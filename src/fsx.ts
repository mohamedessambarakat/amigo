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

/** Run fn while holding a lock file. A lock whose holder is gone, or older than staleMs, is taken over. */
export function withLock<T>(lockPath: string, fn: () => T, staleMs = 60_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const holder = Number(readFileSync(lockPath, 'utf8'));
        const old = Date.now() - statSync(lockPath).mtimeMs > staleMs;
        // A just-created lock may not hold its pid yet (holder 0): only an old one or a dead holder is stale.
        if (old || (holder > 0 && !pidAlive(holder))) rmSync(lockPath, { force: true });
      } catch {
        // the lock vanished between checks; retry
      }
      if (Date.now() - started > staleMs + 5_000) throw new Error(`Timed out waiting for lock ${lockPath}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
