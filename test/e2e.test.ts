import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cliPath, codeRoot, home } from '../src/paths.ts';
import { getTask } from '../src/tasks.ts';
import { cleanup, cli, fakeAgent, git, idFrom, makeHome, makeRepo, tmpDir, waitFor } from './helpers.ts';

describe('end to end with a fake agent', () => {
  it('code project: spawn, inbox, follow-up, review, close --commit', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'my app'));
      assert.equal(cli(env, ['add', repo]).code, 0);
      assert.match(cli(env, ['projects']).out, /my-app .*git, worktree per squad member/);

      const spawned = cli(env, ['spawn', '--project', 'my-app'], 'Title: Write the file\nMODE:question\nDone when: member-output.txt exists');
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
      assert.equal(readFileSync(join(wt, 'member-output.txt'), 'utf8'), 'follow-up handled\n');
      assert.ok(!existsSync(join(repo, 'member-output.txt')), 'the main checkout is untouched');
      assert.match(cli(env, ['status', id]).out, /member-output\.txt/);

      const review = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review it\ncheck the file').out);
      assert.equal((await waitFor(review, env, ['done', 'failed'])).summary, 'PASS - looks good');
      const blocked = cli(env, ['close', id, '--commit']);
      assert.equal(blocked.code, 1);
      assert.match(blocked.err, /Close the review first/);
      assert.equal(cli(env, ['close', review]).code, 0);

      const closed = cli(env, ['close', id, '--commit', '-m', 'add squad member output']);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Committed \w+ to branch amigo\//);
      assert.ok(!existsSync(wt), 'worktree removed');
      assert.equal(git(repo, 'log', '-1', '--format=%s', `amigo/${id}`).trim(), 'add squad member output');
      assert.equal(git(repo, 'show', '--name-only', '--format=', `amigo/${id}`).trim(), 'member-output.txt');
      assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'nothing merged');
    } finally {
      cleanup(dir);
    }
  });

  it('queues while memory is short and starts the next squad member when one finishes', async () => {
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
      assert.ok(existsSync(join(dir, 'one', 'member-output.txt')), 'non-git projects are worked on in place');
      assert.match(cli(env, ['close', a, '--commit']).out, /in place/);
    } finally {
      cleanup(dir);
    }
  });

  it('runs one squad member at a time in a non-git folder', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'shared');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const a = idFrom(cli(env, ['spawn', '--project', 'shared'], 'Title: one\nMODE:sleep').out);
      const b = idFrom(cli(env, ['spawn', '--project', 'shared'], 'Title: two').out);
      assert.equal(getTask(b, env)?.status, 'queued', 'waits although squad members are free');
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
      assert.equal(git(repo, 'branch', '--list', `amigo/${bad}`).trim(), '', 'a branch with no commits is removed');

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

  it('refuses to commit when the squad member left its branch, and keeps the work', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: wander\nMODE:switch').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      const r = cli(env, ['close', id, '--commit']);
      assert.equal(r.code, 1);
      assert.match(r.err, /refs\/heads\/elsewhere, not amigo\//);
      assert.equal(getTask(id, env)?.status, 'done');
      assert.ok(existsSync(join(t.worktree as string, 'member-output.txt')), 'the work is still there');
    } finally {
      cleanup(dir);
    }
  });

  it('squad members cannot manage tasks; amigo brief carries the agent and the briefing', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const id = idFrom(cli({ ...env, CLI_PATH: cliPath }, ['spawn', '--project', 'p'], 'Title: sneaky\nMODE:manage').out);
      const summary = (await waitFor(id, env, ['done'])).summary ?? '';
      assert.match(summary, /manage exit 1: amigo: You are running inside squad member/);
      assert.match(summary, /inbox exit 1/);
      const brief = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /You run as the "fake" agent\. Pass `--agent fake`/);
      assert.match(brief.out, /## Briefing[\s\S]*1 project registered\./);
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
      assert.match(cli(env, ['--dry-run']).out, /would start amigo \(fake\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('runs from inside a squad member: AMIGO_* in the parent environment do not leak into a test', async () => {
    const outside = tmpDir();
    const member = { AMIGO_TASK: 'x-1', AMIGO_HOME: join(outside, 'member-home'), AMIGO_TERMINAL: 'wt', AMIGO_FREE_MB: '1' };
    const saved = Object.fromEntries(Object.keys(member).map((k) => [k, process.env[k]]));
    Object.assign(process.env, member);
    const { dir, env } = makeHome();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      assert.equal(env.AMIGO_TASK, undefined);
      assert.equal(env.AMIGO_TERMINAL, 'test');
      const folder = join(dir, 'p');
      mkdirSync(folder);
      assert.equal(cli(env, ['add', folder]).code, 0);
      const r = cli(env, ['spawn', '--project', 'p'], 'Title: inside');
      assert.equal(r.code, 0, r.err);
      await waitFor(idFrom(r.out), env, ['done']);
      assert.ok(!existsSync(member.AMIGO_HOME), "the squad member's home is never touched");
    } finally {
      cleanup(dir);
      cleanup(outside);
    }
  });

  it('first run creates the home folder and says what to do next', () => {
    const { dir, env } = makeHome();
    try {
      const fresh = { ...env, AMIGO_HOME: join(dir, 'fresh') };
      const help = cli(fresh, ['help']);
      assert.match(help.out, /No agent configured yet/);
      assert.ok(!existsSync(join(dir, 'fresh')), 'help never creates the data folder: that could pre-empt the one-time migration');
      const r = cli(fresh, ['projects']);
      assert.match(r.err, /Created .*fresh/);
      assert.ok(existsSync(join(dir, 'fresh', 'config.json')) && existsSync(join(dir, 'fresh', 'projects.json')));
      assert.match(cli(fresh, ['spawn', '--project', 'x'], 'Title: t').err, /No agent configured yet/);

      const untouched = { ...env, AMIGO_HOME: join(dir, 'never'), HOME: join(dir, 'user'), USERPROFILE: join(dir, 'user') };
      assert.match(cli(untouched, ['install-skill', '--remove']).out, /Nothing to remove/);
      assert.ok(!existsSync(join(dir, 'never')), 'removing skills never creates the data folder');
    } finally {
      cleanup(dir);
    }
  });

  it('bare amigo starts the session with the briefing in its prompt', () => {
    const { dir, env } = makeHome();
    try {
      writeFileSync(join(home(env), 'config.json'), JSON.stringify({ agents: { fake: { amigo: [process.execPath, fakeAgent, 'MODE:amigo {prompt}'], member: [process.execPath, fakeAgent, '{prompt}'] } } }));
      const r = cli(env, []);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /0 projects registered\.\nNothing finished, nothing waiting on you, nothing open\./);
    } finally {
      cleanup(dir);
    }
  });

  it('starts Windows .cmd agents through a prompt file', { skip: process.platform !== 'win32' }, async () => {
    const { dir, env } = makeHome();
    const shim = join(dir, 'agent.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n`);
    writeFileSync(join(home(env), 'config.json'), JSON.stringify({ agents: { fake: { member: [shim, '{prompt}'] } } }));
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      const id = idFrom(cli(env, ['spawn', '--project', 'p'], 'Title: via cmd\nquotes " and 100% are fine here').out);
      assert.equal((await waitFor(id, env, ['done', 'failed'])).status, 'done');
      assert.equal(readFileSync(join(folder, 'member-output.txt'), 'utf8'), 'pointer=true\n');
    } finally {
      cleanup(dir);
    }
  });

  it("starts a Claude squad member as its own session and keeps a failed launch's stderr in output.log", async () => {
    const { dir, env } = makeHome();
    const fakeClaude = join(codeRoot, 'test', 'fake-claude.mjs');
    const win = process.platform === 'win32';
    const shim = join(dir, win ? 'claude.cmd' : 'claude');
    writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${fakeClaude}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(home(env), 'config.json'), JSON.stringify({ agents: { claude: { member: [shim, '{prompt}'] } } }));
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      // spawn runs in amigo's shell, which carries amigo session's variables.
      const id = idFrom(cli({ ...env, CLAUDE_CODE_SESSION_ID: 'head-session', CLAUDECODE: '1' }, ['spawn', '--project', 'p'], 'Title: resume').out);
      const t = await waitFor(id, env, ['failed', 'done']);
      assert.equal(t.status, 'failed');
      assert.match(t.summary ?? '', /^The session ended in the middle of a turn \(exit 1\): No conversation found with session ID: [0-9a-f-]{36}$/);
      const log = readFileSync(join(home(env), 'tasks', id, 'output.log'), 'utf8');
      assert.match(log, /No conversation found with session ID/);
      assert.doesNotMatch(log, /inherited/, 'the squad member does not inherit amigo session');
    } finally {
      cleanup(dir);
    }
  });
});
