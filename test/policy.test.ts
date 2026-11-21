import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { confirmGates } from '../src/gates.ts';
import { commitAll, findAdminDir, pushBranch, worktreeGitArgs } from '../src/git.ts';
import { run } from '../src/proc.ts';
import { assessChanges, docsOrTestsOnly, snapshot } from '../src/risk.ts';
import { policyState, storeApproval } from '../src/policy.ts';
import { approvalsPath, policyPath } from '../src/paths.ts';
import { getTask } from '../src/tasks.ts';
import { addOrigin, cleanup, cli, fakeGhEnv, ghCalls, git, idFrom, makeHome, makeRepo, makeRepoWithChecks, waitFor } from './helpers.ts';

const lines = (env: NodeJS.ProcessEnv): { event: string; id: string; [k: string]: unknown }[] =>
  existsSync(approvalsPath(env))
    ? readFileSync(approvalsPath(env), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const setPolicy = (env: NodeJS.ProcessEnv, change: (policy: Record<string, any>) => void): void => {
  const p = JSON.parse(readFileSync(policyPath(env), 'utf8'));
  change(p);
  writeFileSync(policyPath(env), JSON.stringify(p, null, 2));
};

/** A project with a passing check and one finished squad member that only wrote a docs file: everything but the policy is in order. */
async function finishedDocsTask(dir: string, env: NodeJS.ProcessEnv, extra = ''): Promise<{ repo: string; id: string }> {
  const repo = makeRepoWithChecks(join(dir, 'repo'));
  assert.equal(cli(env, ['add', repo, '--check', 'node ok.mjs']).code, 0);
  confirmGates('repo', env); // what the user does by hand with confirm-gates
  const id = idFrom(cli(env, ['spawn', '--project', 'repo'], `Title: Update the notes\nMODE:docs${extra}`).out);
  assert.equal((await waitFor(id, env, ['done', 'blocked', 'failed'])).status, 'done');
  return { repo, id };
}

describe('approval policy', () => {
  it('starts as an inactive starter policy, and approve-policy refuses without a terminal', () => {
    const { dir, env } = makeHome();
    try {
      const first = cli(env, ['policy']);
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /NOT APPROVED - self-approval is off: the policy has not been approved yet/);
      assert.match(first.out, /"pr": "never"/);
      assert.doesNotMatch(first.out, /allowPr|allowedAction/);
      assert.match(first.out, /pull requests: never/);
      assert.doesNotMatch(first.out, /"summary"/, 'no decorative summary field');
      const refused = cli(env, ['approve-policy'], 'approve\n');
      assert.equal(refused.code, 1);
      assert.match(refused.err, /needs an interactive terminal/);
      assert.equal(policyState(env).approved, false);
    } finally {
      cleanup(dir);
    }
  });

  it('close --self refuses when no approved policy exists', async () => {
    const { dir, env } = makeHome();
    try {
      const { id } = await finishedDocsTask(dir, env);
      const r = cli(env, ['close', id, '--commit', '--self']);
      assert.equal(r.code, 1);
      assert.match(r.err, /cannot be self-approved:\n {2}- the policy is not approved: the policy has not been approved yet/);
      assert.equal(getTask(id, env)?.status, 'done', 'nothing happened');
      assert.equal(lines(env).length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('close --self refuses once the policy was edited after approval', async () => {
    const { dir, env } = makeHome();
    try {
      const { id } = await finishedDocsTask(dir, env);
      assert.equal(storeApproval(env).approved, true);
      setPolicy(env, (p) => p.selfApproval.docsAndTestsGlobs.push('everything-else/**'));
      assert.match(cli(env, ['policy']).out, /NOT APPROVED - self-approval is off: policy\.json was edited after it was approved/);
      const r = cli(env, ['close', id, '--commit', '--self']);
      assert.equal(r.code, 1);
      assert.match(r.err, /the policy is not approved: policy\.json was edited after it was approved/);
      assert.equal(lines(env).length, 0);
      writeFileSync(policyPath(env), '{ not json');
      assert.match(cli(env, ['policy']).out, /policy\.json is invalid/);
    } finally {
      cleanup(dir);
    }
  });

  it('self-approves a low-risk commit, logs it, and undo deletes the branch and logs that too', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      storeApproval(env);
      const r = cli(env, ['close', id, '--commit', '--self']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Self-approved under the policy/);
      assert.match(git(repo, 'branch', '--list', `amigo/${id}`), /amigo\//);

      const [approve] = lines(env);
      assert.equal(approve?.event, 'approve');
      assert.equal(approve?.id, id);
      assert.equal(approve?.project, 'repo');
      assert.equal(approve?.branch, `amigo/${id}`);
      assert.equal(approve?.sha, git(repo, 'rev-parse', `amigo/${id}`).trim());
      assert.equal(approve?.undo, `amigo undo ${id}`);
      assert.match((approve?.reasons as string[]).join(' | '), /checks configured and all passed.*only docs and tests changed/);
      assert.match(JSON.stringify(approve), /"time":"\d{4}-/);

      const undone = cli(env, ['undo', id]);
      assert.equal(undone.code, 0, undone.err);
      assert.equal(git(repo, 'branch', '--list', `amigo/${id}`).trim(), '', 'the branch is gone');
      assert.equal(lines(env).at(-1)?.event, 'undo');
      assert.match(cli(env, ['undo', id]).err, /already undone/);
    } finally {
      cleanup(dir);
    }
  });

  it('undo refuses a branch that was pushed, a branch that moved, and tasks nobody self-approved', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      addOrigin(dir, repo);
      storeApproval(env);
      assert.equal(cli(env, ['close', id, '--commit', '--self']).code, 0);
      const tip = git(repo, 'rev-parse', `amigo/${id}`).trim();
      git(repo, 'update-ref', `refs/heads/amigo/${id}`, 'HEAD');
      assert.match(cli(env, ['undo', id]).err, /moved since it was approved/);
      git(repo, 'update-ref', `refs/heads/amigo/${id}`, tip);
      git(repo, 'push', '-q', '-u', 'origin', `amigo/${id}`);
      const r = cli(env, ['undo', id]);
      assert.equal(r.code, 1);
      assert.match(r.err, /was pushed \(or has an upstream\)/);
      assert.match(git(repo, 'branch', '--list', `amigo/${id}`), /amigo\//, 'still there');
      assert.equal(lines(env).length, 1, 'a refused undo is not logged as one');

      const other = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Not self-approved').out);
      await waitFor(other, env, ['done']);
      assert.match(cli(env, ['undo', other]).err, /was not self-approved/);
    } finally {
      cleanup(dir);
    }
  });

  it('self-approval has no overrides and needs everything: checks, small risk, docs or a review', async () => {
    const { dir, env } = makeHome();
    try {
      const { id } = await finishedDocsTask(dir, env);
      storeApproval(env);
      assert.match(cli(env, ['close', id, '--commit', '--self', '--force']).err, /no overrides/);
      assert.match(cli(env, ['close', id, '--self']).err, /only make sense with --commit/);

      // Work that touches more than docs, with no review, is not eligible; neither is work in a risky path.
      const code = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Change code').out);
      await waitFor(code, env, ['done']);
      assert.match(cli(env, ['close', code, '--commit', '--self']).err, /it changes more than docs and tests \(agent instruction files never count as docs\) and has no reviewer PASS for this exact work/);
      const risky = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Touch auth\nMODE:risky').out);
      await waitFor(risky, env, ['done']);
      assert.match(cli(env, ['close', risky, '--commit', '--self']).err, /risk is needs-you/);

      // A reviewer's PASS makes the code change eligible.
      const review = idFrom(cli(env, ['spawn', '--review', code], 'Title: Review it').out);
      await waitFor(review, env, ['done']);
      cli(env, ['close', review]);
      const ok = cli(env, ['close', code, '--commit', '--self']);
      assert.equal(ok.code, 0, ok.err);
      assert.match((lines(env).at(-1)?.reasons as string[]).join(' | '), /reviewer .* passed exactly this work/);

      // A project without checks can never self-approve.
      const bare = makeRepoWithChecks(join(dir, 'unchecked'));
      cli(env, ['add', bare]);
      const nochecks = idFrom(cli(env, ['spawn', '--project', 'unchecked'], 'Title: Docs\nMODE:docs').out);
      await waitFor(nochecks, env, ['done']);
      assert.match(cli(env, ['close', nochecks, '--commit', '--self']).err, /the project has no checks configured/);
    } finally {
      cleanup(dir);
    }
  });

  it('--self --pr needs pr "also-self-approved"; "after-human-yes" is for close --pr without --self', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      const bare = addOrigin(dir, repo);
      storeApproval(env);
      const noPr = cli(env, ['close', id, '--commit', '--self', '--pr']);
      assert.equal(noPr.code, 1);
      assert.match(noPr.err, /does not allow pull requests \("pr": "never"/);

      setPolicy(env, (p) => (p.pr = 'after-human-yes'));
      assert.equal(policyState(env).approved, false, 'editing the policy switched self-approval off');
      assert.match(cli(env, ['close', id, '--commit', '--self', '--pr']).err, /--pr needs an approved policy[\s\S]*edited after it was approved/);
      storeApproval(env);
      const refused = cli(env, ['close', id, '--commit', '--self', '--pr']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /the policy's "pr" is "after-human-yes", so a pull request needs the user's yes, not --self/);
      assert.equal(getTask(id, env)?.status, 'done');
      assert.equal(git(bare, 'branch', '--list').trim(), 'main', 'nothing was pushed');
      assert.equal(ghCalls(gh.log).length, 0, 'gh was not called');

      setPolicy(env, (p) => (p.pr = 'also-self-approved'));
      storeApproval(env);
      const ok = cli(env, ['close', id, '--commit', '--self', '--pr']);
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.out, /Opened a draft pull request: https:\/\/github\.com\/example\/repo\/pull\/7/);
      assert.match(git(bare, 'branch', '--list'), new RegExp(`amigo/${id}`));
      assert.deepEqual(
        lines(env).map((l) => l.event),
        ['approve', 'pr'],
      );
    } finally {
      cleanup(dir);
    }
  });

  it('close --pr (without --self) refuses with no approved policy, and with an approved policy where pr is never', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const env = { ...base, ...gh.env };
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      const bare = addOrigin(dir, repo);
      const unapproved = cli(env, ['close', id, '--commit', '--pr']);
      assert.equal(unapproved.code, 1);
      assert.match(unapproved.err, /--pr needs an approved policy that allows pull requests, and the policy has not been approved yet/);
      storeApproval(env);
      const off = cli(env, ['close', id, '--commit', '--pr']);
      assert.equal(off.code, 1);
      assert.match(off.err, /The approved policy does not allow pull requests \("pr": "never"/);
      assert.equal(getTask(id, env)?.status, 'done', 'nothing was committed');
      assert.equal(git(bare, 'branch', '--list').trim(), 'main', 'nothing was pushed');
      assert.equal(ghCalls(gh.log).length, 0, 'gh was not called');
      assert.equal(cli(env, ['close', id, '--commit']).code, 0, 'a plain local commit needs no policy');
    } finally {
      cleanup(dir);
    }
  });

  it('--self refuses after a non-interactive change of the project checks, until the user confirms them', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      storeApproval(env);
      const changed = cli(env, ['add', repo, '--check', 'node fail.mjs']);
      assert.equal(changed.code, 0, changed.err);
      assert.match(changed.out, /not confirmed by you yet, so close --self refuses for repo\. To confirm, run in a terminal: amigo confirm-gates repo/);
      const r = cli(env, ['close', id, '--commit', '--self']);
      assert.equal(r.code, 1);
      assert.match(r.err, /the project's checks or risky paths were not confirmed by the user/);
      const noTty = cli(env, ['confirm-gates', 'repo'], 'confirm\n');
      assert.equal(noTty.code, 1);
      assert.match(noTty.err, /needs an interactive terminal/);

      // Even confirmed, results recorded for other checks do not count.
      confirmGates('repo', env);
      assert.match(cli(env, ['close', id, '--commit', '--self']).err, /the project's checks changed after these results were recorded/);

      // Loosening the risky globs by editing projects.json by hand is caught the same way.
      assert.equal(cli(env, ['add', repo, '--check', 'node ok.mjs', '--risky', 'src/**']).code, 0);
      confirmGates('repo', env);
      const file = join(env.AMIGO_HOME as string, 'projects.json');
      const projects = JSON.parse(readFileSync(file, 'utf8'));
      delete projects.projects[0].risky;
      writeFileSync(file, JSON.stringify(projects));
      assert.match(cli(env, ['close', id, '--commit', '--self']).err, /were not confirmed by the user/);

      // Confirmed again: it works.
      confirmGates('repo', env);
      assert.equal(cli(env, ['close', id, '--commit', '--self']).code, 0);
      assert.match((lines(env)[0]?.reasons as string[]).join(' | '), /confirmed the project's checks/);
    } finally {
      cleanup(dir);
    }
  });

  it('a human-approved close does not need confirmed gates', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepoWithChecks(join(dir, 'repo'));
      cli(env, ['add', repo, '--check', 'node ok.mjs']);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Small').out);
      await waitFor(id, env, ['done']);
      assert.equal(cli(env, ['close', id, '--commit']).code, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('--self never counts a package.json one-liner, a binary file, or an edit to agent instructions as low risk', async () => {
    const { dir, env } = makeHome();
    try {
      const { id: docs } = await finishedDocsTask(dir, env);
      storeApproval(env);
      assert.equal(cli(env, ['close', docs, '--commit']).code, 0);
      const refusal = async (mode: string): Promise<string> => {
        const id = idFrom(cli(env, ['spawn', '--project', 'repo'], `Title: ${mode}\nMODE:${mode}`).out);
        await waitFor(id, env, ['done']);
        return cli(env, ['close', id, '--commit', '--self']).err;
      };
      assert.match(await refusal('manifest'), /risk is needs-you - touches package\.json \(dependency manifest or lockfile\)/);
      assert.match(await refusal('binary'), /risk is non-trivial - changes a binary file/);
      assert.match(await refusal('instructions'), /it changes more than docs and tests \(agent instruction files never count as docs\)/);
      assert.equal(lines(env).length, 0, 'nothing was self-approved');
    } finally {
      cleanup(dir);
    }
  });

  it('a file that changes between the gate and the commit is not committed under --self', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      storeApproval(env);
      // A clean filter that acts only outside the gate's throw-away index (GIT_INDEX_FILE is set only there): the gate sees
      // the checked work, the commit's own `git add` stages something else.
      const script = join(dir, 'filter.sh');
      writeFileSync(script, '#!/bin/sh\ncat\n[ -z "$GIT_INDEX_FILE" ] && echo sneaky\nexit 0\n');
      git(repo, 'config', 'filter.sneak.clean', `sh "${script.replaceAll('\\', '/')}"`);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), 'notes.md filter=sneak\n');
      const before = git(repo, 'rev-parse', `amigo/${id}`).trim();
      const r = cli(env, ['close', id, '--commit', '--self']);
      assert.equal(r.code, 1);
      assert.match(r.err, /changed after it was checked \(before the commit\), so nothing was committed/);
      assert.equal(git(repo, 'rev-parse', `amigo/${id}`).trim(), before, 'nothing was committed');
      assert.equal(getTask(id, env)?.status, 'done');
      assert.equal(lines(env).length, 0, 'not logged as approved');
    } finally {
      cleanup(dir);
    }
  });

  it('a member-edited .husky hook (core.hooksPath=.husky) never runs at close or push, and .husky/ is needs-you', () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      addOrigin(dir, repo);
      mkdirSync(join(repo, '.husky'));
      writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'husky');
      git(repo, 'config', 'core.hooksPath', '.husky');
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      git(repo, 'checkout', '-q', '-b', 'amigo/t-1');
      // What the squad member wrote: hooks that run with amigo's permissions and would push past every gate.
      const marker = (name: string) => join(dir, name).replaceAll('\\', '/');
      writeFileSync(join(repo, '.husky', 'pre-commit'), `#!/bin/sh\necho ran > "${marker('commit-hook-ran')}"\n`);
      writeFileSync(join(repo, '.husky', 'pre-push'), `#!/bin/sh\necho ran > "${marker('push-hook-ran')}"\n`);

      const snap = snapshot(repo, repo, base);
      assert.equal(assessChanges(snap.changes).level, 'needs-you');
      assert.match(assessChanges(snap.changes).reasons.join(' '), /touches \.husky\/pre-commit \(git hooks or tooling\)/);

      assert.ok(commitAll(repo, repo, 'amigo/t-1', 'x', snap.tree, env));
      assert.equal(existsSync(join(dir, 'commit-hook-ran')), false, 'the pre-commit hook did not run');
      pushBranch(repo, 'amigo/t-1', env);
      assert.equal(existsSync(join(dir, 'push-hook-ran')), false, 'the pre-push hook did not run');
      assert.match(git(repo, 'ls-remote', 'origin', 'refs/heads/amigo/t-1'), /refs\/heads\/amigo\/t-1/, 'the push itself worked');

      // Control: a plain git commit does run the hook, so the checks above prove something.
      writeFileSync(join(repo, 'more.txt'), 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'plain');
      assert.equal(existsSync(join(dir, 'commit-hook-ran')), true);
    } finally {
      cleanup(dir);
    }
  });

  it('commitAll refuses a clean worktree whose HEAD is not the checked work', () => {
    const { dir } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(repo, 'notes.md'), 'checked\n');
      const checked = snapshot(repo, repo, base);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'the checked work');
      assert.equal(commitAll(repo, repo, 'main', 'x', checked.tree), null, 'HEAD is the checked work: nothing to commit, nothing wrong');

      writeFileSync(join(repo, 'notes.md'), 'something else\n');
      git(repo, 'commit', '-q', '-a', '-m', 'unchecked work');
      assert.throws(() => commitAll(repo, repo, 'main', 'x', checked.tree), /changed after it was checked \(the branch does not hold the checked work\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('--self refuses a tests-only change that deletes test lines, and accepts a pure addition', async () => {
    const { dir, env } = makeHome();
    try {
      const repo = makeRepoWithChecks(join(dir, 'repo'));
      mkdirSync(join(repo, 'test'));
      writeFileSync(join(repo, 'test', 'a.test.js'), 'one\ntwo\nthree\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'a test');
      assert.equal(cli(env, ['add', repo, '--check', 'node ok.mjs']).code, 0);
      confirmGates('repo', env);
      storeApproval(env);
      const finished = async (mode: string): Promise<string> => {
        const id = idFrom(cli(env, ['spawn', '--project', 'repo'], `Title: ${mode}\nMODE:${mode}`).out);
        assert.equal((await waitFor(id, env, ['done', 'blocked', 'failed'])).status, 'done');
        return id;
      };
      const weakened = cli(env, ['close', await finished('testedit'), '--commit', '--self']);
      assert.equal(weakened.code, 1);
      assert.match(weakened.err, /a test file that loses a line is not "only tests"/);
      const added = cli(env, ['close', await finished('testadd'), '--commit', '--self']);
      assert.equal(added.code, 0, added.err);
      assert.match(added.out, /Self-approved/);
    } finally {
      cleanup(dir);
    }
  });

  it('a damaged line in approvals.jsonl is skipped with a warning, not a crash', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      storeApproval(env);
      assert.equal(cli(env, ['close', id, '--commit', '--self']).code, 0);
      writeFileSync(approvalsPath(env), `{ half a line\n${readFileSync(approvalsPath(env), 'utf8')}`);
      const undone = cli(env, ['undo', id]);
      assert.equal(undone.code, 0, undone.err);
      assert.match(undone.err, /warning: line 1 of .*approvals\.jsonl is not valid JSON and was skipped/);
      assert.equal(git(repo, 'branch', '--list', `amigo/${id}`).trim(), '');
    } finally {
      cleanup(dir);
    }
  });

  it('commitAll with the checked tree refuses work that changed after the check, and agent instruction files are never only docs', () => {
    const { dir } = makeHome();
    try {
      const repo = makeRepo(join(dir, 'repo'));
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(repo, 'notes.md'), 'checked\n');
      const checked = snapshot(repo, repo, base);
      writeFileSync(join(repo, 'notes.md'), 'changed after the check\n');
      assert.throws(() => commitAll(repo, repo, 'main', 'x', checked.tree), /changed after it was checked \(before the commit\)/);
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), base, 'nothing was committed');
      writeFileSync(join(repo, 'notes.md'), 'checked\n');
      assert.ok(commitAll(repo, repo, 'main', 'x', checked.tree), 'exactly the checked work is committed');

      const globs = ['*.md', 'docs', 'test'];
      const only = (...paths: string[]) => docsOrTestsOnly(paths.map((path) => ({ path, added: 1, removed: 0, deleted: false })), globs);
      assert.ok(only('README.md', 'docs/a.md', 'test/x.ts'));
      for (const p of ['CLAUDE.md', 'sub/AGENTS.md', 'skills/x/SKILL.md', 'prompts/amigo.md', '.claude/settings.json', '.github/PULL_REQUEST_TEMPLATE.md']) assert.equal(only(p), false, p);
    } finally {
      cleanup(dir);
    }
  });
  it('refuses to run git in a worktree whose .git was redirected to a git dir with a program in its config', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      const worktree = getTask(id, env)?.worktree as string;
      const fwd = (p: string) => p.replaceAll('\\', '/');
      // What a hostile squad member can do from inside its worktree: point .git at a git dir of its own whose config names a program.
      const marker = join(dir, 'fsmonitor-ran.txt');
      const script = join(dir, 'fsmonitor.sh');
      writeFileSync(script, `#!/bin/sh
echo ran > "${fwd(marker)}"
`);
      chmodSync(script, 0o755);
      const evil = join(worktree, '.evil');
      git(dir, 'init', '-q', '--bare', evil);
      git(dir, 'config', '-f', join(evil, 'config'), 'core.bare', 'false');
      git(dir, 'config', '-f', join(evil, 'config'), 'core.worktree', fwd(worktree));
      git(dir, 'config', '-f', join(evil, 'config'), 'core.fsmonitor', fwd(script));
      rmSync(join(worktree, '.git'), { force: true }); // git marks it hidden on Windows, which blocks writing over it
      writeFileSync(join(worktree, '.git'), `gitdir: ${fwd(evil)}
`);

      const refused = /worktree .git was changed; refusing to run git in it/;
      const status = cli(env, ['status', id]);
      assert.equal(status.code, 1);
      assert.match(status.err, refused);
      const close = cli(env, ['close', id, '--commit']);
      assert.equal(close.code, 1);
      assert.match(close.err, refused);
      assert.equal(existsSync(marker), false, 'the planted fsmonitor program never ran');
      assert.equal(getTask(id, env)?.status, 'done', 'nothing was closed or committed');
      assert.equal(git(repo, 'rev-list', '--count', `HEAD..amigo/${id}`).trim(), '0', 'no commit landed on the branch');

      // A discard needs no git in the worktree, so it still cleans up.
      const forced = cli(env, ['close', id, '--force']);
      assert.equal(forced.code, 0, forced.err);
      assert.equal(existsSync(worktree), false);
      assert.equal(existsSync(marker), false);
    } finally {
      cleanup(dir);
    }
  });

  it('git never reads a worktree .git: a clean filter planted in a swapped .git does not run, and the guard still refuses', async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, id } = await finishedDocsTask(dir, env);
      const task = getTask(id, env)!;
      const worktree = task.worktree as string;
      const fwd = (p: string) => p.replaceAll('\\', '/');
      assert.equal(task.gitDir, findAdminDir(repo, worktree), 'the git dir is recorded when the worktree is made');
      // The state a squad member can leave in the gap between the guard and git: .git redirected to a git dir whose config has a clean filter.
      const marker = join(dir, 'filter-ran.txt');
      const script = join(dir, 'filter.sh');
      writeFileSync(script, `#!/bin/sh\ncat\necho ran > "${fwd(marker)}"\n`);
      const evil = join(worktree, '.evil');
      git(dir, 'init', '-q', '--bare', evil);
      git(dir, 'config', '-f', join(evil, 'config'), 'core.bare', 'false');
      git(dir, 'config', '-f', join(evil, 'config'), 'core.worktree', fwd(worktree));
      git(dir, 'config', '-f', join(evil, 'config'), 'filter.evil.clean', `sh "${fwd(script)}"`);
      writeFileSync(join(worktree, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(worktree, 'a.txt'), 'changed by the squad member\n');
      rmSync(join(worktree, '.git'), { force: true }); // git marks it hidden on Windows, which blocks writing over it
      writeFileSync(join(worktree, '.git'), `gitdir: ${fwd(evil)}\n`);

      // Control: git told only the folder (what the old code did) follows .git and runs the planted filter.
      run('git', ['-C', worktree, 'add', '-A']);
      assert.equal(existsSync(marker), true, 'the setup is real: reading .git runs the filter');
      rmSync(marker);

      // The git dir is named outright, from the record or (older tasks, no record) from the repo, so .git is never read.
      for (const recorded of [task.gitDir, undefined]) {
        const r = run('git', worktreeGitArgs(repo, worktree, ['add', '-A'], recorded));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(existsSync(marker), false, 'the planted filter never ran');
      }

      const refused = /worktree .git was changed; refusing to run git in it/;
      const status = cli(env, ['status', id]);
      assert.equal(status.code, 1);
      assert.match(status.err, refused);
      const close = cli(env, ['close', id, '--commit']);
      assert.equal(close.code, 1);
      assert.match(close.err, refused);
      assert.equal(existsSync(marker), false);
    } finally {
      cleanup(dir);
    }
  });

  it('spawn refuses a project that was not a git repo when added but is one now, until it is added again', () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'plain');
      mkdirSync(folder);
      writeFileSync(join(folder, 'a.txt'), 'hello\n');
      assert.equal(cli(env, ['add', folder]).code, 0);
      assert.equal(JSON.parse(readFileSync(join(env.AMIGO_HOME as string, 'projects.json'), 'utf8')).projects[0].wasGit, false);
      // What a squad member working in place can do: turn the folder into a repo.
      git(folder, 'init', '-q', '-b', 'main');
      git(folder, 'add', '.');
      git(folder, 'commit', '-q', '-m', 'init');
      const refused = cli(env, ['spawn', '--project', 'plain'], 'Title: x');
      assert.equal(refused.code, 1);
      assert.match(refused.err, /was not a git repo when you added it, but .* is one now/);
      assert.equal(existsSync(join(env.AMIGO_HOME as string, 'worktrees')), false, 'no worktree was created');
      assert.equal(cli(env, ['spawn', '--project', 'plain', '--dry-run'], 'Title: x').code, 1, 'a dry run refuses too');
      assert.equal(cli(env, ['add', folder]).code, 0, 'the user adds it again');
      assert.equal(cli(env, ['spawn', '--project', 'plain', '--dry-run'], 'Title: x').code, 0);
    } finally {
      cleanup(dir);
    }
  });
});
