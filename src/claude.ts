import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readJson, sleepSync, withLock, writeJsonAtomic } from './fsx.ts';
import { cliPath, home, lockPath } from './paths.ts';

/**
 * Claude Code arms run as interactive sessions in their tab: named octomaxxing-<id>, with hooks that record each turn's
 * STATUS line, and able to message the head (a Claude session named octomaxxing-head) and be messaged by it.
 */
export const HEAD_NAME = 'octomaxxing-head';
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

/** The head's extra flags when `octomaxxing head` starts Claude Code: its name, and accepting messages from arms. */
export function claudeHeadTemplate(template: string[]): string[] {
  const [cmd, ...rest] = template as [string, ...string[]];
  return [cmd, '--name', HEAD_NAME, '--settings', JSON.stringify({ crossSessionInbound: 'accept' }), ...rest];
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
export function claudeArmNotes(id: string, headIsClaude: boolean): string {
  const lines = [
    `## Your session\n\nYou are the Claude Code session \`${armName(id)}\`, open in a terminal tab the user can see and type in. Your session stays open after each turn: the head or the user may send you more.`,
  ];
  if (headIsClaude) {
    lines.push(
      `When a turn ends (done, blocked or a question), first message the head: use the SendMessage tool (load it with ToolSearch "select:SendMessage" if needed) to send \`${HEAD_NAME}\` your result. Try it once: if no session has that name or the message was not sent, just carry on. Then end with your STATUS line.`,
    );
  }
  return lines.join('\n\n');
}

/** Which agent the head runs as, written by `octomaxxing head` and `octomaxxing brief`. */
const headFile = (env: NodeJS.ProcessEnv): string => join(home(env), 'head.json');
export function recordHead(agent: string, claude: boolean, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(headFile(env), { agent, claude });
}
export function headIsClaude(env: NodeJS.ProcessEnv = process.env): boolean {
  return readJson<{ claude?: boolean }>(headFile(env), {}).claude === true;
}

// ---------- the Stop hook's check that the arm reported to the head ----------

interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

const HEAD_RE = new RegExp(`^${HEAD_NAME}( \\[[^\\]]+\\])?$`);

/** Did the latest turn (everything after the last real prompt) send a message to the head? */
export function turnMessagedHead(jsonl: string): boolean {
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
    if (e.type === 'assistant' && parts.some((p) => p.type === 'tool_use' && p.name === 'SendMessage' && typeof p.input?.to === 'string' && HEAD_RE.test(p.input.to))) return true;
    if (e.type === 'user' && parts.length > 0 && parts.some((p) => p.type !== 'tool_result')) return false;
  }
  return false;
}

export function transcriptMessagedHead(path: string | undefined): boolean {
  if (!path) return true;
  try {
    return turnMessagedHead(readFileSync(path, 'utf8'));
  } catch {
    return true; // an unreadable transcript must not trap the arm
  }
}

const SEND = `use the SendMessage tool (load it with ToolSearch "select:SendMessage" if needed) to send ${HEAD_NAME} your result. Try it once: if no session has that name or the message was not sent, just stop`;
const STATUS_LINE = 'end your final message with one line: STATUS: done|blocked|question - <one-line summary>';

/** Why the Stop hook sends the arm back: only what its turn was missing. */
export function reportReason(messaged: boolean, hasStatus: boolean): string {
  if (!messaged && !hasStatus) return `Before stopping: (1) ${SEND}. (2) Then ${STATUS_LINE}.`;
  if (!messaged) return `Before stopping, ${SEND}. Then end with your STATUS line again.`;
  return `Before stopping, ${STATUS_LINE} (your message to ${HEAD_NAME} already went out; do not send it again).`;
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
