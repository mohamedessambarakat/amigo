import { amigoHooks } from '../src/supervise.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { applyHook, memberPrompt, followUpPrompt, herdrPlacement, leadSessionEnv, startMember, tabEnvArgs } from '../src/squad.ts';
import { INLINE_LIMIT, buildLaunch, pointerLine, quoteForCmd } from '../src/command.ts';
import { loadConfig } from '../src/config.ts';
import { memberSettings, guessTranscriptPath, amigoSettings, claudeMemberNotes, claudeMemberTemplate, claudeAmigoTemplate, claudeJsonPath, dropTrust, isClaude, mergeTrust, ownSessionEnv, reportReason, sessionAddress, turnMessagedAmigo } from '../src/claude.ts';
import { parseVmStat, ramAllows } from '../src/ram.ts';
import { stateDir } from '../src/paths.ts';
import { descendants, run as runCmd } from '../src/proc.ts';
import { beat, saveTask, type Task } from '../src/tasks.ts';
import { TESTED_VERSIONS, ancestry, backendVersionWarnings, herdrLabel, homeTag, installedVersions, insideAppTerminal, tabScript, tabShellLine, terminalBackend, versionWarnings, type Placement } from '../src/terminal.ts';
import type { RunResult } from '../src/proc.ts';
import { cleanup, cli, idFrom, makeHome, makeRepo, releaseHeld, tmpDir, waitFor } from './helpers.ts';

const platform = process.platform;
const scriptName = platform === 'win32' ? 'tab.cmd' : 'tab.sh';

/**
 * A herdr-app (herdr-app and hc) that answers from a list of fake spaces, recording every call. amigo's terminal t1 is in space
 * sp1, and this process shares its console (or tty). Terminals the fake made carry the labels hc label gave them.
 */
function fakeHerdrApp(spaces: string[], opts: { failCreate?: string; failSend?: boolean; failLabel?: boolean; wrongShape?: string[]; noLabel?: boolean; status?: string; closeLeavesLive?: boolean } = {}) {
  const calls: string[][] = [];
  const terminals = new Map<string, { state: string; labels: Record<string, string> }>();
  const ok = (body: unknown): RunResult => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
  const notFound = (t: string): RunResult => ({ status: 3, stdout: JSON.stringify({ error: { kind: 'not_found', message: `no terminal "${t}"` } }), stderr: '' });
  const made = (space: string) => {
    terminals.set(`${space}:t`, { state: 'live', labels: { 'herdr.space': space, 'herdr.tab': `${space}:tb` } });
    return ok({ space, tab: `${space}:tb`, terminal: `${space}:t` });
  };
  const runner = (cmd: string, args: string[]): RunResult => {
    calls.push([cmd, ...args]);
    if (cmd === 'hc') {
      const target = args.find((a, i) => i > 0 && !a.startsWith('-')) ?? '';
      switch (args[0]) {
        case 'get': {
          if (target === 't1') return ok({ address: 't1', state: 'live', pid: 4242, labels: opts.noLabel ? {} : { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } });
          const t = terminals.get(target);
          return t ? ok({ address: target, state: t.state, pid: 5, labels: t.labels, status: opts.status ? { app: 'claude-code', state: opts.status } : null }) : notFound(target);
        }
        case 'label': {
          if (opts.failLabel) return { status: 1, stdout: '', stderr: 'label refused' };
          const t = terminals.get(target);
          if (!t) return notFound(target);
          for (const kv of args.slice(args.indexOf(target) + 1)) t.labels[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
          return ok({ ok: true });
        }
        case 'send':
          if (opts.failSend) return notFound(target);
          return terminals.has(target) ? ok({ started: null, status: null, turn: 0 }) : notFound(target);
        case 'kill': {
          const t = terminals.get(target);
          if (t) t.state = 'finished';
          return t ? ok({ ok: true }) : notFound(target);
        }
        case 'rm':
          return terminals.delete(target) ? ok({ ok: true }) : notFound(target);
        case 'ls': {
          const want = args.filter((_, i) => args[i - 1] === '--label');
          const list = [...terminals.entries()].filter(([, t]) => want.every((kv) => t.labels[kv.slice(0, kv.indexOf('='))] === kv.slice(kv.indexOf('=') + 1)));
          // Like hc: ls filters by label but prints no labels.
          return ok({ hidden_finished: 0, terminals: list.map(([address, t]) => ({ address, state: t.state })) });
        }
        default:
          return ok({});
      }
    }
    // The OS: this test runs inside terminal t1, whose program has pid 4242 (same console, same tty).
    if (cmd === 'powershell.exe') return { status: 0, stdout: `4242 ${process.pid} 4243\r\n${process.pid} 4242 1\r\n`, stderr: '' };
    if (cmd === 'ps') return { status: 0, stdout: `4242 1 pts/3\n${process.pid} 4242 pts/3\n`, stderr: '' };
    assert.equal(cmd, 'herdr-app');
    switch (args[1]) {
      case 'space.new':
        if (opts.failCreate) return { status: 1, stdout: JSON.stringify({ error: opts.failCreate }), stderr: '' };
        if (opts.wrongShape?.includes('new')) return ok({ terminal: 't9' });
        spaces.push('sp9');
        return made('sp9');
      case 'tab.new': {
        const space = args[args.indexOf('--space') + 1] as string;
        if (opts.wrongShape?.includes(space)) return ok({ ok: true });
        return spaces.includes(space) ? made(space) : { status: 1, stdout: JSON.stringify({ error: `no space "${space}"` }), stderr: '' };
      }
      case 'tab.close': {
        const tab = args[args.indexOf('--id') + 1] as string;
        if (!opts.closeLeavesLive) terminals.delete(tab.replace(/:tb$/, ':t'));
        return ok({ ok: true });
      }
      default:
        return ok({ ok: true });
    }
  };
  return { calls, runner, terminals };
}

/** The environment herdr-app gives amigo's shell on Windows: no HERDR_* variable, and no terminal carried yet. */
const appEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, AMIGO_TERMINAL: undefined, HC_TERMINAL_SOCKET: '\\\\.\\pipe\\herdr-core-u-default.sock', HC_TERMINAL_ID: 't1', TERM_PROGRAM: 'ghostty' });

describe('terminal backend selection', () => {
  it('refuses outside herdr-app, saying why, and picks herdr-app inside it', () => {
    const { dir, env } = makeHome();
    try {
      const outside = { ...env, AMIGO_TERMINAL: undefined, HC_TERMINAL_ID: undefined, TERM_PROGRAM: undefined };
      assert.throws(() => terminalBackend(outside), /amigo runs only inside the herdr desktop app \(herdr-app\)[\s\S]*no HC_TERMINAL_ID/);
      assert.throws(() => terminalBackend({ ...appEnv(env), TERM_PROGRAM: 'vscode' }, { insideApp: () => true }), /this terminal is vscode, started from a herdr-app terminal/);
      assert.throws(() => terminalBackend(appEnv(env), { insideApp: () => false }), /does not run in herdr-app terminal t1/);
      assert.equal(terminalBackend(appEnv(env), { insideApp: (id) => id === 't1' }).name, 'herdr-app');
      assert.equal(terminalBackend({ ...appEnv(env), TERM_PROGRAM: undefined }, { insideApp: () => true }).name, 'herdr-app', 'the terminal id alone is enough when this process runs in it');
      assert.equal(terminalBackend({ ...outside, AMIGO_TERMINAL: 'herdr-app' }).name, 'herdr-app', "a crew member's tab keeps the carried backend");
      assert.equal(terminalBackend(env).name, 'test');
      const hung = (): RunResult => ({ status: null, stdout: '', stderr: '', error: new Error('hc get timed out after 3s') });
      assert.throws(() => terminalBackend(appEnv(env), { runner: hung }), /does not run in herdr-app terminal t1 \(hc get t1: hc get timed out after 3s\)/, 'a hung hc is a refusal that names the timeout');
    } finally {
      cleanup(dir);
    }
  });

  it('the bare start, brief and spawn refuse outside herdr-app before they start anything', () => {
    const { dir, env } = makeHome();
    try {
      assert.equal(cli(env, ['add', makeRepo(join(dir, 'p'))]).code, 0);
      const outside = { ...env, AMIGO_TERMINAL: '', HC_TERMINAL_ID: '', TERM_PROGRAM: 'xterm' };
      for (const args of [['--dry-run'], ['brief'], ['spawn', '--project', 'p']]) {
        const r = cli(outside, args, 'Title: x');
        assert.notEqual(r.code, 0, args.join(' '));
        assert.match(r.err, /amigo runs only inside the herdr desktop app \(herdr-app\)/, args.join(' '));
      }
      assert.ok(!existsSync(join(env.AMIGO_HOME as string, 'state', 'tasks')) || readdirSync(join(env.AMIGO_HOME as string, 'state', 'tasks')).length === 0, 'no task was made');
    } finally {
      cleanup(dir);
    }
  });

  /**
   * hc knows t1 (program pid 500). The OS answers like this. Consoles (Windows) and ttys (elsewhere): 500, 700 and 900 share the
   * terminal's; 650 is an agent's shell tool, started by the agent 640 that runs in the terminal, with a console (or tty) of its
   * own; 800 has a console of its own and does not descend from the terminal (it only inherited HC_TERMINAL_ID). Parents: 900
   * and 700 and 640 of 500, 650 of 640, 800 of 7.
   */
  const fakeOs = (hc: object | null, opts: { consoles?: Record<number, string>; ttys?: Record<number, string>; hang?: boolean } = {}) => {
    const calls: string[][] = [];
    const consoles = opts.consoles ?? { 500: '500 700 900 501', 700: '500 700 900 501', 900: '500 700 900 501', 640: '500 700 900 501 640', 650: '650 651', 800: '800 801' };
    const ttys = opts.ttys ?? { 500: 'pts/3', 700: 'pts/3', 900: 'pts/3', 640: 'pts/3', 650: '?', 800: 'pts/7', 600: '?' };
    const parents: Record<number, number> = { 500: 1, 700: 500, 900: 500, 640: 500, 650: 640, 800: 7, 600: 1 };
    const up = (pid: number) => {
      const out = [pid];
      while (parents[out.at(-1)!] && out.length < 10) out.push(parents[out.at(-1)!]!);
      return out;
    };
    const runner = (cmd: string, args: string[]): RunResult => {
      calls.push([cmd, ...args]);
      if (opts.hang) return { status: null, stdout: '', stderr: '', error: new Error(`${cmd} ${args[0]} timed out after 3s`) };
      if (cmd === 'hc') return hc ? { status: 0, stdout: JSON.stringify(hc), stderr: '' } : { status: 3, stdout: JSON.stringify({ error: { message: 'no terminal "t1"' } }), stderr: '' };
      if (cmd === 'powershell.exe') {
        const pid = Number(/AttachConsole\((\d+)\)\)/.exec(args.at(-1)!)?.[1]);
        return { status: 0, stdout: `${consoles[pid] ?? 'none'}\r\n${up(pid).join(' ')}\r\n`, stderr: '' };
      }
      assert.equal(cmd, 'ps');
      return { status: 0, stdout: Object.entries(parents).map(([p, pp]) => `  ${p} ${pp} ${ttys[Number(p)] ?? '?'}\n`).join(''), stderr: '' };
    };
    return { calls, runner };
  };
  const live = { address: 't1', state: 'live', pid: 500, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } };

  it('counts a herdr-app terminal as ours only when it is live, shown by the app, and this process runs in it or descends from it', () => {
    for (const os of ['win32', 'linux'] as const) {
      const f = fakeOs(live);
      assert.equal(insideAppTerminal('t1', f.runner, 900, os), true, `a process in the terminal (${os})`);
      assert.deepEqual(f.calls.map((c) => c[0]), ['hc', os === 'win32' ? 'powershell.exe' : 'ps']);
      assert.equal(insideAppTerminal('t1', fakeOs(live).runner, 500, os), true, 'the terminal program itself');
      assert.equal(insideAppTerminal('t1', fakeOs(live).runner, 650, os), true, "an agent's shell tool, with a console or tty of its own (amigo spawn run by Claude Code)");
      assert.equal(insideAppTerminal('t1', fakeOs(live).runner, 800, os), false, 'a process that only inherited HC_TERMINAL_ID');
      assert.equal(insideAppTerminal('t1', fakeOs({ ...live, state: 'finished' }).runner, 900, os), false, 'a finished terminal');
      assert.equal(insideAppTerminal('t1', fakeOs({ ...live, labels: {} }).runner, 900, os), false, 'a bare hc terminal the app does not show');
      assert.equal(insideAppTerminal('t1', fakeOs(null).runner, 900, os), false, 'herdr-core does not know it (or is not running)');
    }
    assert.equal(insideAppTerminal('t1', fakeOs(live).runner, 123, 'win32'), false, 'an unknown process with no console to attach to');
    assert.equal(insideAppTerminal('t1', fakeOs(live, { ttys: { 500: '?', 600: '?' } }).runner, 600, 'linux'), false, 'no controlling tty on either side is not a shared terminal');
    const ps = fakeOs(live);
    insideAppTerminal('t1', ps.runner, 900, 'win32');
    assert.match(ps.calls[1]!.at(-1)!, /AttachConsole\(900\)/, 'the console asked about is this process');
    assert.match(ps.calls[1]!.at(-1)!, /\[uint32\]900;/, 'the ancestors asked about are this process');
    assert.deepEqual(ancestry(9, new Map([[9, 8], [8, 7], [7, 9]])), [9, 8, 7], 'a parent loop ends the walk');
  });

  it("amigo's own session carries the herdr-app check, so a shell shim that cuts the process chain still rings and closes", () => {
    const lead = leadSessionEnv({ HC_TERMINAL_ID: 't1', TERM_PROGRAM: 'ghostty', AMIGO_HOME: 'h' }, 'herdr-app');
    assert.equal(lead.AMIGO_TERMINAL, 'herdr-app');
    assert.equal(lead.AMIGO_LEAD_SESSION, '1');
    // A command run from the session through Git Bash: its ancestors stop short of the terminal's program.
    const cut = fakeOs(live);
    assert.equal(terminalBackend(lead, { runner: cut.runner, insideApp: (id) => insideAppTerminal(id, cut.runner, 800, 'win32') }).name, 'herdr-app');
    assert.ok(!cut.calls.some((c) => c[0] === 'powershell.exe'), 'the carried check is not repeated');
    assert.throws(() => terminalBackend({ HC_TERMINAL_ID: 't1', TERM_PROGRAM: 'ghostty' }, { runner: cut.runner, insideApp: (id) => insideAppTerminal(id, cut.runner, 800, 'win32') }), /does not run in herdr-app terminal t1/, 'without it the same process is refused');
    assert.equal(leadSessionEnv({ AMIGO_HOME: 'h' }).AMIGO_TERMINAL, undefined, 'nothing is carried when nothing was checked');
  });

  it('every no names its cause, so a refused ring or spawn can be diagnosed', () => {
    const cases: [object | null, number, NodeJS.Platform, RegExp][] = [
      [live, 800, 'win32', /program 500 is neither on this process's console \(800 801\) nor among its ancestors \(800 7\)/],
      [live, 800, 'linux', /program 500 shares no tty with this process and is not among its ancestors \(800 7\)/],
      [{ ...live, state: 'finished' }, 900, 'win32', /terminal t1 is finished/],
      [{ ...live, pid: null }, 900, 'win32', /terminal t1 is live, with no program/],
      [{ ...live, labels: {} }, 900, 'linux', /no herdr\.space label/],
      [null, 900, 'win32', /hc get t1: no terminal "t1"/],
    ];
    for (const [hc, pid, os, want] of cases) {
      const why: string[] = [];
      assert.equal(insideAppTerminal('t1', fakeOs(hc).runner, pid, os, (w) => why.push(w)), false);
      assert.equal(why.length, 1, `one reason for ${want}`);
      assert.match(why[0]!, want);
    }
    const why: string[] = [];
    const queryFails = (cmd: string, args: string[]): RunResult => (cmd === 'hc' ? fakeOs(live).runner(cmd, args) : { status: 1, stdout: '', stderr: 'Get-CimInstance: Quota violation\r\nmore' });
    assert.equal(insideAppTerminal('t1', queryFails, 900, 'win32', (w) => why.push(w)), false);
    assert.deepEqual(why, ['the process query exited 1: Get-CimInstance: Quota violation']);
  });

  it('a hung hc or console query means not inside, and says why', () => {
    const why: string[] = [];
    const hung = fakeOs(live, { hang: true });
    assert.equal(insideAppTerminal('t1', hung.runner, 900, 'win32', (w) => why.push(w)), false);
    assert.deepEqual(hung.calls.map((c) => c[0]), ['hc'], 'no further command after hc timed out');
    assert.deepEqual(why, ['hc get t1: hc get timed out after 3s']);
    let n = 0;
    const consoleHangs = (cmd: string, args: string[]): RunResult => (n++ === 0 ? fakeOs(live).runner(cmd, args) : { status: null, stdout: '', stderr: '', error: new Error('powershell.exe timed out after 3s') });
    why.length = 0;
    assert.equal(insideAppTerminal('t1', consoleHangs, 900, 'win32', (w) => why.push(w)), false);
    assert.deepEqual(why, ['powershell.exe timed out after 3s'], 'a slow cold-start console query is not silent');
  });

  it('run() kills a command that takes longer than its timeout and says so', () => {
    const t0 = Date.now();
    const r = runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
    assert.match(r.error?.message ?? '', /timed out after 0\.3s/);
    assert.equal(runCmd(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5000 }).stdout, 'ok');
  });

  it('warns when the installed herdr-app or hc is not the tested version', () => {
    const versions = (app: string | null, hc: string | null) => (cmd: string): RunResult => {
      const v = cmd === 'herdr-app' ? app : hc;
      return v ? { status: 0, stdout: `${v}\n`, stderr: '' } : { status: null, stdout: '', stderr: '', error: new Error(`spawn ${cmd} ENOENT`) };
    };
    const tested = versions(`herdr-app ${TESTED_VERSIONS['herdr-app']}`, `hc ${TESTED_VERSIONS.hc}`);
    assert.deepEqual(installedVersions(tested), TESTED_VERSIONS);
    assert.deepEqual(versionWarnings(tested), []);
    const drift = versionWarnings(versions('herdr-app 0.2.0', `hc ${TESTED_VERSIONS.hc}`));
    assert.deepEqual(drift, [`herdr-app 0.2.0 is installed, but amigo was tested with ${TESTED_VERSIONS['herdr-app']}: crew member tabs may misbehave until amigo is checked against it.`]);
    const missing = versionWarnings(versions(`herdr-app ${TESTED_VERSIONS['herdr-app']}`, null));
    assert.equal(missing.length, 1);
    assert.match(missing[0]!, /^hc did not report its version/);
    assert.deepEqual(backendVersionWarnings({ AMIGO_TERMINAL: 'test' }, versions('herdr-app 9.9.9', 'hc 9.9.9')), [], 'the test fake has no version');
    assert.equal(backendVersionWarnings({}, versions('herdr-app 9.9.9', 'hc 9.9.9')).length, 2);
  });
});

describe('crew member tabs', () => {
  it('quotes the tab script for cmd.exe and sh, and never waits for a key', () => {
    const win = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\oct\\src\\cli.ts', '_tab', 'x-1'];
    assert.equal(tabScript(win, 'win32'), '@echo off\r\nchcp 65001 >nul\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\oct\\src\\cli.ts _tab x-1\r\n');
    assert.throws(() => tabScript(['C:\\100%\\node.exe'], 'win32'), /\.cmd file/);
    assert.equal(tabScript(['/usr/bin/node', "/oct/it's/cli.ts", '_tab', 'x-1'], 'darwin'), "#!/bin/sh\n'/usr/bin/node' '/oct/it'\\''s/cli.ts' '_tab' 'x-1'\n");
    assert.equal(tabShellLine("C:\\h\\it's\\tab.cmd", 'win32'), "& 'C:\\h\\it''s\\tab.cmd'; exit");
    assert.equal(tabShellLine("/h/it's/tab.sh", 'linux'), "sh '/h/it'\\''s/tab.sh'; exit");
    const waits = /pause|Read-Host|read -r|Press Enter|any key/i;
    for (const os of ['win32', 'darwin', 'linux'] as const) assert.doesNotMatch(tabScript(win, os) + tabShellLine('/x', os), waits);
  });

  it('carries AMIGO_* settings into the tab, which does not inherit this environment', () => {
    assert.deepEqual(tabEnvArgs({ AMIGO_TERMINAL: 'herdr-app', AMIGO_HOME: '/h', AMIGO_TASK: 'x', AMIGO_FREE_MB: '', PATH: '/bin' }), ['--env', 'AMIGO_TERMINAL=herdr-app']);
    assert.deepEqual(tabEnvArgs({ AMIGO_TERMINAL: 'herdr-app', AMIGO_HERDR_SPACE: 'sp1' }), ['--env', 'AMIGO_TERMINAL=herdr-app', '--env', 'AMIGO_HERDR_SPACE=sp1']);
  });

  it('labels a tab with the id and a title cut to about 40 characters', () => {
    assert.equal(herdrLabel('7-fix-footer', 'Fix the footer'), '7-fix-footer · Fix the footer');
    const long = herdrLabel('12-fix-footer', 'Fix the broken footer link on the pricing page and the blog');
    assert.ok(long.length <= 40 && long.startsWith('12-fix-footer · Fix the broken') && long.endsWith('…'), long);
    assert.equal(herdrLabel('3', 'two\nlines   here'), '3 · two lines here');
  });

  it('places crew members: own space for a worktree, else beside the reviewed crew member, else amigo', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      const task = (id: string, more: Partial<Task>): Task => ({ id, title: 'Fix the footer', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true, ...more });
      mkdirSync(join(home, 'state', 'tasks', '1-a'), { recursive: true });
      saveTask(task('1-a', { endpoint: { backend: 'herdr-app', task: '1-a', space: 'sp4', tab: 'tb4', terminal: 't4' } }), env);
      assert.deepEqual(herdrPlacement(task('2-b', { worktree: '/w/2-b' }), env, 'sp1'), { label: '2-b · Fix the footer', ownSpace: true, spaces: ['sp1'] });
      assert.deepEqual(herdrPlacement(task('3-c', {}), env, 'sp1'), { label: '3-c · Fix the footer', ownSpace: false, spaces: ['sp1'] });
      assert.deepEqual(herdrPlacement(task('4-d', { reviewOf: '1-a' }), env, 'sp1').spaces, ['sp4', 'sp1']);
      assert.deepEqual(herdrPlacement(task('5-e', { reviewOf: '1-a' }), env, 'sp4').spaces, ['sp4'], 'the same space is tried once');
      assert.deepEqual(herdrPlacement(task('6-f', { reviewOf: '1-a' }), env, null).spaces, ['sp4'], 'no amigo space known');
    } finally {
      cleanup(dir);
    }
  });
});

describe('herdr-app backend', () => {
  const label = '7-fix-footer · Fix the footer';
  const testHome = join(os.tmpdir(), 'amigo-herdr-app-test');
  const backendFor = (h: { runner: (cmd: string, args: string[]) => RunResult }, env: NodeJS.ProcessEnv = { AMIGO_HOME: testHome, AMIGO_TERMINAL: 'herdr-app', HC_TERMINAL_ID: 't1' }) => terminalBackend(env, { runner: h.runner });
  const tag = homeTag({ AMIGO_HOME: testHome });
  const open = (spaces: string[], placement: Placement, opts?: Parameters<typeof fakeHerdrApp>[1]) => {
    const dir = tmpDir();
    const h = fakeHerdrApp(spaces, opts);
    try {
      const ep = backendFor(h).open({ task: '7-fix-footer', cwd: dir, argv: [process.execPath, 'cli.ts', '_tab', '7-fix-footer'], dir, env: {}, placement });
      return { ...h, ep, line: tabShellLine(join(dir, scriptName), platform), cwd: dir, written: readdirSync(dir) };
    } finally {
      cleanup(dir);
    }
  };

  it('puts a crew member with a worktree in a space of its own, unfocused, labels its terminal and types the script into its shell', () => {
    const r = open(['sp1'], { label, ownSpace: true, spaces: ['sp1'] });
    assert.deepEqual(r.calls, [
      ['herdr-app', 'do', 'space.new', '--name', label, '--tab', label, '--folder', r.cwd, '--focus', 'false'],
      ['hc', 'label', '--json', 'sp9:t', 'amigo.task=7-fix-footer', `amigo.home=${tag}`],
      ['hc', 'send', '--json', 'sp9:t', r.line],
    ]);
    assert.deepEqual(r.ep, { backend: 'herdr-app', task: '7-fix-footer', space: 'sp9', tab: 'sp9:tb', terminal: 'sp9:t' });
    assert.deepEqual(r.written, [scriptName]);
  });

  it("puts a crew member without a worktree in a tab of amigo's space, unfocused", () => {
    const r = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] });
    assert.deepEqual(r.calls[0], ['herdr-app', 'do', 'tab.new', '--space', 'sp1', '--name', label, '--folder', r.cwd, '--focus', 'false']);
    assert.equal(r.ep.space, 'sp1');
  });

  it('tries the next space only when the app says a space is gone, else opens a new one', () => {
    const place = { label, ownSpace: false, spaces: ['sp4', 'sp1'] };
    const gone = open(['sp1'], place);
    assert.equal(gone.ep.space, 'sp1', '"no space sp4" falls through to the next space');
    assert.deepEqual(gone.calls.map((c) => c.slice(0, c[0] === 'hc' ? 2 : 5).join(' ')), ['herdr-app do tab.new --space sp4', 'herdr-app do tab.new --space sp1', 'hc label', 'hc send']);
    assert.throws(() => open(['sp4', 'sp1'], place, { wrongShape: ['sp4'] }), /Could not open a herdr-app tab for the crew member: unexpected answer/, 'an odd answer may have made a tab: no second one');
    const none = open([], place);
    assert.equal(none.ep.space, 'sp9');
    assert.deepEqual(none.calls.map((c) => c.slice(0, 3).join(' ')), ['herdr-app do tab.new', 'herdr-app do tab.new', 'herdr-app do space.new', 'hc label --json', 'hc send --json']);
    assert.throws(() => open([], place, { wrongShape: ['new'] }), /Could not open a herdr-app space for the crew member: unexpected answer/);
  });

  it("fails with the app's own message, and closes the tab it made when the terminal cannot be labelled or started", () => {
    assert.throws(() => open([], { label, ownSpace: true, spaces: [] }, { failCreate: 'no window open' }), /Could not open a herdr-app space for the crew member: no window open/);
    for (const [opts, why] of [[{ failSend: true }, /\(hc send\): no terminal "sp1:t"/], [{ failLabel: true }, /\(hc label\): label refused/]] as const) {
      const dir = tmpDir();
      const h = fakeHerdrApp(['sp1'], opts);
      try {
        assert.throws(() => backendFor(h).open({ task: '7-fix-footer', cwd: dir, argv: ['node'], dir, env: {}, placement: { label, ownSpace: false, spaces: ['sp1'] } }), why);
        assert.deepEqual(h.calls.at(-1), ['herdr-app', 'do', 'tab.close', '--id', 'sp1:tb', '--confirmed', 'true']);
      } finally {
        cleanup(dir);
      }
    }
  });

  it('fails the crew member loudly when herdr-app or hc times out while its tab opens', () => {
    const timedOut = (what: string): RunResult => ({ status: null, stdout: '', stderr: '', error: new Error(`${what} timed out after 3s`) });
    const dir = tmpDir();
    try {
      const h = fakeHerdrApp(['sp1']);
      const appHangs = (cmd: string, args: string[]): RunResult => (cmd === 'herdr-app' && args[1] !== 'tab.close' ? (h.calls.push([cmd, ...args]), timedOut('herdr-app do')) : h.runner(cmd, args));
      assert.throws(() => backendFor({ runner: appHangs }).open({ task: 'x', cwd: dir, argv: ['node'], dir, env: {}, placement: { label, ownSpace: false, spaces: ['sp4', 'sp1'] } }), /Could not open a herdr-app tab for the crew member: herdr-app do timed out after 3s/);
      assert.deepEqual(h.calls.map((c) => c.slice(0, 5).join(' ')), ['herdr-app do tab.new --space sp4'], 'one tab.new, then a clear error: no other space, no space.new (the slow app may still make that tab)');
      const h2 = fakeHerdrApp(['sp1']);
      const sendHangs = (cmd: string, args: string[]): RunResult => (cmd === 'hc' && args[0] === 'send' ? (h2.calls.push([cmd, ...args]), timedOut('hc send')) : h2.runner(cmd, args));
      assert.throws(() => backendFor({ runner: sendHangs }).open({ task: 'x', cwd: dir, argv: ['node'], dir, env: {}, placement: { label, ownSpace: true, spaces: [] } }), /Could not start the crew member in its herdr-app tab \(hc send\): hc send timed out after 3s/);
      assert.deepEqual(h2.calls.at(-1), ['herdr-app', 'do', 'tab.close', '--id', 'sp9:tb', '--confirmed', 'true'], 'the tab it made is closed again');
    } finally {
      cleanup(dir);
    }
  });

  it("finds amigo's space from the label herdr-core gives its terminal, unless one is carried", () => {
    const h = fakeHerdrApp([]);
    assert.equal(backendFor(h).amigoSpace(), 'sp1');
    assert.deepEqual(h.calls, [['hc', 'get', 't1', '--json']]);
    assert.equal(backendFor(h, { AMIGO_TERMINAL: 'herdr-app', HC_TERMINAL_ID: 't7', AMIGO_HERDR_SPACE: 'sp4' }).amigoSpace(), 'sp4');
    assert.equal(backendFor(fakeHerdrApp([], { noLabel: true })).amigoSpace(), null);
    assert.equal(backendFor(h, { AMIGO_TERMINAL: 'herdr-app' }).amigoSpace(), null);
    const warned: string[] = [];
    const hung = (): RunResult => ({ status: null, stdout: '', stderr: '', error: new Error('hc get timed out after 3s') });
    assert.equal(terminalBackend({ AMIGO_TERMINAL: 'herdr-app', HC_TERMINAL_ID: 't1' }, { runner: hung, warn: (l) => warned.push(l) }).amigoSpace(), null);
    assert.match(warned.join('\n'), /could not find the herdr-app space of terminal t1 \(hc get timed out after 3s\)/);
  });

  it("reads a terminal's liveness and busy state, and never touches a terminal without this task's labels", () => {
    const r = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] }, { status: 'working' });
    const b = backendFor(r);
    assert.deepEqual(b.state(r.ep), { liveness: 'live', busy: 'busy' });
    for (const [status, busy] of [['idle', 'idle'], ['done', 'idle'], ['blocked', 'unknown']] as const) {
      const s = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] }, { status });
      assert.equal(backendFor(s).state(s.ep).busy, busy, status);
    }
    assert.deepEqual(b.state({ ...r.ep, terminal: 't404' }), { liveness: 'absent', busy: 'unknown' });
    const other = { ...r.ep, task: '8-other' };
    assert.deepEqual(b.state(other), { liveness: 'foreign', busy: 'unknown' });
    assert.throws(() => b.send(other, 'hi'), /Cannot send to 8-other: its terminal sp1:t is foreign/);
    assert.throws(() => b.close(other), /does not carry 8-other's labels/);
    const otherHome = terminalBackend({ AMIGO_HOME: join(os.tmpdir(), 'another-home'), AMIGO_TERMINAL: 'herdr-app' }, { runner: r.runner });
    assert.equal(otherHome.state(r.ep).liveness, 'foreign', 'the same task id in another home is not ours');
    const unreadable = backendFor({ runner: () => ({ status: 1, stdout: '', stderr: 'core down' }) });
    assert.equal(unreadable.state(r.ep).liveness, 'unreadable');
    assert.throws(() => unreadable.close(r.ep), /could not be read, so it was not closed/);
  });

  it('sends a line with hc send, guarding flag-looking text', () => {
    const r = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] });
    r.calls.length = 0;
    backendFor(r).send(r.ep, '--help me');
    assert.deepEqual(r.calls.at(-1), ['hc', 'send', '--json', 'sp1:t', '--', '--help me']);
  });

  it('closes a tab through the app and proves the terminal is gone, also when only hc can end it', () => {
    const r = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] });
    const b = backendFor(r);
    r.calls.length = 0;
    b.close(r.ep);
    assert.equal(b.state(r.ep).liveness, 'absent');
    assert.deepEqual(r.calls.filter((c) => c[0] === 'herdr-app' || c[1] === 'kill' || c[1] === 'rm').map((c) => c.slice(0, 3).join(' ')), ['herdr-app do tab.close']);
    b.close(r.ep);
    const stuck = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] }, { closeLeavesLive: true });
    backendFor(stuck).close(stuck.ep);
    assert.deepEqual(stuck.calls.filter((c) => c[1] === 'kill' || c[1] === 'rm').map((c) => c[1]), ['kill', 'rm'], 'a terminal the app left running is killed and removed');
    assert.equal(stuck.terminals.size, 0);
  });

  it("lists this home's crew member terminals by their labels", () => {
    const r = open(['sp1'], { label, ownSpace: false, spaces: ['sp1'] });
    r.terminals.set('t77', { state: 'live', labels: { 'amigo.task': '9-x', 'amigo.home': 'amigo-someone-else' } });
    assert.deepEqual(backendFor(r).list(), [{ task: '7-fix-footer', terminal: 'sp1:t', space: 'sp1', tab: 'sp1:tb', liveness: 'live' }]);
  });

  it('starting a crew member with the reported herdr-app env opens a worktree crew member in a new space, any other in a tab of the amigo space', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      const start = (id: string, worktree: string | null) => {
        mkdirSync(join(home, 'state', 'tasks', id), { recursive: true });
        mkdirSync(join(home, 'data', id), { recursive: true });
        writeFileSync(join(home, 'data', id, 'brief.md'), 'Title: g\n');
        const t: Task = { id, title: 'g', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree, branch: null, baseSha: null, status: 'queued', createdAt: now, updatedAt: now, runs: 0, followUps: [], seen: true };
        saveTask(t, env);
        const h = fakeHerdrApp(['sp1']);
        assert.equal(startMember(t, loadConfig(appEnv(env)), appEnv(env), h.runner), true);
        const saved = JSON.parse(readFileSync(join(home, 'state', 'tasks', id, 'task.json'), 'utf8')) as Task;
        const script = readFileSync(join(home, 'state', 'tasks', id, scriptName), 'utf8');
        return { calls: h.calls.filter((c) => c[0] === 'hc' || c[0] === 'herdr-app').map((c) => c.slice(0, c[0] === 'hc' ? 2 : 5).join(' ')), saved, script };
      };
      const own = start('8-w', join(dir, 'wt'));
      assert.deepEqual(own.calls, ['hc get', 'hc get', 'herdr-app do space.new --name 8-w · g', 'hc label', 'hc send']);
      assert.equal(own.saved.status, 'running');
      assert.deepEqual(own.saved.endpoint, { backend: 'herdr-app', task: '8-w', space: 'sp9', tab: 'sp9:tb', terminal: 'sp9:t' });
      assert.match(own.script, /AMIGO_TERMINAL=herdr-app/);
      assert.match(own.script, /AMIGO_HERDR_SPACE=sp1/, 'queued crew members started from this tab still know the amigo space');
      const tab = start('9-t', null);
      assert.deepEqual(tab.calls, ['hc get', 'hc get', 'herdr-app do tab.new --space sp1', 'hc label', 'hc send']);
      assert.equal(tab.saved.endpoint?.space, 'sp1');
    } finally {
      cleanup(dir);
    }
  });

  it('relaunches a Claude session killed before its transcript was written as a new session from the brief, and resumes one that has it', () => {
    const { dir, env } = makeHome(0, ['claude', '{prompt}']);
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      const relaunch = (id: string, transcript: string) => {
        mkdirSync(join(home, 'state', 'tasks', id), { recursive: true });
        mkdirSync(join(home, 'data', id), { recursive: true });
        writeFileSync(join(home, 'data', id, 'brief.md'), 'Title: g\nDo the thing.\n');
        const t: Task = { id, title: 'g', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'blocked', createdAt: now, updatedAt: now, runs: 1, followUps: ['start from the top'], followUpsSent: 0, seen: true, sessionId: 'S-old', sessionStarted: true, transcriptPath: transcript, summary: 'The crew member stopped without reporting: its tab closed or never opened (see amigo attach).' };
        saveTask(t, env);
        assert.equal(startMember(t, loadConfig(appEnv(env)), appEnv(env), fakeHerdrApp(['sp1']).runner), true);
        const saved = JSON.parse(readFileSync(join(home, 'state', 'tasks', id, 'task.json'), 'utf8')) as Task;
        return { saved, prompt: readFileSync(join(home, 'state', 'tasks', id, 'prompt.md'), 'utf8') };
      };
      const gone = relaunch('5-gone', join(dir, 'projects', 'x', 'S-old.jsonl'));
      assert.notEqual(gone.saved.sessionId, 'S-old', 'a new session id: --resume of the old one would exit at once');
      assert.deepEqual([gone.saved.status, gone.saved.sessionStarted, gone.saved.transcriptPath, gone.saved.runs], ['running', false, null, 2]);
      assert.match(gone.prompt, /## Brief\n\nTitle: g\nDo the thing\.[\s\S]*## Follow-ups from amigo \(newest last\)\n\n1\. start from the top/);
      assert.match(readFileSync(join(home, 'state', 'tasks', '5-gone', 'output.log'), 'utf8'), /session S-old left no transcript to resume, so run 2 starts a new session/);

      const kept = join(dir, 'S-kept.jsonl');
      writeFileSync(kept, '{}\n');
      const resumed = relaunch('6-kept', kept);
      assert.deepEqual([resumed.saved.sessionId, resumed.saved.sessionStarted, resumed.saved.transcriptPath], ['S-old', true, kept]);
      assert.match(resumed.prompt, /^Follow-up from amigo:\n\nstart from the top\n/);
    } finally {
      cleanup(dir);
    }
  });

  it('close removes the terminal of every run, not only the last one', async () => {
    const { dir, env } = makeHome();
    try {
      const id = idFrom(cli(env, ['spawn', '--scratch'], 'Title: Ask first\nMODE:question\nDone when: a file exists').out);
      assert.equal((await waitFor(id, env, ['question'])).status, 'question');
      const backend = terminalBackend(env);
      const mine = () => backend.list().filter((e) => e.task === id);
      const settled = async (n: number) => {
        for (let i = 0; i < 300 && !(mine().length === n && mine().every((e) => e.liveness === 'finished')); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(mine().filter((e) => e.liveness === 'finished').length, n, `${n} finished terminal(s) of ${id}`);
      };
      await settled(1);
      assert.equal(cli(env, ['control', id, 'relaunch', '--note', 'use blue']).code, 0);
      assert.equal((await waitFor(id, env, ['done'])).status, 'done');
      await settled(2);
      const closed = cli(env, ['close', id]);
      assert.equal(closed.code, 0, closed.err);
      assert.deepEqual(mine(), [], 'the first run\'s terminal went too');
    } finally {
      cleanup(dir);
    }
  });

  it('a crew member started outside herdr-app fails with the refusal, and opens nothing', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      mkdirSync(join(home, 'state', 'tasks', '3-o'), { recursive: true });
      mkdirSync(join(home, 'data', '3-o'), { recursive: true });
      writeFileSync(join(home, 'data', '3-o', 'brief.md'), 'Title: o\n');
      const t: Task = { id: '3-o', title: 'o', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'queued', createdAt: now, updatedAt: now, runs: 0, followUps: [], seen: true };
      saveTask(t, env);
      const h = fakeHerdrApp(['sp1'], { noLabel: true });
      assert.equal(startMember(t, loadConfig(env), appEnv(env), h.runner), false);
      const saved = JSON.parse(readFileSync(join(home, 'state', 'tasks', '3-o', 'task.json'), 'utf8')) as Task;
      assert.equal(saved.status, 'failed');
      assert.match(saved.summary ?? '', /Could not start: amigo runs only inside the herdr desktop app/);
      assert.ok(!h.calls.some((c) => c[0] === 'herdr-app'), 'no tab was opened');
    } finally {
      cleanup(dir);
    }
  });
});

describe('test backend', () => {
  it('runs the command as a detached process and reads, sends to, lists and closes it', async () => {
    const { dir, env } = makeHome();
    try {
      const b = terminalBackend(env);
      const marker = join(dir, 'started.txt');
      const ep = b.open({ task: '1-a', cwd: dir, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => {}, 60000)`], dir, env: { ...process.env }, placement: { label: 'l', ownSpace: true, spaces: [] } });
      for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(existsSync(marker), 'the command ran');
      assert.deepEqual(b.state(ep), { liveness: 'live', busy: 'unknown' });
      assert.equal(b.state({ ...ep, task: '2-b' }).liveness, 'foreign');
      b.send(ep, 'hello');
      assert.equal(readFileSync(join(env.AMIGO_HOME as string, 'state', 'test-terminals', `${ep.terminal}.input`), 'utf8'), 'hello\n');
      assert.deepEqual(b.list(), [{ task: '1-a', terminal: ep.terminal, space: null, tab: null, liveness: 'live' }]);
      b.close(ep);
      assert.equal(b.state(ep).liveness, 'absent');
      assert.deepEqual(b.list(), []);
      assert.throws(() => b.send(ep, 'again'), /is absent/);
    } finally {
      cleanup(dir);
    }
  });
});


describe('Claude Code crew members', () => {
  it('recognises Claude and builds the interactive crew member and amigo commands', () => {
    assert.deepEqual(
      ownSessionEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'head', claude_code_child_session: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' }),
      { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' },
      "a crew member drops amigo session's variables and keeps the user's settings",
    );
    assert.ok(isClaude(['claude', '{prompt}']) && isClaude(['C:\\bin\\claude.exe']) && !isClaude(['codex', 'exec']));
    const t = claudeMemberTemplate(['claude', '-p', '--permission-mode', 'auto', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: false, settingsFile: '/s.json' });
    assert.deepEqual(t, ['claude', '--name', 'amigo-x-1', '--session-id', 'S', '--settings', '/s.json', '--permission-mode', 'auto', '{prompt}']);
    assert.deepEqual(claudeMemberTemplate(['claude', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: true, settingsFile: '/s.json' }).slice(3, 5), ['--resume', 'S']);
    assert.deepEqual(claudeAmigoTemplate(['claude', '{prompt}'], '/h.json', '/p.md'), ['claude', '--name', 'amigo', '--settings', '/h.json', '--append-system-prompt-file', '/p.md', 'Brief me.']);
    assert.deepEqual(claudeAmigoTemplate(['claude', '--model', 'opus', '{prompt}'], '/h.json', '/p.md'), ['claude', '--name', 'amigo', '--settings', '/h.json', '--append-system-prompt-file', '/p.md', '--model', 'opus', 'Brief me.']);
    const hooks = (memberSettings() as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }).hooks;
    assert.match(hooks.Stop![0].hooks[0].command, /^node "[^"\\]+cli\.ts" _hook stop$/);
    assert.match(hooks.UserPromptSubmit![0].hooks[0].command, / _hook prompt$/);
    assert.deepEqual(amigoSettings(), { crossSessionInbound: 'accept', hooks: amigoHooks() }, 'amigo accepts messages and runs the supervision hooks: no status line of its own');
  });

  it('keeps the short first prompt and --append-system-prompt-file for direct Claude binaries and Windows .cmd shims, without affecting other agents', () => {
    const dir = tmpDir();
    try {
      const posixBin = join(dir, 'posix');
      const exeBin = join(dir, 'exe');
      const cmdBin = join(dir, 'cmd');
      for (const d of [posixBin, exeBin, cmdBin]) mkdirSync(d, { recursive: true });
      for (const f of ['claude', 'codex']) writeFileSync(join(posixBin, f), '');
      writeFileSync(join(exeBin, 'claude.exe'), '');
      for (const f of ['claude.cmd', 'codex.cmd']) writeFileSync(join(cmdBin, f), '');

      const fullPrompt = `# You are amigo\n${'x'.repeat(INLINE_LIMIT + 1)}`;
      const posixSettings = '/h/amigo-settings.json';
      const posixPromptFile = '/h/amigo-prompt.md';
      const posixLaunch = buildLaunch(claudeAmigoTemplate(['claude', '{prompt}'], posixSettings, posixPromptFile), { prompt: fullPrompt, promptFile: posixPromptFile }, { PATH: posixBin }, 'linux');
      assert.equal(posixLaunch.shell, false);
      assert.deepEqual(posixLaunch.args, ['--name', 'amigo', '--settings', posixSettings, '--append-system-prompt-file', posixPromptFile, 'Brief me.']);

      const winSettings = 'C:\\h\\amigo-settings.json';
      const winPromptFile = 'C:\\h\\amigo-prompt.md';
      const exeLaunch = buildLaunch(claudeAmigoTemplate(['claude', '{prompt}'], winSettings, winPromptFile), { prompt: fullPrompt, promptFile: winPromptFile }, { PATH: exeBin, PATHEXT: '.exe;.cmd' }, 'win32');
      assert.equal(exeLaunch.shell, false);
      assert.deepEqual(exeLaunch.args, ['--name', 'amigo', '--settings', winSettings, '--append-system-prompt-file', winPromptFile, 'Brief me.']);

      const cmdLaunch = buildLaunch(claudeAmigoTemplate(['claude', '{prompt}'], winSettings, winPromptFile), { prompt: fullPrompt, promptFile: winPromptFile }, { PATH: cmdBin, PATHEXT: '.exe;.cmd' }, 'win32');
      assert.equal(cmdLaunch.shell, true);
      assert.deepEqual(cmdLaunch.args, ['--name', 'amigo', '--settings', winSettings, '--append-system-prompt-file', winPromptFile, 'Brief me.']);
      assert.equal(
        cmdLaunch.commandLine,
        `${quoteForCmd(join(cmdBin, 'claude.cmd'))} --name amigo --settings ${winSettings} --append-system-prompt-file ${winPromptFile} "Brief me."`,
      );
      assert.doesNotMatch(cmdLaunch.commandLine!, /Read the file|# You are amigo/);

      // Non-Claude agents keep their existing prompt handling.
      const codexDirect = buildLaunch(['codex', '{prompt}'], { prompt: '# You are amigo', promptFile: posixPromptFile }, { PATH: posixBin }, 'linux');
      assert.deepEqual(codexDirect.args, ['# You are amigo']);
      const codexCmd = buildLaunch(['codex', '{prompt}'], { prompt: '# You are amigo', promptFile: winPromptFile }, { PATH: cmdBin, PATHEXT: '.exe;.cmd' }, 'win32');
      assert.equal(codexCmd.shell, true);
      assert.deepEqual(codexCmd.args, [pointerLine(winPromptFile)]);
    } finally {
      cleanup(dir);
    }
  });

  it('tells the crew member to message the session that spawned it, whatever its name', () => {
    const head = 'uds:/tmp/head.sock';
    assert.equal(sessionAddress({ CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-ab' }), 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-ab');
    assert.equal(sessionAddress({}), undefined, 'not inside a Claude session: no messaging');
    assert.ok(claudeMemberNotes('x-1', head).includes('SendMessage') && claudeMemberNotes('x-1', head).includes(`\`${head}\``));
    assert.doesNotMatch(claudeMemberNotes('x-1', head), /amigo-head|rename/);
    assert.doesNotMatch(claudeMemberNotes('x-1', undefined), /SendMessage/);
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'] } as unknown as Task;
    assert.match(memberPrompt(t, 'Title: paint', undefined, claudeMemberNotes('x-1', head)), /amigo-x-1[\s\S]*Title: paint/);
    assert.match(followUpPrompt(t), /use blue[\s\S]*STATUS line/);
    const two = { ...t, followUps: ['old', 'lost one', 'newest'], followUpsSent: 1 } as Task;
    assert.match(followUpPrompt(two), /1\. lost one\n2\. newest/, 'every follow-up not yet given');
    assert.doesNotMatch(followUpPrompt(two), /old/);
  });

  it('finds a message to amigo in the latest turn only', () => {
    const line = (o: unknown) => JSON.stringify(o);
    const prompt = line({ type: 'user', message: { content: 'do it' } });
    const send = (to: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to } }] } });
    const result = line({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    const head = 'uds:/tmp/head.sock';
    assert.equal(turnMessagedAmigo([prompt, send(head), result].join('\n'), head), true);
    assert.equal(turnMessagedAmigo([prompt, send('amigo')].join('\n'), head), false, 'only the spawning session counts');
    assert.equal(turnMessagedAmigo([prompt, send(head), prompt].join('\n'), head), false, 'an earlier turn does not count');
    // Claude Code writes delivery notices and Stop hook feedback as user entries marked isMeta: they are not a new prompt.
    const notice = line({ type: 'user', isMeta: true, message: { content: '[Cross-session delivery notice] Your message to another session was held by that session' } });
    const feedback = line({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback:\nBefore stopping, end your final message with one line: STATUS' } });
    assert.equal(turnMessagedAmigo([prompt, send(head), result, notice, feedback].join('\n'), head), true, 'a delivery notice does not hide the message already sent');
    assert.ok(reportReason(false, true, head).includes(`\`${head}\``));
    assert.match(reportReason(false, false), /\(1\)[\s\S]*\(2\)/);
    assert.match(reportReason(true, false), /do not send it again/);
  });

  it('marks folders trusted without touching anything else, and removes the entry again', () => {
    const config = { theme: 'dark', projects: { 'C:/Other': { x: 1 }, 'c:/work/crew member': { allowedTools: ['a'] } } };
    const next = mergeTrust(config, 'C:\\work\\crew member') as typeof config & { projects: Record<string, Record<string, unknown>> };
    assert.deepEqual(next.projects['c:/work/crew member'], { allowedTools: ['a'], hasTrustDialogAccepted: true });
    assert.equal(next.theme, 'dark');
    assert.equal(mergeTrust(next, 'C:/work/crew member'), null, 'already trusted');
    assert.deepEqual(mergeTrust({}, '/home/u/w/')?.projects, { '/home/u/w': { allowedTools: [], hasTrustDialogAccepted: true } });
    assert.deepEqual(Object.keys((dropTrust(next, 'C:/work/crew member') as typeof config).projects), ['C:/Other']);
    assert.equal(dropTrust(next, '/nope'), null);
  });

  it('never writes the real ~/.claude.json from a test home', () => {
    const { dir, env } = makeHome();
    try {
      assert.throws(() => claudeJsonPath({ AMIGO_HOME: env.AMIGO_HOME }), /refusing to touch the real/);
      assert.equal(claudeJsonPath(env), env.AMIGO_CLAUDE_JSON);
      assert.equal(claudeJsonPath({ AMIGO_HOME: join(os.homedir(), '.amigo') }), join(os.homedir(), '.claude.json'), 'a real home is allowed');
    } finally {
      cleanup(dir);
    }
  });

  /** Runs fn with os.tmpdir() answering `temp`. */
  const withTemp = (temp: string, fn: () => void) => {
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
    try {
      assert.equal(os.tmpdir(), temp);
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const refuses = (home: string) => assert.throws(() => claudeJsonPath({ AMIGO_HOME: home }), /refusing to touch the real/, home);

  it('refuses a home in the temp folder reached through a link, created yet or not, in either form', () => {
    const dir = tmpDir();
    try {
      const real = join(dir, 'real-temp');
      const link = join(dir, 'linked-temp');
      mkdirSync(join(real, 'made'), { recursive: true });
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      withTemp(link, () => {
        for (const base of [link, real]) {
          refuses(join(base, 'not-created', 'home'));
          refuses(join(base, 'made'));
        }
      });
      withTemp(real, () => refuses(join(link, 'not-created')));
    } finally {
      cleanup(dir);
    }
  });

  it('refuses the temp folder and what is inside it, but not a sibling whose name starts with the same letters', () => {
    const dir = tmpDir();
    try {
      const temp = join(dir, 'temp');
      mkdirSync(temp);
      withTemp(temp, () => {
        refuses(temp);
        refuses(join(temp, 'home'));
        assert.equal(claudeJsonPath({ AMIGO_HOME: join(`${temp}2`, 'home') }), join(os.homedir(), '.claude.json'));
      });
    } finally {
      cleanup(dir);
    }
  });

  it('refuses a home in a temp folder named by its 8.3 short name, created yet or not, in either form', { skip: process.platform !== 'win32' }, () => {
    const dir = tmpDir();
    try {
      const long = join(dir, 'a-long-temp-folder-name');
      mkdirSync(join(long, 'made'), { recursive: true });
      // Verbatim: node would otherwise escape the inner quotes, and cmd would answer for a path that does not exist.
      const short = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
      assert.ok(existsSync(join(short, 'made')), `${short} is not a working name for ${long}`);
      assert.match(short, /~\d[^\\]*$/, `this volume gives ${long} no 8.3 name, so the test proves nothing`);
      withTemp(short, () => {
        for (const base of [short, long]) {
          refuses(join(base, 'not-created', 'home'));
          refuses(join(base, 'made'));
        }
      });
      withTemp(long, () => refuses(join(short, 'not-created')));
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to --resume a session whose transcript is missing, without launching claude', () => {
    // If the precheck let it through, this claude would fail to start and log "claude could not start" instead.
    const missingClaude = join(tmpDir(), 'no-such-dir', 'claude');
    const { dir, env } = makeHome(0, [missingClaude, '{prompt}']);
    try {
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'state', 'tasks', 'x-1'), { recursive: true });
      writeFileSync(join(home, 'state', 'tasks', 'x-1', 'prompt.md'), 'Follow-up from amigo: go on\n');
      const transcript = join(dir, 'projects', 'gone', 'S-1.jsonl');
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 2, followUps: ['go on'], followUpsSent: 0, seen: true, sessionId: 'S-1', sessionStarted: true, transcriptPath: transcript }, env);
      const r = cli(env, ['_tab', 'x-1', '--run', '2']);
      assert.notEqual(r.code, 0, 'the tab stays open on the error');
      const log = readFileSync(join(home, 'state', 'tasks', 'x-1', 'output.log'), 'utf8');
      const why = `can't resume: no transcript for session S-1 at ${transcript}`;
      assert.ok(log.includes(`amigo: ${why}`), log);
      assert.ok(!/could not start/.test(log), 'claude was never launched');
      const t = JSON.parse(readFileSync(join(home, 'state', 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;
      assert.deepEqual([t.status, t.summary, t.pid, t.sessionStarted], ['failed', why, null, true]);
    } finally {
      cleanup(dir);
      cleanup(dirname(dirname(missingClaude)));
    }
  });

  it('guesses the transcript path the way Claude Code names its project folders, and hooks record the real one', async () => {
    assert.equal(guessTranscriptPath('C:\\Users\\me\\my app', 'S', { CLAUDE_CONFIG_DIR: join('/c', 'cfg') }), join('/c', 'cfg', 'projects', 'C--Users-me-my-app', 'S.jsonl'));
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'state', 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      await applyHook('prompt', { transcript_path: '/t/S.jsonl' }, 'x-1', env);
      assert.equal((JSON.parse(readFileSync(join(home, 'state', 'tasks', 'x-1', 'task.json'), 'utf8')) as Task).transcriptPath, '/t/S.jsonl');
    } finally {
      cleanup(dir);
    }
  });

  it('hooks track turns: STATUS is recorded, a turn without report is sent back once', async () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'state', 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      const task = () => JSON.parse(readFileSync(join(home, 'state', 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;

      const blocked = JSON.parse(await applyHook('stop', { last_assistant_message: 'all done' }, 'x-1', env));
      assert.equal(blocked.decision, 'block');
      assert.match(blocked.reason, /STATUS/);
      assert.equal(task().status, 'running');

      assert.equal(await applyHook('stop', { last_assistant_message: 'all done', stop_hook_active: true }, 'x-1', env), '');
      assert.deepEqual([task().status, task().summary, task().seen], ['done', 'all done', false]);

      await applyHook('prompt', {}, 'x-1', env);
      assert.equal(task().status, 'running');

      // Spawned by a Claude amigo, the turn must also have messaged it.
      saveTask({ ...task(), amigoAddress: 'uds:/tmp/head.sock' }, env);
      const transcript = join(dir, 't.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'go' } }));
      const noMessage = JSON.parse(await applyHook('stop', { last_assistant_message: 'STATUS: question - which color?', transcript_path: transcript }, 'x-1', env));
      assert.match(noMessage.reason, /SendMessage/);
      writeFileSync(transcript, [JSON.stringify({ type: 'user', message: { content: 'go' } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'uds:/tmp/head.sock' } }] } })].join('\n'));
      assert.equal(await applyHook('stop', { last_assistant_message: 'STATUS: question - which color?', transcript_path: transcript }, 'x-1', env), '');
      assert.deepEqual([task().status, task().summary], ['question', 'which color?']);
      assert.match(readFileSync(join(home, 'state', 'tasks', 'x-1', 'output.log'), 'utf8'), /=== turn ended .*\n.*which color\?/);

      // A turn that dies on an API error must not leave the task running.
      saveTask({ ...task(), status: 'running' }, env);
      await applyHook('stop-failure', { error: 'rate_limit' }, 'x-1', env);
      assert.deepEqual([task().status, task().seen], ['blocked', false]);
      assert.match(task().summary ?? '', /rate_limit/);

      saveTask({ ...task(), status: 'closing' }, env);
      await applyHook('stop', { last_assistant_message: 'STATUS: done - late', stop_hook_active: true }, 'x-1', env);
      assert.equal(task().status, 'closing', 'close owns the status');
    } finally {
      cleanup(dir);
    }
  });
});

describe('memory gate and wait', () => {
  it('starts a crew member only while the reserve stays free', () => {
    assert.equal(ramAllows(3000, 600, 2048, 0), true);
    assert.equal(ramAllows(3000, 600, 2048, 1), false, 'a crew member still starting counts');
    assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 2000.\nPages speculative: 100.\n'), 48);
  });

  it('always lets one crew member run, even when memory is below the reserve', async () => {
    const { dir, env } = makeHome();
    try {
      const low = { ...env, AMIGO_FREE_MB: '10' };
      writeFileSync(join(env.AMIGO_HOME as string, 'config', 'config.json'), readFileSync(join(env.AMIGO_HOME as string, 'config', 'config.json'), 'utf8').replace('"memberMb":0', '"memberMb":600').replace('"reserveMb":0', '"reserveMb":2048'));
      for (const p of ['a', 'b']) cli(low, ['add', makeRepo(join(dir, p))]);
      const first = cli(low, ['spawn', '--project', 'a'], 'Title: one\nMODE:hold').out;
      assert.match(first, /^Started/);
      const second = cli(low, ['spawn', '--project', 'b'], 'Title: two').out;
      assert.match(second, /^Queued/, 'the second waits for memory');
      // When the first ends, nothing runs, so the second may start.
      releaseHeld(low);
      await waitFor(/task:\s+(\S+)/.exec(second)![1]!, low, ['done']);
    } finally {
      releaseHeld(env);
      cleanup(dir);
    }
  });

  it('a tab for an old run, or a second tab for the same run, starts nothing', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'state', 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 2, followUps: [], seen: true }, env);
      assert.match(cli(env, ['_tab', 'x-1', '--run', '1']).out, /not starting it/);
      beat('x-1', env);
      assert.match(cli(env, ['_tab', 'x-1', '--run', '2']).out, /not starting it/, 'a live tab already owns this run');
      assert.ok(!existsSync(join(home, 'state', 'tasks', 'x-1', 'output.log')), 'no agent ran');
    } finally {
      cleanup(dir);
    }
  });

  it('finds every descendant process for killing on macOS and Linux', () => {
    assert.deepEqual(descendants(10, '  10  1\n 11 10\n 12 11\n 13 1\n 14 10\n'), [11, 14, 12]);
  });

  it('wait returns when a crew member finishes and says so when nothing is open', async () => {
    const { dir, env } = makeHome();
    try {
      cli(env, ['add', makeRepo(join(dir, 'p'))]);
      assert.match(cli(env, ['wait']).out, /Nothing is running or queued/);
      const out = cli(env, ['spawn', '--project', 'p'], 'Title: write').out;
      const id = /task:\s+(\S+)/.exec(out)![1]!;
      const waited = cli(env, ['wait', id, '--timeout-min', '1']);
      assert.match(waited.out, new RegExp(`${id}  done[\\s\\S]*wrote member-output\\.txt`));
      assert.equal((await waitFor(id, env, ['done'])).seen, true);
      assert.match(cli(env, ['inbox']).out, /Inbox empty/, 'wait marks results seen');
    } finally {
      cleanup(dir);
    }
  });
});

describe('test terminal backend', () => {
  it('close leaves alone a process that reused a recorded pid', async () => {
    const { dir, env } = makeHome();
    try {
      const backend = terminalBackend(env);
      const argv = [process.execPath, '-e', 'setTimeout(() => {}, 60000)'];
      const ep = backend.open({ task: '1-x', cwd: dir, argv, dir, env, placement: { label: '1-x', ownSpace: false, spaces: [] } });
      const recFile = join(stateDir(env), 'test-terminals', `${ep.terminal}.json`);
      const rec = JSON.parse(readFileSync(recFile, 'utf8')) as { pid: number; openedAt: number };
      // Pretend the record is a minute older than the process: the live pid now belongs to a later process.
      writeFileSync(recFile, JSON.stringify({ ...rec, openedAt: rec.openedAt - 60_000 }));
      backend.close(ep);
      assert.doesNotThrow(() => process.kill(rec.pid, 0), 'a reused pid must not be killed');
      process.kill(rec.pid);
      const own = backend.open({ task: '1-x', cwd: dir, argv, dir, env, placement: { label: '1-x', ownSpace: false, spaces: [] } });
      const ownPid = (JSON.parse(readFileSync(join(stateDir(env), 'test-terminals', `${own.terminal}.json`), 'utf8')) as { pid: number }).pid;
      backend.close(own);
      const end = Date.now() + 10_000;
      const gone = () => { try { process.kill(ownPid, 0); return false; } catch { return true; } };
      while (!gone() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      assert.ok(gone(), "close must end the terminal's own process");
    } finally {
      cleanup(dir);
    }
  });
});
