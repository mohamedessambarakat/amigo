import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveExecutable } from './command.ts';
import { sleepSync, withLock, writeJsonAtomic } from './fsx.ts';
import { cliPath, lockPath } from './paths.ts';
import { killTree } from './proc.ts';

/**
 * Claude Code arms run as interactive sessions in their tab: named octomaxxing-<id>, with hooks that record each turn's
 * STATUS line, and able to message the head and be messaged by it. The head is reached by the messaging address of the
 * session that spawned the arm, so it can be named anything; HEAD_NAME is only the label `octomaxxing head` gives it.
 */
export const HEAD_NAME = 'octomaxxing-head';

/** The messaging address of the Claude session this command runs in (the head, when it runs `octomaxxing spawn`). */
export function sessionAddress(env: NodeJS.ProcessEnv): string | undefined {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  return socket ? `uds:${socket}` : undefined;
}
export const armName = (id: string): string => `octomaxxing-${id}`;

/** A template whose command is Claude Code. */
export function isClaude(template: string[]): boolean {
  return /^claude(\.(exe|cmd))?$/i.test(basename(template[0] ?? ''));
}

/**
 * The interactive arm command: the configured template without -p/--print (so its permission flags stay the user's
 * choice), plus the session name, a fixed session id (resumed for follow-ups) and the hook settings.
 */
export function claudeArmTemplate(template: string[], o: { id: string; sessionId: string; resume: boolean; settingsFile: string }): string[] {
  const [cmd, ...rest] = template as [string, ...string[]];
  return [cmd, '--name', armName(o.id), o.resume ? '--resume' : '--session-id', o.sessionId, '--settings', o.settingsFile, ...rest.filter((a) => a !== '-p' && a !== '--print')];
}

/**
 * The head's extra flags when `octomaxxing head` starts Claude Code: its name, and its settings file (headSettings).
 * The settings go in a file, not inline JSON: an npm install starts through cmd.exe on Windows, which mangles the quotes.
 */
export function claudeHeadTemplate(template: string[], settingsFile: string): string[] {
  const [cmd, ...rest] = template as [string, ...string[]];
  return [cmd, '--name', HEAD_NAME, '--settings', settingsFile, ...rest];
}

/** The user's own status line, kept under the board: their command and the shell to run it in (found once, at start-up). */
export interface UserStatusLine {
  command: string;
  shell: string[];
}

/** ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json), or OCTOMAXXING_CLAUDE_SETTINGS. Only ever read. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOMAXXING_CLAUDE_SETTINGS || join(env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'settings.json');
}

/** A statusLine command that is octomaxxing's own board, which must never run inside the board. */
export const isBoardCommand = (command: string): boolean => /(octomaxxing|cli\.ts)["']?\s+board\b/i.test(command);

/**
 * The shell Claude Code runs status lines in: Git Bash on Windows when it is installed, else PowerShell; elsewhere the
 * user's $SHELL. Found at start-up so the board, which runs every 2s, never searches PATH.
 */
export function statusLineShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [env.SHELL || '/bin/sh', '-c'];
  // git.exe sits in Git\cmd, Git\bin or Git\mingw64\bin; bash.exe in Git\bin.
  const git = resolveExecutable('git', env, platform);
  const near = git ? [dirname(dirname(git)), dirname(dirname(dirname(git)))].map((root) => join(root, 'bin', 'bash.exe')) : [];
  const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, ...near].find((p) => p && existsSync(p));
  return bash ? [bash, '-c'] : ['powershell.exe', '-NoProfile', '-Command'];
}

/** The user's configured statusLine command, or undefined when there is none, it cannot be read, or it is the board. */
export function userStatusLine(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): UserStatusLine | undefined {
  let command: unknown;
  try {
    const settings = JSON.parse(readFileSync(claudeSettingsPath(env), 'utf8')) as { statusLine?: { type?: string; command?: unknown } };
    if (settings.statusLine?.type === 'command') command = settings.statusLine.command;
  } catch {
    return undefined; // no settings file, or one being written: the head simply starts without the user's line
  }
  if (typeof command !== 'string' || !command.trim() || isBoardCommand(command)) return undefined;
  return { command, shell: statusLineShell(env, platform) };
}

/** The user's line travels in the board's own command as base64url, which every shell passes through untouched. */
export const encodeStatusLine = (line: UserStatusLine): string => Buffer.from(JSON.stringify(line)).toString('base64url');
export function decodeStatusLine(encoded: string): UserStatusLine | undefined {
  try {
    const v = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UserStatusLine;
    return typeof v.command === 'string' && Array.isArray(v.shell) && v.shell.length > 0 && v.shell.every((a) => typeof a === 'string') ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Set while the user's command runs, so a board started from inside it (a loop) prints only the arms. */
export const IN_BOARD_ENV = 'OCTOMAXXING_IN_BOARD';

/**
 * Run the user's status line with the JSON Claude Code sent the board on stdin, and give back its output, or '' when it
 * fails, prints nothing or takes longer than timeoutMs (then its whole process tree is stopped).
 */
export function runUserStatusLine(line: UserStatusLine, stdin: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 1000): Promise<string> {
  return new Promise((done) => {
    const [shell, ...args] = line.shell as [string, ...string[]];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [...args, line.command], { env: { ...env, [IN_BOARD_ENV]: '1' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return done('');
    }
    let out = '';
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      done(text);
    };
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      finish('');
    }, timeoutMs);
    child.on('error', () => finish(''));
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.on('close', (code) => finish(code === 0 ? out.replace(/\s+$/, '') : ''));
    child.stdin?.on('error', () => {}); // a command that never reads stdin may close it early
    child.stdin?.end(stdin);
  });
}

/** The head's settings: accept messages from arms, and show the live board of arms (then the user's own line) as the status line. */
export function headSettings(user?: UserStatusLine): Record<string, unknown> {
  const command = `node "${cliPath.replace(/\\/g, '/')}" board${user ? ` --user ${encodeStatusLine(user)}` : ''}`;
  return { crossSessionInbound: 'accept', statusLine: { type: 'command', command, refreshInterval: 2 } };
}

/**
 * Hook commands run in whatever shell Claude Code uses, so they start with a bare `node` (on PATH wherever octomaxxing
 * runs) and a quoted script path with forward slashes, which bash, cmd.exe and PowerShell all read the same way.
 */
export function armSettings(): Record<string, unknown> {
  const hook = (name: string) => [{ hooks: [{ type: 'command', command: `node "${cliPath.replace(/\\/g, '/')}" _hook ${name}`, timeout: 15 }] }];
  return { crossSessionInbound: 'accept', hooks: { UserPromptSubmit: hook('prompt'), Stop: hook('stop'), StopFailure: hook('stop-failure') } };
}

/** The arm part only Claude arms get. */
export function claudeArmNotes(id: string, headAddress: string | undefined): string {
  const lines = [
    `## Your session\n\nYou are the Claude Code session \`${armName(id)}\`. You may be running in the background with no window, so never wait for someone to type into your session: ask questions through your report. Your session stays open after each turn: the head may send you more.`,
  ];
  if (headAddress) {
    lines.push(`When a turn ends (done, blocked or a question), first message the head, the session that started you: ${send(headAddress)}, just carry on. Then end with your STATUS line.`);
  }
  return lines.join('\n\n');
}

// ---------- the Stop hook's check that the arm reported to the head ----------

interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

/** Did the latest turn (everything after the last real prompt) send a message to the head's address? */
export function turnMessagedHead(jsonl: string, headAddress: string): boolean {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // a partly written last line is fine to skip
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const content = e.message?.content;
    const parts: { type?: string; name?: string; input?: { to?: unknown } }[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text' }] : [];
    if (e.type === 'assistant' && parts.some((p) => p.type === 'tool_use' && p.name === 'SendMessage' && p.input?.to === headAddress)) return true;
    if (e.type === 'user' && parts.length > 0 && parts.some((p) => p.type !== 'tool_result')) return false;
  }
  return false;
}

export function transcriptMessagedHead(path: string | undefined, headAddress: string): boolean {
  if (!path) return true;
  try {
    return turnMessagedHead(readFileSync(path, 'utf8'), headAddress);
  } catch {
    return true; // an unreadable transcript must not trap the arm
  }
}

const send = (to: string): string =>
  `use the SendMessage tool (load it with ToolSearch "select:SendMessage" if needed) to send your result with \`to\` set to exactly \`${to}\`. Try it once: if that session is gone or the message was not sent`;
const STATUS_LINE = 'end your final message with one line: STATUS: done|blocked|question - <one-line summary>';

/** Why the Stop hook sends the arm back: only what its turn was missing. */
export function reportReason(messaged: boolean, hasStatus: boolean, headAddress = ''): string {
  if (!messaged && !hasStatus) return `Before stopping: (1) ${send(headAddress)}, just stop. (2) Then ${STATUS_LINE}.`;
  if (!messaged) return `Before stopping, ${send(headAddress)}, just stop. Then end with your STATUS line again.`;
  return `Before stopping, ${STATUS_LINE} (your message to the head already went out; do not send it again).`;
}

// ---------- workspace trust ----------

/**
 * ~/.claude.json, or OCTOMAXXING_CLAUDE_JSON. With OCTOMAXXING_HOME in the temp folder (tests) the override is required,
 * so a test can never write the user's real file.
 */
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OCTOMAXXING_CLAUDE_JSON) return env.OCTOMAXXING_CLAUDE_JSON;
  if (env.OCTOMAXXING_HOME && resolve(env.OCTOMAXXING_HOME).toLowerCase().startsWith(resolve(os.tmpdir()).toLowerCase())) {
    throw new Error('OCTOMAXXING_HOME is in the temp folder but OCTOMAXXING_CLAUDE_JSON is not set; refusing to touch the real ~/.claude.json');
  }
  return join(os.homedir(), '.claude.json');
}

/** Claude Code keys projects by path with forward slashes. */
export const trustKey = (dir: string): string => dir.replace(/\\/g, '/').replace(/\/+$/, '');
const norm = (p: string): string => (/^[a-zA-Z]:/.test(trustKey(p)) ? trustKey(p).toLowerCase() : trustKey(p));

/**
 * The config with dir marked trusted by an entry of its own (a trusted parent folder is not reliably inherited), or null
 * when nothing changes. Every other field is kept.
 */
export function mergeTrust(config: Record<string, unknown>, dir: string): Record<string, unknown> | null {
  const projects = { ...((config.projects as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  const key = Object.keys(projects).find((k) => norm(k) === norm(dir)) ?? trustKey(dir);
  const cur = projects[key];
  if (cur?.hasTrustDialogAccepted === true) return null;
  projects[key] = cur ? { ...cur, hasTrustDialogAccepted: true } : { allowedTools: [], hasTrustDialogAccepted: true };
  return { ...config, projects };
}

/** The config without the entry for dir, or null when there is none. */
export function dropTrust(config: Record<string, unknown>, dir: string): Record<string, unknown> | null {
  const projects = (config.projects as Record<string, unknown> | undefined) ?? {};
  const key = Object.keys(projects).find((k) => norm(k) === norm(dir));
  if (!key) return null;
  const { [key]: _, ...rest } = projects;
  return { ...config, projects: rest };
}

function readClaudeJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  // A running Claude session may be mid-write; a torn read fails to parse, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if (attempt >= 5) throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
      sleepSync(100);
    }
  }
}

/**
 * Apply change to ~/.claude.json under a lock, re-reading right before the write. A running Claude session rewrites the
 * whole file from memory and can undo the write, so the result is checked once more and written again if it was lost.
 */
function editClaudeJson(change: (c: Record<string, unknown>) => Record<string, unknown> | null, env: NodeJS.ProcessEnv): boolean {
  const file = claudeJsonPath(env);
  if (change(readClaudeJson(file)) === null) return false;
  withLock(lockPath('claude-json', env), () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = change(readClaudeJson(file));
      if (!next) return;
      writeJsonAtomic(file, next);
      sleepSync(200);
    }
    if (change(readClaudeJson(file)) !== null) process.stderr.write(`octomaxxing: warning: another Claude session keeps rewriting ${file}; an arm may show the trust dialog\n`);
  });
  return true;
}

/** Mark an arm's folder trusted so its session opens without the workspace trust dialog. True when octomaxxing added the trust. */
export function trustFolder(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return editClaudeJson((c) => mergeTrust(c, dir), env);
}

/** Remove a closed arm's worktree entry (Claude Code also adds one for every folder it runs in). */
export function forgetFolder(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  editClaudeJson((c) => dropTrust(c, dir), env);
}
