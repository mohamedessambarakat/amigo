import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { resolveExecutable } from './command.ts';
import { sleepSync } from './fsx.ts';
import { listTasks, type Task } from './tasks.ts';

/**
 * The shared no-mistakes daemon: read it, and start it again when it is positively down.
 *
 * Why amigo starts it: on Windows a non-elevated `no-mistakes daemon start` cannot register its logon task (v1.84 asks for an
 * any-user trigger, which needs admin), so it falls back to a detached child of whoever ran it. That child stays in the
 * caller's job object. A herdr terminal's job, and Node's own child-process job, kill every member when they close, so the
 * daemon dies with the terminal (or the amigo watcher) that started it, and never comes back after a reboot. amigo therefore
 * starts it outside every job (CREATE_BREAKAWAY_FROM_JOB), so it outlives the terminal and the watcher.
 *
 * Only `daemon status` and `daemon start` are ever run: never stop, restart or update. A dead daemon has no in-flight runs to
 * kill. Only positive evidence counts as down (it says "not running", or the socket refuses the connection); a timeout, a
 * crash of the status call or any other output is "unknown" and leaves the daemon alone.
 */

export type DaemonState = 'up' | 'down' | 'unknown';

export interface DaemonReading {
  state: DaemonState;
  detail: string;
}

const ms = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** How long one `daemon status` may take before it counts as unknown. */
const statusTimeout = (env: NodeJS.ProcessEnv) => ms(env.AMIGO_NM_STATUS_TIMEOUT_MS, 15_000);
/** How long amigo waits for a started daemon to answer (no-mistakes' own readiness budget is 45 s). */
const startWait = (env: NodeJS.ProcessEnv) => ms(env.AMIGO_NM_START_WAIT_MS, 60_000);

interface NmCommand {
  file: string;
  pre: string[];
}

/** AMIGO_NO_MISTAKES (a program or, for tests, a .mjs script run by this Node), else `no-mistakes` on PATH. */
function nmCommand(env: NodeJS.ProcessEnv): NmCommand | null {
  const o = env.AMIGO_NO_MISTAKES;
  if (o && /\.(m|c)?js$/i.test(o)) return existsSync(o) ? { file: process.execPath, pre: [o] } : null;
  const file = resolveExecutable(o || 'no-mistakes', env);
  if (!file) return null;
  // A Windows .cmd/.bat shim only starts through cmd.exe.
  if (process.platform === 'win32' && /^\.(cmd|bat)$/i.test(extname(file))) return { file: env.ComSpec || 'cmd.exe', pre: ['/d', '/c', file] };
  return { file, pre: [] };
}

const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[●○]/g, '');

/** The lines no-mistakes adds about its own updates are noise here. */
const meaningful = (s: string): string =>
  clean(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/new version of no-mistakes|no-mistakes update/i.test(l))
    .join(' | ');

/** Positive evidence the daemon is not there. */
const DOWN = /\bdaemon not running\b|actively refused|connection refused|ECONNREFUSED/i;

/** `no-mistakes daemon status`, bounded. Null when no-mistakes is not installed. */
export function readDaemon(env: NodeJS.ProcessEnv): DaemonReading | null {
  const nm = nmCommand(env);
  if (!nm) return null;
  const timeout = statusTimeout(env);
  const r = spawnSync(nm.file, [...nm.pre, 'daemon', 'status'], { env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { state: 'unknown', detail: timedOut ? `daemon status timed out after ${timeout / 1000}s` : `daemon status could not run: ${r.error.message}` };
  }
  const text = meaningful(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (/\bdaemon running\b/i.test(text)) return { state: 'up', detail: text };
  if (DOWN.test(text)) return { state: 'down', detail: text };
  return { state: 'unknown', detail: `daemon status exited ${r.status}: ${text || 'no output'}` };
}

/** Quote one argument for a Windows command line (the CommandLineToArgvW rules). */
export function quoteWinArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Starts the command line in AMIGO_DETACH_CMDLINE as a console-less process outside every job object (falling back to one
 * inside the job when a job forbids breakaway), with this environment, and prints "<pid> breakaway|in-job".
 */
const WINDOWS_LAUNCHER = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AmigoDetach {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SI { public int cb; public string r; public string d; public string t; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)]
  struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  public static string Start(string cmd) {
    const uint DETACHED = 0x8, NEW_GROUP = 0x200, BREAKAWAY = 0x1000000;
    foreach (uint extra in new uint[] { BREAKAWAY, 0 }) {
      SI si = new SI(); si.cb = Marshal.SizeOf(si); PI pi;
      if (CreateProcessW(null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false, DETACHED | NEW_GROUP | extra, IntPtr.Zero, null, ref si, out pi)) {
        CloseHandle(pi.ht); CloseHandle(pi.hp);
        return pi.pid + (extra != 0 ? " breakaway" : " in-job");
      }
      if (extra == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return null;
  }
}
'@
[AmigoDetach]::Start($env:AMIGO_DETACH_CMDLINE)`;

/** Launch `daemon start` so neither it nor the daemon it spawns belongs to this process or its terminal. */
function launchDetached(nm: NmCommand, env: NodeJS.ProcessEnv): { ok: true; how: string } | { ok: false; error: string } {
  const argv = [nm.file, ...nm.pre, 'daemon', 'start'];
  if (process.platform !== 'win32') {
    try {
      // A launch error arrives as an event; the status poll that follows reports the daemon still down.
      spawn(argv[0]!, argv.slice(1), { env, cwd: homedir(), detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return { ok: true, how: 'detached' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const encoded = Buffer.from(WINDOWS_LAUNCHER, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...env, AMIGO_DETACH_CMDLINE: argv.map(quoteWinArg).join(' ') },
    // The daemon inherits this folder: never a worktree or temporary folder it would keep from being deleted.
    cwd: homedir(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.error) return { ok: false, error: `the detached launcher could not run: ${r.error.message}` };
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^\d+ (breakaway|in-job)$/m.test(out)) return { ok: false, error: `the detached launcher failed (exit ${r.status}): ${meaningful(`${r.stderr}\n${out}`) || 'no output'}` };
  return { ok: true, how: /breakaway/.test(out) ? 'outside the terminal job' : 'inside the terminal job (it forbids breakaway, so it may die with this terminal)' };
}

export type EnsureResult =
  | { action: 'none'; reading: DaemonReading | null }
  | { action: 'started'; was: DaemonReading; now: DaemonReading; how: string }
  | { action: 'failed'; was: DaemonReading; error: string };

/**
 * Start the daemon only when `daemon status` positively says it is down, twice in a row (so a daemon that just came up is
 * never handed a second start), then wait for it to answer. A live or unknown daemon is left alone.
 */
export function ensureDaemon(env: NodeJS.ProcessEnv): EnsureResult {
  const first = readDaemon(env);
  if (!first || first.state !== 'down') return { action: 'none', reading: first };
  const second = readDaemon(env);
  if (!second || second.state !== 'down') return { action: 'none', reading: second };
  const nm = nmCommand(env)!;
  const launched = launchDetached(nm, env);
  if (!launched.ok) return { action: 'failed', was: second, error: launched.error };
  const deadline = Date.now() + startWait(env);
  let now: DaemonReading | null = null;
  for (;;) {
    now = readDaemon(env);
    if (now?.state === 'up') return { action: 'started', was: second, now, how: launched.how };
    if (Date.now() > deadline) break;
    sleepSync(500);
  }
  return { action: 'failed', was: second, error: `daemon start ran, but the daemon did not answer within ${startWait(env) / 1000}s (last status: ${now?.detail ?? 'none'})` };
}

/** Builds that run through the no-mistakes pipeline and are still open: the ones a dead daemon strands. */
export const openPipelineBuilds = (env: NodeJS.ProcessEnv): Task[] =>
  listTasks(env).filter((t) => t.mode === 'no-mistakes' && !t.merge && !['queued', 'closing', 'closed'].includes(t.status));

/** One line for amigo about an ensure that did something. */
export function describeEnsure(r: EnsureResult, builds: readonly Task[]): string {
  const ids = builds.map((t) => t.id).join(', ');
  if (r.action === 'started')
    return `no-mistakes daemon was down (${r.was.detail}); amigo started it again ${r.how} (${r.now.detail}).${ids ? ` Steer each open no-mistakes build (${ids}) to reattach: \`no-mistakes axi run\` from its own worktree, after reading \`no-mistakes axi status\`.` : ''}`;
  if (r.action === 'failed') return `no-mistakes daemon is down (${r.was.detail}) and amigo could not start it: ${r.error}.${ids ? ` Open no-mistakes builds stranded: ${ids}.` : ''} Tell the Boss.`;
  const reading = r.reading;
  if (!reading) return 'no-mistakes is not installed.';
  return reading.state === 'up' ? `no-mistakes daemon is running (${reading.detail}).` : `no-mistakes daemon state is unknown (${reading.detail}); left alone - a timeout is not evidence it is down.`;
}
