import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import os from 'node:os';
import { resolveExecutable } from './command.ts';
import { run, type RunResult } from './proc.ts';

/**
 * How a squad member's tab opens. It is always the terminal amigo runs in, found from the variables that terminal sets; one
 * that offers no way to open a tab gets a new console window (`window`). Nobody configures this. AMIGO_TERMINAL is
 * internal: it carries the found kind into squad member tabs, and `test` there runs the tab's command as a detached process.
 */
export type TerminalKind = 'tmux' | 'herdr' | 'herdr-app' | 'wezterm' | 'warp' | 'wt' | 'terminal' | 'window' | 'test';
const KINDS: readonly TerminalKind[] = ['tmux', 'herdr', 'herdr-app', 'wezterm', 'warp', 'wt', 'terminal', 'window', 'test'];

export interface TerminalEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Finds a command on PATH (default: resolveExecutable). */
  find?: (cmd: string) => string | null;
  /** Whether this process runs inside the herdr-core terminal with this id (default: insideHcTerminal). */
  insideHc?: (id: string) => boolean;
}

/** How long a herdr app or hc command may take before amigo gives up on it: a hung herdr must not hang amigo. */
export const HERDR_TIMEOUT_MS = 3000;
const quickRun: Runner = (cmd, args) => run(cmd, args, { timeoutMs: HERDR_TIMEOUT_MS });

/**
 * PowerShell that prints the ids of the processes attached to the console of process `pid`, or "none". It leaves its own
 * console, attaches to that one, asks GetConsoleProcessList and leaves again; its output goes to a pipe, not a console.
 */
const consoleListScript = (pid: number): string => [
  "Add-Type -Name C -Namespace AmigoConsole -MemberDefinition '",
  '[DllImport("kernel32.dll")] public static extern bool FreeConsole();',
  '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);',
  '[DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] list, uint count);',
  "'",
  '[void][AmigoConsole.C]::FreeConsole()',
  `if (-not [AmigoConsole.C]::AttachConsole(${pid})) { 'none'; exit }`,
  "$l = New-Object 'uint32[]' 1024",
  '$n = [AmigoConsole.C]::GetConsoleProcessList($l, 1024)',
  '[void][AmigoConsole.C]::FreeConsole()',
  "if ($n -lt 1 -or $n -gt 1024) { 'none' } else { $l[0..($n - 1)] -join ' ' }",
].join('\n');

/**
 * Whether this process shares the terminal of the process `program`: on Windows they are attached to the same console (a
 * herdr-core terminal is a pseudo console), elsewhere they have the same controlling tty. A shared ancestor is not enough: a
 * window opened from that terminal (Start-Process, wt, x-terminal-emulator) is a descendant but has a console or tty of its own.
 */
function sharesTerminal(program: number, pid: number, platform: NodeJS.Platform, runner: Runner, unchecked: (why: string) => void): boolean {
  if (platform === 'win32') {
    const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', consoleListScript(pid)]);
    if (r.error) unchecked(r.error.message);
    if (r.error || r.status !== 0) return false;
    return r.stdout.trim().split(/\s+/).map(Number).includes(program);
  }
  const r = runner('ps', ['-o', 'pid=,tty=', '-p', `${program},${pid}`]);
  if (r.error) unchecked(r.error.message);
  if (r.error || r.status !== 0) return false;
  const tty = new Map(r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 2).map(([p, t]) => [Number(p), t!]));
  const mine = tty.get(pid);
  return Boolean(mine) && !/^\?+$/.test(mine!) && tty.get(program) === mine;
}

/**
 * Whether this process runs inside the herdr-core terminal `id`: herdr-core knows it as live, and this process shares that
 * terminal's console (or tty) with its program. HC_TERMINAL_ID alone proves nothing: every process started from such a terminal
 * inherits it, also a new console window or Windows Terminal tab opened from there. A command that fails or times out means no,
 * with a warning: amigo then opens squad members as if outside herdr, and the user should know why.
 */
export function insideHcTerminal(id: string, runner: Runner = quickRun, pid: number = process.pid, platform: NodeJS.Platform = process.platform, warn: (line: string) => void = warnLine): boolean {
  const unchecked = (why: string) => warn(`amigo: could not check whether it runs in herdr terminal ${id} (${why}); squad members open as if outside herdr`);
  const r = herdrCli(runner, 'hc', ['get', id, '--json']);
  if ('error' in r && !r.answered) unchecked(r.error);
  if (!('result' in r) || r.result.state !== 'live' || typeof r.result.pid !== 'number') return false;
  return sharesTerminal(r.result.pid, pid, platform, runner, unchecked);
}

const warnLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The terminal this process runs in. tmux goes first: it may run inside any of the others. */
export function detectTerminal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, insideHc: (id: string) => boolean = (id) => insideHcTerminal(id)): TerminalKind {
  if (env.TMUX) return 'tmux';
  // A terminal started from a herdr pane inherits HERDR_PANE_ID but sets its own TERM_PROGRAM: the innermost one wins.
  if (env.TERM_PROGRAM === 'herdr' || (env.HERDR_PANE_ID && !env.TERM_PROGRAM)) return 'herdr';
  // The herdr desktop app runs its terminals in herdr-core, which sets HC_TERMINAL_ID (and no HERDR_* variable) and calls
  // itself ghostty. Those variables leak into anything started from such a terminal, so its process must be our ancestor.
  if (env.HC_TERMINAL_ID && (!env.TERM_PROGRAM || env.TERM_PROGRAM === 'ghostty') && insideHc(env.HC_TERMINAL_ID)) return 'herdr-app';
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

/** The herdr workspace amigo runs in. A queued squad member's tab is in a workspace of its own, so the carried value wins. */
export const amigoHerdrWorkspace = (env: NodeJS.ProcessEnv): string | null => env.AMIGO_HERDR_WORKSPACE || env.HERDR_WORKSPACE_ID || null;

/** The terminal found for amigo (carried in AMIGO_TERMINAL), else the one this process runs in. */
export function selectTerminal(t: TerminalEnv): TerminalKind {
  const carried = t.env.AMIGO_TERMINAL as TerminalKind | undefined;
  const kind = carried && KINDS.includes(carried) ? carried : detectTerminal(t.env, t.platform, t.insideHc);
  if (kind === 'window' && t.platform === 'linux' && !(t.find ?? ((c) => resolveExecutable(c, t.env, t.platform)))('x-terminal-emulator')) {
    throw new Error('amigo cannot open a tab or a window from this terminal: no terminal emulator found (x-terminal-emulator)');
  }
  return kind;
}

export interface TabRequest {
  /** Tab name, amigo-<id>. */
  name: string;
  title: string;
  cwd: string;
  /** The command the tab runs: node, the CLI and its arguments. */
  argv: string[];
  /** Where the tab's script is written (the task folder). */
  dir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** herdr only: where the tab goes. */
  herdr?: HerdrPlacement;
}

export interface HerdrPlacement {
  /** The tab's name: the task id and title, shortened. */
  label: string;
  /** A squad member with its own worktree gets a workspace of its own, which herdr closes when the squad member's tab does. */
  ownWorkspace: boolean;
  /** Otherwise a tab in the first of these that still exists (the reviewed squad member's, then amigo's); none left means a new workspace. */
  workspaces: string[];
}

export interface TabPlan {
  files: { path: string; content: string }[];
  /** What opens the tab. Null for 'test', and for herdr, which takes several steps (see openHerdrTab). */
  command: { cmd: string; args: string[] } | null;
  /** The Warp tab config, deleted when the squad member ends. */
  tabConfig: string | null;
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const asQuote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** "<id> · <title>", cut to about 40 characters so it fits a tab. */
export function herdrLabel(id: string, title: string, max = 40): string {
  const head = `${id} · `;
  const room = Math.max(8, max - head.length);
  const t = title.replace(/\s+/g, ' ').trim();
  return head + (t.length > room ? `${t.slice(0, room - 1).trimEnd()}…` : t);
}

function cmdArg(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`Cannot put this in a .cmd file: ${JSON.stringify(arg)}`);
  return /^[A-Za-z0-9_.:\\/=+@,-]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * The tab runs a small script, so no terminal has to parse the command line itself. The tab always closes when the squad member
 * ends, error or not: nothing waits for a key. Errors stay visible in `amigo status`, `inbox` and `attach`.
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

/** What a shell started in the tab runs: on Windows PowerShell, on macOS and Linux the login shell. `exit` closes the tab once the script is done. */
function tabShellLine(script: string, win: boolean): string {
  return win ? `& ${psQuote(script)}; exit` : `sh ${shQuote(script)}; exit`;
}

export function planTab(kind: TerminalKind, req: TabRequest, home: string = os.homedir()): TabPlan {
  const win = req.platform === 'win32';
  const path = win ? win32 : posix;
  const script = path.join(req.dir, win ? 'tab.cmd' : 'tab.sh');
  const files = [{ path: script, content: tabScript(req.argv, req.platform) }];
  const shellLine = tabShellLine(script, win);
  switch (kind) {
    case 'warp': {
      const tabConfig = path.join(warpTabConfigDir(req.platform, req.env, home), `${req.name}.toml`);
      files.push({ path: tabConfig, content: warpTabConfig(req.name, req.title, req.cwd, shellLine) });
      const url = `warp://tab_config/${req.name}`;
      const command = win ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Start-Process "${url}"`] } : { cmd: 'open', args: [url] };
      return { files, command, tabConfig };
    }
    case 'wt': {
      // `;` separates wt subcommands, so it cannot appear in an argument. `-w 0` is the window amigo runs in.
      if ([req.cwd, script].some((s) => s.includes(';'))) throw new Error('This terminal cannot open a tab in a path that contains ";"');
      const title = req.title.replace(/;/g, ',');
      return { files, command: { cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', title, '--suppressApplicationTitle', '--startingDirectory', req.cwd, 'cmd', '/c', script] }, tabConfig: null };
    }
    case 'wezterm':
      // A new tab in the window of the pane amigo runs in (WEZTERM_PANE); openTab then names it.
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
    case 'herdr':
    case 'herdr-app':
      return { files, command: null, tabConfig: null };
  }
}

type Runner = (cmd: string, args: string[]) => RunResult;

/**
 * Runs a herdr CLI and reads its JSON answer: herdr's {"result":...}, or the bare object the herdr app and hc print. A failure,
 * also one reported on stdout as {"error":"..."} or {"error":{"message":...}}, gives its real message.
 */
function herdrCli(runner: Runner, bin: string, args: string[]): { result: any } | { error: string; answered: boolean } {
  const r = runner(bin, args);
  // No answer at all (it timed out or did not start): the command may still have done its work.
  if (r.error) return { error: r.error.message, answered: false };
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // not JSON: the message below comes from the raw output
  }
  const message: string | undefined = typeof json?.error === 'string' ? json.error : json?.error?.message;
  // answered: herdr itself said no ({"error":...}), so nothing was done.
  if (r.status !== 0 || json?.error) return { error: message ?? ((r.stderr || r.stdout).trim() || `exit ${r.status}`), answered: Boolean(json?.error) };
  return { result: json?.result ?? json ?? {} };
}

/** Runs herdr: HERDR_BIN_PATH, which herdr sets, else the one on PATH. */
const herdr = (runner: Runner, env: NodeJS.ProcessEnv, args: string[]) => herdrCli(runner, env.HERDR_BIN_PATH || 'herdr', args);

/**
 * The herdr app space amigo runs in: the carried value (a queued squad member's tab is in a space of its own), else the space
 * herdr-core labels amigo's terminal (HC_TERMINAL_ID) with. Null when neither is known.
 */
export function amigoHerdrAppSpace(env: NodeJS.ProcessEnv, runner: Runner = quickRun, warn: (line: string) => void = warnLine): string | null {
  if (env.AMIGO_HERDR_WORKSPACE) return env.AMIGO_HERDR_WORKSPACE;
  if (!env.HC_TERMINAL_ID) return null;
  const r = herdrCli(runner, 'hc', ['get', env.HC_TERMINAL_ID, '--json']);
  if ('error' in r && !r.answered) warn(`amigo: could not find the herdr space of terminal ${env.HC_TERMINAL_ID} (${r.error}); squad members without a worktree get a space of their own`);
  const space = 'result' in r ? r.result.labels?.['herdr.space'] : null;
  return typeof space === 'string' && space ? space : null;
}

/**
 * Open the squad member's tab in the herdr app, placed as in herdr (see openHerdrTab), with `herdr-app do space.new | tab.new`
 * and no focus; then hc types the script's line into the tab's shell. The app closes the tab when that shell exits, and a
 * space with its last tab. Returns the space id.
 */
function openHerdrAppTab(req: TabRequest, shellLine: string, runner: Runner): string {
  const place = req.herdr;
  if (!place) throw new Error('herdr needs a placement');
  const app = (args: string[]) => herdrCli(runner, 'herdr-app', ['do', ...args]);
  /**
   * The ids of the tab one app call made. Only the app's own "no" (such as a space that is gone) returns null, so the next place
   * is tried. Anything else stops at once: after a timeout or an answer of the wrong shape the tab may exist, and trying
   * elsewhere would open a second one.
   */
  const open = (what: string, args: string[]) => {
    const r = app(args);
    if ('error' in r) {
      if (r.answered) return { refused: r.error };
      throw new Error(`Could not open a herdr ${what} for the squad member: ${r.error}`);
    }
    const { space, tab, terminal } = r.result;
    if (![space, tab, terminal].every((id) => typeof id === 'string')) throw new Error(`Could not open a herdr ${what} for the squad member: unexpected answer ${JSON.stringify(r.result)}`);
    return { space: space as string, tab: tab as string, terminal: terminal as string };
  };
  let made: { space: string; tab: string; terminal: string } | null = null;
  if (!place.ownWorkspace) {
    for (const space of place.workspaces) {
      const r = open('tab', ['tab.new', '--space', space, '--name', place.label, '--folder', req.cwd, '--focus', 'false']);
      if (!('refused' in r)) {
        made = r;
        break;
      }
    }
  }
  if (!made) {
    const r = open('space', ['space.new', '--name', place.label, '--tab', place.label, '--folder', req.cwd, '--focus', 'false']);
    if ('refused' in r) throw new Error(`Could not open a herdr space for the squad member: ${r.refused}`);
    made = r;
  }
  const typed = herdrCli(runner, 'hc', ['send', '--json', made.terminal, shellLine]);
  if ('error' in typed) {
    app(['tab.close', '--id', made.tab, '--confirmed', 'true']);
    throw new Error(`Could not start the squad member in its herdr tab: ${typed.error}`);
  }
  return made.space;
}

/**
 * Open the squad member's tab in herdr: a new workspace for a squad member with its own worktree, else a tab in the first workspace that
 * still exists (a queued squad member may start after one was closed), else a new workspace. Only the last can fail the squad member.
 * herdr closes the tab when the script's shell exits, and a workspace with its last tab. Returns the workspace id.
 */
function openHerdrTab(req: TabRequest, shellLine: string, runner: Runner): string {
  const place = req.herdr;
  if (!place) throw new Error('herdr needs a placement');
  // A success of the wrong shape counts as a failure, so the next workspace (or the clear error) follows.
  const created = (r: ReturnType<typeof herdr>) => {
    if (!('result' in r)) return null;
    const [workspace, tab, pane] = [r.result.tab?.workspace_id, r.result.tab?.tab_id, r.result.root_pane?.pane_id];
    return [workspace, tab, pane].every((id) => typeof id === 'string') ? { workspace: workspace as string, tab: tab as string, pane: pane as string } : null;
  };
  const call = (args: string[]) => herdr(runner, req.env, args);
  let made: ReturnType<typeof created> = null;
  if (!place.ownWorkspace) {
    for (const ws of place.workspaces) {
      made = created(call(['tab', 'create', '--workspace', ws, '--cwd', req.cwd, '--label', place.label, '--no-focus']));
      if (made) break;
    }
  }
  if (!made) {
    const r = call(['workspace', 'create', '--cwd', req.cwd, '--label', place.label, '--no-focus']);
    if ('error' in r) throw new Error(`Could not open a herdr workspace for the squad member: ${r.error}`);
    made = created(r);
    if (!made) throw new Error(`Could not open a herdr workspace for the squad member: unexpected answer ${JSON.stringify(r.result)}`);
    // The workspace's first tab is named "1". The name is a nicety: a failure leaves the tab open as it is.
    call(['tab', 'rename', made.tab, place.label]);
  }
  const typed = call(['pane', 'run', made.pane, shellLine]);
  if ('error' in typed) {
    call(['tab', 'close', made.tab]);
    throw new Error(`Could not start the squad member in its herdr tab: ${typed.error}`);
  }
  return made.workspace;
}

/** Write the tab's files and open it. A herdr tab also reports its workspace. */
export function openTab(kind: TerminalKind, req: TabRequest, runner: Runner = kind === 'herdr-app' ? quickRun : run): { tabConfig: string | null; herdrWorkspace: string | null } {
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
    return { tabConfig: null, herdrWorkspace: null };
  }
  if (kind === 'herdr' || kind === 'herdr-app') {
    const line = tabShellLine(plan.files[0]!.path, req.platform === 'win32');
    return { tabConfig: null, herdrWorkspace: kind === 'herdr' ? openHerdrTab(req, line, runner) : openHerdrAppTab(req, line, runner) };
  }
  const r = runner(plan.command!.cmd, plan.command!.args);
  if (r.error || r.status !== 0) throw new Error(`Could not open a tab for the squad member: ${r.error?.message ?? ((r.stderr || r.stdout).trim() || `exit ${r.status}`)}`);
  // `wezterm cli spawn` prints the new pane's id. The title is a nicety: a failure leaves the tab open as it is.
  const pane = r.stdout.trim();
  if (kind === 'wezterm' && /^\d+$/.test(pane)) runner('wezterm', ['cli', 'set-tab-title', '--pane-id', pane, req.title]);
  return { tabConfig: plan.tabConfig, herdrWorkspace: null };
}

export function removeTabConfig(path: string | null | undefined): void {
  if (path) rmSync(path, { force: true });
}
