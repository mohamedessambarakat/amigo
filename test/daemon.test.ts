import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { describeEnsure, ensureDaemon, openPipelineBuilds, quoteWinArg, readDaemon } from '../src/nmdaemon.ts';
import { claimTaskDir, saveTask, type Task } from '../src/tasks.ts';
import { scan } from '../src/watch.ts';
import { codeRoot } from '../src/paths.ts';
import { cleanup, cli, makeHome } from './helpers.ts';

/** A home whose no-mistakes is test/fake-no-mistakes.mjs with its daemon in `state`, and a temporary NM_HOME. */
function nmHome(state: string, extra: NodeJS.ProcessEnv = {}) {
  const { dir, env } = makeHome();
  const stateFile = join(dir, 'nm-state');
  const log = join(dir, 'nm.log');
  writeFileSync(stateFile, state);
  const e: NodeJS.ProcessEnv = {
    ...env,
    AMIGO_NO_MISTAKES: join(codeRoot, 'test', 'fake-no-mistakes.mjs'),
    FAKE_NM_STATE: stateFile,
    FAKE_NM_LOG: log,
    AMIGO_NM_STATUS_TIMEOUT_MS: '2000',
    AMIGO_NM_START_WAIT_MS: '20000',
    AMIGO_NM_DAEMON_SECS: '0',
    AMIGO_NM_RETRY_SECS: '0',
    ...extra,
  };
  const calls = (): { args: string[]; nmHome: string | null }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const starts = () => calls().filter((c) => c.args[0] === 'daemon' && c.args[1] !== 'status');
  return { dir, env: e, stateFile, calls, starts, state: () => readFileSync(stateFile, 'utf8').trim() };
}

function build(env: NodeJS.ProcessEnv, id: string, patch: Partial<Task> = {}): void {
  const now = new Date().toISOString();
  assert.ok(claimTaskDir(id, env));
  saveTask({ id, title: id, project: '(scratch)', agent: 'fake', cwd: '.', repo: null, worktree: null, branch: null, baseSha: null, status: 'done', createdAt: now, updatedAt: now, startedAt: now, runs: 1, followUps: [], seen: true, mode: 'no-mistakes', ...patch }, env);
}

describe('no-mistakes daemon', () => {
  it('reads only positive evidence as down: a timeout or unknown output is never down', () => {
    for (const [state, want] of [['up', 'up'], ['down', 'down'], ['refused', 'down'], ['garbled', 'unknown']] as const) {
      const h = nmHome(state);
      try {
        assert.equal(readDaemon(h.env)?.state, want, state);
      } finally {
        cleanup(h.dir);
      }
    }
    const h = nmHome('hang', { AMIGO_NM_STATUS_TIMEOUT_MS: '500' });
    try {
      const r = readDaemon(h.env);
      assert.equal(r?.state, 'unknown');
      assert.match(r?.detail ?? '', /timed out/);
    } finally {
      cleanup(h.dir);
    }
  });

  it('starts a down daemon detached, in the home NM_HOME, and never stops or restarts one', () => {
    const h = nmHome('refused');
    try {
      const r = ensureDaemon(h.env);
      assert.equal(r.action, 'started', JSON.stringify(r));
      assert.equal(h.state(), 'up');
      assert.deepEqual(h.starts().map((c) => c.args.join(' ')), ['daemon start']);
      assert.ok(h.calls().every((c) => c.nmHome === h.env.NM_HOME), 'every call sees the temporary NM_HOME');
      assert.match(describeEnsure(r, []), /was down \(.*actively refused.*\); amigo started it again/);
    } finally {
      cleanup(h.dir);
    }
  });

  it('leaves a live daemon and an unreadable one alone', () => {
    for (const [state, extra] of [['up', {}], ['hang', { AMIGO_NM_STATUS_TIMEOUT_MS: '500' }], ['garbled', {}]] as const) {
      const h = nmHome(state, extra);
      try {
        const r = ensureDaemon(h.env);
        assert.equal(r.action, 'none', state);
        assert.deepEqual(h.starts(), [], `${state}: no start, stop or restart`);
        if (state === 'hang') assert.match(describeEnsure(r, []), /unknown.*left alone - a timeout is not evidence/);
      } finally {
        cleanup(h.dir);
      }
    }
  });

  it('the watcher restarts a down daemon only while open no-mistakes builds use it, and wakes amigo to steer them', () => {
    const h = nmHome('down');
    try {
      build(h.env, 'lo1', { mode: 'local-only' });
      build(h.env, 'nm0', { status: 'closed' });
      assert.deepEqual(scan(h.env), [], 'no open no-mistakes build: the daemon is not even read');
      assert.deepEqual(h.calls(), []);

      build(h.env, 'nm1');
      assert.deepEqual(openPipelineBuilds(h.env).map((t) => t.id), ['nm1']);
      const wakes = scan(h.env).filter((w) => w.key === 'daemon:no-mistakes');
      assert.equal(wakes.length, 1);
      assert.match(wakes[0]!.reason, /^check: no-mistakes daemon was down .* amigo started it again .*\(nm1\) to reattach: `no-mistakes axi run`/);
      assert.equal(h.state(), 'up');
      assert.deepEqual(scan(h.env).filter((w) => w.key === 'daemon:no-mistakes'), [], 'a running daemon wakes nobody');
      assert.equal(h.starts().length, 1);
    } finally {
      cleanup(h.dir);
    }
  });

  it('a failed start wakes once per episode and is retried quietly', () => {
    const h = nmHome('down', { FAKE_NM_START_FAILS: '1', AMIGO_NM_START_WAIT_MS: '1000' });
    try {
      build(h.env, 'nm1');
      const first = scan(h.env).filter((w) => w.key === 'daemon:no-mistakes');
      assert.equal(first.length, 1);
      assert.match(first[0]!.reason, /could not start it: .*Open no-mistakes builds stranded: nm1\. Tell the Boss\./);
      assert.deepEqual(scan(h.env).filter((w) => w.key === 'daemon:no-mistakes'), []);
      assert.equal(h.starts().length, 2, 'retried');
    } finally {
      cleanup(h.dir);
    }
  });

  it('amigo daemon reports and starts through the same path', () => {
    const h = nmHome('down');
    try {
      const r = cli(h.env, ['daemon']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /amigo started it again/);
      assert.match(cli(h.env, ['daemon']).out, /daemon is running \(daemon running \(pid 4242\)\)/);
    } finally {
      cleanup(h.dir);
    }
  });

  it('quotes Windows command-line arguments', () => {
    assert.equal(quoteWinArg('plain'), 'plain');
    assert.equal(quoteWinArg('C:\\Program Files\\x.exe'), '"C:\\Program Files\\x.exe"');
    assert.equal(quoteWinArg('a "b"'), '"a \\"b\\""');
    assert.equal(quoteWinArg('dir with space\\'), '"dir with space\\\\"');
    assert.equal(quoteWinArg(''), '""');
  });
});
