import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { age, memberPrompt, amigoPrompt, titleOf } from '../src/squad.ts';
import { INLINE_LIMIT, buildLaunch, pointerLine, quoteForCmd, resolveExecutable } from '../src/command.ts';
import { nameFromSource, pickAgent, validateConfig, validateProjects } from '../src/config.ts';
import { HEARTBEAT_MS, memberNumber, beat, newId, nextMemberNumber, parseStatus, resolveId, runnerAlive, saveTask, type Task } from '../src/tasks.ts';
import { installSkills, removeSkills } from '../src/skills.ts';
import { TEMPLATES } from '../src/templates.ts';
import { cleanup, makeHome, tmpDir } from './helpers.ts';

const tmp = tmpDir();
after(() => cleanup(tmp));

describe('config', () => {
  it('accepts a valid config and fills in the memory gate', () => {
    const c = validateConfig({ agents: { a: { amigo: ['a', '{prompt}'], member: ['a', '-p', '{prompt}'] } } });
    assert.deepEqual([c.memberMb, c.reserveMb], [600, 2048]);
    assert.equal(pickAgent(c, undefined), 'a');
  });

  it('rejects templates without {prompt}, bad memory numbers and an unknown defaultAgent', () => {
    assert.throws(() => validateConfig({ agents: { a: { amigo: ['a'], member: ['a', '{prompt}'] } } }), /agents.a.amigo needs a "\{prompt\}"/);
    assert.throws(() => validateConfig({ agents: { a: { amigo: ['a', '{prompt}'] } } }), /agents.a.member must be/);
    assert.doesNotThrow(() => validateConfig({ agents: { memberonly: { member: ['some-agent', '--message', '{prompt}'] } } }), 'member-only agents are fine');
    assert.throws(() => validateConfig({ memberMb: -1 }), /memberMb/);
    assert.throws(() => validateConfig({ reserveMb: 'lots' }), /reserveMb/);
    assert.throws(() => validateConfig({ agents: {}, defaultAgent: 'x' }), /defaultAgent/);
  });

  it('explains what to do when no agent is configured', () => {
    assert.throws(() => pickAgent(validateConfig({}), undefined), /No agent configured yet/);
    assert.throws(() => pickAgent(validateConfig({ agents: { a: { amigo: ['a', '{prompt}'], member: ['a', '{prompt}'] } } }), 'b'), /Unknown agent "b"/);
  });

  it('validates projects', () => {
    const abs = join(tmp, 'x');
    const env = { AMIGO_HOME: abs };
    assert.deepEqual(validateProjects({ projects: [{ name: 'x', source: 'https://example.com/x.git', notes: 'n' }] }, 'p', env), [
      { name: 'x', source: 'https://example.com/x.git', path: join(abs, 'projects', 'x'), mode: 'no-mistakes', yolo: false, branchPrefix: 'amigo/', notes: 'n' },
    ]);
    assert.deepEqual(validateProjects({ projects: [{ name: 'x', source: 's', mode: 'local-only', yolo: true, branchPrefix: '', live: abs }] }, 'p', env)[0], { name: 'x', source: 's', path: join(abs, 'projects', 'x'), mode: 'local-only', yolo: true, branchPrefix: '', live: abs });
    assert.throws(() => validateProjects({ projects: [{ name: 'x' }] }), /needs a "source"/);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', source: 's', mode: 'yolo' }] }), /"mode" must be one of no-mistakes, direct-PR, local-only/);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', source: 's', branchPrefix: 'a b/' }] }), /branchPrefix/);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', source: 's', live: 'relative' }] }), /absolute/);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', source: 's' }, { name: 'x', source: 's' }] }), /twice/);
    assert.throws(() => validateProjects([]), /must look like/);
  });

  it('derives a project name from a clone source', () => {
    assert.equal(nameFromSource('/home/sam/My App'), 'my-app');
    assert.equal(nameFromSource('/x/.hidden'), 'hidden');
    assert.equal(nameFromSource('https://github.com/me/Tripwire.git'), 'tripwire');
    assert.equal(nameFromSource('git@github.com:me/noira-orders.git'), 'noira-orders');
    assert.equal(nameFromSource('C:\\work\\amigo\\'), 'amigo');
  });
});

describe('launching agents', () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const f of ['agent.exe', 'shim.cmd', 'plain']) writeFileSync(join(bin, f), '');
  // Lowercase PATHEXT so the Windows cases also pass on case-sensitive file systems (CI on Linux and macOS).
  const WIN = { PATH: bin, PATHEXT: '.exe;.cmd' };

  it('finds commands on PATH, with PATHEXT on Windows', () => {
    assert.equal(resolveExecutable('agent', WIN, 'win32'), join(bin, 'agent.exe'));
    assert.equal(resolveExecutable('shim', { Path: bin, PATHEXT: '.exe;.cmd' }, 'win32'), join(bin, 'shim.cmd'));
    assert.equal(resolveExecutable('plain', { PATH: bin }, 'linux'), join(bin, 'plain'));
    assert.equal(resolveExecutable('agent', { PATH: bin }, 'linux'), null);
    assert.equal(resolveExecutable('missing', { PATH: bin }, 'linux'), null);
    assert.equal(resolveExecutable(join(bin, 'plain'), {}, 'linux'), join(bin, 'plain'));
  });

  it('passes the prompt inline to a real executable', () => {
    const l = buildLaunch(['agent', '-p', '{prompt}'], { prompt: 'line 1\nline "2"', promptFile: '/p.md' }, WIN, 'win32');
    assert.deepEqual(l.args, ['-p', 'line 1\nline "2"']);
    assert.equal(l.shell, false);
  });

  it('uses a prompt file for Windows .cmd shims and for very long prompts', () => {
    const shim = buildLaunch(['shim', '{prompt}'], { prompt: 'x', promptFile: 'C:\\h\\p.md' }, WIN, 'win32');
    assert.equal(shim.shell, true);
    assert.equal(shim.commandLine, `${quoteForCmd(join(bin, 'shim.cmd'))} "${pointerLine('C:\\h\\p.md')}"`);
    const long = buildLaunch(['plain', '{prompt}'], { prompt: 'x'.repeat(INLINE_LIMIT + 1), promptFile: '/p.md' }, { PATH: bin }, 'linux');
    assert.deepEqual(long.args, [pointerLine('/p.md')]);
  });

  it('fails clearly when the agent is not installed', () => {
    assert.throws(() => buildLaunch(['nope', '{prompt}'], { prompt: 'x', promptFile: '/p' }, { PATH: bin }, 'linux'), /"nope" was not found on PATH/);
  });

  it('quotes for cmd.exe and refuses what cmd.exe would mangle', () => {
    assert.equal(quoteForCmd('plain-token'), 'plain-token');
    assert.equal(quoteForCmd('has space & pipe |'), '"has space & pipe |"');
    assert.throws(() => quoteForCmd('100%'), /cmd\.exe/);
    assert.throws(() => quoteForCmd('a"b'), /cmd\.exe/);
  });
});

describe('tasks', () => {
  it('reads the last STATUS line, tolerating markdown and dashes', () => {
    assert.deepEqual(parseStatus('work\nSTATUS: done - all good'), { status: 'done', summary: 'all good' });
    assert.deepEqual(parseStatus('**STATUS: question** \u2014 which color?'), { status: 'question', summary: 'which color?' });
    assert.deepEqual(parseStatus('STATUS: blocked: need a key\n`STATUS: done - fixed`'), { status: 'done', summary: 'fixed' });
    assert.equal(parseStatus('no status here'), null);
    assert.equal(parseStatus('STATUS: done - <what changed>'), null, 'placeholder lines from an echoed prompt are ignored');
  });

  it('makes short numbered ids and titles from the brief', () => {
    assert.equal(newId('Fix the Footer Link!', 7), '7-fix-the-footer');
    assert.equal(newId('Internationalization overhaul', 12), '12-internationaliza', 'one long word is cut at 16 letters');
    assert.equal(newId('عنوان', 3), '3');
    assert.equal(memberNumber('7-fix-footer'), '7');
    assert.equal(memberNumber('2fa-login-ab12cd34'), null, 'old random ids have no number');
    assert.equal(titleOf('Title: Fix footer\nmore'), 'Fix footer');
    assert.equal(titleOf('# Heading\nmore'), 'Heading');
  });

  it('builds the squad member prompt with notes, brief and follow-ups', () => {
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'], summary: 'which color?' } as Task;
    const p = memberPrompt(t, 'Title: paint', 'never touch .env');
    for (const part of ['Task id: x-1', 'never touch .env', 'Title: paint', 'which color?', '1. use blue', 'STATUS: done']) assert.ok(p.includes(part), part);
    assert.ok(!p.includes('blast radius'), 'only reviewers get the blast-radius check');
  });

  it('gives reviewers the blast-radius check, read-only on production', () => {
    const r = memberPrompt({ id: 'r-1', project: 'p', cwd: '/w', followUps: [], reviewOf: 'x-1' } as unknown as Task, 'Title: review', undefined);
    for (const part of ['task x-1', 'blast radius', 'file:line', '**unproven**', 'production', 'STATUS: done']) assert.ok(r.includes(part), part);
  });
});

describe('squad member ids', () => {
  it('take arm2 and #2 as arm 2', () => {
    const { dir, env } = makeHome();
    try {
      const old = new Date().toISOString();
      saveTask({ id: '2-beta', title: 'Task 2-beta', agent: 'fake', status: 'running', createdAt: old, updatedAt: old, runs: 1, followUps: [], seen: true, project: 'p', cwd: '/w', repo: null, worktree: null, branch: null, baseSha: null } as Task, env);
      assert.equal(resolveId('2', env), '2-beta');
      assert.equal(resolveId('arm2', env), '2-beta');
      assert.equal(resolveId('#2', env), '2-beta');
    } finally {
      cleanup(dir);
    }
  });
});


describe('ages', () => {
  it('shows seconds, minutes and seconds, or hours and minutes', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const at = (s: number) => age(new Date(now - s * 1000).toISOString(), now);
    assert.deepEqual([at(0), at(45), at(59), at(60), at(125), at(3599), at(3600), at(3840), at(90_000)], ['0s', '45s', '59s', '1m 00s', '2m 05s', '59m 59s', '1h 00m', '1h 04m', '25h 00m']);
    assert.equal(age(new Date(now + 60_000).toISOString(), now), '0s', 'a clock running behind never shows a negative age');
  });
});

describe('agent templates and skills', () => {
  it('every built-in template is a valid config entry', () => {
    assert.doesNotThrow(() => validateConfig({ agents: TEMPLATES }));
  });

  it('installs, updates and removes only its own skill files, and adds missing agents to config', () => {
    const { dir, env } = makeHome();
    const userHome = join(dir, 'user');
    try {
      const lines = installSkills('claude', env, userHome);
      const skill = join(userHome, '.claude', 'skills', 'amigo', 'SKILL.md');
      assert.match(readFileSync(skill, 'utf8'), /^---\nname: amigo\n[\s\S]*amigo brief --agent claude/);
      assert.ok(lines.some((l) => l.includes('added its template')));
      assert.deepEqual(JSON.parse(readFileSync(join(env.AMIGO_HOME as string, 'config', 'config.json'), 'utf8')).agents.claude, TEMPLATES.claude);
      assert.ok(!installSkills('claude', env, userHome).some((l) => l.includes('added its template')), 'never adds an agent twice');

      installSkills('codex', env, userHome);
      installSkills('grok', env, userHome);
      const shared = join(userHome, '.agents', 'skills', 'amigo', 'SKILL.md');
      assert.match(readFileSync(shared, 'utf8'), /--agent codex[\s\S]*--agent grok/);
      installSkills('gemini', env, userHome);
      assert.match(readFileSync(join(userHome, '.gemini', 'commands', 'amigo.toml'), 'utf8'), /prompt = """\n[\s\S]*--agent gemini/);

      const foreign = join(userHome, '.gemini', 'config', 'skills', 'amigo', 'SKILL.md');
      mkdirSync(join(foreign, '..'), { recursive: true });
      writeFileSync(foreign, 'someone else');
      assert.throws(() => installSkills('antigravity', env, userHome), /not written by amigo/);

      const removed = removeSkills(undefined, userHome);
      assert.equal(removed.length, 3);
      assert.ok(!existsSync(skill) && !existsSync(shared));
      assert.equal(readFileSync(foreign, 'utf8'), 'someone else', 'foreign files are left alone');
      assert.throws(() => installSkills('some-agent', env, userHome), /No slash command support for "some-agent"/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('runner heartbeat', () => {
  it('counts a runner as alive only while its heartbeat is fresh', () => {
    const { dir, env } = makeHome();
    try {
      mkdirSync(join(env.AMIGO_HOME as string, 'state', 'tasks', 'hb-1'), { recursive: true });
      assert.equal(runnerAlive('hb-1', env), false);
      beat('hb-1', env);
      assert.equal(runnerAlive('hb-1', env), true);
      assert.equal(runnerAlive('hb-1', env, Date.now() + HEARTBEAT_MS * 5), false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('squad member numbers', () => {
  it('counts up, never reuses a number, and resolves what a person types', () => {
    const { dir, env } = makeHome();
    try {
      assert.equal(nextMemberNumber(env), 1);
      const now = new Date().toISOString();
      const task = (id: string, status: Task['status']) =>
        saveTask({ id, title: id, agent: 'fake', status, createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true, project: 'p', cwd: '/w', repo: null, worktree: null, branch: null, baseSha: null } as Task, env);
      task('1-old-work', 'closed');
      task('2-fix-footer', 'running');
      task('fix-login-ab12cd34', 'done');
      assert.equal(nextMemberNumber(env), 3, 'closed squad members keep their number');
      assert.equal(resolveId('2', env), '2-fix-footer');
      assert.equal(resolveId('1', env), '1-old-work', 'a closed squad member still resolves for status');
      assert.equal(resolveId('fix-l', env), 'fix-login-ab12cd34', 'old ids by their start');
      assert.equal(resolveId('2-fix-footer', env), '2-fix-footer');
      assert.throws(() => resolveId('9', env), /No squad member matches "9"/);
      task('20-other', 'queued');
      assert.equal(resolveId('2', env), '2-fix-footer', 'a number never matches a longer number');
      task('fix-loop-cd34ef56', 'queued');
      assert.throws(() => resolveId('fix-lo', env), /several squad members/);
      task('12-numbered', 'running');
      assert.equal(resolveId('arm12', env), '12-numbered', 'arm12 is arm 12 while no old id starts with it');
      task('arm12-deadbeef', 'done');
      assert.equal(resolveId('arm12', env), 'arm12-deadbeef', 'an old id starting with arm12 wins over the arm12 shorthand');
      assert.equal(resolveId('arm12-deadbeef', env), 'arm12-deadbeef');
      assert.equal(resolveId('12', env), '12-numbered', 'the bare number still means squad member 12');
    } finally {
      cleanup(dir);
    }
  });
});

describe('amigo instructions', () => {
  it('say crew members open in herdr-app tabs, with no show or hide commands', () => {
    const { dir, env } = makeHome();
    try {
      const prompt = amigoPrompt('fake', env);
      assert.match(prompt, /Each crew member opens in its own herdr-app tab/);
      assert.doesNotMatch(prompt, /amigo (show|hide|board)|background, with no window/);
    } finally {
      cleanup(dir);
    }
  });

  it('rule 5 lets amigo merge green work under yolo or the Boss word, while gating risky or outward actions on the Boss', () => {
    const { dir, env } = makeHome();
    try {
      const prompt = amigoPrompt('fake', env);
      const rule5 = prompt.split(/\r?\n/).find((line) => line.startsWith('5. '));
      assert.ok(rule5, 'expected rule 5 in amigo instructions');
      assert.doesNotMatch(rule5, /[\u2013\u2014]/, 'rule 5 must not use em or en dashes');
      assert.doesNotMatch(rule5, /Only the user approves anything outward|approves `close --commit` and nothing more/i);
      assert.doesNotMatch(rule5, /reviewer PASS/i);
      assert.match(rule5, /green CI/i);
      assert.match(rule5, /merge.*`?main`?.*yolo.*merge it/i);
      assert.match(rule5, /risky work.*dependencies.*hooks.*auth.*CI\/prod config/i);
      assert.match(rule5, /deploys.*live migrations.*spending money.*messaging people.*Boss/i);
    } finally {
      cleanup(dir);
    }
  });
});

