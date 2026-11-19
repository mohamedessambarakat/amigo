import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import os from 'node:os';
import { resolveExecutable } from './command.ts';
import { run } from './proc.ts';

/**
 * How an arm's tab opens. It is always the terminal the head runs in, found from the variables that terminal sets; one
 * that offers no way to open a tab gets a new console window (`window`). Nobody configures this. OCTOMAXXING_TERMINAL is
 * internal: it carries the found kind into arm tabs, and `test` there runs the tab's command as a detached process.
 */
export type TerminalKind = 'tmux' | 'wezterm' | 'warp' | 'wt' | 'terminal' | 'window' | 'test';
const KINDS: readonly TerminalKind[] = ['tmux', 'wezterm', 'warp', 'wt', 'terminal', 'window', 'test'];

export interface TerminalEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Finds a command on PATH (default: resolveExecutable). */
  find?: (cmd: string) => string | null;
}

/** The terminal this process runs in. tmux goes first: it may run inside any of the others. */
export function detectTerminal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): TerminalKind {
  if (env.TMUX) return 'tmux';
  switch (env.TERM_PROGRAM) {
    case 'WezTerm':
      return 'wezterm';
    case 'WarpTerminal':
      return 'warp';
    case 'Apple_Terminal':
      return 'terminal';
  }
  // Windows Terminal sets no TERM_PROGRAM, only WT_SESSION, which a terminal started from it can inherit: so it is last.
  if (platform === 'win32' && env.WT_SESSION) return 'wt';
  return platform === 'darwin' ? 'terminal' : 'window';
}

/** The terminal found for the head (carried in OCTOMAXXING_TERMINAL), else the one this process runs in. */
export function selectTerminal(t: TerminalEnv): TerminalKind {
  const carried = t.env.OCTOMAXXING_TERMINAL as TerminalKind | undefined;
  const kind = carried && KINDS.includes(carried) ? carried : detectTerminal(t.env, t.platform);
  if (kind === 'window' && t.platform === 'linux' && !(t.find ?? ((c) => resolveExecutable(c, t.env, t.platform)))('x-terminal-emulator')) {
    throw new Error('octomaxxing cannot open a tab or a window from this terminal: no terminal emulator found (x-terminal-emulator)');
  }
  return kind;
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
    case 'warp': {
      const tabConfig = path.join(warpTabConfigDir(req.platform, req.env, home), `${req.name}.toml`);
      files.push({ path: tabConfig, content: warpTabConfig(req.name, req.title, req.cwd, shellLine) });
      const url = `warp://tab_config/${req.name}`;
      const command = win ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Start-Process "${url}"`] } : { cmd: 'open', args: [url] };
      return { files, command, tabConfig };
    }
    case 'wt': {
      // `;` separates wt subcommands, so it cannot appear in an argument. `-w 0` is the window the head runs in.
      if ([req.cwd, script].some((s) => s.includes(';'))) throw new Error('This terminal cannot open a tab in a path that contains ";"');
      const title = req.title.replace(/;/g, ',');
      return { files, command: { cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', title, '--suppressApplicationTitle', '--startingDirectory', req.cwd, 'cmd', '/c', script] }, tabConfig: null };
    }
    case 'wezterm':
      // A new tab in the window of the pane the head runs in (WEZTERM_PANE); openTab then names it.
      return { files, command: { cmd: 'wezterm', args: ['cli', 'spawn', '--cwd', req.cwd, '--', ...(win ? ['cmd.exe', '/c', script] : ['sh', script])] }, tabConfig: null };
    case 'window': {
      if (win) {
        // Start-Process gives cmd.exe a console window of its own, in the user's default terminal app.
        const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c', ${psQuote(`"${script}"`)} -WorkingDirectory ${psQuote(req.cwd)}`;
        return { files, command: { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] }, tabConfig: null };
      }
      return { files, command: { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `cd ${shQuote(req.cwd)} && sh ${shQuote(script)}`] }, tabConfig: null };
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
  if (r.error || r.status !== 0) throw new Error(`Could not open a tab for the arm: ${r.error?.message ?? ((r.stderr || r.stdout).trim() || `exit ${r.status}`)}`);
  // `wezterm cli spawn` prints the new pane's id. The title is a nicety: a failure leaves the tab open as it is.
  const pane = r.stdout.trim();
  if (kind === 'wezterm' && /^\d+$/.test(pane)) run('wezterm', ['cli', 'set-tab-title', '--pane-id', pane, req.title]);
  return { tabConfig: plan.tabConfig };
}

export function removeTabConfig(path: string | null | undefined): void {
  if (path) rmSync(path, { force: true });
}
