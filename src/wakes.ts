import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, stateDir } from './paths.ts';

/**
 * The durable wake queue (ported from fm-wake-lib / fm-wake-drain). The watcher appends every actionable event
 * here before it closes, so a wake survives a session that dies before handling it. amigo drains the queue, handles each
 * row, then acknowledges with the exact command the drain printed.
 *
 * Two facts are kept apart, as in the original:
 *   - consumption is bound to the monotonic sequence: `ack --through <seq>` deletes rows at or below it, never a newer one;
 *   - the episode is bound to the generation: every append opens a new generation, and only an acknowledgement naming the
 *     current generation, with nothing left queued, closes the episode. A stale generation still consumes its rows and says
 *     how to catch up (drain again).
 * `announced` is the newest generation already shown to amigo (by a watcher close or a drain): a watcher that starts with
 * rows queued past it closes at once with a recovery wake, and never twice for the same generation.
 */
export type WakeKind = 'signal' | 'stale' | 'check' | 'heartbeat' | 'recovery';

export interface WakeRow {
  seq: number;
  kind: WakeKind;
  /** What the row is about (`task:<id>`, `check:<name>`...): a drain shows only the newest row per key. */
  key: string;
  reason: string;
  at: string;
}

export interface WakeQueue {
  seq: number;
  generation: number;
  announced: number;
  rows: WakeRow[];
}

const KINDS: readonly WakeKind[] = ['signal', 'stale', 'check', 'heartbeat', 'recovery'];

export const queuePath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'wake-queue.json');
const queueLock = (env: NodeJS.ProcessEnv): string => lockPath('wake-queue', env);
/** The watcher's terminal-delivery ledger: one JSON line per reason a watcher printed, so an attached arm can report it. */
export const deliveriesPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'watch-deliveries.jsonl');

const EMPTY: WakeQueue = { seq: 0, generation: 0, announced: 0, rows: [] };

const usable = (r: unknown): r is WakeRow => {
  const row = r as WakeRow;
  return Boolean(row) && Number.isInteger(row.seq) && row.seq > 0 && KINDS.includes(row.kind) && typeof row.key === 'string' && typeof row.reason === 'string' && typeof row.at === 'string';
};

/**
 * The queue as stored. A file that does not parse is moved aside (never lost: it was the only record of its rows) and the
 * queue starts again with one recovery row naming where it went. Rows that lost a field are dropped with the same notice.
 */
function load(env: NodeJS.ProcessEnv): WakeQueue {
  const file = queuePath(env);
  if (!existsSync(file)) return { ...EMPTY, rows: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const aside = `${file}.unreadable-${Date.now()}`;
    renameSync(file, aside);
    return { seq: 1, generation: 1, announced: 0, rows: [{ seq: 1, kind: 'recovery', key: 'queue', reason: `recovery: the wake queue could not be read (${(err as Error).message}); its old contents are in ${aside}`, at: new Date().toISOString() }] };
  }
  const q = raw as Partial<WakeQueue>;
  const rows = Array.isArray(q.rows) ? q.rows : [];
  const good = rows.filter(usable);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  // A lost or broken counter must never let an outstanding acknowledgement consume a newer row: number past every row.
  const seq = Math.max(num(q.seq), ...good.map((r) => r.seq), 0);
  const out: WakeQueue = { seq, generation: num(q.generation), announced: num(q.announced), rows: good };
  if (good.length < rows.length) {
    const dropped = rows.filter((r) => !usable(r)).slice(0, 20).map((r) => JSON.stringify(r)).join('; ');
    out.seq += 1;
    out.generation += 1;
    out.rows.push({ seq: out.seq, kind: 'recovery', key: 'queue', reason: `recovery: ${rows.length - good.length} unusable wake row(s) were removed: ${dropped}`, at: new Date().toISOString() });
  }
  return out;
}

function change<T>(env: NodeJS.ProcessEnv, fn: (q: WakeQueue) => T): T {
  return withLock(queueLock(env), () => {
    const q = load(env);
    const result = fn(q);
    writeJsonAtomic(queuePath(env), q);
    return result;
  });
}

/** Read the queue without changing it. */
export function readQueue(env: NodeJS.ProcessEnv): WakeQueue {
  return withLock(queueLock(env), () => load(env));
}

/** Append one actionable wake. Every append opens a new generation, so even a repeat of an acknowledged row is recovered. */
export function appendWake(kind: WakeKind, key: string, reason: string, env: NodeJS.ProcessEnv): WakeRow {
  return change(env, (q) => {
    q.seq += 1;
    q.generation += 1;
    const row: WakeRow = { seq: q.seq, kind, key, reason, at: new Date().toISOString() };
    q.rows.push(row);
    return row;
  });
}

/** Rows are queued that amigo has not been shown yet. */
export const recoveryPending = (q: WakeQueue): boolean => q.rows.length > 0 && q.announced < q.generation;

/** The current generation has been shown to amigo (a watcher printed its reason). */
export function markAnnounced(env: NodeJS.ProcessEnv): void {
  change(env, (q) => {
    q.announced = q.generation;
  });
}

/**
 * If rows wait that amigo was never shown, mark them shown and return the one recovery reason that announces them; null
 * otherwise. A generation is announced at most once: a later empty start stays quiet until a new row arrives.
 */
export function takeRecovery(env: NodeJS.ProcessEnv): string | null {
  return change(env, (q) => {
    if (!recoveryPending(q)) return null;
    q.announced = q.generation;
    return `recovery: ${q.rows.length} queued wake(s) not yet handled (newest: ${q.rows[q.rows.length - 1]!.reason.split('\n')[0]})`;
  });
}

export interface Drained {
  rows: WakeRow[];
  through: number;
  generation: number;
}

/**
 * The newest row of each kind and key, oldest first: an older row about the same thing is covered by the newer one. A
 * check row is the event itself, so check rows collapse only when their text is identical (as fm_wake_print_deduped).
 */
export function latestPerKey(rows: WakeRow[]): WakeRow[] {
  const newest = new Map<string, WakeRow>();
  for (const r of rows) newest.set(r.kind === 'check' ? `${r.kind}|${r.key}|${r.reason}` : `${r.kind}|${r.key}`, r);
  return [...newest.values()].sort((a, b) => a.seq - b.seq);
}

/** Present the queue: every row stays until it is acknowledged, so an interrupted handling turn sees it again. */
export function drainWakes(env: NodeJS.ProcessEnv): Drained {
  return change(env, (q) => {
    q.announced = q.generation;
    return { rows: [...q.rows], through: q.rows.reduce((m, r) => Math.max(m, r.seq), 0), generation: q.generation };
  });
}

export const ackCommand = (through: number, generation: number): string => `amigo wake ack --through ${through} --generation ${generation}`;

/** The drain as amigo reads it: the rows, then the exact acknowledgement to run once every row is handled. */
export function describeDrain(d: Drained): string {
  if (!d.rows.length) return 'WAKE QUEUE: empty.';
  const shown = latestPerKey(d.rows);
  const lines = shown.map((r) => `  [${r.seq}] ${r.reason}`);
  const covered = d.rows.length - shown.length;
  return [
    `WAKE QUEUE: ${d.rows.length} wake(s)${covered ? ` (${covered} older one(s) covered by a newer wake about the same thing)` : ''}:`,
    ...lines,
    `WAKE_ACK_REQUIRED: ${ackCommand(d.through, d.generation)}`,
    'Handle every wake above (and reconcile amigo inbox), then run that exact command. Until then the wakes stay queued.',
  ].join('\n');
}

/**
 * Acknowledge: delete the rows at or below `through`. The episode closes only when `generation` is still current and nothing
 * is left. Returns what happened, in words amigo can act on.
 */
export function ackWakes(through: number, generation: number, env: NodeJS.ProcessEnv): string {
  if (!Number.isInteger(through) || through < 0 || !Number.isInteger(generation) || generation < 0) throw new Error('wake ack needs --through <seq> and --generation <n>, as the drain printed them');
  return change(env, (q) => {
    const before = q.rows.length;
    q.rows = q.rows.filter((r) => r.seq > through);
    const removed = before - q.rows.length;
    const left = q.rows.length;
    if (!removed && left) {
      const newest = q.rows.reduce((m, r) => Math.max(m, r.seq), 0);
      return `Acknowledged nothing: every queued wake is newer than ${through}. Run amigo wake drain, handle them, then: ${ackCommand(newest, q.generation)}`;
    }
    if (generation !== q.generation) {
      return `Acknowledged ${removed} wake(s) through ${through}. Newer wakes arrived after that drain (generation ${q.generation}, ${left} queued): run amigo wake drain again.`;
    }
    if (left) return `Acknowledged ${removed} wake(s); ${left} newer one(s) remain: run amigo wake drain.`;
    return `Acknowledged ${removed} wake(s); the queue is empty.`;
  });
}

// ---------- terminal-delivery ledger ----------

export interface Delivery {
  pid: number;
  token: string;
  reason: string;
  at: string;
}

const LEDGER_KEEP = 200;

/** Record the reason a watcher printed, before it lets go of its lock. */
export function recordDelivery(d: Delivery, env: NodeJS.ProcessEnv): void {
  const file = deliveriesPath(env);
  appendFileSync(file, `${JSON.stringify(d)}\n`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > LEDGER_KEEP * 2) writeFileSync(file, `${lines.slice(-LEDGER_KEEP).join('\n')}\n`);
}

/** The reason the watcher with this token printed, if it printed one. */
export function findDelivery(token: string, env: NodeJS.ProcessEnv): Delivery | null {
  let text = '';
  try {
    text = readFileSync(deliveriesPath(env), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Delivery;
      if (d.token === token) return d;
    } catch {
      // a torn last line is skipped
    }
  }
  return null;
}
