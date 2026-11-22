import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, taskDir, tasksDir } from './paths.ts';

/**
 * queued   waiting for a free squad member
 * running  the agent is working
 * verifying  the agent said done and amigo is running the project's checks in its folder
 * done / blocked / question   the agent finished its turn (Claude) or run and said so (see parseStatus)
 * failed   the agent exited with an error, never started, or its tab closed mid-turn
 * closing  close is committing or cleaning up; nothing may start it again
 * closed   amigo closed it (committed or discarded)
 */
export type Status = 'queued' | 'running' | 'verifying' | 'done' | 'blocked' | 'question' | 'failed' | 'closing' | 'closed';

/** Statuses where the squad member is waiting for amigo. */
export const FINISHED: readonly Status[] = ['done', 'blocked', 'question', 'failed'];

/** One verification command run in a squad member's folder. `output` is its last lines. */
export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  seconds: number;
  output: string;
}

/** How the project's checks went when the squad member last said done. 'unverified': the project has no checks. */
export interface Verification {
  state: 'passed' | 'failed' | 'unverified';
  results: CheckResult[];
  /** The folder's git tree when the checks passed (see snapshot): proof they ran on exactly this work. */
  tree?: string;
  at: string;
}

/** A reviewer's verdict on a task's work, and the work it saw. */
export interface ReviewVerdict {
  by: string;
  verdict: 'PASS' | 'FAIL';
  tree?: string;
  at: string;
  /** Why this verdict does not count (the work changed while the reviewer read it, or the same work already failed). */
  void?: string;
}

export interface Task {
  id: string;
  title: string;
  project: string;
  agent: string;
  /** Where the agent runs: a worktree for git projects, else the project folder. */
  cwd: string;
  /** Git projects only: the main checkout, the worktree, its branch and the commit it started from. */
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  baseSha: string | null;
  /** The worktree's git dir under the repo (recorded when the worktree is made): git runs against it, never against <worktree>/.git. Missing on older tasks. */
  gitDir?: string;
  /** The messaging address (`uds:<socket>`) of the Claude session that spawned this squad member; it gets the squad member's results. */
  amigoAddress?: string;
  /** A scratch task (spawn --scratch): works in its own folder under the home, not a project and not git. */
  scratch?: boolean;
  /** The startup briefing's own squad member (see briefing.ts): one open at a time, and its scratch folder goes when it is closed. */
  briefing?: boolean;
  /** Set for a reviewer: the task whose folder it reads, and that task's git tree when the reviewer was spawned. */
  reviewOf?: string;
  reviewedTree?: string;
  /** Starts only once this task (same project) is closed with a commit, from that commit. */
  after?: string;
  /** The GitHub issue this task came from (spawn --issue). */
  issue?: { number: number; url: string; title: string };
  /** Set when the task is closed with --commit: the commit its branch holds. */
  committed?: string;
  /** The draft pull request opened by close --pr. */
  pr?: string;
  verification?: Verification;
  /** Automatic fix-it follow-ups sent for failed checks since amigo last wrote to the squad member. */
  checkRetries?: number;
  /** The latest reviewer verdict on this task's work. */
  review?: ReviewVerdict;
  /** Trees of this task's work that a reviewer failed: a later PASS on the same tree does not count. */
  reviewFailedTrees?: string[];
  status: Status;
  createdAt: string;
  updatedAt: string;
  /** How many times the agent was started (1 + follow-ups). */
  runs: number;
  /** Follow-up messages from amigo, oldest first. */
  followUps: string[];
  /** How many follow-ups the squad member has been given (a resumed Claude session gets only the rest). */
  followUpsSent?: number;
  /** The agent process in the squad member's tab. */
  pid?: number | null;
  /** When the squad member's tab was last opened. */
  startedAt?: string | null;
  /** Claude Code squad members: the session id, resumed when a follow-up reopens the tab once the session has started. */
  sessionId?: string | null;
  sessionStarted?: boolean;
  /** Claude Code squad members: the session's transcript, as its hooks report it; a --resume needs it to exist. */
  transcriptPath?: string | null;
  /** amigo added the ~/.claude.json trust entry for cwd (removed again on close). */
  trustAdded?: boolean;
  /** Warp only: the tab config file, deleted when the squad member ends. */
  tabConfig?: string | null;
  /** herdr only: the workspace holding the squad member's tab, where a reviewer's tab goes. */
  herdrWorkspace?: string | null;
  exitCode?: number | null;
  /** The agent's STATUS line (or its last output line) from the latest run. */
  summary?: string;
  /** The commit subject the squad member proposed in its latest done report (a `COMMIT:` line for Claude Code, or `commit-subject.txt` for other agents; cleared by a later done report without one). `close --commit` checks and uses it. */
  commitSubject?: string;
  /** False until amigo has seen this result in `inbox`. */
  seen: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function assertValidId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Invalid task id "${id}"`);
}

/** A new id: the squad member's number, then a few words of its title (`7-fix-footer`). The number alone is enough in every command. */
export function newId(title: string, n: number): string {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = (words[0] ?? '').slice(0, 16);
  for (const w of words.slice(1)) {
    if (slug.length + 1 + w.length > 16) break;
    slug += `-${w}`;
  }
  return slug ? `${n}-${slug}` : String(n);
}

const NUMBER_RE = /^(\d+)(?:-|$)/;

/** The number an id starts with (`7` for `7-fix-footer`); ids from before numbering have none. */
export function memberNumber(id: string): string | null {
  return NUMBER_RE.exec(id)?.[1] ?? null;
}

/** One more than the highest squad member number used so far, closed squad members included: a number is never reused. */
export function nextMemberNumber(env: NodeJS.ProcessEnv = process.env): number {
  const dir = tasksDir(env);
  const used = existsSync(dir) ? readdirSync(dir).map((d) => Number(memberNumber(d) ?? 0)) : [];
  return Math.max(0, ...used) + 1;
}

/**
 * The task a person means: its exact id, its number (`7`), or the start of its id. When several match, the one squad member that
 * is still open wins.
 */
export function resolveId(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const all = listTasks(env);
  if (all.some((t) => t.id === ref)) return ref;
  // `arm3` and `#3` still mean task 3 (an old habit). An id from before numbering that starts with such a word (arm12-deadbeef) wins over the shorthand.
  const shorthand = ref && !all.some((t) => memberNumber(t.id) === null && t.id.startsWith(ref));
  if (shorthand) ref = ref.replace(/^(arm|#)(?=\d+$)/i, '');
  if (all.some((t) => t.id === ref)) return ref;
  const matches = /^\d+$/.test(ref) ? all.filter((t) => memberNumber(t.id) === ref) : all.filter((t) => ref && t.id.startsWith(ref));
  const open = matches.filter((t) => t.status !== 'closed');
  const pick = matches.length === 1 ? matches : open;
  if (pick.length === 1) return pick[0]!.id;
  if (!matches.length) throw new Error(`No squad member matches "${ref}" (see amigo status)`);
  throw new Error(`"${ref}" matches several squad members: ${(open.length ? open : matches).map((t) => t.id).join(', ')}`);
}

export const taskFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'task.json');
export const briefFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'brief.md');
export const promptFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'prompt.md');
export const logFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'output.log');
/** Where a squad member without hooks writes its proposed commit subject; read and removed when its run ends. */
export const commitSubjectFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'commit-subject.txt');
const heartbeatFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'heartbeat');

/** Create the task folder, failing if the id is already taken (mkdir is atomic). */
export function claimTaskDir(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  mkdirSync(tasksDir(env), { recursive: true });
  try {
    mkdirSync(taskDir(id, env));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export const HEARTBEAT_MS = 5_000;

/** The squad member's tab touches this file while it is open; pids alone are not trusted (they get reused after a reboot). */
export function beat(id: string, env: NodeJS.ProcessEnv = process.env): void {
  writeFileSync(heartbeatFile(id, env), String(Date.now()));
}

export function clearBeat(id: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(heartbeatFile(id, env), { force: true });
}

/** True while the tab's heartbeat is recent. */
export function runnerAlive(id: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  try {
    return now - statSync(heartbeatFile(id, env)).mtimeMs < HEARTBEAT_MS * 4;
  } catch {
    return false;
  }
}

export function getTask(id: string, env: NodeJS.ProcessEnv = process.env): Task | null {
  assertValidId(id);
  return readJson<Task | null>(taskFile(id, env), null);
}

export function requireTask(id: string, env: NodeJS.ProcessEnv = process.env): Task {
  const t = getTask(id, env);
  if (!t) throw new Error(`No task "${id}" (see amigo status)`);
  return t;
}

export function saveTask(task: Task, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(taskFile(task.id, env), task);
}

/** Read-modify-write one task under a lock, so the runner and the CLI never overwrite each other. updatedAt becomes now unless the patch carries its own (a migration keeps a record's age). */
export function mutateTask(id: string, fn: (t: Task) => Partial<Task> | null, env: NodeJS.ProcessEnv = process.env): Task {
  return withLock(lockPath(`task-${id}`, env), () => {
    const t = requireTask(id, env);
    const patch = fn(t);
    if (!patch) return t;
    const next = { ...t, updatedAt: new Date().toISOString(), ...patch };
    saveTask(next, env);
    return next;
  });
}

export function listTasks(env: NodeJS.ProcessEnv = process.env): Task[] {
  const dir = tasksDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => ID_RE.test(d))
    .map((d) => readJson<Task | null>(taskFile(d, env), null))
    .filter((t): t is Task => t !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const STATUS_RE = /^[\s>*_`#-]*STATUS:?[\s*_`]*(done|blocked|question)\b[\s*_`]*(?:[-:–—]+)?[\s]*(.*?)[\s*_`]*$/gim;

/** The last `STATUS: done|blocked|question - ...` line the agent printed, tolerating markdown around it. */
export function parseStatus(output: string): { status: 'done' | 'blocked' | 'question'; summary: string } | null {
  let last: RegExpExecArray | null = null;
  // Skip the placeholder lines of the instructions, in case an agent echoes its prompt.
  for (const m of output.matchAll(STATUS_RE)) if (!/^<.*>$/.test((m[2] ?? '').trim())) last = m;
  if (!last) return null;
  return { status: (last[1] as string).toLowerCase() as 'done' | 'blocked' | 'question', summary: (last[2] ?? '').trim() };
}

export function lastLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n).join('\n');
}
