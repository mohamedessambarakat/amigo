import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { home, lockPath, stateDir } from './paths.ts';
import { run } from './proc.ts';
import { processStarted } from './session.ts';
import { drain, refresh } from './squad.ts';
import { prWatch } from './merge.ts';
import { declaredWait as statusWait, readStatus, statusFile } from './status.ts';
import { FINISHED, listTasks, logFile, runnerAlive, type Task } from './tasks.ts';
import { terminalBackend, type EndpointState } from './terminal.ts';
import { appendWake, findDelivery, markAnnounced, readQueue, recordDelivery, takeRecovery, type WakeKind } from './wakes.ts';

/**
 * The zero-token watcher (ported from fm-watch.sh and fm-watch-arm.sh). It sleeps on the fleet, classifies every
 * event in code, absorbs the benign majority, and closes only for an actionable one, printing one reason line per wake:
 *
 *   signal: <id> <status>: <summary>   a crew member finished a turn amigo has not read (done, blocked, question, failed)
 *   stale: <id> (...)                  a crew member stopped responding: its session died mid-turn, or it made no progress
 *                                      past the threshold with no declared wait
 *   check: <name>: <output>            a registered check printed something (always actionable)
 *   heartbeat ...                      backstop: results stay unread, with a backing-off cadence
 *   recovery: ...                      wakes were queued while nobody was watching
 *
 * Every actionable reason is appended to the durable wake queue (wakes.ts) before it is printed. One watcher runs per home
 * (state/watch.lock); it touches state/watcher-beat every poll, and nothing else touches that beacon, so a wedged watcher can
 * never look healthy. A second arm attaches to a healthy watcher and reports the reason it closed with.
 */

// ---------- tunables (seconds unless named otherwise) ----------

const num = (v: string | undefined, fallback: number, min = 0): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= min ? n : fallback;
};

export interface WatchTunables {
  /** Seconds between polls. */
  poll: number;
  /** A crew member whose agent is idle with no progress for this long, and no declared wait, stopped responding. */
  staleIdle: number;
  /** The same when the terminal cannot tell busy from idle. */
  staleUnknown: number;
  /** A busy agent with no progress for this long may be wedged (a hung tool call). */
  busyMax: number;
  /** A declared wait is rechecked once per this long. */
  pauseResurface: number;
  /** Seconds between re-escalations of one stale episode. */
  staleEscalate: number;
  heartbeat: number;
  heartbeatMax: number;
  checkInterval: number;
  checkTimeout: number;
  /** Seconds between live reads of a build's open PR (CI and merge state). */
  prPoll: number;
  /** Seconds to linger after a signal, so crew members finishing together make one wake. */
  signalGrace: number;
  /** The longest one watcher cycle runs before it closes with a heartbeat (below the Stop hook's 8 h limit). */
  maxCycle: number;
}

export function tunables(env: NodeJS.ProcessEnv): WatchTunables {
  const poll = num(env.AMIGO_POLL_SECS, 15, 0.05);
  return {
    poll,
    staleIdle: num(env.AMIGO_STALE_SECS, 240),
    staleUnknown: num(env.AMIGO_STALE_UNKNOWN_SECS, 1800),
    busyMax: num(env.AMIGO_BUSY_MAX_SECS, 3600),
    pauseResurface: num(env.AMIGO_PAUSE_RESURFACE_SECS, 14_400),
    staleEscalate: num(env.AMIGO_STALE_ESCALATE_SECS, 240),
    heartbeat: num(env.AMIGO_HEARTBEAT_SECS, 600),
    heartbeatMax: num(env.AMIGO_HEARTBEAT_MAX_SECS, 7200),
    checkInterval: num(env.AMIGO_CHECK_INTERVAL_SECS, 300),
    checkTimeout: num(env.AMIGO_CHECK_TIMEOUT_SECS, 30, 1),
    prPoll: num(env.AMIGO_PR_POLL_SECS, 120),
    signalGrace: num(env.AMIGO_SIGNAL_GRACE_SECS, 5),
    maxCycle: num(env.AMIGO_WATCH_MAX_SECS, 6 * 3600, 1),
  };
}

/** How old the beacon may be while the watcher counts as healthy: max(300, poll + 60), as fm_poll_derived_grace. */
export const watcherGrace = (env: NodeJS.ProcessEnv): number => num(env.AMIGO_GUARD_GRACE_SECS, Math.max(300, tunables(env).poll + 60), 1);

// ---------- files ----------

export const watchLockPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'watch.lock');
export const beaconPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'watcher-beat');
const memoryPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'watch-memory.json');
export const checksDir = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'checks');

interface WatchLock {
  pid: number;
  token: string;
  /** The process's start time (session.ts processStarted), to tell a reused pid apart. */
  started: string | null;
  startedAt: string;
}

/** What the watcher remembers between cycles, so a re-armed watcher never re-surfaces what an earlier one already did. */
interface Memory {
  /** task id -> the `<status>|<updatedAt>` signature last surfaced. */
  surfaced: Record<string, string>;
  /** task id -> the stale episode: the progress time it is about, how many times it surfaced, and when last. */
  stale: Record<string, { progress: number; count: number; at: number }>;
  heartbeat: { at: number; interval: number; unread: string };
  checks: Record<string, number>;
  /** task id -> the PR state last surfaced, and when the PR was last read. */
  prs: Record<string, { sig: string; at: number }>;
  /** task id -> the `<status>|<updatedAt>` of a finished turn whose session was already reported gone. */
  gone: Record<string, string>;
}

const loadMemory = (env: NodeJS.ProcessEnv): Memory => {
  const m = readJson<Partial<Memory>>(memoryPath(env), {});
  return { surfaced: m.surfaced ?? {}, stale: m.stale ?? {}, heartbeat: m.heartbeat ?? { at: 0, interval: 0, unread: '' }, checks: m.checks ?? {}, prs: m.prs ?? {}, gone: m.gone ?? {} };
};

// ---------- registered checks ----------

/** A command the watcher runs every interval in the background; anything it prints wakes amigo. */
export interface CheckSpec {
  name: string;
  argv: string[];
  cwd?: string;
  /** Seconds between runs; the watcher's check interval when absent. */
  every?: number;
  /** The task it belongs to, if any; teardown of that task removes it. */
  task?: string;
}

const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function registerCheck(spec: CheckSpec, env: NodeJS.ProcessEnv): void {
  if (!CHECK_NAME.test(spec.name)) throw new Error(`Invalid check name "${spec.name}"`);
  if (!spec.argv.length || !spec.argv[0]) throw new Error('A check needs a command');
  writeJsonAtomic(join(checksDir(env), `${spec.name}.json`), spec);
}

export function removeCheck(name: string, env: NodeJS.ProcessEnv): boolean {
  const file = join(checksDir(env), `${name}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function listChecks(env: NodeJS.ProcessEnv): CheckSpec[] {
  const dir = checksDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CheckSpec;
        return CHECK_NAME.test(s.name) && Array.isArray(s.argv) && s.argv.length ? [s] : [];
      } catch {
        return [];
      }
    });
}

// ---------- what needs supervision ----------

/** Why this home needs a watcher; empty when nothing does (every task closed, no checks, no queued wake). */
export function supervisionNeed(env: NodeJS.ProcessEnv): string[] {
  const open = listTasks(env).filter((t) => t.status !== 'closed');
  const checks = listChecks(env);
  const queued = readQueue(env).rows.length;
  return [
    open.length ? `${open.length} open task(s)` : '',
    checks.length ? `${checks.length} registered check(s)` : '',
    queued ? `${queued} queued wake(s)` : '',
  ].filter(Boolean);
}

// ---------- crew state ----------

const mtime = (file: string | null | undefined): number => {
  if (!file) return 0;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** The latest sign that a crew member is making progress: its record changed, its transcript or output log grew. */
export function lastProgress(t: Task, env: NodeJS.ProcessEnv): number {
  return Math.max(Date.parse(t.updatedAt) || 0, Date.parse(t.startedAt ?? '') || 0, mtime(t.transcriptPath), mtime(logFile(t.id, env)), mtime(statusFile(t.id, env)));
}

export interface DeclaredWait {
  what: string;
  until: number | null;
  at: number;
}

/**
 * The crew member's declared wait, if its latest status word (status.ts) is `paused: <what it waits on> [until <UTC time>]`.
 * A later working, done or other state line ends it.
 */
export function declaredWait(id: string, env: NodeJS.ProcessEnv): DeclaredWait | null {
  const w = statusWait(readStatus(id, env));
  if (!w) return null;
  const what = w.text.replace(/\s*\buntil\s+\S+\s*$/i, '').trim() || 'an external wait';
  return { what, until: w.until, at: w.since !== null ? w.since * 1000 : mtime(statusFile(id, env)) };
}

/** A failed status that means the crew member stopped responding: its tab or session went away in the middle of a turn. */
export const stoppedResponding = (t: Task): boolean =>
  t.status === 'failed' && /stopped without reporting|session ended in the middle of a turn|tab closed/i.test(t.summary ?? '');

const endpointState = (t: Task, env: NodeJS.ProcessEnv): EndpointState => {
  if (!t.endpoint) return { liveness: 'absent', busy: 'unknown', takesInput: false };
  try {
    return terminalBackend(env).state(t.endpoint);
  } catch {
    return { liveness: 'unreadable', busy: 'unknown', takesInput: false };
  }
};

const AT_REST: readonly Task['status'][] = ['done', 'blocked', 'question'];

/**
 * A Claude crew member that reported (done at its handoff, blocked, or a question) keeps its session open for amigo's next
 * message. When its runner and its tab are both gone it stopped responding at rest: the endpoint state, else null. An
 * unreadable endpoint is not proof it is gone. Other agents run once and exit after reporting, so they never count.
 */
export function goneAtRest(t: Task, env: NodeJS.ProcessEnv): EndpointState | null {
  if (!AT_REST.includes(t.status) || t.sessionStarted !== true || !t.endpoint || runnerAlive(t.id, env)) return null;
  const ep = endpointState(t, env);
  return ep.liveness === 'live' || ep.liveness === 'unreadable' ? null : ep;
}

/**
 * One line of a crew member's current state (fm-crew-state): the hooks' record, its terminal, and its progress.
 * `state: working|done|blocked|paused|failed|stopped|queued|closed|unknown · <detail>`.
 */
export function crewState(t: Task, env: NodeJS.ProcessEnv, now = Date.now()): string {
  const ep = endpointState(t, env);
  const idle = Math.round((now - lastProgress(t, env)) / 1000);
  const tab = `tab ${ep.liveness}${ep.busy === 'unknown' ? '' : `/${ep.busy}`}, runner ${runnerAlive(t.id, env) ? 'alive' : 'gone'}`;
  const wait = t.status === 'running' ? declaredWait(t.id, env) : null;
  if (t.status === 'running' || t.status === 'verifying') {
    if (!runnerAlive(t.id, env) && ep.liveness !== 'live') return `state: stopped · ${tab}; no progress for ${idle}s - its session is gone mid-turn`;
    if (wait) return `state: paused · ${tab}; waiting on ${wait.what}${wait.until ? ` until ${new Date(wait.until).toISOString()}` : ''}`;
    return `state: working · ${tab}; last progress ${idle}s ago`;
  }
  if (stoppedResponding(t)) return `state: stopped · ${tab}; ${t.summary}`;
  if (goneAtRest(t, env)) return `state: stopped · ${tab}; its session ended while it waited (${t.status}) - recover it`;
  if (FINISHED.includes(t.status)) return `state: ${t.status} · ${tab}; ${t.summary ?? ''}`.trim();
  return `state: ${t.status} · ${tab}`;
}

// ---------- one scan ----------

export interface Wake {
  kind: WakeKind;
  key: string;
  reason: string;
}

const firstLine = (s: string | undefined): string => (s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

/** Run one registered check, bounded. Its output, or its failure, is the wake; silence is nothing to report. */
function runRegisteredCheck(c: CheckSpec, timeoutSecs: number): string | null {
  const [cmd, ...args] = c.argv as [string, ...string[]];
  const r = run(cmd, args, { ...(c.cwd ? { cwd: c.cwd } : {}), timeoutMs: timeoutSecs * 1000 });
  if (r.error) return `check: ${c.name} could not run: ${r.error.message}`;
  const out = r.stdout.trim();
  if (r.status !== 0) return `check: ${c.name} failed (exit ${r.status}): ${(r.stderr.trim() || out).split(/\r?\n/).slice(-5).join(' | ') || 'no output'}`;
  return out ? `check: ${c.name}: ${out.split(/\r?\n/).slice(0, 20).join('\n  ')}` : null;
}

/**
 * Classify the fleet once. Returns the actionable wakes (empty: absorb and keep sleeping), already appended to the durable
 * wake queue. The memory of what was already surfaced is written after that append, under the caller's watcher lock.
 */
export function scan(env: NodeJS.ProcessEnv, now = Date.now()): Wake[] {
  const tun = tunables(env);
  try {
    // Tabs gone mid-turn become failed; queued crew members start as memory frees up (what `amigo wait` used to do).
    refresh(env);
    drain(env);
  } catch {
    // the classification below still runs on what is recorded
  }
  const mem = loadMemory(env);
  const tasks = listTasks(env);
  const wakes: Wake[] = [];

  for (const t of tasks) {
    // A session gone while the crew member waits at rest (handoff, blocked, question): surfaced once per finished turn.
    const gone = goneAtRest(t, env);
    if (gone) {
      const sig = `${t.status}|${t.updatedAt}`;
      if (mem.gone[t.id] !== sig) {
        mem.gone[t.id] = sig;
        wakes.push({ kind: 'stale', key: `task:${t.id}`, reason: `stale: ${t.id} (stopped responding: tab ${gone.liveness} and runner gone while it waited at ${t.status}. Its worktree and commits are kept; recover it, never spawn a fresh copy)` });
      }
    } else delete mem.gone[t.id];
    // Signals: a finished turn amigo has not read, surfaced once per distinct record.
    if (FINISHED.includes(t.status) && !t.seen) {
      const sig = `${t.status}|${t.updatedAt}`;
      if (mem.surfaced[t.id] !== sig) {
        mem.surfaced[t.id] = sig;
        const reason = stoppedResponding(t)
          ? `stale: ${t.id} (stopped responding: ${firstLine(t.summary)} Its worktree and commits are kept; recover it, never spawn a fresh copy)`
          : `signal: ${t.id} ${t.status}: ${firstLine(t.summary) || '(no summary)'}`;
        wakes.push({ kind: stoppedResponding(t) ? 'stale' : 'signal', key: `task:${t.id}`, reason });
      }
      delete mem.stale[t.id];
      continue;
    }
    if (t.status !== 'running') {
      delete mem.stale[t.id];
      if (t.status === 'closed') delete mem.surfaced[t.id];
      continue;
    }
    // Stale: no progress past the threshold for what the terminal says the agent is doing, and no declared wait.
    const progress = lastProgress(t, env);
    const ep = endpointState(t, env);
    if (ep.liveness !== 'live' && !runnerAlive(t.id, env)) continue; // refresh turns a lost tab into a failed signal
    const idle = (now - progress) / 1000;
    const wait = declaredWait(t.id, env);
    const episode = mem.stale[t.id];
    const fresh = !episode || episode.progress !== progress;
    if (wait && (wait.until === null || now < wait.until)) {
      // A declared wait idles on purpose: rechecked on the long cadence (or once its named time passes), never a wedge.
      const due = fresh ? idle >= tun.pauseResurface : (now - episode.at) / 1000 >= tun.pauseResurface;
      if (due) {
        mem.stale[t.id] = { progress, count: (fresh ? 0 : episode.count) + 1, at: now };
        wakes.push({ kind: 'stale', key: `task:${t.id}`, reason: `stale: ${t.id} (paused ${Math.round(idle)}s, waiting on ${wait.what}; rechecked on the long cadence, not a wedge - confirm the wait still holds)` });
      }
      continue;
    }
    const limit = ep.busy === 'busy' ? tun.busyMax : ep.busy === 'idle' ? tun.staleIdle : tun.staleUnknown;
    if (idle < limit) {
      if (fresh) delete mem.stale[t.id];
      continue;
    }
    if (!fresh && (now - episode.at) / 1000 < tun.staleEscalate) continue;
    const count = fresh ? 1 : episode.count + 1;
    mem.stale[t.id] = { progress, count, at: now };
    const what = wait ? `its declared wait (${wait.what}) passed its time` : ep.busy === 'busy' ? 'busy with no progress, possible wedge' : `agent ${ep.busy === 'idle' ? 'idle' : 'state unknown'} without reporting`;
    const deep = count >= 3 ? ', demand-deep-inspection: same crew member escalated 3 times in a row - look at its tab, do not re-absorb on its state alone' : '';
    wakes.push({ kind: 'stale', key: `task:${t.id}`, reason: `stale: ${t.id} (stopped responding: no progress for ${Math.round(idle)}s, ${what}, escalation ${count}${deep})` });
  }
  for (const id of Object.keys(mem.surfaced)) if (!tasks.some((t) => t.id === id)) delete mem.surfaced[id];
  for (const id of Object.keys(mem.gone)) if (!tasks.some((t) => t.id === id)) delete mem.gone[id];

  // Checks: each runs on its own interval; whatever it prints wakes amigo.
  for (const c of listChecks(env)) {
    const every = c.every ?? tun.checkInterval;
    if ((now - (mem.checks[c.name] ?? 0)) / 1000 < every) continue;
    mem.checks[c.name] = now;
    const reason = runRegisteredCheck(c, tun.checkTimeout);
    if (reason) wakes.push({ kind: 'check', key: `check:${c.name}`, reason });
  }
  for (const name of Object.keys(mem.checks)) if (!listChecks(env).some((c) => c.name === name)) delete mem.checks[name];

  // PRs: a build's recorded, unmerged PR is read live on its own cadence (merge.ts prWatch). A change to merged (recorded and
  // cleaned up there), closed, CI red, or green and mergeable wakes amigo once per state and head; CI still running is absorbed.
  for (const t of tasks) {
    if (!t.pr || t.merge || t.status === 'closed' || t.status === 'closing') {
      delete mem.prs[t.id];
      continue;
    }
    const seen = mem.prs[t.id];
    if (seen && (now - seen.at) / 1000 < tun.prPoll) continue;
    let read: { sig: string; line: string };
    try {
      read = prWatch(t.id, env);
    } catch (err) {
      // An unreadable PR (network, gh auth) is reported once per distinct error, then absorbed until it changes.
      read = { sig: `error:${(err as Error).message}`, line: `could not read ${t.pr}: ${(err as Error).message}` };
    }
    mem.prs[t.id] = { sig: read.sig, at: now };
    if (read.sig !== seen?.sig && !read.sig.startsWith('pending')) wakes.push({ kind: 'check', key: `pr:${t.id}`, reason: `check: ${t.id} PR ${read.line}` });
  }
  for (const id of Object.keys(mem.prs)) if (!tasks.some((t) => t.id === id)) delete mem.prs[id];

  // Heartbeat: a backstop for results that were surfaced but stay unread, backing off while nothing changes.
  const unread = tasks.filter((t) => FINISHED.includes(t.status) && !t.seen).map((t) => t.id).sort().join(',');
  if (!unread) {
    mem.heartbeat = { at: now, interval: 0, unread: '' };
  } else if (!wakes.length) {
    const hb = mem.heartbeat;
    const interval = hb.unread === unread && hb.interval ? hb.interval : tun.heartbeat;
    if (!hb.at || hb.unread !== unread) mem.heartbeat = { at: now, interval, unread };
    else if ((now - hb.at) / 1000 >= interval) {
      mem.heartbeat = { at: now, interval: Math.min(interval * 2, tun.heartbeatMax), unread };
      wakes.push({ kind: 'heartbeat', key: 'heartbeat', reason: `heartbeat: ${unread.split(',').length} result(s) still unread (${unread}) - run amigo inbox` });
    }
  }

  // Queue first, then memory: a watcher killed between the two re-surfaces a wake, and never loses one.
  for (const w of wakes) appendWake(w.kind, w.key, w.reason, env);
  writeJsonAtomic(memoryPath(env), mem);
  return wakes;
}

// ---------- the watcher process ----------

const readWatchLock = (env: NodeJS.ProcessEnv): WatchLock | null => {
  try {
    const l = JSON.parse(readFileSync(watchLockPath(env), 'utf8')) as WatchLock;
    return Number.isInteger(l.pid) && typeof l.token === 'string' ? l : null;
  } catch {
    return null;
  }
};

const beaconAge = (env: NodeJS.ProcessEnv, now = Date.now()): number => {
  const m = mtime(beaconPath(env));
  return m ? (now - m) / 1000 : Infinity;
};

/** A live watcher holds the lock and its beacon is fresh: the PID-strict fm_watcher_healthy. */
export function watcherHealthy(env: NodeJS.ProcessEnv): boolean {
  const l = readWatchLock(env);
  return Boolean(l) && pidAlive(l!.pid) && beaconAge(env) < watcherGrace(env);
}

export type CycleResult = { kind: 'reason'; text: string; attached: boolean } | { kind: 'failed'; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The holder still runs and is the process that took the lock (a reused pid is not). */
const holderRuns = (l: WatchLock): boolean => {
  if (!pidAlive(l.pid)) return false;
  if (!l.started) return true;
  const now = processStarted(l.pid);
  return now === null || now === l.started;
};

/**
 * Take the watcher lock. A holder that runs with a fresh beacon is kept (the caller attaches). One whose beacon (or, before
 * its first poll, whose start) is older than three graces is not polling: it is stopped, after its identity is re-verified,
 * and replaced. A dead holder's lock is simply taken.
 */
function claimLock(env: NodeJS.ProcessEnv, token: string): { claimed: true } | { claimed: false; holder: WatchLock } {
  const started = processStarted(process.pid);
  return withLock(lockPath('watch-claim', env), () => {
    const cur = readWatchLock(env);
    if (cur && cur.pid !== process.pid && holderRuns(cur)) {
      const quiet = existsSync(beaconPath(env)) ? beaconAge(env) : (Date.now() - (Date.parse(cur.startedAt) || 0)) / 1000;
      if (quiet < watcherGrace(env) * 3) return { claimed: false as const, holder: cur };
      try {
        process.kill(cur.pid);
      } catch {
        // already gone
      }
    }
    // The predecessor's beacon must not vouch for this watcher: health needs this watcher's own first poll.
    rmSync(beaconPath(env), { force: true });
    writeJsonAtomic(watchLockPath(env), { pid: process.pid, token, started, startedAt: new Date().toISOString() } satisfies WatchLock);
    return { claimed: true as const };
  });
}

function releaseLock(env: NodeJS.ProcessEnv, token: string): void {
  try {
    withLock(lockPath('watch-claim', env), () => {
      if (readWatchLock(env)?.token === token) rmSync(watchLockPath(env), { force: true });
    });
  } catch {
    // a lock left behind by a dead pid is taken over by the next watcher
  }
}

/** Follow a live watcher until it closes, then report what it closed with (its delivery record), or fail. */
async function attach(env: NodeJS.ProcessEnv, holder: WatchLock, pollMs: number, deadline: number): Promise<CycleResult> {
  let cur = holder;
  for (;;) {
    while (pidAlive(cur.pid) && readWatchLock(env)?.token === cur.token) {
      if (Date.now() > deadline) return { kind: 'failed', text: `watcher: FAILED - attached to pid ${cur.pid} past the cycle limit` };
      await sleep(pollMs);
    }
    const d = findDelivery(cur.token, env);
    if (d) return { kind: 'reason', text: d.reason, attached: true };
    const next = readWatchLock(env);
    if (next && next.token !== cur.token && pidAlive(next.pid)) {
      cur = next; // a verified successor took over: follow it
      continue;
    }
    return { kind: 'failed', text: `watcher: FAILED - the watcher it attached to (pid ${cur.pid}) ended without an actionable reason` };
  }
}

/**
 * One watcher cycle: claim the lock (or attach to the live watcher), announce queued wakes nobody was shown, then poll until
 * something actionable happens. Every actionable reason is queued durably, recorded in the delivery ledger, and returned.
 */
export async function watchCycle(env: NodeJS.ProcessEnv, opts: { signal?: AbortSignal } = {}): Promise<CycleResult> {
  const tun = tunables(env);
  const pollMs = Math.max(50, tun.poll * 1000);
  const deadline = Date.now() + tun.maxCycle * 1000;
  mkdirSync(stateDir(env), { recursive: true });
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const claim = claimLock(env, token);
  if (!claim.claimed) return attach(env, claim.holder, Math.min(pollMs, 1000), deadline);
  const release = () => releaseLock(env, token);
  process.once('exit', release);
  try {
    const deliver = (text: string): CycleResult => {
      recordDelivery({ pid: process.pid, token, reason: text, at: new Date().toISOString() }, env);
      markAnnounced(env);
      return { kind: 'reason', text, attached: false };
    };
    const recovery = takeRecovery(env);
    if (recovery) {
      recordDelivery({ pid: process.pid, token, reason: recovery, at: new Date().toISOString() }, env);
      return { kind: 'reason', text: recovery, attached: false };
    }
    const homeDir = home(env);
    for (;;) {
      if (opts.signal?.aborted) return { kind: 'failed', text: 'watcher: FAILED - stopped' };
      // A watcher whose home or state folder is gone (a deleted temporary home) stops instead of running on as an orphan.
      if (!existsSync(homeDir) || !existsSync(stateDir(env))) return { kind: 'failed', text: `watcher: exiting - ${homeDir} no longer exists` };
      if (readWatchLock(env)?.token !== token) return { kind: 'failed', text: 'watcher: FAILED - another watcher took the lock over' };
      writeFileSync(beaconPath(env), String(Date.now()));
      let wakes = scan(env);
      if (wakes.length && wakes.every((w) => w.kind === 'signal') && tun.signalGrace > 0) {
        // Linger so crew members finishing together coalesce into one wake.
        await sleep(tun.signalGrace * 1000);
        writeFileSync(beaconPath(env), String(Date.now()));
        wakes = [...wakes, ...scan(env)];
      }
      // scan() already queued them durably.
      if (wakes.length) {
        return deliver(wakes.map((w) => w.reason).join('\n'));
      }
      if (Date.now() > deadline) {
        appendWake('heartbeat', 'heartbeat', `heartbeat: the watcher ran ${Math.round(tun.maxCycle / 3600)}h with nothing actionable; it re-arms at the next turn end`, env);
        return deliver(`heartbeat: the watcher ran ${Math.round(tun.maxCycle / 3600)}h with nothing actionable; it re-arms at the next turn end`);
      }
      await sleep(pollMs);
    }
  } catch (err) {
    return { kind: 'failed', text: `watcher: FAILED - ${(err as Error).message}` };
  } finally {
    process.removeListener('exit', release);
    release();
  }
}
