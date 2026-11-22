import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { quoteForCmd, resolveExecutable } from './command.ts';
import { assertWorktreeIntact, findAdminDir, samePath, worktreeRun } from './git.ts';
import { worktreePoolDir } from './paths.ts';
import { run, type RunResult } from './proc.ts';

/** How long one treehouse or fetch call may take. */
const TOOL_TIMEOUT_MS = 5 * 60_000;

/**
 * treehouse: AMIGO_TREEHOUSE (another program, for tests), else `treehouse` on PATH, else where its installer puts it on Windows
 * (%LOCALAPPDATA%\treehouse\treehouse.exe): a shell opened before the install does not see the PATH change.
 */
export function treehousePath(env: NodeJS.ProcessEnv): string | null {
  if (env.AMIGO_TREEHOUSE) return resolveExecutable(env.AMIGO_TREEHOUSE, env);
  const onPath = resolveExecutable('treehouse', env);
  if (onPath) return onPath;
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const exe = join(env.LOCALAPPDATA, 'treehouse', 'treehouse.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** The pool treehouse keeps the worktrees in: TREEHOUSE_ROOT when the environment sets one, else state/worktrees in the home. */
export const poolRoot = (env: NodeJS.ProcessEnv): string => env.TREEHOUSE_ROOT || worktreePoolDir(env);

function runTreehouse(args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  const file = treehousePath(env);
  if (!file) throw new Error('treehouse is not installed: amigo takes every worktree from its pool. Install it from https://github.com/kunchenguid/treehouse, then try again.');
  const toolEnv = { ...env, TREEHOUSE_ROOT: poolRoot(env) };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const r = spawnSync([file, ...args].map(quoteForCmd).join(' '), { cwd, env: toolEnv, encoding: 'utf8', shell: true, windowsHide: true, timeout: TOOL_TIMEOUT_MS });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  }
  const r = spawnSync(file, args, { cwd, env: toolEnv, encoding: 'utf8', windowsHide: true, timeout: TOOL_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

const said = (r: RunResult): string => (r.error?.message || r.stderr || r.stdout).trim();

/** The worktree path `treehouse get --lease --json` printed: its JSON `path`, else its last line (older output is the bare path). */
export function leasedPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const path = (JSON.parse(line) as { path?: unknown }).path;
      if (typeof path === 'string' && path) return path;
    } catch {
      // not the JSON line
    }
  }
  return lines.at(-1) ?? null;
}

/**
 * Why `path` is not an isolated worktree of the clone, or null when it is. Isolated means: a
 * real folder that is its own worktree root, not the clone itself, whose git dir is not the clone's common git dir. amigo checks
 * it from the clone's own records (a worktree git dir under <common>/worktrees naming <path>/.git), never trusting <path>/.git.
 */
export function isolationProblem(clone: string, path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return 'it is not a folder';
  } catch {
    return 'it is not a readable folder';
  }
  if (samePath(clone, path)) return 'it is the project clone itself';
  try {
    assertWorktreeIntact(clone, path);
    findAdminDir(clone, path);
  } catch (err) {
    return `it is not a linked worktree root of the clone (${(err as Error).message})`;
  }
  return null;
}

export interface Leased {
  worktree: string;
  baseSha: string;
  gitDir: string;
}

/**
 * A worktree for a build: lease one from treehouse's pool for the task, prove it is isolated from the clone, require it clean, then
 * start it from origin's tip (or from `from`, a commit the clone has, for a task that follows another), never from the clone's
 * checkout, and create the task's branch there. Refuses rather than launching from a stale or unknown base. A slot that is dirty or
 * not isolated stays leased, named in the error, for the Boss to inspect; any other failure returns it to the pool.
 */
export function leaseWorktree(clone: string, taskId: string, branch: string, env: NodeJS.ProcessEnv, from?: string): Leased {
  if (run('git', ['-C', clone, 'rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0) {
    throw new Error(`${clone} has no commit yet (unborn HEAD), so there is nothing to branch a worktree from. Make one commit in the project's origin, then spawn again.`);
  }
  const help = runTreehouse(['get', '--help'], clone, env);
  if (!/--lease\b/.test(`${help.stdout}${help.stderr}`)) throw new Error(`This treehouse cannot lease a worktree (its "get --help" has no --lease): update treehouse. It said: ${said(help).slice(0, 300)}`);
  const got = runTreehouse(['get', '--lease', '--lease-holder', taskId, '--json'], clone, env);
  if (got.error || got.status !== 0) throw new Error(`treehouse get --lease failed for ${taskId} in ${clone}: ${said(got)}`);
  const worktree = leasedPath(got.stdout);
  if (!worktree) throw new Error(`treehouse get --lease did not report a worktree for ${taskId}`);
  const keep = (why: string) => new Error(`${why}. The worktree stays leased to ${taskId}; once inspected, release it with: treehouse return --force "${worktree}" (from ${clone}).`);
  const isolation = isolationProblem(clone, worktree);
  if (isolation) throw keep(`treehouse did not yield an isolated worktree (${worktree}: ${isolation}); refusing to launch, so the clone is never tangled`);
  const gitDir = findAdminDir(clone, worktree);
  const wt = (args: string[], timeoutMs?: number) => worktreeRun(clone, worktree, args, { gitDir, ...(timeoutMs ? { timeoutMs } : {}) });
  const status = wt(['-c', 'core.quotePath=false', 'status', '--porcelain']);
  if (status.status !== 0) throw keep(`Could not inspect the pooled worktree ${worktree}: ${said(status)}`);
  if (status.stdout.trim()) throw keep(`The pooled worktree ${worktree} is not clean; refusing to discard uncommitted work while refreshing its base`);
  try {
    let target: string;
    if (from) {
      target = from;
    } else {
      const fail = (what: string, r: RunResult) => new Error(`${what} for the pooled worktree ${worktree}; refusing to launch from a potentially stale base: ${said(r)}`);
      const fetched = wt(['fetch', '--quiet', 'origin'], TOOL_TIMEOUT_MS);
      if (fetched.error || fetched.status !== 0) throw fail('Could not fetch origin', fetched);
      const head = wt(['remote', 'set-head', 'origin', '--auto'], TOOL_TIMEOUT_MS);
      if (head.status !== 0) throw fail("Could not resolve origin's current default branch", head);
      const def = wt(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '');
      if (!def) throw new Error(`Could not determine origin's default branch for the pooled worktree ${worktree}; refusing to launch from a potentially stale base`);
      const ref = wt(['fetch', '--quiet', 'origin', `+refs/heads/${def}:refs/remotes/origin/${def}`], TOOL_TIMEOUT_MS);
      if (ref.error || ref.status !== 0) throw fail(`Could not fetch origin/${def}`, ref);
      target = `origin/${def}`;
    }
    const expected = wt(['rev-parse', '--verify', '--quiet', `${target}^{commit}`]).stdout.trim();
    if (!expected) throw new Error(`${target} is not a commit in ${clone}; refusing to launch`);
    const reset = wt(['reset', '--hard', '--quiet', expected]);
    if (reset.status !== 0) throw new Error(`Could not reset the pooled worktree ${worktree} to ${target}: ${said(reset)}`);
    const actual = wt(['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
    if (actual !== expected) throw new Error(`The pooled worktree ${worktree} is at ${actual || 'unknown'}, not ${target} (${expected}); refusing to launch`);
    const made = wt(['checkout', '--quiet', '-b', branch]);
    if (made.status !== 0) throw new Error(`Could not create branch ${branch} in ${worktree}: ${said(made)}`);
    return { worktree, baseSha: expected, gitDir };
  } catch (err) {
    returnWorktree(clone, worktree, env, gitDir);
    throw err;
  }
}

/**
 * Give a task's worktree back to treehouse's pool. The branch is detached first, so it stays in the clone but no worktree holds it
 * (pruning and deleting it work); a worktree whose .git was tampered with is returned without running git in it. Throws when
 * treehouse refuses.
 */
export function returnWorktree(clone: string, worktree: string, env: NodeJS.ProcessEnv, gitDir?: string): void {
  if (!existsSync(worktree)) return;
  try {
    assertWorktreeIntact(clone, worktree, gitDir);
  } catch {
    // A crew member pointed .git at a git dir of its own: every git command run there (treehouse's reset and clean too) could
    // start a program named in that dir's config. Delete the folder without running git in it (rmSync does not follow links),
    // and let the clone forget the worktree; treehouse's pool loses that slot.
    rmSync(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    run('git', ['-C', clone, 'worktree', 'prune']);
    return;
  }
  const detached = worktreeRun(clone, worktree, ['checkout', '--quiet', '--detach'], { gitDir });
  if (detached.status !== 0) throw new Error(`Could not detach ${worktree} from its branch before returning it: ${said(detached)}`);
  const r = runTreehouse(['return', '--force', worktree], clone, env);
  if (r.error || r.status !== 0) throw new Error(`treehouse return --force ${worktree} failed: ${said(r)}`);
}
