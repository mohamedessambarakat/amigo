import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { resolveExecutable } from './command.ts';
import { readJson, sleepSync, withLock, writeJsonAtomic } from './fsx.ts';
import { lockPath, stateDir } from './paths.ts';
import { listTasks, type Task } from './tasks.ts';

/**
 * The shared no-mistakes daemon: read it, and on Windows start it again when it is positively down.
 *
 * Why amigo starts it: on Windows a non-elevated `no-mistakes daemon start` cannot register its logon task (v1.84 asks for an
 * any-user trigger, which needs admin), so it falls back to a detached child of whoever ran it. That child stays in the
 * caller's job object. A herdr terminal's job kills every member when it closes, so the daemon dies with the terminal that
 * started it, and nothing brings it back after a reboot. amigo starts it outside every job (CREATE_BREAKAWAY_FROM_JOB), so it
 * outlives the terminal and the watcher. On macOS and Linux launchd or systemd own the daemon, and amigo only reads it.
 *
 * Only `daemon status` and `daemon start` are ever run: never stop, restart or update. Only positive evidence counts as down
 * (not running, a pid that is no longer running, a refused socket); a timeout or any other output is "unknown" and leaves the
 * daemon alone. `daemon start` kills a `daemon run` that does not answer, so a start is launched only when the daemon read down
 * on two reads at least AMIGO_NM_DOWN_GAP_MS apart (above no-mistakes' 45 s readiness budget), no `daemon run` process exists
 * for this NM_HOME, and the nm-daemon lock is held: the watcher, `amigo daemon` and spawn share it.
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
/** How long a launched daemon gets to answer (no-mistakes' own readiness budget is 45 s). */
const startWait = (env: NodeJS.ProcessEnv) => ms(env.AMIGO_NM_START_WAIT_MS, 90_000);
/** Two down reads at least this far apart before a start: a daemon that is still starting reads down for up to 45 s. */
const downGap = (env: NodeJS.ProcessEnv) => ms(env.AMIGO_NM_DOWN_GAP_MS, 50_000);
/** A daemon launched this many times inside the window keeps dying: stop launching and say so once. */
const LOOP_LAUNCHES = 3;
const loopWindow = (env: NodeJS.ProcessEnv) => ms(env.AMIGO_NM_LOOP_WINDOW_MS, 30 * 60_000);

/** Whether amigo starts a down daemon here: Windows only (AMIGO_NM_AUTOSTART=1 forces it, for tests). */
export const autostart = (env: NodeJS.ProcessEnv): boolean => env.AMIGO_NM_AUTOSTART === '1' || (env.AMIGO_NM_AUTOSTART !== '0' && process.platform === 'win32');

interface NmCommand {
  file: string;
  pre: string[];
  /** A Windows .cmd/.bat shim: it runs through cmd.exe /d /s /c "<quoted command line>", as Node runs shell commands. */
  shim?: string;
}

/** AMIGO_NO_MISTAKES (a program or, for tests, a .mjs script run by this Node), else `no-mistakes` on PATH. */
function nmCommand(env: NodeJS.ProcessEnv): NmCommand | null {
  const o = env.AMIGO_NO_MISTAKES;
  if (o && /\.(m|c)?js$/i.test(o)) return existsSync(o) ? { file: process.execPath, pre: [o] } : null;
  const file = resolveExecutable(o || 'no-mistakes', env);
  if (!file) return null;
  if (process.platform === 'win32' && /^\.(cmd|bat)$/i.test(extname(file))) return { file: env.ComSpec || 'cmd.exe', pre: [], shim: file };
  return { file, pre: [] };
}

/** Quote one argument for a Windows command line (the CommandLineToArgvW rules). */
export function quoteWinArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** The argv to spawn (verbatim on Windows when it goes through cmd.exe), and the full Windows command line. */
function invocation(nm: NmCommand, args: string[]): { file: string; args: string[]; verbatim: boolean; line: string } {
  if (nm.shim) {
    const inner = `"${[nm.shim, ...args].map(quoteWinArg).join(' ')}"`;
    return { file: nm.file, args: ['/d', '/s', '/c', inner], verbatim: true, line: `${quoteWinArg(nm.file)} /d /s /c ${inner}` };
  }
  const all = [...nm.pre, ...args];
  return { file: nm.file, args: all, verbatim: false, line: [nm.file, ...all].map(quoteWinArg).join(' ') };
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
const DOWN = /\bdaemon not running\b|\bis no longer running\b|actively refused|connection refused|ECONNREFUSED/i;

/** `no-mistakes daemon status`, bounded. Null when no-mistakes is not installed. */
export function readDaemon(env: NodeJS.ProcessEnv): DaemonReading | null {
  const nm = nmCommand(env);
  if (!nm) return null;
  const timeout = statusTimeout(env);
  const inv = invocation(nm, ['daemon', 'status']);
  const r = spawnSync(inv.file, inv.args, { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: inv.verbatim, timeout, maxBuffer: 1024 * 1024 });
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { state: 'unknown', detail: timedOut ? `daemon status timed out after ${timeout / 1000}s` : `daemon status could not run: ${r.error.message}` };
  }
  const text = meaningful(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (/\bdaemon running\b/i.test(text)) return { state: 'up', detail: text };
  if (DOWN.test(text)) return { state: 'down', detail: text };
  return { state: 'unknown', detail: `daemon status exited ${r.status}: ${text || 'no output'}` };
}

/** The NM_HOME the daemon serves. */
const nmRoot = (env: NodeJS.ProcessEnv): string => resolve(env.NM_HOME || join(homedir(), '.no-mistakes'));

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pids of `... daemon run --root <this NM_HOME>` processes: one that exists is starting (or wedged), and is never handed a
 * second start. Null when the process list cannot be read, which also blocks a start.
 */
export function daemonRunProcesses(env: NodeJS.ProcessEnv): number[] | null {
  const root = nmRoot(env);
  const flags = process.platform === 'win32' ? 'i' : '';
  const re = new RegExp(`\\bdaemon run\\b.*--root\\s+("?)${escapeRe(root)}[\\\\/]?\\1(\\s|$)`, flags);
  const r =
    process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "CommandLine like '%daemon run%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      : spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m) && Number(m![1]) !== process.pid && re.test(m![2]!))
    .map((m) => Number(m[1]));
}

/**
 * Starts the command line in AMIGO_DETACH_CMDLINE as a console-less process outside every job object (inside the job when
 * one forbids breakaway, or AMIGO_NM_NO_BREAKAWAY=1 for tests), with this environment minus that variable, and prints
 * "<pid> breakaway|in-job".
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
  public static string Start(string cmd, bool breakaway) {
    const uint DETACHED = 0x8, NEW_GROUP = 0x200, BREAKAWAY = 0x1000000;
    foreach (uint extra in breakaway ? new uint[] { BREAKAWAY, 0 } : new uint[] { 0 }) {
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
$line = $env:AMIGO_DETACH_CMDLINE
$breakaway = $env:AMIGO_NM_NO_BREAKAWAY -ne '1'
Remove-Item Env:AMIGO_DETACH_CMDLINE
Remove-Item Env:AMIGO_NM_NO_BREAKAWAY -ErrorAction SilentlyContinue
[AmigoDetach]::Start($line, $breakaway)`;

/** The environment the daemon gets: none of amigo's or Claude Code's own variables, so its agents never look like amigo's lead. */
const daemonEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(AMIGO_|CLAUDE)/i.test(k)));

/** Launch `daemon start` so neither it nor the daemon it spawns belongs to this process or its terminal. It does not wait. */
export function launchStart(env: NodeJS.ProcessEnv): { ok: true; how: string } | { ok: false; error: string } {
  const nm = nmCommand(env);
  if (!nm) return { ok: false, error: 'no-mistakes is not installed' };
  const inv = invocation(nm, ['daemon', 'start']);
  const childEnv = daemonEnv(env);
  if (process.platform !== 'win32') {
    try {
      // A launch error arrives as an event; the next status read reports the daemon still down.
      spawn(inv.file, inv.args, { env: childEnv, cwd: homedir(), detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return { ok: true, how: 'detached' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  const encoded = Buffer.from(WINDOWS_LAUNCHER, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...childEnv, AMIGO_DETACH_CMDLINE: inv.line, ...(env.AMIGO_NM_NO_BREAKAWAY === '1' ? { AMIGO_NM_NO_BREAKAWAY: '1' } : {}) },
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

/** What amigo remembers about the daemon between reads (state/nm-daemon.json). */
interface Memory {
  /** When the current down episode was first read (0: not down). */
  firstDownAt: number;
  firstDown: string;
  /** A launched start still waiting to answer. */
  launch: { at: number; how: string } | null;
  /** When starts were launched, for the keeps-dying limit. */
  launches: number[];
  /** A failure (or the keeps-dying stop) was already reported in this episode. */
  reported: boolean;
}

const memoryFile = (env: NodeJS.ProcessEnv) => join(stateDir(env), 'nm-daemon.json');
const loadMemory = (env: NodeJS.ProcessEnv): Memory => {
  const m = readJson<Partial<Memory>>(memoryFile(env), {});
  return { firstDownAt: m.firstDownAt ?? 0, firstDown: m.firstDown ?? '', launch: m.launch ?? null, launches: Array.isArray(m.launches) ? m.launches : [], reported: m.reported ?? false };
};

export type Tend =
  /** Nothing to do or say: running, unreadable, not installed, or not amigo's to start here. */
  | { kind: 'none'; reading: DaemonReading | null; note: string }
  /** Down, and amigo is confirming it, waiting for another starter, or waiting for its own launch to answer. */
  | { kind: 'pending'; reading: DaemonReading; note: string }
  | { kind: 'restarted'; was: string; now: DaemonReading; how: string }
  | { kind: 'failed'; was: string; error: string }
  | { kind: 'keeps-dying'; was: string; launches: number; minutes: number };

/**
 * One non-blocking look at the daemon, under the nm-daemon lock: read it, and on Windows move a positively down daemon one step
 * towards running (confirm the down, launch a detached start, see it answer). A live, starting or unreadable daemon is left alone.
 * Failures and the keeps-dying stop are returned once per episode; a launch that answered is returned once. Never waits on a
 * start: the launch returns at once and later looks see it answer.
 */
export function tendDaemon(env: NodeJS.ProcessEnv, now = Date.now(), opts: { waitMs?: number } = {}): Tend {
  if (!nmCommand(env)) return { kind: 'none', reading: null, note: 'no-mistakes is not installed' };
  // Held by another tender (the watcher, amigo daemon, a spawn): a caller that cannot wait throws, and looks again later.
  return withLock(lockPath('nm-daemon', env), () => tendLocked(env, now), 180_000, opts.waitMs ?? 185_000);
}

function tendLocked(env: NodeJS.ProcessEnv, now: number): Tend {
  const mem = loadMemory(env);
  const save = () => writeJsonAtomic(memoryFile(env), mem);
  const reading = readDaemon(env)!;
  mem.launches = mem.launches.filter((t) => now - t < loopWindow(env));
  if (reading.state === 'up') {
    const launched = mem.launch;
    const was = mem.firstDown;
    Object.assign(mem, { firstDownAt: 0, firstDown: '', launch: null, reported: false });
    save();
    return launched ? { kind: 'restarted', was, now: reading, how: launched.how } : { kind: 'none', reading, note: 'running' };
  }
  if (reading.state === 'unknown' || !autostart(env)) {
    save();
    return { kind: 'none', reading, note: reading.state === 'unknown' ? 'unreadable: left alone' : 'down; its service manager owns it here' };
  }
  if (!mem.firstDownAt) Object.assign(mem, { firstDownAt: now, firstDown: reading.detail });
  const was = mem.firstDown;
  const pending = (note: string): Tend => (save(), { kind: 'pending', reading, note });
  const once = (t: Tend): Tend => {
    if (mem.reported) return pending('already reported');
    mem.reported = true;
    save();
    return t;
  };
  if (mem.launch) {
    if (now - mem.launch.at < startWait(env)) return pending('waiting for the started daemon to answer');
    mem.launch = null;
    mem.firstDownAt = now; // a fresh confirmation before any further start
    return once({ kind: 'failed', was, error: `daemon start was launched, but the daemon did not answer within ${startWait(env) / 1000}s (last status: ${reading.detail})` });
  }
  if (mem.launches.length >= LOOP_LAUNCHES) return once({ kind: 'keeps-dying', was, launches: mem.launches.length, minutes: Math.round(loopWindow(env) / 60_000) });
  if (now - mem.firstDownAt < downGap(env)) return pending('confirming it stays down');
  const runs = daemonRunProcesses(env);
  if (runs === null) return pending('the process list could not be read, so a start could collide');
  if (runs.length) {
    mem.firstDownAt = now;
    return pending(`a daemon run process (pid ${runs.join(', ')}) is already starting`);
  }
  const launched = launchStart(env);
  if (!launched.ok) {
    mem.firstDownAt = now;
    return once({ kind: 'failed', was, error: launched.error });
  }
  mem.launches.push(now);
  mem.launch = { at: now, how: launched.how };
  return pending('started; waiting for it to answer');
}

/** `amigo daemon`: tend until the outcome is known, bounded. */
export function ensureDaemon(env: NodeJS.ProcessEnv): Tend {
  const deadline = Date.now() + downGap(env) + startWait(env) + 30_000;
  for (;;) {
    const t = tendDaemon(env);
    if (t.kind !== 'pending' || t.note === 'already reported' || Date.now() > deadline) return t;
    sleepSync(Math.min(2_000, downGap(env)));
  }
}

/** Builds that run through the no-mistakes pipeline and are still open: the ones a dead daemon strands. */
export const openPipelineBuilds = (env: NodeJS.ProcessEnv): Task[] =>
  listTasks(env).filter((t) => t.mode === 'no-mistakes' && !t.merge && !['queued', 'closing', 'closed'].includes(t.status));

/** One line for amigo about a look at the daemon. */
export function describeTend(t: Tend, builds: readonly Task[]): string {
  const ids = builds.map((b) => b.id).join(', ');
  switch (t.kind) {
    case 'restarted':
      return `no-mistakes daemon was down (${t.was}); amigo started it again ${t.how} (${t.now.detail}).${ids ? ` Steer each open no-mistakes build (${ids}) to reattach: \`no-mistakes axi run\` from its own worktree, after reading \`no-mistakes axi status\`.` : ''}`;
    case 'failed':
      return `no-mistakes daemon is down (${t.was}) and amigo could not start it: ${t.error}.${ids ? ` Open no-mistakes builds stranded: ${ids}.` : ''} Tell the Boss.`;
    case 'keeps-dying':
      return `no-mistakes daemon keeps dying: amigo started it ${t.launches} times in ${t.minutes} min and it is down again (${t.was}). amigo stopped starting it until that window passes.${ids ? ` Open no-mistakes builds stranded: ${ids}.` : ''} Tell the Boss.`;
    case 'pending':
      return `no-mistakes daemon is down (${t.reading.detail}); ${t.note}.`;
    default:
      if (!t.reading) return 'no-mistakes is not installed.';
      if (t.reading.state === 'up') return `no-mistakes daemon is running (${t.reading.detail}).`;
      if (t.reading.state === 'unknown') return `no-mistakes daemon state is unknown (${t.reading.detail}); left alone - a timeout is not evidence it is down.`;
      return `no-mistakes daemon is down (${t.reading.detail}); ${t.note}.`;
  }
}
