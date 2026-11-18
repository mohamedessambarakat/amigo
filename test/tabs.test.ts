import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyHook, armPrompt, followUpPrompt, tabEnvArgs } from '../src/arms.ts';
import { armSettings, claudeArmNotes, claudeArmTemplate, claudeHeadTemplate, claudeJsonPath, dropTrust, isClaude, mergeTrust, recordHead, reportReason, turnMessagedHead } from '../src/claude.ts';
import { parseVmStat, ramAllows } from '../src/ram.ts';
import { descendants } from '../src/proc.ts';
import { beat, saveTask, type Task } from '../src/tasks.ts';
import { planTab, selectTerminal, tabScript, warpTabConfig } from '../src/terminal.ts';
import { cleanup, cli, makeHome, waitFor } from './helpers.ts';

const req = (platform: NodeJS.Platform) => ({
  name: 'octomaxxing-x-1',
  title: 'octomaxxing: Fix "it"',
  cwd: platform === 'win32' ? 'C:\\work\\my app' : '/work/my app',
  argv: platform === 'win32' ? ['C:\\Program Files\\nodejs\\node.exe', 'C:\\oct\\src\\cli.ts', '_tab', 'x-1'] : ['/usr/bin/node', "/oct/it's/cli.ts", '_tab', 'x-1'],
  dir: platform === 'win32' ? 'C:\\h\\tasks\\x-1' : '/h/tasks/x-1',
  platform,
  env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
});

describe('terminal tabs', () => {
  it('picks the terminal: override, then Warp if installed, then the system terminal', () => {
    const none = () => false;
    assert.equal(selectTerminal(undefined, { env: { OCTOMAXXING_TERMINAL: 'wt' }, platform: 'darwin', exists: none }), 'wt');
    assert.equal(selectTerminal('tmux', { env: {}, platform: 'darwin', exists: none }), 'tmux');
    assert.equal(selectTerminal(undefined, { env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', exists: (p) => p.endsWith('Warp') }), 'warp');
    assert.equal(selectTerminal(undefined, { env: {}, platform: 'darwin', exists: (p) => p === '/Applications/Warp.app' }), 'warp');
    assert.equal(selectTerminal(undefined, { env: {}, platform: 'darwin', exists: none }), 'terminal');
    assert.equal(selectTerminal(undefined, { env: { TMUX: '/tmp/t' }, platform: 'linux', exists: none }), 'tmux');
    assert.throws(() => selectTerminal(undefined, { env: {}, platform: 'linux', exists: none }), /inside tmux/);
    assert.throws(() => selectTerminal('xterm', { env: {}, platform: 'linux', exists: none }), /Unknown terminal/);
  });

  it('writes a Warp tab config that runs the tab script and closes the tab', () => {
    const plan = planTab('warp', req('win32'), 'C:\\Users\\u');
    assert.equal(plan.tabConfig, 'C:\\Users\\u\\AppData\\Roaming\\warp\\Warp\\data\\tab_configs\\octomaxxing-x-1.toml');
    assert.deepEqual(plan.command, { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Process "warp://tab_config/octomaxxing-x-1"'] });
    const toml = plan.files.find((f) => f.path === plan.tabConfig)!.content;
    assert.equal(
      toml,
      [
        'name = "octomaxxing-x-1"',
        'title = "octomaxxing: Fix \\"it\\""',
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
    assert.equal(mac.tabConfig, '/Users/u/.warp/tab_configs/octomaxxing-x-1.toml');
    assert.deepEqual(mac.command, { cmd: 'open', args: ['warp://tab_config/octomaxxing-x-1'] });
    assert.match(warpTabConfig('n', 't', '/a', "sh '/h/tab.sh'; exit"), /commands = \["sh '\/h\/tab\.sh'; exit"\]/);
  });

  it('quotes the tab script for cmd.exe and sh, and never waits for a key', () => {
    assert.equal(tabScript(req('win32').argv, 'win32'), '@echo off\r\nchcp 65001 >nul\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\oct\\src\\cli.ts _tab x-1\r\n');
    assert.throws(() => tabScript(['C:\\100%\\node.exe'], 'win32'), /\.cmd file/);
    assert.equal(tabScript(req('darwin').argv, 'darwin'), "#!/bin/sh\n'/usr/bin/node' '/oct/it'\\''s/cli.ts' '_tab' 'x-1'\n");
    const waits = /pause|Read-Host|read -r|Press Enter|any key/i;
    for (const kind of ['warp', 'wt', 'terminal', 'tmux'] as const) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const plan = planTab(kind, req(platform), platform === 'win32' ? 'C:\\Users\\u' : '/Users/u');
        for (const f of plan.files) assert.doesNotMatch(f.content, waits, `${kind}/${platform}: ${f.path}`);
        assert.doesNotMatch(JSON.stringify(plan.command), waits, `${kind}/${platform} launch command`);
      }
    }
  });

  it('carries OCTOMAXXING_* settings into the tab, which does not inherit this environment', () => {
    assert.deepEqual(tabEnvArgs({ OCTOMAXXING_TERMINAL: 'wt', OCTOMAXXING_HOME: '/h', OCTOMAXXING_TASK: 'x', OCTOMAXXING_FREE_MB: '', PATH: '/bin' }), ['--env', 'OCTOMAXXING_TERMINAL=wt']);
  });

  it('opens Windows Terminal, Terminal.app and tmux tabs', () => {
    const wt = planTab('wt', { ...req('win32'), title: 'a;b' });
    assert.deepEqual(wt.command?.args, ['-w', 'octomaxxing', 'new-tab', '--title', 'a,b', '--suppressApplicationTitle', '--startingDirectory', 'C:\\work\\my app', 'cmd', '/c', 'C:\\h\\tasks\\x-1\\tab.cmd']);
    assert.throws(() => planTab('wt', { ...req('win32'), cwd: 'C:\\a;b' }), /";"/);
    const term = planTab('terminal', req('darwin'));
    assert.equal(term.command?.args.at(-1), `tell application "Terminal" to do script "cd '/work/my app' && sh '/h/tasks/x-1/tab.sh'; exit"`);
    assert.deepEqual(planTab('tmux', req('linux')).command, { cmd: 'tmux', args: ['new-window', '-n', 'octomaxxing-x-1', '-c', '/work/my app', 'sh', '/h/tasks/x-1/tab.sh'] });
  });
});

describe('Claude Code arms', () => {
  it('recognises Claude and builds the interactive arm and head commands', () => {
    assert.ok(isClaude(['claude', '{prompt}']) && isClaude(['C:\\bin\\claude.exe']) && !isClaude(['codex', 'exec']));
    const t = claudeArmTemplate(['claude', '-p', '--permission-mode', 'auto', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: false, settingsFile: '/s.json' });
    assert.deepEqual(t, ['claude', '--name', 'octomaxxing-x-1', '--session-id', 'S', '--settings', '/s.json', '--permission-mode', 'auto', '{prompt}']);
    assert.deepEqual(claudeArmTemplate(['claude', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: true, settingsFile: '/s.json' }).slice(3, 5), ['--resume', 'S']);
    assert.deepEqual(claudeHeadTemplate(['claude', '{prompt}'], '/h.json'), ['claude', '--name', 'octomaxxing-head', '--settings', '/h.json', '{prompt}']);
    const hooks = (armSettings() as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }).hooks;
    assert.match(hooks.Stop![0].hooks[0].command, /^node "[^"\\]+cli\.ts" _hook stop$/);
    assert.match(hooks.UserPromptSubmit![0].hooks[0].command, / _hook prompt$/);
  });

  it('tells the arm to message the head only when the head is Claude', () => {
    assert.match(claudeArmNotes('x-1', true), /SendMessage[\s\S]*octomaxxing-head/);
    assert.doesNotMatch(claudeArmNotes('x-1', false), /SendMessage/);
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'] } as unknown as Task;
    assert.match(armPrompt(t, 'Title: paint', undefined, claudeArmNotes('x-1', true)), /octomaxxing-x-1[\s\S]*Title: paint/);
    assert.match(followUpPrompt(t), /use blue[\s\S]*STATUS line/);
    const two = { ...t, followUps: ['old', 'lost one', 'newest'], followUpsSent: 1 } as Task;
    assert.match(followUpPrompt(two), /1\. lost one\n2\. newest/, 'every follow-up not yet given');
    assert.doesNotMatch(followUpPrompt(two), /old/);
  });

  it('finds a message to the head in the latest turn only', () => {
    const line = (o: unknown) => JSON.stringify(o);
    const prompt = line({ type: 'user', message: { content: 'do it' } });
    const send = (to: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to } }] } });
    const result = line({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    assert.equal(turnMessagedHead([prompt, send('octomaxxing-head'), result].join('\n')), true);
    assert.equal(turnMessagedHead([prompt, send('octomaxxing-head [ab12]')].join('\n')), true);
    assert.equal(turnMessagedHead([prompt, send('someone-else')].join('\n')), false);
    assert.equal(turnMessagedHead([prompt, send('octomaxxing-head'), prompt].join('\n')), false, 'an earlier turn does not count');
    assert.match(reportReason(false, false), /\(1\)[\s\S]*\(2\)/);
    assert.match(reportReason(true, false), /do not send it again/);
  });

  it('marks folders trusted without touching anything else, and removes the entry again', () => {
    const config = { theme: 'dark', projects: { 'C:/Other': { x: 1 }, 'c:/work/arm': { allowedTools: ['a'] } } };
    const next = mergeTrust(config, 'C:\\work\\arm') as typeof config & { projects: Record<string, Record<string, unknown>> };
    assert.deepEqual(next.projects['c:/work/arm'], { allowedTools: ['a'], hasTrustDialogAccepted: true });
    assert.equal(next.theme, 'dark');
    assert.equal(mergeTrust(next, 'C:/work/arm'), null, 'already trusted');
    assert.deepEqual(mergeTrust({}, '/home/u/w/')?.projects, { '/home/u/w': { allowedTools: [], hasTrustDialogAccepted: true } });
    assert.deepEqual(Object.keys((dropTrust(next, 'C:/work/arm') as typeof config).projects), ['C:/Other']);
    assert.equal(dropTrust(next, '/nope'), null);
  });

  it('never writes the real ~/.claude.json from a test home', () => {
    const { dir, env } = makeHome();
    try {
      assert.throws(() => claudeJsonPath({ OCTOMAXXING_HOME: env.OCTOMAXXING_HOME }), /refusing to touch the real/);
      assert.equal(claudeJsonPath(env), env.OCTOMAXXING_CLAUDE_JSON);
    } finally {
      cleanup(dir);
    }
  });

  it('hooks track turns: STATUS is recorded, a turn without report is sent back once', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.OCTOMAXXING_HOME as string;
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      const task = () => JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;

      const blocked = JSON.parse(applyHook('stop', { last_assistant_message: 'all done' }, 'x-1', env));
      assert.equal(blocked.decision, 'block');
      assert.match(blocked.reason, /STATUS/);
      assert.equal(task().status, 'running');

      assert.equal(applyHook('stop', { last_assistant_message: 'all done', stop_hook_active: true }, 'x-1', env), '');
      assert.deepEqual([task().status, task().summary, task().seen], ['done', 'all done', false]);

      applyHook('prompt', {}, 'x-1', env);
      assert.equal(task().status, 'running');

      // With a Claude head, the turn must also have messaged it.
      recordHead('claude', true, env);
      const transcript = join(dir, 't.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'go' } }));
      const noMessage = JSON.parse(applyHook('stop', { last_assistant_message: 'STATUS: question - which color?', transcript_path: transcript }, 'x-1', env));
      assert.match(noMessage.reason, /SendMessage/);
      writeFileSync(transcript, [JSON.stringify({ type: 'user', message: { content: 'go' } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'octomaxxing-head' } }] } })].join('\n'));
      assert.equal(applyHook('stop', { last_assistant_message: 'STATUS: question - which color?', transcript_path: transcript }, 'x-1', env), '');
      assert.deepEqual([task().status, task().summary], ['question', 'which color?']);
      assert.match(readFileSync(join(home, 'tasks', 'x-1', 'output.log'), 'utf8'), /=== turn ended .*\n.*which color\?/);

      // A turn that dies on an API error must not leave the task running.
      saveTask({ ...task(), status: 'running' }, env);
      applyHook('stop-failure', { error: 'rate_limit' }, 'x-1', env);
      assert.deepEqual([task().status, task().seen], ['blocked', false]);
      assert.match(task().summary ?? '', /rate_limit/);

      saveTask({ ...task(), status: 'closing' }, env);
      applyHook('stop', { last_assistant_message: 'STATUS: done - late', stop_hook_active: true }, 'x-1', env);
      assert.equal(task().status, 'closing', 'close owns the status');
    } finally {
      cleanup(dir);
    }
  });
});

describe('RAM gate and wait', () => {
  it('starts an arm only while the reserve stays free', () => {
    assert.equal(ramAllows(3000, 600, 2048, 0), true);
    assert.equal(ramAllows(3000, 600, 2048, 1), false, 'an arm still starting counts');
    assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 2000.\nPages speculative: 100.\n'), 48);
  });

  it('always lets one arm run, even when RAM is below the reserve', async () => {
    const { dir, env } = makeHome();
    try {
      const low = { ...env, OCTOMAXXING_FREE_MB: '10' };
      writeFileSync(join(env.OCTOMAXXING_HOME as string, 'config.json'), readFileSync(join(env.OCTOMAXXING_HOME as string, 'config.json'), 'utf8').replace('"armMb":0', '"armMb":600').replace('"reserveMb":0', '"reserveMb":2048'));
      for (const p of ['a', 'b']) {
        mkdirSync(join(dir, p));
        cli(low, ['add', join(dir, p)]);
      }
      const first = cli(low, ['spawn', '--project', 'a'], 'Title: one\nMODE:sleep').out;
      assert.match(first, /^Started/);
      const second = cli(low, ['spawn', '--project', 'b'], 'Title: two').out;
      assert.match(second, /^Queued/, 'the second waits for RAM');
      // When the first ends, nothing runs, so the second may start.
      await waitFor(/task:\s+(\S+)/.exec(second)![1]!, low, ['done']);
    } finally {
      cleanup(dir);
    }
  });

  it('a tab for an old run, or a second tab for the same run, starts nothing', () => {
    const { dir, env } = makeHome();
    try {
      const home = env.OCTOMAXXING_HOME as string;
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

  it('wait returns when an arm finishes and says so when nothing is open', async () => {
    const { dir, env } = makeHome();
    try {
      const folder = join(dir, 'p');
      mkdirSync(folder);
      cli(env, ['add', folder]);
      assert.match(cli(env, ['wait']).out, /Nothing is running or queued/);
      const out = cli(env, ['spawn', '--project', 'p'], 'Title: write').out;
      const id = /task:\s+(\S+)/.exec(out)![1]!;
      const waited = cli(env, ['wait', id, '--timeout-min', '1']);
      assert.match(waited.out, new RegExp(`${id}  done[\\s\\S]*wrote arm-output\\.txt`));
      assert.equal((await waitFor(id, env, ['done'])).seen, true);
      assert.match(cli(env, ['inbox']).out, /Inbox empty/, 'wait marks results seen');
    } finally {
      cleanup(dir);
    }
  });
});
