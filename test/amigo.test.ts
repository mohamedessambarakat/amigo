import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { describe, it } from 'node:test';
import { COMMANDS, HELP } from '../src/cli.ts';
import { confirmGates, gatesConfirmed } from '../src/gates.ts';
import { pushBranch } from '../src/git.ts';
import { legacyBranchName } from '../src/legacy.ts';
import { movePath } from '../src/migrate.ts';
import { codeRoot, home, scratchDir } from '../src/paths.ts';
import { listTasks, getTask, beat, clearBeat } from '../src/tasks.ts';
import { beginNotice, finishNotice, noticesPending, takeNotices, touchNotice } from '../src/notices.ts';
import { moveTrust } from '../src/claude.ts';
import { resolveExecutable } from '../src/command.ts';
import { noticesPath } from '../src/paths.ts';
import { addOrigin, cleanEnv, cleanup, cli, fakeGhEnv, ghCalls, git, idFrom, makeHome, makeRepo, tmpDir, waitFor } from './helpers.ts';

/** Poll the inbox until its text contains `needle` (the live checks run in a detached process). */
async function inboxHas(env: NodeJS.ProcessEnv, needle: RegExp, timeoutMs = 30_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let seen = '';
  for (;;) {
    seen += `${cli(env, ['inbox']).out}\n`;
    if (needle.test(seen)) return seen;
    if (Date.now() > end) throw new Error(`the inbox never showed ${needle}; it showed: ${seen}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('help and the bare command', () => {
  it('--help, -h and help list every command with a description', () => {
    const { dir, env } = makeHome();
    try {
      for (const flag of ['--help', '-h', 'help']) {
        const r = cli(env, [flag]);
        assert.equal(r.code, 0, r.err);
        assert.ok(r.out.startsWith(HELP), `${flag} prints the help text`);
        for (const name of COMMANDS) {
          const line = r.out.split('\n').find((l) => l.startsWith(`  amigo ${name}`));
          assert.ok(line, `${flag}: "${name}" is listed`);
        }
        assert.ok(r.out.split('\n').some((l) => /^ {2}amigo \[--agent <name>\] \[--dry-run\]/.test(l)), 'the bare command is listed');
      }
      assert.doesNotMatch(HELP, /amigo head/);
    } finally {
      cleanup(dir);
    }
  });

  it('every command the dispatch handles is in COMMANDS, and the other way round', () => {
    const source = readFileSync(join(codeRoot, 'src', 'cli.ts'), 'utf8');
    const handled = new Set([...source.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1] as string).filter((n) => n !== '--help' && n !== '-h'));
    for (const name of COMMANDS) assert.ok(handled.has(name), `${name} has a case in cli.ts`);
    for (const name of handled) assert.ok(COMMANDS.includes(name), `${name} is in COMMANDS (so the help lists it)`);
  });

  it('amigo with no command starts the session (--dry-run shows how); the old head command is gone', () => {
    const { dir, env } = makeHome();
    try {
      const bare = cli(env, ['--dry-run']);
      assert.equal(bare.code, 0, bare.err);
      assert.match(bare.out, /DRY RUN: would start amigo \(fake\)/);
      assert.match(cli(env, ['--agent', 'fake', '--dry-run']).out, /would start amigo \(fake\)/);
      assert.equal(cli(env, ['--agent', 'nope', '--dry-run']).code, 1);
      assert.ok(!existsSync(join(home(env), 'tasks')) || readdirSync(join(home(env), 'tasks')).length === 0, 'a dry run starts nothing');
      const old = cli(env, ['head', '--dry-run']);
      assert.equal(old.code, 1);
      assert.match(old.err, /Unknown command "head"/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('scratch workspace', () => {
  it('two scratch squad members run in parallel, each in its own folder, unverified; close keeps the folder', async () => {
    const { dir, env } = makeHome(2);
    try {
      const a = cli(env, ['spawn', '--scratch'], 'Title: First\nMODE:sleep\nDone when: a file exists');
      const b = cli(env, ['spawn', '--scratch'], 'Title: Second\nMODE:sleep\nDone when: a file exists');
      assert.equal(a.code, 0, a.err);
      assert.equal(b.code, 0, b.err);
      const [ida, idb] = [idFrom(a.out), idFrom(b.out)];
      assert.match(a.out, /Started/);
      assert.match(b.out, /Started/, 'the second one starts at once too: different folders');
      const ta = getTask(ida, env)!;
      const tb = getTask(idb, env)!;
      assert.equal(ta.cwd, scratchDir(ida, env));
      assert.equal(tb.cwd, scratchDir(idb, env));
      assert.notEqual(ta.cwd, tb.cwd);
      assert.equal(ta.worktree, null);
      assert.equal(ta.branch, null);
      assert.deepEqual([getTask(ida, env)?.status, getTask(idb, env)?.status], ['running', 'running'], 'both run at the same time');

      const [da, db] = [await waitFor(ida, env, ['done', 'failed']), await waitFor(idb, env, ['done', 'failed'])];
      assert.equal(da.status, 'done');
      assert.equal(db.status, 'done');
      assert.equal(da.verification?.state, 'unverified');
      assert.ok(existsSync(join(ta.cwd, 'member-output.txt')), 'the first one worked in its own folder');
      assert.ok(existsSync(join(tb.cwd, 'member-output.txt')), 'the second one worked in its own folder');
      assert.match(cli(env, ['status', ida]).out, /unverified \(scratch folder/);

      const closed = cli(env, ['close', ida]);
      assert.equal(closed.code, 0, closed.err);
      assert.ok(closed.out.includes(ta.cwd), 'close prints the folder it kept');
      assert.ok(existsSync(join(ta.cwd, 'member-output.txt')), 'the folder and its files are kept');
    } finally {
      cleanup(dir);
    }
  });

  it('--scratch stands alone', () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      assert.match(cli(env, ['spawn', '--scratch', '--project', 'repo'], 'x').err, /--scratch stands alone/);
      assert.match(cli(env, ['spawn'], 'x').err, /--scratch/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('startup briefing', () => {
  it('shows what finished and what is open, and the finished ones are then no longer new', async () => {
    const { dir, env } = makeHome();
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Done soon\nsay hi').out);
      await waitFor(id, env, ['done']);
      const first = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /Finished since your last look \(1\):\n\S+\s+done\s+\[scratch\] Done soon/);
      assert.doesNotMatch(cli(env, ['brief', '--agent', 'fake']).out, /Finished since your last look/);
      assert.match(cli(env, ['brief', '--agent', 'fake']).out, /waiting on you \(1\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('live commands run in the project folder and their output lands in the inbox', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const repo = makeRepo(join(dir, 'repo'));
      git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
      const plain = makeRepo(join(dir, 'plain'));
      assert.equal(cli(env, ['add', repo]).code, 0);
      assert.equal(cli(env, ['add', plain, '--live', 'node -e "console.log(\'LIVE-MARK\')"']).code, 0);
      // Their own commands wait for the user's confirmation; the defaults of a GitHub project do not.
      const before = cli(env, ['brief', '--agent', 'fake']);
      assert.match(before.out, /Live commands of plain skipped: you have not confirmed them \(in a terminal: amigo confirm-gates plain\)/);
      assert.doesNotMatch(await inboxHas(env, /FAKE-RUN-LIST/), /LIVE-MARK/, 'an unconfirmed live command did not run');
      confirmGates('plain', env);
      const brief = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /Live checks are running in the background/);
      assert.doesNotMatch(brief.out, /skipped/);

      const text = await inboxHas(env, /LIVE-MARK[\s\S]*FAKE-RUN-LIST|FAKE-RUN-LIST[\s\S]*LIVE-MARK/);
      assert.match(text, /briefing: live checks/);
      assert.match(text, /\[repo\] \$ gh pr list --limit 5\n\s+FAKE-PR-LIST/, 'the GitHub project got the default commands');
      assert.match(text, /\[repo\] \$ gh run list --limit 3\n\s+FAKE-RUN-LIST/);
      assert.match(text, /\[plain\] \$ node -e .*\n\s+LIVE-MARK/, 'a project with its own live commands runs those');
      assert.doesNotMatch(text, /\[plain\] \$ gh/, 'and not the defaults');
      const calls = ghCalls(gh.log);
      assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')).sort(), ['pr list', 'pr list', 'run list', 'run list'], 'the defaults ran at both starts');
      for (const c of calls) assert.equal(c.cwd.toLowerCase(), repo.toLowerCase(), 'gh ran in the project folder, not in a worktree');
      assert.equal(listTasks(env).length, 0, 'live checks are not squad members');
      assert.equal(cli(env, ['inbox']).out.trim(), 'Inbox empty.', 'the entry is shown once');
    } finally {
      cleanup(dir);
    }
  });

  it('a live command that runs too long is stopped and reported; --live "" turns the defaults off', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env, AMIGO_LIVE_TIMEOUT_MS: '800' };
    try {
      const repo = makeRepo(join(dir, 'repo'));
      git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
      cli(env, ['add', repo, '--live', 'node -e "setTimeout(() => {}, 30000)"']);
      confirmGates('repo', env);
      cli(env, ['brief', '--agent', 'fake']);
      assert.match(await inboxHas(env, /timed out/), /\[repo\] \$ node -e .* \(timed out\)/);
      cli(env, ['add', repo, '--live', '']);
      const off = cli(env, ['brief', '--agent', 'fake']);
      assert.doesNotMatch(off.out, /Live checks are running/, 'an empty list means no live checks');
      assert.equal(ghCalls(gh.log).length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('live commands and watch items are gates: setting or changing them needs confirming again, and a project without them keeps its hash', () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo, '--check', 'node -e "1"']);
      const project = () => JSON.parse(readFileSync(join(home(env), 'projects.json'), 'utf8')).projects[0];
      confirmGates('repo', env);
      assert.ok(gatesConfirmed(project(), env));
      const out = cli(env, ['add', repo, '--live', 'echo hi', '--watch', 'is the site up?']).out;
      assert.deepEqual(project().live, ['echo hi']);
      assert.deepEqual(project().watch, ['is the site up?']);
      assert.deepEqual(project().checks, ['node -e "1"'], 'the checks stay');
      assert.ok(!gatesConfirmed(project(), env), 'new live commands and watch items are unconfirmed');
      assert.match(out, /not confirmed by you yet[\s\S]*the briefing skips its live commands and watch items/);
      confirmGates('repo', env);
      assert.ok(gatesConfirmed(project(), env));
      cli(env, ['add', repo, '--live', 'echo changed']);
      assert.ok(!gatesConfirmed(project(), env), 'changing them needs confirming again');
      cli(env, ['add', repo, '--live', '', '--watch', '']);
      assert.match(cli(env, ['projects']).out, /live: \(none\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('the default live commands run gh by its absolute path through no shell: a gh.bat in the repository is never started', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const repo = makeRepo(join(dir, 'repo'));
      git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
      // What a cloned repository could ship: cmd.exe looks in the current folder before PATH.
      const pwned = join(dir, 'pwned.txt');
      writeFileSync(join(repo, 'gh.bat'), `@echo off\r\necho pwned> "${pwned}"\r\n`);
      writeFileSync(join(repo, 'gh'), `#!/bin/sh\necho pwned > "${pwned}"\n`, { mode: 0o755 });
      cli(env, ['add', repo]);
      assert.equal(cli(env, ['brief', '--agent', 'fake']).code, 0);
      const text = await inboxHas(env, /FAKE-RUN-LIST/);
      assert.match(text, /FAKE-PR-LIST/, 'the real (fake) gh ran');
      assert.ok(!existsSync(pwned), "the repository's own gh was not started");
    } finally {
      cleanup(dir);
    }
  });

  it('watch items spawn exactly one scratch squad member, and no watch items spawn none', async () => {
    const { dir, env } = makeHome(2);
    try {
      const one = makeRepo(join(dir, 'one'));
      const two = makeRepo(join(dir, 'two'));
      cli(env, ['add', one, '--live', '']);
      cli(env, ['add', two, '--live', '']);
      assert.equal(cli(env, ['brief', '--agent', 'fake']).code, 0);
      assert.equal(listTasks(env).length, 0, 'no watch items: no squad member');

      cli(env, ['add', one, '--live', '', '--watch', 'Is the staging site up?', '--watch', 'Any failing deploy?']);
      cli(env, ['add', two, '--live', '', '--watch', 'Anything odd in the logs?']);
      const unconfirmed = cli(env, ['brief', '--agent', 'fake']);
      assert.match(unconfirmed.out, /Watch items of one skipped: you have not confirmed them \(in a terminal: amigo confirm-gates one\)/);
      assert.equal(listTasks(env).length, 0, 'unconfirmed watch items spawn nothing');
      confirmGates('one', env);
      confirmGates('two', env);
      const brief = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /Squad member \S+ \("Briefing checks"\) is checking the watch items of: one, two/);
      const tasks = listTasks(env);
      assert.equal(tasks.length, 1, 'exactly one squad member for all projects');
      const t = tasks[0]!;
      assert.equal(t.title, 'Briefing checks');
      assert.equal(t.scratch, true);
      assert.equal(t.cwd, scratchDir(t.id, env));
      const brief1 = readFileSync(join(home(env), 'tasks', t.id, 'brief.md'), 'utf8');
      for (const w of ['Is the staging site up?', 'Any failing deploy?', 'Anything odd in the logs?']) assert.ok(brief1.includes(w), w);
      assert.match(brief1, /Change nothing: no edits, no commits, no pushes/);
      assert.equal((await waitFor(t.id, env, ['done', 'failed'])).status, 'done');
      assert.match(cli(env, ['inbox']).out, /Briefing checks/);

      assert.equal(cli(env, ['--dry-run']).code, 0);
      assert.equal(listTasks(env).length, 1, 'a dry run of the bare command spawns nothing');

      // One at a time: an open briefing member is not joined by a second one.
      const again = cli(env, ['brief', '--agent', 'fake']);
      assert.match(again.out, /"Briefing checks" squad member \S+ is still open \(done\); not starting another/);
      assert.equal(listTasks(env).length, 1);

      // Closing it removes its scratch folder; any other scratch member keeps its own.
      const other = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Mine\nsay hi').out);
      await waitFor(other, env, ['done']);
      const closed = cli(env, ['close', t.id]);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Removed the briefing squad member's scratch folder/);
      assert.ok(!existsSync(t.cwd), 'the briefing scratch folder is gone');
      assert.equal(cli(env, ['close', other]).code, 0);
      assert.ok(existsSync(getTask(other, env)!.cwd), 'another scratch member keeps its folder');
      assert.match(cli(env, ['brief', '--agent', 'fake']).out, /Squad member \S+ \("Briefing checks"\) is checking/, 'a new one starts once the old one is closed');
    } finally {
      cleanup(dir);
    }
  });
});

describe('one-time migration from the former home', () => {
  /** A user's machine: a fake home folder with the old data folder, a repo and an installed old skill. */
  function setup() {
    const dir = tmpDir();
    const user = join(dir, 'user');
    const old = join(user, '.octomaxxing');
    mkdirSync(user, { recursive: true });
    const base = makeHome();
    // makeHome's own home is not used: the old folder is the home while the old data is built.
    cleanup(base.dir);
    mkdirSync(old, { recursive: true });
    const fake = join(codeRoot, 'test', 'fake-agent.mjs');
    writeFileSync(join(old, 'config.json'), JSON.stringify({ agents: { fake: { amigo: [process.execPath, fake, '{prompt}'], member: [process.execPath, fake, '{prompt}'] } }, memberMb: 0, reserveMb: 0 }));
    const claudeJson = join(dir, 'claude.json');
    const common = { ...cleanEnv(), AMIGO_TERMINAL: 'test', AMIGO_CLAUDE_JSON: claudeJson, AMIGO_FREE_MB: '4096' };
    const building = { ...common, AMIGO_HOME: old };
    // What the migrating command sees: no AMIGO_HOME, a user folder that is the temp one, the old home located by AMIGO_OLD_HOME.
    const migrating = { ...common, HOME: user, USERPROFILE: user, AMIGO_OLD_HOME: old };
    return { dir, user, old, claudeJson, building, migrating, fake };
  }

  it('moves a home with a finished open task: its worktree, status and close still work, and the old skill goes', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      assert.equal(cli(s.building, ['add', repo]).code, 0);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Write a file\nDone when: it exists').out);
      const done = await waitFor(id, s.building, ['done']);
      const oldWorktree = done.worktree as string;
      assert.ok(oldWorktree.startsWith(s.old), 'the task lives in the old home');
      assert.match(git(repo, 'worktree', 'list'), /\.octomaxxing/);

      // The old data as the old version wrote it: its config keys and its trust entry in ~/.claude.json.
      const cfg = JSON.parse(readFileSync(join(s.old, 'config.json'), 'utf8'));
      writeFileSync(join(s.old, 'config.json'), JSON.stringify({ agents: { fake: { head: cfg.agents.fake.amigo, arm: cfg.agents.fake.member } }, armMb: 0, reserveMb: 0 }));
      const task = JSON.parse(readFileSync(join(s.old, 'tasks', id, 'task.json'), 'utf8'));
      writeFileSync(join(s.old, 'tasks', id, 'task.json'), JSON.stringify({ ...task, trustAdded: true, headAddress: 'uds:/tmp/x' }));
      writeFileSync(s.claudeJson, JSON.stringify({ numStartups: 3, projects: { [oldWorktree.replaceAll('\\', '/')]: { allowedTools: [], hasTrustDialogAccepted: true, lastCost: 1.5 } } }));
      const skill = join(s.user, '.claude', 'skills', 'octomaxxing', 'SKILL.md');
      mkdirSync(join(s.user, '.claude', 'skills', 'octomaxxing'), { recursive: true });
      writeFileSync(skill, '---\nname: octomaxxing\n---\n<!-- installed by octomaxxing -->\nrun it\n');
      const foreign = join(s.user, '.gemini', 'commands', 'octomaxxing.toml');
      mkdirSync(join(s.user, '.gemini', 'commands'), { recursive: true });
      writeFileSync(foreign, 'description = "somebody else wrote this"\n');

      const r = cli(s.migrating, ['status', id]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.err, /Moved .*\.octomaxxing to .*\.amigo \(1 task, 1 worktree repaired\)\./);
      assert.match(r.err, /amigo install-skill/);
      assert.match(r.out, new RegExp(`${id}\\s+done`));
      assert.match(r.out, /changed files[\s\S]*member-output\.txt/, 'git runs in the moved worktree');

      const moved = join(s.user, '.amigo');
      assert.ok(existsSync(moved));
      assert.ok(!existsSync(s.old), 'the old folder is gone');
      const worktrees = git(repo, 'worktree', 'list');
      assert.ok(worktrees.replaceAll('\\', '/').toLowerCase().includes(join(moved, 'worktrees').replaceAll('\\', '/').toLowerCase()), `git worktree list shows the new path:\n${worktrees}`);
      assert.doesNotMatch(worktrees, /\.octomaxxing/);

      const migrated = getTask(id, { ...s.migrating, AMIGO_HOME: moved })!;
      assert.ok(migrated.worktree!.startsWith(moved));
      assert.ok(migrated.cwd.startsWith(moved));
      assert.equal((migrated as unknown as Record<string, unknown>).headAddress, undefined);
      assert.equal(migrated.amigoAddress, 'uds:/tmp/x');
      const config = JSON.parse(readFileSync(join(moved, 'config.json'), 'utf8'));
      assert.ok(config.agents.fake.amigo && config.agents.fake.member && config.memberMb === 0, 'old config keys are renamed');
      assert.ok(!('head' in config.agents.fake) && !('armMb' in config));

      assert.ok(!existsSync(skill), 'the old skill file written by the former name is removed');
      assert.ok(existsSync(foreign), 'a file it did not write is kept');
      const trust = JSON.parse(readFileSync(s.claudeJson, 'utf8'));
      assert.equal(trust.numStartups, 3, 'other fields of ~/.claude.json are kept');
      const keys = Object.keys(trust.projects).map((k) => k.toLowerCase());
      assert.ok(keys.some((k) => k.includes('.amigo/worktrees')), 'trust follows the worktree');
      assert.ok(!keys.some((k) => k.includes('.octomaxxing')), 'and the old entry is gone');
      const entry = Object.entries(trust.projects).find(([k]) => k.toLowerCase().includes('.amigo/worktrees'))?.[1] as Record<string, unknown>;
      assert.equal(entry.lastCost, 1.5, 'the entry keeps its other fields');
      assert.equal(entry.hasTrustDialogAccepted, true);

      // The second command does not migrate again, and the task closes with a commit on its (new-named) branch.
      const closed = cli(s.migrating, ['close', id, '--commit']);
      assert.equal(closed.code, 0, closed.err);
      assert.doesNotMatch(closed.err, /Moved/);
      assert.match(closed.out, /Committed \w+ to branch amigo\//);
      assert.ok(!existsSync(migrated.worktree!), 'worktree removed');
      assert.equal(git(repo, 'show', '--name-only', '--format=', `amigo/${id}`).trim(), 'member-output.txt');
    } finally {
      cleanup(s.dir);
    }
  });

  it('refuses while a task is running, and moves nothing', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Slow\nMODE:sleep\nwork').out);
      assert.equal(getTask(id, s.building)?.status, 'running');
      const r = cli(s.migrating, ['status']);
      assert.equal(r.code, 1);
      assert.match(r.err, /still has tasks at work \(\S+ running\)\. Wait for them to finish/);
      assert.ok(existsSync(s.old), 'the old home stays where it was');
      assert.ok(!existsSync(join(s.user, '.amigo')), 'no new home was made');
      assert.equal(cli(s.migrating, ['help']).code, 0, 'help still works');
      await waitFor(id, s.building, ['done']);
      const ok = cli(s.migrating, ['status']);
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.err, /Moved /);
    } finally {
      cleanup(s.dir);
    }
  });

  it('does nothing when AMIGO_HOME is set or ~/.amigo already exists', () => {
    const s = setup();
    try {
      mkdirSync(join(s.user, '.amigo'));
      assert.doesNotMatch(cli(s.migrating, ['projects']).err, /Moved/);
      assert.ok(existsSync(s.old), 'the old home is left alone');
      assert.doesNotMatch(cli({ ...s.migrating, AMIGO_HOME: join(s.dir, 'elsewhere') }, ['projects']).err, /Moved/);
    } finally {
      cleanup(s.dir);
    }
  });

  it('refuses while any task has a live tab, whatever its status says', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Quick\nwork').out);
      assert.equal((await waitFor(id, s.building, ['done'])).status, 'done');
      await new Promise((r) => setTimeout(r, 500));
      beat(id, s.building); // a tab of this task is open and beating
      const r = cli(s.migrating, ['status']);
      assert.equal(r.code, 1);
      assert.match(r.err, /still has tasks at work \(\S+ done\)/);
      assert.ok(existsSync(s.old) && !existsSync(join(s.user, '.amigo')), 'nothing moved');
      clearBeat(id, s.building);
      assert.equal(cli(s.migrating, ['status']).code, 0);
    } finally {
      cleanup(s.dir);
    }
  });

  it('finishes a move that stopped halfway: the next command rewrites what is left', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Half\nwork').out);
      await waitFor(id, s.building, ['done']);
      const cfg = JSON.parse(readFileSync(join(s.old, 'config.json'), 'utf8'));
      writeFileSync(join(s.old, 'config.json'), JSON.stringify({ agents: { fake: { head: cfg.agents.fake.amigo, arm: cfg.agents.fake.member } }, armMb: 0, reserveMb: 0 }));
      // What a crash right after the rename leaves: the folder moved, the marker in it, nothing inside rewritten.
      const moved = join(s.user, '.amigo');
      writeFileSync(join(s.old, '.migration-incomplete'), JSON.stringify({ from: s.old }));
      renameSync(s.old, moved);
      assert.match(JSON.stringify(JSON.parse(readFileSync(join(moved, 'tasks', id, 'task.json'), 'utf8'))), /\.octomaxxing/, 'the task still has old paths');

      const r = cli(s.migrating, ['status', id]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.err, /Finished moving .* \(1 task, 1 worktree repaired\)/);
      assert.match(r.out, /changed files[\s\S]*member-output\.txt/, 'git works in the repaired worktree');
      const config = JSON.parse(readFileSync(join(moved, 'config.json'), 'utf8'));
      assert.ok(config.agents.fake.amigo && config.agents.fake.member && config.memberMb === 0);
      assert.doesNotMatch(readFileSync(join(moved, 'tasks', id, 'task.json'), 'utf8'), /\.octomaxxing/);
      assert.ok(!existsSync(join(moved, '.migration-incomplete')), 'the marker is removed at the end');
      assert.doesNotMatch(cli(s.migrating, ['status']).err, /moving|Moved/, 'and nothing is repeated');
    } finally {
      cleanup(s.dir);
    }
  });

  it('a session of the former name still counts as a squad member: managing commands are refused and its Stop hook still records', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Old session\nMODE:sleep\nwork').out);
      assert.equal(getTask(id, s.building)?.status, 'running');
      const { AMIGO_HOME: _home, ...common } = s.building;
      const oldSession = { ...common, HOME: s.user, USERPROFILE: s.user, AMIGO_OLD_HOME: s.old, OCTOMAXXING_TASK: id, OCTOMAXXING_HOME: s.old };
      const refused = cli(oldSession, ['spawn', '--scratch'], 'x');
      assert.equal(refused.code, 1);
      assert.match(refused.err, new RegExp('You are running inside squad member ' + id));
      assert.ok(existsSync(s.old) && !existsSync(join(s.user, '.amigo')), 'and nothing moved');

      const hook = cli(oldSession, ['_hook', 'stop'], JSON.stringify({ last_assistant_message: 'STATUS: done - hook saw it' }));
      assert.equal(hook.code, 0, hook.err);
      const after = getTask(id, s.building)!;
      assert.equal(after.summary, 'hook saw it', "the old session's hook wrote to the old home");
    } finally {
      await waitFor(getTask(listTasks(s.building)[0]!.id, s.building) ? listTasks(s.building)[0]!.id : '', s.building, ['done', 'failed']).catch(() => undefined);
      cleanup(s.dir);
    }
  });

  it('tells a user whose shell still sets the former home variable that amigo does not read it', () => {
    const s = setup();
    try {
      const env = { ...s.migrating, AMIGO_OLD_HOME: join(s.dir, 'nothing-here'), OCTOMAXXING_HOME: join(s.dir, 'somewhere') };
      const first = cli(env, ['projects']);
      assert.match(first.err, /home variable is set .*somewhere.*set AMIGO_HOME to that folder to keep using it, or move it to .*\.amigo/);
      assert.doesNotMatch(cli(env, ['projects']).err, /home variable is set/, 'once ~/.amigo exists the hint is gone');
      assert.doesNotMatch(cli({ ...env, AMIGO_HOME: join(s.dir, 'chosen') }, ['projects']).err, /home variable is set/, 'and AMIGO_HOME answers it');
    } finally {
      cleanup(s.dir);
    }
  });

  it('moves a trust entry with all its fields, and trusts the folder when it had no entry', () => {
    const config = { numStartups: 1, projects: { 'C:/old/wt': { allowedTools: ['x'], hasTrustDialogAccepted: true, lastCost: 2 } } };
    const moved = moveTrust(config, 'C:\\old\\wt', 'C:/new/wt') as { projects: Record<string, Record<string, unknown>> };
    assert.deepEqual(Object.keys(moved.projects), ['C:/new/wt']);
    assert.deepEqual(moved.projects['C:/new/wt'], { allowedTools: ['x'], hasTrustDialogAccepted: true, lastCost: 2 });
    assert.equal(moveTrust(moved, 'C:/old/wt', 'C:/new/wt'), null, 'moving again changes nothing');
    const fresh = moveTrust({ projects: {} }, 'C:/old/wt', 'C:/new/wt') as { projects: Record<string, unknown> };
    assert.ok(fresh.projects['C:/new/wt']);
  });

  it('a repair that fails (the repo folder is gone) is warned about once: the marker goes and the next command is quiet', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Orphan\nwork').out);
      await waitFor(id, s.building, ['done']);
      cleanup(repo); // the project's own folder is deleted before the move
      const first = cli(s.migrating, ['projects']);
      assert.equal(first.code, 0, first.err);
      assert.match(first.err, /Moved .*\(1 task, 0 worktrees repaired\)\./);
      assert.equal((first.err.match(/Warning: git worktree repair failed/g) ?? []).length, 1, 'one warning');
      assert.ok(!existsSync(join(s.user, '.amigo', '.migration-incomplete')), 'the marker is gone');
      const second = cli(s.migrating, ['projects']);
      assert.doesNotMatch(second.err, /Moved|moving|Warning/, 'nothing repeats');
    } finally {
      cleanup(s.dir);
    }
  });

  it('a move that stopped halfway refuses to go on while a task has a live tab, and leaves finished records alone', async () => {
    const s = setup();
    try {
      const repo = makeRepo(join(s.dir, 'repo'));
      cli(s.building, ['add', repo]);
      const id = idFrom(cli(s.building, ['spawn', '--project', 'repo'], 'Title: Resume\nwork').out);
      await waitFor(id, s.building, ['done']);
      const moved = join(s.user, '.amigo');
      writeFileSync(join(s.old, '.migration-incomplete'), JSON.stringify({ from: s.old }));
      renameSync(s.old, moved);
      const inMoved = { ...s.building, AMIGO_HOME: moved };
      await new Promise((r) => setTimeout(r, 500));
      beat(id, inMoved);
      const refused = cli(s.migrating, ['projects']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /still has tasks at work/);
      assert.ok(existsSync(join(moved, '.migration-incomplete')), 'the marker stays until the job is done');
      assert.match(readFileSync(join(moved, 'tasks', id, 'task.json'), 'utf8'), /\.octomaxxing/, 'nothing was rewritten');
      clearBeat(id, inMoved);

      // A record an earlier run already rewrote is not written again (a write could undo a live status change).
      const file = join(moved, 'tasks', id, 'task.json');
      const text = readFileSync(file, 'utf8').split(s.old.replaceAll('\\', '\\\\')).join(moved.replaceAll('\\', '\\\\'));
      writeFileSync(file, text);
      await new Promise((r) => setTimeout(r, 100));
      const before = statSync(file).mtimeMs;
      const ok = cli(s.migrating, ['projects']);
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.err, /Finished moving .*\(0 tasks, 1 worktree repaired\)/);
      assert.equal(statSync(file).mtimeMs, before, 'the finished record was left alone');
    } finally {
      cleanup(s.dir);
    }
  });

  it('a squad member never migrates: its read-only commands leave the old home where it is', () => {
    const s = setup();
    try {
      const member = { ...s.migrating, AMIGO_TASK: 'x-1' };
      const r = cli(member, ['projects']);
      assert.doesNotMatch(r.err, /Moved/);
      assert.ok(existsSync(join(s.old, 'config.json')), 'the old home is untouched');
    } finally {
      cleanup(s.dir);
    }
  });

  it('rewrites only paths that point inside the old home', () => {
    assert.equal(movePath('/u/.octomaxxing/worktrees/a', '/u/.octomaxxing', '/u/.amigo'), '/u/.amigo/worktrees/a');
    assert.equal(movePath('/u/.octomaxxing', '/u/.octomaxxing', '/u/.amigo'), '/u/.amigo');
    assert.equal(movePath('/u/.octomaxxing-other/x', '/u/.octomaxxing', '/u/.amigo'), '/u/.octomaxxing-other/x');
    assert.equal(movePath('/work/repo', '/u/.octomaxxing', '/u/.amigo'), '/work/repo');
  });
});

describe('branches of migrated tasks', () => {
  it('push accepts the task own amigo/ or former branch and nothing else', () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      addOrigin(dir, repo);
      git(repo, 'branch', legacyBranchName('7-old'));
      git(repo, 'branch', 'amigo/8-new');
      git(repo, 'branch', 'feature');
      pushBranch(repo, legacyBranchName('7-old'), env, '7-old');
      pushBranch(repo, 'amigo/8-new', env, '8-new');
      assert.match(git(repo, 'ls-remote', 'origin', 'refs/heads/*'), /7-old[\s\S]*8-new|8-new[\s\S]*7-old/);
      assert.throws(() => pushBranch(repo, 'amigo/8-new', env, '7-old'), /Refusing to push/);
      assert.throws(() => pushBranch(repo, legacyBranchName('7-old'), env, '8-new'), /Refusing to push/);
      assert.throws(() => pushBranch(repo, 'feature', env, '7-old'), /Refusing to push/);
      assert.throws(() => pushBranch(repo, 'feature', env), /Refusing to push/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('background results (notices)', () => {
  it('a live run that beats is never taken for dead, and a slow run that was reported dead still delivers its result', () => {
    const { dir, env } = makeHome();
    try {
      const id = beginNotice('briefing: live checks', env);
      assert.equal(noticesPending(env), true);
      assert.deepEqual(takeNotices(env), [], 'nothing to show while it runs');
      // Silent for longer than the window: reported as dead, once.
      const later = Date.now() + 5 * 60_000;
      assert.equal(noticesPending(env, later), false);
      const dead = takeNotices(env, later);
      assert.equal(dead.length, 1);
      assert.match(dead[0]!.text, /stopped reporting/);
      assert.deepEqual(takeNotices(env, later), [], 'reported once');
      // It was only slow: the real result still arrives.
      finishNotice(id, 'LATE-RESULT', env);
      const late = takeNotices(env);
      assert.equal(late.length, 1);
      assert.equal(late[0]!.text, 'LATE-RESULT');

      // A beat keeps a long run alive: the same notice, last heard from long ago, is pending again after one beat.
      const id2 = beginNotice('briefing: live checks', env);
      const all = JSON.parse(readFileSync(noticesPath(env), 'utf8'));
      writeFileSync(noticesPath(env), JSON.stringify(all.map((n: { id: string }) => (n.id === id2 ? { ...n, beatAt: new Date(Date.now() - 10 * 60_000).toISOString() } : n))));
      assert.equal(noticesPending(env), false, 'no beat for ten minutes: dead');
      touchNotice(id2, env);
      assert.equal(noticesPending(env), true, 'one beat and it is alive');
    } finally {
      cleanup(dir);
    }
  });
});

describe('help anywhere and the version', () => {
  it('-h and --help print the help wherever they are, and --version prints the version', () => {
    const { dir, env } = makeHome();
    try {
      for (const argv of [['--agent', 'x', '--help'], ['spawn', '--help'], ['close', '3', '-h'], ['status', '-h'], ['--dry-run', '-h']]) {
        const r = cli(env, argv);
        assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
        assert.ok(r.out.startsWith(HELP), `${argv.join(' ')} prints the help`);
      }
      const version = (JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8')) as { version: string }).version;
      assert.equal(cli(env, ['--version']).out.trim(), version);
      assert.match(HELP, /amigo --version/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('the briefing text in the instructions', () => {
  it('mentions live checks, and amigo wait for them, only when some will run', () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const none = cli(env, ['brief', '--agent', 'fake']);
      assert.doesNotMatch(none.out, /live checks/i, 'no origin on GitHub: no live checks, no mention');
      git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
      const some = cli(env, ['brief', '--agent', 'fake']);
      assert.match(some.out, /Live checks are running in the background: run `amigo wait` in the background for their result, like any other/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('finding a program', () => {
  it('answers with an absolute path and ignores a relative PATH entry, so a program in the current folder is never picked', () => {
    const dir = tmpDir();
    const here = process.cwd();
    try {
      const win = process.platform === 'win32';
      const name = win ? 'sometool.cmd' : 'sometool';
      mkdirSync(join(dir, 'rel'));
      writeFileSync(join(dir, 'rel', name), win ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
      process.chdir(dir);
      const env = { PATH: ['rel', '.', ''].join(delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      assert.equal(resolveExecutable('sometool', env), null, 'a relative PATH entry is not searched');
      const absolute = { ...env, PATH: [join(dir, 'rel')].join(delimiter) };
      const found = resolveExecutable('sometool', absolute);
      assert.ok(found && isAbsolute(found), 'an absolute PATH entry is');
      // An explicit relative path comes back absolute too.
      const explicit = resolveExecutable(join('rel', name), env);
      assert.ok(explicit && isAbsolute(explicit), explicit ?? 'not found');
    } finally {
      process.chdir(here);
      cleanup(dir);
    }
  });
});
