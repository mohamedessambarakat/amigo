import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, taskDir, tasksDir } from './paths.ts';

/**
 * queued   waiting for a free arm
 * running  the agent is working
 * done / blocked / question   the agent finished its run and said so (see parseStatus)
 * failed   the agent exited with an error, or never started
 * closing  close is committing or cleaning up; nothing may start it again
 * closed   the head closed it (committed or discarded)
 */
export type Status = 'queued' | 'running' | 'done' | 'blocked' | 'question' | 'failed' | 'closing' | 'closed';

/** Statuses where the arm is waiting for the head. */
export const FINISHED: readonly Status[] = ['done', 'blocked', 'question', 'failed'];

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
  /** Set for a reviewer: the task whose folder it reads. */
  reviewOf?: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  /** How many times the agent was started (1 + follow-ups). */
  runs: number;
  /** Follow-up messages from the head, oldest first. */
  followUps: string[];
  pid?: number | null;
  exitCode?: number | null;
  /** The agent's STATUS line (or its last output line) from the latest run. */
  summary?: string;
  /** False until the head has seen this result in `inbox`. */
  seen: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function assertValidId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Invalid task id "${id}"`);
}

export function newId(title: string, rand: () => string = () => randomBytes(4).toString('hex')): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return `${slug || 'task'}-${rand()}`;
}

export const taskFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'task.json');
export const briefFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'brief.md');
export const promptFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'prompt.md');
export const logFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'output.log');
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

/** The runner touches this file while its agent runs; pids alone are not trusted (they get reused after a reboot). */
export function beat(id: string, env: NodeJS.ProcessEnv = process.env): void {
  writeFileSync(heartbeatFile(id, env), String(Date.now()));
}

/** True while the runner's heartbeat is recent. */
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
  if (!t) throw new Error(`No task "${id}" (see octomaxxing status)`);
  return t;
}

export function saveTask(task: Task, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(taskFile(task.id, env), task);
}

/** Read-modify-write one task under a lock, so the runner and the CLI never overwrite each other. */
export function mutateTask(id: string, fn: (t: Task) => Partial<Task> | null, env: NodeJS.ProcessEnv = process.env): Task {
  return withLock(lockPath(`task-${id}`, env), () => {
    const t = requireTask(id, env);
    const patch = fn(t);
    if (!patch) return t;
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
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
