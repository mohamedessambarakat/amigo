import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { quoteForCmd } from './command.ts';
import { readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { home } from './paths.ts';
import type { RunResult } from './proc.ts';
import type { Busy, Endpoint, EndpointState, InputState, ListedEndpoint, Liveness, TerminalBackend } from './terminal.ts';

/**
 * The T3 Code backend (t3 v0.1.13). amigo's lead is the T3 thread the Boss typed `/amigo` (or `amigo`) in, and each crew
 * member is a T3 thread of its own, started with `t3 thread start` in its leased worktree, which amigo adds as a T3 project.
 * T3 starts Claude Code through the Agent SDK, so amigo cannot pass its own flags (hooks, contract, session name): hooks
 * come from one user-level dispatcher (t3-hook.ts) that acts only for threads in the registry below, and the contract is
 * printed into the lead thread.
 *
 * T3 has no labels on threads, so the registry is the ownership record a herdr-app tab's labels are: a thread that is not
 * in it, or is in it for another task or home, is foreign. It lives at one fixed path for every home
 * (~/.amigo/state/t3-threads.json, or AMIGO_T3_REGISTRY), because T3 starts a thread without amigo's environment: the
 * registry tells a thread's commands and hooks which home and task they belong to.
 */

/** The t3 CLI version this backend was tested against. The session-start briefing warns when another is installed. */
export const T3_TESTED_VERSION = '0.1.13';
/** The T3 provider instance that runs Claude Code. amigo starts Claude Code crew members only. */
export const T3_PROVIDER = 'claudeAgent';
/** The model a crew member gets when its task names none and the lead's model is not known. */
export const T3_DEFAULT_MODEL = 'opus';
/** How long one t3 CLI call may take: it talks to the running T3 server, which answers in well under a second. */
export const T3_TIMEOUT_MS = 20_000;

export type T3Runner = (args: string[], input?: string) => RunResult;

/** Runs the t3 CLI named by T3CODE_CLI_PATH. On Windows that is a .cmd shim, which only starts through cmd.exe. */
export function t3Runner(env: NodeJS.ProcessEnv): T3Runner {
  return (args, input) => {
    const cli = env.T3CODE_CLI_PATH;
    if (!cli) return { status: null, stdout: '', stderr: '', error: new Error('T3CODE_CLI_PATH is not set: this does not run inside T3 Code') };
    const opts = { env: { ...process.env, ...env }, encoding: 'utf8' as const, windowsHide: true, timeout: T3_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...(input !== undefined ? { input } : {}) };
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
    const r = shim ? spawnSync([cli, ...args].map(quoteForCmd).join(' '), { ...opts, shell: true }) : spawnSync(cli, args, opts);
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: timedOut ? new Error(`t3 ${args.slice(0, 2).join(' ')} timed out after ${T3_TIMEOUT_MS / 1000}s`) : r.error } : {}) };
  };
}

// ---------- the thread registry ----------

export interface T3Thread {
  role: 'lead' | 'crew';
  /** The amigo home the thread belongs to. */
  home: string;
  /** crew: the task id. */
  task?: string;
  /** crew: the T3 project the thread runs in. */
  project?: string;
  /** lead: its model, the default for crew members that name none. */
  model?: string;
  /** lead: the agent amigo runs as (config.json), for the instructions put back after a compaction. */
  agent?: string;
  /**
   * crew: the Claude session of the thread, from its first hook. A Claude session started inside the thread (`claude -p`, a
   * tool's own agent) inherits T3CODE_THREAD_ID: its hooks carry another session id and are not the crew member's.
   */
  session?: string;
  at: string;
}

export interface T3Registry {
  threads: Record<string, T3Thread>;
  /** The T3 projects amigo added (id -> folder); only these are removed again, once no registered thread uses them. */
  projects: Record<string, { cwd: string; home: string }>;
}

export const t3RegistryPath = (env: NodeJS.ProcessEnv): string => env.AMIGO_T3_REGISTRY || join(os.homedir(), '.amigo', 'state', 't3-threads.json');

export function readRegistry(env: NodeJS.ProcessEnv): T3Registry {
  const r = readJson<Partial<T3Registry> | null>(t3RegistryPath(env), null);
  return { threads: r?.threads ?? {}, projects: r?.projects ?? {} };
}

export function editRegistry<T>(env: NodeJS.ProcessEnv, change: (r: T3Registry) => T): T {
  const file = t3RegistryPath(env);
  return withLock(`${file}.lock`, () => {
    const r = readRegistry(env);
    const out = change(r);
    writeJsonAtomic(file, r);
    return out;
  });
}

const sameDir = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** The registry entry of a thread (this process's own thread by default), or null when amigo does not know it. */
export function t3Thread(env: NodeJS.ProcessEnv, id: string | undefined = env.T3CODE_THREAD_ID): T3Thread | null {
  if (!id) return null;
  return readRegistry(env).threads[id] ?? null;
}

/**
 * A command or hook that runs in a registered thread belongs to that thread's home, and in a crew member's thread to its task:
 * the environment T3 gives the thread has neither AMIGO_HOME nor AMIGO_TASK, so they come from the registry. A variable that is
 * already set wins.
 */
export function adoptT3Env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.T3CODE_THREAD_ID || (env.AMIGO_TASK && env.AMIGO_HOME)) return env;
  let entry: T3Thread | null;
  try {
    entry = t3Thread(env);
  } catch {
    return env;
  }
  if (!entry) return env;
  // A task id names a task only in its own home.
  const task = entry.role === 'crew' && entry.task && !env.AMIGO_TASK && (!env.AMIGO_HOME || sameDir(env.AMIGO_HOME, entry.home));
  return { ...env, ...(env.AMIGO_HOME ? {} : { AMIGO_HOME: entry.home }), ...(task ? { AMIGO_TASK: entry.task } : {}) };
}

/**
 * Whether a hook with this session id is the crew thread's own session: the first session seen in the thread is pinned (its
 * SessionStart comes before anything it starts), and a later hook from another session is a nested one.
 */
export function ownCrewSession(env: NodeJS.ProcessEnv, session: string | undefined, id: string | undefined = env.T3CODE_THREAD_ID): boolean {
  if (!id || !session) return true;
  const known = readRegistry(env).threads[id];
  if (known?.role !== 'crew') return true;
  if (known.session) return known.session === session;
  return editRegistry(env, (r) => {
    const t = r.threads[id];
    if (!t || t.role !== 'crew') return true;
    if (!t.session) t.session = session;
    return t.session === session;
  });
}

/** Whether this process runs in a T3 thread registered as this home's lead. */
export const isT3Lead = (env: NodeJS.ProcessEnv): boolean => {
  const entry = t3Thread(env);
  return entry?.role === 'lead' && sameDir(entry.home, home(env));
};

/** Record this thread as the home's lead (one per home: an earlier lead thread of the home is dropped). */
export function registerLead(agent: string, env: NodeJS.ProcessEnv, runner: T3Runner = t3Runner(env)): void {
  const id = env.T3CODE_THREAD_ID;
  if (!id) throw new Error('This is not a T3 Code thread (no T3CODE_THREAD_ID)');
  const shown = showThread(runner, id);
  const model = 'thread' in shown ? str(shown.thread.model) : null;
  editRegistry(env, (r) => {
    for (const [tid, t] of Object.entries(r.threads)) if (t.role === 'lead' && sameDir(t.home, home(env))) delete r.threads[tid];
    r.threads[id] = { role: 'lead', home: home(env), agent, ...(model ? { model } : {}), at: new Date().toISOString() };
  });
}

// ---------- reading the t3 CLI ----------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const said = (r: RunResult): string => (r.error?.message ?? ((r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`));

/** `t3 thread show --json`: the thread, `gone` when T3 says it is no longer available, or the error. */
export function showThread(runner: T3Runner, id: string): { thread: Json } | { gone: true } | { error: string } {
  const r = runner(['thread', 'show', id, '--json', '--messages', '0']);
  if (!r.error && r.status !== 0 && /no longer available|not found/i.test(`${r.stdout}\n${r.stderr}`)) return { gone: true };
  if (r.error || r.status !== 0) return { error: said(r) };
  try {
    const thread = obj(obj(JSON.parse(r.stdout)).thread);
    return str(thread.threadId) ? { thread } : { error: `unexpected answer: ${r.stdout.slice(0, 200)}` };
  } catch {
    return { error: `unexpected answer: ${r.stdout.slice(0, 200)}` };
  }
}

/** The title T3 shows: the tab label, with the characters cmd.exe cannot carry taken out. */
const safeTitle = (label: string): string => label.replace(/["%\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'amigo crew member';

/**
 * The t3 backend. open() adds the folder as a T3 project (or finds amigo's own one for it), starts the thread with the brief on
 * stdin, records it, and starts the crew member's runner (req.argv, detached) that beats while the thread lives.
 */
export function t3Backend(env: NodeJS.ProcessEnv, runner: T3Runner = t3Runner(env), spawnRunner: (argv: string[], cwd: string, childEnv: NodeJS.ProcessEnv) => void = spawnDetached): TerminalBackend {
  const me = home(env);
  const mine = (ep: Pick<Endpoint, 'terminal' | 'task'>): boolean => {
    const t = readRegistry(env).threads[ep.terminal];
    return t?.role === 'crew' && t.task === ep.task && sameDir(t.home, me);
  };
  const read = (ep: Pick<Endpoint, 'terminal' | 'task'>): { liveness: Liveness; thread: Json } => {
    const s = showThread(runner, ep.terminal);
    if ('gone' in s) return { liveness: 'absent', thread: {} };
    if ('error' in s) return { liveness: 'unreadable', thread: {} };
    if (!mine(ep)) return { liveness: 'foreign', thread: s.thread };
    return { liveness: s.thread.archived === true ? 'finished' : 'live', thread: s.thread };
  };
  return {
    name: 't3',
    amigoSpace: () => null,
    open(req) {
      const agent = req.agent;
      if (!agent) throw new Error('The t3 backend starts the agent itself: the open request needs its folder and prompt');
      const title = safeTitle(req.placement.label);
      // amigo's own project for this folder, when an earlier crew member (the reviewed one) added it.
      let project = Object.entries(readRegistry(env).projects).find(([, p]) => sameDir(p.cwd, agent.cwd))?.[0] ?? null;
      let added = false;
      if (!project) {
        const r = runner(['project', 'add', agent.cwd, '--title', title]);
        const id = /Added project (\S+)/.exec(r.stdout)?.[1];
        if (!r.error && r.status === 0 && id) {
          project = id;
          added = true;
          editRegistry(env, (reg) => {
            reg.projects[id] = { cwd: agent.cwd, home: me };
          });
        } else if (!/already exists/i.test(`${r.stdout}\n${r.stderr}`)) {
          throw new Error(`Could not add ${agent.cwd} as a T3 project: ${said(r)}`);
        }
        // Already a project the Boss added himself: the thread starts in it, and amigo never removes it.
      }
      const lead = t3Thread(env);
      const model = agent.model || (lead?.role === 'lead' ? lead.model : undefined) || T3_DEFAULT_MODEL;
      const args = ['thread', 'start', project ?? agent.cwd, '-', '--provider', T3_PROVIDER, '--model', model, ...(agent.effort ? ['--option', `effort=${agent.effort}`] : []), '--title', title, '--json'];
      const r = runner(args, agent.prompt);
      let thread: string | null = null;
      let threadProject: string | null = null;
      try {
        const body = obj(JSON.parse(r.stdout));
        thread = str(body.threadId);
        threadProject = str(body.projectId);
      } catch {
        // the message below says what came back
      }
      if (r.error || r.status !== 0 || !thread) {
        if (added && project) {
          runner(['project', 'remove', project, '--force']);
          editRegistry(env, (reg) => {
            delete reg.projects[project!];
          });
        }
        throw new Error(`Could not start the crew member's T3 thread: ${r.error || r.status !== 0 ? said(r) : `unexpected answer ${r.stdout.slice(0, 200)}`}`);
      }
      editRegistry(env, (reg) => {
        // The task's earlier thread (gone or archived: startMember never opens beside a live one) is no longer its thread.
        for (const [id, t] of Object.entries(reg.threads)) if (t.role === 'crew' && t.task === req.task && sameDir(t.home, me)) delete reg.threads[id];
        reg.threads[thread] = { role: 'crew', home: me, task: req.task, ...((project ?? threadProject) ? { project: (project ?? threadProject)! } : {}), at: new Date().toISOString() };
      });
      spawnRunner(req.argv, req.cwd, req.env);
      return { backend: 't3', task: req.task, space: null, tab: null, terminal: thread };
    },
    send(ep, text) {
      const s = read(ep);
      if (s.liveness !== 'live') throw new Error(`Cannot send to ${ep.task}: its T3 thread ${ep.terminal} is ${s.liveness}`);
      // Queued as the thread's next turn: a busy thread gets it when its turn ends, nothing is interrupted.
      const r = runner(['thread', 'send', ep.terminal, '-', '--json'], text);
      if (r.error || r.status !== 0) throw new Error(`Could not send to ${ep.task} (T3 thread ${ep.terminal}): ${said(r)}`);
    },
    interrupt(ep) {
      const s = read(ep);
      if (s.liveness !== 'live') throw new Error(`Cannot interrupt ${ep.task}: its T3 thread ${ep.terminal} is ${s.liveness}`);
      throw new Error(`T3 Code has no command-line interrupt yet: stop ${ep.task}'s turn with the t3_thread_interrupt tool, threadId "${ep.terminal}" (the thread stays open).`);
    },
    state(ep) {
      const s = read(ep);
      if (s.liveness !== 'live') return { liveness: s.liveness, busy: 'unknown', input: 'no-status' } satisfies EndpointState;
      const busy: Busy = s.thread.status === 'running' || s.thread.status === 'starting' || str(s.thread.activeRunId) ? 'busy' : 'idle';
      const pending = typeof s.thread.pendingRequestCount === 'number' ? s.thread.pendingRequestCount : 0;
      // A message is queued, never typed: it reaches the thread whatever it is doing, except a request waiting on an answer.
      const input: InputState = pending > 0 ? 'dialog' : 'ready';
      return { liveness: 'live', busy, input };
    },
    close(ep) {
      const before = read(ep);
      if (before.liveness === 'unreadable') throw new Error(`T3 thread ${ep.terminal} of ${ep.task} could not be read, so it was not closed`);
      if (before.liveness === 'foreign') throw new Error(`T3 thread ${ep.terminal} is not ${ep.task}'s in amigo's registry: amigo does not close it`);
      const reg = readRegistry(env);
      const entry = reg.threads[ep.terminal];
      const project = entry?.project ?? null;
      const ofThisTask = (t: T3Thread): boolean => t.role === 'crew' && t.task === ep.task && sameDir(t.home, me);
      const shared = Boolean(project) && Object.entries(reg.threads).some(([id, t]) => id !== ep.terminal && t.project === project && !ofThisTask(t));
      // Removing amigo's own project deletes it with its threads (T3 has no command to delete one thread). A project another
      // registered thread still uses, or one the Boss added, stays: the thread is only forgotten here.
      const removeProject = Boolean(project && reg.projects[project] && !shared);
      if (removeProject) {
        const r = runner(['project', 'remove', project!, '--force']);
        if ((r.error || r.status !== 0) && !/No active project/i.test(`${r.stdout}\n${r.stderr}`)) throw new Error(`Could not remove T3 project ${project} of ${ep.task}: ${said(r)}`);
        const after = read(ep).liveness;
        if (after !== 'absent') throw new Error(`T3 thread ${ep.terminal} of ${ep.task} is ${after} after removing its project`);
      } else if (before.liveness === 'live' && (before.thread.status === 'running' || str(before.thread.activeRunId))) {
        throw new Error(`T3 thread ${ep.terminal} of ${ep.task} is still working and its T3 project stays (another thread uses it, or the Boss added it), so it cannot be removed: stop its turn with the t3_thread_interrupt tool, then close again`);
      }
      editRegistry(env, (r) => {
        delete r.threads[ep.terminal];
        for (const [id, t] of Object.entries(r.threads)) if (ofThisTask(t)) delete r.threads[id];
        if (removeProject) delete r.projects[project!];
      });
    },
    list() {
      const threads = Object.entries(readRegistry(env).threads).filter(([, t]) => t.role === 'crew' && t.task && sameDir(t.home, me));
      return threads.map(([id, t]): ListedEndpoint => ({ task: t.task!, terminal: id, space: null, tab: null, liveness: read({ terminal: id, task: t.task! }).liveness }));
    },
  };
}

function spawnDetached(argv: string[], cwd: string, childEnv: NodeJS.ProcessEnv): void {
  const [cmd, ...args] = argv as [string, ...string[]];
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: childEnv });
  child.on('error', () => {});
  child.unref();
}

/** The crew member part a Claude crew member in T3 gets: it reports through the report command, and its thread stays open. */
export function t3MemberNotes(): string {
  return '## Your session\n\nYou are a T3 Code thread amigo started; the Boss can see it and type in it. Your thread stays open after each turn: amigo may send you more as a new turn. Nothing reads your messages to amigo: whenever a turn ends (done, blocked or a question), first run the report command under "Your task", then end your final message with one line: STATUS: done|blocked|question - <one-line summary>.';
}
