import os from 'node:os';
import { run } from './proc.ts';

/** macOS: available memory is free + inactive + speculative pages (os.freemem() counts only "free" and undercounts badly). */
export function parseVmStat(out: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(out)?.[1]);
  const total = pages('free') + pages('inactive') + pages('speculative');
  if (!size || !Number.isFinite(total)) return null;
  return Math.floor((total * size) / 1024 / 1024);
}

/** Free memory in MB. AMIGO_FREE_MB overrides the measurement. */
export function freeMemMb(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): number {
  if (env.AMIGO_FREE_MB !== undefined && env.AMIGO_FREE_MB !== '') return Number(env.AMIGO_FREE_MB);
  if (platform === 'darwin') {
    const r = run('vm_stat', []);
    const mb = r.status === 0 ? parseVmStat(r.stdout) : null;
    if (mb !== null) return mb;
  }
  return Math.floor(os.freemem() / 1024 / 1024);
}

/** Start one more crew member only if free memory, minus this crew member and the crew members still starting up, stays at or above the reserve. */
export function ramAllows(freeMb: number, memberMb: number, reserveMb: number, starting: number): boolean {
  return freeMb - (starting + 1) * memberMb >= reserveMb;
}
