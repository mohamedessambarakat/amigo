import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './fsx.ts';
import { lockPath, taskDir } from './paths.ts';
import { appendStatus, formatStatusLine } from './status.ts';
import { requireTask, type Task } from './tasks.ts';
import { terminalBackend, type Runner } from './terminal.ts';

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

/**
 * Ring the doorbell: type the constant line into the crew member's terminal when it is live. Best effort: the record is the
 * delivery. Returns what happened.
 */
export function ring(t: Task, env: NodeJS.ProcessEnv, runner?: Runner): { rung: boolean; why?: string } {
  if (!t.endpoint) return { rung: false, why: 'it has no terminal' };
  try {
    const backend = terminalBackend(env, runner ? { runner } : {});
    const state = backend.state(t.endpoint);
    if (state.liveness !== 'live') return { rung: false, why: `its terminal is ${state.liveness}` };
    backend.send(t.endpoint, doorbell(t.id, env));
    return { rung: true };
  } catch (err) {
    return { rung: false, why: (err as Error).message };
  }
}

/**
 * `amigo send`: write the message durably, close the named open decisions (a `resolved` status line per key, written at
 * answer time), then ring. The record decides success; a failed ring only says so.
 */
export function sendMessage(id: string, message: string, opts: { resolveKeys?: string[] } = {}, env: NodeJS.ProcessEnv = process.env, runner?: Runner): string[] {
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
  else out.push(`Did not ring (${r.why}). The message waits in the inbox; if the crew member is not running, relaunch it: amigo control ${id} relaunch --note "check your inbox"`);
  return out;
}
