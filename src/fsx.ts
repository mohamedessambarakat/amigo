import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

/** Write via a temp file + rename so readers never see a half-written file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // On Windows the rename can fail briefly while another process has the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 8) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run fn while holding a lock file (ported from fm-lock-lib: fail safe). The lock records its holder's pid and a token. It
 * is taken over only when its holder is proven dead: the pid is gone, or the pid now belongs to a process that started
 * after the lock was written (a reused pid). A live holder keeps the lock however long it runs; a lock whose pid cannot be
 * read (a crash mid-write) is taken over once older than staleMs. Waiting gives up after waitMs. The finally block
 * removes the lock only while it still carries this holder's token.
 */
export function withLock<T>(lockPath: string, fn: () => T, staleMs = 60_000, waitMs = staleMs + 5_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  const token = `${process.pid} ${Math.random().toString(36).slice(2, 12)}`;
  let checkedReuse = '';
  for (;;) {
    try {
      writeFileSync(lockPath, token, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const held = readFileSync(lockPath, 'utf8');
        const holder = Number(held.split(' ')[0]);
        const written = statSync(lockPath).mtimeMs;
        let dead = false;
        if (!(Number.isInteger(holder) && holder > 0)) dead = Date.now() - written > staleMs;
        else if (!pidAlive(holder)) dead = true;
        else if (Date.now() - written > staleMs && checkedReuse !== held) {
          // A lock held this long may name a pid reused by an unrelated process: check its start time once per lock.
          checkedReuse = held;
          const since = processStartMs(holder);
          dead = since !== null && since > written + 2_000;
        }
        if (dead && readFileSync(lockPath, 'utf8') === held) rmSync(lockPath, { force: true });
      } catch {
        // the lock vanished between checks; retry
      }
      if (Date.now() - started > waitMs) throw new Error(`Timed out waiting for lock ${lockPath}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true });
    } catch {
      // already gone
    }
  }
}

/** When process `pid` started, in epoch ms; null when it cannot be read (which never counts as proof of death). */
export function processStartMs(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + (ticks / 100) * 1000 : null;
    }
    const r =
      platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
        : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 });
    const ms = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
