import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decodeReason, encodeReason, listItems, notDispatchable, parseList, toonCells, versionAtLeast, type BacklogItem } from '../src/backlog.ts';
import { laneVerdict, parseLaneCapacity, parseProjectCapacity, type Vitals } from '../src/capacity.ts';
import { checkDispatch, resolveProfiles, validateDispatch } from '../src/dispatch.ts';
import { answerBoss, holdForBoss } from '../src/holds.ts';
import { resolveExecutable } from '../src/command.ts';
import { getTask, type Task } from '../src/tasks.ts';
import { addOrigin, cleanEnv, cleanup, cli, cloneOf, git, idFrom, makeHome, makeRepo, releaseHeld, startBacklog, tmpDir, waitFor } from './helpers.ts';

const home = (env: NodeJS.ProcessEnv): string => env.AMIGO_HOME as string;

function project(dir: string, env: NodeJS.ProcessEnv, mode?: string): { bare: string; clone: string } {
  const repo = makeRepo(join(dir, 'repo'));
  const bare = addOrigin(dir, repo);
  const added = cli(env, ['add', bare, '--name', 'repo', ...(mode ? ['--mode', mode] : [])]);
  assert.equal(added.code, 0, added.err);
  return { bare, clone: cloneOf(env, 'repo') };
}

const item = (env: NodeJS.ProcessEnv, id: string): BacklogItem | undefined => listItems(env).find((i) => i.id === id);

describe('backlog plumbing', () => {
  it('reads tasks-axi list output, quoted cells and all', () => {
    const out = [
      'count: 3',
      'tasks[3]{id,state,kind,repo,title,hold_kind,hold_reason,hold_until,blocked_by,closed,body}:',
      '  1-fix,in_flight,build,demo,fix footer,"-","-","-",none,"-",""',
      '  2-look,queued,survey,demo,look at x,captain,"Boss: a, or b",2026-12-01,"1-fix,3-x","-","Boss hold set: x\\nline \\"q\\", comma"',
      '  3-x,done,build,"-","title, with \\"quotes\\"","-","-","-",none,2026-11-22,""',
      'help[1]:',
    ].join('\n');
    const [a, b, c] = parseList(out);
    assert.deepEqual([a?.id, a?.state, a?.holdKind, a?.blockedBy, a?.body], ['1-fix', 'in_flight', null, [], '']);
    assert.deepEqual([b?.holdReason, b?.holdUntil, b?.blockedBy, b?.body], ['Boss: a, or b', '2026-12-01', ['1-fix', '3-x'], 'Boss hold set: x\nline "q", comma']);
    assert.deepEqual([c?.title, c?.repo, c?.closed], ['title, with "quotes"', null, '2026-11-22']);
    assert.deepEqual(toonCells('a,"b,c",,d'), ['a', 'b,c', '', 'd']);
  });

  it('encodes a hold reason tasks-axi would refuse, and decodes it back', () => {
    assert.equal(encodeReason('plain reason'), 'plain reason');
    const enc = encodeReason('pick (a) or (b)\nsecond line');
    assert.match(enc, /^amigo-hold-v1:[A-Za-z0-9+/=]+$/);
    assert.equal(decodeReason(enc), 'pick (a) or (b)\nsecond line');
    assert.equal(decodeReason('amigo-hold-v1:not base64!'), 'amigo-hold-v1:not base64!');
  });

  it('compares versions and judges what is dispatchable', () => {
    assert.ok(versionAtLeast('0.2.6', '0.2.6') && versionAtLeast('0.2.10', '0.2.6') && versionAtLeast('1.0.0', '0.2.6'));
    assert.ok(!versionAtLeast('0.2.5', '0.2.6'));
    const base = { kind: 'build', repo: 'r', title: 't', blockedBy: [], holdKind: null, holdReason: null, holdUntil: null, closed: null, body: '' };
    const all: BacklogItem[] = [
      { ...base, id: 'a', state: 'queued' },
      { ...base, id: 'b', state: 'queued', blockedBy: ['a'] },
      { ...base, id: 'c', state: 'queued', holdKind: 'captain', holdReason: 'a or b?' },
      { ...base, id: 'd', state: 'queued', holdKind: 'parked', holdReason: 'later', holdUntil: '2026-01-01' },
      { ...base, id: 'e', state: 'done' },
    ];
    const why = (id: string) => notDispatchable(all.find((i) => i.id === id) as BacklogItem, all, '2026-06-01');
    assert.equal(why('a'), null);
    assert.match(why('b') ?? '', /blocked by a/);
    assert.match(why('c') ?? '', /held for the Boss: a or b\?/);
    assert.equal(why('d'), null, 'a hold whose date has passed no longer stops dispatch');
    assert.match(why('e') ?? '', /Done/);
  });
});

describe('capacity files', () => {
  it('parses lane-capacity strictly', () => {
    assert.deepEqual(parseLaneCapacity('12  # the cap\nmin-avail-gb 5\nadmit-spawns\n'), { cap: 12, minAvailGb: 5, reserveFlags: [], admitSpawns: true });
    assert.equal(parseLaneCapacity('auto\nmax-lanes 16').maxLanes, 16);
    assert.throws(() => parseLaneCapacity(''), /first line must be the cap/);
    assert.throws(() => parseLaneCapacity('many'), /line 1: the cap must be a whole number or auto/);
    assert.throws(() => parseLaneCapacity('4\nmax-lanes 3'), /line 2: "max-lanes" only goes with auto/);
    assert.throws(() => parseLaneCapacity('4\nmin-disk-gb 1\nmin-disk-gb 2'), /line 3: "min-disk-gb" is given twice/);
    assert.throws(() => parseLaneCapacity('4\npressure-file x'), /unknown key "pressure-file"/);
    assert.throws(() => parseLaneCapacity('4\nreserve-flag relative/path'), /absolute or ~\/ path/);
  });

  it('parses project-capacity, comments included', () => {
    const caps = parseProjectCapacity('# heavy suite\nmy project 2\n#repo 3\n#\n# 4\n');
    assert.deepEqual([...caps], [['my project', 2], ['#repo', 3]]);
    assert.throws(() => parseProjectCapacity('repo two'), /line 1: expected/);
    assert.throws(() => parseProjectCapacity('repo 0'), /positive whole number/);
    assert.throws(() => parseProjectCapacity('repo 1\nrepo 2'), /named twice/);
  });

  it('judges a fixed cap and an auto budget', () => {
    const v: Vitals = { availMb: 32_000, totalMb: 64_000, cores: 8, load1: 1, load5: 1, diskFreeMb: 200_000 };
    const lane = (status: Task['status'], startedAt?: string) => ({ status, startedAt }) as Task;
    const fixed = parseLaneCapacity('2');
    assert.deepEqual(laneVerdict(fixed, [lane('running')], v), { admit: true, freeLanes: 1, reasons: [] });
    assert.match(laneVerdict(fixed, [lane('running'), lane('done'), lane('queued')], v).reasons.join(), /full: 2 of 2/);
    assert.match(laneVerdict(fixed, [], { ...v, load1: 9 }).reasons.join(), /cpu/);
    assert.match(laneVerdict(fixed, [], { ...v, diskFreeMb: 1000 }).reasons.join(), /disk/);

    const auto = parseLaneCapacity('auto');
    // memory: (32000 - 6400 kept) / 2048 = 12; cpu: 8 * 0.85 - 1 = 5; disk: (200000 - 10240) / 3072 = 61 -> 5 open
    assert.deepEqual(laneVerdict(auto, [], v), { admit: true, freeLanes: 5, reasons: [] });
    const now = Date.now();
    assert.equal(laneVerdict(auto, [lane('running', new Date(now - 1000).toISOString())], v, now).freeLanes, 4, 'a young lane reserves a full lane');
    assert.match(laneVerdict(auto, [], { ...v, availMb: 7000 }).reasons.join(), /memory: no room/);
    assert.equal(laneVerdict(parseLaneCapacity('auto\nmax-lanes 1'), [lane('running')], v).admit, false);
    assert.match(laneVerdict(auto, [], { ...v, availMb: null }).reasons.join(), /memory: unmeasurable/);
  });
});

describe('dispatch profiles', () => {
  const file = {
    shared_quota: true,
    rules: [{ when: 'design work', use: [{ agent: 'codex', effort: 'high' }, { agent: 'fake', model: 'big', effort: 'xhigh' }], why: 'thinking' }],
    default: { agent: 'fake' },
  };

  it('validates the file and resolves profiles in declared order', () => {
    const d = validateDispatch(file);
    const r = resolveProfiles(d, 0, ['fake']);
    assert.deepEqual(r.candidates.map((c) => c.eligible), [false, true]);
    assert.match(r.candidates[0]?.why ?? '', /agent "codex" is not configured/);
    assert.deepEqual(r.pick, { agent: 'fake', model: 'big', effort: 'xhigh' });
    assert.deepEqual(resolveProfiles(d, 0, ['fake', 'codex']).pick, { agent: 'codex', effort: 'high' });
    assert.throws(() => validateDispatch({ rules: [{ when: 'x', use: [] }] }), /empty profile list/);
    assert.throws(() => validateDispatch({ rules: [{ when: 'x', use: { agent: 'a', effort: 'huge' } }] }), /"effort" must be one of/);
    assert.throws(() => validateDispatch({ shared_quota: 'yes' }), /"shared_quota" must be true or false/);
    assert.throws(() => validateDispatch({ rules: [{ use: { agent: 'a' } }] }), /"when" is required/);
  });

  it('makes every spawn name its agent while the file exists, and keeps max for the Boss', () => {
    const { dir, env } = makeHome();
    try {
      assert.doesNotThrow(() => checkDispatch({}, env), 'no file: nothing required');
      assert.throws(() => checkDispatch({ agent: 'fake', effort: 'max' }, env), /--effort max needs the Boss/);
      assert.doesNotThrow(() => checkDispatch({ agent: 'fake', effort: 'max', bossMax: true }, env));
      writeFileSync(join(home(env), 'config', 'crew-dispatch.json'), JSON.stringify(file));
      const refused = cli(env, ['spawn', '--scratch'], 'do it');
      assert.equal(refused.code, 1);
      assert.match(refused.err, /pass the resolved profile's --agent \(see amigo dispatch\)/);
      const listed = cli(env, ['dispatch']);
      assert.match(listed.out, /1\. when design work\n {5}use codex effort=high \| fake:big effort=xhigh/);
      const one = cli(env, ['dispatch', '1']);
      assert.match(one.out, /candidate: codex effort=high -> not eligible/);
      assert.match(one.out, /profile: --agent fake --model big --effort xhigh/);
      assert.match(cli(env, ['dispatch', 'default']).out, /profile: --agent fake\n.*Effort, when neither/);
      const dry = cli(env, ['spawn', '--scratch', '--agent', 'fake', '--model', 'big', '--effort', 'xhigh', '--dry-run'], 'do it');
      assert.equal(dry.code, 0, dry.err);
      assert.match(dry.out, /agent: {3}fake \(model big, effort xhigh: recorded only, this agent gets no such flags\)/);
      // A Claude Code crew member gets the profile as flags, right after the command.
      const claude = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      writeFileSync(claude, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
      const config = JSON.parse(readFileSync(join(home(env), 'config', 'config.json'), 'utf8'));
      config.agents.claude = { member: [claude, '{prompt}'] };
      writeFileSync(join(home(env), 'config', 'config.json'), JSON.stringify(config));
      const claudeDry = cli(env, ['spawn', '--scratch', '--agent', 'claude', '--model', 'opus', '--effort', 'low', '--dry-run'], 'do it');
      assert.equal(claudeDry.code, 0, claudeDry.err);
      assert.match(claudeDry.out, /claude(\.cmd)?"? --model opus --effort low --name amigo-/);
      writeFileSync(join(home(env), 'config', 'crew-dispatch.json'), '{ broken');
      assert.match(cli(env, ['spawn', '--scratch', '--agent', 'fake'], 'x').err, /crew-dispatch\.json/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('backlog transitions', () => {
  it('a home without data/backlog.md keeps no backlog: spawn and close move nothing', async () => {
    const { dir, env } = makeHome();
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'note').out);
      await waitFor(id, env, ['done']);
      assert.ok(!getTask(id, env)?.backlogItem);
      assert.equal(cli(env, ['close', id]).code, 0);
      assert.ok(!existsSync(join(home(env), 'data', 'backlog.md')));
    } finally {
      cleanup(dir);
    }
  });

  it('spawn adds and starts the item; close moves it to Done with what it delivered', async () => {
    const { dir, env } = makeHome();
    try {
      project(dir, env, 'local-only');
      startBacklog(env);
      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: fix it\nMODE:hold').out);
      await waitFor(id, env, ['running']);
      assert.deepEqual([item(env, id)?.state, item(env, id)?.kind, item(env, id)?.repo], ['in_flight', 'build', 'repo']);
      releaseHeld(env);
      await waitFor(id, env, ['done']);
      assert.match(cli(env, ['close', id]).err, /its work has not landed/, 'unlanded work is not torn down');
      assert.equal(item(env, id)?.state, 'in_flight');
      // The merge lands the branch and its cleanup closes the task, which moves the item.
      const merged = cli(env, ['merge', id, '--boss']);
      assert.equal(merged.code, 0, merged.err);
      assert.match(merged.out, new RegExp(`Backlog: ${id} is Done`));
      assert.equal(item(env, id)?.state, 'done');
      assert.match(item(env, id)?.body ?? '', /committed [0-9a-f]{12} on amigo\//);
    } finally {
      cleanup(dir);
    }
  });

  it('spawn --task dispatches a queued item and refuses a held or blocked one', async () => {
    const { dir, env } = makeHome();
    try {
      project(dir, env);
      startBacklog(env);
      assert.equal(cli(env, ['backlog', 'add', 'readme-fix', 'fix the readme', '--kind', 'build', '--repo', 'repo']).code, 0);
      assert.equal(cli(env, ['backlog', 'add', 'later-one', 'later', '--kind', 'build', '--repo', 'repo', '--blocked-by', 'readme-fix']).code, 0);
      assert.match(cli(env, ['backlog', 'add', 'x', 'y', '--start']).err, /add --start would put an item In flight/);
      assert.match(cli(env, ['backlog', 'list', '--file', 'other.md']).err, /drop --file/);
      assert.match(cli(env, ['spawn', '--task', 'later-one'], 'go').err, /cannot be dispatched: it is blocked by readme-fix/);
      const held = cli(env, ['hold', 'readme-fix', '--reason', 'which readme (old or new)?']);
      assert.equal(held.code, 0, held.err);
      assert.match(cli(env, ['spawn', '--task', 'readme-fix'], 'go').err, /held for the Boss: which readme \(old or new\)\?/);
      const listed = cli(env, ['backlog', 'list', '--fields', 'hold_reason']);
      assert.match(listed.out, /"which readme \(old or new\)\?"/, 'the list shows the decoded reason');
      assert.equal(cli(env, ['answer', 'readme-fix', '--release', 'the new one']).code, 0);
      const spawned = cli(env, ['spawn', '--task', 'readme-fix'], 'MODE:nocommit go');
      assert.equal(spawned.code, 0, spawned.err);
      assert.equal(idFrom(spawned.out), 'readme-fix');
      assert.match(spawned.out, /"fix the readme"/);
      await waitFor('readme-fix', env, ['done']);
      assert.equal(item(env, 'readme-fix')?.state, 'in_flight');
      assert.match(cli(env, ['spawn', '--task', 'readme-fix'], 'again').err, /already In flight/);
      assert.equal(cli(env, ['close', 'readme-fix', '--force']).code, 0);
      assert.equal(item(env, 'readme-fix')?.state, 'done');
      assert.match(item(env, 'readme-fix')?.body ?? '', /discarded/);
      assert.equal(notDispatchable(item(env, 'later-one') as BacklogItem, listItems(env)), null, 'its dependant is ready now');
    } finally {
      cleanup(dir);
    }
  });

  it('a close whose backlog half fails says so loudly and is replayed later', async () => {
    const { dir, env } = makeHome();
    try {
      startBacklog(env);
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'note').out);
      await waitFor(id, env, ['done']);
      const closed = cli({ ...env, FAKE_TASKS_AXI_FAIL: 'done' }, ['close', id]);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, new RegExp(`FAILED to update the backlog item ${id}: .*fake failure of done.*retried`));
      assert.equal(item(env, id)?.state, 'in_flight');
      const next = idFrom(cli(env, ['spawn', '--scratch'], 'note').out);
      assert.equal(item(env, id)?.state, 'done', 'the next spawn finished it');
      await waitFor(next, env, ['done']);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses a tasks-axi older than 0.2.6', () => {
    const { dir, env } = makeHome();
    try {
      startBacklog(env);
      const r = cli({ ...env, FAKE_TASKS_AXI_VERSION: '0.2.5' }, ['spawn', '--scratch'], 'note');
      assert.equal(r.code, 1);
      assert.match(r.err, /tasks-axi 0\.2\.5 is too old: amigo needs 0\.2\.6 or newer/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Boss holds', () => {
  it('hold creates or holds an item, keeps its stamp, defers with --until, and answer records his words', () => {
    const { dir, env } = makeHome();
    try {
      assert.match(cli(env, ['hold', 'pick-db', '--reason', 'postgres or sqlite?']).err, /pass --title/);
      const made = cli(env, ['hold', 'pick-db', '--reason', 'postgres or sqlite?', '--title', 'choose the database', '--project', 'repo']);
      assert.equal(made.code, 0, made.err);
      const first = item(env, 'pick-db') as BacklogItem;
      assert.deepEqual([first.kind, first.repo, first.holdKind, first.holdReason], ['boss', 'repo', 'captain', 'postgres or sqlite?']);
      const stamp = first.body.split('\n')[0];
      assert.match(stamp ?? '', /^Boss hold set: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.equal(cli(env, ['hold', 'pick-db', '--reason', 'later', '--until', '2099-01-01']).code, 0);
      assert.equal(item(env, 'pick-db')?.body.split('\n')[0], stamp, 'repeating an active hold keeps its stamp');
      assert.equal(item(env, 'pick-db')?.holdUntil, '2099-01-01');
      assert.match(cli(env, ['hold', 'pick-db', '--reason', 'x', '--until', 'soon']).err, /YYYY-MM-DD/);
      assert.match(cli(env, ['answer', 'pick-db']).err, /The answer is empty/);
      const answered = cli(env, ['answer', 'pick-db', 'sqlite, keep it simple']);
      assert.equal(answered.code, 0, answered.err);
      const done = item(env, 'pick-db') as BacklogItem;
      assert.equal(done.state, 'done');
      assert.match(done.body, /Resolution recorded by amigo\.\nDecision digest: [0-9a-f]{16}\nResolution mode: answered\nAnswered: .*\n\nBoss decision:\nsqlite, keep it simple/);
      assert.match(cli(env, ['answer', 'pick-db', 'sqlite, keep it simple']).out, /already records this answer/);
      assert.match(cli(env, ['answer', 'pick-db', 'postgres']).err, /already records a different answer/);
      assert.match(cli(env, ['hold', 'pick-db', '--reason', 'again?']).err, /is Done; a closed item is never reopened/);
      assert.equal(cli(env, ['backlog', 'add', 'plain', 'plain work']).code, 0);
      assert.match(cli(env, ['answer', 'plain', 'yes']).err, /never held for the Boss/);
      assert.throws(() => holdForBoss('plain', { reason: 'x', origin: 'plain' }, env), /cannot name itself as its origin/);
      assert.throws(() => answerBoss('plain', 'x'.repeat(9000), {}, env), /over 8192 bytes/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('surveys', () => {
  it('writes its report, never pushes, attests no open call itself, and closes with its report as the deliverable', async () => {
    const { dir, env } = makeHome();
    try {
      const { bare, clone } = project(dir, env);
      startBacklog(env);
      const spawned = cli(env, ['spawn', '--project', 'repo', '--survey'], 'Title: why slow\nMODE:survey');
      assert.equal(spawned.code, 0, spawned.err);
      assert.match(spawned.out, /kind: {4}survey: writes .*report\.md, never pushes/);
      const id = idFrom(spawned.out);
      const t = await waitFor(id, env, ['done']);
      assert.equal(item(env, id)?.kind, 'survey');
      const report = readFileSync(join(home(env), 'data', id, 'report.md'), 'utf8');
      assert.match(report, /push exit [1-9]\d*: .*this is a survey: it never pushes/);
      assert.doesNotMatch(git(bare, 'branch', '--list'), /survey-leak/, 'nothing reached origin');
      assert.match(t.summary ?? '', /complete: exit 0 .*no open Boss call/);
      assert.deepEqual(getTask(id, env)?.decisions?.holds, []);
      assert.notEqual(cli(env, ['close', id, '--commit']).code, 0, 'close takes no --commit');
      const closed = cli(env, ['close', id]);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, /Removed the survey's scratch branch amigo\//);
      assert.equal(git(clone, 'branch', '--list', `amigo/${id}`).trim(), '', 'the scratch branch is gone');
      assert.equal(item(env, id)?.state, 'done');
      assert.ok(existsSync(join(home(env), 'data', id, 'report.md')), 'the report outlives the survey');
    } finally {
      cleanup(dir);
    }
  });

  it('is not torn down until its open Boss calls are held and attested; a held work item survives close', async () => {
    const { dir, env } = makeHome();
    try {
      startBacklog(env);
      const id = idFrom(cli(env, ['spawn', '--scratch', '--survey'], 'Title: compare\nMODE:survey MODE:surveycall').out);
      await waitFor(id, env, ['done']);
      assert.equal(getTask(id, env)?.decisions, undefined, 'the survey did not attest an open call');
      assert.match(cli(env, ['close', id]).err, /has not passed the Boss-call completion gate: its open Boss calls were never inventoried/);
      // a crew member may attest only its own empty inventory
      assert.match(cli({ ...env, AMIGO_TASK: id }, ['complete', id, 'x']).err, /you may only run "complete/);
      assert.match(cli({ ...env, AMIGO_TASK: id }, ['hold', 'x', '--reason', 'y']).err, /only amigo can hold work/);
      assert.match(cli(env, ['complete', id, 'nope']).err, /nope: there is no such backlog item/);
      assert.match(cli(env, ['complete', id, id]).err, /it is the survey itself/);
      // the call gates the survey's own follow-up work: hold that item
      assert.equal(cli(env, ['hold', 'ab-call', '--reason', 'a or b?', '--title', 'a or b', '--origin', id]).code, 0);
      assert.equal(cli(env, ['hold', 'other', '--reason', 'c?', '--title', 'c', '--origin', 'elsewhere']).code, 1, 'an origin must be a task');
      const attested = cli(env, ['complete', id, 'ab-call']);
      assert.equal(attested.code, 0, attested.err);
      assert.match(attested.out, /carried by ab-call/);
      assert.equal(cli(env, ['hold', id, '--reason', 'ship the fix?']).code, 0, 'the survey item itself held for the Boss');
      const closed = cli(env, ['close', id]);
      assert.equal(closed.code, 0, closed.err);
      assert.match(closed.out, new RegExp(`Backlog: ${id} stays open, still held for the Boss`));
      const kept = item(env, id) as BacklogItem;
      assert.deepEqual([kept.state, kept.holdKind], ['queued', 'captain']);
      assert.ok(item(env, 'ab-call')?.holdKind === 'captain', 'the call stays open after the survey is gone');
    } finally {
      cleanup(dir);
    }
  });

  it('--force discards a survey without its report', async () => {
    const { dir, env } = makeHome();
    try {
      startBacklog(env);
      const id = idFrom(cli(env, ['spawn', '--scratch', '--survey'], 'MODE:nocommit nothing').out);
      await waitFor(id, env, ['done']);
      assert.match(cli(env, ['close', id]).err, /is a survey with no report at/);
      assert.equal(cli(env, ['close', id, '--force']).code, 0);
      assert.match(item(env, id)?.body ?? '', /discarded/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('capacity holds spawns back', () => {
  it('a project at its cap keeps the next task queued until a place frees', async () => {
    const { dir, env } = makeHome();
    try {
      project(dir, env);
      writeFileSync(join(home(env), 'config', 'project-capacity'), '# one at a time\nrepo 1\n');
      const a = idFrom(cli(env, ['spawn', '--project', 'repo'], 'MODE:hold MODE:nocommit').out);
      await waitFor(a, env, ['running']);
      const second = cli(env, ['spawn', '--project', 'repo'], 'MODE:nocommit b');
      assert.match(second.out, /Queued \(repo is at its capacity of 1 \(held by .*\); it starts when a place frees\)/);
      const b = idFrom(second.out);
      assert.match(cli(env, ['capacity']).out, new RegExp(`project repo: 1 of 1 \\(${a}\\)`));
      releaseHeld(env);
      await waitFor(a, env, ['done']);
      assert.equal(getTask(b, env)?.status, 'queued', 'a finished task still holds its place until it is closed');
      assert.equal(cli(env, ['close', a, '--force']).code, 0);
      await waitFor(b, env, ['done']);
      writeFileSync(join(home(env), 'config', 'project-capacity'), 'repo many\n');
      assert.match(cli(env, ['spawn', '--project', 'repo'], 'x').err, /Fix the project capacity before spawning/);
      assert.equal(cli(env, ['capacity']).code, 1);
    } finally {
      cleanup(dir);
    }
  });

  it('lane capacity with admit-spawns keeps a crew member queued beyond the cap', async () => {
    const { dir, env: base } = makeHome();
    const env = { ...base, AMIGO_LOAD1: '0', AMIGO_CORES: '8', AMIGO_DISK_FREE_MB: '500000', AMIGO_FREE_MB: '60000' };
    try {
      writeFileSync(join(home(env), 'config', 'lane-capacity'), '1\nadmit-spawns\n');
      const a = idFrom(cli(env, ['spawn', '--scratch'], 'MODE:hold').out);
      await waitFor(a, env, ['running']);
      const second = cli(env, ['spawn', '--scratch'], 'b');
      assert.match(second.out, /Queued \(lane capacity: full: 1 of 1 lanes in use; it starts when a place frees\)/);
      assert.match(cli(env, ['capacity']).out, /^capacity: free_lanes=0 reason=full lanes=1 target=1 load1=0\.00 cores=8 /);
      releaseHeld(env);
      await waitFor(a, env, ['done']);
      assert.equal(cli(env, ['close', a]).code, 0);
      await waitFor(idFrom(second.out), env, ['done']);
      writeFileSync(join(home(env), 'config', 'lane-capacity'), '1\nbogus\n');
      assert.match(cli(env, ['spawn', '--scratch'], 'x').err, /Fix the lane capacity before spawning: .*unknown key "bogus"/);
    } finally {
      cleanup(dir);
    }
  });
});

const realAxi = resolveExecutable('tasks-axi', cleanEnv());

describe('against the real tasks-axi', { skip: realAxi ? false : 'tasks-axi is not installed' }, () => {
  it('reads, holds, answers and closes through the installed tool', () => {
    const dir = tmpDir();
    const env = { ...cleanEnv(), AMIGO_HOME: join(dir, 'home') };
    try {
      mkdirSync(join(dir, 'home', 'data'), { recursive: true });
      holdForBoss('db-call', { reason: 'pick (a) or "b"?\nsecond line', title: 'title, with "quotes"', project: 'repo' }, env);
      const it = listItems(env).find((i) => i.id === 'db-call') as BacklogItem;
      assert.deepEqual([it.title, it.state, it.kind, it.repo, it.holdKind, it.holdReason], ['title, with "quotes"', 'queued', 'boss', 'repo', 'captain', 'pick (a) or "b"?\nsecond line']);
      assert.match(it.body, /^Boss hold set: /);
      answerBoss('db-call', 'b, "obviously"', {}, env);
      const done = listItems(env).find((i) => i.id === 'db-call') as BacklogItem;
      assert.equal(done.state, 'done');
      assert.match(done.body, /Boss decision:\nb, "obviously"/);
      assert.match(readFileSync(join(dir, 'home', 'data', 'backlog.md'), 'utf8'), /## Done/);
    } finally {
      cleanup(dir);
    }
  });
});
