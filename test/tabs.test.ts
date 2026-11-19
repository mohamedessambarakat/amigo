import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { applyHook, armPrompt, followUpPrompt, tabEnvArgs } from '../src/arms.ts';
import { armSettings, decodeStatusLine, guessTranscriptPath, headSettings, isBoardCommand, runUserStatusLine, statusLineShell, userStatusLine, claudeArmNotes, claudeArmTemplate, claudeHeadTemplate, claudeJsonPath, dropTrust, isClaude, mergeTrust, ownSessionEnv, reportReason, sessionAddress, turnMessagedHead } from '../src/claude.ts';
import { parseVmStat, ramAllows } from '../src/ram.ts';
import { descendants } from '../src/proc.ts';
import { beat, saveTask, type Task } from '../src/tasks.ts';
import { consoleWindowScript, planTab, selectTerminal, tabScript, warpTabConfig } from '../src/terminal.ts';
import { cleanup, cli, makeHome, tmpDir, waitFor } from './helpers.ts';

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
  it('runs arms in the background unless a terminal is set', () => {
    const tmux = () => '/usr/bin/tmux';
    const none = () => null;
    assert.equal(selectTerminal(undefined, { env: {}, platform: 'win32', find: none }), 'background', 'Windows needs nothing extra');
    assert.equal(selectTerminal(undefined, { env: {}, platform: 'darwin', find: tmux }), 'background');
    assert.equal(selectTerminal(undefined, { env: {}, platform: 'linux', find: tmux }), 'background');
    assert.throws(() => selectTerminal(undefined, { env: {}, platform: 'linux', find: none }), /install tmux/);
    assert.equal(selectTerminal(undefined, { env: { OCTOMAXXING_TERMINAL: 'wt' }, platform: 'darwin', find: none }), 'wt');
    assert.equal(selectTerminal('warp', { env: {}, platform: 'linux', find: none }), 'warp');
    assert.throws(() => selectTerminal('xterm', { env: {}, platform: 'linux', find: none }), /Unknown terminal/);
  });

  it('opens a background arm in a hidden console (Windows) or a detached tmux session', () => {
    const win = planTab('background', { ...req('win32'), cwd: "C:\\it's here" });
    assert.equal(win.tabConfig, null);
    assert.deepEqual(win.command, {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c', '"C:\\h\\tasks\\x-1\\tab.cmd"' -WorkingDirectory 'C:\\it''s here' -WindowStyle Hidden`],
    });
    assert.deepEqual(planTab('background', req('darwin')).command, { cmd: 'tmux', args: ['new-session', '-d', '-s', 'octomaxxing-x-1', '-c', '/work/my app', 'sh', '/h/tasks/x-1/tab.sh'] });
    assert.equal(planTab('background', { ...req('linux'), run: 2 }).command?.args[3], 'octomaxxing-x-1-run2', 'a follow-up never collides with the ending run');
    assert.match(consoleWindowScript(42, true), /AttachConsole\(42\)[\s\S]*ShowWindow\(\$h, 9\)/);
    assert.match(consoleWindowScript(42, false), /ShowWindow\(\$h, 0\)/);
    assert.throws(() => consoleWindowScript(Number.NaN, true), /Bad pid/);
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
    for (const kind of ['background', 'warp', 'wt', 'terminal', 'tmux'] as const) {
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
    assert.deepEqual(
      ownSessionEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'head', claude_code_child_session: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' }),
      { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' },
      "an arm drops the head session's variables and keeps the user's settings",
    );
    assert.ok(isClaude(['claude', '{prompt}']) && isClaude(['C:\\bin\\claude.exe']) && !isClaude(['codex', 'exec']));
    const t = claudeArmTemplate(['claude', '-p', '--permission-mode', 'auto', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: false, settingsFile: '/s.json' });
    assert.deepEqual(t, ['claude', '--name', 'octomaxxing-x-1', '--session-id', 'S', '--settings', '/s.json', '--permission-mode', 'auto', '{prompt}']);
    assert.deepEqual(claudeArmTemplate(['claude', '{prompt}'], { id: 'x-1', sessionId: 'S', resume: true, settingsFile: '/s.json' }).slice(3, 5), ['--resume', 'S']);
    assert.deepEqual(claudeHeadTemplate(['claude', '{prompt}'], '/h.json'), ['claude', '--name', 'octomaxxing-head', '--settings', '/h.json', '{prompt}']);
    const hooks = (armSettings() as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }).hooks;
    assert.match(hooks.Stop![0].hooks[0].command, /^node "[^"\\]+cli\.ts" _hook stop$/);
    assert.match(hooks.UserPromptSubmit![0].hooks[0].command, / _hook prompt$/);
    const status = (headSettings() as { statusLine: { command: string; refreshInterval: number } }).statusLine;
    assert.match(status.command, /^node "[^"\\]+cli\.ts" board$/);
    assert.equal(status.refreshInterval, 2);
  });

  it("keeps the user's own status line: read once from their settings, carried in the board's command", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, 'settings.json');
      const env = { OCTOMAXXING_CLAUDE_SETTINGS: file, SHELL: '/bin/zsh' };
      assert.equal(userStatusLine(env, 'linux'), undefined, 'no settings file');
      writeFileSync(file, JSON.stringify({ model: 'opus' }));
      assert.equal(userStatusLine(env, 'linux'), undefined, 'no statusLine');
      writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'node "C:/x/octomaxxing/src/cli.ts" board' } }));
      assert.equal(userStatusLine(env, 'linux'), undefined, 'the board itself is never run inside the board');
      writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'node "$HOME/.claude/statusline.js"' } }));
      const user = userStatusLine(env, 'linux');
      assert.deepEqual(user, { command: 'node "$HOME/.claude/statusline.js"', shell: ['/bin/zsh', '-c'] });
      const command = (headSettings(user) as { statusLine: { command: string } }).statusLine.command;
      const m = /^node "[^"\\]+cli\.ts" board --user ([A-Za-z0-9_-]+)$/.exec(command);
      assert.ok(m, `shell-safe board command: ${command}`);
      assert.deepEqual(decodeStatusLine(m[1]!), user);
      assert.equal(decodeStatusLine('not-json'), undefined);
      assert.ok(isBoardCommand('octomaxxing board') && !isBoardCommand('node ~/.claude/statusline.js --board-ish'));
      // On Windows, Git Bash next to git (as Claude Code uses), else PowerShell.
      const gitBin = join(dir, 'Git', 'mingw64', 'bin');
      mkdirSync(gitBin, { recursive: true });
      writeFileSync(join(gitBin, 'git.exe'), '');
      const win = { PATH: gitBin, PATHEXT: '.EXE' };
      assert.deepEqual(statusLineShell(win, 'win32'), ['powershell.exe', '-NoProfile', '-Command']);
      mkdirSync(join(dir, 'Git', 'bin'));
      writeFileSync(join(dir, 'Git', 'bin', 'bash.exe'), '');
      assert.deepEqual(statusLineShell(win, 'win32'), [join(dir, 'Git', 'bin', 'bash.exe'), '-c']);
    } finally {
      cleanup(dir);
    }
  });

  it("runs the user's status line with Claude Code's JSON, and leaves it out when it fails or hangs", async () => {
    const js = (code: string) => ({ command: code, shell: [process.execPath, '-e'] });
    const echo = js("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('model: '+JSON.parse(d).model.display_name))");
    assert.equal(await runUserStatusLine(echo, '{"model":{"display_name":"Opus"}}', process.env), 'model: Opus');
    assert.equal(await runUserStatusLine(js("console.log('half'); process.exit(3)"), '', process.env), '', 'a failing command is left out');
    assert.equal(await runUserStatusLine({ command: 'x', shell: ['no-such-shell-xyz'] }, '', process.env), '', 'a shell that cannot start is left out');
    const started = Date.now();
    assert.equal(await runUserStatusLine(js('setInterval(() => {}, 1000)'), '', process.env, 500), '', 'a hanging command is left out');
    assert.ok(Date.now() - started < 3000, 'and the board does not wait for it');
  });

  it("carries a command with quotes, $HOME and spaces through the board's command unchanged", () => {
    const tricky = `node "C:/Program Files/my line.js" --tag 'it''s' $HOME "$HOME/a b" \`pwd\` 100% & echo "done"`;
    const command = (headSettings({ command: tricky, shell: ['/bin/bash', '-c'] }) as { statusLine: { command: string } }).statusLine.command;
    const encoded = / --user ([A-Za-z0-9_-]+)$/.exec(command)![1]!;
    assert.deepEqual(decodeStatusLine(encoded), { command: tricky, shell: ['/bin/bash', '-c'] });
  });

  it('writes valid head settings with just the board when the user has no status line', () => {
    const dir = tmpDir();
    try {
      const file = join(dir, 'settings.json');
      writeFileSync(file, JSON.stringify({ model: 'opus' }));
      const settings = JSON.parse(JSON.stringify(headSettings(userStatusLine({ OCTOMAXXING_CLAUDE_SETTINGS: file }, 'linux')))) as { crossSessionInbound: string; statusLine: { type: string; command: string } };
      assert.equal(settings.crossSessionInbound, 'accept');
      assert.equal(settings.statusLine.type, 'command');
      assert.match(settings.statusLine.command, /^node "[^"\\]+cli\.ts" board$/);
    } finally {
      cleanup(dir);
    }
  });

  const gitBash = process.platform === 'win32' ? statusLineShell() : [];
  it('runs a PowerShell status line with its quotes, $HOME and spaces intact', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const ps = { command: `Write-Output "a  b" '$HOME' "$HOME" 'it''s'`, shell: ['powershell.exe', '-NoProfile', '-Command'] };
    assert.equal(await runUserStatusLine(ps, '', process.env, 10_000), `a  b\n$HOME\n${process.env.USERPROFILE}\nit's`.replace(/\n/g, '\r\n'));
  });

  it('leaves no process behind when a Git Bash status line hangs', { skip: !/bash/i.test(gitBash[0] ?? '') && 'needs Git Bash on Windows' }, async () => {
    const line = { command: 'echo "a  b" "$HOME"', shell: gitBash };
    assert.equal(await runUserStatusLine(line, '', process.env), `a  b ${process.env.HOME?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)}`, 'quotes and $HOME pass through the timeout wrapper');
    // A sleep with a duration no one else uses, so only ours are counted.
    const ours = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -match '47\\.31' }).Count`], { encoding: 'utf8' }).trim();
    const before = ours();
    const started = Date.now();
    assert.equal(await runUserStatusLine({ command: 'sleep 47.31; echo late', shell: gitBash }, '', process.env, 1000), '');
    assert.ok(Date.now() - started < 2500, 'the board does not wait for it');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([before, ours()], ['0', '0'], 'sleep.exe processes before and after the timeout');
  });

  it('ignores a non-GNU timeout found first on PATH (like Windows timeout.exe)', { skip: !/bash/i.test(gitBash[0] ?? '') && 'needs Git Bash on Windows' }, async () => {
    const dir = tmpDir();
    try {
      // Stands in for C:\Windows\System32\timeout.exe: same name, rejects GNU's arguments, prints nothing.
      writeFileSync(join(dir, 'timeout'), '#!/bin/sh\necho "ERROR: Invalid syntax." >&2\nexit 1\n', { mode: 0o755 });
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      const env = { ...process.env, [pathKey]: `${dir};${process.env[pathKey] ?? ''}` };
      // Git\usr\bin\bash.exe (what CLAUDE_CODE_GIT_BASH_PATH may name) keeps PATH's order; Git\bin\bash.exe puts /usr/bin first.
      const usrBash = join(dirname(dirname(gitBash[0]!)), 'usr', 'bin', 'bash.exe');
      assert.notEqual(execFileSync(usrBash, ['-c', 'command -v timeout'], { env, encoding: 'utf8' }).trim(), '/usr/bin/timeout', 'the fake comes first on PATH');
      assert.equal(await runUserStatusLine({ command: 'echo hi', shell: [usrBash, '-c'] }, '', env), 'hi');
    } finally {
      cleanup(dir);
    }
  });

  it('prints the arm lines, then the user line; just the arms when the user line fails or would loop', () => {
    const { dir, env } = makeHome();
    try {
      const old = new Date(Date.now() - 65_000).toISOString();
      saveTask({ id: '3-tripwire', title: 'Tripwire: MVP build plan', agent: 'fake', status: 'running', createdAt: old, updatedAt: old, startedAt: old, runs: 1, followUps: [], seen: true, project: 'tripwire', cwd: '/w', repo: null, worktree: null, branch: null, baseSha: null } as Task, env);
      const user = (code: string) => Buffer.from(JSON.stringify({ command: code, shell: [process.execPath, '-e'] })).toString('base64url');
      const mine = user("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('[mine] '+JSON.parse(d).cwd))");
      const r = cli(env, ['board', '--user', mine], '{"cwd":"/home/me/proj"}');
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /^🐙 arms: 1 running · 0 queued · 0 new results\n▶ arm3  running  Tripwire: MVP build plan  \[tripwire\]  1m 0\ds\n\[mine\] \/home\/me\/proj\n$/);
      assert.doesNotMatch(cli(env, ['board', '--user', user('process.exit(1)')]).out, /\n\n|mine/);
      assert.equal(cli({ ...env, OCTOMAXXING_IN_BOARD: '1' }, ['board', '--user', mine], '{"cwd":"x"}').out.split('\n').length, 3, 'no user line from inside itself');
    } finally {
      cleanup(dir);
    }
  });

  it('tells the arm to message the session that spawned it, whatever its name', () => {
    const head = 'uds:/tmp/head.sock';
    assert.equal(sessionAddress({ CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-ab' }), 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-ab');
    assert.equal(sessionAddress({}), undefined, 'not inside a Claude session: no messaging');
    assert.ok(claudeArmNotes('x-1', head).includes('SendMessage') && claudeArmNotes('x-1', head).includes(`\`${head}\``));
    assert.doesNotMatch(claudeArmNotes('x-1', head), /octomaxxing-head|rename/);
    assert.doesNotMatch(claudeArmNotes('x-1', undefined), /SendMessage/);
    const t = { id: 'x-1', project: 'p', cwd: '/w', followUps: ['use blue'] } as unknown as Task;
    assert.match(armPrompt(t, 'Title: paint', undefined, claudeArmNotes('x-1', head)), /octomaxxing-x-1[\s\S]*Title: paint/);
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
    const head = 'uds:/tmp/head.sock';
    assert.equal(turnMessagedHead([prompt, send(head), result].join('\n'), head), true);
    assert.equal(turnMessagedHead([prompt, send('octomaxxing-head')].join('\n'), head), false, 'only the spawning session counts');
    assert.equal(turnMessagedHead([prompt, send(head), prompt].join('\n'), head), false, 'an earlier turn does not count');
    assert.ok(reportReason(false, true, head).includes(`\`${head}\``));
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

  it('refuses to --resume a session whose transcript is missing, without launching claude', () => {
    // If the precheck let it through, this claude would fail to start and log "claude could not start" instead.
    const missingClaude = join(tmpDir(), 'no-such-dir', 'claude');
    const { dir, env } = makeHome(0, [missingClaude, '{prompt}']);
    try {
      const home = env.OCTOMAXXING_HOME as string;
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      writeFileSync(join(home, 'tasks', 'x-1', 'prompt.md'), 'Follow-up from the head: go on\n');
      const transcript = join(dir, 'projects', 'gone', 'S-1.jsonl');
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'fake', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 2, followUps: ['go on'], followUpsSent: 0, seen: true, sessionId: 'S-1', sessionStarted: true, transcriptPath: transcript }, env);
      const r = cli(env, ['_tab', 'x-1', '--run', '2']);
      assert.notEqual(r.code, 0, 'the tab stays open on the error');
      const log = readFileSync(join(home, 'tasks', 'x-1', 'output.log'), 'utf8');
      const why = `can't resume: no transcript for session S-1 at ${transcript}`;
      assert.ok(log.includes(`octomaxxing: ${why}`), log);
      assert.ok(!/could not start/.test(log), 'claude was never launched');
      const t = JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task;
      assert.deepEqual([t.status, t.summary, t.pid, t.sessionStarted], ['failed', why, null, true]);
    } finally {
      cleanup(dir);
      cleanup(dirname(dirname(missingClaude)));
    }
  });

  it('guesses the transcript path the way Claude Code names its project folders, and hooks record the real one', () => {
    assert.equal(guessTranscriptPath('C:\\Users\\me\\my app', 'S', { CLAUDE_CONFIG_DIR: join('/c', 'cfg') }), join('/c', 'cfg', 'projects', 'C--Users-me-my-app', 'S.jsonl'));
    const { dir, env } = makeHome();
    try {
      const home = env.OCTOMAXXING_HOME as string;
      mkdirSync(join(home, 'tasks', 'x-1'), { recursive: true });
      const now = new Date().toISOString();
      saveTask({ id: 'x-1', title: 't', project: 'p', agent: 'claude', cwd: dir, repo: null, worktree: null, branch: null, baseSha: null, status: 'running', createdAt: now, updatedAt: now, runs: 1, followUps: [], seen: true }, env);
      applyHook('prompt', { transcript_path: '/t/S.jsonl' }, 'x-1', env);
      assert.equal((JSON.parse(readFileSync(join(home, 'tasks', 'x-1', 'task.json'), 'utf8')) as Task).transcriptPath, '/t/S.jsonl');
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

      // Spawned by a Claude head, the turn must also have messaged it.
      saveTask({ ...task(), headAddress: 'uds:/tmp/head.sock' }, env);
      const transcript = join(dir, 't.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'go' } }));
      const noMessage = JSON.parse(applyHook('stop', { last_assistant_message: 'STATUS: question - which color?', transcript_path: transcript }, 'x-1', env));
      assert.match(noMessage.reason, /SendMessage/);
      writeFileSync(transcript, [JSON.stringify({ type: 'user', message: { content: 'go' } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'uds:/tmp/head.sock' } }] } })].join('\n'));
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

describe('memory gate and wait', () => {
  it('starts an arm only while the reserve stays free', () => {
    assert.equal(ramAllows(3000, 600, 2048, 0), true);
    assert.equal(ramAllows(3000, 600, 2048, 1), false, 'an arm still starting counts');
    assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 2000.\nPages speculative: 100.\n'), 48);
  });

  it('always lets one arm run, even when memory is below the reserve', async () => {
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
      assert.match(second, /^Queued/, 'the second waits for memory');
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
