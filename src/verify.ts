import { spawn, type ChildProcess } from 'node:child_process';
import { quoteForCmd } from './command.ts';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadProjects } from './config.ts';
import { assertWorktreeIntact } from './git.ts';
import { killTree } from './proc.ts';
import { snapshot } from './risk.ts';
import { lastLines, mutateTask, requireTask, type CheckResult, type Task, type Verification } from './tasks.ts';

/** How many times a failed check sends the squad member back to fix it before the task is blocked. */
export const MAX_CHECK_RETRIES = 2;

/** The project's checks that apply to this task: none for a reviewer, which changes nothing. */
export function checksFor(t: Task, env: NodeJS.ProcessEnv): string[] {
  return t.reviewOf || t.scratch ? [] : (loadProjects(env).find((p) => p.name === t.project)?.checks ?? []);
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

const why = (r: CheckResult, minutes: number): string => (r.timedOut ? `timed out after ${minutes} min` : r.exitCode === null ? 'could not start' : `exit ${r.exitCode}`);

/** The follow-up a squad member gets when checks fail: each failing command with the tail of its output. */
export function failureMessage(failed: CheckResult[], retry: number, minutes: number): string {
  const blocks = failed.map((r) => `\`${r.command}\` (${why(r, minutes)}):\n${r.output || '(no output)'}`);
  return `amigo ran the project's checks in your folder and ${failed.length === 1 ? 'one failed' : `${failed.length} failed`} (automatic retry ${retry} of ${MAX_CHECK_RETRIES}).\n\n${blocks.join('\n\n')}\n\nFix the cause, run the failing command yourself until it passes, then report again with your STATUS line.`;
}

/**
 * Run the project's checks for a task whose squad member just said done (status "verifying") and record the outcome: all passed,
 * done; a failure with retries left, the follow-up for the squad member (returned, and the task goes to `retryStatus`: "running"
 * when the squad member's session is still open to read it, "queued" when the agent runs again with it as a follow-up); a failure
 * with none left, blocked with the failing check in the summary. Returns the follow-up, or null.
 */
export async function verifyDone(id: string, retryStatus: 'running' | 'queued', env: NodeJS.ProcessEnv): Promise<string | null> {
  const t = requireTask(id, env);
  const minutes = loadConfig(env).checkTimeoutMin;
  if (t.worktree && t.repo) {
    // The checks run in the squad member's folder and may run git there: never in a worktree whose .git was redirected.
    try {
      assertWorktreeIntact(t.repo, t.worktree, t.gitDir);
    } catch (err) {
      mutateTask(id, (cur) => (cur.status !== 'verifying' ? null : { status: 'blocked', seen: false, verification: { state: 'failed', results: [], at: new Date().toISOString() }, summary: (err as Error).message }), env);
      return null;
    }
  }
  const results: CheckResult[] = [];
  for (const command of checksFor(t, env)) results.push(await runCheck(command, t.cwd, minutes * 60_000, env));
  const failed = results.filter((r) => !r.ok);
  const at = new Date().toISOString();
  let tree: string | undefined;
  if (!failed.length && t.worktree && t.repo && t.baseSha && existsSync(t.worktree)) {
    try {
      tree = snapshot(t.repo, t.worktree, t.baseSha, t.gitDir).tree;
    } catch {
      // without a tree the checks still count; only --self refuses work it cannot tie to them
    }
  }
  let message: string | null = null;
  mutateTask(
    id,
    (cur) => {
      if (cur.status !== 'verifying') return null; // closed or restarted meanwhile
      if (!failed.length) return { status: 'done', seen: false, checkRetries: 0, verification: { state: 'passed', results, ...(tree ? { tree } : {}), at } satisfies Verification };
      const verification: Verification = { state: 'failed', results, at };
      const retries = cur.checkRetries ?? 0;
      if (retries < MAX_CHECK_RETRIES) {
        message = failureMessage(failed, retries + 1, minutes);
        return { status: retryStatus, checkRetries: retries + 1, verification, ...(retryStatus === 'queued' ? { followUps: [...cur.followUps, message], seen: true } : {}) };
      }
      const first = failed[0] as CheckResult;
      const last = lastLines(first.output, 1);
      return {
        status: 'blocked',
        seen: false,
        verification,
        summary: `Check failed after ${MAX_CHECK_RETRIES} automatic retries: ${first.command} (${why(first, minutes)})${last ? `: ${last}` : ''}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`,
      };
    },
    env,
  );
  return message;
}

/** One line for status and inbox: how the checks went. */
export function describeVerification(t: Task): string | null {
  const v = t.verification;
  if (!v) return null;
  if (v.state === 'unverified') return t.scratch ? 'unverified (scratch folder, not git: nothing to check)' : 'unverified (this project has no checks)';
  const ok = v.results.filter((r) => r.ok).length;
  if (v.state === 'passed') return `passed (${ok} of ${v.results.length} checks)`;
  return `failed: ${v.results.filter((r) => !r.ok).map((r) => r.command).join(', ')}${t.checkRetries ? ` (automatic retries used: ${t.checkRetries} of ${MAX_CHECK_RETRIES})` : ''}`;
}
