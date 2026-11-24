import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cliPath, codeRoot, home } from '../src/paths.ts';
import { getTask } from '../src/tasks.ts';
import { branchOf, cleanup, cli, cloneOf, fakeAgent, git, idFrom, makeHome, makeRepo, releaseHeld, tmpDir, waitFor, waitForTabExit } from './helpers.ts';

describe('end to end with a fake agent', () => {
  it('local-only build: spawn, question, inbox message, relaunch, review, merge on the Boss word, landed cleanup', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'my app'));
      assert.equal(cli(env, ['add', repo, '--mode', 'local-only']).code, 0);
      assert.match(cli(env, ['projects']).out, /my-app  \[local-only\]  .*projects[\\/]my-app  \(clone, from /);

      const spawned = cli(env, ['spawn', '--project', 'my-app'], 'Title: Write the file\nMODE:question\nDone when: member-output.txt exists');
      assert.equal(spawned.code, 0, spawned.err);
      assert.match(spawned.out, /deliver: local-only/);
      const id = idFrom(spawned.out);
      const brief = readFileSync(join(home(env), 'data', id, 'brief.md'), 'utf8');
      assert.match(brief, /^Delivery contract: mode=local-only$/m);
      assert.match(brief, /^Build branch: feat\/write-the-file$/m);
      const asked = await waitFor(id, env, ['question', 'done', 'failed']);
      assert.equal(asked.status, 'question');
      assert.equal(asked.summary, 'which color?');

      assert.match(cli(env, ['inbox']).out, new RegExp(`${id}  question`));
      assert.equal(cli(env, ['inbox']).out.trim(), 'Inbox empty.', 'inbox shows each result once');

      // send is the data plane: a durable inbox record. Once the run-once agent's tab has exited, nothing is rung.
      await waitForTabExit(id, env);
      const answer = join(dir, 'answer.md');
      writeFileSync(answer, 'use blue');
      const sent = cli(env, ['send', id, '--file', answer]);
      assert.equal(sent.code, 0, sent.err);
      assert.match(sent.out, /Recorded for/);
      assert.match(sent.out, /Did not ring/);
      const inboxDir = join(home(env), 'state', 'tasks', id, 'inbox');
      assert.match(readFileSync(join(inboxDir, '001.msg'), 'utf8'), /^schema=amigo-task-inbox\.v1\n[\s\S]*\n--\nuse blue\n$/);
      assert.match(cli(env, ['status', id]).out, /inbox:\s+1 message not acknowledged \(oldest 001\.msg\)/);
      assert.equal(getTask(id, env)?.status, 'question', 'send does not restart anything');

      // control is the lifecycle plane: relaunch runs the agent again with the note.
      assert.equal(cli(env, ['control', id, 'relaunch']).code, 1, 'relaunch needs a note');
      const relaunched = cli(env, ['control', id, 'relaunch', '--note', 'use blue, then read your inbox']);
      assert.equal(relaunched.code, 0, relaunched.err);
      const done = await waitFor(id, env, ['done', 'failed', 'blocked']);
      assert.equal(done.status, 'done', done.summary);
      assert.equal(done.runs, 2);
      assert.equal(done.summary, 'ready in branch feat/write-the-file');
      const wt = done.worktree as string;
      const clone = cloneOf(env, 'my-app');
      assert.equal(readFileSync(join(wt, 'member-output.txt'), 'utf8'), 'follow-up handled\n');
      assert.equal(done.localDoneHead, git(clone, 'rev-parse', branchOf(env, id)).trim(), 'the ready head is latched');
      assert.ok(!existsSync(join(clone, 'member-output.txt')), 'the clone is untouched until the merge');
      assert.match(readFileSync(join(home(env), 'state', 'tasks', id, 'status'), 'utf8'), /^done \[at=\d+\]: ready in branch /m);

      const review = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review it\ncheck the file').out);
      assert.equal((await waitFor(review, env, ['done', 'failed'])).summary, 'PASS - looks good');
      const blocked = cli(env, ['close', id]);
      assert.equal(blocked.code, 1);
      assert.match(blocked.err, /Close the review first/);
      assert.equal(cli(env, ['close', review]).code, 0);

      const notYolo = cli(env, ['merge', id]);
      assert.equal(notYolo.code, 1);
      assert.match(notYolo.err, /merges only when the Boss says "merge it"/);
      const merged = cli(env, ['merge', id, '--boss']);
      assert.equal(merged.code, 0, merged.err);
      assert.match(merged.out, /merged feat\/write-the-file into local main/);
      assert.match(merged.out, /Landed: .* is in the local main/);
      assert.match(merged.out, new RegExp(`Closed ${id}\\.`));
      assert.equal(git(clone, 'rev-parse', 'main').trim(), done.localDoneHead);
      assert.equal(readFileSync(join(clone, 'member-output.txt'), 'utf8').replace(/\r\n/g, '\n'), 'follow-up handled\n', 'the clone checkout followed the fast-forward');
      assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'the worktree went back to the pool, off the branch');
      const after = getTask(id, env)!;
      assert.equal(after.status, 'closed');
      assert.equal(after.merge?.authority, 'boss');
      assert.equal(git(repo, 'branch', '--list', branchOf(env, id)).trim(), '', 'nothing was pushed to the source');
    } finally {
      cleanup(dir);
    }
  });

  it('queues while memory is short and starts the next crew member when one finishes', async () => {
    const { dir, env } = makeHome(1);
    try {
      for (const name of ['one', 'two']) cli(env, ['add', makeRepo(join(dir, name))]);
      const a = idFrom(cli(env, ['spawn', '--project', 'one'], 'Title: one\nMODE:hold').out);
      const second = cli(env, ['spawn', '--project', 'two'], 'Title: two\nMODE:hold');
      assert.match(second.out, /^Queued/);
      const b = idFrom(second.out);
      assert.equal(getTask(b, env)?.status, 'queued');
      releaseHeld(env);
      await waitFor(a, env, ['done']);
      await waitFor(b, env, ['done']);
      assert.ok(existsSync(join(getTask(a, env)!.worktree as string, 'member-output.txt')), 'each works in its own worktree');
    } finally {
      releaseHeld(env);
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
      assert.equal(git(cloneOf(env, 'repo'), 'branch', '--list', branchOf(env, bad)).trim(), '', 'a branch with no commits is removed');

      const good = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: write').out);
      await waitFor(good, env, ['done']);
      const refused = cli(env, ['close', good]);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /its work has not landed \(\w+ is on no remote branch/);
      assert.equal(getTask(good, env)?.status, 'done', 'a refused close puts the task back');
      assert.equal(cli(env, ['close', good, '--force']).code, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses a ready report when the crew member left its branch, and keeps the work', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo, '--mode', 'local-only']);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: wander\nMODE:switch').out);
      const t = await waitFor(id, env, ['done', 'failed', 'blocked']);
      assert.equal(t.status, 'blocked');
      assert.match(t.summary ?? '', /done refused: your HEAD \w+ is not your branch feat\/wander/);
      assert.equal(t.localDoneHead, undefined, 'no ready head was latched');
      assert.match(cli(env, ['merge', id, '--boss']).err, /has no accepted done head/);
      assert.ok(existsSync(join(t.worktree as string, 'member-output.txt')), 'the work is still there');
      assert.match(cli(env, ['close', id]).err, /has not landed/);
    } finally {
      cleanup(dir);
    }
  });

  it('crew members cannot manage tasks; amigo brief carries the agent and the briefing', async () => {
    const { dir, env } = makeHome();
    try {
      cli(env, ['add', makeRepo(join(dir, 'p'))]);
      const id = idFrom(cli({ ...env, CLI_PATH: cliPath }, ['spawn', '--project', 'p'], 'Title: sneaky\nMODE:manage').out);
      const summary = (await waitFor(id, env, ['done'])).summary ?? '';
      assert.match(summary, /manage exit 1: amigo: You are running inside crew member/);
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
      assert.match(r.out, /DRY RUN[\s\S]*leased from treehouse, on new branch feat\/try \(from origin's tip\)[\s\S]*fake-agent\.mjs/);
      assert.ok(!existsSync(join(home(env), 'state', 'tasks')) || readdirSync(join(home(env), 'state', 'tasks')).length === 0);
      assert.match(cli(env, ['--dry-run']).out, /would start amigo \(fake\)/);

      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', 'fix', '--dry-run'], 'Title: Fix sidebar alignment').out, /on new branch fix\/sidebar-alignment /);
      // A taken name, locally or on origin, gets the next free suffix.
      git(cloneOf(env, 'repo'), 'branch', 'feat/try');
      git(cloneOf(env, 'repo'), 'update-ref', 'refs/remotes/origin/feat/try-2', 'HEAD');
      assert.match(cli(env, ['spawn', '--project', 'repo', '--dry-run'], 'Title: try').out, /on new branch feat\/try-3 /);
      // origin is asked as it is now, not as the clone last fetched it; and git cannot keep docs/x beside a branch named docs.
      git(repo, 'branch', 'fix/fresh');
      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', 'fix', '--dry-run'], 'Title: fresh').out, /on new branch fix\/fresh-2 /);
      git(repo, 'branch', 'fix/nested/old');
      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', 'fix', '--dry-run'], 'Title: nested').out, /on new branch fix\/nested-2 /);
      git(cloneOf(env, 'repo'), 'branch', 'docs');
      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', 'docs', '--dry-run'], 'Title: readme').err, /has a branch named "docs", so git cannot make docs\/readme beside it/);
      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', '', '--dry-run'], 'Title: try').err, /A build needs --type feat\|fix\|/);
      assert.match(cli(env, ['spawn', '--project', 'repo', '--type', 'bugfix', '--dry-run'], 'Title: try').err, /A build needs --type/);
      assert.match(cli(env, ['spawn', '--scratch', '--type', 'fix', '--dry-run'], 'Title: try').err, /--type names a build's branch/);
    } finally {
      cleanup(dir);
    }
  });

  it('runs from inside a crew member: AMIGO_* in the parent environment do not leak into a test', async () => {
    const outside = tmpDir();
    const member = { AMIGO_TASK: 'x-1', AMIGO_HOME: join(outside, 'member-home'), AMIGO_TERMINAL: 'herdr-app', AMIGO_FREE_MB: '1' };
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
      assert.equal(cli(env, ['add', makeRepo(join(dir, 'p'))]).code, 0);
      const r = cli(env, ['spawn', '--project', 'p'], 'Title: inside');
      assert.equal(r.code, 0, r.err);
      await waitFor(idFrom(r.out), env, ['done']);
      assert.ok(!existsSync(member.AMIGO_HOME), "the crew member's home is never touched");
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
      assert.ok(existsSync(join(dir, 'fresh', 'config', 'config.json')) && existsSync(join(dir, 'fresh', 'data', 'projects.json')));
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
      // A stand-in Claude Code that exits at once: the briefing goes into the prompt file it is started with.
      const win = process.platform === 'win32';
      const claude = join(dir, win ? 'claude.cmd' : 'claude');
      writeFileSync(claude, win ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(home(env), 'config', 'config.json'), JSON.stringify({ agents: { fake: { amigo: [claude, '{prompt}'], member: [process.execPath, fakeAgent, '{prompt}'] } } }));
      const r = cli(env, []);
      assert.equal(r.code, 0, r.err);
      const prompt = readFileSync(join(home(env), 'state', 'amigo-prompt.md'), 'utf8');
      assert.match(prompt, /0 projects registered\.\nNothing finished, nothing waiting on you, nothing open\./);
    } finally {
      cleanup(dir);
    }
  });

  it('starts Windows .cmd agents through a prompt file', { skip: process.platform !== 'win32' }, async () => {
    const { dir, env } = makeHome();
    const shim = join(dir, 'agent.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n`);
    writeFileSync(join(home(env), 'config', 'config.json'), JSON.stringify({ agents: { fake: { member: [shim, '{prompt}'] } } }));
    try {
      cli(env, ['add', makeRepo(join(dir, 'p'))]);
      const id = idFrom(cli(env, ['spawn', '--project', 'p'], 'Title: via cmd\nquotes " and 100% are fine here').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      assert.equal(t.status, 'done');
      assert.equal(readFileSync(join(t.worktree as string, 'member-output.txt'), 'utf8'), 'pointer=true\n');
    } finally {
      cleanup(dir);
    }
  });

  it("starts a Claude crew member as its own session and keeps a failed launch's stderr in output.log", async () => {
    const { dir, env } = makeHome();
    const fakeClaude = join(codeRoot, 'test', 'fake-claude.mjs');
    const win = process.platform === 'win32';
    const shim = join(dir, win ? 'claude.cmd' : 'claude');
    writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${fakeClaude}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(home(env), 'config', 'config.json'), JSON.stringify({ agents: { claude: { member: [shim, '{prompt}'] } } }));
    try {
      cli(env, ['add', makeRepo(join(dir, 'p'))]);
      // spawn runs in amigo's shell, which carries amigo session's variables.
      const id = idFrom(cli({ ...env, CLAUDE_CODE_SESSION_ID: 'head-session', CLAUDECODE: '1' }, ['spawn', '--project', 'p'], 'Title: resume').out);
      const t = await waitFor(id, env, ['failed', 'done']);
      assert.equal(t.status, 'failed');
      assert.match(t.summary ?? '', /^The session ended in the middle of a turn \(exit 1\): No conversation found with session ID: [0-9a-f-]{36}$/);
      const log = readFileSync(join(home(env), 'state', 'tasks', id, 'output.log'), 'utf8');
      assert.match(log, /No conversation found with session ID/);
      assert.doesNotMatch(log, /inherited/, 'the crew member does not inherit amigo session');
    } finally {
      cleanup(dir);
    }
  });
});
