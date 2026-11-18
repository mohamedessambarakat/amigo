import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cliPath, home } from '../src/paths.ts';
import { getTask } from '../src/tasks.ts';
import { cleanup, cli, fakeAgent, git, idFrom, makeHome, makeRepo, waitFor } from './helpers.ts';

describe('end to end with a fake agent', () => {
  it('code project: spawn, inbox, follow-up, review, close --commit', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'my app'));
      assert.equal(cli(env, ['add', repo]).code, 0);
      assert.match(cli(env, ['projects']).out, /my-app .*git, worktree per arm/);

      const spawned = cli(env, ['spawn', '--project', 'my-app'], 'Title: Write the file\nMODE:question\nDone when: arm-output.txt exists');
      assert.equal(spawned.code, 0, spawned.err);
      const id = idFrom(spawned.out);
      const asked = await waitFor(id, env, ['question', 'done', 'failed']);
      assert.equal(asked.status, 'question');
      assert.equal(asked.summary, 'which color?');

      assert.match(cli(env, ['inbox']).out, new RegExp(`${id}  question`));
      assert.equal(cli(env, ['inbox']).out.trim(), 'Inbox empty.', 'inbox shows each result once');

      const answer = join(dir, 'answer.md');
      writeFileSync(answer, 'use blue');
      assert.equal(cli(env, ['send', id, '--file', answer]).code, 0);
      const done = await waitFor(id, env, ['done', 'failed']);
      assert.equal(done.status, 'done');
      assert.equal(done.runs, 2);
      const wt = done.worktree as string;
      assert.equal(readFileSync(join(wt, 'arm-output.txt'), 'utf8'), 'follow-up handled\n');
      assert.ok(!existsSync(join(repo, 'arm-output.txt')), 'the main checkout is untouched');
      assert.match(cli(env, ['status', id]).out, /arm-output\.txt/);

      const review = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review it\ncheck the file').out);
      assert.equal((await waitFor(review, env, ['done', 'failed'])).summary, 'looks good');
      const blocked = cli(env, ['close', id, '--commit']);
      assert.equal(blocked.code, 1);
      assert.match(blocked.err, /Close the review first/);
      assert.equal(cli(env, ['close', review]).code, 0);

      const closed = cli(env, ['close', id, '--commit', '-m', 'add arm output']);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Committed \w+ to branch octomaxxing\//);
      assert.ok(!existsSync(wt), 'worktree removed');
      assert.equal(git(repo, 'log', '-1', '--format=%s', `octomaxxing/${id}`).trim(), 'add arm output');
      assert.equal(git(repo, 'show', '--name-only', '--format=', `octomaxxing/${id}`).trim(), 'arm-output.txt');
      assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'nothing merged');
    } finally {
      cleanup(dir);
    }
  });

  it('queues while RAM is short and starts the next arm when one finishes', async () => {
    const { dir, env } = makeHome(1);
    try {
      for (const name of ['one', 'two']) {
        mkdirSync(join(dir, name));
        cli(env, ['add', join(dir, name)]);
      }
      const a = idFrom(cli(env, ['spawn', '--project', 'one'], 'Title: one\nMODE:sleep').out);
      const second = cli(env, ['spawn', '--project', 'two'], 'Title: two\nMODE:sleep');
      assert.match(second.out, /^Queued/);
      const b = idFrom(second.out);
      assert.equal(getTask(b, env)?.status, 'queued');
      await waitFor(a, env, ['done']);
      await waitFor(b, env, ['done']);
      assert.ok(existsSync(join(dir, 'one', 'arm-output.txt')), 'non-git projects are worked on in place');
      assert.match(cli(env, ['close', a, '--commit']).out, /in place/);
    } finally {
      cleanup(dir);
    }
  });

  it('runs one arm at a time in a non-git folder', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'shared');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const a = idFrom(cli(env, ['spawn', '--project', 'shared'], 'Title: one\nMODE:sleep').out);
      const b = idFrom(cli(env, ['spawn', '--project', 'shared'], 'Title: two').out);
      assert.equal(getTask(b, env)?.status, 'queued', 'waits although arms are free');
      await waitFor(a, env, ['done']);
      await waitFor(b, env, ['done']);
    } finally {
      cleanup(dir);
    }
  });

  it('records failures, refuses to drop changes, and cleans up an unused branch', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const bad = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: break\nMODE:fail').out);
      const failed = await waitFor(bad, env, ['failed', 'done']);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.exitCode, 3);
      assert.equal(cli(env, ['close', bad]).code, 0);
      assert.equal(git(repo, 'branch', '--list', `octomaxxing/${bad}`).trim(), '', 'a branch with no commits is removed');

      const good = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: write').out);
      await waitFor(good, env, ['done']);
      const refused = cli(env, ['close', good]);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /1 changed files/);
      assert.equal(getTask(good, env)?.status, 'done', 'a refused close puts the task back');
      assert.equal(cli(env, ['close', good, '--force']).code, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to commit when the arm left its branch, and keeps the work', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: wander\nMODE:switch').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      const r = cli(env, ['close', id, '--commit']);
      assert.equal(r.code, 1);
      assert.match(r.err, /refs\/heads\/elsewhere, not octomaxxing\//);
      assert.equal(getTask(id, env)?.status, 'done');
      assert.ok(existsSync(join(t.worktree as string, 'arm-output.txt')), 'the work is still there');
    } finally {
      cleanup(dir);
    }
  });

  it('arms cannot manage tasks; the head brief carries the agent and the greeting', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const id = idFrom(cli({ ...env, CLI_PATH: cliPath }, ['spawn', '--project', 'p'], 'Title: sneaky\nMODE:manage').out);
      assert.match((await waitFor(id, env, ['done'])).summary ?? '', /manage exit 1: octomaxxing: You are running inside arm/);
      const brief = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /You run as the "fake" agent\. Pass `--agent fake`/);
      assert.match(brief.out, /🐙 .+\n1 project · 0 arms running · \d+ MB free · inbox: \S+/);
    } finally {
      cleanup(dir);
    }
  });

  it('dry runs write nothing and show the command', () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const r = cli(env, ['spawn', '--project', 'repo', '--dry-run'], 'Title: try');
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /DRY RUN[\s\S]*new worktree[\s\S]*fake-agent\.mjs/);
      assert.ok(!existsSync(join(home(env), 'tasks')) || readdirSync(join(home(env), 'tasks')).length === 0);
      assert.match(cli(env, ['head', '--dry-run']).out, /would start the head \(fake\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('first run creates the home folder and says what to do next', () => {
    const { dir, env } = makeHome();
    try {
      const fresh = { ...env, OCTOMAXXING_HOME: join(dir, 'fresh') };
      const r = cli(fresh, ['help']);
      assert.match(r.err, /Created .*fresh/);
      assert.match(r.out, /No agent configured yet/);
      assert.ok(existsSync(join(dir, 'fresh', 'config.json')) && existsSync(join(dir, 'fresh', 'projects.json')));
      assert.match(cli(fresh, ['spawn', '--project', 'x'], 'Title: t').err, /No agent configured yet/);

      const untouched = { ...env, OCTOMAXXING_HOME: join(dir, 'never'), HOME: join(dir, 'user'), USERPROFILE: join(dir, 'user') };
      assert.match(cli(untouched, ['install-skill', '--remove']).out, /Nothing to remove/);
      assert.ok(!existsSync(join(dir, 'never')), 'removing skills never creates the data folder');
    } finally {
      cleanup(dir);
    }
  });

  it('runs the head with the greeting in its prompt', () => {
    const { dir, env } = makeHome();
    try {
      writeFileSync(join(home(env), 'config.json'), JSON.stringify({ agents: { fake: { head: [process.execPath, fakeAgent, 'MODE:head {prompt}'], arm: [process.execPath, fakeAgent, '{prompt}'] } } }));
      const r = cli(env, ['head']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /🐙 .+\n0 projects · 0 arms running · \d+ MB free · inbox: empty/);
    } finally {
      cleanup(dir);
    }
  });

  it('starts Windows .cmd agents through a prompt file', { skip: process.platform !== 'win32' }, async () => {
    const { dir, env } = makeHome();
    const shim = join(dir, 'agent.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n`);
    writeFileSync(join(home(env), 'config.json'), JSON.stringify({ agents: { fake: { arm: [shim, '{prompt}'] } } }));
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const id = idFrom(cli(env, ['spawn', '--project', 'p'], 'Title: via cmd\nquotes " and 100% are fine here').out);
      assert.equal((await waitFor(id, env, ['done', 'failed'])).status, 'done');
      assert.equal(readFileSync(join(folder, 'arm-output.txt'), 'utf8'), 'pointer=true\n');
    } finally {
      cleanup(dir);
    }
  });
});
