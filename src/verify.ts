import { spawn, type ChildProcess } from 'node:child_process';
import { quoteForCmd } from './command.ts';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { killTree } from './proc.ts';
import { lastLines } from './tasks.ts';

/** One command the briefing ran (a live command): how it ended and the tail of its output. */
export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  seconds: number;
  output: string;
}

/** Run one process, killing it (and what it started) after timeoutMs. Output goes to a file, so a stuck child cannot hold a pipe open. */
function runWith(command: string, start: (fd: number) => ChildProcess, timeoutMs: number): Promise<CheckResult> {
  const file = join(os.tmpdir(), `amigo-check-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
  const fd = openSync(file, 'w');
  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let finished = false;
    const child = start(fd);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const end = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeSync(fd);
      const text = error ? error.message : readFileSync(file, 'utf8');
      rmSync(file, { force: true });
      resolve({ command, ok: code === 0 && !timedOut, exitCode: code, timedOut, seconds: Math.round((Date.now() - started) / 1000), output: lastLines(text, 40).slice(-3000) });
    };
    child.on('error', (err) => end(null, err));
    child.on('close', (code) => end(code));
  });
}

/** Run one shell command in `cwd` (see runWith). */
export function runCheck(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  return runWith(command, (fd) => spawn(command, { cwd, env, shell: true, stdio: ['ignore', fd, fd], windowsHide: true }), timeoutMs);
}

/**
 * Run a program by its absolute path with an argument list, through no shell (a Windows .cmd shim excepted, which only starts
 * through cmd.exe, still by its absolute path). A shell started in a project folder would find the folder's own gh.bat or
 * gh.cmd before the real one on PATH, and run whatever a cloned repository put there. `label` is what the result shows.
 */
export function runProgram(file: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, label: string): Promise<CheckResult> {
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  return runWith(
    label,
    (fd) =>
      shim
        ? spawn([file, ...args].map(quoteForCmd).join(' '), { cwd, env, shell: true, stdio: ['ignore', fd, fd], windowsHide: true })
        : spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', fd, fd], windowsHide: true }),
    timeoutMs,
  );
}
