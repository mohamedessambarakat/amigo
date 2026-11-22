import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './fsx.ts';
import { cliPath, home, lockPath, taskDir } from './paths.ts';
import { run } from './proc.ts';
import { appendStatus, formatStatusLine } from './status.ts';
import { logFile, requireTask, type Task } from './tasks.ts';
import { HC_ROUTING_ENV, HERDR_TIMEOUT_MS, terminalBackend, type Runner } from './terminal.ts';

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

/** How long a queued ring waits for a starting crew member's agent to come up before it gives up (the message stays in the inbox). */
export const RING_WAIT_MS = 60_000;
const RING_POLL_MS = 1_000;
/**
 * The queued ring's own `hc send` may wait for a person's unsent draft in the crew member's tab (hc waits up to 60s since their
 * last key): it runs in the background, so it gets that long. Every other hc call keeps the usual short timeout.
 */
const RING_SEND_TIMEOUT_MS = 70_000;
const patientRunner: Runner = (cmd, args) => run(cmd, args, { timeoutMs: cmd === 'hc' && args[0] === 'send' ? RING_SEND_TIMEOUT_MS : HERDR_TIMEOUT_MS, unset: HC_ROUTING_ENV });

export type RingResult = { rung: true } | { rung: false; why: string; starting?: boolean };

/**
 * Ring the doorbell: type the constant line into the crew member's terminal when its agent is up. Best effort: the record is the
 * delivery. A crew member that is still starting (relaunched a moment ago) is not typed into: the line could be lost or left
 * unsent, and hc send hangs on the starting screen. Then `starting` is set, for a ring later.
 */
export function ring(t: Task, env: NodeJS.ProcessEnv, runner?: Runner): RingResult {
  if (!t.endpoint) return { rung: false, why: 'it has no terminal' };
  try {
    const backend = terminalBackend(env, runner ? { runner } : {});
    const state = backend.state(t.endpoint);
    if (state.liveness !== 'live') return { rung: false, why: `its terminal is ${state.liveness}` };
    if (!state.takesInput) return { rung: false, why: 'its terminal is still starting: no agent is up in it yet', starting: true };
    backend.send(t.endpoint, doorbell(t.id, env));
    return { rung: true };
  } catch (err) {
    return { rung: false, why: (err as Error).message };
  }
}

const ringMarker = (id: string, env: NodeJS.ProcessEnv): string => join(taskDir(id, env), 'ring.pending');

/**
 * Queue a ring for a crew member that is still starting: a detached `amigo _ring <id>` waits for its agent (ringWhenReady). One
 * at a time per crew member: the doorbell is constant, so one ring covers every message waiting by then. False when one is
 * already waiting.
 */
export function startRingWorker(id: string, env: NodeJS.ProcessEnv): boolean {
  const marker = ringMarker(id, env);
  try {
    writeFileSync(marker, String(Date.now()), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A worker that died without removing its marker leaves an old one: past the longest wait, it no longer counts.
    if (Date.now() - statSync(marker).mtimeMs < RING_WAIT_MS + RING_SEND_TIMEOUT_MS) return false;
    writeFileSync(marker, String(Date.now()));
  }
  const backend = terminalBackend(env).name;
  const child = spawn(process.execPath, [cliPath, '_ring', id], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, AMIGO_HOME: home(env), AMIGO_TERMINAL: backend } });
  child.on('error', () => rmSync(marker, { force: true }));
  child.unref();
  return true;
}

/**
 * `amigo _ring <id>`: wait (up to RING_WAIT_MS) until the crew member's agent takes input, then ring once. It stops early when
 * the inbox has nothing waiting or the task closed. The outcome goes to the crew member's output.log and is returned.
 */
export async function ringWhenReady(
  id: string,
  env: NodeJS.ProcessEnv,
  opts: { runner?: Runner; waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const waitMs = opts.waitMs ?? RING_WAIT_MS;
  const deadline = now() + waitMs;
  const runner = opts.runner ?? (env.AMIGO_TERMINAL === 'test' ? undefined : patientRunner);
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
      const r = ring(t, env, runner);
      if (r.rung) {
        outcome = 'rang the terminal once its agent was up';
        break;
      }
      // Only a crew member still starting is waited for; every other answer is final.
      if (!r.starting) {
        outcome = `did not ring (${r.why})`;
        break;
      }
      if (now() >= deadline) {
        outcome = `did not ring: no agent was up in its terminal after ${Math.round(waitMs / 1000)}s`;
        break;
      }
      await sleep(opts.pollMs ?? RING_POLL_MS);
    }
  } catch (err) {
    outcome = `did not ring (${(err as Error).message})`;
  } finally {
    rmSync(ringMarker(id, env), { force: true });
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
 * answer time), then ring. The record decides success; a failed ring only says so. A crew member that is still starting is
 * rung by a background worker once its agent is up.
 */
export function sendMessage(
  id: string,
  message: string,
  opts: { resolveKeys?: string[]; ringLater?: (id: string, env: NodeJS.ProcessEnv) => boolean } = {},
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
  if (r.rung) out.push(`Rang ${id}'s terminal; it acknowledges by moving the message into handled/.`);
  else if (r.starting) {
    let queued: boolean | Error;
    try {
      queued = (opts.ringLater ?? startRingWorker)(id, env);
    } catch (err) {
      queued = err as Error;
    }
    if (queued instanceof Error) out.push(`Did not ring (${r.why}), and could not queue a ring for later: ${queued.message}. The message waits in the inbox; send again once the crew member is up.`);
    else out.push(`Not rung yet: ${id}'s terminal is still starting. ${queued ? 'amigo rings it' : 'A ring already queued rings it'} once its agent is up (waiting up to ${RING_WAIT_MS / 1000}s; the outcome goes to its output.log). The message waits in the inbox meanwhile.`);
  } else out.push(`Did not ring (${r.why}). The message waits in the inbox; if the crew member is not running, relaunch it: amigo control ${id} relaunch --note "check your inbox"`);
  return out;
}
