import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { armPrompt, boardText, greeting, headPrompt, titleOf } from '../src/arms.ts';
import { INLINE_LIMIT, buildLaunch, pointerLine, quoteForCmd, resolveExecutable } from '../src/command.ts';
import { nameFromPath, pickAgent, validateConfig, validateProjects } from '../src/config.ts';
import { commitAll, looksSecret, porcelainPath } from '../src/git.ts';
import { HEARTBEAT_MS, armNumber, beat, newId, nextArmNumber, parseStatus, resolveId, runnerAlive, saveTask, type Task } from '../src/tasks.ts';
import { installSkills, removeSkills } from '../src/skills.ts';
import { TEMPLATES } from '../src/templates.ts';
import { cleanup, git, makeHome, makeRepo, tmpDir } from './helpers.ts';

const tmp = tmpDir();
after(() => cleanup(tmp));

describe('config', () => {
  it('accepts a valid config and fills in the RAM gate', () => {
    const c = validateConfig({ agents: { a: { head: ['a', '{prompt}'], arm: ['a', '-p', '{prompt}'] } } });
    assert.deepEqual([c.armMb, c.reserveMb], [600, 2048]);
    assert.equal(pickAgent(c, undefined), 'a');
  });

  it('rejects templates without {prompt}, bad RAM numbers, an unknown terminal and an unknown defaultAgent', () => {
    assert.throws(() => validateConfig({ agents: { a: { head: ['a'], arm: ['a', '{prompt}'] } } }), /agents\.a\.head needs a "\{prompt\}"/);
    assert.throws(() => validateConfig({ agents: { a: { head: ['a', '{prompt}'] } } }), /agents\.a\.arm must be/);
    assert.doesNotThrow(() => validateConfig({ agents: { armonly: { arm: ['some-agent', '--message', '{prompt}'] } } }), 'arm-only agents are fine');
    assert.throws(() => validateConfig({ armMb: -1 }), /armMb/);
    assert.throws(() => validateConfig({ reserveMb: 'lots' }), /reserveMb/);
    assert.throws(() => validateConfig({ terminal: 'xterm' }), /terminal/);
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

  it('makes short numbered ids and titles from the brief', () => {
    assert.equal(newId('Fix the Footer Link!', 7), '7-fix-the-footer');
    assert.equal(newId('Internationalization overhaul', 12), '12-internationaliza', 'one long word is cut at 16 letters');
    assert.equal(newId('عنوان', 3), '3');
    assert.equal(armNumber('7-fix-footer'), '7');
    assert.equal(armNumber('2fa-login-ab12cd34'), null, 'old random ids have no number');
    assert.equal(titleOf('Title: Fix footer\nmore'), 'Fix footer');
    assert.equal(titleOf('# Heading\nmore'), 'Heading');
  });

  it('builds the arm prompt with notes, brief and follow-ups', () => {
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'], summary: 'which color?' } as Task;
    const p = armPrompt(t, 'Title: paint', 'never touch .env');
    for (const part of ['Task id: x-1', 'never touch .env', 'Title: paint', 'which color?', '1. use blue', 'STATUS: done']) assert.ok(p.includes(part), part);
    assert.ok(!p.includes('blast radius'), 'only reviewers get the blast-radius check');
  });

  it('gives reviewers the blast-radius check, read-only on production', () => {
    const r = armPrompt({ id: 'r-1', project: 'p', cwd: '/w', followUps: [], reviewOf: 'x-1' } as unknown as Task, 'Title: review', undefined);
    for (const part of ['task x-1', 'blast radius', 'file:line', '**unproven**', 'production', 'STATUS: done']) assert.ok(r.includes(part), part);
  });
});

describe('greeting', () => {
  it('rotates the line and carries live status', () => {
    const { dir, env } = makeHome(3);
    try {
      const g = greeting(env, () => 0);
      assert.match(g, /^🐙 Tentacles warmed up\.\n0 projects · 0 arms running · inbox: empty$/);
      assert.notEqual(greeting(env, () => 1).split('\n')[0], g.split('\n')[0]);
    } finally {
      cleanup(dir);
    }
  });
});

describe('board', () => {
  it('lists open arms, busiest first, and caps the lines', () => {
    const { dir, env } = makeHome();
    try {
      assert.equal(boardText(env), '🐙 no arms');
      const old = new Date(Date.now() - 5 * 60_000).toISOString();
      const task = (id: string, status: Task['status'], extra: Partial<Task> = {}) =>
        saveTask({ id, title: `Task ${id}`, agent: 'fake', status, createdAt: old, updatedAt: old, runs: 1, followUps: [], seen: true, project: 'p', cwd: '/w', repo: null, worktree: null, branch: null, baseSha: null, ...extra } as Task, env);
      task('1-alpha', 'done', { seen: false });
      task('2-beta', 'running', { startedAt: old });
      task('3-gamma', 'queued');
      task('4-delta', 'closed');
      const lines = boardText(env).split('\n');
      assert.equal(lines[0], '🐙 1 running · 1 queued · 1 new result');
      assert.deepEqual(lines.slice(1).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), ['▶ 2', '✓ 1', '… 3'], 'number first; running, then finished, then queued; closed is hidden');
      assert.equal(lines[1], '▶ 2  running  Task 2-beta  [p]  5m');
      const capped = boardText(env, 2).split('\n');
      assert.equal(capped.length, 4);
      assert.equal(capped[3], '  +1 more: octomaxxing status');
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

describe('secret files', () => {
  it('flags secret-looking names but not examples', () => {
    for (const p of ['.env', 'app/.env.local', 'keys\\server.pem', 'id_ed25519', 'config/credentials.json', 'secrets.yaml']) assert.ok(looksSecret(p), p);
    for (const p of ['.env.example', 'src/env.ts', 'README.md', 'keyboard.ts', 'docs/secrets.md']) assert.ok(!looksSecret(p), p);
  });

  it('reads porcelain paths, renames and quotes included', () => {
    assert.equal(porcelainPath('?? .env'), '.env');
    assert.equal(porcelainPath('R  old.txt -> new.pem'), 'new.pem');
    assert.equal(porcelainPath(' M "a b/.env"'), 'a b/.env');
  });

  it('commitAll refuses a worktree with a .env file', () => {
    const dir = tmpDir();
    try {
      const repo = makeRepo(join(dir, 'r'));
      git(repo, 'checkout', '-q', '-b', 'octomaxxing/t-1');
      writeFileSync(join(repo, '.env'), 'TOKEN=fake');
      assert.throws(() => commitAll(repo, 'octomaxxing/t-1', 'm'), /may hold secrets: \.env/);
      assert.equal(git(repo, 'status', '--porcelain').trim(), '?? .env');
    } finally {
      cleanup(dir);
    }
  });
});

describe('arm numbers', () => {
  it('counts up, never reuses a number, and resolves what a person types', () => {
    const { dir, env } = makeHome();
    try {
      assert.equal(nextArmNumber(env), 1);
      const now = new Date().toISOString();
      const task = (id: string, status: Task['status']) =>
        saveTask({ id, title: id, agent: 'fake', status, createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true, project: 'p', cwd: '/w', repo: null, worktree: null, branch: null, baseSha: null } as Task, env);
      task('1-old-work', 'closed');
      task('2-fix-footer', 'running');
      task('fix-login-ab12cd34', 'done');
      assert.equal(nextArmNumber(env), 3, 'closed arms keep their number');
      assert.equal(resolveId('2', env), '2-fix-footer');
      assert.equal(resolveId('1', env), '1-old-work', 'a closed arm still resolves for status');
      assert.equal(resolveId('fix-l', env), 'fix-login-ab12cd34', 'old ids by their start');
      assert.equal(resolveId('2-fix-footer', env), '2-fix-footer');
      assert.throws(() => resolveId('9', env), /No arm matches "9"/);
      task('20-other', 'queued');
      assert.equal(resolveId('2', env), '2-fix-footer', 'a number never matches a longer number');
      task('fix-loop-cd34ef56', 'queued');
      assert.throws(() => resolveId('fix-lo', env), /several arms/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('head instructions', () => {
  it('tell the head to open an arm window when asked to show an arm', () => {
    const { dir, env } = makeHome();
    try {
      const prompt = headPrompt('fake', env);
      assert.match(prompt, /`octomaxxing show <id>`: when the user asks to open, show, see or watch an arm/);
      assert.match(prompt, /Never answer such a request with `status` or `attach`/);
    } finally {
      cleanup(dir);
    }
  });
});
