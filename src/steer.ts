import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, processStartMs, withLock } from './fsx.ts';
import { cliPath, home, lockPath, taskDir } from './paths.ts';
import { run, type RunOptions, type RunResult } from './proc.ts';
import { appendStatus, formatStatusLine } from './status.ts';
import { logFile, requireTask, type Task } from './tasks.ts';
import { HC_ROUTING_ENV, HERDR_TIMEOUT_MS, terminalBackend, type BackendName, type Runner } from './terminal.ts';

/**
 * The steering inbox: the payload moves to the filesystem, which is reliable, and the
 * crew member's terminal gets only a short constant doorbell line. A duplicated doorbell is harmless (the inbox is empty or
 * already handled), and a swallowed one is seen by the missing acknowledgement and rung again.
 *
 *   state/tasks/<id>/inbox/NNN.msg    one durable message, numbered, written by atomic rename
 *   state/tasks/<id>/inbox/handled/   the crew member's move into here IS the acknowledgement
 *
 * Record format:
 *   schema=amigo-task-inbox.v1
 *   at=<UTC timestamp>
 *   body-terminator=1     the writer added exactly one final newline that is not part of the message
 *   --
 *   <the exact message text>
 *
 * Numbers are never reused within a task: allocation counts both the inbox and handled/.
 */
export const INBOX_SCHEMA = 'amigo-task-inbox.v1';

export const inboxDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'inbox');
const handledDir = (id: string, env: NodeJS.ProcessEnv): string => join(inboxDir(id, env), 'handled');
const MSG_RE = /^(\d+)\.msg$/;

/** The constant line typed into the crew member's terminal. It describes itself, so a crew member that forgot its brief still knows what to do. */
export function doorbell(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = inboxDir(id, env).replaceAll('\\', '/');
  return `amigo: an instruction is waiting in ${dir} - read every *.msg file there in numeric order, act on each, then move each one into ${dir}/handled/ to acknowledge it.`;
}

/** The next free message number: one more than the highest used in the inbox or handled/. */
function nextSeq(id: string, env: NodeJS.ProcessEnv): number {
  const used = [inboxDir(id, env), handledDir(id, env)].flatMap((d) => {
    try {
      return readdirSync(d).map((f) => Number(MSG_RE.exec(f)?.[1] ?? 0));
    } catch {
      return [];
    }
  });
  return Math.max(0, ...used) + 1;
}

/** Write one message as a durable record. Returns its file. Throws on an empty message. */
export function writeInbox(id: string, message: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!message.trim()) throw new Error('The message is empty');
  const dir = inboxDir(id, env);
  mkdirSync(handledDir(id, env), { recursive: true });
  return withLock(lockPath(`inbox-${id}`, env), () => {
    const name = `${String(nextSeq(id, env)).padStart(3, '0')}.msg`;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, `schema=${INBOX_SCHEMA}\nat=${new Date().toISOString()}\nbody-terminator=1\n--\n${message}\n`);
    renameSync(tmp, join(dir, name));
    return join(dir, name);
  });
}

/** The message text of a record: everything after the `--` line, less the one terminator newline the writer added. */
export function inboxBody(raw: string): string {
  const at = raw.indexOf('\n--\n');
  if (at < 0) return raw;
  const head = raw.slice(0, at);
  const body = raw.slice(at + 4);
  return /^body-terminator=1$/m.test(head) && body.endsWith('\n') ? body.slice(0, -1) : body;
}

export interface InboxMessage {
  name: string;
  file: string;
  body: string;
}

/** Messages the crew member has not acknowledged yet, oldest first. */
export function pendingMessages(id: string, env: NodeJS.ProcessEnv = process.env): InboxMessage[] {
  const dir = inboxDir(id, env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => MSG_RE.test(f));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => Number(MSG_RE.exec(a)?.[1]) - Number(MSG_RE.exec(b)?.[1]))
    .map((name) => {
      const file = join(dir, name);
      return { name, file, body: inboxBody(readFileSync(file, 'utf8')) };
    });
}

/** Acknowledge a message the way a crew member does: move it into handled/. */
export function acknowledge(id: string, name: string, env: NodeJS.ProcessEnv = process.env): void {
  const from = join(inboxDir(id, env), name);
  if (!existsSync(from)) throw new Error(`No message ${name} waiting for ${id}`);
  mkdirSync(handledDir(id, env), { recursive: true });
  renameSync(from, join(handledDir(id, env), name));
}

/** How long a queued ring waits for a crew member's agent to be ready before it gives up (the message stays in the inbox). */
export const RING_WAIT_MS = 60_000;
/**
 * How long after a crew member (re)starts a terminal without agent status still counts as starting. After it, no status means an
 * agent herdr-app does not recognise, which is rung directly. Shorter than RING_WAIT_MS, so a queued ring always gets past it.
 */
export const RING_START_WINDOW_MS = 45_000;
const RING_POLL_MS = 1_000;
/**
 * The queued ring's own `hc send` may wait for a person's unsent draft in the crew member's tab (hc waits up to 60s since their
 * last key): it runs in the background, so it gets that long. Every other hc call keeps the usual short timeout.
 */
export const RING_SEND_TIMEOUT_MS = 70_000;

/** The runner of the queued ring: RING_SEND_TIMEOUT_MS for `hc send`, the usual HERDR_TIMEOUT_MS for every other call. */
export const patientRunner =
  (exec: (cmd: string, args: string[], opts: RunOptions) => RunResult = run): Runner =>
  (cmd, args) =>
    exec(cmd, args, { timeoutMs: cmd === 'hc' && args[0] === 'send' ? RING_SEND_TIMEOUT_MS : HERDR_TIMEOUT_MS, unset: HC_ROUTING_ENV });

/**
 * rung: the doorbell went in. later: the agent is not ready yet (still starting, or it came up a moment ago); a ring later
 * reaches it. dialog: its agent waits on a dialog, which hc does not type into. no: final (no terminal, a failed send).
 */
export type RingResult = { outcome: 'rung' } | { outcome: 'later' | 'dialog' | 'no'; why: string; backend?: BackendName };

/**
 * Ring the doorbell: type the constant line into the crew member's terminal when its agent is ready. Best effort: the record is
 * the delivery. A crew member still starting is not typed into (the line could be lost, and hc send hangs on the starting
 * screen): that is `later`. A terminal that still reports no agent RING_START_WINDOW_MS after the crew member started runs an
 * agent herdr-app does not recognise, and is rung directly.
 */
export function ring(t: Task, env: NodeJS.ProcessEnv, runner?: Runner, now: () => number = Date.now): RingResult {
  if (!t.endpoint) return { outcome: 'no', why: 'it has no terminal' };
  try {
    const backend = terminalBackend(env, runner ? { runner } : {});
    const state = backend.state(t.endpoint);
    if (state.liveness !== 'live') return { outcome: 'no', why: `its terminal is ${state.liveness}` };
    if (state.input === 'dialog') return { outcome: 'dialog', why: 'its agent waits on a dialog in its tab (a permission or a question), and hc does not type into a dialog' };
    if (state.input === 'settling') return { outcome: 'later', why: `${t.id}'s agent came up only a moment ago`, backend: backend.name };
    const started = Date.parse(t.startedAt ?? '');
    if (state.input === 'no-status' && Number.isFinite(started) && now() - started < RING_START_WINDOW_MS) {
      return { outcome: 'later', why: `${t.id}'s terminal is still starting: no agent is up in it yet`, backend: backend.name };
    }
    backend.send(t.endpoint, doorbell(t.id, env));
    return { outcome: 'rung' };
  } catch (err) {
    return { outcome: 'no', why: (err as Error).message };
  }
}

const ringMarker = (id: string, env: NodeJS.ProcessEnv): string => join(taskDir(id, env), 'ring.pending');
/** A marker whose worker pid is not written yet (`0 <token>`) is past its spawn after this long. */
const MARKER_SPAWN_MS = 30_000;

/**
 * Whether the ring marker `held` (`<worker pid> <token>`, written at mtime) no longer stands for a waiting worker: its worker is
 * gone, its pid now belongs to a process started after the marker (a reused pid), or the spawn never wrote a pid.
 */
function markerStale(held: string, mtime: number): boolean {
  const pid = Number(held.split(' ')[0]);
  if (!(Number.isInteger(pid) && pid > 0)) return Date.now() - mtime > MARKER_SPAWN_MS;
  if (!pidAlive(pid)) return true;
  // A live pid older than a worker can live may have been reused: check its start time (slow on Windows, so only then).
  if (Date.now() - mtime <= RING_WAIT_MS + RING_SEND_TIMEOUT_MS + MARKER_SPAWN_MS) return false;
  const since = processStartMs(pid);
  return since !== null && since > mtime + 2_000;
}

/** Take the ring marker with `content`: false while another worker holds it. A stale marker is taken over by an atomic move. */
function claimMarker(marker: string, content: string): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(marker, content, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let held: string;
    let mtime: number;
    try {
      held = readFileSync(marker, 'utf8');
      mtime = statSync(marker).mtimeMs;
    } catch {
      continue; // it went away meanwhile: try again
    }
    if (!markerStale(held, mtime)) return false;
    // Only one taker wins the move; it puts back a marker that changed after it was judged.
    const aside = `${marker}.${randomBytes(4).toString('hex')}.stale`;
    try {
      renameSync(marker, aside);
    } catch {
      continue;
    }
    const moved = readFileSync(aside, 'utf8');
    rmSync(aside, { force: true });
    if (moved !== held) {
      try {
        writeFileSync(marker, moved, { flag: 'wx' });
      } catch {
        // a newer one is there already
      }
      return false;
    }
  }
  return false;
}

/** Remove the ring marker only while it still holds this token. */
function releaseMarker(marker: string, token: string): void {
  try {
    if (readFileSync(marker, 'utf8').split(' ')[1] === token) rmSync(marker, { force: true });
  } catch {
    // already gone
  }
}

/** Starts `amigo <args>` detached and returns its pid. */
export type WorkerSpawner = (args: string[], env: NodeJS.ProcessEnv) => number | undefined;
const spawnDetached: WorkerSpawner = (args, env) => {
  const child = spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on('error', () => {});
  child.unref();
  return child.pid;
};

/**
 * Queue a ring for a crew member that is not ready yet: a detached `amigo _ring <id> --token <t>` waits for its agent
 * (ringWhenReady). One at a time per crew member, held by the marker `ring.pending` (`<worker pid> <token>`): the doorbell is
 * constant, so one ring covers every message waiting by then. False when one is already waiting.
 */
export function startRingWorker(id: string, env: NodeJS.ProcessEnv, backend: BackendName, spawnWorker: WorkerSpawner = spawnDetached): boolean {
  const marker = ringMarker(id, env);
  const token = randomBytes(6).toString('hex');
  if (!claimMarker(marker, `0 ${token}`)) return false;
  try {
    const pid = spawnWorker(['_ring', id, '--token', token], { ...env, AMIGO_HOME: home(env), AMIGO_TERMINAL: backend });
    if (!pid) throw new Error('the ring worker did not start');
    // The worker may be done already and have removed the marker: write its pid only into our own marker.
    if (readFileSync(marker, 'utf8') === `0 ${token}`) writeFileSync(marker, `${pid} ${token}`);
    return true;
  } catch (err) {
    releaseMarker(marker, token);
    throw err;
  }
}

/**
 * `amigo _ring <id>`: wait (up to RING_WAIT_MS) until the crew member's agent is ready, then ring once. It stops early when the
 * inbox has nothing waiting or the task closed. The outcome goes to the crew member's output.log and is returned. With the token
 * of the marker that started it, it removes that marker at the end.
 */
export async function ringWhenReady(
  id: string,
  env: NodeJS.ProcessEnv,
  opts: { token?: string; runner?: Runner; waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const waitMs = opts.waitMs ?? RING_WAIT_MS;
  const deadline = now() + waitMs;
  const runner = opts.runner ?? (env.AMIGO_TERMINAL === 'test' ? undefined : patientRunner());
  let outcome: string;
  try {
    for (;;) {
      const t = requireTask(id, env);
      if (t.status === 'closed' || t.status === 'closing') {
        outcome = `did not ring: the task is ${t.status}`;
        break;
      }
      if (!pendingMessages(id, env).length) {
        outcome = 'did not ring: nothing waits in the inbox now';
        break;
      }
      const r = ring(t, env, runner, now);
      if (r.outcome === 'rung') {
        outcome = 'rang the terminal once its agent was ready';
        break;
      }
      if (r.outcome === 'no' || r.outcome === 'dialog') {
        outcome = `did not ring (${r.why})`;
        break;
      }
      if (now() >= deadline) {
        outcome = `did not ring: its agent was still not ready after ${Math.round(waitMs / 1000)}s (${r.why})`;
        break;
      }
      await sleep(opts.pollMs ?? RING_POLL_MS);
    }
  } catch (err) {
    outcome = `did not ring (${(err as Error).message})`;
  } finally {
    if (opts.token) releaseMarker(ringMarker(id, env), opts.token);
  }
  const line = `amigo: queued doorbell for the inbox: ${outcome}`;
  try {
    appendFileSync(logFile(id, env), `${line}\n`);
  } catch {
    // the log is a convenience
  }
  return line;
}

/**
 * `amigo send`: write the message durably, close the named open decisions (a `resolved` status line per key, written at
 * answer time), then ring. The record decides success; a failed ring only says so. A crew member that is not ready yet is
 * rung by a background worker once it is.
 */
export function sendMessage(
  id: string,
  message: string,
  opts: { resolveKeys?: string[]; ringLater?: (id: string, env: NodeJS.ProcessEnv, backend: BackendName) => boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  runner?: Runner,
): string[] {
  const t = requireTask(id, env);
  if (t.status === 'closed' || t.status === 'closing') throw new Error(`Task ${id} is ${t.status}: there is nobody to steer`);
  const file = writeInbox(id, message, env);
  const out = [`Recorded for ${id}: ${file}`];
  for (const key of opts.resolveKeys ?? []) {
    appendStatus(id, formatStatusLine('resolved', `answered by amigo: ${message.split(/\r?\n/)[0]!.slice(0, 120)}`, { key }), env);
    out.push(`Closed the open item [${key}].`);
  }
  const r = ring(t, env, runner);
  if (r.outcome === 'rung') out.push(`Rang ${id}'s terminal; it acknowledges by moving the message into handled/.`);
  else if (r.outcome === 'later') {
    let queued: boolean | Error;
    try {
      queued = (opts.ringLater ?? startRingWorker)(id, env, r.backend ?? 'herdr-app');
    } catch (err) {
      queued = err as Error;
    }
    if (queued instanceof Error) out.push(`Did not ring: ${r.why}, and a ring for later could not be queued: ${queued.message}. The message waits in the inbox; send again once the crew member is up.`);
    else out.push(`Not rung yet: ${r.why}. ${queued ? 'amigo rings it' : 'A ring already queued rings it'} once its agent is ready (waiting up to ${RING_WAIT_MS / 1000}s; the outcome goes to its output.log). The message waits in the inbox meanwhile.`);
  } else if (r.outcome === 'dialog') out.push(`Did not ring: ${r.why}. The message waits in the inbox; answer the dialog in ${id}'s tab, and its next doorbell (the next amigo send to it) covers this message too.`);
  else out.push(`Did not ring (${r.why}). The message waits in the inbox; if the crew member is not running, relaunch it: amigo control ${id} relaunch --note "check your inbox"`);
  return out;
}
