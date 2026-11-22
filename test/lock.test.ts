import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { withLock } from '../src/fsx.ts';
import { codeRoot } from '../src/paths.ts';
import { cleanup, tmpDir } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withLock', () => {
  it('never takes a lock over from a live holder, however long it holds it', async () => {
    const dir = tmpDir();
    const lock = join(dir, 'x.lock');
    const log = join(dir, 'log');
    try {
      const fsx = pathToFileURL(join(codeRoot, 'src', 'fsx.ts')).href;
      // Process A holds the lock for 1.5 s with a 300 ms stale age: older than staleMs, but its holder is alive.
      const script = `import { withLock, sleepSync } from ${JSON.stringify(fsx)}; import { appendFileSync } from 'node:fs';
        withLock(${JSON.stringify(lock)}, () => { appendFileSync(${JSON.stringify(log)}, 'A in\\n'); sleepSync(1500); appendFileSync(${JSON.stringify(log)}, 'A out\\n'); }, 300);`;
      const a = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
      const done = new Promise((r) => a.on('exit', r));
      for (let i = 0; i < 100 && !existsSync(log); i++) await sleep(50);
      await sleep(500);
      withLock(lock, () => appendFileSync(log, 'B in\nB out\n'), 300, 10_000);
      await done;
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['A in', 'A out', 'B in', 'B out']);
      assert.ok(!existsSync(lock));
    } finally {
      cleanup(dir);
    }
  });

  it('takes over a lock whose holder is dead, and leaves a lock it no longer holds alone', () => {
    const dir = tmpDir();
    const lock = join(dir, 'x.lock');
    try {
      writeFileSync(lock, '99999999 deadbeef');
      assert.equal(withLock(lock, () => 'got it', 300, 5000), 'got it');
      withLock(lock, () => writeFileSync(lock, `${process.pid} someone-else`));
      assert.equal(readFileSync(lock, 'utf8'), `${process.pid} someone-else`, 'a lock replaced under us is not removed');
    } finally {
      cleanup(dir);
    }
  });
});
