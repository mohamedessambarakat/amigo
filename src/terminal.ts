import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import os from 'node:os';
import { resolveExecutable } from './command.ts';
import { run } from './proc.ts';

/**
 * Where an arm runs. `background` (the default) opens no window: a hidden console on Windows, a detached tmux session on
 * macOS and Linux, so the arm still gets a real terminal and nothing takes your focus. The others open a visible tab.
 * `test` is for the test suite only: it runs the tab's command as a detached child process.
 */
export type TerminalKind = 'background' | 'warp' | 'wt' | 'terminal' | 'tmux' | 'test';
const KINDS: readonly TerminalKind[] = ['background', 'warp', 'wt', 'terminal', 'tmux', 'test'];

export interface TerminalEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Finds a command on PATH (default: resolveExecutable). */
  find?: (cmd: string) => string | null;
}

/** OCTOMAXXING_TERMINAL, then config "terminal", then `background`. */
export function selectTerminal(configured: string | undefined, t: TerminalEnv): TerminalKind {
  const kind = (t.env.OCTOMAXXING_TERMINAL || configured || 'background') as TerminalKind;
  if (!KINDS.includes(kind)) throw new Error(`Unknown terminal "${kind}" (use background, warp, wt, terminal or tmux)`);
  if (kind === 'background' && t.platform !== 'win32' && !(t.find ?? ((c) => resolveExecutable(c, t.env, t.platform)))('tmux')) {
    throw new Error('Background arms on macOS and Linux run in detached tmux sessions: install tmux, or set "terminal" in config.json to warp, terminal or tmux');
  }
  return kind;
}

export interface TabRequest {
  /** Tab name, octomaxxing-<id>. */
  name: string;
  /** The task's run number. A background tmux session is named after it too: the previous run's session can still be
   * ending when a follow-up starts the next, and tmux refuses two sessions with one name. */
  run?: number;
  title: string;
  cwd: string;
  /** The command the tab runs: node, the CLI and its arguments. */
  argv: string[];
  /** Where the tab's script is written (the task folder). */
  dir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface TabPlan {
  files: { path: string; content: string }[];
  command: { cmd: string; args: string[] } | null;
  /** The Warp tab config, deleted when the arm ends. */
  tabConfig: string | null;
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const asQuote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function cmdArg(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`Cannot put this in a .cmd file: ${JSON.stringify(arg)}`);
  return /^[A-Za-z0-9_.:\\/=+@,-]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * The tab runs a small script, so no terminal has to parse the command line itself. The tab always closes when the arm
 * ends, error or not: nothing waits for a key. Errors stay visible in `octomaxxing status`, `inbox` and `attach`.
 */
export function tabScript(argv: string[], platform: NodeJS.Platform): string {
  // The file is UTF-8; without chcp, cmd.exe reads it in the OEM code page and mangles non-ASCII paths.
  if (platform === 'win32') return `@echo off\r\nchcp 65001 >nul\r\n${argv.map(cmdArg).join(' ')}\r\n`;
  return `#!/bin/sh\n${argv.map(shQuote).join(' ')}\n`;
}

/** Where Warp reads tab configs: %APPDATA%\warp\Warp\data\tab_configs on Windows, ~/.warp/tab_configs on macOS. */
export function warpTabConfigDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string = os.homedir()): string {
  if (platform === 'win32') return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'tab_configs');
  return posix.join(home, '.warp', 'tab_configs');
}

export function warpTabConfig(name: string, title: string, cwd: string, command: string): string {
  return [
    `name = ${tomlString(name)}`,
    `title = ${tomlString(title)}`,
    '',
    '[[panes]]',
    'id = "main"',
    'type = "terminal"',
    `directory = ${tomlString(cwd.replace(/\\/g, '/'))}`,
    `commands = [${tomlString(command)}]`,
    'is_focused = true',
    '',
  ].join('\n');
}

export function planTab(kind: TerminalKind, req: TabRequest, home: string = os.homedir()): TabPlan {
  const win = req.platform === 'win32';
  const path = win ? win32 : posix;
  const script = path.join(req.dir, win ? 'tab.cmd' : 'tab.sh');
  const files = [{ path: script, content: tabScript(req.argv, req.platform) }];
  // Warp on Windows starts PowerShell, on macOS the login shell. `exit` closes the tab once the script is done.
  const shellLine = win ? `& ${psQuote(script)}; exit` : `sh ${shQuote(script)}; exit`;
  switch (kind) {
    case 'background': {
      if (win) {
        // Start-Process gives cmd.exe a console of its own, hidden: the arm sees a real terminal, and no window opens.
        const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c', ${psQuote(`"${script}"`)} -WorkingDirectory ${psQuote(req.cwd)} -WindowStyle Hidden`;
        return { files, command: { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] }, tabConfig: null };
      }
      // The session ends, and is gone, when the script exits. `tmux attach -t octomaxxing-<id>` watches it.
      const session = req.run === undefined ? req.name : `${req.name}-run${req.run}`;
      return { files, command: { cmd: 'tmux', args: ['new-session', '-d', '-s', session, '-c', req.cwd, 'sh', script] }, tabConfig: null };
    }
    case 'warp': {
      const tabConfig = path.join(warpTabConfigDir(req.platform, req.env, home), `${req.name}.toml`);
      files.push({ path: tabConfig, content: warpTabConfig(req.name, req.title, req.cwd, shellLine) });
      const url = `warp://tab_config/${req.name}`;
      const command = win ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Start-Process "${url}"`] } : { cmd: 'open', args: [url] };
      return { files, command, tabConfig };
    }
    case 'wt': {
      // `;` separates wt subcommands, so it cannot appear in an argument. All arms share the window "octomaxxing".
      if ([req.cwd, script].some((s) => s.includes(';'))) throw new Error('Windows Terminal cannot open a path that contains ";"');
      const title = req.title.replace(/;/g, ',');
      return { files, command: { cmd: 'wt.exe', args: ['-w', 'octomaxxing', 'new-tab', '--title', title, '--suppressApplicationTitle', '--startingDirectory', req.cwd, 'cmd', '/c', script] }, tabConfig: null };
    }
    case 'terminal': {
      const line = `cd ${shQuote(req.cwd)} && ${shellLine}`;
      return { files, command: { cmd: 'osascript', args: ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script "${asQuote(line)}"`] }, tabConfig: null };
    }
    case 'tmux':
      return { files, command: { cmd: 'tmux', args: ['new-window', '-n', req.name, '-c', req.cwd, 'sh', script] }, tabConfig: null };
    case 'test':
      return { files: [], command: null, tabConfig: null };
  }
}

/** Write the tab's files and open it. */
export function openTab(kind: TerminalKind, req: TabRequest): { tabConfig: string | null } {
  const plan = planTab(kind, req);
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  if (kind === 'test') {
    const [cmd, ...args] = req.argv as [string, ...string[]];
    const child = spawn(cmd, args, { cwd: req.cwd, detached: true, stdio: 'ignore', windowsHide: true, env: req.env });
    child.on('error', () => {});
    child.unref();
    return { tabConfig: null };
  }
  const r = run(plan.command!.cmd, plan.command!.args);
  if (r.error || r.status !== 0) throw new Error(`Could not open a ${kind} tab: ${r.error?.message ?? ((r.stderr || r.stdout).trim() || `exit ${r.status}`)}`);
  return { tabConfig: plan.tabConfig };
}

/**
 * PowerShell that shows (or hides again) the hidden console a Windows background arm runs in. It finds the window by
 * attaching to the console of a process inside it. Exit 2: that process has no console any more (the arm ended).
 */
export function consoleWindowScript(pid: number, show: boolean): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Bad pid ${pid}`);
  return [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public class OctoConsole {',
    '  [DllImport("kernel32.dll")] public static extern bool FreeConsole();',
    '  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '}',
    '"@',
    '[OctoConsole]::FreeConsole() | Out-Null',
    `if (-not [OctoConsole]::AttachConsole(${pid})) { exit 2 }`,
    '$h = [OctoConsole]::GetConsoleWindow()',
    '[OctoConsole]::FreeConsole() | Out-Null',
    'if ($h -eq [IntPtr]::Zero) { exit 2 }',
    // 9 restores the window; 0 hides it.
    show ? '[OctoConsole]::ShowWindow($h, 9) | Out-Null; [OctoConsole]::SetForegroundWindow($h) | Out-Null' : '[OctoConsole]::ShowWindow($h, 0) | Out-Null',
    'exit 0',
  ].join('\n');
}

/** Show or hide a Windows background arm's console window. */
export function setConsoleVisible(pid: number, show: boolean): void {
  const encoded = Buffer.from(consoleWindowScript(pid, show), 'utf16le').toString('base64');
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  if (r.error) throw new Error(`Could not run PowerShell: ${r.error.message}`);
  if (r.status === 2) throw new Error('The arm has no console any more: it has ended');
  if (r.status !== 0) throw new Error(`Could not ${show ? 'show' : 'hide'} the arm's window: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
}

export function removeTabConfig(path: string | null | undefined): void {
  if (path) rmSync(path, { force: true });
}
