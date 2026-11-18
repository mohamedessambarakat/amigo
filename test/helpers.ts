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

/** An arm's tab process can still be finishing (and holding the folder on Windows) just after its task reports. */
export function cleanup(dir: string): void {
  for (let waited = 0; ; waited += 250) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (err) {
      if (waited > 30_000 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/**
 * A home with the fake agent configured. Never the user's real ~/.octomaxxing or ~/.claude.json. Arm tabs open as
 * detached processes (OCTOMAXXING_TERMINAL=test). With arms > 0, free RAM is faked so exactly that many arms fit.
 */
export function makeHome(arms = 0, arm: string[] = [process.execPath, fakeAgent, '{prompt}']): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpDir();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { fake: { head: [process.execPath, fakeAgent, '{prompt}'], arm } }, armMb: arms ? 100 : 0, reserveMb: 0 }));
  const env: NodeJS.ProcessEnv = { ...process.env, OCTOMAXXING_HOME: home, OCTOMAXXING_TERMINAL: 'test', OCTOMAXXING_CLAUDE_JSON: join(dir, 'claude.json'), OCTOMAXXING_FREE_MB: String(arms ? arms * 100 + 50 : 4096) };
  return { dir, env };
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
