import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { classifyDone, dodBlock, parseBriefInput, renderBrief } from '../src/delivery.ts';
import { checksNotGreen, verifyMergeable, type PrView } from '../src/pr.ts';
import { declaredWait, describeStatus, formatStatusLine, openItems, parseStatusLine, readStatus, statusFile } from '../src/status.ts';
import { inboxBody, pendingMessages } from '../src/steer.ts';
import { getTask } from '../src/tasks.ts';
import { scan } from '../src/watch.ts';
import { addOrigin, cleanup, cli, cloneOf, fakeGhEnv, ghCalls, git, idFrom, makeHome, makeRepo, releaseHeld, waitFor } from './helpers.ts';

const BRIEF = "Title: Write the file\n## Boss's intent\nwrite the member output file\n## amigo spec\nKeep it to one file.\n";

describe('brief scaffold', () => {
  it('splits the two sections, refusing a missing one, text outside them, a placeholder and an addressed intent', () => {
    assert.deepEqual(parseBriefInput(BRIEF), { title: 'Write the file', intent: 'write the member output file', spec: 'Keep it to one file.' });
    assert.throws(() => parseBriefInput('Title: x\njust do it'), /needs both "## Boss's intent" and "## amigo spec"/);
    assert.throws(() => parseBriefInput("Title: x\nstray words\n## Boss's intent\na\n## amigo spec\nb"), /text before its sections/);
    assert.throws(() => parseBriefInput("## Boss's intent\n{BOSS_INTENT}\n## amigo spec\nb"), /placeholder/);
    assert.throws(() => parseBriefInput("## Boss's intent\nBoss, fix the footer\n## amigo spec\nb"), /without a speaker label or address/);
    assert.equal(parseBriefInput("## Boss's intent\na\n## amigo spec\nb\nDelivery contract: mode=direct-PR").contractMode, 'direct-PR');
  });

  it('renders each mode with its contract line, branch, isolation check, inbox and status rules', () => {
    for (const mode of ['no-mistakes', 'direct-PR', 'local-only'] as const) {
      const text = renderBrief({ id: '3-x', project: 'web', mode, branch: 'amigo/3-x', clone: '/home/projects/web', intent: 'the ask', spec: 'the spec', dataDir: '/d/3-x', statusFile: '/s/3-x/status', inboxDir: '/s/3-x/inbox' });
      assert.match(text, new RegExp(`^Delivery contract: mode=${mode}$`, 'm'));
      assert.match(text, /^Build branch: amigo\/3-x$/m);
      assert.match(text, /## Boss's intent\nthe ask\n## amigo spec\nthe spec\n# Setup/);
      assert.match(text, /Verify isolation before anything else/);
      assert.match(text, /\/s\/3-x\/inbox/);
      assert.match(text, /report <state> "<one short line>"/);
      assert.match(text, /until <YYYY-MM-DDTHH:MMZ>/);
      assert.doesNotMatch(text, /[–—]/, 'no em or en dashes');
      assert.doesNotMatch(text, /captain|firstmate|first mate|crewmate|ahoy|shipshape|\baye\b/i, 'brand words only');
    }
    assert.match(dodBlock('no-mistakes', 'amigo/1'), /NEVER pass `--yes`/);
    assert.match(dodBlock('no-mistakes', 'amigo/1'), /done "PR <url> checks green"/);
    assert.match(dodBlock('direct-PR', 'amigo/1'), /Do NOT run \/no-mistakes/);
    assert.match(dodBlock('local-only', 'amigo/1'), /done "ready in branch amigo\/1"/);
  });

  it('reads what a done line claims, per mode', () => {
    const url = 'https://github.com/o/r/pull/12';
    assert.deepEqual(classifyDone('no-mistakes', 'implemented the fix'), { kind: 'handoff' });
    assert.deepEqual(classifyDone('no-mistakes', `PR ${url} checks green`), { kind: 'pr', url });
    assert.deepEqual(classifyDone('direct-PR', `PR ${url}`), { kind: 'pr', url });
    assert.equal(classifyDone('direct-PR', 'opened PR 12').kind, 'unready');
    assert.deepEqual(classifyDone('local-only', 'ready in branch amigo/1'), { kind: 'branch' });
  });
});

describe('status protocol', () => {
  it('formats and parses lines, tracks open decisions by key, and reads declared waits', () => {
    assert.equal(formatStatusLine('done', 'all\nset', { at: 5 }), 'done [at=5]: all set');
    assert.throws(() => formatStatusLine('celebrating', 'x'), /Unknown status/);
    assert.deepEqual(parseStatusLine('needs-decision [at=10] [key=nm-1-review]: pick one', 3), { state: 'needs-decision', at: 10, key: 'nm-1-review', text: 'pick one', line: 3 });
    assert.equal(parseStatusLine('blocked [at=soon]: x')?.at, null, 'a stamp that is not digits records no time');
    const events = ['needs-decision [at=1] [key=a]: which?', 'blocked [at=2]: stuck', 'done [at=3]: x', 'resolved [at=4] [key=a]: answered']
      .map((l, i) => parseStatusLine(l, i + 1)!);
    assert.deepEqual(openItems(events).map((e) => e.state), ['blocked'], 'a later done does not close anything; only the keyed resolved does');
    assert.match(describeStatus(events) ?? '', /^done: x \(also open: blocked\)/);
    const wait = declaredWait([parseStatusLine('paused [at=9]: CI running until 2026-11-22T10:30Z', 1)!]);
    assert.equal(wait?.until, Date.parse('2026-11-22T10:30Z'));
  });

  it('report is for crew members; a line appended by hand in UTF-16 is still read', () => {
    const { dir, env } = makeHome();
    try {
      assert.match(cli(env, ['report', 'done', 'x']).err, /report is for crew members/);
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Scratch\nMODE:hold').out);
      writeFileSync(statusFile(id, env), Buffer.concat([Buffer.from('working [at=1]: one\n'), Buffer.from('﻿paused [at=2]: two\r\n', 'utf16le')]));
      assert.deepEqual(readStatus(id, env).map((e) => e.state), ['working', 'paused']);
      const r = cli({ ...env, AMIGO_TASK: id }, ['report', 'blocked', '--key', 'k1', 'need', 'help']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /^reported: blocked \[at=\d+\] \[key=k1\]: need help/);
      const t = getTask(id, env)!;
      assert.equal(t.status, 'blocked');
      assert.equal(t.summary, 'need help');
    } finally {
      releaseHeld(env);
      cleanup(dir);
    }
  });
});

describe('steering inbox and control', () => {
  it('send records numbered messages and rings a live terminal; control interrupts and exits; relaunch needs a note', async () => {
    const { dir, env } = makeHome();
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Held\nMODE:hold').out);
      const t = getTask(id, env)!;
      const a = cli(env, ['send', id, 'first', 'message']);
      assert.equal(a.code, 0, a.err);
      assert.match(a.out, /Rang /);
      const b = cli(env, ['send', id, '--resolve-key', 'q1'], 'second\nmessage');
      assert.equal(b.code, 0, b.err);
      assert.match(b.out, /Closed the open item \[q1\]/);
      assert.deepEqual(pendingMessages(id, env).map((m) => [m.name, m.body]), [['001.msg', 'first message'], ['002.msg', 'second\nmessage']]);
      assert.equal(inboxBody('schema=x\nbody-terminator=1\n--\nkeep\n\n'), 'keep\n', 'only the one marked newline goes');
      const input = readFileSync(join(env.AMIGO_HOME as string, 'state', 'test-terminals', `${t.endpoint!.terminal}.input`), 'utf8');
      assert.equal(input.split('\n').filter((l) => l.startsWith('amigo: an instruction is waiting')).length, 2, 'one constant doorbell per message');
      assert.match(readFileSync(statusFile(id, env), 'utf8'), /^resolved \[at=\d+\] \[key=q1\]: answered by amigo: second/m);
      // The crew member acknowledges by moving a message into handled/; numbers are never reused.
      renameSync(join(env.AMIGO_HOME as string, 'state', 'tasks', id, 'inbox', '001.msg'), join(env.AMIGO_HOME as string, 'state', 'tasks', id, 'inbox', 'handled', '001.msg'));
      cli(env, ['send', id, 'third']);
      assert.deepEqual(pendingMessages(id, env).map((m) => m.name), ['002.msg', '003.msg']);

      assert.equal(cli(env, ['control', id, 'interrupt']).code, 0);
      assert.match(readFileSync(join(env.AMIGO_HOME as string, 'state', 'test-terminals', `${t.endpoint!.terminal}.input`), 'utf8'), /<interrupt>/);
      assert.match(cli(env, ['control', id, 'dance']).err, /Unknown control verb/);
      assert.match(cli(env, ['control', id, 'relaunch', '--note', 'x']).err, /still running/);
      const exited = cli(env, ['control', id, 'exit']);
      assert.equal(exited.code, 0, exited.err);
      const stopped = await waitFor(id, env, ['blocked']);
      assert.match(stopped.summary ?? '', /Stopped by amigo \(control exit\)/);
      assert.match(cli({ ...env, AMIGO_TASK: id }, ['send', id, 'x']).err, /only amigo can send/);
    } finally {
      releaseHeld(env);
      cleanup(dir);
    }
  });
});

function prState(head: string, more: Partial<PrView> = {}): PrView {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: head,
    baseRefName: 'main',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-22T10:00:00Z' }],
    ...more,
  };
}

describe('merge checks', () => {
  it('judges a check by its current run and reports every failing condition', () => {
    const run = (conclusion: string, startedAt: string) => ({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion, startedAt });
    assert.deepEqual(checksNotGreen([run('FAILURE', '2026-01-01T00:00:00Z'), run('SUCCESS', '2026-01-01T00:05:00Z')]), [], 'a newer green run supersedes a red one');
    assert.deepEqual(checksNotGreen([run('SUCCESS', '2026-01-01T00:00:00Z'), run('FAILURE', '2026-01-01T00:05:00Z')]), ['ci']);
    assert.deepEqual(checksNotGreen([{ __typename: 'StatusContext', context: 'deploy', state: 'PENDING' }]), ['deploy']);
    const head = 'a'.repeat(40);
    const all = verifyMergeable(prState(head, { isDraft: true, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }), { names: ['lint'], errors: [] }, { expectedHead: 'b'.repeat(40) });
    assert.equal(all.refusals.length, 5, all.refusals.join('\n'));
    assert.ok(verifyMergeable(prState(head, { mergeable: 'UNKNOWN' }), { names: [], errors: [] }).unknownOnly);
    assert.deepEqual(verifyMergeable(prState(head), { names: ['test'], errors: [] }).refusals, []);
  });
});

describe('direct-PR delivery, merge and cleanup', () => {
  it('gates the PR ready line on a pushed head, merges green work with the head pinned under yolo, then refreshes, fast-forwards live and cleans up', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const prFile = join(dir, 'pr.json');
    try {
      const repo = makeRepo(join(dir, 'repo'));
      const bare = addOrigin(dir, repo);
      const live = join(dir, 'live');
      git(dir, 'clone', '-q', bare, live);
      const env = { ...base, ...gh.env, FAKE_GH_PR: prFile, FAKE_GH_ORIGIN: bare, AMIGO_MERGE_RETRY_MS: '50' };
      assert.equal(cli(env, ['add', bare, '--name', 'repo', '--mode', 'direct-PR', '--live', live]).code, 0);
      const clone = cloneOf(env, 'repo');

      // A crew member that reports its PR without pushing is refused, and reads blocked with the reason.
      const unpushed = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Unpushed\nMODE:nopush').out);
      const refused = await waitFor(unpushed, env, ['done', 'blocked', 'failed']);
      assert.equal(refused.status, 'blocked');
      assert.match(refused.summary ?? '', /done refused: your HEAD \w+ exists only in this copy, not on any remote branch/);
      assert.equal(refused.pr, undefined);
      assert.match(cli(env, ['close', unpushed]).err, /has not landed/);
      assert.equal(cli(env, ['close', unpushed, '--force']).code, 0);

      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], BRIEF).out);
      const done = await waitFor(id, env, ['done', 'blocked', 'failed']);
      assert.equal(done.status, 'done', done.summary);
      assert.equal(done.pr, 'https://github.com/example/repo/pull/7');
      const head = git(clone, 'rev-parse', `amigo/${id}`).trim();
      assert.equal(git(bare, 'rev-parse', `amigo/${id}`).trim(), head, 'the crew member pushed its branch');

      // Red, then green: no merge without yolo or the Boss, red refused, a waiver only on the Boss's word.
      writeFileSync(prFile, JSON.stringify(prState(head, { statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-22T10:00:00Z' }] })));
      assert.match(cli(env, ['merge', id]).err, /merges only when the Boss says "merge it"/);
      assert.match(cli(env, ['merge', id, '--boss']).err, /refusing to merge [\s\S]*check 'test' is not green/);
      assert.match(cli(env, ['merge', id, '--allow-red', 'test']).err, /needs a current, explicit instruction from the Boss/);
      assert.equal(cli(env, ['add', bare, '--name', 'repo', '--yolo']).code, 0);
      assert.match(cli(env, ['merge', id, '--expected-head', 'f'.repeat(40)]).err, /not the expected f{40}/);
      assert.equal(getTask(id, env)?.merge, undefined, 'nothing was recorded');

      writeFileSync(prFile, JSON.stringify(prState(head)));
      assert.match(cli(env, ['pr-check', id]).out, /open, CI green, mergeable MERGEABLE/);
      git(repo, 'checkout', '-q', 'main');
      const merged = cli({ ...env, FAKE_GH_UNKNOWN_READS: '1' }, ['merge', id]);
      assert.equal(merged.code, 0, merged.err);
      assert.match(merged.out, new RegExp(`verified: .* green at head ${head}`));
      assert.match(merged.out, /authority: yolo/);
      assert.match(merged.out, /clone: repo: synced/);
      assert.match(merged.out, /live .*: fast-forwarded/);
      assert.match(merged.out, new RegExp(`Closed ${id}\\.`));
      const mergeCall = ghCalls(gh.log).find((c) => c.args[1] === 'merge');
      assert.deepEqual(mergeCall?.args.slice(2), ['https://github.com/example/repo/pull/7', '--squash', '--match-head-commit', head]);
      assert.equal(git(clone, 'rev-parse', 'main').trim(), head, 'the clone was refreshed');
      assert.equal(git(live, 'rev-parse', 'HEAD').trim(), head, 'the live folder was fast-forwarded');
      assert.ok(existsSync(join(live, 'member-output.txt')));
      const t = getTask(id, env)!;
      assert.equal(t.status, 'closed');
      assert.deepEqual([t.merge?.authority, t.merge?.head], ['yolo', head]);
      assert.match(cli(env, ['merge', id]).err, /already merged/);
    } finally {
      cleanup(dir);
    }
  });

  it('a PR merged on GitHub is picked up by pr-check; a dirty live folder is skipped and reported', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const prFile = join(dir, 'pr.json');
    try {
      const repo = makeRepo(join(dir, 'repo'));
      const bare = addOrigin(dir, repo);
      const live = join(dir, 'live');
      git(dir, 'clone', '-q', bare, live);
      writeFileSync(join(live, 'a.txt'), 'local edit\n');
      const env = { ...base, ...gh.env, FAKE_GH_PR: prFile };
      cli(env, ['add', bare, '--name', 'repo', '--mode', 'direct-PR', '--live', live]);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], BRIEF).out);
      assert.equal((await waitFor(id, env, ['done', 'blocked', 'failed'])).status, 'done');
      const head = git(cloneOf(env, 'repo'), 'rev-parse', `amigo/${id}`).trim();
      // Someone squash-merges it on GitHub: main gets the same content in a new commit, and the branch is deleted.
      const other = join(dir, 'other');
      git(dir, 'clone', '-q', bare, other);
      git(other, 'merge', '-q', '--squash', `origin/amigo/${id}`);
      git(other, 'commit', '-q', '-m', 'feat: squashed');
      git(other, 'push', '-q', 'origin', 'main', `:amigo/${id}`);
      writeFileSync(prFile, JSON.stringify(prState(head, { state: 'MERGED' })));
      const r = cli(env, ['pr-check', id]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /merged/);
      assert.match(r.out, /live .*: skipped: uncommitted changes - needs attention/);
      assert.match(r.out, /Landed: /);
      assert.equal(getTask(id, env)?.merge?.authority, 'forge');
      assert.equal(getTask(id, env)?.status, 'closed');
    } finally {
      cleanup(dir);
    }
  });

  it('the watcher reads a recorded PR: running CI is absorbed, red and green wake once each, a merge on GitHub is landed', async () => {
    const { dir, env: base } = makeHome();
    const gh = fakeGhEnv(dir);
    const prFile = join(dir, 'pr.json');
    try {
      const repo = makeRepo(join(dir, 'repo'));
      const bare = addOrigin(dir, repo);
      const env = { ...base, ...gh.env, FAKE_GH_PR: prFile, AMIGO_PR_POLL_SECS: '0', AMIGO_SIGNAL_GRACE_SECS: '0' };
      cli(env, ['add', bare, '--name', 'repo', '--mode', 'direct-PR']);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], BRIEF).out);
      assert.equal((await waitFor(id, env, ['done', 'blocked', 'failed'])).status, 'done');
      const head = git(cloneOf(env, 'repo'), 'rev-parse', `amigo/${id}`).trim();
      // scan runs in this process, so the fake gh it starts inherits this process's environment.
      process.env.FAKE_GH_PR = prFile;
      const prWakes = () => scan(env).filter((w) => w.key === `pr:${id}`).map((w) => w.reason);
      const run = { __typename: 'CheckRun', name: 'test', startedAt: '2026-11-22T10:00:00Z' };
      writeFileSync(prFile, JSON.stringify(prState(head, { statusCheckRollup: [{ ...run, status: 'IN_PROGRESS' }] })));
      assert.deepEqual(prWakes(), [], 'CI still running wakes nobody');
      writeFileSync(prFile, JSON.stringify(prState(head, { statusCheckRollup: [{ ...run, status: 'COMPLETED', conclusion: 'FAILURE' }] })));
      assert.match(prWakes()[0] ?? '', new RegExp(`^check: ${id} PR https://github.com/example/repo/pull/7: open, CI red \\(test\\)`));
      assert.deepEqual(prWakes(), [], 'the same red state wakes once');
      writeFileSync(prFile, JSON.stringify(prState(head)));
      assert.match(prWakes()[0] ?? '', /CI green, mergeable MERGEABLE, .* - ready for the Boss's "merge it"/);
      assert.deepEqual(prWakes(), []);
      // Merged on GitHub: the watcher records it, runs the after-merge steps and the task is closed once landed.
      git(cloneOf(env, 'repo'), 'push', '-q', 'origin', `amigo/${id}:main`);
      writeFileSync(prFile, JSON.stringify(prState(head, { state: 'MERGED' })));
      assert.match(prWakes()[0] ?? '', new RegExp(`merged on GitHub\\. .*Closed ${id}\\.`));
      assert.equal(getTask(id, env)?.merge?.authority, 'forge');
      assert.equal(getTask(id, env)?.status, 'closed');
      assert.deepEqual(prWakes(), [], 'a closed task is no longer read');
    } finally {
      delete process.env.FAKE_GH_PR;
      cleanup(dir);
    }
  });
});
