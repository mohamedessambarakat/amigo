import { spawnSync } from 'node:child_process';
import { sleepSync } from './fsx.ts';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function run(cmd: string, args: string[]): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function runOrThrow(cmd: string, args: string[]): string {
  const r = run(cmd, args);
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/**
 * Stop an arm: its runner and everything the runner started. Call it only for a runner known to be alive
 * (fresh heartbeat), so a recycled pid is never hit.
 * The runner is spawned detached: on macOS/Linux it leads its own process group; on Windows taskkill /T walks the tree.
 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  const group = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!group(0)) return;
  group('SIGTERM');
  for (let i = 0; i < 20 && group(0); i++) sleepSync(100);
  // The runner may exit on SIGTERM while the agent ignores it: always finish the whole group.
  group('SIGKILL');
}
