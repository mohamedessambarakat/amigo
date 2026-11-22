import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve, sep, win32 } from 'node:path';
import { sleepSync, withLock, writeJsonAtomic } from './fsx.ts';
import { cliPath, lockPath } from './paths.ts';

/**
 * Claude Code squad members run as interactive sessions in their tab: named amigo-<id>, with hooks that record each turn's
 * STATUS line, and able to message amigo and be messaged by it. Amigo is reached by the messaging address of the
 * session that spawned the squad member, so it can be named anything; AMIGO_NAME is only the label `amigo` gives it.
 */
export const AMIGO_NAME = 'amigo';

/** The messaging address of the Claude session this command runs in (amigo, when it runs `amigo spawn`). */
export function sessionAddress(env: NodeJS.ProcessEnv): string | undefined {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  return socket ? `uds:${socket}` : undefined;
}
export const memberName = (id: string): string => `amigo-${id}`;

/**
 * Variables a running Claude session sets for the commands it runs. `amigo spawn` and `send` run in amigo's
 * shell, so without this every squad member inherits them and starts as a child of amigo's session: it then never writes its
 * own transcript (~/.claude/projects/<cwd>/<session id>.jsonl), and `--resume` of it fails with "No conversation found
 * with session ID". User settings such as CLAUDE_CONFIG_DIR or CLAUDE_CODE_USE_BEDROCK are kept.
 */
const SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]);

/** The environment for a new top-level Claude session: env without the variables of the session it was started from. */
export function ownSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.has(k.toUpperCase())));
}

/**
 * Where Claude Code keeps a session's transcript when no hook has told us: <config dir>/projects/<cwd with every
 * character other than a letter or digit turned into "-">/<session id>.jsonl. A guess from the folders it writes
 * (C:\Users\me\app becomes C--Users-me-app), not a documented rule; very long paths may be shortened differently.
 */
export function guessTranscriptPath(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** A template whose command is Claude Code. */
export function isClaude(template: string[]): boolean {
  // win32.basename splits on both / and \, so a Windows path in the config reads the same on every OS
  return /^claude(\.(exe|cmd))?$/i.test(win32.basename(template[0] ?? ''));
}

/**
 * The interactive squad member command: the configured template without -p/--print (so its permission flags stay the user's
 * choice), plus the session name, a fixed session id (resumed for follow-ups) and the hook settings.
 */
export function claudeMemberTemplate(template: string[], o: { id: string; sessionId: string; resume: boolean; settingsFile: string }): string[] {
  const [cmd, ...rest] = template as [string, ...string[]];
  return [cmd, '--name', memberName(o.id), o.resume ? '--resume' : '--session-id', o.sessionId, '--settings', o.settingsFile, ...rest.filter((a) => a !== '-p' && a !== '--print')];
}

/** Short visible first prompt when `amigo` launches Claude Code (the full lead instructions go via --append-system-prompt-file). */
export const AMIGO_FIRST_PROMPT = 'Brief me.';

/**
 * Amigo's extra flags when `amigo` starts Claude Code: its name, its settings file (amigoSettings), and the lead
 * instructions via --append-system-prompt-file. Replacing {prompt} here with the short prompt also keeps Windows .cmd
 * shims from substituting the pointer line in buildLaunch.
 */
export function claudeAmigoTemplate(template: string[], settingsFile: string, promptFile: string): string[] {
  const [cmd, ...rest] = template as [string, ...string[]];
  const hasPrompt = rest.some((a) => a.includes('{prompt}'));
  const args = hasPrompt ? rest.map((a) => a.replace(/\{prompt\}/g, AMIGO_FIRST_PROMPT)) : [...rest, AMIGO_FIRST_PROMPT];
  return [cmd, '--name', AMIGO_NAME, '--settings', settingsFile, '--append-system-prompt-file', promptFile, ...args];
}

/** Amigo's settings: accept messages from squad members. */
export function amigoSettings(): Record<string, unknown> {
  return { crossSessionInbound: 'accept' };
}

/**
 * Hook commands run in whatever shell Claude Code uses, so they start with a bare `node` (on PATH wherever amigo
 * runs) and a quoted script path with forward slashes, which bash, cmd.exe and PowerShell all read the same way.
 */
export function memberSettings(stopTimeoutSeconds = 15): Record<string, unknown> {
  const hook = (name: string, timeout = 15) => [{ hooks: [{ type: 'command', command: `node "${cliPath.replace(/\\/g, '/')}" _hook ${name}`, timeout }] }];
  return { crossSessionInbound: 'accept', hooks: { UserPromptSubmit: hook('prompt'), Stop: hook('stop', Math.max(15, stopTimeoutSeconds)), StopFailure: hook('stop-failure') } };
}

/** The squad member part only Claude squad members get. */
export function claudeMemberNotes(id: string, amigoAddress: string | undefined): string {
  const lines = [
    `## Your session\n\nYou are the Claude Code session \`${memberName(id)}\`, open in a terminal tab the user can see and type in. Your session stays open after each turn: amigo or the user may send you more.`,
  ];
  if (amigoAddress) {
    lines.push(`When a turn ends (done, blocked or a question), first message amigo, the session that started you: ${send(amigoAddress)}, just carry on. Then end with your STATUS line.`);
  }
  return lines.join('\n\n');
}

// ---------- the Stop hook's check that the squad member reported to amigo ----------

interface TranscriptEntry {
  type?: string;
  /** Set on entries Claude Code writes itself (delivery notices, Stop hook feedback): never a new prompt. */
  isMeta?: boolean;
  message?: { content?: unknown };
}

/** Did the latest turn (everything after the last real prompt) send a message to amigo's address? */
export function turnMessagedAmigo(jsonl: string, amigoAddress: string): boolean {
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
    if (e.type === 'assistant' && parts.some((p) => p.type === 'tool_use' && p.name === 'SendMessage' && p.input?.to === amigoAddress)) return true;
    if (e.type === 'user' && !e.isMeta && parts.length > 0 && parts.some((p) => p.type !== 'tool_result')) return false;
  }
  return false;
}

export function transcriptMessagedAmigo(path: string | undefined, amigoAddress: string): boolean {
  if (!path) return true;
  try {
    return turnMessagedAmigo(readFileSync(path, 'utf8'), amigoAddress);
  } catch {
    return true; // an unreadable transcript must not trap the squad member
  }
}

const send = (to: string): string =>
  `use the SendMessage tool (load it with ToolSearch "select:SendMessage" if needed) to send your result with \`to\` set to exactly \`${to}\`. Try it once: if that session is gone or the message was not sent`;
const STATUS_LINE = 'end your final message with one line: STATUS: done|blocked|question - <one-line summary>';

/** Why the Stop hook sends the squad member back: only what its turn was missing. */
export function reportReason(messaged: boolean, hasStatus: boolean, amigoAddress = ''): string {
  if (!messaged && !hasStatus) return `Before stopping: (1) ${send(amigoAddress)}, just stop. (2) Then ${STATUS_LINE}.`;
  if (!messaged) return `Before stopping, ${send(amigoAddress)}, just stop. Then end with your STATUS line again.`;
  return `Before stopping, ${STATUS_LINE} (your message to amigo already went out; do not send it again).`;
}

// ---------- workspace trust ----------

/**
 * The ways one folder can be written: as given, and with symlinks (macOS /var -> /private/var) and Windows 8.3 short
 * names resolved. A folder that does not exist yet is resolved through its nearest existing parent.
 */
const pathForms = (p: string): string[] => {
  const given = resolve(p);
  const tail: string[] = [];
  for (let dir = given; ; ) {
    try {
      return [given, join(realpathSync.native(dir), ...tail)];
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return [given];
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
};

/**
 * ~/.claude.json, or AMIGO_CLAUDE_JSON. With AMIGO_HOME in the temp folder (tests) the override is required,
 * so a test can never write the user's real file.
 */
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AMIGO_CLAUDE_JSON) return env.AMIGO_CLAUDE_JSON;
  const temps = pathForms(os.tmpdir()).map((t) => t.toLowerCase());
  // Whole folder names only: C:\Temp2 is not in C:\Temp. A drive root (C:\, /) already ends in a separator.
  const inside = (h: string, t: string) => h === t || h.startsWith(t.endsWith(sep) ? t : t + sep);
  if (env.AMIGO_HOME && pathForms(env.AMIGO_HOME).some((h) => temps.some((t) => inside(h.toLowerCase(), t)))) {
    throw new Error('AMIGO_HOME is in the temp folder but AMIGO_CLAUDE_JSON is not set; refusing to touch the real ~/.claude.json');
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
    if (change(readClaudeJson(file)) !== null) process.stderr.write(`amigo: warning: another Claude session keeps rewriting ${file}; a squad member may show the trust dialog\n`);
  });
  return true;
}

/** Mark a squad member's folder trusted so its session opens without the workspace trust dialog. True when amigo added the trust. */
export function trustFolder(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return editClaudeJson((c) => mergeTrust(c, dir), env);
}

/**
 * The config with the trust entry of `from` moved to `to`, every other field of that entry kept; just trusts `to` when there
 * is no entry for `from`. Null when nothing changes.
 */
export function moveTrust(config: Record<string, unknown>, from: string, to: string): Record<string, unknown> | null {
  const projects = { ...((config.projects as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  const oldKey = Object.keys(projects).find((k) => norm(k) === norm(from));
  if (!oldKey) return mergeTrust(config, to);
  const entry = projects[oldKey] as Record<string, unknown>;
  delete projects[oldKey];
  const newKey = Object.keys(projects).find((k) => norm(k) === norm(to)) ?? trustKey(to);
  projects[newKey] = { ...entry, ...(projects[newKey] ?? {}), hasTrustDialogAccepted: true };
  return { ...config, projects };
}

/** A moved folder keeps its ~/.claude.json entry (trust and the rest) under its new path. */
export function moveFolderTrust(from: string, to: string, env: NodeJS.ProcessEnv = process.env): void {
  editClaudeJson((c) => moveTrust(c, from, to), env);
}

/** Remove a closed squad member's worktree entry (Claude Code also adds one for every folder it runs in). */
export function forgetFolder(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  editClaudeJson((c) => dropTrust(c, dir), env);
}
