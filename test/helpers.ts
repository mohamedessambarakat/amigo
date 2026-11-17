import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { cliPath, codeRoot } from '../src/paths.ts';
import { getTask, type Status, type Task } from '../src/tasks.ts';

export const fakeAgent = join(codeRoot, 'test', 'fake-agent.mjs');

export function tmpDir(prefix = 'octomaxxing-test-'): string {
  return realpathSync(mkdtempSync(join(os.tmpdir(), prefix)));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** A home with the fake agent configured. Never the user's real ~/.octomaxxing. */
export function makeHome(maxArms = 2, arm: string[] = [process.execPath, fakeAgent, '{prompt}']): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { fake: { head: [process.execPath, fakeAgent, '{prompt}'], arm } }, maxArms }));
  return { dir, env: { ...process.env, OCTOMAXXING_HOME: home } };
}

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
