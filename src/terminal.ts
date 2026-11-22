import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { home, stateDir } from './paths.ts';
import { killTree, run, type RunResult } from './proc.ts';

/**
 * The terminal backend: every terminal action amigo takes goes through one TerminalBackend. There are two: the herdr desktop app
 * (`herdr-app`, driven through `herdr-app do` and herdr-core's `hc`), and `test`, a fake for the test suite that runs a crew
 * member's command as a detached process. amigo runs only inside herdr-app: started anywhere else it refuses (see
 * terminalBackend). AMIGO_TERMINAL is internal: `test` selects the fake, and `herdr-app` is carried into crew member tabs so
 * they do not detect the app again.
 */
export type BackendName = 'herdr-app' | 'test';

/** The herdr-app and hc versions this backend was tested against. The session-start briefing warns when another is installed. */
export const TESTED_VERSIONS = { 'herdr-app': '0.1.16', hc: '0.1.21' } as const;

/** Where a crew member's terminal lives. `task` and the home tag are checked against the terminal's labels before any input or close. */
export interface Endpoint {
  backend: BackendName;
  /** The crew member's task id. */
  task: string;
  /** herdr-app: the space and tab holding the terminal. */
  space: string | null;
  tab: string | null;
  /** herdr-core's terminal address (`t7`); for the test backend, its own id. */
  terminal: string;
}

/**
 * live: the terminal runs. finished: its program ended but the terminal is still known. absent: no such terminal. foreign: the
 * terminal exists but carries another task's (or another home's) labels, so amigo never types into it or closes it. unreadable:
 * the backend did not answer.
 */
export type Liveness = 'live' | 'finished' | 'absent' | 'foreign' | 'unreadable';
/** busy: the agent in the terminal is working on a turn. idle: it settled. unknown: no agent status is reported. */
export type Busy = 'busy' | 'idle' | 'unknown';

export interface EndpointState {
  liveness: Liveness;
  busy: Busy;
}

export interface ListedEndpoint {
  task: string;
  terminal: string;
  space: string | null;
  tab: string | null;
  liveness: Liveness;
}

export interface Placement {
  /** The tab's name: the task id and title, shortened. */
  label: string;
  /** A crew member with its own worktree gets a space of its own, which herdr-app closes when the crew member's tab does. */
  ownSpace: boolean;
  /** Otherwise a tab in the first of these spaces that still exists (the reviewed crew member's, then amigo's); none left means a new space. */
  spaces: string[];
}

export interface OpenRequest {
  /** The crew member's task id. */
  task: string;
  cwd: string;
  /** The command the tab runs: node, the CLI and its arguments. */
  argv: string[];
  /** Where the tab's script is written (the task folder). */
  dir: string;
  /** The environment the command runs with (the test backend only: a herdr-app tab gets its shell's environment). */
  env: NodeJS.ProcessEnv;
  placement: Placement;
}

/** Every terminal action amigo takes. */
export interface TerminalBackend {
  readonly name: BackendName;
  /** The space amigo itself runs in, where crew members without a worktree open. Null when it is not known. */
  amigoSpace(): string | null;
  /** Open a crew member's terminal running req.argv. Throws with the backend's own message when it cannot. */
  open(req: OpenRequest): Endpoint;
  /** Type one line into the endpoint and submit it. Throws unless the endpoint is this task's and live. */
  send(ep: Endpoint, text: string): void;
  /** Whether the endpoint's terminal still runs, and whether its agent is busy. Never throws. */
  state(ep: Endpoint): EndpointState;
  /** End the endpoint's program and remove its terminal. Gone already is success; throws unless it is proven gone. */
  close(ep: Endpoint): void;
  /** The crew member terminals of this home. */
  list(): ListedEndpoint[];
}

export type Runner = (cmd: string, args: string[]) => RunResult;

/** How long a herdr-app or hc command may take before amigo gives up on it: a hung herdr must not hang amigo. */
export const HERDR_TIMEOUT_MS = 3000;
const quickRun: Runner = (cmd, args) => run(cmd, args, { timeoutMs: HERDR_TIMEOUT_MS });

const warnLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The labels that tie a terminal to a task of this home, so a recorded address never steers input into someone else's terminal. */
export const TASK_LABEL = 'amigo.task';
export const HOME_LABEL = 'amigo.home';

/** A short tag for this home: two homes (a test home and the real one) may hold the same task id. */
export function homeTag(env: NodeJS.ProcessEnv): string {
  return `amigo-${createHash('sha256').update(home(env)).digest('hex').slice(0, 8)}`;
}

const REFUSAL = 'amigo runs only inside the herdr desktop app (herdr-app). Open a terminal in herdr-app and start amigo there';

/**
 * The backend for this process. AMIGO_TERMINAL=test is the fake; a carried herdr-app is trusted (a crew member's tab is a
 * herdr-app terminal); otherwise this process must run inside a herdr-app terminal, or amigo refuses with the reason.
 */
export function terminalBackend(env: NodeJS.ProcessEnv, opts: { runner?: Runner; platform?: NodeJS.Platform; insideApp?: (id: string) => boolean; warn?: (line: string) => void } = {}): TerminalBackend {
  if (env.AMIGO_TERMINAL === 'test') return testBackend(env);
  const runner = opts.runner ?? quickRun;
  const warn = opts.warn ?? warnLine;
  if (env.AMIGO_TERMINAL !== 'herdr-app') {
    const why: string[] = [];
    const inside = opts.insideApp ?? ((id: string) => insideAppTerminal(id, runner, process.pid, opts.platform ?? process.platform, (w) => why.push(w)));
    if (!env.HC_TERMINAL_ID) throw new Error(`${REFUSAL}: this terminal is not one of herdr-app's (no HC_TERMINAL_ID).`);
    // herdr-core calls every terminal ghostty: a terminal started from one keeps HC_TERMINAL_ID but sets its own TERM_PROGRAM.
    if (env.TERM_PROGRAM && env.TERM_PROGRAM !== 'ghostty') throw new Error(`${REFUSAL}: this terminal is ${env.TERM_PROGRAM}, started from a herdr-app terminal but not one itself.`);
    if (!inside(env.HC_TERMINAL_ID)) throw new Error(`${REFUSAL}: this process does not run in herdr-app terminal ${env.HC_TERMINAL_ID}${why.length ? ` (${why.join('; ')})` : ''}.`);
  }
  return herdrAppBackend(env, runner, warn);
}

/**
 * PowerShell that prints two lines about process `pid`: the ids of the processes attached to its console (or "none"), then its
 * own id and those of its ancestors. For the first it leaves its own console, attaches to that one, asks GetConsoleProcessList
 * and leaves again; its output goes to a pipe, not a console. The second walks one Win32_Process snapshot.
 */
const processScript = (pid: number): string => [
  "Add-Type -Name C -Namespace AmigoConsole -MemberDefinition '",
  '[DllImport("kernel32.dll")] public static extern bool FreeConsole();',
  '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);',
  '[DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] list, uint count);',
  "'",
  '[void][AmigoConsole.C]::FreeConsole()',
  "$cl = 'none'",
  `if ([AmigoConsole.C]::AttachConsole(${pid})) {`,
  "  $l = New-Object 'uint32[]' 1024",
  '  $n = [AmigoConsole.C]::GetConsoleProcessList($l, 1024)',
  '  [void][AmigoConsole.C]::FreeConsole()',
  "  if ($n -ge 1 -and $n -le 1024) { $cl = $l[0..($n - 1)] -join ' ' }",
  '}',
  '$cl',
  '$m = @{}',
  'foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId) { $m[[uint32]$p.ProcessId] = [uint32]$p.ParentProcessId }',
  `$c = [uint32]${pid}; $up = @()`,
  'while ($c -and $up.Count -lt 64 -and -not ($up -contains $c)) { $up += $c; if (-not $m.ContainsKey($c)) { break }; $c = $m[$c] }',
  "$up -join ' '",
].join('\n');

/** Every ancestor of pid (pid itself first), from a pid -> parent map. Stops at a loop or an unknown parent. */
export function ancestry(pid: number, parent: Map<number, number>): number[] {
  const up: number[] = [];
  for (let c: number | undefined = pid; c && up.length < 64 && !up.includes(c); c = parent.get(c)) up.push(c);
  return up;
}

/**
 * Whether this process runs in the terminal whose program is `program`: it shares that terminal (on Windows the same console, a
 * herdr-core terminal being a pseudo console; elsewhere the same controlling tty), or the program is one of its ancestors. The
 * second covers an agent's own shell tool, which runs commands in a console or tty of its own: Claude Code started in the
 * terminal runs `amigo spawn` that way. A window opened from the terminal also descends from it; it then still opens its crew
 * members in herdr-app, which is what matters.
 */
function runsInTerminal(program: number, pid: number, platform: NodeJS.Platform, runner: Runner, unchecked: (why: string) => void): boolean {
  if (platform === 'win32') {
    const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', processScript(pid)]);
    if (r.error) unchecked(r.error.message);
    if (r.error || r.status !== 0) return false;
    const [consoleLine = '', ancestorLine = ''] = r.stdout.trim().split(/\r?\n/);
    const ids = (line: string) => line.trim().split(/\s+/).map(Number);
    return ids(consoleLine).includes(program) || ids(ancestorLine).includes(program);
  }
  const r = runner('ps', ['-A', '-o', 'pid=,ppid=,tty=']);
  if (r.error) unchecked(r.error.message);
  if (r.error || r.status !== 0) return false;
  const rows = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 3);
  const parent = new Map(rows.map(([p, pp]) => [Number(p), Number(pp)]));
  const tty = new Map(rows.map(([p, , t]) => [Number(p), t!]));
  const mine = tty.get(pid);
  const sharedTty = Boolean(mine) && !/^\?+$/.test(mine!) && tty.get(program) === mine;
  return sharedTty || ancestry(pid, parent).includes(program);
}

/** A JSON object as herdr-app and hc print it; fields are read through str/num/obj, which narrow what they find. */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Whether this process runs inside the herdr-app terminal `id`: herdr-core knows it as live, the app shows it (it carries a
 * herdr.space label, which the app stamps on every terminal it makes), and this process runs in it (see runsInTerminal).
 * HC_TERMINAL_ID alone proves nothing: it leaks into anything that copies an environment. A command that fails or times out
 * means no; `unchecked` hears why.
 */
export function insideAppTerminal(id: string, runner: Runner = quickRun, pid: number = process.pid, platform: NodeJS.Platform = process.platform, unchecked: (why: string) => void = () => {}): boolean {
  const r = hcCli(runner, ['get', id, '--json']);
  if ('error' in r) {
    unchecked(`hc get ${id}: ${r.error}`);
    return false;
  }
  const program = r.result.pid;
  if (r.result.state !== 'live' || typeof program !== 'number') return false;
  if (!str(obj(r.result.labels)['herdr.space'])) return false;
  return runsInTerminal(program, pid, platform, runner, unchecked);
}

/** "<id> · <title>", cut to about 40 characters so it fits a tab. */
export function herdrLabel(id: string, title: string, max = 40): string {
  const head = `${id} · `;
  const room = Math.max(8, max - head.length);
  const t = title.replace(/\s+/g, ' ').trim();
  return head + (t.length > room ? `${t.slice(0, room - 1).trimEnd()}…` : t);
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function cmdArg(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`Cannot put this in a .cmd file: ${JSON.stringify(arg)}`);
  return /^[A-Za-z0-9_.:\\/=+@,-]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * The tab runs a small script, so the shell never parses the command line itself. The tab always closes when the crew member
 * ends, error or not: nothing waits for a key. Errors stay visible in `amigo status`, `inbox` and `attach`.
 */
export function tabScript(argv: string[], platform: NodeJS.Platform): string {
  // The file is UTF-8; without chcp, cmd.exe reads it in the OEM code page and mangles non-ASCII paths.
  if (platform === 'win32') return `@echo off\r\nchcp 65001 >nul\r\n${argv.map(cmdArg).join(' ')}\r\n`;
  return `#!/bin/sh\n${argv.map(shQuote).join(' ')}\n`;
}

/** What the tab's shell runs: on Windows PowerShell (herdr-core's default shell there), elsewhere sh. `exit` closes the tab once the script is done. */
export function tabShellLine(script: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `& ${psQuote(script)}; exit` : `sh ${shQuote(script)}; exit`;
}

/** Writes the tab script into dir and returns its path. */
function writeTabScript(dir: string, argv: string[], platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const script = (win ? win32 : posix).join(dir, win ? 'tab.cmd' : 'tab.sh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(script, tabScript(argv, platform));
  return script;
}

type CliAnswer = { result: Json } | { error: string; answered: boolean; status: number | null };

/**
 * Runs herdr-app or hc and reads its JSON answer. A failure, also one reported on stdout as {"error":"..."} or
 * {"error":{"message":...}}, gives its real message; `answered` says the tool itself said no, so nothing was done.
 */
function herdrCli(runner: Runner, bin: string, args: string[]): CliAnswer {
  const r = runner(bin, args);
  // No answer at all (it timed out or did not start): the command may still have done its work.
  if (r.error) return { error: r.error.message, answered: false, status: null };
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // not JSON: the message below comes from the raw output
  }
  const body = obj(json);
  const err = body.error;
  const message = str(err) ?? str(obj(err).message);
  if (r.status !== 0 || err) return { error: message ?? ((r.stderr || r.stdout).trim() || `exit ${r.status}`), answered: Boolean(err), status: r.status };
  // An array answer (a list) is kept whole under `items`.
  return { result: Array.isArray(json) ? { items: json } : body };
}

const hcCli = (runner: Runner, args: string[]): CliAnswer => herdrCli(runner, 'hc', args);
/** hc's exit status for a terminal it does not know. */
const HC_NOT_FOUND = 3;

/** The installed herdr-app and hc versions (null when a binary does not answer `--version`). */
export function installedVersions(runner: Runner = quickRun): Record<keyof typeof TESTED_VERSIONS, string | null> {
  const version = (bin: string): string | null => {
    const r = runner(bin, ['--version']);
    if (r.error || r.status !== 0) return null;
    return new RegExp(`^${bin}\\s+v?(\\d+\\.\\d+\\.\\d+\\S*)`).exec(r.stdout.trim())?.[1] ?? null;
  };
  return { 'herdr-app': version('herdr-app'), hc: version('hc') };
}

/** One line per herdr-app or hc binary whose version is not the tested one; empty when both match. For the session-start briefing. */
export function versionWarnings(runner: Runner = quickRun): string[] {
  const found = installedVersions(runner);
  return (Object.keys(TESTED_VERSIONS) as (keyof typeof TESTED_VERSIONS)[]).flatMap((bin) => {
    const want = TESTED_VERSIONS[bin];
    const have = found[bin];
    if (have === want) return [];
    return [have ? `${bin} ${have} is installed, but amigo was tested with ${want}: crew member tabs may misbehave until amigo is checked against it.` : `${bin} did not report its version (${bin} --version); amigo was tested with ${want}.`];
  });
}

/** The version warnings for this process's backend: none for the test fake. */
export function backendVersionWarnings(env: NodeJS.ProcessEnv, runner: Runner = quickRun): string[] {
  return env.AMIGO_TERMINAL === 'test' ? [] : versionWarnings(runner);
}

const livenessOf = (state: unknown): Liveness => (state === 'live' ? 'live' : state === 'finished' ? 'finished' : 'unreadable');

/**
 * The herdr-app backend. A crew member's tab is made with `herdr-app do space.new | tab.new` (never focused), labelled with
 * its task and home through `hc label`, and its shell is given the tab script's line with `hc send`. The app closes the tab when
 * that shell exits, and a space with its last tab. Reads and input go through `hc` against the recorded terminal address.
 */
function herdrAppBackend(env: NodeJS.ProcessEnv, runner: Runner, warn: (line: string) => void): TerminalBackend {
  const tag = homeTag(env);
  const app = (args: string[]) => herdrCli(runner, 'herdr-app', ['do', ...args]);
  const read = (ep: Pick<Endpoint, 'terminal' | 'task'>): { liveness: Liveness; terminal: Json } => {
    const r = hcCli(runner, ['get', ep.terminal, '--json']);
    if ('error' in r) return { liveness: r.status === HC_NOT_FOUND ? 'absent' : 'unreadable', terminal: {} };
    const labels = obj(r.result.labels);
    if (labels[HOME_LABEL] !== tag || labels[TASK_LABEL] !== ep.task) return { liveness: 'foreign', terminal: r.result };
    return { liveness: livenessOf(r.result.state), terminal: r.result };
  };
  return {
    name: 'herdr-app',
    amigoSpace() {
      if (env.AMIGO_HERDR_SPACE) return env.AMIGO_HERDR_SPACE;
      if (!env.HC_TERMINAL_ID) return null;
      const r = hcCli(runner, ['get', env.HC_TERMINAL_ID, '--json']);
      if ('error' in r) {
        if (!r.answered) warn(`amigo: could not find the herdr-app space of terminal ${env.HC_TERMINAL_ID} (${r.error}); crew members without a worktree get a space of their own`);
        return null;
      }
      return str(obj(r.result.labels)['herdr.space']);
    },
    open(req) {
      const place = req.placement;
      const line = tabShellLine(writeTabScript(req.dir, req.argv, process.platform), process.platform);
      /**
       * The ids of the tab one app call made. Only the app's own "no" (such as a space that is gone) returns refused, so the next
       * place is tried. Anything else stops at once: after a timeout or an answer of the wrong shape the tab may exist, and trying
       * elsewhere would open a second one.
       */
      const make = (what: string, args: string[]): { space: string; tab: string; terminal: string } | { refused: string } => {
        const r = app(args);
        if ('error' in r) {
          if (r.answered) return { refused: r.error };
          throw new Error(`Could not open a herdr-app ${what} for the crew member: ${r.error}`);
        }
        const [space, tab, terminal] = [str(r.result.space), str(r.result.tab), str(r.result.terminal)];
        if (!space || !tab || !terminal) throw new Error(`Could not open a herdr-app ${what} for the crew member: unexpected answer ${JSON.stringify(r.result)}`);
        return { space, tab, terminal };
      };
      let made: { space: string; tab: string; terminal: string } | null = null;
      if (!place.ownSpace) {
        for (const space of place.spaces) {
          const r = make('tab', ['tab.new', '--space', space, '--name', place.label, '--folder', req.cwd, '--focus', 'false']);
          if (!('refused' in r)) {
            made = r;
            break;
          }
        }
      }
      if (!made) {
        const r = make('space', ['space.new', '--name', place.label, '--tab', place.label, '--folder', req.cwd, '--focus', 'false']);
        if ('refused' in r) throw new Error(`Could not open a herdr-app space for the crew member: ${r.refused}`);
        made = r;
      }
      const tab = made.tab;
      const fail = (step: string, why: string): never => {
        app(['tab.close', '--id', tab, '--confirmed', 'true']);
        throw new Error(`Could not start the crew member in its herdr-app tab (${step}): ${why}`);
      };
      const labelled = hcCli(runner, ['label', '--json', made.terminal, `${TASK_LABEL}=${req.task}`, `${HOME_LABEL}=${tag}`]);
      if ('error' in labelled) fail('hc label', labelled.error);
      const typed = hcCli(runner, ['send', '--json', made.terminal, line]);
      if ('error' in typed) fail('hc send', typed.error);
      return { backend: 'herdr-app', task: req.task, ...made };
    },
    send(ep, text) {
      const s = read(ep);
      if (s.liveness !== 'live') throw new Error(`Cannot send to ${ep.task}: its terminal ${ep.terminal} is ${s.liveness}`);
      // `--` keeps text that looks like a flag from being read as one. hc pastes it and presses Enter.
      const r = hcCli(runner, ['send', '--json', ep.terminal, '--', text]);
      if ('error' in r) throw new Error(`Could not send to ${ep.task} (terminal ${ep.terminal}): ${r.error}`);
    },
    state(ep) {
      const s = read(ep);
      const status = obj(s.terminal.status).state;
      const busy: Busy = s.liveness !== 'live' ? 'unknown' : status === 'working' ? 'busy' : status === 'idle' || status === 'done' ? 'idle' : 'unknown';
      return { liveness: s.liveness, busy };
    },
    close(ep) {
      const before = read(ep).liveness;
      if (before === 'absent') return;
      if (before === 'foreign') throw new Error(`Terminal ${ep.terminal} does not carry ${ep.task}'s labels: amigo does not close it`);
      if (before === 'unreadable') throw new Error(`Terminal ${ep.terminal} of ${ep.task} could not be read, so it was not closed`);
      // The app closes the tab and ends its terminal; when the tab is already gone, hc ends and removes the terminal.
      if (ep.tab) app(['tab.close', '--id', ep.tab, '--confirmed', 'true']);
      if (read(ep).liveness === 'live') hcCli(runner, ['kill', '--json', ep.terminal]);
      if (read(ep).liveness === 'finished') hcCli(runner, ['rm', '--json', ep.terminal]);
      const after = read(ep).liveness;
      if (after !== 'absent') throw new Error(`Terminal ${ep.terminal} of ${ep.task} is ${after} after closing it`);
    },
    list() {
      const r = hcCli(runner, ['ls', '--all', '--json', '--label', `${HOME_LABEL}=${tag}`]);
      if ('error' in r) throw new Error(`Could not list the crew member terminals (hc ls): ${r.error}`);
      const items = Array.isArray(r.result.items) ? r.result.items : Array.isArray(r.result.terminals) ? r.result.terminals : [];
      // hc ls filters by label but does not print labels: each terminal's task comes from its own hc get.
      return items.map(obj).flatMap((t) => {
        const terminal = str(t.address);
        if (!terminal) return [];
        const got = hcCli(runner, ['get', terminal, '--json']);
        const labels = 'result' in got ? obj(got.result.labels) : {};
        const task = str(labels[TASK_LABEL]);
        if (!task || labels[HOME_LABEL] !== tag) return [];
        return [{ task, terminal, space: str(labels['herdr.space']), tab: str(labels['herdr.tab']), liveness: livenessOf(obj('result' in got ? got.result : t).state) }];
      });
    },
  };
}

interface FakeRecord {
  task: string;
  home: string;
  pid: number | null;
  cwd: string;
}

/**
 * The test backend: a crew member's "tab" is its command run as a detached process. Its records live in <home>/test-terminals
 * (one JSON file per terminal, and the lines sent to it in <terminal>.input), so any amigo process of the test home sees them.
 */
function testBackend(env: NodeJS.ProcessEnv): TerminalBackend {
  const dir = join(stateDir(env), 'test-terminals');
  const tag = homeTag(env);
  const recordFile = (terminal: string) => join(dir, `${terminal}.json`);
  const load = (terminal: string): FakeRecord | null => {
    try {
      return JSON.parse(readFileSync(recordFile(terminal), 'utf8')) as FakeRecord;
    } catch {
      return null;
    }
  };
  const alive = (pid: number | null): boolean => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const liveness = (ep: Pick<Endpoint, 'terminal' | 'task'>): Liveness => {
    const rec = load(ep.terminal);
    if (!rec) return 'absent';
    if (rec.task !== ep.task || rec.home !== tag) return 'foreign';
    return alive(rec.pid) ? 'live' : 'finished';
  };
  return {
    name: 'test',
    amigoSpace: () => null,
    open(req) {
      const terminal = `tt${randomBytes(4).toString('hex')}`;
      const [cmd, ...args] = req.argv as [string, ...string[]];
      const child = spawn(cmd, args, { cwd: req.cwd, detached: true, stdio: 'ignore', windowsHide: true, env: req.env });
      child.on('error', () => {});
      child.unref();
      mkdirSync(dir, { recursive: true });
      const rec: FakeRecord = { task: req.task, home: tag, pid: child.pid ?? null, cwd: req.cwd };
      writeFileSync(recordFile(terminal), JSON.stringify(rec));
      return { backend: 'test', task: req.task, space: null, tab: null, terminal };
    },
    send(ep, text) {
      const l = liveness(ep);
      if (l !== 'live') throw new Error(`Cannot send to ${ep.task}: its terminal ${ep.terminal} is ${l}`);
      appendFileSync(join(dir, `${ep.terminal}.input`), `${text}\n`);
    },
    state: (ep) => ({ liveness: liveness(ep), busy: 'unknown' }),
    close(ep) {
      const l = liveness(ep);
      if (l === 'absent') return;
      if (l === 'foreign') throw new Error(`Terminal ${ep.terminal} does not carry ${ep.task}'s labels: amigo does not close it`);
      const rec = load(ep.terminal);
      if (rec?.pid && alive(rec.pid)) killTree(rec.pid);
      rmSync(recordFile(ep.terminal), { force: true });
      rmSync(join(dir, `${ep.terminal}.input`), { force: true });
    },
    list() {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }
      return files.flatMap((f) => {
        const terminal = f.slice(0, -'.json'.length);
        const rec = load(terminal);
        return rec && rec.home === tag ? [{ task: rec.task, terminal, space: null, tab: null, liveness: alive(rec.pid) ? ('live' as const) : ('finished' as const) }] : [];
      });
    },
  };
}
