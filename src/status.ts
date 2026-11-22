import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskDir } from './paths.ts';

/**
 * The worker status protocol. A crew member reports by appending one line to its status file
 * (state/tasks/<id>/status), never by editing it:
 *
 *   <state> [at=<epoch>] [key=<slug>]: <one short line>
 *
 * working         a material phase change; nonterminal, the crew member keeps going
 * needs-decision  a decision belongs above the crew member; it stops until amigo answers
 * blocked         it is stuck and amigo must act
 * paused          a declared wait expected to clear on its own (its own pipeline run, CI, a long command); `until <UTC time>`
 *                 names when to recheck
 * done            the Definition of done gate it reached (a build's ready line names its PR or branch)
 * failed          it cannot finish
 * resolved        closes an open needs-decision or blocked with the same key (or the keyless one)
 * note            extra facts for amigo (a no-mistakes run's pipeline changes); never a state
 *
 * The file is append-only and durable: it outlives the crew member's session, so a restarted amigo can read every crew
 * member's last word. `amigo report` writes these lines for the crew member; a line appended by hand counts the same.
 */
export const STATUS_VERBS = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'resolved', 'note'] as const;
export type StatusVerb = (typeof STATUS_VERBS)[number];

/** Verbs that end the crew member's turn and wait on amigo. */
export const TERMINAL_VERBS: readonly StatusVerb[] = ['needs-decision', 'blocked', 'done', 'failed'];

export interface StatusEvent {
  /** The verb as written: a known one, or an unknown word, which is still shown as the line itself. */
  state: string;
  /** Unix seconds from `[at=<epoch>]`, or null when the stamp is missing or not plain digits. */
  at: number | null;
  key?: string;
  text: string;
  /** Its line number in the file, from 1. */
  line: number;
}

export const statusFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDir(id, env), 'status');

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LINE_RE = /^([a-z][a-z-]*)((?:\s*\[[a-z]+=[^\]\r\n]*\])*)\s*:\s?(.*)$/i;

/** One status line, ready to append (one line: newlines in the text become spaces). Throws on an unknown verb or a bad key. */
export function formatStatusLine(state: string, text: string, opts: { at?: number; key?: string } = {}): string {
  if (!(STATUS_VERBS as readonly string[]).includes(state)) throw new Error(`Unknown status "${state}": use one of ${STATUS_VERBS.join(', ')}`);
  if (opts.key !== undefined && !KEY_RE.test(opts.key)) throw new Error(`Invalid key "${opts.key}": letters, digits, . _ - only`);
  const one = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!one) throw new Error('The status text is empty: say in one short line what happened');
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  return `${state} [at=${at}]${opts.key ? ` [key=${opts.key}]` : ''}: ${one}`;
}

/** Parse one line; null for a line that is not a status declaration (continuation prose, a blank line). */
export function parseStatusLine(raw: string, line = 0): StatusEvent | null {
  const m = LINE_RE.exec(raw.trim());
  if (!m) return null;
  const tags = Object.fromEntries([...(m[2] ?? '').matchAll(/\[([a-z]+)=([^\]]*)\]/gi)].map((t) => [(t[1] as string).toLowerCase(), (t[2] as string).trim()]));
  const at = /^\d+$/.test(tags.at ?? '') ? Number(tags.at) : null;
  return { state: (m[1] as string).toLowerCase(), at, ...(tags.key ? { key: tags.key } : {}), text: (m[3] ?? '').trim(), line };
}

/**
 * The file's text. A shell can append UTF-16 (Windows PowerShell's `>>`): text with a UTF-16 byte order mark, or with NUL bytes,
 * is decoded as UTF-16LE line by line rather than misread.
 */
function readText(file: string): string {
  const buf = readFileSync(file);
  if (!buf.includes(0)) return buf.toString('utf8').replace(/^﻿/, '');
  // Mixed encodings are possible (amigo report writes UTF-8, a shell may append UTF-16): split on newlines first.
  return buf
    .toString('latin1')
    .split('\n')
    .map((part) => {
      let bytes = Buffer.from(part, 'latin1');
      // A UTF-16 newline is 0A 00: splitting on 0A leaves its 00 at the start of the next line.
      if (bytes[0] === 0) bytes = bytes.subarray(1);
      if (!bytes.includes(0)) return bytes.toString('utf8');
      return bytes.toString('utf16le').replace(/^﻿/, '');
    })
    .join('\n')
    .replace(/\0/g, '');
}

/** Every status event of a task, oldest first. An absent file is an empty list. */
export function readStatus(id: string, env: NodeJS.ProcessEnv = process.env): StatusEvent[] {
  const file = statusFile(id, env);
  if (!existsSync(file)) return [];
  return readText(file)
    .split(/\r?\n/)
    .map((l, i) => parseStatusLine(l, i + 1))
    .filter((e): e is StatusEvent => e !== null);
}

/** Append one formatted line. */
export function appendStatus(id: string, line: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = statusFile(id, env);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`);
}

/** The crew member's latest word: the newest event that is not a note or a resolution. */
export function latestEvent(events: StatusEvent[]): StatusEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as StatusEvent;
    if (e.state !== 'note' && e.state !== 'resolved') return e;
  }
  return null;
}

/**
 * Decisions and blockers still open. Only a `resolved` line with the same key closes a keyed one (a later done or working never
 * does); a keyless resolved closes every keyless one before it.
 */
export function openItems(events: StatusEvent[]): StatusEvent[] {
  const open: StatusEvent[] = [];
  for (const e of events) {
    if (e.state === 'needs-decision' || e.state === 'blocked') open.push(e);
    else if (e.state === 'resolved') {
      for (let i = open.length - 1; i >= 0; i--) if ((open[i] as StatusEvent).key === e.key) open.splice(i, 1);
    }
  }
  return open;
}

/** `until <YYYY-MM-DDTHH:MM[:SS]Z>` in a paused line, as epoch milliseconds; null when absent or malformed. */
export function untilOf(text: string): number | null {
  const m = /\buntil\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)/.exec(text);
  if (!m) return null;
  const ms = Date.parse(m[1] as string);
  return Number.isNaN(ms) ? null : ms;
}

/** The declared wait the crew member is in: its latest word is `paused`. */
export function declaredWait(events: StatusEvent[]): { since: number | null; until: number | null; text: string } | null {
  const last = latestEvent(events);
  if (!last || last.state !== 'paused') return null;
  return { since: last.at, until: untilOf(last.text), text: last.text };
}

/** One line for status and the digest: the latest word, and what is still open. */
export function describeStatus(events: StatusEvent[]): string | null {
  const last = latestEvent(events);
  if (!last) return null;
  const open = openItems(events).filter((e) => e !== last);
  return `${last.state}${last.key ? ` [${last.key}]` : ''}: ${last.text}${open.length ? ` (also open: ${open.map((e) => `${e.state}${e.key ? ` [${e.key}]` : ''}`).join(', ')})` : ''}`;
}
