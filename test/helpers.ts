import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { cliPath, codeRoot, policyPath } from '../src/paths.ts';
import { ensureHome } from '../src/config.ts';
import { storeApproval } from '../src/policy.ts';
import { getTask, type Status, type Task } from '../src/tasks.ts';

export const fakeAgent = join(codeRoot, 'test', 'fake-agent.mjs');

export function tmpDir(prefix = 'amigo-test-'): string {
  // native: the long form of a Windows 8.3 short temp path (C:\Users\RUNNER~1), the form git prints
  return realpathSync.native(mkdtempSync(join(os.tmpdir(), prefix)));
}

/** Runs fn until the folder it touches is free: a squad member's tab process can still be finishing (and holding the folder on Windows) just after its task reports. */
function whenReleased(fn: () => void): void {
  for (let waited = 0; ; waited += 250) {
    try {
      fn();
      return;
    } catch (err) {
      if (waited > 30_000 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

export function cleanup(dir: string): void {
  whenReleased(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
}

/** Rename a home whose last task just reported, once its tab process has let go of it. */
export function moveFolder(from: string, to: string): void {
  whenReleased(() => renameSync(from, to));
}

/**
 * The environment a test starts from: this process's, without any AMIGO_* or GIT_* variable (a git hook sets GIT_DIR and friends, which would point every test git call at the hooked repo). Squad member tabs set
 * AMIGO_TASK and AMIGO_HOME, so `npm test` run inside a squad member would otherwise act as that squad member, on its home.
 * Tests set only what they need on top.
 */
export function cleanEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(from).filter(([k]) => !/^(AMIGO_|GIT_|TREEHOUSE_)/.test(k.toUpperCase())));
}

// Code that falls back to process.env, git and other child processes see the clean environment too.
for (const k of Object.keys(process.env)) if (/^(AMIGO_|GIT_|TREEHOUSE_)/.test(k.toUpperCase())) delete process.env[k];

// Code that falls back to process.env (a function called without an env) must never reach the real ~/.amigo or ~/.claude.json: point it at a throwaway home.
const strayHome = mkdtempSync(join(os.tmpdir(), 'amigo-stray-home-'));
process.env.AMIGO_HOME = strayHome;
process.env.AMIGO_CLAUDE_JSON = join(strayHome, 'claude.json');
process.on('exit', () => rmSync(strayHome, { recursive: true, force: true }));

/**
 * A home with the fake agent configured. Never the user's real ~/.amigo or ~/.claude.json. Squad member tabs open as
 * detached processes (AMIGO_TERMINAL=test). With members > 0, free memory is faked so exactly that many squad members fit.
 */
export function makeHome(members = 0, member: string[] = [process.execPath, fakeAgent, '{prompt}']): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ agents: { fake: { amigo: [process.execPath, fakeAgent, '{prompt}'], member } }, memberMb: members ? 100 : 0, reserveMb: 0 }));
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), AMIGO_HOME: home, AMIGO_TERMINAL: 'test', AMIGO_CLAUDE_JSON: join(dir, 'claude.json'), AMIGO_FREE_MB: String(members ? members * 100 + 50 : 4096), ...fakeTreehouseEnv(dir), AMIGO_TASKS_AXI: fakeTasksAxi };
  return { dir, env };
}

/** The fake tasks-axi (test/fake-tasks-axi.mjs). It only acts once a home keeps a backlog: see startBacklog. */
export const fakeTasksAxi = join(codeRoot, 'test', 'fake-tasks-axi.mjs');

/** Make the home keep a backlog (data/backlog.md exists), so spawn and close move its items. */
export function startBacklog(env: NodeJS.ProcessEnv): void {
  mkdirSync(join(env.AMIGO_HOME as string, 'data'), { recursive: true });
  writeFileSync(join(env.AMIGO_HOME as string, 'data', 'backlog.md'), JSON.stringify({ tasks: [] }));
}

/** The environment for the fake treehouse (test/fake-treehouse.mjs): its pool is the home's own state/worktrees. */
export function fakeTreehouseEnv(dir: string, script = join(codeRoot, 'test', 'fake-treehouse.mjs')): NodeJS.ProcessEnv {
  const win = process.platform === 'win32';
  const shim = join(dir, win ? 'treehouse.cmd' : 'treehouse');
  writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { AMIGO_TREEHOUSE: shim, FAKE_TREEHOUSE_LOG: join(dir, 'treehouse.log') };
}

/** amigo's clone of a registered project. */
export const cloneOf = (env: NodeJS.ProcessEnv, name: string): string => join(env.AMIGO_HOME as string, 'projects', name);

/** The path of a file in a task's runtime folder (state/tasks/<id>). */
export const taskFilePath = (env: NodeJS.ProcessEnv, id: string, file: string): string => join(env.AMIGO_HOME as string, 'state', 'tasks', id, file);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Run the real CLI in a child process. */
export function cli(env: NodeJS.ProcessEnv, args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], { env, input: input ?? '', encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function idFrom(out: string): string {
  const m = /task:\s+(\S+)/.exec(out);
  if (!m) throw new Error(`no task id in: ${out}`);
  return m[1] as string;
}

export async function waitFor(id: string, env: NodeJS.ProcessEnv, statuses: Status[], timeoutMs = 30_000): Promise<Task> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = getTask(id, env);
    if (t && statuses.includes(t.status)) return t;
    if (Date.now() > end) throw new Error(`${id} did not reach ${statuses.join('/')} (now ${t?.status})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A repo with check scripts committed in it: ok.mjs passes, fail.mjs always fails, needs-follow-up.mjs passes once the fake agent handled a follow-up. */
export function makeRepoWithChecks(dir: string): string {
  const repo = makeRepo(dir);
  writeFileSync(join(repo, 'ok.mjs'), '');
  writeFileSync(join(repo, 'fail.mjs'), "console.error('ALWAYS-FAILS marker');\nprocess.exit(1);\n");
  // It holds the task in verifying until the test calls releaseChecks, so a test can look at that state without racing it.
  writeFileSync(
    join(repo, 'needs-follow-up.mjs'),
    `import { existsSync, readFileSync } from 'node:fs';\nwhile (!existsSync(${JSON.stringify(releaseFile(repo))})) await new Promise((r) => setTimeout(r, 50));\n` +
      "const text = readFileSync('member-output.txt', 'utf8');\nif (!text.includes('follow-up handled')) {\n  console.error('CHECK-FAIL-MARKER: the follow-up was not handled yet');\n  process.exit(1);\n}\n",
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'check scripts');
  return repo;
}

const releaseFile = (repo: string): string => `${repo}.release-checks`;

/** Lets needs-follow-up.mjs of a makeRepoWithChecks repo finish, now and on every later run. */
export function releaseChecks(repo: string): void {
  writeFileSync(releaseFile(repo), '');
}

/** Lets every MODE:hold squad member of this home finish, now and on every later start. */
export function releaseHeld(env: NodeJS.ProcessEnv): void {
  writeFileSync(`${env.AMIGO_HOME}.release-held`, '');
}

/** A bare repo to act as origin for `repo`. */
export function addOrigin(dir: string, repo: string): string {
  const bare = join(dir, 'origin.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main'); // the base of every task is on origin's default branch
  return bare;
}

/** The environment for a fake `gh`: calls are logged to the returned file, `gh issue view` answers with `issue`. */
export function fakeGhEnv(dir: string, issue?: object): { env: NodeJS.ProcessEnv; log: string } {
  const script = join(codeRoot, 'test', 'fake-gh.mjs');
  const win = process.platform === 'win32';
  const shim = join(dir, win ? 'gh.cmd' : 'gh');
  writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const log = join(dir, 'gh.log');
  return { env: { AMIGO_GH: shim, FAKE_GH_LOG: log, ...(issue ? { FAKE_GH_ISSUE: JSON.stringify(issue) } : {}) }, log };
}

/** Every call the fake gh logged. */
export function ghCalls(log: string): { cwd: string; args: string[]; body?: string }[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

/** Approve a policy that allows pull requests (what the user does by hand with approve-policy). */
export function allowPrs(env: NodeJS.ProcessEnv, pr: 'after-human-yes' | 'also-self-approved' = 'after-human-yes'): void {
  ensureHome(env);
  const p = JSON.parse(readFileSync(policyPath(env), 'utf8'));
  p.pr = pr;
  writeFileSync(policyPath(env), JSON.stringify(p, null, 2));
  storeApproval(env);
}

/** Point a clone's origin at a new bare repo holding its main (for tests that check what was pushed): returns the bare repo. */
export function repointOrigin(dir: string, clone: string): string {
  const bare = join(dir, 'origin.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(clone, 'push', '-q', bare, 'main');
  git(clone, 'remote', 'set-url', 'origin', bare);
  git(clone, 'fetch', '-q', 'origin');
  return bare;
}
