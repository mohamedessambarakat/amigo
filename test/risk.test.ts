import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseVerdict } from '../src/gates.ts';
import { assessChanges, docsOrTestsOnly, globMatches, snapshot, type Change } from '../src/risk.ts';
import { getTask } from '../src/tasks.ts';
import { cleanup, cli, git, idFrom, makeHome, makeRepo, waitFor } from './helpers.ts';

const change = (path: string, added = 1, removed = 0, deleted = false): Change => ({ path, added, removed, deleted });

describe('risk scoring', () => {
  it('a tiny diff in a risky path is needs-you, whatever its size', () => {
    for (const path of ['src/auth/login.ts', 'lib/payments/charge.ts', 'billing.ts', 'db/migrations/001_users.sql', '.env', 'config/credentials.json', '.github/workflows/ci.yml', 'Dockerfile', 'vercel.json', 'infra/main.tf', 'k8s/deploy.yaml', 'src/api/users.ts', 'src/routes/index.ts', 'openapi.yaml', 'proto/users.proto']) {
      const r = assessChanges([change(path)]);
      assert.equal(r.level, 'needs-you', path);
      assert.match(r.reasons.join(' '), new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
  });

  it('small is at most 3 files and 100 lines with no deletions; the rest is non-trivial', () => {
    assert.equal(assessChanges([change('src/a.ts', 60, 37), change('src/b.ts'), change('README.md')]).level, 'small');
    assert.equal(assessChanges([change('src/a.ts', 60, 41)]).level, 'non-trivial', '101 lines');
    assert.equal(assessChanges([change('a'), change('b'), change('c'), change('d')]).level, 'non-trivial', '4 files');
    assert.equal(assessChanges([]).level, 'small');
    const deleting = assessChanges([change('src/old.ts', 0, 3, true)]);
    assert.equal(deleting.level, 'needs-you');
    assert.deepEqual(deleting.deleted, ['src/old.ts']);
    assert.equal(assessChanges([change('.env.example')]).level, 'small', 'an example env file holds no secrets');
    assert.equal(assessChanges([change('src/author.ts')]).level, 'small', 'author is not auth');
  });

  it('projects add their own risky globs', () => {
    assert.equal(assessChanges([change('src/legacy/x.ts')]).level, 'small');
    const r = assessChanges([change('src/legacy/x.ts')], ['src/legacy/**']);
    assert.equal(r.level, 'needs-you');
    assert.match(r.reasons[0] as string, /project risky path src\/legacy\/\*\*/);
    assert.equal(assessChanges([change('db/dump.sql')], ['*.sql']).level, 'needs-you');
  });

  it('dependency manifests, lockfiles, production config and auth-like names are risky, even as a one-line change', () => {
    const risky = [
      'package.json', 'web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'poetry.lock', 'go.mod', 'go.sum',
      'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', '.npmrc', '.yarnrc', '.yarnrc.yml',
      'config/production.json', 'apps/web/config/production.yml', 'settings.prod.json',
      'src/session.ts', 'lib/jwt.ts', 'src/tokens.ts', 'app/oauth/callback.ts', 'src/login.tsx', 'src/permissions.ts', 'server/middleware.ts',
    ];
    for (const path of risky) {
      const r = assessChanges([change(path)]);
      assert.equal(r.level, 'needs-you', path);
    }
    assert.match(assessChanges([change('package.json')]).reasons.join(' '), /dependency manifest or lockfile/);
    assert.equal(assessChanges([change('src/ui/button.ts'), change('config/development.json')]).level, 'small', 'ordinary files stay small');
  });

  it('git hook folders and the files the checks run are risky, even as a one-line change', () => {
    for (const path of ['.husky/pre-commit', '.githooks/pre-push', '.git-hooks/x', 'lefthook.yml', '.pre-commit-config.yaml', 'Makefile', 'justfile', 'scripts/test.sh', 'jest.config.js', 'vitest.config.ts', 'playwright.config.ts', 'karma.conf.js', 'eslint.config.mjs', '.eslintrc.json', 'tsconfig.json', 'packages/a/tsconfig.build.json', '.prettierrc', 'biome.json', 'biome.jsonc']) {
      assert.equal(assessChanges([change(path)]).level, 'needs-you', path);
    }
    assert.match(assessChanges([change('.husky/pre-commit')]).reasons.join(' '), /git hooks or tooling/);
  });

  it('a test file that loses an existing line is not "only docs and tests", a pure addition is', () => {
    const globs = ['*.md', 'test', '*.test.*'];
    assert.ok(docsOrTestsOnly([change('test/a.test.js', 5, 0), change('README.md', 2, 2)], globs), 'additions to tests, any edit to docs');
    assert.equal(docsOrTestsOnly([change('test/a.test.js', 1, 2)], globs), false, 'a deleted line');
    assert.equal(docsOrTestsOnly([change('src/x.spec.ts', 1, 1)], globs), false, 'a changed line');
  });

  it('a binary file, a submodule or a file mode change is never small, however few lines it has', () => {
    for (const odd of [{ ...change('logo.png', 0, 0), opaque: true }, { ...change('vendor/lib', 1, 1), opaque: true }]) {
      const r = assessChanges([odd]);
      assert.equal(r.level, 'non-trivial', odd.path);
      assert.match(r.reasons.join(' '), /binary file, submodule or file mode/);
    }
    assert.equal(assessChanges([change('notes.md', 1, 0)]).level, 'small');
  });

  it('snapshot flags binary files and mode changes as opaque', () => {
    const { dir } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      writeFileSync(join(repo, 'run.sh'), 'echo hi\n');
      git(repo, 'add', '.');
      git(repo, 'update-index', '--chmod=+x', 'run.sh');
      git(repo, 'commit', '-q', '-m', 'script');
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      const by = (path: string) => snapshot(repo, repo, base).changes.find((c) => c.path === path);

      writeFileSync(join(repo, 'logo.png'), Buffer.from([0, 1, 2, 255, 0]));
      assert.equal(by('logo.png')?.opaque, true, 'a binary file has no line count');
      assert.equal(assessChanges([by('logo.png') as Change]).level, 'non-trivial', 'a binary file is not small');

      writeFileSync(join(repo, 'text.md'), 'one line\n');
      assert.equal(by('text.md')?.opaque, false, 'text is measured');

      // run.sh was committed as executable; a working file git reads as a normal file is a mode change.
      git(repo, 'config', 'core.fileMode', 'true');
      assert.equal(by('run.sh')?.opaque, true, 'a mode change is not measurable by lines');
    } finally {
      cleanup(dir);
    }
  });

  it('globs: names match anywhere, paths with a slash match from the root, ** crosses folders', () => {
    assert.ok(globMatches('migrations', 'a/b/migrations/1.sql'));
    assert.ok(globMatches('*.proto', 'x/y/z.PROTO'));
    assert.ok(globMatches('.github/workflows/**', '.github/workflows/ci.yml'));
    assert.ok(!globMatches('.github/workflows/**', 'sub/.github/workflows/ci.yml'));
    assert.ok(globMatches('src/**/secret.ts', 'src/secret.ts'));
    assert.ok(globMatches('src/**/secret.ts', 'src/a/b/secret.ts'));
    assert.ok(globMatches('src/legacy', 'src/legacy/a/b.ts'), 'a folder glob covers what is inside it');
    assert.ok(!globMatches('auth', 'author/x.ts'));
  });

  it('measures what a squad member changed against its start commit: committed or not, untracked and deleted files included', () => {
    const { dir } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      writeFileSync(join(repo, 'b.txt'), '1\n2\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'b');
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      const clean = snapshot(repo, repo, base);
      assert.deepEqual(clean.changes, []);

      writeFileSync(join(repo, 'a.txt'), 'hello\nmore\n'); // modified tracked
      writeFileSync(join(repo, 'new.txt'), 'x\ny\nz\n'); // untracked
      git(repo, 'rm', '-q', 'b.txt'); // deleted
      const snap = snapshot(repo, repo, base);
      const by = Object.fromEntries(snap.changes.map((c) => [c.path, c]));
      assert.deepEqual([by['a.txt']?.added, by['a.txt']?.removed], [1, 0]);
      assert.deepEqual([by['new.txt']?.added, by['new.txt']?.deleted], [3, false]);
      assert.deepEqual([by['b.txt']?.removed, by['b.txt']?.deleted], [2, true]);
      assert.notEqual(snap.tree, clean.tree);
      assert.equal(snapshot(repo, repo, base).tree, snap.tree, 'the same work has the same tree');
      assert.equal(git(repo, 'status', '--porcelain').includes('new.txt'), true, 'the real index is untouched');

      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'commit it');
      const committed = snapshot(repo, repo, base);
      assert.equal(committed.tree, snap.tree, 'committing does not change what the work is');
      assert.equal(committed.changes.length, 3);
    } finally {
      cleanup(dir);
    }
  });

  it('reads PASS or FAIL as the first word of a reviewer summary', () => {
    assert.equal(parseVerdict('PASS - looks good'), 'PASS');
    assert.equal(parseVerdict('fail: two bugs'), 'FAIL');
    assert.equal(parseVerdict('**Verdict: PASS** fine'), 'PASS');
    assert.equal(parseVerdict('Passed all the checks'), null);
    assert.equal(parseVerdict('looks good, PASS'), null);
  });
});

describe('mandatory review', () => {
  it('close --commit refuses non-trivial work without a PASS review and succeeds after one', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Four files\nMODE:big').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      assert.match(cli(env, ['status', id]).out, /risk:\s+non-trivial - 4 files and 4 lines changed/);
      assert.match(cli(env, ['status', id]).out, /review:\s+none yet/);

      const refused = cli(env, ['close', id, '--commit']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /needs a reviewer's PASS before close --commit\. No reviewer has judged it yet/);
      assert.equal(getTask(id, env)?.status, 'done', 'a refused close changes nothing');
      assert.ok(existsSync(t.worktree as string));

      const review = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review it\ncheck the four files').out);
      await waitFor(review, env, ['done', 'failed']);
      assert.equal(getTask(id, env)?.review?.verdict, 'PASS');
      assert.equal(getTask(id, env)?.review?.by, review);
      assert.match(cli(env, ['status', id]).out, /review:\s+PASS by /);
      assert.equal(cli(env, ['close', review]).code, 0);

      const closed = cli(env, ['close', id, '--commit']);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Committed \w+ to branch amigo\//);
      assert.equal(git(repo, 'show', '--name-only', '--format=', `amigo/${id}`).trim().split(/\r?\n/).length, 4);
    } finally {
      cleanup(dir);
    }
  });

  it('a tiny change in a risky path needs review too; FAIL, stale and same-work-after-FAIL reviews do not count, and there is no override', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Touch auth\nMODE:risky').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      assert.match(cli(env, ['status', id]).out, /risk:\s+needs-you - touches src\/auth\/login\.txt \(auth\)/);
      assert.match(cli(env, ['close', id, '--commit']).err, /needs-you/);
      assert.match(cli(env, ['close', id, '--commit', '--skip-review']).err, /--skip-review/, 'the override is gone');

      const bad = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review it\nMODE:reviewfail').out);
      await waitFor(bad, env, ['done', 'failed']);
      assert.equal(getTask(id, env)?.review?.verdict, 'FAIL');
      assert.equal(cli(env, ['close', bad]).code, 0);
      assert.match(cli(env, ['close', id, '--commit']).err, /said FAIL/);

      // A later PASS on exactly the work that failed does not override the FAIL.
      const same = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review the same work again').out);
      await waitFor(same, env, ['done', 'failed']);
      assert.equal(getTask(id, env)?.review?.verdict, 'PASS');
      assert.match(getTask(id, env)?.review?.void ?? '', /already failed exactly this work/);
      assert.match(cli(env, ['status', id]).out, /PASS by .* \(does not count: a reviewer already failed exactly this work/);
      cli(env, ['close', same]);
      assert.match(cli(env, ['close', id, '--commit']).err, /PASS does not count: a reviewer already failed exactly this work/);

      // Changed work and a new review is the way through.
      writeFileSync(join(t.worktree as string, 'fix.txt'), 'the fix\n');
      const good = idFrom(cli(env, ['spawn', '--review', id], 'Title: Review the fix').out);
      await waitFor(good, env, ['done', 'failed']);
      cli(env, ['close', good]);
      assert.equal(getTask(id, env)?.review?.void, undefined);
      writeFileSync(join(t.worktree as string, 'extra.txt'), 'changed after the review\n');
      assert.match(cli(env, ['status', id]).out, /PASS by .* \(but the work changed since/);
      assert.match(cli(env, ['close', id, '--commit']).err, /changed since reviewer .* passed it/);
      rmSync(join(t.worktree as string, 'extra.txt'));
      const closed = cli(env, ['close', id, '--commit']);
      assert.equal(closed.code, 0, closed.err);
      assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'nothing merged');
    } finally {
      cleanup(dir);
    }
  });

  it('a change to the work while the reviewer reads it voids its PASS; send is refused while a reviewer is open', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Four files\nMODE:big').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      const review = idFrom(cli(env, ['spawn', '--review', id], 'Title: Slow review\nMODE:sleep').out);
      assert.ok(getTask(review, env)?.reviewedTree, "the parent's tree is recorded when the reviewer is spawned");

      const sent = cli(env, ['send', id], 'please also add a fifth file');
      assert.equal(sent.code, 1);
      assert.match(sent.err, new RegExp(`Task ${id} is under review \\(${review}\\)`));
      assert.equal(getTask(id, env)?.status, 'done', 'the refused send changed nothing');

      writeFileSync(join(t.worktree as string, 'sneaky.txt'), 'changed while the reviewer was reading\n');
      await waitFor(review, env, ['done', 'failed']);
      const verdict = getTask(id, env)?.review;
      assert.equal(verdict?.verdict, 'PASS');
      assert.match(verdict?.void ?? '', /the work changed while the reviewer was reading it/);
      assert.match(cli(env, ['send', id], 'one more thing').err, /is under review/, 'still refused while the finished reviewer is open');
      assert.equal(cli(env, ['close', review]).code, 0);
      assert.match(cli(env, ['close', id, '--commit']).err, /PASS does not count/);
      assert.equal(cli(env, ['send', id], 'one more thing').code, 0, 'allowed once the reviewer is closed');
    } finally {
      cleanup(dir);
    }
  });

  it('small work needs no review', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      cli(env, ['add', repo]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Small').out);
      await waitFor(id, env, ['done']);
      assert.match(cli(env, ['status', id]).out, /risk:\s+small - 1 file, 1 line/);
      assert.match(cli(env, ['status', id]).out, /review:\s+not needed/);
      assert.equal(cli(env, ['close', id, '--commit']).code, 0);
    } finally {
      cleanup(dir);
    }
  });
});
