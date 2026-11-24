import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readJson, writeJsonAtomic } from './fsx.ts';
import { loadConfig } from './config.ts';
import { stateDir } from './paths.ts';
import { lockState, type Identity } from './session.ts';

/**
 * Context rotation for amigo's own session. Durable records, not conversation memory, are the truth, so a long session is
 * rotated rather than left to fill up or compact:
 *
 *   1. NUDGE    past config.json's rotateAtTokens (0 turns it off) and MIN_GROWTH_TOKENS past the session's first model call,
 *               the turn-end guard asks amigo, once per session and again every RENUDGE_TOKENS more, to run the /remember
 *               sweep and then `amigo rotate`
 *   2. REQUEST  `amigo rotate` records state/rotate.json for this session's amigo command (LAUNCHER_ENV)
 *   3. STOP     the next turn end marks the rotation stopped; the `amigo` command that started the session sees the mark and
 *               ends the Claude process tree. It must be the amigo command: a hook is inside
 *               that tree, so a tree kill started from a hook ends itself before it reaches Claude
 *   4. RESTART  once the session has exited, the amigo command starts a fresh one in the same terminal; its SessionStart
 *               hook prints the full digest
 */
const RENUDGE_TOKENS = 25_000;
/**
 * A session that has not grown this much past its own first model call is never asked: a fresh session whose startup
 * context alone passes the rotation point would otherwise rotate in a loop.
 */
const MIN_GROWTH_TOKENS = 20_000;
/** How much of the transcript's end is read to find the latest model call. */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * The variable that ties a session to the amigo command that started it: `<pid>:<random>`, one per amigo command. Only that
 * command ends and restarts its session, so two amigo terminals on one home never act on each other's rotation, and a
 * session started by an older amigo (no token, no restart loop) is never asked to rotate.
 */
export const LAUNCHER_ENV = 'AMIGO_LAUNCHER';

interface RotationRecord {
  launcher: string;
  session: string;
  requestedAt: string;
  stoppedAt?: string;
}

interface NudgeRecord {
  session: string;
  tokens: number;
  at: string;
}

const rotatePath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'rotate.json');
const nudgePath = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'rotate-nudge.json');
const readRotation = (env: NodeJS.ProcessEnv): RotationRecord | null => readJson<RotationRecord | null>(rotatePath(env), null);
const kTokens = (n: number): string => `${Math.round(n / 1000)}K`;

/** The rotation point in tokens (config.json's rotateAtTokens); 0 means never rotate. An unreadable config never rotates. */
export function rotateAt(env: NodeJS.ProcessEnv): number {
  try {
    return loadConfig(env).rotateAtTokens;
  } catch {
    return 0;
  }
}

/**
 * The context size of a main-thread model call in the session's transcript: input plus cache reads and writes. `newest`
 * (the default) is the current size, `first` the session's startup size. Null when the transcript is missing or has no
 * model call with usage yet.
 */
export function contextTokens(transcript: string | undefined, which: 'newest' | 'first' = 'newest'): number | null {
  if (!transcript || !existsSync(transcript)) return null;
  const fd = openSync(transcript, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, which === 'first' ? 0 : size - len);
    const lines = buf.toString('utf8').split('\n');
    const order = which === 'first' ? lines.map((_, i) => i) : lines.map((_, i) => lines.length - 1 - i);
    for (const i of order) {
      const line = lines[i]!;
      if (!line.includes('"usage"')) continue;
      let o: { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, number> } };
      try {
        o = JSON.parse(line);
      } catch {
        continue; // a line at either end of the read may be cut
      }
      const u = o.message?.usage;
      if (o.type !== 'assistant' || o.isSidechain || !u) continue;
      return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A new launcher token for an amigo command. */
export const newLauncher = (): string => `${process.pid}:${randomUUID()}`;

const launcherPid = (token: string): number => Number(token.split(':')[0]);

/**
 * The turn-end nudge to rotate, or null: only in a session whose amigo command can restart it, past the rotation point, once
 * per session and again every RENUDGE_TOKENS.
 */
export function rotationNudge(me: Identity, transcript: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const limit = rotateAt(env);
  const launcher = env[LAUNCHER_ENV];
  if (!limit || !me.session || !launcher) return null;
  if (readRotation(env)?.launcher === launcher) return null; // already asked for
  const tokens = contextTokens(transcript);
  if (tokens === null || tokens < limit) return null;
  if (tokens < (contextTokens(transcript, 'first') ?? 0) + MIN_GROWTH_TOKENS) return null;
  const last = readJson<NudgeRecord | null>(nudgePath(env), null);
  if (last?.session === me.session && tokens < last.tokens + RENUDGE_TOKENS) return null;
  writeJsonAtomic(nudgePath(env), { session: me.session, tokens, at: new Date().toISOString() } satisfies NudgeRecord);
  return (
    `amigo: this session's context is at ${kTokens(tokens)} tokens, past the rotation point (${kTokens(limit)}). Rotate now: ` +
    'run the /remember sweep (file open work only this session knows, curate boss.md and learnings.md; report it to the Boss in one line), ' +
    'then run `amigo rotate` and end the turn with one line saying amigo is restarting fresh. The turn end stops this session and ' +
    'the amigo command starts a new one with the full digest.\n'
  );
}

/** `amigo rotate`: record that this session wants a fresh one. Only the session that controls the home can rotate. */
export function requestRotation(me: Identity, env: NodeJS.ProcessEnv): string {
  const launcher = env[LAUNCHER_ENV];
  if (!launcher || !me.session) throw new Error('amigo rotate runs only inside an amigo session started by an amigo command that can restart it: if this session was started before rotation existed, the Boss restarts amigo instead.');
  if (lockState(env, me).state !== 'owned') throw new Error('This session does not hold the session lock: only the amigo session that controls the home can rotate.');
  writeJsonAtomic(rotatePath(env), { launcher, session: me.session, requestedAt: new Date().toISOString() } satisfies RotationRecord);
  return 'Rotation set. End this turn now with one line to the Boss: when it ends, amigo stops this session and starts a fresh one in this terminal with the full digest.';
}

/**
 * At a turn end of a session whose amigo command has a rotation requested: mark it stopped, so that command ends the
 * session (rotationStopped). The session lock is kept: it goes stale when the session ends and the fresh session's digest
 * takes it over. True when it was marked.
 */
export function stopForRotation(env: NodeJS.ProcessEnv): boolean {
  const r = readRotation(env);
  const launcher = env[LAUNCHER_ENV];
  if (!r || !launcher || r.launcher !== launcher || r.stoppedAt) return false;
  writeJsonAtomic(rotatePath(env), { ...r, stoppedAt: new Date().toISOString() } satisfies RotationRecord);
  return true;
}

/** This session (its amigo command's token in env) is marked stopped for a rotation and is about to be ended. */
export const stoppingForRotation = (env: NodeJS.ProcessEnv): boolean => Boolean(env[LAUNCHER_ENV]) && rotationStopped(env, env[LAUNCHER_ENV]!);

/** The session this amigo command started has reached the turn end of its rotation: the command ends it now. */
export const rotationStopped = (env: NodeJS.ProcessEnv, launcher: string): boolean => {
  const r = readRotation(env);
  return r?.launcher === launcher && Boolean(r.stoppedAt);
};

/**
 * After the session this amigo command started has exited: true when it was stopped for a rotation, so the command starts a
 * fresh one. Its record is consumed either way; another command's record is left alone.
 */
export function takeRotation(env: NodeJS.ProcessEnv, launcher: string): boolean {
  const r = readRotation(env);
  if (r?.launcher !== launcher) return false;
  rmSync(rotatePath(env), { force: true });
  return Boolean(r.stoppedAt);
}

/** Before an amigo command starts a session: drop a record whose amigo command is gone (it died before it could restart). */
export function clearOrphanRotation(env: NodeJS.ProcessEnv): void {
  const r = readRotation(env);
  if (!r) return;
  const pid = launcherPid(r.launcher ?? '');
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) rmSync(rotatePath(env), { force: true });
}

/** The briefing for the session that follows a rotation. */
export const ROTATED_NOTE =
  'This session follows a context rotation: the previous amigo session filed what it knew and restarted to free context. Nothing changed for the Boss; do not repeat the previous session\'s reports. Open with one line that amigo restarted fresh, plus only what needs his action.';
