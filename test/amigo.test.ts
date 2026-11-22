import { amigoHooks } from '../src/supervise.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { describe, it } from 'node:test';
import { COMMANDS, HELP } from '../src/cli.ts';
import { codeRoot, home, scratchDir } from '../src/paths.ts';
import { listTasks, getTask } from '../src/tasks.ts';
import { beginNotice, finishNotice, noticesPending, takeNotices, touchNotice } from '../src/notices.ts';
import { amigoPrompt, inbox, waitForMembers } from '../src/squad.ts';
import { pointerLine, resolveExecutable } from '../src/command.ts';
import { noticesPath } from '../src/paths.ts';
import { cleanup, cli, cloneOf, fakeAgent, fakeGhEnv, ghCalls, git, idFrom, makeHome, makeRepo, releaseHeld, tmpDir, waitFor } from './helpers.ts';

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
      assert.ok(!existsSync(join(home(env), 'state', 'tasks')) || readdirSync(join(home(env), 'state', 'tasks')).length === 0, 'a dry run starts nothing');
      const old = cli(env, ['head', '--dry-run']);
      assert.equal(old.code, 1);
      assert.match(old.err, /Unknown command "head"/);
    } finally {
      cleanup(dir);
    }
  });

  it('bare amigo passes Claude instructions via --append-system-prompt-file and a short first prompt, while keeping other agents unchanged', () => {
    const { dir, env } = makeHome();
    try {
      const win = process.platform === 'win32';
      const recorder = join(dir, 'record.mjs');
      writeFileSync(
        recorder,
        [
          "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
          'const [outFile, ...argv] = process.argv.slice(2);',
          "const pIdx = argv.indexOf('--append-system-prompt-file');",
          "const sIdx = argv.indexOf('--settings');",
          'const promptPath = pIdx >= 0 ? argv[pIdx + 1] : null;',
          'const settingsPath = sIdx >= 0 ? argv[sIdx + 1] : null;',
          'writeFileSync(outFile, JSON.stringify({',
          '  argv,',
          "  promptText: promptPath && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : null,",
          "  settingsText: settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null,",
          '}));',
        ].join('\n'),
      );
      const makeShim = (name: string, outFile: string) => {
        const shim = join(dir, win ? `${name}.cmd` : name);
        writeFileSync(
          shim,
          win ? `@echo off\r\n"${process.execPath}" "${recorder}" "${outFile}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "${outFile}" "$@"\n`,
          { mode: 0o755 },
        );
        return shim;
      };
      const claudeOut = join(dir, 'claude-run.json');
      const codexOut = join(dir, 'codex-run.json');
      const claudeShim = makeShim('claude', claudeOut);
      const codexShim = makeShim('codex', codexOut);
      const claudeExe = join(dir, 'bin', 'claude.exe');
      mkdirSync(join(dir, 'bin'), { recursive: true });
      writeFileSync(claudeExe, '');

      const amigoHome = home(env);
      const promptPath = join(amigoHome, 'state', 'amigo-prompt.md');
      const settingsPath = join(amigoHome, 'state', 'amigo-settings.json');
      writeFileSync(
        join(amigoHome, 'config', 'config.json'),
        JSON.stringify({
          agents: {
            claude: { amigo: [claudeShim, '{prompt}'], member: [claudeShim, '{prompt}'] },
            ...(win ? { claudeDirect: { amigo: [claudeExe, '{prompt}'], member: [claudeExe, '{prompt}'] } } : {}),
            codex: { amigo: [codexShim, '{prompt}'], member: [codexShim, 'exec', '{prompt}'] },
            fake: { amigo: [process.execPath, fakeAgent, '{prompt}'], member: [process.execPath, fakeAgent, '{prompt}'] },
          },
          memberMb: 0,
          reserveMb: 0,
        }),
      );

      // Dry run prints the exact launch command and writes nothing.
      for (const agent of win ? ['claude', 'claudeDirect'] : ['claude']) {
        const dry = cli(env, ['--agent', agent, '--dry-run']);
        assert.equal(dry.code, 0, dry.err);
        assert.match(dry.out, /--name amigo/);
        assert.ok(dry.out.includes(`--settings`) && dry.out.includes(settingsPath), dry.out);
        assert.ok(dry.out.includes(`--append-system-prompt-file`) && dry.out.includes(promptPath), dry.out);
        assert.ok(dry.out.includes('"Brief me."'), dry.out);
        assert.doesNotMatch(dry.out, /Read the file|# You are amigo/);
      }
      const fakeDry = cli(env, ['--agent', 'fake', '--dry-run']);
      assert.equal(fakeDry.code, 0, fakeDry.err);
      assert.doesNotMatch(fakeDry.out, /--append-system-prompt-file|--name|--settings|Brief me\./);
      assert.match(fakeDry.out, /# You are amigo/);
      const codexDry = cli(env, ['--agent', 'codex', '--dry-run']);
      assert.equal(codexDry.code, 0, codexDry.err);
      assert.doesNotMatch(codexDry.out, /--append-system-prompt-file|--name|--settings|Brief me\./);
      assert.ok(win ? codexDry.out.includes(pointerLine(promptPath)) : codexDry.out.includes('# You are amigo'), codexDry.out);
      assert.ok(!existsSync(promptPath) && !existsSync(settingsPath), 'dry run writes neither prompt nor settings');

      // Real run for a non-Claude agent keeps its current prompt handling and writes no Claude settings.
      const codexRun = cli(env, ['--agent', 'codex']);
      assert.equal(codexRun.code, 0, codexRun.err);
      const codexSeen = JSON.parse(readFileSync(codexOut, 'utf8')) as { argv: string[] };
      assert.equal(codexSeen.argv.length, 1);
      if (win) assert.equal(codexSeen.argv[0], pointerLine(promptPath));
      else assert.match(codexSeen.argv[0] ?? '', /^# You are amigo[\s\S]*## Briefing/);
      assert.ok(!existsSync(settingsPath), 'non-Claude agent writes no amigo-settings.json');

      // Real run for Claude writes amigo-prompt.md and amigo-settings.json before launching and sends only the short first prompt.
      const claudeRun = cli(env, ['--agent', 'claude']);
      assert.equal(claudeRun.code, 0, claudeRun.err);
      const claudeSeen = JSON.parse(readFileSync(claudeOut, 'utf8')) as { argv: string[]; promptText: string | null; settingsText: string | null };
      assert.deepEqual(claudeSeen.argv, ['--name', 'amigo', '--settings', settingsPath, '--append-system-prompt-file', promptPath, 'Brief me.']);
      assert.match(claudeSeen.promptText ?? '', /^# You are amigo[\s\S]*## Briefing/, 'amigo-prompt.md was written before launching Claude');
      assert.deepEqual(JSON.parse(claudeSeen.settingsText ?? 'null'), { crossSessionInbound: 'accept', hooks: amigoHooks() });
    } finally {
      cleanup(dir);
    }
  });
});

describe('scratch workspace', () => {
  it('two scratch crew members run in parallel, each in its own folder; close keeps the folder', async () => {
    const { dir, env } = makeHome(2);
    try {
      const a = cli(env, ['spawn', '--scratch'], 'Title: First\nMODE:hold\nDone when: a file exists');
      const b = cli(env, ['spawn', '--scratch'], 'Title: Second\nMODE:hold\nDone when: a file exists');
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
      releaseHeld(env);

      const [da, db] = [await waitFor(ida, env, ['done', 'failed']), await waitFor(idb, env, ['done', 'failed'])];
      assert.equal(da.status, 'done');
      assert.equal(db.status, 'done');
      assert.ok(existsSync(join(ta.cwd, 'member-output.txt')), 'the first one worked in its own folder');
      assert.ok(existsSync(join(tb.cwd, 'member-output.txt')), 'the second one worked in its own folder');

      const closed = cli(env, ['close', ida]);
      assert.equal(closed.code, 0, closed.err);
      assert.ok(closed.out.includes(ta.cwd), 'close prints the folder it kept');
      assert.ok(existsSync(join(ta.cwd, 'member-output.txt')), 'the folder and its files are kept');
    } finally {
      releaseHeld(env);
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
      const plain = makeRepo(join(dir, 'plain'));
      assert.equal(cli(env, ['add', repo]).code, 0);
      git(cloneOf(env, 'repo'), 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
      assert.equal(cli(env, ['add', plain, '--live-command', 'node -e "console.log(\'LIVE-MARK\')"']).code, 0);
      // A project's own live commands run with no confirmation step (the old gates are gone); a GitHub project gets the defaults.
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
      assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')).sort(), ['pr list', 'run list'], 'the defaults ran');
      for (const c of calls) assert.equal(c.cwd.toLowerCase(), cloneOf(env, 'repo').toLowerCase(), 'gh ran in the clone, not in a worktree');
      assert.equal(listTasks(env).length, 0, 'live checks are not crew members');
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
      cli(env, ['add', repo, '--live-command', 'node -e "setTimeout(() => {}, 30000)"']);
      git(cloneOf(env, 'repo'), 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
      cli(env, ['brief', '--agent', 'fake']);
      assert.match(await inboxHas(env, /timed out/), /\[repo\] \$ node -e .* \(timed out\)/);
      cli(env, ['add', repo, '--live-command', '']);
      const off = cli(env, ['brief', '--agent', 'fake']);
      assert.doesNotMatch(off.out, /Live checks are running/, 'an empty list means no live checks');
      assert.equal(ghCalls(gh.log).length, 0);
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
      // What a cloned repository could ship: cmd.exe looks in the current folder before PATH.
      const pwned = join(dir, 'pwned.txt');
      writeFileSync(join(repo, 'gh.bat'), `@echo off\r\necho pwned> "${pwned}"\r\n`);
      writeFileSync(join(repo, 'gh'), `#!/bin/sh\necho pwned > "${pwned}"\n`, { mode: 0o755 });
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'ship a gh');
      cli(env, ['add', repo]);
      git(cloneOf(env, 'repo'), 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
      assert.equal(cli(env, ['brief', '--agent', 'fake']).code, 0);
      const text = await inboxHas(env, /FAKE-RUN-LIST/);
      assert.match(text, /FAKE-PR-LIST/, 'the real (fake) gh ran');
      assert.ok(!existsSync(pwned), "the repository's own gh was not started");
    } finally {
      cleanup(dir);
    }
  });

  it('watch items spawn exactly one scratch crew member, and no watch items spawn none', async () => {
    const { dir, env } = makeHome(2);
    try {
      const one = makeRepo(join(dir, 'one'));
      const two = makeRepo(join(dir, 'two'));
      cli(env, ['add', one, '--live-command', '']);
      cli(env, ['add', two, '--live-command', '']);
      assert.equal(cli(env, ['brief', '--agent', 'fake']).code, 0);
      assert.equal(listTasks(env).length, 0, 'no watch items: no crew member');

      cli(env, ['add', one, '--live-command', '', '--watch', 'Is the staging site up?', '--watch', 'Any failing deploy?']);
      cli(env, ['add', two, '--live-command', '', '--watch', 'Anything odd in the logs?']);
      const brief = cli(env, ['brief', '--agent', 'fake']);
      assert.equal(brief.code, 0, brief.err);
      assert.match(brief.out, /Crew member \S+ \("Briefing checks"\) is checking the watch items of: one, two/);
      const tasks = listTasks(env);
      assert.equal(tasks.length, 1, 'exactly one crew member for all projects');
      const t = tasks[0]!;
      assert.equal(t.title, 'Briefing checks');
      assert.equal(t.scratch, true);
      assert.equal(t.cwd, scratchDir(t.id, env));
      const brief1 = readFileSync(join(home(env), 'data', t.id, 'brief.md'), 'utf8');
      for (const w of ['Is the staging site up?', 'Any failing deploy?', 'Anything odd in the logs?']) assert.ok(brief1.includes(w), w);
      assert.match(brief1, /Change nothing: no edits, no commits, no pushes/);
      assert.equal((await waitFor(t.id, env, ['done', 'failed'])).status, 'done');
      assert.match(cli(env, ['inbox']).out, /Briefing checks/);

      assert.equal(cli(env, ['--dry-run']).code, 0);
      assert.equal(listTasks(env).length, 1, 'a dry run of the bare command spawns nothing');

      // One at a time: an open briefing member is not joined by a second one.
      const again = cli(env, ['brief', '--agent', 'fake']);
      assert.match(again.out, /"Briefing checks" crew member \S+ is still open \(done\); not starting another/);
      assert.equal(listTasks(env).length, 1);

      // Closing it removes its scratch folder; any other scratch member keeps its own.
      const other = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Mine\nsay hi').out);
      await waitFor(other, env, ['done']);
      const closed = cli(env, ['close', t.id]);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Removed the briefing crew member's scratch folder/);
      assert.ok(!existsSync(t.cwd), 'the briefing scratch folder is gone');
      assert.equal(cli(env, ['close', other]).code, 0);
      assert.ok(existsSync(getTask(other, env)!.cwd), 'another scratch member keeps its folder');
      assert.match(cli(env, ['brief', '--agent', 'fake']).out, /Crew member \S+ \("Briefing checks"\) is checking/, 'a new one starts once the old one is closed');
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

  it('wait returns pending or unseen notices, and stops once inbox has consumed them', async () => {
    const { dir, env } = makeHome();
    try {
      // Unseen finished notice: wait returns it immediately and marks it seen.
      const id1 = beginNotice('briefing: live checks', env);
      finishNotice(id1, 'FIRST-LIVE', env);
      const immediate = await waitForMembers([], 5_000, env, 50);
      assert.match(immediate, /briefing: live checks[\s\S]*FIRST-LIVE/);
      assert.equal(inbox(env), 'Inbox empty.', 'wait marked the notice seen');

      // Pending notice: wait polls until it finishes, then returns it.
      const id2 = beginNotice('briefing: live checks', env);
      const pending = waitForMembers([], 5_000, env, 50);
      setTimeout(() => finishNotice(id2, 'SECOND-LIVE', env), 100);
      assert.match(await pending, /briefing: live checks[\s\S]*SECOND-LIVE/);

      // Already consumed by inbox: wait sees nothing pending and returns immediately.
      const id3 = beginNotice('briefing: live checks', env);
      finishNotice(id3, 'THIRD-LIVE', env);
      assert.match(inbox(env), /THIRD-LIVE/);
      assert.equal(await waitForMembers([], 5_000, env, 50), 'Nothing is running or queued, and nothing new has finished.');
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
  it('mentions live checks only when some will run, and gates amigo wait on pending work', () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const none = cli(env, ['brief', '--agent', 'fake']);
      assert.doesNotMatch(none.out, /live checks/i, 'no origin on GitHub: no live checks, no mention');
      assert.match(none.out, /after you handle a result while anything is still running or queued/);
      git(cloneOf(env, 'repo'), 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
      const some = cli(env, ['brief', '--agent', 'fake']);
      assert.match(
        some.out,
        /Live checks are running in the background: run `amigo wait` in the background only if their result has not already arrived in `amigo inbox` \(or crew members are still running or queued\), and mention it when it arrives\./,
      );
      assert.doesNotMatch(some.out, /run `amigo wait` in the background for their result, like any other/);

      // Direct amigoPrompt check for opts.live true vs false.
      const promptWithLive = amigoPrompt('fake', env, '1 project registered.', { live: true });
      const promptWithoutLive = amigoPrompt('fake', env, '1 project registered.', { live: false });
      assert.match(promptWithLive, /only if their result has not already arrived in `amigo inbox` \(or crew members are still running or queued\)/);
      assert.doesNotMatch(promptWithoutLive, /live checks/i);
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
