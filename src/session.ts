import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, withLock, writeJsonAtomic } from './fsx.ts';
import { home, lockPath, stateDir } from './paths.ts';
import { run } from './proc.ts';

/**
 * One controlling amigo per home (ported from fm-lock / fm-session-lock-lib). The session that runs the
 * session-start digest takes state/session.lock; every other Claude session on the same home is read-only: it may look
 * (status, inbox, digest) but not spawn, send, close, drain or acknowledge wakes.
 *
 * Identity is the Claude Code process (CLAUDE_PID, which Claude sets for every command and hook it runs) plus its session
 * id. A session owns the lock when the recorded pid is its own, or when the lock carries its session id and the recorded
 * process is still alive (a resumed session keeps its id). A recorded process that is gone, or whose start time no longer
 * matches (a reused pid), leaves the lock free to reclaim; a live owner whose start time cannot be read keeps it.
 */
export interface SessionLock {
  pid: number;
  /** The process's start time as recorded at acquisition, to tell a reused pid apart. Null when it could not be read. */
  started: string | null;
  session: string | null;
  at: string;
  home: string;
}

export interface Identity {
  pid: number | null;
  session: string | null;
}

export const sessionLockPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'session.lock');

/** This process's Claude session, if it runs inside one: from Claude's own variables, or a hook payload's session id. */
export function identity(env: NodeJS.ProcessEnv, payloadSession?: string | null): Identity {
  const pid = Number(env.CLAUDE_PID);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, session: payloadSession || env.CLAUDE_CODE_SESSION_ID || null };
}

/** True when this process runs as a command or hook of a Claude session (crew members' sessions excluded by the caller). */
export const inClaudeSession = (me: Identity): boolean => me.pid !== null || me.session !== null;

/**
 * When process `pid` started, as a string that changes when the pid is reused; null when it cannot be read. Linux reads
 * /proc, macOS asks ps, Windows asks PowerShell (bounded: a slow answer counts as unreadable).
 */
export function processStarted(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    }
    if (platform === 'win32') {
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { timeoutMs: 8000 });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }
    const r = run('ps', ['-p', String(pid), '-o', 'lstart='], { timeoutMs: 5000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Whether the lock's recorded process still runs and is the same process (not a reused pid). */
export function holderAlive(lock: SessionLock): boolean {
  if (!pidAlive(lock.pid)) return false;
  if (!lock.started) return true;
  const now = processStarted(lock.pid);
  // An identity that cannot be read is not proof of death: keep the live owner.
  return now === null || now === lock.started;
}

/** The lock as recorded, or null when there is none or it is not a usable record. */
export function readSessionLock(env: NodeJS.ProcessEnv): SessionLock | null {
  try {
    const l = JSON.parse(readFileSync(sessionLockPath(env), 'utf8')) as SessionLock;
    return Number.isInteger(l.pid) && l.pid > 0 ? l : null;
  } catch {
    return null;
  }
}

export const ownsLock = (lock: SessionLock | null, me: Identity): boolean =>
  Boolean(lock) && ((me.pid !== null && lock!.pid === me.pid) || (me.session !== null && lock!.session === me.session && holderAlive(lock!)));

export type LockState = { state: 'owned'; lock: SessionLock } | { state: 'free'; lock: null } | { state: 'stale'; lock: SessionLock } | { state: 'foreign'; lock: SessionLock };

export function lockState(env: NodeJS.ProcessEnv, me: Identity): LockState {
  const lock = readSessionLock(env);
  if (!lock) return { state: 'free', lock: null };
  if (ownsLock(lock, me)) return { state: 'owned', lock };
  return holderAlive(lock) ? { state: 'foreign', lock } : { state: 'stale', lock };
}

export type Acquired =
  | { result: 'acquired' | 'reanchored' | 'reclaimed'; lock: SessionLock; previous?: SessionLock }
  | { result: 'held'; lock: SessionLock }
  | { result: 'no-session' };

/** Take the session lock for this Claude session: free, stale and own locks are taken; a live foreign owner keeps it. */
export function acquireSessionLock(env: NodeJS.ProcessEnv, me: Identity): Acquired {
  if (me.pid === null) return { result: 'no-session' };
  return withLock(lockPath('session', env), () => {
    const cur = lockState(env, me);
    if (cur.state === 'foreign') return { result: 'held' as const, lock: cur.lock };
    const sameProcess = cur.state === 'owned' && cur.lock.pid === me.pid;
    const lock: SessionLock = {
      pid: me.pid!,
      started: sameProcess ? cur.lock.started : processStarted(me.pid!),
      session: me.session,
      at: new Date().toISOString(),
      home: home(env),
    };
    writeJsonAtomic(sessionLockPath(env), lock);
    if (cur.state === 'owned') return { result: 'reanchored' as const, lock, previous: cur.lock };
    if (cur.state === 'stale') return { result: 'reclaimed' as const, lock, previous: cur.lock };
    return { result: 'acquired' as const, lock };
  });
}

/** Give the lock up, only if this session holds it. */
export function releaseSessionLock(env: NodeJS.ProcessEnv, me: Identity): boolean {
  return withLock(lockPath('session', env), () => {
    if (!ownsLock(readSessionLock(env), me)) return false;
    rmSync(sessionLockPath(env), { force: true });
    return true;
  });
}

export const describeHolder = (l: SessionLock): string => `pid ${l.pid}${l.session ? `, session ${l.session}` : ''}, since ${l.at}`;

/**
 * Why this process may not run a managing command, or null when it may. Only another Claude session is refused while a
 * live session holds the lock: the Boss at a plain terminal is never locked out of his own home.
 */
export function controlRefusal(env: NodeJS.ProcessEnv): string | null {
  if (!existsSync(sessionLockPath(env))) return null;
  const me = identity(env);
  if (!inClaudeSession(me)) return null;
  const cur = lockState(env, me);
  if (cur.state !== 'foreign') return null;
  return `This session is read-only: another amigo session controls ${home(env)} (${describeHolder(cur.lock)}). Work in that session, or close it first; a new session takes over once it is gone.`;
}
