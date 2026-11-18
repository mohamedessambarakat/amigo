import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  armName,
  armSettings,
  claudeArmNotes,
  claudeArmTemplate,
  claudeHeadTemplate,
  forgetFolder,
  headIsClaude,
  isClaude,
  recordHead,
  reportReason,
  transcriptMessagedHead,
  trustFolder,
} from './claude.ts';
import { buildLaunch, describeLaunch, type Launch } from './command.ts';
import { findProject, loadConfig, loadProjects, pickAgent, type Config } from './config.ts';
import { withLock, writeJsonAtomic } from './fsx.ts';
import { branchName, changedFiles, commitAll, committedFiles, createWorktree, deleteBranchIfUnused, isGitRepo, removeWorktree } from './git.ts';
import { cliPath, codeRoot, home, lockPath, taskDir, worktreesDir } from './paths.ts';
import { killTree } from './proc.ts';
import { freeMemMb, ramAllows } from './ram.ts';
import { openTab, removeTabConfig, selectTerminal } from './terminal.ts';
import {
  FINISHED,
  HEARTBEAT_MS,
  beat,
  briefFile,
  claimTaskDir,
  clearBeat,
  lastLines,
  listTasks,
  logFile,
  mutateTask,
  newId,
  parseStatus,
  promptFile,
  requireTask,
  runnerAlive,
  saveTask,
  type Task,
} from './tasks.ts';

const readPrompt = (name: string): string => readFileSync(join(codeRoot, 'prompts', name), 'utf8').trim();

/** An arm whose tab opened this recently may still be loading: it counts against free RAM before it uses any. */
const STARTUP_MS = 60_000;

const settingsFile = (id: string, env: NodeJS.ProcessEnv): string => join(taskDir(id, env), 'claude-settings.json');

function armTemplate(t: Pick<Task, 'agent'>, config: Config): string[] {
  const template = config.agents[t.agent]?.arm;
  if (!template) throw new Error(`Agent "${t.agent}" is no longer in config.json`);
  return template;
}

/** Everything an arm gets for its first run: the arm rules, the project notes, the brief and any follow-ups. */
export function armPrompt(t: Task, brief: string, notes: string | undefined, claudeNotes?: string): string {
  const parts = [readPrompt('arm.md'), `## Your task\n\nTask id: ${t.id}\nProject: ${t.project}\nWorking directory: ${t.cwd}`];
  if (claudeNotes) parts.push(claudeNotes);
  if (t.reviewOf) {
    parts.push(
      `## You are a reviewer\n\nYou check the work of task ${t.reviewOf} in this folder. Read, run and report only: do not edit, commit, stage, reset or delete anything. End with STATUS: done followed by your verdict.`,
    );
  }
  parts.push(`## Project notes (hard rules)\n\n${notes?.trim() || 'None.'}`);
  parts.push(`## Brief\n\n${brief.trim()}`);
  if (t.followUps.length) {
    if (t.summary) parts.push(`## Your previous run ended with\n\n${t.summary}`);
    parts.push(`## Follow-ups from the head (newest last)\n\n${t.followUps.map((m, i) => `${i + 1}. ${m.trim()}`).join('\n')}`);
  }
  return parts.join('\n\n') + '\n';
}

/** A resumed Claude session already has the brief: it gets every follow-up it has not been given yet. */
export function followUpPrompt(t: Task): string {
  const pending = t.followUps.slice(t.followUpsSent ?? 0).map((m) => m.trim());
  const body = pending.length === 1 ? pending[0] : pending.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return `Follow-up from the head:\n\n${body}\n\nWhen this turn ends, report as before and end with your STATUS line.\n`;
}

function notesFor(project: string, env: NodeJS.ProcessEnv): string | undefined {
  return loadProjects(env).find((p) => p.name === project)?.notes;
}

/** The command an arm's tab runs for this task (what `--dry-run` shows). */
function armLaunch(t: Task, config: Config, prompt: string, env: NodeJS.ProcessEnv): Launch {
  const template = armTemplate(t, config);
  const resume = t.runs > 1 && Boolean(t.sessionId);
  const full = isClaude(template) ? claudeArmTemplate(template, { id: t.id, sessionId: t.sessionId ?? '<new session id>', resume, settingsFile: settingsFile(t.id, env) }) : template;
  return buildLaunch(full, { prompt, promptFile: promptFile(t.id, env) }, env);
}

export interface SpawnInput {
  project?: string;
  review?: string;
  title?: string;
  agent?: string;
  brief: string;
}

/** "Title: Fix the footer" on the brief's first line, else the first line itself. */
export function titleOf(brief: string): string {
  const first = brief.trim().split(/\r?\n/)[0] ?? '';
  return first.replace(/^title:\s*/i, '').replace(/^#+\s*/, '').trim().slice(0, 80) || 'task';
}

/** Plan a new arm. With dryRun, nothing is written: the plan is returned as text, which also proves the agent can be found. */
export function spawnArm(input: SpawnInput, opts: { dryRun?: boolean }, env: NodeJS.ProcessEnv = process.env): { task: Task; text: string } {
  if (!input.brief.trim()) throw new Error('The brief is empty');
  if (!input.project === !input.review) throw new Error('Give either --project <name> or --review <task-id>');
  const config = loadConfig(env);
  const agent = pickAgent(config, input.agent, env);
  const terminal = selectTerminal(config.terminal, { env, platform: process.platform });
  const title = input.title?.trim() || titleOf(input.brief);
  let id = newId(title);
  if (!opts.dryRun) {
    for (let i = 0; !claimTaskDir(id, env); i++) {
      if (i >= 5) throw new Error('Could not find a free task id');
      id = newId(title);
    }
  }
  const now = new Date().toISOString();
  const base = { id, title, agent, status: 'queued' as const, createdAt: now, updatedAt: now, runs: 0, followUps: [], seen: true };

  let task: Task;
  if (input.review) {
    const parent = requireTask(input.review, env);
    if (parent.status === 'closed' || parent.status === 'closing') throw new Error(`Task ${parent.id} is ${parent.status}; there is nothing left to review`);
    task = { ...base, project: parent.project, cwd: parent.cwd, repo: null, worktree: null, branch: null, baseSha: null, reviewOf: parent.id };
  } else {
    const project = findProject(loadProjects(env), input.project as string);
    if (!existsSync(project.path)) throw new Error(`Project folder ${project.path} does not exist`);
    if (isGitRepo(project.path)) {
      const worktree = join(worktreesDir(env), `${project.name}-${id}`);
      task = { ...base, project: project.name, cwd: worktree, repo: project.path, worktree, branch: branchName(id), baseSha: null };
    } else {
      task = { ...base, project: project.name, cwd: project.path, repo: null, worktree: null, branch: null, baseSha: null };
    }
  }

  const launch = armLaunch(task, config, armPrompt(task, input.brief, notesFor(task.project, env)), env);
  const where = task.worktree ? `new worktree ${task.worktree} on branch ${task.branch} (from ${task.repo})` : `${task.cwd} (in place${task.reviewOf ? `, reviewing ${task.reviewOf}` : ''})`;
  const text = [`task:    ${id}  "${title}"`, `folder:  ${where}`, `agent:   ${agent} (${terminal} tab ${armName(id)})`, `command: ${describeLaunch(launch)}`].join('\n');
  if (opts.dryRun) return { task, text: `DRY RUN, nothing was started.\n${text}` };

  writeFileSync(briefFile(id, env), input.brief.trim() + '\n');
  if (task.worktree && task.repo && task.branch) {
    mkdirSync(worktreesDir(env), { recursive: true });
    task.baseSha = createWorktree(task.repo, task.worktree, task.branch);
  }
  saveTask(task, env);
  drain(env);
  const after = requireTask(id, env);
  const state = after.status === 'running' ? 'Started' : after.status === 'failed' ? `Failed: ${after.summary}` : 'Queued (waiting for free RAM or for its folder)';
  return { task: after, text: `${state}\n${text}` };
}

const TAB_LOST = 'The arm stopped without reporting: its tab closed or never opened (see octomaxxing attach).';

/**
 * Mark arms whose tab is gone in the middle of a turn (closed, crashed, reboot, or it never opened) as failed. The pid
 * is kept: a tab that was only asleep beats again and puts its task back to running (see runTab).
 */
export function refresh(env: NodeJS.ProcessEnv = process.env): void {
  for (const t of listTasks(env)) {
    if (t.status !== 'running' || runnerAlive(t.id, env)) continue;
    if (Date.now() - Date.parse(t.startedAt ?? t.updatedAt) < STARTUP_MS) continue; // the tab may still be opening
    mutateTask(
      t.id,
      (cur) =>
        cur.status === 'running' && !runnerAlive(cur.id, env)
          ? { status: 'failed', seen: false, summary: TAB_LOST }
          : null,
      env,
    );
  }
}

/**
 * Start queued arms, oldest first, while free RAM allows (armMb per arm, reserveMb kept free; one arm may always run).
 * One arm per folder: a folder is busy while an arm runs there or still has its tab open (it may be working on a message
 * from the head), except that a reviewer may read a finished arm's folder. A task whose old tab is still open waits for it.
 */
export function drain(env: NodeJS.ProcessEnv = process.env): string[] {
  return withLock(lockPath('queue', env), () => {
    refresh(env);
    const config = loadConfig(env);
    const tasks = listTasks(env);
    const running = tasks.filter((t) => t.status === 'running');
    const busy = new Set(running.map((t) => t.cwd));
    const open = new Set(tasks.filter((t) => t.status !== 'closed' && runnerAlive(t.id, env)).map((t) => t.cwd));
    let starting = running.filter((t) => t.startedAt && Date.now() - Date.parse(t.startedAt) < STARTUP_MS).length;
    let free: number | null = null;
    const started: string[] = [];
    for (const t of tasks.filter((x) => x.status === 'queued')) {
      if (busy.has(t.cwd) || (open.has(t.cwd) && !t.reviewOf) || runnerAlive(t.id, env)) continue;
      free ??= freeMemMb(env);
      if ((running.length > 0 || started.length > 0) && !ramAllows(free, config.armMb, config.reserveMb, starting)) break;
      if (startArm(t, config, env)) {
        started.push(t.id);
        busy.add(t.cwd);
        starting++;
      }
    }
    return started;
  });
}

/**
 * A tab starts with the terminal's environment, not this process's, but its end starts the next queued arm: so the
 * OCTOMAXXING_* settings travel with it as arguments.
 */
export function tabEnvArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => k.startsWith('OCTOMAXXING_') && k !== 'OCTOMAXXING_HOME' && k !== 'OCTOMAXXING_TASK' && v)
    .flatMap(([k, v]) => ['--env', `${k}=${v}`]);
}

function startArm(t: Task, config: Config, env: NodeJS.ProcessEnv): boolean {
  try {
    const claude = isClaude(armTemplate(t, config));
    const terminal = selectTerminal(config.terminal, { env, platform: process.platform });
    const resume = claude && t.sessionStarted === true;
    if (resume) {
      writeFileSync(promptFile(t.id, env), followUpPrompt(t));
    } else {
      const brief = readFileSync(briefFile(t.id, env), 'utf8');
      writeFileSync(promptFile(t.id, env), armPrompt(t, brief, notesFor(t.project, env), claude ? claudeArmNotes(t.id, headIsClaude(env)) : undefined));
    }
    let trustAdded = false;
    if (claude) {
      writeJsonAtomic(settingsFile(t.id, env), armSettings());
      trustAdded = trustFolder(t.cwd, env);
    }
    const now = mutateTask(
      t.id,
      (cur) => ({
        status: 'running',
        pid: null,
        runs: cur.runs + 1,
        seen: true,
        exitCode: null,
        startedAt: new Date().toISOString(),
        sessionId: claude ? (cur.sessionId ?? randomUUID()) : null,
        trustAdded: cur.trustAdded || trustAdded,
      }),
      env,
    );
    const { tabConfig } = openTab(terminal, {
      name: armName(t.id),
      title: `octomaxxing: ${t.title}`,
      // The tab's shell sits in the task folder, never in the worktree, so it cannot block removing the worktree on close.
      cwd: taskDir(t.id, env),
      argv: [process.execPath, cliPath, '_tab', t.id, '--run', String(now.runs), '--home', home(env), ...tabEnvArgs(env)],
      dir: taskDir(t.id, env),
      platform: process.platform,
      env: { ...env, OCTOMAXXING_HOME: home(env) },
    });
    if (tabConfig) mutateTask(t.id, () => ({ tabConfig }), env);
    return true;
  } catch (err) {
    mutateTask(t.id, (cur) => (cur.status === 'running' || cur.status === 'queued' ? { status: 'failed', seen: false, summary: `Could not start: ${(err as Error).message}` } : null), env);
    return false;
  }
}

function spawnAgent(launch: Launch, opts: Parameters<typeof spawn>[2]) {
  return launch.shell ? spawn(launch.commandLine as string, { ...opts, shell: true }) : spawn(launch.file, launch.args, opts);
}

/** Record the agent's pid. False when the arm was closed before it started: then the agent is stopped at once. */
function recordPid(id: string, pid: number | undefined, env: NodeJS.ProcessEnv, more: (cur: Task) => Partial<Task> = () => ({})): boolean {
  const t = mutateTask(id, (cur) => (cur.status === 'closing' || cur.status === 'closed' ? null : { pid: pid ?? null, ...(pid ? more(cur) : {}) }), env);
  if (t.status === 'closing' || t.status === 'closed') {
    if (pid) killTree(pid);
    return false;
  }
  return true;
}

/**
 * `octomaxxing _tab <id>`: runs inside the arm's terminal tab. Claude Code gets an interactive session the user can type
 * in (its hooks record each turn); other agents run once with their output shown in the tab and kept in the log.
 * Returns the tab's exit code: non-zero keeps the tab open so the error stays readable.
 */
export async function runTab(id: string, env: NodeJS.ProcessEnv = process.env, run?: number): Promise<number> {
  const t = requireTask(id, env);
  // A tab that opens late, or is reopened from Warp's menu, must not start a second session.
  if (t.status !== 'running' || (run !== undefined && t.runs !== run) || runnerAlive(id, env)) {
    process.stdout.write(`octomaxxing: ${id} is ${t.status} (run ${t.runs}), not starting it from this tab.\n`);
    return 0;
  }
  const tick = () => {
    try {
      beat(id, env);
      // Back from sleep: refresh may have failed this task while the tab could not beat.
      mutateTask(id, (cur) => (cur.status === 'failed' && cur.summary === TAB_LOST && cur.pid ? { status: 'running', seen: true } : null), env);
    } catch {
      // a missed beat is retried in HEARTBEAT_MS; refresh allows several
    }
  };
  tick();
  const heartbeat = setInterval(tick, HEARTBEAT_MS);
  let code = 1;
  try {
    const template = armTemplate(t, loadConfig(env));
    code = isClaude(template) ? await runClaudeArm(t, env) : await runOnce(t, template, env);
  } catch (err) {
    process.stderr.write(`octomaxxing: ${(err as Error).message}\n`);
    appendFileSync(logFile(id, env), `octomaxxing: ${(err as Error).message}\n`);
    mutateTask(id, (cur) => (cur.status === 'running' ? { status: 'failed', pid: null, seen: false, summary: (err as Error).message } : null), env);
  } finally {
    clearInterval(heartbeat);
    // The tab config goes first: once the beat is gone, a new tab for this task may be written at the same path.
    removeTabConfig(requireTask(id, env).tabConfig);
    clearBeat(id, env);
  }
  drain(env);
  return code;
}

async function runClaudeArm(t: Task, env: NodeJS.ProcessEnv): Promise<number> {
  const launch = armLaunch(t, loadConfig(env), readFileSync(promptFile(t.id, env), 'utf8'), env);
  // Ctrl+C belongs to the session, not to this wrapper.
  process.on('SIGINT', () => {});
  const child = spawnAgent(launch, { cwd: t.cwd, stdio: 'inherit', env: { ...env, OCTOMAXXING_TASK: t.id, OCTOMAXXING_HOME: home(env) } });
  // Only now does the session exist (resumable later) and has it been given the follow-ups in its prompt.
  if (!recordPid(t.id, child.pid, env, (cur) => ({ sessionStarted: true, followUpsSent: cur.followUps.length }))) return 0;
  const exit = await new Promise<number | null>((done) => {
    child.on('error', (err) => {
      process.stderr.write(`octomaxxing: claude could not start: ${err.message}\n`);
      done(null);
    });
    child.on('exit', (c) => done(c));
  });
  const after = mutateTask(
    t.id,
    (cur) => {
      if (cur.status === 'running') return { status: 'failed', pid: null, exitCode: exit, seen: false, summary: `The session ended in the middle of a turn (exit ${exit}).` };
      return { pid: null, exitCode: exit };
    },
    env,
  );
  // A session closed by `octomaxxing close` or a follow-up, or ended after reporting, is a clean end: the tab closes.
  return after.status === 'failed' && exit !== 0 ? (exit ?? 1) : 0;
}

async function runOnce(t: Task, template: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const log = logFile(t.id, env);
  const before = existsSync(log) ? readFileSync(log).length : 0;
  const launch = buildLaunch(template, { prompt: readFileSync(promptFile(t.id, env), 'utf8'), promptFile: promptFile(t.id, env) }, env);
  appendFileSync(log, `\n=== octomaxxing: run ${t.runs}, ${new Date().toISOString()} ===\n`);
  // OCTOMAXXING_TASK marks the arm's environment: octomaxxing refuses to manage tasks from inside an arm.
  const child = spawnAgent(launch, { cwd: t.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, OCTOMAXXING_TASK: t.id }, windowsHide: true });
  if (!recordPid(t.id, child.pid, env)) return 0;
  const tee = (out: NodeJS.WritableStream) => (chunk: Buffer) => {
    appendFileSync(log, chunk);
    out.write(chunk);
  };
  child.stdout?.on('data', tee(process.stdout));
  child.stderr?.on('data', tee(process.stderr));
  const code = await new Promise<number | null>((done) => {
    child.on('error', (err) => {
      appendFileSync(log, `octomaxxing: the agent could not start: ${err.message}\n`);
      done(null);
    });
    child.on('close', (c) => done(c));
  });
  const output = readFileSync(log).subarray(before).toString('utf8');
  const reported = parseStatus(output);
  const after = mutateTask(
    t.id,
    (cur) =>
      cur.status !== 'running'
        ? { pid: null }
        : {
            status: reported?.status ?? (code === 0 ? 'done' : 'failed'),
            summary: reported?.summary || lastLines(output, 1) || `exited with code ${code}`,
            exitCode: code,
            pid: null,
            seen: false,
          },
    env,
  );
  return after.status === 'failed' ? code || 1 : 0;
}

interface HookPayload {
  last_assistant_message?: string;
  error?: string;
  error_type?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

/**
 * A Claude Code hook in an arm (`octomaxxing _hook prompt|stop`). Returns what to print: on a stop whose turn did not
 * report (no STATUS line, or no message to a Claude head), the arm is sent back once to do it.
 */
export function applyHook(name: string, payload: HookPayload, id: string, env: NodeJS.ProcessEnv = process.env): string {
  const live = (s: Task['status']) => s === 'running' || FINISHED.includes(s);
  if (name === 'prompt') {
    mutateTask(id, (cur) => (live(cur.status) && cur.status !== 'running' ? { status: 'running' } : null), env);
    return '';
  }
  if (name === 'stop-failure') {
    // The turn ended on an API error (rate limit, overload...): the session is idle, so the head must hear about it.
    const why = [payload.error, payload.error_type, payload.last_assistant_message].find((v) => typeof v === 'string' && v.trim());
    mutateTask(id, (cur) => (cur.status === 'running' ? { status: 'blocked', summary: `The turn ended with an error${why ? `: ${lastLines(why, 1)}` : ''}. Send a follow-up to retry.`, seen: false } : null), env);
    return '';
  }
  if (name !== 'stop') throw new Error(`unknown hook "${name}"`);
  const message = payload.last_assistant_message ?? '';
  if (message.trim()) appendFileSync(logFile(id, env), `\n=== turn ended ${new Date().toISOString()} ===\n${message.trim()}\n`);
  const report = parseStatus(message);
  let out = '';
  mutateTask(
    id,
    (cur) => {
      if (!live(cur.status)) return null;
      if (!payload.stop_hook_active) {
        const messaged = !headIsClaude(env) || transcriptMessagedHead(payload.transcript_path);
        if (!messaged || !report) {
          out = JSON.stringify({ decision: 'block', reason: reportReason(messaged, Boolean(report)) });
          return null;
        }
      }
      return { status: report?.status ?? 'done', summary: report?.summary || lastLines(message, 1) || 'The arm ended its turn without a STATUS line.', exitCode: null, seen: false };
    },
    env,
  );
  return out;
}

/** Give a finished arm a follow-up. A Claude arm resumes its session in a new tab; other agents run again with it. */
export function sendFollowUp(id: string, message: string, env: NodeJS.ProcessEnv = process.env): Task {
  if (!message.trim()) throw new Error('The message is empty');
  const t = mutateTask(
    id,
    (cur) => {
      if (!FINISHED.includes(cur.status)) throw new Error(`Task ${id} is ${cur.status}; send works once the arm has finished a turn`);
      return { followUps: [...cur.followUps, message.trim()], status: 'queued', seen: true };
    },
    env,
  );
  // The old tab ends first; its exit starts the queue again, which reopens the arm.
  if (t.pid && runnerAlive(id, env)) killTree(t.pid);
  drain(env);
  return requireTask(id, env);
}

export interface CloseOptions {
  commit?: boolean;
  message?: string;
  force?: boolean;
}

/** Close an arm: stop its session, optionally commit its work to its branch, then remove its worktree. Never merges or pushes. */
export function closeArm(id: string, opts: CloseOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  const reviewers = listTasks(env).filter((r) => r.reviewOf === id && r.status !== 'closed');
  if (reviewers.length) throw new Error(`Close the review first: ${reviewers.map((r) => r.id).join(', ')}`);
  // Claim the task first: from here on, drain will not start it and its tab will not overwrite it.
  let previous = 'queued' as Task['status'];
  const t = mutateTask(
    id,
    (cur) => {
      if (cur.status === 'closed' || cur.status === 'closing') throw new Error(`Task ${id} is already ${cur.status}`);
      if (cur.status === 'running' && !opts.force) throw new Error(`Task ${id} is still running. Wait for it, or use --force to stop it.`);
      previous = cur.status;
      return { status: 'closing' };
    },
    env,
  );
  const out: string[] = [];
  try {
    if (t.pid && runnerAlive(id, env)) killTree(t.pid);
    if (t.worktree && t.repo && t.branch) {
      if (existsSync(t.worktree)) {
        if (opts.commit) {
          const sha = commitAll(t.worktree, t.branch, opts.message?.trim() || t.title);
          out.push(sha ? `Committed ${sha} to branch ${t.branch}:` : 'Nothing to commit.', ...(sha ? committedFiles(t.worktree, sha).map((f) => `  ${f}`) : []));
        } else {
          const changes = changedFiles(t.worktree);
          if (changes.length && !opts.force) throw new Error(`Task ${id} has ${changes.length} changed files. Use --commit to keep them on branch ${t.branch}, or --force to discard them.`);
        }
      }
      removeWorktree(t.repo, t.worktree);
      out.push(deleteBranchIfUnused(t.repo, t.branch, t.baseSha) ? `Removed the unused branch ${t.branch}.` : `Branch ${t.branch} kept. Nothing was merged or pushed.`);
    } else if (opts.commit) {
      out.push('This arm worked in place (not a git worktree), so there is nothing to commit.');
    }
    // Claude Code adds an entry for every folder a session ran in: drop the arm's worktree, and a folder only we trusted.
    for (const dir of [t.worktree, t.trustAdded && !t.worktree ? t.cwd : null]) {
      if (!dir) continue;
      try {
        forgetFolder(dir, env);
      } catch (err) {
        out.push(`Warning: could not remove ${dir} from ~/.claude.json: ${(err as Error).message}`);
      }
    }
    removeTabConfig(t.tabConfig);
    mutateTask(id, () => ({ status: 'closed', pid: null, tabConfig: null }), env);
    out.push(`Closed ${id}.`);
  } catch (err) {
    mutateTask(id, () => ({ status: previous === 'running' ? 'failed' : previous, pid: null }), env);
    throw err;
  }
  const started = drain(env);
  if (started.length) out.push(`Started queued: ${started.join(', ')}`);
  return out;
}

function describeResults(tasks: Task[]): string {
  return tasks.map((t) => `${t.id}  ${t.status}  [${t.project}] ${t.title}\n    ${t.summary ?? ''}`).join('\n');
}

/** Results nobody has seen yet (optionally only for some ids); marks them seen. */
function takeFresh(ids: string[], env: NodeJS.ProcessEnv): Task[] {
  return withLock(lockPath('inbox', env), () => {
    const fresh = listTasks(env).filter((t) => FINISHED.includes(t.status) && !t.seen && (!ids.length || ids.includes(t.id)));
    for (const t of fresh) mutateTask(t.id, () => ({ seen: true }), env);
    return fresh;
  });
}

/** Arms that finished a turn since the head last looked; marks them seen. */
export function inbox(env: NodeJS.ProcessEnv = process.env): string {
  drain(env); // the head runs inbox often: queued arms also start here as RAM frees up
  const fresh = takeFresh([], env);
  return fresh.length ? describeResults(fresh) : 'Inbox empty.';
}

/** Wait until an arm (any, or one of ids) finishes a turn. Also starts queued arms as RAM frees up. */
export async function waitForArms(ids: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env, pollMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    drain(env);
    const fresh = takeFresh(ids, env);
    if (fresh.length) return `${describeResults(fresh)}\nDetails: octomaxxing status <id>`;
    const open = listTasks(env).filter((t) => (t.status === 'queued' || t.status === 'running') && (!ids.length || ids.includes(t.id)));
    if (!open.length) return 'Nothing is running or queued, and nothing new has finished.';
    if (Date.now() >= deadline) return `No arm finished within ${Math.round(timeoutMs / 60_000)} min. Run octomaxxing wait again.`;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

export function statusText(id: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  drain(env);
  if (id) {
    const t = requireTask(id, env);
    const lines = [
      `${t.id}  ${t.status}  [${t.project}] ${t.title}`,
      `agent:   ${t.agent}   runs: ${t.runs}   updated ${age(t.updatedAt)} ago${runnerAlive(t.id, env) ? `   tab open: ${armName(t.id)}` : ''}`,
      `folder:  ${t.cwd}${t.branch ? `   branch: ${t.branch}` : ''}${t.reviewOf ? `   reviewing: ${t.reviewOf}` : ''}`,
    ];
    if (t.summary) lines.push(`result:  ${t.summary}`);
    if (t.followUps.length) lines.push(`follow-ups: ${t.followUps.length}`);
    if (t.worktree && existsSync(t.worktree)) {
      const files = changedFiles(t.worktree);
      lines.push(files.length ? `changed files (what close --commit would commit):\n${files.map((f) => `  ${f}`).join('\n')}` : 'changed files: none');
    }
    lines.push(`output:  ${logFile(t.id, env)}`);
    return lines.join('\n');
  }
  const open = listTasks(env).filter((t) => t.status !== 'closed');
  const config = loadConfig(env);
  const running = open.filter((t) => t.status === 'running').length;
  const head = `Arms: ${running} running, ${open.filter((t) => t.status === 'queued').length} queued. Free RAM ${freeMemMb(env)} MB (an arm starts while ${config.armMb} MB for it still leaves ${config.reserveMb} MB).`;
  if (!open.length) return `${head} No open tasks.`;
  return [head, ...open.map((t) => `${t.id}  ${t.status.padEnd(8)}  [${t.project}] ${t.title}  (${age(t.updatedAt)})`)].join('\n');
}

const GREETINGS = [
  '🐙 Tentacles warmed up.',
  "🐙 Ready to maxx. Hand me the work, I'll hand it out.",
  '🐙 Head online.',
  '🐙 All arms stretched. Point me at something.',
  '🐙 Octomaxxing online. What are we maxxing today?',
  '🐙 Eight arms, zero excuses.',
];

/** The head's opening lines: a rotating one-liner plus live status. */
export function greeting(env: NodeJS.ProcessEnv = process.env, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  refresh(env);
  const tasks = listTasks(env);
  const running = tasks.filter((t) => t.status === 'running').length;
  const waiting = tasks.filter((t) => FINISHED.includes(t.status) && !t.seen).map((t) => t.id);
  const projects = loadProjects(env).length;
  const status = `${projects} project${projects === 1 ? '' : 's'} · ${running} arm${running === 1 ? '' : 's'} running · ${freeMemMb(env)} MB free · inbox: ${waiting.length ? waiting.join(', ') : 'empty'}`;
  return `${GREETINGS[pick(GREETINGS.length)]}\n${status}`;
}

const CLAUDE_HEAD = `## Talking to arms (you are Claude Code)

- Claude arms are sessions named \`octomaxxing-<id>\` in terminal tabs, and they message the session named \`octomaxxing-head\` when a turn ends. Your session needs that name: if you were started with /octomaxxing, ask the user once to type \`/rename octomaxxing-head\`.
- To answer an arm whose tab is still open, use SendMessage to \`octomaxxing-<id>\`: the arm carries on in the same session. \`octomaxxing send\` restarts its session in a new tab instead.
- Messages from arms can be held for the user's approval, so never rely on them alone: \`octomaxxing wait\` and \`octomaxxing inbox\` always have every result.`;

/** The head's full instructions, for `octomaxxing head` and for the /octomaxxing skill (`octomaxxing brief`). */
export function headPrompt(agent: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = loadConfig(env);
  const others = Object.keys(config.agents).filter((a) => a !== agent);
  const drafts = join(home(env), 'drafts');
  const claude = isClaude(config.agents[agent]?.head ?? config.agents[agent]?.arm ?? []);
  return [
    readPrompt('head.md'),
    `## Your setup\n\n- You run as the "${agent}" agent. Pass \`--agent ${agent}\` to every spawn so arms use the same agent${others.length ? `, unless a task is better suited to another configured agent: ${others.join(', ')}` : ''}.\n- Write briefs and messages to new files in ${drafts} (create the folder if needed) and pass them with \`--brief-file\` or \`--file\`.`,
    ...(claude ? [CLAUDE_HEAD] : []),
    `## Start\n\nBegin your first reply with exactly these two lines, then wait for the user:\n\n${greeting(env)}`,
  ].join('\n\n') + '\n';
}

/** Remember which agent the head is, so Claude arms know whether to message it. */
export function noteHead(agent: string, env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  recordHead(agent, isClaude(config.agents[agent]?.head ?? config.agents[agent]?.arm ?? []), env);
}

/** Start the head in this terminal and wait for it to exit. */
export async function runHead(agentName: string | undefined, opts: { dryRun?: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const agent = pickAgent(config, agentName, env);
  const template = config.agents[agent]!.head;
  if (!template) throw new Error(`Agent "${agent}" has no "head" template: start the head with /octomaxxing inside it (octomaxxing install-skill), or use --agent with another agent.`);
  const file = join(home(env), 'head-prompt.md');
  const prompt = headPrompt(agent, env);
  const launch = buildLaunch(isClaude(template) ? claudeHeadTemplate(template) : template, { prompt, promptFile: file }, env);
  if (opts.dryRun) {
    process.stdout.write(`DRY RUN: would start the head (${agent}) in ${home(env)}:\n${describeLaunch(launch)}\n`);
    return 0;
  }
  writeFileSync(file, prompt);
  noteHead(agent, env);
  const childEnv = { ...env, OCTOMAXXING_HOME: home(env) };
  const child = spawnAgent(launch, { cwd: home(env), stdio: 'inherit', env: childEnv });
  return await new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', (c) => done(c ?? 1));
  });
}

/** Print an arm's output (for Claude arms: how each turn ended), then keep following it while it runs. */
export async function attach(id: string, env: NodeJS.ProcessEnv = process.env, out: NodeJS.WritableStream = process.stdout): Promise<void> {
  const log = logFile(id, env);
  if (requireTask(id, env).sessionId) out.write(`[${id} is a Claude session in the tab ${armName(id)}; this shows how each turn ended]\n`);
  let offset = 0;
  const flush = () => {
    if (!existsSync(log)) return;
    const buf = readFileSync(log);
    if (buf.length > offset) out.write(buf.subarray(offset));
    offset = buf.length;
  };
  for (;;) {
    flush();
    refresh(env);
    const t = requireTask(id, env);
    if (t.status !== 'running' && t.status !== 'queued') {
      flush();
      out.write(`\n[${t.id} is ${t.status}${t.summary ? `: ${t.summary}` : ''}]\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
