import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { awayMergeRefusal, awayPath, readAway } from '../src/away.ts';
import { actionLines, updateAmigo } from '../src/update.ts';
import { addOrigin, cleanup, cli, git, makeHome, makeRepo } from './helpers.ts';

describe('the away posture (/afk and /quiet)', () => {
  it('records the words verbatim, refreshes, replaces, narrows merges only while afk, shows in the digest and archives on return', () => {
    const { dir, env } = makeHome();
    try {
      assert.match(cli(env, ['away', 'status']).out, /Not away/);
      const words = join(dir, 'words.txt');
      writeFileSync(words, 'Merge the footer fix if it goes green.\nNothing else.');
      const entered = cli(env, ['away', 'afk', '--words-file', words, '--expected-return', '2026-11-23T08:00Z']);
      assert.equal(entered.code, 0, entered.err);
      assert.match(entered.out, /Entered afk mode\.[\s\S]*Expected back: 2026-11-23T08:00:00\.000Z[\s\S]*His words \(verbatim\):\nMerge the footer fix if it goes green\.\nNothing else\./);
      assert.equal(readAway(env)?.words, 'Merge the footer fix if it goes green.\nNothing else.');

      assert.match(cli(env, ['away', 'afk']).out, /Refreshed afk mode/);
      assert.equal(readAway(env)?.words, 'Merge the footer fix if it goes green.\nNothing else.', 'a refresh with no words keeps the mandate');
      cli(env, ['away', 'afk', '--words', 'Only watch.']);
      const replaced = readAway(env);
      assert.equal(replaced?.words, 'Only watch.');
      assert.equal(replaced?.superseded?.[0]?.words, 'Merge the footer fix if it goes green.\nNothing else.', 'replaced words are kept for the return brief');

      assert.match(awayMergeRefusal({ localOnly: false, waiving: true }, env) ?? '', /waiving a check needs him present/);
      assert.match(awayMergeRefusal({ localOnly: true, waiving: false }, env) ?? '', /local-only landing waits for his return/);
      assert.equal(awayMergeRefusal({ localOnly: false, waiving: false }, env), null, 'green work under standing authority may still merge');

      assert.match(cli(env, ['digest', '--again']).out, /AWAY \(afk\)[\s\S]*Only watch\./);

      const back = cli(env, ['away', 'return']);
      assert.match(back.out, /Ended\. The record is archived\.[\s\S]*Only watch\.[\s\S]*Since then:[\s\S]*amigo wake drain/);
      assert.ok(!existsSync(awayPath(env)));
      assert.equal(readdirSync(join(env.AMIGO_HOME as string, 'state', 'away-archive')).length, 1);
      assert.match(cli(env, ['away', 'return']).out, /Not away: nothing to end/);

      cli(env, ['away', 'quiet']);
      assert.equal(readAway(env)?.mode, 'quiet');
      assert.equal(awayMergeRefusal({ localOnly: true, waiving: true }, env), null, 'quiet mode never changes merge authority');
      assert.match(cli(env, ['away', 'nap']).err, /Unknown away command "nap"/);
      assert.match(cli(env, ['away', 'afk', '--expected-return', 'soon']).err, /--expected-return must be a date/);
    } finally {
      cleanup(dir);
    }
  });

  it('is a managing command a crew member cannot run', () => {
    const { dir, env } = makeHome();
    try {
      const r = cli({ ...env, AMIGO_TASK: 'x-1' }, ['away', 'afk']);
      assert.notEqual(r.code, 0);
      assert.ok(!existsSync(awayPath(env)));
    } finally {
      cleanup(dir);
    }
  });
});

describe('amigo update', () => {
  it("fast-forwards amigo's own live folder from origin and says what the session must do", () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'amigo-src'));
      const bare = addOrigin(dir, repo);
      const live = join(dir, 'live');
      git(dir, 'clone', '-q', bare, live);

      assert.match(updateAmigo(env, live)[0] as string, /skipped: amigo's code folder .* is not the live folder of any registered project/);

      assert.equal(cli(env, ['add', bare, '--name', 'amigo', '--live', live]).code, 0);
      const current = updateAmigo(env, live);
      assert.match(current.join('\n'), /live .*: already current/);
      assert.deepEqual(current.slice(-3), ['reread-contract: no', 'reinstall-skills: no', 'restart-session: no']);

      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      git(repo, 'commit', '-q', '-am', 'docs: change a');
      git(repo, 'push', '-q', 'origin', 'main');
      const moved = updateAmigo(env, live);
      assert.match(moved.join('\n'), /live .*: fast-forwarded/);
      assert.deepEqual(moved.slice(-3), ['reread-contract: no', 'reinstall-skills: no', 'restart-session: no']);

      writeFileSync(join(live, 'a.txt'), 'local edit\n');
      writeFileSync(join(repo, 'a.txt'), 'again\n');
      git(repo, 'commit', '-q', '-am', 'docs: again');
      git(repo, 'push', '-q', 'origin', 'main');
      assert.match(updateAmigo(env, live).join('\n'), /live .*: skipped: uncommitted changes/, 'a dirty live folder is reported, never touched');
    } finally {
      cleanup(dir);
    }
  });

  it('maps changed files to the follow-up actions', () => {
    assert.deepEqual(actionLines(['prompts/amigo.md', 'skills/agent/x.md']), ['reread-contract: yes', 'reinstall-skills: no', 'restart-session: no']);
    assert.deepEqual(actionLines(['skills/user/afk/SKILL.md', 'src/cli.ts']), ['reread-contract: no', 'reinstall-skills: yes', 'restart-session: yes']);
  });
});
