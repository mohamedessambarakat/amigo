import { readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, noticesPath } from './paths.ts';

/**
 * A result that is not a squad member's task, such as the briefing's live checks. It waits in the inbox until it is seen once.
 * `running` ones are still being produced: the producer beats (touchNotice) while it works, and `wait` keeps waiting for a
 * notice that beat recently. A producer silent for STALE_MS is taken as dead and reported so; if it was only slow and
 * finishes later, its real result is delivered then (finishNotice).
 */
export interface Notice {
  id: string;
  title: string;
  text: string;
  state: 'running' | 'done';
  at: string;
  /** The producer's last sign of life while running. */
  beatAt?: string;
  seen: boolean;
}

/** The producer beats every BEAT_MS; this many silent ms mean it died (a missed beat or two must not). */
export const BEAT_MS = 5_000;
export const STALE_MS = 90_000;

const load = (env: NodeJS.ProcessEnv): Notice[] => readJson<Notice[]>(noticesPath(env), []);

function change<T>(env: NodeJS.ProcessEnv, fn: (all: Notice[]) => { all: Notice[]; result: T }): T {
  return withLock(lockPath('notices', env), () => {
    const { all, result } = fn(load(env));
    writeJsonAtomic(noticesPath(env), all);
    return result;
  });
}

/** Start a notice that replaces any earlier one with the same title. Returns its id. */
export function beginNotice(title: string, env: NodeJS.ProcessEnv): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const at = new Date().toISOString();
  return change(env, (all) => ({ all: [...all.filter((n) => n.title !== title), { id, title, text: '', state: 'running', at, beatAt: at, seen: false }], result: id }));
}

/** The producer is alive. */
export function touchNotice(id: string, env: NodeJS.ProcessEnv): void {
  change(env, (all) => ({ all: all.map((n) => (n.id === id && n.state === 'running' ? { ...n, beatAt: new Date().toISOString() } : n)), result: undefined }));
}

/** Fill in the result. It is shown even when a stale-notice report already went out: a slow producer's result is never lost. */
export function finishNotice(id: string, text: string, env: NodeJS.ProcessEnv): void {
  change(env, (all) => ({ all: all.map((n) => (n.id === id ? { ...n, text, state: 'done' as const, at: new Date().toISOString(), seen: false } : n)), result: undefined }));
}

const isStale = (n: Notice, now: number): boolean => n.state === 'running' && now - Date.parse(n.beatAt ?? n.at) > STALE_MS;

/** Notices nobody has seen that are finished (or whose producer died); marks them seen. */
export function takeNotices(env: NodeJS.ProcessEnv, now = Date.now()): Notice[] {
  if (!load(env).some((n) => !n.seen)) return [];
  return change(env, (all) => {
    const fresh = all.filter((n) => !n.seen && (n.state === 'done' || isStale(n, now))).map((n) => (n.state === 'done' ? n : { ...n, text: 'The checks stopped reporting: the process running them seems to have died. If it was only slow, its result still arrives here.' }));
    const ids = new Set(fresh.map((n) => n.id));
    return { all: all.map((n) => (ids.has(n.id) ? { ...n, seen: true } : n)), result: fresh };
  });
}

/** Is a producer still at work (beat recently) on a notice nobody has seen? */
export function noticesPending(env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  return load(env).some((n) => n.state === 'running' && !n.seen && !isStale(n, now));
}
