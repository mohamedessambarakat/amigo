import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyHook, stopHookSeconds } from '../src/squad.ts';
import { loadProjects } from '../src/config.ts';
import { addProject } from '../src/projects.ts';
import { getTask, saveTask } from '../src/tasks.ts';
import { runCheck } from '../src/verify.ts';
import { cleanup, cli, git, idFrom, makeHome, makeRepo, makeRepoWithChecks, releaseChecks, waitFor } from './helpers.ts';

describe('verification gates', () => {
  it('a failing check sends the squad member a follow-up with its output, and the task shows verifying meanwhile', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepoWithChecks(join(dir, 'repo'));
      assert.equal(cli(env, ['add', repo, '--check', 'node needs-follow-up.mjs']).code, 0);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Write the file').out);

      await waitFor(id, env, ['verifying']);
      assert.match(cli(env, ['status', id]).out, /^\S+\s+verifying /m);
      assert.match(cli(env, ['status']).out, /verifying \(1\)/);
      releaseChecks(repo);

      const done = await waitFor(id, env, ['done', 'blocked', 'failed']);
      assert.equal(done.status, 'done');
      assert.equal(done.runs, 2, 'the squad member ran again for the fix');
      assert.equal(done.followUps.length, 1);
      assert.match(done.followUps[0] as string, /`node needs-follow-up\.mjs` \(exit 1\)/);
      assert.match(done.followUps[0] as string, /CHECK-FAIL-MARKER: the follow-up was not handled yet/);
      assert.equal(done.verification?.state, 'passed');
      assert.match(cli(env, ['status', id]).out, /checks:\s+passed \(1 of 1 checks\)/);
      assert.match(cli(env, ['inbox']).out, /checks: passed/);
    } finally {
      cleanup(dir);
    }
  });

  it('after two failed retries the task is blocked and its summary names the failing check', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepoWithChecks(join(dir, 'repo'));
      cli(env, ['add', repo, '--check', 'node ok.mjs', '--check', 'node fail.mjs']);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Never good enough').out);
      const t = await waitFor(id, env, ['blocked', 'done', 'failed']);
      assert.equal(t.status, 'blocked');
      assert.equal(t.runs, 3, 'one run and two automatic retries');
      assert.equal(t.followUps.length, 2);
      assert.match(t.summary ?? '', /^Check failed after 2 automatic retries: node fail\.mjs \(exit 1\): ALWAYS-FAILS marker$/);
      assert.equal(t.verification?.state, 'failed');
      assert.match(cli(env, ['inbox']).out, /blocked[\s\S]*Check failed after 2 automatic retries/);
      assert.match(cli(env, ['status']).out, /waiting on you \(1\)[\s\S]*blocked/);
    } finally {
      cleanup(dir);
    }
  });

  it('a project without checks shows finished work as unverified', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepoWithChecks(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: No checks here').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      assert.equal(t.status, 'done');
      assert.equal(t.verification?.state, 'unverified');
      assert.match(cli(env, ['status', id]).out, /checks:\s+unverified/);
      assert.match(cli(env, ['status']).out, /waiting on you[\s\S]*done, checks unverified/);
      assert.match(cli(env, ['inbox']).out, /checks: unverified/);
    } finally {
      cleanup(dir);
    }
  });

  it('a Claude squad member is sent back in its own session by the Stop hook, then blocked after two retries', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      writeFileSync(join(folder, 'fail.mjs'), "console.error('boom-from-check');\nprocess.exit(1);\n");
      git(folder, 'init', '-q', '-b', 'main');
      git(folder, 'add', '.');
      git(folder, 'commit', '-q', '-m', 'init');
      addProject(folder, { checks: ['node fail.mjs'] }, env);
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'state', 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: folder, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      const stop = async () => await applyHook('stop', { last_assistant_message: 'STATUS: done - all good' }, 'x-1', env);

      for (const retry of [1, 2]) {
        const blocked = JSON.parse(await stop());
        assert.equal(blocked.decision, 'block');
        assert.match(blocked.reason, /`node fail\.mjs` \(exit 1\):\nboom-from-check/);
        assert.match(blocked.reason, new RegExp(`automatic retry ${retry} of 2`));
        assert.equal(getTask('x-1', env)?.status, 'running', 'the session carries on');
      }
      assert.equal(await stop(), '', 'no third retry: the hook lets the squad member stop');
      const t = getTask('x-1', env);
      assert.equal(t?.status, 'blocked');
      assert.match(t?.summary ?? '', /Check failed after 2 automatic retries: node fail\.mjs \(exit 1\): boom-from-check/);
      assert.equal(t?.seen, false);
    } finally {
      cleanup(dir);
    }
  });

  it('a stuck check is killed at the time limit and counts as failed', async () => {
    const r = await runCheck('node -e "setTimeout(function(){},30000)"', process.cwd(), 700);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    const ok = await runCheck('node -e "console.log(1)"', process.cwd(), 20_000);
    assert.deepEqual([ok.ok, ok.exitCode, ok.output], [true, 0, '1']);
  });

  it('add sets checks, and adding the same project again updates only what is given', () => {
    const { dir, env } = makeHome();
    try {
      const folder = makeRepo(join(dir, 'p'));
      cli(env, ['add', folder, '--notes', 'be careful', '--check', 'npm test', '--check', 'npm run lint', '--risky', 'legacy/**']);
      assert.deepEqual(loadProjects(env)[0]?.checks, ['npm test', 'npm run lint']);
      const again = cli(env, ['add', folder, '--check', 'make test']);
      assert.match(again.out, /^Updated p/);
      const p = loadProjects(env)[0];
      assert.deepEqual([p?.notes, p?.checks, p?.risky], ['be careful', ['make test'], ['legacy/**']], 'checks replaced, notes and risky kept');
      cli(env, ['add', folder, '--check', '']);
      assert.equal(loadProjects(env)[0]?.checks, undefined, 'an empty --check clears the list');
      const clash = cli(env, ['add', makeRepo(join(dir, 'other')), '--name', 'p']);
      assert.equal(clash.code, 1);
      assert.match(clash.err, /already exists, cloned from/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Stop hook timeout', () => {
  it('covers checks added after the squad member started: at least 10 checks at their time limit', () => {
    assert.equal(stopHookSeconds(0, 10), 10 * 10 * 60 + 60, 'no checks yet, but some may be added while the session is open');
    assert.equal(stopHookSeconds(2, 10), stopHookSeconds(0, 10));
    assert.equal(stopHookSeconds(12, 5), 12 * 5 * 60 + 60, 'more checks than the allowance');
  });
});
