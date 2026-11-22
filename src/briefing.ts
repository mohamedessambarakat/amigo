import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import { loadProjects, type Project } from './config.ts';
import { gatesConfirmed } from './gates.ts';
import { isGitRepo } from './git.ts';
import { ghPath } from './github.ts';
import { BEAT_MS, beginNotice, finishNotice, touchNotice } from './notices.ts';
import { cliPath, home } from './paths.ts';
import { run } from './proc.ts';
import { FINISHED, listTasks, type Task } from './tasks.ts';
import { backendVersionWarnings } from './terminal.ts';
import { describeResults, isActive, refresh, spawnMember, stationText, stations, takeFresh, type Stations } from './squad.ts';
import { runCheck, runProgram } from './verify.ts';

export const LIVE_TITLE = 'briefing: live checks';
export const WATCH_TITLE = 'Briefing checks';

/** How long one live command may run before it is stopped. AMIGO_LIVE_TIMEOUT_MS overrides it (tests). */
export const liveTimeoutMs = (env: NodeJS.ProcessEnv): number => Number(env.AMIGO_LIVE_TIMEOUT_MS) || 60_000;

/** What a GitHub project gets when it names no live commands: open pull requests and recent CI runs (read only). */
export const DEFAULT_LIVE: readonly (readonly string[])[] = [
  ['pr', 'list', '--limit', '5'],
  ['run', 'list', '--limit', '3'],
];

/** One live command: a program with arguments (the defaults), or a shell command the user wrote and confirmed. */
export type LiveCommand = { kind: 'gh'; file: string; args: string[]; label: string } | { kind: 'shell'; command: string; label: string };

/** Defaults apply to a git project whose origin is on GitHub, when gh is available. They run gh by its absolute path, never through a shell. */
export function defaultLive(project: Project, env: NodeJS.ProcessEnv): LiveCommand[] {
  const gh = ghPath(env);
  if (!gh || !existsSync(project.path) || !isGitRepo(project.path)) return [];
  const origin = run('git', ['-C', project.path, 'remote', 'get-url', 'origin']);
  if (origin.status !== 0 || !/github\.com[:/]/i.test(origin.stdout)) return [];
  return DEFAULT_LIVE.map((args) => ({ kind: 'gh' as const, file: gh, args: [...args], label: `gh ${args.join(' ')}` }));
}

/**
 * The live commands to run for a project. Its own commands run only once the user confirmed them (confirm-gates, which needs a
 * terminal): they are shell commands that start in the project folder at every amigo start. Otherwise `skipped` says so.
 */
export function livePlan(project: Project, env: NodeJS.ProcessEnv): { commands: LiveCommand[]; skipped?: string } {
  if (project.live === undefined) return { commands: defaultLive(project, env) };
  if (!project.live.length) return { commands: [] };
  if (!gatesConfirmed(project, env)) return { commands: [], skipped: `Live commands of ${project.name} skipped: you have not confirmed them (in a terminal: amigo confirm-gates ${project.name}).` };
  return { commands: project.live.map((command) => ({ kind: 'shell' as const, command, label: command })) };
}

/** The text of the briefing that comes from local state alone: what finished, what waits on the user, what is open. */
export function localBriefing(env: NodeJS.ProcessEnv, consume = true): string {
  refresh(env);
  const tasks = listTasks(env);
  const fresh: Task[] = consume ? takeFresh([], env) : tasks.filter((t) => FINISHED.includes(t.status) && !t.seen);
  const s = stations(tasks);
  const known = new Set(fresh.map((t) => t.id));
  const none: Stations = { queued: [], building: [], verifying: [], review: [], closing: [], waiting: [], done: [] };
  const waiting = stationText({ ...none, waiting: s.waiting.filter((t) => !known.has(t.id)) }, tasks);
  const open = stationText({ ...s, waiting: [], done: [] }, tasks);
  const projects = loadProjects(env).length;
  const sections = [
    fresh.length ? `Finished since your last look (${fresh.length}):\n${describeResults(fresh)}` : '',
    s.waiting.some((t) => !known.has(t.id)) ? waiting : '',
    tasks.some((t) => t.status === 'queued' || isActive(t) || t.status === 'closing') ? `Open:\n${open}` : '',
  ].filter(Boolean);
  return [`${projects} project${projects === 1 ? '' : 's'} registered.`, ...(sections.length ? sections : ['Nothing finished, nothing waiting on you, nothing open.'])].join('\n');
}

/** The brief of the one squad member that looks at the projects' `watch` items. */
export function watchBrief(projects: Project[]): string {
  const items = projects.filter((p) => p.watch?.length).map((p) => `Project ${p.name} (${p.path}):\n${p.watch!.map((w) => `- ${w}`).join('\n')}`);
  return [
    `Title: ${WATCH_TITLE}`,
    "You are doing the startup checks for the user's briefing. Your working directory is a scratch folder; you may read the project folders named below, read only.",
    "Look at each item and say, in your STATUS line, only what needs the user's attention (or that everything is fine). Change nothing: no edits, no commits, no pushes, nothing sent to anyone.",
    '',
    ...items,
  ].join('\n');
}

const indent = (text: string): string => text.split(/\r?\n/).map((l) => `    ${l}`).join('\n');

/** The environment shell live commands run in: a test's fake gh (AMIGO_GH) is found first when they say `gh`. */
function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gh = env.AMIGO_GH ? ghPath(env) : null;
  if (!gh) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: [dirname(gh), env[key] ?? ''].filter(Boolean).join(delimiter) };
}

/**
 * `amigo _live <notice id>`: the detached process the briefing starts. Runs every project's live commands in the project's
 * own folder (never in a squad member's worktree), each with a time limit, then fills in the notice the inbox will show.
 * It beats while it works, so a slow run is never taken for a dead one.
 */
export async function runLiveChecks(noticeId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const out: string[] = [];
  const timer = setInterval(() => {
    try {
      touchNotice(noticeId, env);
    } catch {
      // a missed beat is made up by the next one
    }
  }, BEAT_MS);
  try {
    for (const p of loadProjects(env)) {
      const { commands } = livePlan(p, env);
      if (!commands.length) continue;
      if (!existsSync(p.path)) {
        out.push(`[${p.name}] folder is missing: ${p.path}`);
        continue;
      }
      for (const c of commands) {
        const r = c.kind === 'gh' ? await runProgram(c.file, c.args, p.path, liveTimeoutMs(env), env, c.label) : await runCheck(c.command, p.path, liveTimeoutMs(env), shellEnv(env));
        out.push(`[${p.name}] $ ${c.label}${r.ok ? '' : r.timedOut ? ' (timed out)' : ` (exit ${r.exitCode})`}\n${indent(r.output.trim() || '(no output)')}`);
      }
    }
  } catch (err) {
    out.push(`The live checks stopped: ${(err as Error).message}`);
  } finally {
    clearInterval(timer);
  }
  finishNotice(noticeId, out.join('\n') || 'No live commands are configured.', env);
}

/** Start the detached process that runs the live checks. */
function startLiveProcess(noticeId: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliPath, '_live', noticeId], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, AMIGO_HOME: home(env) } });
  child.unref();
}

export interface Briefing {
  text: string;
  /** Live checks were started: their result arrives in the inbox. */
  live: boolean;
}

/**
 * What the start of amigo does: begin the live checks in the background (one notice in the inbox when they finish), spawn one
 * scratch squad member for the projects' `watch` items, and return the briefing text. With dryRun nothing is started.
 * The live commands and watch items of a project run only once the user confirmed them. The squad member is told to change
 * nothing; that is a rule given to it, not something enforced here.
 */
export function startBriefing(agent: string | undefined, env: NodeJS.ProcessEnv, opts: { dryRun?: boolean } = {}): Briefing {
  const projects = loadProjects(env);
  // A herdr-app or hc other than the tested one may have changed the commands amigo relies on.
  const notes: string[] = backendVersionWarnings(env);
  const plans = projects.map((p) => livePlan(p, env));
  for (const plan of plans) if (plan.skipped) notes.push(plan.skipped);
  const hasLive = plans.some((plan) => plan.commands.length > 0);
  const withWatch = projects.filter((p) => p.watch?.length);
  const watched = withWatch.filter((p) => gatesConfirmed(p, env));
  for (const p of withWatch) if (!watched.includes(p)) notes.push(`Watch items of ${p.name} skipped: you have not confirmed them (in a terminal: amigo confirm-gates ${p.name}).`);
  let live = false;
  if (opts.dryRun) {
    if (hasLive) notes.push('Live checks would run in the background (dry run: not started).');
    if (watched.length) notes.push(`A squad member "${WATCH_TITLE}" would check: ${watched.map((p) => p.name).join(', ')} (dry run: not started).`);
  } else {
    if (hasLive) {
      startLiveProcess(beginNotice(LIVE_TITLE, env), env);
      live = true;
      notes.push(`Live checks are running in the background; the result lands in your inbox as "${LIVE_TITLE}".`);
    }
    if (watched.length) {
      const open = listTasks(env).find((t) => t.briefing && t.status !== 'closed');
      if (open) {
        notes.push(`The "${WATCH_TITLE}" squad member ${open.id} is still open (${open.status}); not starting another. Close it to run the watch items again.`);
      } else {
        try {
          const { task } = spawnMember({ scratch: true, briefing: true, brief: watchBrief(watched), title: WATCH_TITLE, agent }, {}, env);
          notes.push(`Squad member ${task.id} ("${WATCH_TITLE}") is checking the watch items of: ${watched.map((p) => p.name).join(', ')}.`);
        } catch (err) {
          notes.push(`Could not start the "${WATCH_TITLE}" squad member: ${(err as Error).message}`);
        }
      }
    }
  }
  return { text: [localBriefing(env, !opts.dryRun), ...notes].join('\n'), live };
}
