import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { home } from '../src/paths.ts';
import { clearOrphanRotation, contextTokens, requestRotation, rotateAt, ROTATED_NOTE, rotationStopped, takeRotation } from '../src/rotate.ts';
import { acquireSessionLock, identity, lockState } from '../src/session.ts';
import { autoArm, turnEndGuard } from '../src/supervise.ts';
import { tabEnvArgs } from '../src/squad.ts';
import { appendWake } from '../src/wakes.ts';
import { cleanup, cli, makeHome } from './helpers.ts';

const withoutSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)));
const fast = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...withoutSession(env), AMIGO_POLL_SECS: '0.1', AMIGO_SIGNAL_GRACE_SECS: '0', AMIGO_GUARD_SYNC_WAIT_MS: '200', AMIGO_NO_MISTAKES: 'missing-nm', AMIGO_TASKS_AXI: 'missing-axi', AMIGO_GH: 'missing-gh' });
const MINE = `${process.pid}:mine`;
/** A Claude session started by an amigo command (launcher token MINE unless given). */
const asSession = (env: NodeJS.ProcessEnv, pid = process.pid, session = 's1', launcher: string | undefined = MINE): NodeJS.ProcessEnv => ({
  ...env,
  CLAUDE_PID: String(pid),
  CLAUDE_CODE_SESSION_ID: session,
  ...(launcher ? { AMIGO_LAUNCHER: launcher } : {}),
});
/** Set config.json's rotateAtTokens in the home. */
const rotateAtConfig = (env: NodeJS.ProcessEnv, n: number) => {
  const p = join(home(env), 'config', 'config.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), rotateAtTokens: n }));
};
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
const rotatePath = (env: NodeJS.ProcessEnv) => join(home(env), 'state', 'rotate.json');
const writeRecord = (env: NodeJS.ProcessEnv, launcher: string, stopped = true) => {
  mkdirSync(join(home(env), 'state'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(rotatePath(env), JSON.stringify({ launcher, session: 'x', requestedAt: now, ...(stopped ? { stoppedAt: now } : {}) }));
};

/** A transcript whose newest main-thread model call used `tokens` of context (a later sidechain call must not count). */
function transcript(dir: string, tokens: number): string {
  const path = join(dir, 'session.jsonl');
  const call = (n: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', ...extra, message: { usage: { input_tokens: 2, cache_read_input_tokens: n - 102, cache_creation_input_tokens: 100, output_tokens: 50 } } });
  writeFileSync(path, [call(1000), JSON.stringify({ type: 'user', message: { content: 'hi' } }), call(tokens), call(999_999, { isSidechain: true }), JSON.stringify({ type: 'system' }), ''].join('\n'));
  return path;
}

/** A stand-in lead agent: `script` lines run with `state` (the home's state folder) and `n` (1 for the first launch, ...). */
function fakeLead(dir: string, env: NodeJS.ProcessEnv, script: string[]): void {
  const win = process.platform === 'win32';
  const fake = join(dir, 'fake-lead.mjs');
  writeFileSync(
    fake,
    [
      "import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const state = join(process.env.AMIGO_HOME, 'state');",
      "appendFileSync(join(state, 'fake-runs'), 'x');",
      "const n = readFileSync(join(state, 'fake-runs'), 'utf8').length;",
      "copyFileSync(process.argv[process.argv.indexOf('--append-system-prompt-file') + 1], join(state, 'prompt-' + n + '.md'));",
      ...script,
      '',
    ].join('\n'),
  );
  const shim = join(dir, win ? 'claude.cmd' : 'claude');
  writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home(env), 'config', 'config.json'), JSON.stringify({ agents: { claude: { amigo: [shim, '{prompt}'], member: [shim, '{prompt}'] } } }));
}

describe('context rotation', () => {
  it('reads the context size of the newest and the first main-thread model call', () => {
    const { dir } = makeHome();
    try {
      assert.equal(contextTokens(transcript(dir, 130_000)), 130_000);
      assert.equal(contextTokens(transcript(dir, 130_000), 'first'), 1000);
      assert.equal(contextTokens(join(dir, 'missing.jsonl')), null);
      assert.equal(contextTokens(undefined), null);
    } finally {
      cleanup(dir);
    }
  });

  it('the turn-end guard asks once past the rotation point, again after 25K more, and only where a rotation can happen', async () => {
    const { dir, env: base } = makeHome();
    const env = asSession(fast(base));
    try {
      assert.equal(rotateAt(env), 500_000, 'the default');
      rotateAtConfig(env, 120_000);
      acquireSessionLock(env, identity(env));
      assert.equal((await turnEndGuard({ session_id: 's1', transcript_path: transcript(dir, 119_000) }, env)).code, 0, 'below the point');
      const first = await turnEndGuard({ session_id: 's1', transcript_path: transcript(dir, 121_000) }, env);
      assert.equal(first.code, 2);
      assert.match(first.stderr ?? '', /context is at 121K tokens, past the rotation point \(120K\).*\/remember.*amigo rotate/);
      assert.equal((await turnEndGuard({ session_id: 's1', transcript_path: transcript(dir, 140_000) }, env)).code, 0, 'asked already');
      assert.equal((await turnEndGuard({ session_id: 's1', transcript_path: transcript(dir, 146_000) }, env)).code, 2, '25K more: ask again');
      const other = sleeper();
      try {
        const foreign = asSession(fast(base), other.pid!, 's2');
        assert.equal((await turnEndGuard({ session_id: 's2', transcript_path: transcript(dir, 200_000) }, foreign)).code, 0, 'a session without the lock is never asked');
      } finally {
        other.kill();
      }
      // A session an older amigo command started (no launcher token) cannot be restarted, so it is never asked.
      const old = asSession(fast(base), process.pid, 's5', '');
      acquireSessionLock(old, identity(old));
      assert.equal((await turnEndGuard({ session_id: 's5', transcript_path: transcript(dir, 200_000) }, old)).code, 0, 'no launcher');
      // A fresh session whose startup alone passes the point is not asked: it would rotate in a loop.
      const big = join(dir, 'big.jsonl');
      const usage = (n: number) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: n } } });
      writeFileSync(big, [usage(150_000), usage(160_000), ''].join('\n'));
      const fresh = asSession(fast(base), process.pid, 's4');
      acquireSessionLock(fresh, identity(fresh));
      assert.equal((await turnEndGuard({ session_id: 's4', transcript_path: big }, fresh)).code, 0, 'grew only 10K past its start');
      writeFileSync(big, [usage(150_000), usage(171_000), ''].join('\n'));
      assert.equal((await turnEndGuard({ session_id: 's4', transcript_path: big }, fresh)).code, 2, 'grew 21K');
      const off = asSession(fast(base), process.pid, 's3');
      acquireSessionLock(off, identity(off));
      rotateAtConfig(env, 0);
      assert.equal((await turnEndGuard({ session_id: 's3', transcript_path: transcript(dir, 190_000) }, off)).code, 0, '0 turns it off');
    } finally {
      cleanup(dir);
    }
  });

  it("a requested rotation is marked stopped at its own session's turn end, keeps the lock, and restarts exactly once", async () => {
    const { dir, env: base } = makeHome();
    const env = asSession(fast(base));
    try {
      assert.throws(() => requestRotation(identity(env), env), /does not hold the session lock/);
      assert.throws(() => requestRotation(identity(env), { ...env, AMIGO_LAUNCHER: '' }), /started by an amigo command that can restart it/);
      acquireSessionLock(env, identity(env));
      assert.match(requestRotation(identity(env), env), /Rotation set/);
      // A session of another amigo command never marks this rotation.
      await turnEndGuard({ session_id: 'other', transcript_path: transcript(dir, 190_000) }, { ...env, CLAUDE_CODE_SESSION_ID: 'other', AMIGO_LAUNCHER: `${process.pid}:other` });
      assert.equal(rotationStopped(env, MINE), false);
      assert.equal((await turnEndGuard({ session_id: 's1', transcript_path: transcript(dir, 190_000) }, env)).code, 0);
      assert.equal(rotationStopped(env, MINE), true);
      assert.equal(rotationStopped(env, `${process.pid}:other`), false, 'only its own amigo command ends the session');
      assert.equal(lockState(env, identity(env)).state, 'owned', 'the lock is kept: it goes stale when the session ends');
      assert.equal(takeRotation(env, `${process.pid}:other`), false, "another command's record is left alone");
      assert.equal(takeRotation(env, MINE), true);
      assert.equal(takeRotation(env, MINE), false, 'consumed');
      // A rotation that was asked for but never stopped does not restart a later exit.
      requestRotation(identity(env), env);
      assert.equal(takeRotation(env, MINE), false);
    } finally {
      cleanup(dir);
    }
  });

  it('a session stopped for a rotation is not woken by the async Stop hook, and crew tabs never get the launcher token', async () => {
    const { dir, env: base } = makeHome();
    const env = { ...asSession(fast(base)), AMIGO_HEARTBEAT_SECS: '0' };
    try {
      acquireSessionLock(env, identity(env));
      appendWake('signal', 'task:1', 'signal: 1 done: shipped', env);
      writeRecord(env, MINE);
      assert.equal((await autoArm({ session_id: 's1' }, env, 'stop')).code, 0, 'no wake into a session about to be ended');
      assert.ok(!tabEnvArgs(env).some((a) => a.startsWith('AMIGO_LAUNCHER=')));
    } finally {
      cleanup(dir);
    }
  });

  it('a record whose amigo command is gone is dropped; a live one is kept', () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    const live = sleeper();
    try {
      writeRecord(env, '999999991:dead');
      clearOrphanRotation(env);
      assert.equal(existsSync(rotatePath(env)), false);
      writeFileSync(rotatePath(env), JSON.stringify({ session: 'x', requestedAt: 'x', stoppedAt: 'x' }));
      clearOrphanRotation(env);
      assert.equal(existsSync(rotatePath(env)), false, 'a record without a launcher is dropped too');
      writeRecord(env, `${live.pid}:live`);
      clearOrphanRotation(env);
      assert.equal(existsSync(rotatePath(env)), true);
    } finally {
      live.kill();
      cleanup(dir);
    }
  });

  it('the session-start hook prints the full digest again after a compaction', () => {
    const { dir, env: base } = makeHome();
    const env = asSession(fast(base), process.pid, 'c1');
    try {
      const hook = (source: string) => cli(env, ['_amigo-hook', 'session-start'], JSON.stringify({ session_id: 'c1', source }));
      assert.match(hook('startup').out, /^LOCK: this session controls/);
      assert.match(hook('resume').out, /already ran in this session/);
      const compacted = hook('compact').out;
      assert.match(compacted, /^LOCK: this session already controls/);
      assert.match(compacted, /FLEET STATE/);
      assert.match(hook('resume').out, /already ran in this session/, 'still once per session otherwise');
    } finally {
      cleanup(dir);
    }
  });

  it('the amigo command ends its session marked for rotation and starts a fresh one with the rotation briefing', () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    // Run 1 marks its own rotation stopped (as the turn-end guard would) and keeps running: the amigo command must end it.
    fakeLead(dir, env, [
      'if (n === 1) {',
      '  const now = new Date().toISOString();',
      "  writeFileSync(join(state, 'rotate.json'), JSON.stringify({ launcher: process.env.AMIGO_LAUNCHER, session: 's', requestedAt: now, stoppedAt: now }));",
      '  setInterval(() => {}, 1000);',
      '} else process.exit(0);',
    ]);
    try {
      const r = cli(env, []);
      assert.equal(r.code, 0, r.err);
      assert.match(r.err, /starting a fresh session \(context rotation\)/);
      const state = join(home(env), 'state');
      assert.equal(readFileSync(join(state, 'fake-runs'), 'utf8'), 'xx', 'exactly two sessions');
      assert.ok(!readFileSync(join(state, 'prompt-1.md'), 'utf8').includes(ROTATED_NOTE));
      assert.ok(readFileSync(join(state, 'prompt-2.md'), 'utf8').includes(ROTATED_NOTE));
      assert.equal(existsSync(rotatePath(env)), false);
    } finally {
      cleanup(dir);
    }
  });

  it("another amigo command's rotation, live or left over, never ends or restarts this one's session", () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    const live = sleeper();
    // The session lives 1.5s and exits normally: a wrong kill would end it at once with exit 1.
    fakeLead(dir, env, ['setTimeout(() => process.exit(0), 1500);']);
    try {
      writeRecord(env, `${live.pid}:other-terminal`);
      let r = cli(env, []);
      assert.equal(r.code, 0, r.err);
      assert.equal(readFileSync(join(home(env), 'state', 'fake-runs'), 'utf8'), 'x', 'one session, not restarted');
      assert.equal(existsSync(rotatePath(env)), true, "the other terminal's record is left for it");
      writeRecord(env, '999999991:gone');
      r = cli(env, []);
      assert.equal(r.code, 0, r.err);
      assert.equal(readFileSync(join(home(env), 'state', 'fake-runs'), 'utf8'), 'xx', 'a leftover record does not kill a fresh start');
      assert.equal(existsSync(rotatePath(env)), false, 'the leftover is dropped');
    } finally {
      live.kill();
      cleanup(dir);
    }
  });
});
