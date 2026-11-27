import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { localBriefing, startBriefing } from './briefing.ts';
import { loadConfig } from './config.ts';
import { sessionDigest } from './digest.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { cliPath, codeRoot, home, stateDir } from './paths.ts';
import { identity, lockState } from './session.ts';
import { amigoPrompt, applyHook, leadAgent } from './squad.ts';
import { autoArm, turnEndGuard, type HookPayload, type HookResult } from './supervise.ts';
import { isT3Lead, ownCrewSession, registerLead, t3Runner, t3Thread, type T3Runner } from './t3.ts';

/**
 * amigo's lead in T3 Code. The Boss types `/amigo` (or runs `amigo`) in a T3 thread: the thread takes the session lock, is
 * registered as the home's lead, and gets the contract and the digest as the command's output. Its hooks, and every crew
 * member thread's, come from one user-level dispatcher (t3-hook.ts -> `amigo _t3-hook <event>`):
 *
 *   lead  SessionStart (after a compaction)  the contract and a fresh briefing again: in T3 they live in the conversation
 *         Stop                                the turn-end guard, and a detached watcher (`_t3-arm`) that wakes this thread
 *                                             with `t3 thread send` on an actionable event
 *         StopFailure                         the watcher again
 *   crew  UserPromptSubmit / Stop / StopFailure   the crew member hooks herdr-app tabs get through --settings (applyHook)
 */

/** What `amigo` and `amigo brief` print in a T3 thread. */
export function t3LeadBrief(agentName: string | undefined, env: NodeJS.ProcessEnv, opts: { runner?: T3Runner } = {}): string {
  const agent = leadAgent(loadConfig(env), agentName, env);
  const digest = sessionDigest(env);
  const owned = lockState(env, identity(env)).state === 'owned';
  const hooks = t3HooksInstalled(userSettingsPath(env)) ? '' : `\n\nSUPERVISION IS DOWN: amigo's T3 hook is not in ${userSettingsPath(env)}, so no watcher arms and crew members' turns are not recorded. Tell the Boss to run amigo install-skill, then start a new T3 thread with /amigo.`;
  // Another session leads this home: this thread only gets the digest (it says read-only and why), never the lead's contract.
  if (!owned) return `${digest}\nThis T3 thread is not amigo: another session leads ${home(env)}. Work in that session, or close it, then type /amigo here again.\n`;
  registerLead(agent, env, opts.runner ?? t3Runner(env));
  const briefing = startBriefing(agent, env);
  return amigoPrompt(agent, env, `${digest}\n${briefing.text}${hooks}`, { live: briefing.live, backend: 't3' });
}

const HOOK_NAMES: Record<string, 'prompt' | 'stop' | 'stop-failure'> = { UserPromptSubmit: 'prompt', Stop: 'stop', StopFailure: 'stop-failure' };

/** One hook event in a registered T3 thread (env already carries the thread's home and, for a crew member, its task). */
export async function t3Hook(event: string, payload: HookPayload, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const entry = t3Thread(env);
  if (!entry) return { code: 0 };
  if (entry.role === 'crew') {
    // A Claude session started inside the crew thread inherits its thread id, but its turns are not the crew member's.
    if (!ownCrewSession(env, payload.session_id)) return { code: 0 };
    const name = HOOK_NAMES[event];
    if (!name || !env.AMIGO_TASK) return { code: 0 };
    return { code: 0, stdout: await applyHook(name, payload, env.AMIGO_TASK, env) };
  }
  if (!isT3Lead(env)) return { code: 0 };
  if (event === 'SessionStart') {
    // A compaction summarizes the contract away: it comes back whole, with the fleet as it is now.
    if (payload.source !== 'compact') return { code: 0 };
    const agent = leadAgent(loadConfig(env), entry.agent, env);
    return { code: 0, stdout: amigoPrompt(agent, env, `The conversation was compacted: these are your instructions again, with the fleet as it is now.\n\n${localBriefing(env, false)}`, { backend: 't3' }) };
  }
  if (event === 'Stop') {
    // The watcher runs detached, so it outlives this hook; the guard then sees its claim (supervise.ts).
    spawnArm('stop', payload.session_id, env);
    // The arm is a fresh Node process that must start before its claim exists: the guard waits for it longer than for an
    // in-process hook (it returns as soon as the claim is there).
    return turnEndGuard(payload, { AMIGO_GUARD_SYNC_WAIT_MS: String(ARM_START_WAIT_MS), ...env });
  }
  if (event === 'StopFailure') spawnArm('stop-failure', payload.session_id, env);
  return { code: 0 };
}

/** How long the lead's turn-end guard waits for the detached arm to take its claim (well inside the Stop hook's 90 s). */
const ARM_START_WAIT_MS = 20_000;
/** A wake that T3 did not take is sent again this many times, a few seconds apart. */
const WAKE_SENDS = 4;

function spawnArm(event: 'stop' | 'stop-failure', session: string | undefined, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliPath, '_t3-arm', event, ...(session ? ['--session', session] : [])], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on('error', () => {});
  child.unref();
}

/**
 * `amigo _t3-arm <event>`: the lead's auto-arm (supervise.ts), outside the hook. An actionable close is sent to the lead
 * thread as its next turn, the T3 form of an asyncRewake: it is already in the durable wake queue, so a failed send loses
 * nothing the next drain would not show.
 */
export async function t3Arm(event: 'stop' | 'stop-failure', session: string | undefined, env: NodeJS.ProcessEnv, runner: T3Runner = t3Runner(env)): Promise<void> {
  const r = await autoArm({ ...(session ? { session_id: session } : {}) }, env, event);
  if (r.code !== 2 || !r.stderr || !env.T3CODE_THREAD_ID) return;
  // The thread may have stopped leading this home while the watcher slept.
  if (!isT3Lead(env)) return;
  let sent = runner(['thread', 'send', env.T3CODE_THREAD_ID, '-', '--json'], r.stderr);
  for (let attempt = 1; attempt < WAKE_SENDS && (sent.error || sent.status !== 0); attempt++) {
    await new Promise((done) => setTimeout(done, 3000 * attempt));
    sent = runner(['thread', 'send', env.T3CODE_THREAD_ID, '-', '--json'], r.stderr);
  }
  if (sent.error || sent.status !== 0) {
    mkdirSync(stateDir(env), { recursive: true });
    appendFileSync(join(stateDir(env), 'hook-errors.log'), `${new Date().toISOString()} amigo t3 wake: could not send to thread ${env.T3CODE_THREAD_ID}: ${sent.error?.message ?? (sent.stderr || sent.stdout).trim()}\n`);
  }
}

// ---------- the user-level dispatcher hook ----------

export const T3_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure'] as const;
/** The gate script every Claude Code session runs; it is how amigo's entries are told apart from the user's. */
const gate = (): string => join(codeRoot, 'src', 't3-hook.ts').replace(/\\/g, '/');
export const t3HookCommand = (event: string): string => `node "${gate()}" ${event}`;
const isOurs = (h: unknown): boolean => typeof (h as { command?: unknown })?.command === 'string' && (h as { command: string }).command.replace(/\\/g, '/').includes('/src/t3-hook.ts');

/** The user's Claude Code settings, where the dispatcher hook lives (AMIGO_CLAUDE_SETTINGS for tests). */
export const userSettingsPath = (env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): string => env.AMIGO_CLAUDE_SETTINGS || join(userHome, '.claude', 'settings.json');

type HookGroup = { matcher?: string; hooks?: unknown[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** The settings without amigo's T3 hook entries (a group left empty goes too). Every other field and hook is kept. */
export function withoutT3Hooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (Array.isArray(groups) ? groups : []).flatMap((g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(isOurs)) return [g];
      const rest = g.hooks.filter((h) => !isOurs(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** The settings with amigo's T3 hook entries, once each (an older entry, from another code folder too, is replaced). */
export function withT3Hooks(settings: Settings): Settings {
  const base = withoutT3Hooks(settings);
  const hooks = { ...(base.hooks ?? {}) };
  for (const event of T3_HOOK_EVENTS) hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command: t3HookCommand(event), timeout: event === 'Stop' ? 90 : 60 }] }];
  return { ...base, hooks };
}

function readSettings(file: string): Settings {
  // An unreadable settings file is never overwritten: readJson throws on anything but a missing file.
  return readJson<Settings>(file, {});
}

/** Whether T3 Code is installed for this user (its CLI shim), or this runs inside it. */
export const t3Installed = (env: NodeJS.ProcessEnv, userHome: string = os.homedir()): boolean => Boolean(env.T3CODE_CLI_PATH) || existsSync(join(userHome, '.t3', 'bin'));

export function t3HooksInstalled(file: string): boolean {
  try {
    const hooks = readSettings(file).hooks ?? {};
    // This code folder's exact command: an entry left by a moved or older amigo would run a gate that is not there.
    return T3_HOOK_EVENTS.every((e) => (hooks[e] ?? []).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => (h as { command?: unknown })?.command === t3HookCommand(e))));
  } catch {
    return false;
  }
}

/** Write amigo's T3 dispatcher hook into the user's Claude Code settings. Returns what was done. */
export function installT3Hooks(file: string): string {
  const before = readSettings(file);
  const after = withT3Hooks(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return `t3: the T3 Code hook is already in ${file}`;
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, after);
  return `t3: added the T3 Code hook to ${file} (${T3_HOOK_EVENTS.join(', ')}: ${t3HookCommand('<event>')}; it does nothing outside threads amigo registered)`;
}

export function removeT3Hooks(file: string): string[] {
  if (!existsSync(file)) return [];
  const before = readSettings(file);
  const after = withoutT3Hooks(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return [];
  writeJsonAtomic(file, after);
  return [`removed the T3 Code hook from ${file}`];
}
