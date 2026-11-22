import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sessionDigest } from '../src/digest.ts';
import { acquireSessionLock, controlRefusal, identity, lockState } from '../src/session.ts';
import { amigoHooks, autoArm, turnEndGuard } from '../src/supervise.ts';
import { beat, claimTaskDir, mutateTask, saveTask, type Task } from '../src/tasks.ts';
import { terminalBackend } from '../src/terminal.ts';
import { ackWakes, appendWake, drainWakes, queuePath, readQueue, takeRecovery } from '../src/wakes.ts';
import { declaredWait, registerCheck, scan, statusLogFile, supervisionNeed, watchCycle, watcherHealthy } from '../src/watch.ts';
import { cleanup, cli, idFrom, makeHome, waitFor } from './helpers.ts';

/** Fast watcher settings for tests: no signal linger, short polls. */
const fast = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...withoutSession(env), AMIGO_POLL_SECS: '0.1', AMIGO_SIGNAL_GRACE_SECS: '0', AMIGO_GUARD_SYNC_WAIT_MS: '200', AMIGO_NO_MISTAKES: 'missing-nm', AMIGO_TASKS_AXI: 'missing-axi', AMIGO_GH: 'missing-gh' });

/** The environment without the Claude session this test run may itself be inside: a plain terminal. */
const withoutSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)));

/** A live process that is not this one: another "Claude session". Killed by the caller. */
const otherProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

/** Session identity variables: this test process plays the Claude session `s1`. */
const asSession = (env: NodeJS.ProcessEnv, pid = process.pid, session = 's1'): NodeJS.ProcessEnv => ({ ...env, CLAUDE_PID: String(pid), CLAUDE_CODE_SESSION_ID: session });

/** A task record written directly, for classification tests that need no real crew member. */
function fakeTask(env: NodeJS.ProcessEnv, id: string, patch: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const t: Task = {
    id, title: id, project: '(scratch)', agent: 'fake', cwd: '.', repo: null, worktree: null, branch: null, baseSha: null,
    status: 'running', createdAt: now, updatedAt: now, startedAt: now, runs: 1, followUps: [], seen: true, ...patch,
  };
  assert.ok(claimTaskDir(id, env));
  saveTask(t, env);
  return t;
}

describe('wake queue', () => {
  it('consumes by sequence, closes the episode by generation, and announces queued wakes once', () => {
    const { dir, env } = makeHome();
    try {
      appendWake('signal', 'task:1', 'signal: 1 done: a', env);
      appendWake('signal', 'task:1', 'signal: 1 done: b', env);
      assert.match(takeRecovery(env) ?? '', /^recovery: 2 queued wake/);
      assert.equal(takeRecovery(env), null, 'a generation is announced at most once');
      const d = drainWakes(env);
      assert.equal(d.rows.length, 2);
      // A wake arriving after the drain is newer: the old acknowledgement consumes only what it saw.
      appendWake('check', 'check:x', 'check: x: hello', env);
      assert.match(ackWakes(d.through, d.generation, env), /Newer wakes arrived/);
      assert.deepEqual(readQueue(env).rows.map((r) => r.reason), ['check: x: hello']);
      assert.match(ackWakes(d.through, d.generation, env), /Acknowledged nothing.*--through 3/);
      const d2 = drainWakes(env);
      assert.match(ackWakes(d2.through, d2.generation, env), /queue is empty/);
      assert.equal(takeRecovery(env), null);
    } finally {
      cleanup(dir);
    }
  });

  it('keeps an unreadable queue aside and says so', () => {
    const { dir, env } = makeHome();
    try {
      appendWake('signal', 'k', 'signal: x', env);
      writeFileSync(queuePath(env), '{ not json');
      const q = readQueue(env);
      assert.equal(q.rows.length, 1);
      assert.match(q.rows[0]!.reason, /could not be read.*unreadable-/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('session lock', () => {
  it('one session controls the home; another live session is read-only; a dead owner is reclaimed', () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    const other = otherProcess();
    try {
      const me = identity(asSession(env));
      assert.equal(acquireSessionLock(env, me).result, 'acquired');
      assert.equal(acquireSessionLock(env, me).result, 'reanchored');
      const them = identity(asSession(env, other.pid!, 's2'));
      assert.equal(acquireSessionLock(env, them).result, 'held');
      assert.equal(lockState(env, them).state, 'foreign');
      // The Boss at a plain terminal is never locked out; another Claude session is.
      assert.equal(controlRefusal(env), null);
      assert.match(controlRefusal(asSession(env, other.pid!, 's2')) ?? '', /read-only: another amigo session/);
      const refused = cli(asSession(env, other.pid!, 's2'), ['wake', 'drain']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /read-only/);
      assert.equal(cli(asSession(env, other.pid!, 's2'), ['wake', 'status']).code, 0, 'looking is allowed');
      // The other session takes over once the owner is gone.
      const dead = identity(asSession(env, 999_999_99, 's0'));
      rmSync(join(env.AMIGO_HOME!, 'state', 'session.lock'));
      writeFileSync(join(env.AMIGO_HOME!, 'state', 'session.lock'), JSON.stringify({ pid: dead.pid, started: null, session: 's0', at: 'x', home: env.AMIGO_HOME }));
      assert.equal(acquireSessionLock(env, them).result, 'reclaimed');
    } finally {
      other.kill();
      cleanup(dir);
    }
  });
});

describe('watcher classification', () => {
  it('a finished turn amigo has not read wakes it once, as a queued signal', async () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch', '--agent', 'fake'], 'Title: Quick\nDone when: it reports').out);
      await waitFor(id, env, ['done']);
      const r = await watchCycle(env);
      assert.equal(r.kind, 'reason');
      assert.match(r.text, new RegExp(`^signal: ${id} done`));
      assert.equal(readQueue(env).rows.length, 1);
      assert.ok(!existsSync(join(env.AMIGO_HOME!, 'state', 'watch.lock')), 'the watcher lets go of its lock');
      // Nothing new: the same finish is not surfaced again; the unread result only comes back as a backing-off heartbeat.
      const hbEnv = { ...env, AMIGO_HEARTBEAT_SECS: '0' };
      assert.deepEqual(scan(hbEnv), []);
      const hb = scan(hbEnv);
      assert.match(hb[0]?.reason ?? '', /^heartbeat: 1 result\(s\) still unread/);
    } finally {
      cleanup(dir);
    }
  });

  it('a crew member making no progress raises "stopped responding", unless it declared a wait', () => {
    const { dir, env: base } = makeHome();
    const env = { ...fast(base), AMIGO_STALE_UNKNOWN_SECS: '60', AMIGO_STALE_ESCALATE_SECS: '30' };
    try {
      fakeTask(env, '1-quiet');
      fakeTask(env, '2-waits');
      beat('1-quiet', env);
      beat('2-waits', env);
      writeFileSync(statusLogFile('2-waits', env), `working: started\npaused: CI on PR 7 until ${new Date(Date.now() + 3_600_000).toISOString()}\n`);
      assert.equal(declaredWait('2-waits', env)?.what, 'CI on PR 7');
      const later = Date.now() + 120_000;
      const wakes = scan(env, later);
      assert.equal(wakes.length, 1);
      assert.match(wakes[0]!.reason, /^stale: 1-quiet \(stopped responding: no progress for \d+s, agent state unknown without reporting, escalation 1\)/);
      assert.deepEqual(scan(env, later + 1000), [], 'one stale episode is not re-surfaced every poll');
      assert.match(scan(env, later + 31_000)[0]?.reason ?? '', /escalation 2/);
      assert.match(scan(env, later + 62_000)[0]?.reason ?? '', /escalation 3, demand-deep-inspection/);
      // Progress ends the episode.
      mutateTask('1-quiet', () => ({ summary: 'busy' }), env);
      assert.deepEqual(scan(env), []);
    } finally {
      cleanup(dir);
    }
  });

  it('a crew member whose tab is killed mid-turn raises "stopped responding" and keeps its work', async () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch', '--agent', 'fake'], 'Title: Held\nMODE:hold\nDone when: released').out);
      const t = await waitFor(id, env, ['running']);
      for (let i = 0; i < 100 && !mutateTask(id, () => null, env).endpoint; i++) await new Promise((r) => setTimeout(r, 100));
      terminalBackend(env).close(mutateTask(id, () => null, env).endpoint!);
      // The tab's heartbeat lapses and it has run past its startup grace.
      rmSync(join(env.AMIGO_HOME!, 'state', 'tasks', id, 'heartbeat'), { force: true });
      mutateTask(id, () => ({ startedAt: new Date(Date.now() - 120_000).toISOString() }), env);
      const wakes = scan(env);
      assert.equal(wakes.length, 1);
      assert.match(wakes[0]!.reason, new RegExp(`^stale: ${id} \\(stopped responding: .*worktree and commits are kept`));
      assert.ok(existsSync(t.cwd), 'its folder is kept');
      const digest = sessionDigest(asSession(env));
      assert.match(digest, new RegExp(`RECOVER ${id}: it stopped responding`));
      assert.match(digest, /Recovery rules/);
    } finally {
      writeFileSync(`${base.AMIGO_HOME}.release-held`, '');
      cleanup(dir);
    }
  });

  it('a registered check that prints something wakes amigo', async () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    try {
      registerCheck({ name: 'pr-7', argv: [process.execPath, '-e', 'console.log("PR 7 merged")'] }, env);
      registerCheck({ name: 'quiet', argv: [process.execPath, '-e', ''] }, env);
      assert.deepEqual(supervisionNeed(env), ['2 registered check(s)']);
      const r = await watchCycle(env);
      assert.equal(r.text, 'check: pr-7: PR 7 merged');
    } finally {
      cleanup(dir);
    }
  });
});

describe('Stop hooks', () => {
  it('settings register the guard, the async auto-arm and the session-start digest', () => {
    const h = amigoHooks() as { Stop: { hooks: { command: string; asyncRewake?: boolean }[] }[]; StopFailure: unknown[]; SessionStart: unknown[] };
    const stop = h.Stop[0]!.hooks;
    assert.match(stop[0]!.command, /_amigo-hook guard$/);
    assert.match(stop[1]!.command, /_amigo-hook stop$/);
    assert.equal(stop[1]!.asyncRewake, true);
    assert.ok(h.StopFailure.length && h.SessionStart.length);
  });

  it('the auto-arm wakes the owning session with the reason; any other session stays silent', async () => {
    const { dir, env: base } = makeHome();
    const env = asSession(fast(base));
    try {
      fakeTask(env, '1-done', { status: 'done', summary: 'shipped', seen: false });
      assert.deepEqual(await autoArm({ session_id: 's1' }, env, 'stop'), { code: 0 }, 'no session lock: inert');
      acquireSessionLock(env, identity(env));
      assert.deepEqual(await autoArm({ session_id: 's9' }, { ...env, CLAUDE_PID: '1' , CLAUDE_CODE_SESSION_ID: 's9' }, 'stop'), { code: 0 }, 'not the owner');
      const r = await autoArm({ session_id: 's1' }, env, 'stop');
      assert.equal(r.code, 2);
      assert.match(r.stderr ?? '', /signal: 1-done done: shipped/);
      assert.match(r.stderr ?? '', /amigo wake drain/);
    } finally {
      cleanup(dir);
    }
  });

  it('the guard blocks a blind turn end a bounded number of times, then fails open with a queued wake', async () => {
    const { dir, env: base } = makeHome();
    const env: NodeJS.ProcessEnv = { ...asSession(fast(base)), AMIGO_GUARD_BLOCKS: '2' };
    try {
      assert.equal((await turnEndGuard({ session_id: 's1' }, env)).code, 0, 'nothing open: the turn may end');
      fakeTask(env, '1-run');
      acquireSessionLock(env, identity(env));
      const first = await turnEndGuard({ session_id: 's1' }, env);
      assert.equal(first.code, 2);
      assert.match(first.stderr ?? '', /do not end the turn blind/);
      assert.equal((await turnEndGuard({ session_id: 's1' }, env)).code, 2);
      assert.equal((await turnEndGuard({ session_id: 's1' }, env)).code, 0, 'past the budget it fails open');
      assert.match(readQueue(env).rows.at(-1)?.reason ?? '', /turn-end guard failed open/);
      // A healthy watcher lets the turn end.
      writeFileSync(join(env.AMIGO_HOME!, 'state', 'watch.lock'), JSON.stringify({ pid: process.pid, token: 't', started: null, startedAt: new Date().toISOString() }));
      writeFileSync(join(env.AMIGO_HOME!, 'state', 'watcher-beat'), '1');
      assert.ok(watcherHealthy(env));
      assert.equal((await turnEndGuard({ session_id: 's1' }, env)).code, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe('session-start digest', () => {
  it('takes the lock, drains the queue with its ack command, runs once per session, and is read-only for a second session', () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    const other = otherProcess();
    try {
      appendWake('signal', 'task:1', 'signal: 1 done: shipped', env);
      mkdirSync(join(env.AMIGO_HOME!, 'data'), { recursive: true });
      writeFileSync(join(env.AMIGO_HOME!, 'data', 'boss.md'), 'Likes short answers.\n');
      const d = sessionDigest(asSession(env), { once: true });
      assert.match(d, /^LOCK: this session controls/);
      assert.match(d, /BOOTSTRAP \(detect only[\s\S]*no-mistakes is not installed/);
      assert.match(d, /\[1\] signal: 1 done: shipped\nWAKE_ACK_REQUIRED: amigo wake ack --through 1 --generation 1/);
      assert.match(d, /SUPERVISION/);
      assert.match(d, /NETWORK CHECKS: GitHub auth/);
      assert.match(d, /Likes short answers\./);
      assert.match(d, /learnings\.md: ABSENT/);
      assert.match(sessionDigest(asSession(env), { once: true }), /already ran in this session/);
      const ro = sessionDigest(asSession(env, other.pid!, 's2'), { once: true });
      assert.match(ro, /LOCK: READ-ONLY\. Another amigo session controls/);
      assert.match(ro, /WAKE QUEUE: not drained/);
      assert.match(ro, /NETWORK CHECKS: none/);
      assert.equal(readFileSync(join(env.AMIGO_HOME!, 'state', 'session.lock'), 'utf8').includes(`"pid": ${process.pid}`), true);
    } finally {
      other.kill();
      cleanup(dir);
    }
  });

  it('a new session after amigo closed mid-task takes over, reconciles the task and resumes supervision through the real hooks', () => {
    const { dir, env: base } = makeHome();
    const env = fast(base);
    try {
      fakeTask(env, '1-build', { status: 'done', summary: 'PR opened', seen: false });
      appendWake('signal', 'task:1-build', 'signal: 1-build done: PR opened', env);
      // The old session held the lock and is gone.
      writeFileSync(join(env.AMIGO_HOME!, 'state', 'session.lock'), JSON.stringify({ pid: 999_999_99, started: null, session: 'old', at: 'x', home: env.AMIGO_HOME }));
      const fresh = asSession(env, process.pid, 'new');
      const start = cli(fresh, ['_amigo-hook', 'session-start'], JSON.stringify({ session_id: 'new', source: 'startup' }));
      assert.equal(start.code, 0, start.err);
      assert.match(start.out, /taken over from a session that is gone/);
      assert.match(start.out, /signal: 1-build done: PR opened\r?\nWAKE_ACK_REQUIRED/);
      assert.match(start.out, /- 1-build \[\(scratch\)\] done/);
      const ack = /WAKE_ACK_REQUIRED: amigo wake (ack .*)/.exec(start.out)![1]!.split(' ');
      // The background network worker (no gh here) may add a newer wake meanwhile: only what was drained is consumed.
      assert.match(cli(fresh, ['wake', ...ack]).out, /Acknowledged 1 wake/);
      // The task is still unread, so the next turn end arms the watcher and the backstop wakes the session.
      const stop = cli({ ...fresh, AMIGO_HEARTBEAT_SECS: '0' }, ['_amigo-hook', 'stop'], JSON.stringify({ session_id: 'new' }));
      assert.equal(stop.code, 2, stop.err);
      // Whichever comes first: the backstop for the unread result, or the background network worker's problem (no gh here).
      assert.match(stop.err, /heartbeat: 1 result\(s\) still unread \(1-build\)|recovery: 1 queued wake\(s\) not yet handled \(newest: check: session-start network checks: gh is not installed\)/);
    } finally {
      cleanup(dir);
    }
  });
});
