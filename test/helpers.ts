import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { cliPath, codeRoot } from '../src/paths.ts';
import { getTask, type Status, type Task } from '../src/tasks.ts';
import { terminalBackend } from '../src/terminal.ts';

export const fakeAgent = join(codeRoot, 'test', 'fake-agent.mjs');

export function tmpDir(prefix = 'amigo-test-'): string {
  // native: the long form of a Windows 8.3 short temp path (C:\Users\RUNNER~1), the form git prints
  return realpathSync.native(mkdtempSync(join(os.tmpdir(), prefix)));
}

/** Runs fn until the folder it touches is free: a crew member's tab process can still be finishing (and holding the folder on Windows) just after its task reports. */
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
 * The environment a test starts from: this process's, without any AMIGO_* or GIT_* variable (a git hook sets GIT_DIR and friends, which would point every test git call at the hooked repo). Crew member tabs set
 * AMIGO_TASK and AMIGO_HOME, so `npm test` run inside a crew member would otherwise act as that crew member, on its home.
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

/** A program named claude that runs the fake agent, so a lead template counts as Claude Code. */
function leadShim(dir: string): string {
  const win = process.platform === 'win32';
  const shim = join(dir, win ? 'claude.cmd' : 'claude');
  writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}" "$@"\n`, { mode: 0o755 });
  return shim;
}

/**
 * A home with the fake agent configured. Never the user's real ~/.amigo or ~/.claude.json. Crew member tabs open as
 * detached processes (AMIGO_TERMINAL=test). With members > 0, free memory is faked so exactly that many crew members fit.
 */
export function makeHome(members = 0, member: string[] = [process.execPath, fakeAgent, '{prompt}']): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  // amigo leads only on Claude Code: the fake agent's lead template is a `claude` shim (never run by these tests), its crew members the fake agent.
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ agents: { fake: { amigo: [leadShim(dir), '{prompt}'], member } }, memberMb: members ? 100 : 0, reserveMb: 0 }));
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), AMIGO_LEAD_SESSION: '1', AMIGO_HOME: home, AMIGO_TERMINAL: 'test', AMIGO_CLAUDE_JSON: join(dir, 'claude.json'), AMIGO_FREE_MB: String(members ? members * 100 + 50 : 4096), ...fakeTreehouseEnv(dir), AMIGO_TASKS_AXI: fakeTasksAxi,
    // Never the Boss's no-mistakes or its daemon: no binary by default (test/fake-no-mistakes.mjs where a test needs one), and a temporary NM_HOME.
    AMIGO_NO_MISTAKES: join(dir, 'no-mistakes-not-installed'), NM_HOME: join(dir, 'nm-home') };
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

/**
 * A build's brief in the two sections spawn requires: a leading `Title:` line stays on top, the rest is the Boss's intent (where
 * the fake agent finds its MODE: words). Text that already has the sections is returned as it is.
 */
export function asBuildBrief(text: string): string {
  if (!text.trim() || /^## Boss's intent$/m.test(text)) return text;
  const lines = text.split(/\r?\n/);
  const title = /^title:/i.test(lines[0] ?? '') ? `${lines.shift()}\n` : '';
  return `${title}## Boss's intent\n${lines.join('\n').trim() || 'Do the task in the title.'}\n## amigo spec\nDo what the intent asks; keep it small.\n`;
}

/** Run the real CLI in a child process. A brief piped to a build's spawn (--project, --after or --task, not a survey) is put in the build sections (asBuildBrief). */
export function cli(env: NodeJS.ProcessEnv, args: string[], input?: string): { code: number; out: string; err: string } {
  const build = args[0] === 'spawn' && (args.includes('--project') || args.includes('--after') || args.includes('--task')) && !args.includes('--survey') && !args.includes('--review') && input !== undefined;
  const r = spawnSync(process.execPath, [cliPath, ...args], { env, input: build ? asBuildBrief(input) : (input ?? ''), encoding: 'utf8' });
  lastCli = { args, code: r.status ?? -1, out: r.stdout, err: r.stderr };
  return { code: lastCli.code, out: lastCli.out, err: lastCli.err };
}

/** The last cli call, so a failed idFrom(cli(...).out) can say why the command printed no task id. */
let lastCli: { args: string[]; code: number; out: string; err: string } | null = null;

export function idFrom(out: string): string {
  const m = /task:\s+(\S+)/.exec(out);
  if (!m) {
    const why = lastCli && lastCli.out === out ? ` (amigo ${lastCli.args.join(' ')} exited ${lastCli.code}; stderr: ${lastCli.err.trim() || 'empty'})` : '';
    throw new Error(`no task id in: ${out}${why}`);
  }
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

/**
 * Waits until a crew member's tab process has exited. A run-once crew member reports its status before its tab finishes
 * (the tab still clears its heartbeat and drains the queue), so a reported status alone does not mean the tab is gone.
 */
export async function waitForTabExit(id: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ep = getTask(id, env)?.endpoint;
    if (!ep) throw new Error(`${id} has no terminal`);
    const liveness = terminalBackend(env).state(ep).liveness;
    if (liveness !== 'live') return;
    if (Date.now() > end) throw new Error(`${id}'s tab did not exit (its terminal is ${liveness})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Lets every MODE:hold crew member of this home finish, now and on every later start. */
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
