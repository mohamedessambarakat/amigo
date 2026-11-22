import { join } from 'node:path';
import { pidAlive, readJson, withLock, writeJsonAtomic } from './fsx.ts';
import { cliPath, lockPath, stateDir } from './paths.ts';
import { acquireSessionLock, identity, lockState, type Identity } from './session.ts';
import { appendWake } from './wakes.ts';
import { supervisionNeed, watchCycle, watcherGrace, watcherHealthy } from './watch.ts';

/**
 * amigo's own Claude Code hooks (ported from fm-claude-stop-autoarm.sh and fm-turnend-guard.sh --claude):
 *
 *   SessionStart   the session-start digest, once per session (digest.ts)
 *   Stop           two hooks that run side by side:
 *                    guard  synchronous: no turn ends blind while work is open and no watcher is armed
 *                    stop   asyncRewake: runs the watcher in the background; an actionable close exits 2, which wakes
 *                           the idle session with the reason ("Stop hook feedback")
 *   StopFailure    stop again, so a turn that ended on an API error still re-arms (paced, so a dead API cannot loop)
 *
 * Only the session that holds the session lock arms; a crew member's session never runs these (it has its own hooks).
 */
export function amigoHooks(): Record<string, unknown> {
  const hook = (name: string, timeout: number, extra: Record<string, unknown> = {}) => ({ type: 'command', command: `node "${cliPath.replace(/\\/g, '/')}" _amigo-hook ${name}`, timeout, ...extra });
  return {
    SessionStart: [{ hooks: [hook('session-start', 180)] }],
    Stop: [{ hooks: [hook('guard', 60), hook('stop', 28_800, { asyncRewake: true })] }],
    StopFailure: [{ hooks: [hook('stop-failure', 28_800, { asyncRewake: true })] }],
  };
}

export interface HookResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface HookPayload {
  session_id?: string;
  source?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

// ---------- the auto-arm generation claim ----------

/**
 * state/autoarm.json: the newest auto-arm generation. Claude does not dedupe async hooks, so exactly one firing arms per turn
 * end: a firing defers to an open claim (arming, its process alive, same session, not stuck) and otherwise takes the next
 * generation. Nothing is held across the arm; a superseded owner goes silent.
 */
interface Claim {
  gen: number;
  pid: number;
  session: string | null;
  outcome: 'arming' | 'delivered' | 'failed' | 'idle' | 'stood-down';
  at: string;
}

const claimPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'autoarm.json');
const readClaim = (env: NodeJS.ProcessEnv): Claim | null => readJson<Claim | null>(claimPath(env), null);

/** A claim that still owns recovery: arming, alive, and not stuck (its record and the beacon both older than the grace). */
export function claimOpen(c: Claim | null, env: NodeJS.ProcessEnv, session?: string | null): boolean {
  if (!c || c.outcome !== 'arming' || !pidAlive(c.pid)) return false;
  if (session && c.session && c.session !== session) return false;
  const old = (Date.now() - Date.parse(c.at)) / 1000 > watcherGrace(env);
  return !(old && !watcherHealthy(env));
}

function takeClaim(env: NodeJS.ProcessEnv, me: Identity): Claim | null {
  return withLock(lockPath('autoarm', env), () => {
    const cur = readClaim(env);
    if (claimOpen(cur, env, me.session)) return null;
    const c: Claim = { gen: (cur?.gen ?? 0) + 1, pid: process.pid, session: me.session, outcome: 'arming', at: new Date().toISOString() };
    writeJsonAtomic(claimPath(env), c);
    return c;
  });
}

/** Write this generation's outcome, only while it is still the newest: false means a newer firing took over (go silent). */
function settleClaim(env: NodeJS.ProcessEnv, c: Claim, outcome: Claim['outcome']): boolean {
  return withLock(lockPath('autoarm', env), () => {
    if (readClaim(env)?.gen !== c.gen) return false;
    writeJsonAtomic(claimPath(env), { ...c, outcome, at: new Date().toISOString() });
    return true;
  });
}

// ---------- failure episodes ----------

const failurePath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'autoarm-failure.json');
const stopFailurePath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'autoarm-stopfailure.json');

const num = (v: string | undefined, fallback: number): number => (v !== undefined && v.trim() !== '' && Number(v) >= 0 ? Number(v) : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const WAKE_BANNER = 'Run `amigo wake drain` first, handle every wake, then run the WAKE_ACK_REQUIRED command it prints. The next turn end re-arms the watcher by itself: never start it yourself.';

/** Is this session the one that controls the home? A stale lock (its session is gone) is reclaimed here. */
function controls(env: NodeJS.ProcessEnv, me: Identity): boolean {
  const s = lockState(env, me);
  if (s.state === 'owned') return true;
  if (s.state !== 'stale' || me.pid === null) return false;
  const got = acquireSessionLock(env, me);
  return got.result !== 'held' && got.result !== 'no-session';
}

/**
 * The Stop / StopFailure auto-arm. While this session controls the home and something needs supervision, it runs the
 * watcher (or attaches to the live one) inside this hook's process and turns an actionable close into exit 2 with the reason.
 */
export async function autoArm(payload: HookPayload, env: NodeJS.ProcessEnv, event: 'stop' | 'stop-failure'): Promise<HookResult> {
  const me = identity(env, payload.session_id);
  if (env.AMIGO_TASK || !controls(env, me)) return { code: 0 };
  if (!supervisionNeed(env).length) return { code: 0 };
  const claim = takeClaim(env, me);
  if (!claim) return { code: 0 }; // an open claim from another firing of this turn end owns it
  if (event === 'stop-failure') {
    // An API error can end the next turn too: pace the rewakes so a dead API cannot chain error -> rewake -> error.
    const cooldown = num(env.AMIGO_STOPFAILURE_COOLDOWN_SECS, 300) * 1000;
    const last = readJson<{ at: number } | null>(stopFailurePath(env), null)?.at ?? 0;
    const wait = last + cooldown - Date.now();
    if (wait > 0) await sleep(wait);
  }
  const retries = num(env.AMIGO_AUTOARM_RETRIES, 3);
  let failure = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    const res = await watchCycle(env);
    // Ownership is re-verified before anything is said: a session that lost the home, or a superseded claim, goes silent.
    if (!controls(env, me) || readClaim(env)?.gen !== claim.gen) return { code: 0 };
    if (res.kind === 'reason') {
      if (!supervisionNeed(env).length && !res.text.startsWith('check:')) {
        settleClaim(env, claim, 'idle');
        return { code: 0 };
      }
      if (!settleClaim(env, claim, 'delivered')) return { code: 0 };
      writeJsonAtomic(failurePath(env), null);
      if (event === 'stop-failure') writeJsonAtomic(stopFailurePath(env), { at: Date.now() });
      return { code: 2, stderr: `amigo wake${res.attached ? ' (attached watcher)' : ''}:\n${res.text}\n${WAKE_BANNER}\n` };
    }
    failure = res.text;
    if (watcherHealthy(env)) continue; // a live watcher took over: attach to it on the next attempt
  }
  // Exhausted: one notice per failure episode, so a broken watcher cannot loop the session.
  const episode = readJson<{ notified: boolean } | null>(failurePath(env), null);
  if (!settleClaim(env, claim, 'failed')) return { code: 0 };
  if (episode?.notified) return { code: 0 };
  writeJsonAtomic(failurePath(env), { notified: true, at: new Date().toISOString(), failure });
  return {
    code: 2,
    stderr: `amigo watcher auto-arm FAILED: ${failure}\nSupervision is down while work is open. Run amigo wake drain and amigo status yourself, find why the watcher fails (try amigo watch in a shell), and do not turn this notice into a manual re-arm loop.\n`,
  };
}

// ---------- the turn-end guard ----------

const guardPath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'turnend-guard.json');

/**
 * The synchronous Stop guard: a turn may end when nothing needs supervision, a healthy watcher runs, or an auto-arm claim
 * owns recovery. Otherwise it blocks (exit 2) with the recovery instruction, at most AMIGO_GUARD_BLOCKS times in a row; past
 * that it fails open once and queues a wake saying so, so a broken hook can never trap the session.
 */
export async function turnEndGuard(payload: HookPayload, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const me = identity(env, payload.session_id);
  if (env.AMIGO_TASK) return { code: 0 };
  let s = lockState(env, me);
  // A stale lock (this session resumed with a new process, or its old owner is gone) is reclaimed here, as the Stop hook does.
  if (s.state === 'stale' && controls(env, me)) s = lockState(env, me);
  // Another live session controls the home: this one cannot arm, so blocking it would loop. The owner keeps supervision.
  if (s.state === 'foreign') return { code: 0 };
  const reset = () => writeJsonAtomic(guardPath(env), { blocks: 0 });
  if (!supervisionNeed(env).length) {
    reset();
    return { code: 0 };
  }
  const waitMs = num(env.AMIGO_GUARD_SYNC_WAIT_MS, 2000);
  const until = Date.now() + waitMs;
  for (;;) {
    // Re-read each pass: the parallel Stop hook may reclaim a stale lock (a resumed session) and arm while this waits.
    s = lockState(env, me);
    if (s.state === 'foreign') return { code: 0 };
    if (s.state === 'owned' && (watcherHealthy(env) || claimOpen(readClaim(env), env, me.session))) {
      reset();
      return { code: 0 };
    }
    if (Date.now() >= until) break;
    await sleep(100);
  }
  const budget = num(env.AMIGO_GUARD_BLOCKS, 3);
  const g = readJson<{ blocks?: number; alarmed?: boolean } | null>(guardPath(env), null) ?? {};
  const blocks = g.blocks ?? 0;
  if (blocks >= budget) {
    if (!g.alarmed) {
      appendWake('check', 'turnend-guard', `check: the turn-end guard failed open after ${blocks} blocked stops: work is open and no watcher could be armed. Check the Stop hook and run amigo watch to see why.`, env);
      writeJsonAtomic(guardPath(env), { blocks, alarmed: true });
    }
    return { code: 0 };
  }
  writeJsonAtomic(guardPath(env), { blocks: blocks + 1 });
  const why =
    s.state === 'owned'
      ? 'no watcher is armed and no auto-arm claim owns recovery'
      : 'this session holds no session lock, so the Stop hook cannot arm the watcher; run `amigo digest` to take it';
  return {
    code: 2,
    stderr: `amigo: do not end the turn blind. Crew work is open (${supervisionNeed(env).join(', ')}) but ${why}. Run \`amigo wake drain\` and handle what it shows, then end the turn again: the Stop hook re-arms the watcher.\n`,
  };
}
