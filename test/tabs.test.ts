import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { applyHook, memberPrompt, followUpPrompt, herdrPlacement, startMember, tabEnvArgs } from '../src/squad.ts';
import { loadConfig } from '../src/config.ts';
import { memberSettings, guessTranscriptPath, amigoSettings, claudeMemberNotes, claudeMemberTemplate, claudeAmigoTemplate, claudeJsonPath, dropTrust, isClaude, mergeTrust, ownSessionEnv, reportReason, sessionAddress, turnMessagedAmigo } from '../src/claude.ts';
import { parseVmStat, ramAllows } from '../src/ram.ts';
import { descendants } from '../src/proc.ts';
import { beat, saveTask, type Task } from '../src/tasks.ts';
import { detectTerminal, amigoHerdrWorkspace, herdrLabel, openTab, planTab, selectTerminal, tabScript, warpTabConfig, type HerdrPlacement } from '../src/terminal.ts';
import type { RunResult } from '../src/proc.ts';
import { cleanup, cli, makeHome, releaseHeld, tmpDir, waitFor } from './helpers.ts';

const req = (platform: NodeJS.Platform) => ({
  name: 'amigo-x-1',
  title: 'amigo: Fix "it"',
  cwd: platform === 'win32' ? 'C:\\work\\my app' : '/work/my app',
  argv: platform === 'win32' ? ['C:\\Program Files\\nodejs\\node.exe', 'C:\\oct\\src\\cli.ts', '_tab', 'x-1'] : ['/usr/bin/node', "/oct/it's/cli.ts", '_tab', 'x-1'],
  dir: platform === 'win32' ? 'C:\\h\\tasks\\x-1' : '/h/tasks/x-1',
  platform,
  env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
});

describe('terminal tabs', () => {
  it('opens squad members in the terminal amigo runs in', () => {
    assert.equal(detectTerminal({ TMUX: '/tmp/tmux-1/default,1,0', TERM_PROGRAM: 'tmux' }, 'linux'), 'tmux');
    assert.equal(detectTerminal({ TMUX: '/tmp/t', TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '0' }, 'darwin'), 'tmux', 'tmux inside another terminal opens tmux windows');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3', WT_SESSION: 'x' }, 'win32'), 'wezterm', 'WezTerm started from Windows Terminal is still WezTerm');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'WarpTerminal' }, 'win32'), 'warp');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'win32'), 'wt');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'herdr', HERDR_PANE_ID: 'w1:p1' }, 'win32'), 'herdr');
    assert.equal(detectTerminal({ HERDR_PANE_ID: 'w1:p1' }, 'linux'), 'herdr', 'the pane id alone is enough');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'herdr', TMUX: '/tmp/t' }, 'linux'), 'tmux', 'tmux inside herdr opens tmux windows');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'herdr', WT_SESSION: 'x' }, 'win32'), 'herdr', 'herdr started from Windows Terminal is still herdr');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode', HERDR_PANE_ID: 'w1:p1' }, 'win32'), 'window', 'a terminal started from a herdr pane keeps its own identity');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'WezTerm', HERDR_PANE_ID: 'w1:p1' }, 'linux'), 'wezterm');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin'), 'terminal');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode' }, 'darwin'), 'terminal', 'macOS falls back to a Terminal.app window');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode' }, 'win32'), 'window', 'Windows falls back to a console window');
    assert.equal(detectTerminal({}, 'linux'), 'window');
    const found = () => '/usr/bin/x-terminal-emulator';
    const none = () => null;
    assert.equal(selectTerminal({ env: { TERM_PROGRAM: 'WezTerm' }, platform: 'linux', find: none }), 'wezterm');
    assert.equal(selectTerminal({ env: {}, platform: 'linux', find: found }), 'window');
    assert.throws(() => selectTerminal({ env: {}, platform: 'linux', find: none }), /no terminal emulator found/);
    assert.equal(selectTerminal({ env: { AMIGO_TERMINAL: 'wt', TERM_PROGRAM: 'WezTerm' }, platform: 'win32', find: none }), 'wt', "a squad member's tab keeps amigo's terminal");
    assert.equal(selectTerminal({ env: { AMIGO_TERMINAL: 'herdr', TERM_PROGRAM: 'herdr' }, platform: 'win32', find: none }), 'herdr');
    assert.equal(selectTerminal({ env: { AMIGO_TERMINAL: 'nonsense', TERM_PROGRAM: 'WezTerm' }, platform: 'linux', find: none }), 'wezterm', 'a bad carried value falls back to detection');
  });

  it('opens a WezTerm tab in amigo window, or a new console window elsewhere', () => {
    assert.deepEqual(planTab('wezterm', req('win32')).command, { cmd: 'wezterm', args: ['cli', 'spawn', '--cwd', 'C:\\work\\my app', '--', 'cmd.exe', '/c', 'C:\\h\\tasks\\x-1\\tab.cmd'] });
    assert.deepEqual(planTab('wezterm', req('darwin')).command, { cmd: 'wezterm', args: ['cli', 'spawn', '--cwd', '/work/my app', '--', 'sh', '/h/tasks/x-1/tab.sh'] });
    const win = planTab('window', { ...req('win32'), cwd: "C:\\it's here" });
    assert.equal(win.tabConfig, null);
    assert.deepEqual(win.command, {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c', '"C:\\h\\tasks\\x-1\\tab.cmd"' -WorkingDirectory 'C:\\it''s here'`],
    });
    assert.deepEqual(planTab('window', req('linux')).command, { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', "cd '/work/my app' && sh '/h/tasks/x-1/tab.sh'"] });
  });

  it('writes a Warp tab config that runs the tab script and closes the tab', () => {
    const plan = planTab('warp', req('win32'), 'C:\\Users\\u');
    assert.equal(plan.tabConfig, 'C:\\Users\\u\\AppData\\Roaming\\warp\\Warp\\data\\tab_configs\\amigo-x-1.toml');
    assert.deepEqual(plan.command, { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Process "warp://tab_config/amigo-x-1"'] });
    const toml = plan.files.find((f) => f.path === plan.tabConfig)!.content;
    assert.equal(
      toml,
      [
        'name = "amigo-x-1"',
        'title = "amigo: Fix \\"it\\""',
        '',
        '[[panes]]',
        'id = "main"',
        'type = "terminal"',
        'directory = "C:/work/my app"',
        `commands = ["& 'C:\\\\h\\\\tasks\\\\x-1\\\\tab.cmd'; exit"]`,
        'is_focused = true',
        '',
      ].join('\n'),
    );
    const mac = planTab('warp', req('darwin'), '/Users/u');
    assert.equal(mac.tabConfig, '/Users/u/.warp/tab_configs/amigo-x-1.toml');
    assert.deepEqual(mac.command, { cmd: 'open', args: ['warp://tab_config/amigo-x-1'] });
    assert.match(warpTabConfig('n', 't', '/a', "sh '/h/tab.sh'; exit"), /commands = \["sh '\/h\/tab\.sh'; exit"\]/);
  });

  it('quotes the tab script for cmd.exe and sh, and never waits for a key', () => {
    assert.equal(tabScript(req('win32').argv, 'win32'), '@echo off\r\nchcp 65001 >nul\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\oct\\src\\cli.ts _tab x-1\r\n');
    assert.throws(() => tabScript(['C:\\100%\\node.exe'], 'win32'), /\.cmd file/);
    assert.equal(tabScript(req('darwin').argv, 'darwin'), "#!/bin/sh\n'/usr/bin/node' '/oct/it'\\''s/cli.ts' '_tab' 'x-1'\n");
    const waits = /pause|Read-Host|read -r|Press Enter|any key/i;
    for (const kind of ['tmux', 'herdr', 'wezterm', 'warp', 'wt', 'terminal', 'window'] as const) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const plan = planTab(kind, req(platform), platform === 'win32' ? 'C:\\Users\\u' : '/Users/u');
        for (const f of plan.files) assert.doesNotMatch(f.content, waits, `${kind}/${platform}: ${f.path}`);
        assert.doesNotMatch(JSON.stringify(plan.command), waits, `${kind}/${platform} launch command`);
      }
    }
  });

  it('carries AMIGO_* settings into the tab, which does not inherit this environment', () => {
    assert.deepEqual(tabEnvArgs({ AMIGO_TERMINAL: 'wt', AMIGO_HOME: '/h', AMIGO_TASK: 'x', AMIGO_FREE_MB: '', PATH: '/bin' }), ['--env', 'AMIGO_TERMINAL=wt']);
    assert.deepEqual(tabEnvArgs({ AMIGO_TERMINAL: 'herdr', AMIGO_HERDR_WORKSPACE: 'w1', HERDR_WORKSPACE_ID: 'w1' }), ['--env', 'AMIGO_TERMINAL=herdr', '--env', 'AMIGO_HERDR_WORKSPACE=w1']);
  });

  it("finds amigo's herdr workspace, which a queued squad member's own tab must not replace", () => {
    assert.equal(amigoHerdrWorkspace({ HERDR_WORKSPACE_ID: 'w1' }), 'w1');
    assert.equal(amigoHerdrWorkspace({ HERDR_WORKSPACE_ID: 'w7', AMIGO_HERDR_WORKSPACE: 'w1' }), 'w1', 'the carried value wins inside a squad member tab');
    assert.equal(amigoHerdrWorkspace({}), null);
  });

  it('labels a herdr tab with the id and a title cut to about 40 characters', () => {
    assert.equal(herdrLabel('7-fix-footer', 'Fix the footer'), '7-fix-footer · Fix the footer');
    const long = herdrLabel('12-fix-footer', 'Fix the broken footer link on the pricing page and the blog');
    assert.ok(long.length <= 40 && long.startsWith('12-fix-footer · Fix the broken') && long.endsWith('…'), long);
    assert.equal(herdrLabel('3', 'two\nlines   here'), '3 · two lines here');
  });

  it('opens Windows Terminal, Terminal.app and tmux tabs', () => {
    const wt = planTab('wt', { ...req('win32'), title: 'a;b' });
    assert.deepEqual(wt.command?.args, ['-w', '0', 'new-tab', '--title', 'a,b', '--suppressApplicationTitle', '--startingDirectory', 'C:\\work\\my app', 'cmd', '/c', 'C:\\h\\tasks\\x-1\\tab.cmd']);
    assert.throws(() => planTab('wt', { ...req('win32'), cwd: 'C:\\a;b' }), /";"/);
    const term = planTab('terminal', req('darwin'));
    assert.equal(term.command?.args.at(-1), `tell application "Terminal" to do script "cd '/work/my app' && sh '/h/tasks/x-1/tab.sh'; exit"`);
    assert.deepEqual(planTab('tmux', req('linux')).command, { cmd: 'tmux', args: ['new-window', '-n', 'amigo-x-1', '-c', '/work/my app', 'sh', '/h/tasks/x-1/tab.sh'] });
  });
});

/** A herdr that answers from a list of fake workspaces, recording every call. */
function fakeHerdr(workspaces: string[], opts: { failCreate?: string; failRun?: boolean; bin?: string; wrongShape?: string[] } = {}) {
  const calls: string[][] = [];
  const reply = (result: unknown): RunResult => ({ status: 0, stdout: JSON.stringify({ id: 'x', result }), stderr: '' });
  const error = (code: string, message: string): RunResult => ({ status: 1, stdout: JSON.stringify({ error: { code, message }, id: 'x' }), stderr: '' });
  const made = (ws: string) => ({ tab: { tab_id: `${ws}:t1`, workspace_id: ws }, root_pane: { pane_id: `${ws}:p1`, workspace_id: ws } });
  const runner = (cmd: string, args: string[]): RunResult => {
    assert.equal(cmd, opts.bin ?? 'herdr');
    calls.push(args);
    switch (`${args[0]} ${args[1]}`) {
      case 'workspace create':
        if (opts.failCreate) return error('internal', opts.failCreate);
        if (opts.wrongShape?.includes('new')) return reply({ workspace: { workspace_id: 'w9' } });
        workspaces.push('w9');
        return reply(made('w9'));
      case 'tab create': {
        const ws = args[args.indexOf('--workspace') + 1] as string;
        if (opts.wrongShape?.includes(ws)) return reply({ type: 'ok' });
        return workspaces.includes(ws) ? reply(made(ws)) : error('workspace_not_found', `workspace ${ws} not found`);
      }
      case 'pane run':
        return opts.failRun ? error('pane_not_found', `pane ${args[2]} not found`) : reply({ type: 'ok' });
      default:
        return reply({ type: 'ok' });
    }
  };
  return { calls, runner };
}

describe('herdr tabs', () => {
  const label = '7-fix-footer · Fix the footer';
  /** Opens a herdr tab against a fake herdr that has these workspaces. */
  const open = (workspaces: string[], herdr: HerdrPlacement, opts?: Parameters<typeof fakeHerdr>[1]) => {
    const platform = process.platform; // the script is written for real, so it follows this machine's path style
    const win = platform === 'win32';
    const dir = tmpDir();
    const h = fakeHerdr(workspaces, opts);
    try {
      const r = openTab('herdr', { ...req(platform), dir, herdr }, h.runner);
      return { ...h, ...r, line: win ? `& '${join(dir, 'tab.cmd')}'; exit` : `sh '${join(dir, 'tab.sh')}'; exit`, cwd: req(platform).cwd, written: readdirSync(dir) };
    } finally {
      cleanup(dir);
    }
  };

  it('puts a squad member with a worktree in a workspace of its own, renames its tab, and runs the script there', () => {
    const r = open(['w1'], { label, ownWorkspace: true, workspaces: ['w1'] });
    assert.deepEqual(r.calls, [
      ['workspace', 'create', '--cwd', r.cwd, '--label', label, '--no-focus'],
      ['tab', 'rename', 'w9:t1', label],
      ['pane', 'run', 'w9:p1', r.line],
    ]);
    assert.equal(r.herdrWorkspace, 'w9');
    assert.deepEqual(r.written, [process.platform === 'win32' ? 'tab.cmd' : 'tab.sh'], 'the tab script is written before the pane runs it');
  });

  it("puts a squad member without a worktree in amigo's workspace, without renaming anything", () => {
    const r = open(['w1'], { label, ownWorkspace: false, workspaces: ['w1'] });
    assert.deepEqual(r.calls, [
      ['tab', 'create', '--workspace', 'w1', '--cwd', r.cwd, '--label', label, '--no-focus'],
      ['pane', 'run', 'w1:p1', r.line],
    ]);
    assert.equal(r.herdrWorkspace, 'w1');
  });

  it("puts a reviewer in the reviewed squad member's workspace, else amigo's, else a new one", () => {
    const place = { label, ownWorkspace: false, workspaces: ['w4', 'w1'] };
    assert.equal(open(['w1', 'w4'], place).herdrWorkspace, 'w4');
    const closed = open(['w1'], place);
    assert.equal(closed.herdrWorkspace, 'w1', 'the reviewed squad member already closed its workspace');
    assert.deepEqual(closed.calls.slice(0, 2).map((c) => c.slice(0, 4)), [['tab', 'create', '--workspace', 'w4'], ['tab', 'create', '--workspace', 'w1']]);
    const none = open([], place);
    assert.equal(none.herdrWorkspace, 'w9', 'both gone: a new workspace');
    assert.deepEqual(none.calls.map((c) => c.slice(0, 2).join(' ')), ['tab create', 'tab create', 'workspace create', 'tab rename', 'pane run']);
  });

  it('treats an answer without workspace, tab and pane ids as a failure, not a tab', () => {
    const place = { label, ownWorkspace: false, workspaces: ['w4', 'w1'] };
    const r = open(['w4', 'w1'], place, { wrongShape: ['w4'] });
    assert.equal(r.herdrWorkspace, 'w1', 'the next workspace is tried');
    assert.throws(() => open(['w4'], place, { wrongShape: ['w4', 'new'] }), /Could not open a herdr workspace for the squad member: unexpected answer/);
  });

  it('runs the herdr that herdr itself points to (HERDR_BIN_PATH), else the one on PATH', () => {
    const dir = tmpDir();
    const bin = 'C:\herdr\herdr.exe';
    const h = fakeHerdr(['w1'], { bin });
    try {
      const r = openTab('herdr', { ...req(process.platform), dir, env: { HERDR_BIN_PATH: bin }, herdr: { label, ownWorkspace: false, workspaces: ['w1'] } }, h.runner);
      assert.equal(r.herdrWorkspace, 'w1');
      assert.equal(h.calls.length, 2);
    } finally {
      cleanup(dir);
    }
  });

  it('places squad members: own workspace for a worktree, else beside the reviewed squad member, else amigo', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      const task = (id: string, more: Partial<Task>): Task => ({ id, title: 'Fix the footer', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true, ...more });
      mkdirSync(join(home, 'tasks', '1-a'), { recursive: true });
      saveTask(task('1-a', { herdrWorkspace: 'w4' }), env);
      const bare = { ...env, HERDR_WORKSPACE_ID: undefined }; // this test may itself run inside herdr
      const head = { ...env, HERDR_WORKSPACE_ID: 'w1' };
      assert.deepEqual(herdrPlacement(task('2-b', { worktree: '/w/2-b' }), head), { label: '2-b · Fix the footer', ownWorkspace: true, workspaces: ['w1'] });
      assert.deepEqual(herdrPlacement(task('3-c', {}), head), { label: '3-c · Fix the footer', ownWorkspace: false, workspaces: ['w1'] });
      assert.deepEqual(herdrPlacement(task('4-d', { reviewOf: '1-a' }), head).workspaces, ['w4', 'w1']);
      assert.deepEqual(herdrPlacement(task('5-e', { reviewOf: '1-a' }), { ...head, AMIGO_HERDR_WORKSPACE: 'w4' }).workspaces, ['w4'], 'the same workspace is tried once');
      assert.deepEqual(herdrPlacement(task('6-f', { reviewOf: '1-a' }), bare).workspaces, ['w4'], 'no amigo workspace known');
    } finally {
      cleanup(dir);
    }
  });

  it("starting a herdr squad member carries amigo's workspace into the tab and records the squad member's own", () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      const now = new Date().toISOString();
      mkdirSync(join(home, 'tasks', '7-g'), { recursive: true });
      writeFileSync(join(home, 'tasks', '7-g', 'brief.md'), 'Title: g\n');
      const t: Task = { id: '7-g', title: 'g', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'queued', createdAt: now, updatedAt: now, runs: 0, followUps: [], seen: true };
      saveTask(t, env);
      const bin = 'C:\herdr\herdr.exe';
      const h = fakeHerdr(['w1'], { bin });
      const amigoEnv = { ...env, AMIGO_TERMINAL: 'herdr', HERDR_WORKSPACE_ID: 'w1', HERDR_BIN_PATH: bin };
      assert.equal(startMember(t, loadConfig(amigoEnv), amigoEnv, h.runner), true);
      assert.deepEqual(h.calls.map((c) => c.slice(0, 2).join(' ')), ['tab create', 'pane run']);
      const script = readFileSync(join(home, 'tasks', '7-g', process.platform === 'win32' ? 'tab.cmd' : 'tab.sh'), 'utf8');
      assert.match(script, /AMIGO_TERMINAL=herdr/);
      assert.match(script, /AMIGO_HERDR_WORKSPACE=w1/);
      assert.equal((JSON.parse(readFileSync(join(home, 'tasks', '7-g', 'task.json'), 'utf8')) as Task).herdrWorkspace, 'w1');
    } finally {
      cleanup(dir);
    }
  });

  it('opens a new workspace when no workspace is known', () => {
    assert.equal(open(['w1'], { label, ownWorkspace: false, workspaces: [] }).herdrWorkspace, 'w9');
  });

  it("fails with herdr's own message when a new workspace cannot be created, or the script cannot be started", () => {
    assert.throws(() => open([], { label, ownWorkspace: true, workspaces: [] }, { failCreate: 'no room' }), /Could not open a herdr workspace for the squad member: no room/);
    const dir = tmpDir();
    const h = fakeHerdr(['w1'], { failRun: true });
    try {
      assert.throws(() => openTab('herdr', { ...req(process.platform), dir, herdr: { label, ownWorkspace: false, workspaces: ['w1'] } }, h.runner), /pane w1:p1 not found/);
      assert.deepEqual(h.calls.at(-1), ['tab', 'close', 'w1:t1'], 'the empty tab it made is closed again');
    } finally {
      cleanup(dir);
    }
  });
});

describe('Claude Code squad members', () => {
  it('recognises Claude and builds the interactive squad member and amigo commands', () => {
    assert.deepEqual(
      ownSessionEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'head', claude_code_child_session: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' }),
      { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' },
      "a squad member drops amigo session's variables and keeps the user's settings",
    );
    assert.ok(isClaude(['claude', '{prompt}']) && isClaude(['C:\\bin\\claude.exe']) && !isClaude(['codex', 'exec']));
    const t = claudeMemberTemplate(['claude', '-p', '--permission-mode', 'auto', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: false, settingsFile: '/s.json' });
    assert.deepEqual(t, ['claude', '--name', 'amigo-x-1', '--session-id', 'S', '--settings', '/s.json', '--permission-mode', 'auto', '{prompt}']);
    assert.deepEqual(claudeMemberTemplate(['claude', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: true, settingsFile: '/s.json' }).slice(3, 5), ['--resume', 'S']);
    assert.deepEqual(claudeAmigoTemplate(['claude', '{prompt}'], '/h.json'), ['claude', '--name', 'amigo', '--settings', '/h.json', '{prompt}']);
    const hooks = (memberSettings() as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }).hooks;
    assert.match(hooks.Stop![0].hooks[0].command, /^node "[^"\\]+cli\.ts" _hook stop$/);
    assert.match(hooks.UserPromptSubmit![0].hooks[0].command, / _hook prompt$/);
    assert.deepEqual(amigoSettings(), { crossSessionInbound: 'accept' }, 'amigo only accepts messages: no status line of its own');
  });

  it('tells the squad member to message the session that spawned it, whatever its name', () => {
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
    const config = { theme: 'dark', projects: { 'C:/Other': { x: 1 }, 'c:/work/squad member': { allowedTools: ['a'] } } };
    const next = mergeTrust(config, 'C:\\work\\squad member') as typeof config & { projects: Record<string, Record<string, unknown>> };
    assert.deepEqual(next.projects['c:/work/squad member'], { allowedTools: ['a'], hasTrustDialogAccepted: true });
    assert.equal(next.theme, 'dark');
    assert.equal(mergeTrust(next, 'C:/work/squad member'), null, 'already trusted');
    assert.deepEqual(mergeTrust({}, '/home/u/w/')?.projects, { '/home/u/w': { allowedTools: [], hasTrustDialogAccepted: true } });
    assert.deepEqual(Object.keys((dropTrust(next, 'C:/work/squad member') as typeof config).projects), ['C:/Other']);
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
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      writeFileSync(join(home, 'tasks', 'x-1', 'prompt.md'), 'Follow-up from amigo: go on\n');
      const transcript = join(dir, 'projects', 'gone', 'S-1.jsonl');
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 2, followUps: ['go on'], followUpsSent: 0, seen: true, sessionId: 'S-1', sessionStarted: true, transcriptPath: transcript }, env);
      const r = cli(env, ['_tab', 'x-1', '--run', '2']);
      assert.notEqual(r.code, 0, 'the tab stays open on the error');
      const log = readFileSync(join(home, 'tasks', 'x-1', 'output.log'), 'utf8');
      const why = `can't resume: no transcript for session S-1 at ${transcript}`;
      assert.ok(log.includes(`amigo: ${why}`), log);
      assert.ok(!/could not start/.test(log), 'claude was never launched');
      const t = JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;
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
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      await applyHook('prompt', { transcript_path: '/t/S.jsonl' }, 'x-1', env);
      assert.equal((JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task).transcriptPath, '/t/S.jsonl');
    } finally {
      cleanup(dir);
    }
  });

  it('hooks track turns: STATUS is recorded, a turn without report is sent back once', async () => {
    const { dir, env } = makeHome();
    try {
      const home = env.AMIGO_HOME as string;
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      const task = () => JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;

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
      assert.match(readFileSync(join(home, 'tasks', 'x-1', 'output.log'), 'utf8'), /=== turn ended .*\n.*which color\?/);

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
  it('starts a squad member only while the reserve stays free', () => {
    assert.equal(ramAllows(3000, 600, 2048, 0), true);
    assert.equal(ramAllows(3000, 600, 2048, 1), false, 'a squad member still starting counts');
    assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 2000.\nPages speculative: 100.\n'), 48);
  });

  it('always lets one squad member run, even when memory is below the reserve', async () => {
    const { dir, env } = makeHome();
    try {
      const low = { ...env, AMIGO_FREE_MB: '10' };
      writeFileSync(join(env.AMIGO_HOME as string, 'config.json'), readFileSync(join(env.AMIGO_HOME as string, 'config.json'), 'utf8').replace('"memberMb":0', '"memberMb":600').replace('"reserveMb":0', '"reserveMb":2048'));
      for (const p of ['a', 'b']) {
        mkdirSync(join(dir, p));
        cli(low, ['add', join(dir, p)]);
      }
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
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 2, followUps: [], seen: true }, env);
      assert.match(cli(env, ['_tab', 'x-1', '--run', '1']).out, /not starting it/);
      beat('x-1', env);
      assert.match(cli(env, ['_tab', 'x-1', '--run', '2']).out, /not starting it/, 'a live tab already owns this run');
      assert.ok(!existsSync(join(home, 'tasks', 'x-1', 'output.log')), 'no agent ran');
    } finally {
      cleanup(dir);
    }
  });

  it('finds every descendant process for killing on macOS and Linux', () => {
    assert.deepEqual(descendants(10, '  10  1\n 11 10\n 12 11\n 13 1\n 14 10\n'), [11, 14, 12]);
  });

  it('wait returns when a squad member finishes and says so when nothing is open', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
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
