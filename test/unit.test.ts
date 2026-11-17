import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { armPrompt, greeting, titleOf } from '../src/arms.ts';
import { INLINE_LIMIT, buildLaunch, pointerLine, quoteForCmd, resolveExecutable } from '../src/command.ts';
import { nameFromPath, pickAgent, validateConfig, validateProjects } from '../src/config.ts';
import { HEARTBEAT_MS, beat, newId, parseStatus, runnerAlive, type Task } from '../src/tasks.ts';
import { installSkills, removeSkills } from '../src/skills.ts';
import { TEMPLATES } from '../src/templates.ts';
import { cleanup, makeHome, tmpDir } from './helpers.ts';

const tmp = tmpDir();
after(() => cleanup(tmp));

describe('config', () => {
  it('accepts a valid config and fills in maxArms', () => {
    const c = validateConfig({ agents: { a: { head: ['a', '{prompt}'], arm: ['a', '-p', '{prompt}'] } } });
    assert.equal(c.maxArms, 2);
    assert.equal(pickAgent(c, undefined), 'a');
  });

  it('rejects templates without {prompt}, bad maxArms and an unknown defaultAgent', () => {
    assert.throws(() => validateConfig({ agents: { a: { head: ['a'], arm: ['a', '{prompt}'] } } }), /agents\.a\.head needs a "\{prompt\}"/);
    assert.throws(() => validateConfig({ agents: { a: { head: ['a', '{prompt}'] } } }), /agents\.a\.arm must be/);
    assert.doesNotThrow(() => validateConfig({ agents: { armonly: { arm: ['some-agent', '--message', '{prompt}'] } } }), 'arm-only agents are fine');
    assert.throws(() => validateConfig({ maxArms: 0 }), /maxArms/);
    assert.throws(() => validateConfig({ agents: {}, defaultAgent: 'x' }), /defaultAgent/);
  });

  it('explains what to do when no agent is configured', () => {
    assert.throws(() => pickAgent(validateConfig({}), undefined), /No agent configured yet/);
    assert.throws(() => pickAgent(validateConfig({ agents: { a: { head: ['a', '{prompt}'], arm: ['a', '{prompt}'] } } }), 'b'), /Unknown agent "b"/);
  });

  it('validates projects', () => {
    const abs = join(tmp, 'x');
    assert.deepEqual(validateProjects({ projects: [{ name: 'x', path: abs, notes: 'n' }] }), [{ name: 'x', path: abs, notes: 'n' }]);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', path: 'relative' }] }), /absolute/);
    assert.throws(() => validateProjects({ projects: [{ name: 'x', path: abs }, { name: 'x', path: abs }] }), /twice/);
    assert.throws(() => validateProjects([]), /must look like/);
  });

  it('derives a project name from a folder', () => {
    assert.equal(nameFromPath('/home/sam/My App'), 'my-app');
    assert.equal(nameFromPath('/x/.hidden'), 'hidden');
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

  it('makes ids and titles from the brief', () => {
    assert.equal(newId('Fix the Footer Link!', () => 'ab12'), 'fix-the-footer-link-ab12');
    assert.equal(newId('عنوان', () => 'ab12'), 'task-ab12');
    assert.equal(titleOf('Title: Fix footer\nmore'), 'Fix footer');
    assert.equal(titleOf('# Heading\nmore'), 'Heading');
  });

  it('builds the arm prompt with notes, brief and follow-ups', () => {
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'], summary: 'which color?' } as Task;
    const p = armPrompt(t, 'Title: paint', 'never touch .env');
    for (const part of ['Task id: x-1', 'never touch .env', 'Title: paint', 'which color?', '1. use blue', 'STATUS: done']) assert.ok(p.includes(part), part);
  });
});

describe('greeting', () => {
  it('rotates the line and carries live status', () => {
    const { dir, env } = makeHome(3);
    try {
      const g = greeting(env, () => 0);
      assert.match(g, /^🐙 Tentacles warmed up\.\n0 projects · 3\/3 arms free · inbox: empty$/);
      assert.notEqual(greeting(env, () => 1).split('\n')[0], g.split('\n')[0]);
    } finally {
      cleanup(dir);
    }
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
      const skill = join(userHome, '.claude', 'skills', 'octomaxxing', 'SKILL.md');
      assert.match(readFileSync(skill, 'utf8'), /^---\nname: octomaxxing\n[\s\S]*octomaxxing brief --agent claude/);
      assert.ok(lines.some((l) => l.includes('added its template')));
      assert.deepEqual(JSON.parse(readFileSync(join(env.OCTOMAXXING_HOME as string, 'config.json'), 'utf8')).agents.claude, TEMPLATES.claude);
      assert.ok(!installSkills('claude', env, userHome).some((l) => l.includes('added its template')), 'never adds an agent twice');

      installSkills('codex', env, userHome);
      installSkills('grok', env, userHome);
      const shared = join(userHome, '.agents', 'skills', 'octomaxxing', 'SKILL.md');
      assert.match(readFileSync(shared, 'utf8'), /--agent codex[\s\S]*--agent grok/);
      installSkills('gemini', env, userHome);
      assert.match(readFileSync(join(userHome, '.gemini', 'commands', 'octomaxxing.toml'), 'utf8'), /prompt = """\n[\s\S]*--agent gemini/);

      const foreign = join(userHome, '.gemini', 'config', 'skills', 'octomaxxing', 'SKILL.md');
      mkdirSync(join(foreign, '..'), { recursive: true });
      writeFileSync(foreign, 'someone else');
      assert.throws(() => installSkills('antigravity', env, userHome), /not written by octomaxxing/);

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
      mkdirSync(join(env.OCTOMAXXING_HOME as string, 'tasks', 'hb-1'), { recursive: true });
      assert.equal(runnerAlive('hb-1', env), false);
      beat('hb-1', env);
      assert.equal(runnerAlive('hb-1', env), true);
      assert.equal(runnerAlive('hb-1', env, Date.now() + HEARTBEAT_MS * 5), false);
    } finally {
      cleanup(dir);
    }
  });
});
