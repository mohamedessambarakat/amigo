import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, taskDataDir, taskDir, tasksDir } from './paths.ts';
import type { DeliveryMode } from './config.ts';
import type { Endpoint } from './terminal.ts';

/**
 * queued   waiting for a free squad member
 * running  the agent is working
 * verifying  (no longer set: amigo ran per-project checks here before the delivery modes replaced them)
 * done / blocked / question   the agent finished its turn (Claude) or run and said so (see parseStatus)
 * failed   the agent exited with an error, never started, or its tab closed mid-turn
 * closing  close is committing or cleaning up; nothing may start it again
 * closed   amigo closed it (committed or discarded)
 */
export type Status = 'queued' | 'running' | 'verifying' | 'done' | 'blocked' | 'question' | 'failed' | 'closing' | 'closed';

/** Statuses where the squad member is waiting for amigo. */
export const FINISHED: readonly Status[] = ['done', 'blocked', 'question', 'failed'];

/** A confirmed merge of a build's work: amigo's merge, or one GitHub reported (authority "forge"). */
export interface MergeRecord {
  /** The PR that was merged; none for a local-only fast-forward. */
  url?: string;
  /** The head commit that landed (pinned at merge time). */
  head: string;
  at: string;
  /** boss: the Boss said to merge it. yolo: the project's standing merge authority. forge: merged on GitHub, not by amigo. */
  authority: 'boss' | 'yolo' | 'forge';
  /** squash / merge / rebase, a local fast-forward, or merged on GitHub. */
  how: string;
  commit?: string;
}

export interface Task {
  id: string;
  title: string;
  project: string;
  agent: string;
  /** Where the agent runs: a worktree for git projects, else the project folder. */
  cwd: string;
  /** Builds only: amigo's clone of the project, the worktree, its branch and the commit it started from. */
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  baseSha: string | null;
  /** The worktree was leased from treehouse's pool (every build since projects became clones): close returns it to the pool. */
  leased?: boolean;
  /** The worktree's git dir under the repo (recorded when the worktree is made): git runs against it, never against <worktree>/.git. Missing on older tasks. */
  gitDir?: string;
  /** The messaging address (`uds:<socket>`) of the Claude session that spawned this squad member; it gets the squad member's results. */
  amigoAddress?: string;
  /** A scratch task (spawn --scratch): works in its own folder under the home, not a project and not git. */
  scratch?: boolean;
  /** The startup briefing's own squad member (see briefing.ts): one open at a time, and its scratch folder goes when it is closed. */
  briefing?: boolean;
  /** Set for a reviewer: the task whose folder it reads. */
  reviewOf?: string;
  /** Starts only once this task (same project) is closed with a commit, from that commit. */
  after?: string;
  /** The GitHub issue this task came from (spawn --issue). */
  issue?: { number: number; url: string; title: string };
  /** Set at close when the build's branch holds commits: the commit a task started --after it builds on. */
  committed?: string;
  /** A build's delivery mode, from the registry when it was spawned (see delivery.ts). */
  mode?: DeliveryMode;
  /** The PR a build's accepted ready line named (full URL, as GitHub printed it). */
  pr?: string;
  /** The PR's head commit as GitHub last reported it. */
  prHead?: string;
  /** local-only builds: the head of the latest accepted done, the one commit amigo merge may land. */
  localDoneHead?: string;
  /** Set once the build's work is confirmed merged. */
  merge?: MergeRecord;
  /** How many status-file lines this record has taken in (see report.ts). */
  statusSeen?: number;
  /** When the crew member's current turn began (Claude Code's prompt hook): a status line after it reports this turn. */
  turnStartedAt?: string;
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
  /** The terminal of the crew member's latest tab (see terminal.ts); its space is where a reviewer's tab goes. */
  endpoint?: Endpoint | null;
  exitCode?: number | null;
  /** The agent's STATUS line (or its last output line) from the latest run. */
  summary?: string;
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
/** The brief is a durable record: data/<id>/brief.md, beside a survey's report. */
export const briefFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDataDir(id, env), 'brief.md');
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
