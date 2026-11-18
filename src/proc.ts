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
 * Stop an arm's agent and everything it started. Call it only while the arm's tab is known to be alive (fresh heartbeat),
 * so a recycled pid is never hit. On Windows taskkill /T walks the tree; elsewhere the tree comes from `ps` (the agent
 * shares its tab's process group, so signalling a group would also hit the tab's shell).
 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  const pids = [pid, ...descendants(pid, run('ps', ['-A', '-o', 'pid=,ppid=']).stdout)];
  const signal = (sig: NodeJS.Signals | 0): boolean =>
    pids
      .map((p) => {
        try {
          process.kill(p, sig);
          return true;
        } catch {
          return false;
        }
      })
      .some(Boolean);
  if (!signal(0)) return;
  signal('SIGTERM');
  for (let i = 0; i < 20 && signal(0); i++) sleepSync(100);
  signal('SIGKILL');
}

/** Every process below pid, from `ps -A -o pid=,ppid=` output. */
export function descendants(pid: number, psOutput: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || pp === undefined || Number.isNaN(pp)) continue;
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  const out: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length) {
    const p = queue.shift()!;
    if (out.includes(p)) continue;
    out.push(p);
    queue.push(...(children.get(p) ?? []));
  }
  return out;
}
