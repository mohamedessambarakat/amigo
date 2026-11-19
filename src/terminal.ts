import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import os from 'node:os';
import { resolveExecutable } from './command.ts';
import { run } from './proc.ts';

/**
 * Where an arm's tab opens. `test` is for the test suite only: it runs the tab's command as a detached child process.
 */
export type TerminalKind = 'warp' | 'wt' | 'terminal' | 'tmux' | 'test';
const KINDS: readonly TerminalKind[] = ['warp', 'wt', 'terminal', 'tmux', 'test'];

export interface TerminalEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** OCTOMAXXING_TERMINAL, then config "terminal", then: Warp if installed, else Windows Terminal (Windows), Terminal.app (macOS) or tmux (Linux). */
export function selectTerminal(configured: string | undefined, t: TerminalEnv): TerminalKind {
  const exists = t.exists ?? existsSync;
  const forced = t.env.OCTOMAXXING_TERMINAL || configured;
  if (forced) {
    if (!KINDS.includes(forced as TerminalKind)) throw new Error(`Unknown terminal "${forced}" (use warp, wt, terminal or tmux)`);
    return forced as TerminalKind;
  }
  if (t.platform === 'win32') {
    const local = t.env.LOCALAPPDATA;
    if (local && exists(win32.join(local, 'Programs', 'Warp'))) return 'warp';
    if (resolveExecutable('wt', t.env, 'win32')) return 'wt';
    throw new Error('No terminal found for arm tabs: install Warp or Windows Terminal, or set "terminal" in config.json');
  }
  if (t.platform === 'darwin') return exists('/Applications/Warp.app') ? 'warp' : 'terminal';
  if (t.env.TMUX) return 'tmux';
  throw new Error('On Linux, arms open as tmux windows: run octomaxxing (and the head) inside tmux');
}

export interface TabRequest {
  /** Tab name, octomaxxing-<id>. */
  name: string;
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
    'is_focused = false',
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

export function removeTabConfig(path: string | null | undefined): void {
  if (path) rmSync(path, { force: true });
}
