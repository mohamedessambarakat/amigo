import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeAway, readAway } from './away.ts';
import { resolveExecutable } from './command.ts';
import { loadProjects } from './config.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { ghPath, runGh } from './github.ts';
import { BEAT_MS, beginNotice, finishNotice, touchNotice } from './notices.ts';
import { tangleBranch } from './projects.ts';
import { bossPath, cliPath, home, learningsPath, stateDir } from './paths.ts';
import { backlogActive, replayPendingCloses } from './backlog.ts';
import { acquireSessionLock, describeHolder, identity, type Acquired, type Identity } from './session.ts';
import { syncProjects } from './sync.ts';
import { FINISHED, listTasks, type Task } from './tasks.ts';
import { backendVersionWarnings } from './terminal.ts';
import { appendWake, describeDrain, drainWakes } from './wakes.ts';
import { crewState, listChecks, stoppedResponding, supervisionNeed, watcherHealthy } from './watch.ts';
import { treehousePath } from './worktree.ts';

/**
 * The session-start digest (ported from fm-session-start.sh and the session-start-recovery skill), run once per
 * session by amigo's SessionStart hook or by `amigo digest`. In order:
 *   1. LOCK         take the session lock first, before anything changes shared state; without it the session is read-only
 *   2. BOOTSTRAP    detect-only tool checks (herdr-app/hc versions, treehouse, no-mistakes, tasks-axi, gh) and clone tangles
 *   3. WAKE QUEUE   locked only: drain and present the durable queue, with its acknowledgement command
 *   4. SUPERVISION  how this session is supervised (the Stop hook owns the watcher)
 *   5. FLEET STATE  every open task with its current state and the recovery it needs
 *      BACKLOG      locked, with a backlog only: replay backlog closes that failed earlier (backlog.ts)
 *   6. NETWORK      locked only: GitHub auth and the clone refresh run in a background worker; the digest never waits on them
 *   7. CONTEXT      the project registry, boss.md and learnings.md, with ABSENT markers for missing files
 */

const NO_MISTAKES_MIN = '1.46.0';
const TASKS_AXI_MIN = '0.2.6';

const digestRecord = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'digest.json');

const semver = (s: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** a >= b for x.y.z versions. */
export function versionAtLeast(a: string, b: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

/** `<tool> --version`, bounded. A Windows .cmd shim (an npm global) only starts through cmd.exe. Null when it does not answer. */
function toolVersion(file: string): string | null {
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const r = shim
    ? spawnSync(`"${file}" --version`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    : spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (r.error || r.status !== 0) return null;
  // Strip colour codes (no-mistakes prints a yellow update banner) and take the first version number.
  const text = `${r.stdout ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  return semver(text) ? semver(text)!.join('.') : null;
}

/** Detect-only bootstrap lines: empty when every tool is present and recent enough. */
export function bootstrapProblems(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [...backendVersionWarnings(env)];
  if (!treehousePath(env)) out.push('treehouse is not installed: builds cannot lease worktrees (https://github.com/kunchenguid/treehouse).');
  const floor = (name: string, override: string | undefined, min: string) => {
    const file = resolveExecutable(override || name, env);
    if (!file) return out.push(`${name} is not installed (needs ${min} or newer).`);
    const v = toolVersion(file);
    if (!v) out.push(`${name} did not report its version (${file} --version); amigo needs ${min} or newer.`);
    else if (!versionAtLeast(v, min)) out.push(`${name} ${v} is older than the ${min} amigo needs: ask the Boss before upgrading it.`);
  };
  floor('no-mistakes', env.AMIGO_NO_MISTAKES, NO_MISTAKES_MIN);
  floor('tasks-axi', env.AMIGO_TASKS_AXI, TASKS_AXI_MIN);
  if (!ghPath(env)) out.push('gh (the GitHub CLI) is not installed: pull requests and merges cannot run.');
  for (const p of loadProjects(env)) {
    if (!existsSync(p.path)) {
      out.push(`${p.name}: its clone is missing (${p.path}); amigo add ${p.source} --name ${p.name} makes it again.`);
      continue;
    }
    const tangled = tangleBranch(p.path);
    if (tangled) out.push(`${p.name}: the clone is on branch ${tangled}, not its default; amigo sync reports it, and nothing is forced.`);
  }
  return out;
}

const RECOVERY_RULES = [
  'Recovery rules (stopped crew member):',
  '- A crew member whose pull request already landed is not a recovery case: close it the ordinary way, never with --force.',
  '- Read its state first (amigo status <id>). Its worktree and commits are kept: never spawn a fresh copy of the task or close --force while they hold unlanded work.',
  '- Relaunch it in its own worktree, same task, with its brief plus a short progress note: amigo control <id> relaunch --note "<what is done, what is left>".',
  "- The full playbook is skills/agent/stuck-crew-recovery.md in amigo's code folder.",
  '- A crew member that is confused or looping gets one corrective line; one genuinely wedged after that is relaunched. If a second relaunch fails, report the plain failure, the preserved work and the consequence to the Boss.',
  '- A low context reading is not wedging.',
].join('\n');

const SUPERVISION = [
  'SUPERVISION (Claude Code; the Stop hook owns the watcher):',
  '1. Drain first: amigo wake drain. After handling every wake (and reconciling amigo inbox), run the exact WAKE_ACK_REQUIRED command it printed; until then the wakes stay queued.',
  '2. Every turn end while work is open arms one zero-token watcher through the Stop hook. Never start it yourself and never poll in a loop.',
  '3. A Stop hook wake (signal:, stale:, check:, heartbeat, recovery:) means: run amigo wake drain first, then handle it. stale: means a crew member stopped responding: follow the recovery rules below.',
  '4. One "amigo watcher auto-arm FAILED" notice means the mechanism is broken: drain, look at why (amigo watch in a shell), and do not turn it into a manual re-arm loop.',
  '5. Waiting on the watcher is silent: no idle progress messages.',
].join('\n');

const age = (iso: string | null | undefined, now = Date.now()): string => {
  const s = Math.max(0, Math.floor((now - (Date.parse(iso ?? '') || now)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};

/** One line per open task, plus the recovery each stopped one needs. */
export function fleetState(env: NodeJS.ProcessEnv): string {
  const open = listTasks(env).filter((t) => t.status !== 'closed');
  if (!open.length) return 'FLEET STATE: no open tasks.';
  const lines = open.map((t: Task) => {
    const where = t.worktree ? ` · worktree ${t.worktree}${existsSync(t.worktree) ? '' : ' (MISSING)'}${t.branch ? ` on ${t.branch}` : ''}` : '';
    return `- ${t.id} [${t.project}] ${t.status}, updated ${age(t.updatedAt)} ago · ${crewState(t, env)}${where}`;
  });
  const recover = open.filter((t) => stoppedResponding(t) || (/^state: stopped/.test(crewState(t, env)) && (t.status === 'running' || t.status === 'verifying')));
  const unread = open.filter((t) => FINISHED.includes(t.status) && !t.seen);
  return [
    `FLEET STATE (${open.length} open; the endpoint read is a presence check, not proof the work is gone):`,
    ...lines,
    ...recover.map((t) => `RECOVER ${t.id}: it stopped responding mid-turn. Its work stays in ${t.worktree ?? t.cwd}. Follow the recovery rules.`),
    ...(unread.length ? [`UNREAD RESULTS: ${unread.map((t) => t.id).join(', ')} (amigo inbox shows them)`] : []),
    ...(recover.length ? ['', RECOVERY_RULES] : []),
  ].join('\n');
}

/** The context files, each delimited, with an explicit ABSENT marker for a missing one. */
function contextDigest(env: NodeJS.ProcessEnv): string {
  const file = (label: string, path: string, absent: string) => {
    if (!existsSync(path)) return `--- ${label}: ABSENT (${absent}) ---`;
    const text = readFileSync(path, 'utf8').trim();
    return `--- ${label} (${path}) ---\n${text || '(empty)'}\n--- end ${label} ---`;
  };
  const projects = loadProjects(env);
  const registry = projects.length
    ? projects.map((p) => `- ${p.name} [${p.mode}${p.yolo ? ' +yolo' : ''}] ${p.path} (from ${p.source})${p.live ? ` live: ${p.live}` : ''}`).join('\n')
    : '(no projects registered: amigo add <git url or path>)';
  return [
    'CONTEXT:',
    `--- projects ---\n${registry}\n--- end projects ---`,
    file('boss.md', bossPath(env), "the Boss's preferences are not recorded yet: use amigo's defaults"),
    file('learnings.md', learningsPath(env), 'nothing learned yet'),
  ].join('\n');
}

/** Start the network checks in a detached worker; their result arrives as an inbox notice (and a wake when something is wrong). */
function startNetworkChecks(env: NodeJS.ProcessEnv): void {
  const id = beginNotice(NETWORK_TITLE, env);
  const child = spawn(process.execPath, [cliPath, '_netcheck', id], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, AMIGO_HOME: home(env) } });
  child.on('error', () => {});
  child.unref();
}

export const NETWORK_TITLE = 'session start: network checks';

/** `amigo _netcheck <notice id>`: GitHub authentication and the guarded clone refresh, off the digest's blocking path. */
export async function runNetworkChecks(noticeId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const timer = setInterval(() => {
    try {
      touchNotice(noticeId, env);
    } catch {
      // the next beat makes up for it
    }
  }, BEAT_MS);
  const lines: string[] = [];
  const problems: string[] = [];
  try {
    if (!ghPath(env)) {
      problems.push('gh is not installed');
    } else {
      const auth = runGh(['auth', 'status'], home(env), env);
      if (auth.error || auth.status !== 0) problems.push(`gh is not authenticated: ${(auth.stderr || auth.stdout || auth.error?.message || '').trim().split(/\r?\n/)[0]}`);
      else lines.push('GitHub: authenticated.');
    }
    for (const line of syncProjects(undefined, env)) {
      lines.push(`sync ${line}`);
      if (/STUCK|fetch failed/.test(line)) problems.push(line);
    }
  } catch (err) {
    problems.push(`the network checks stopped: ${(err as Error).message}`);
  } finally {
    clearInterval(timer);
  }
  finishNotice(noticeId, [...problems.map((p) => `PROBLEM: ${p}`), ...lines].join('\n') || 'Nothing to check.', env);
  if (problems.length) appendWake('check', 'network', `check: session-start network checks: ${problems.join('; ')}`, env);
}

function lockSection(got: Acquired, me: Identity, env: NodeJS.ProcessEnv): string {
  switch (got.result) {
    case 'acquired':
      return `LOCK: this session controls ${home(env)}.`;
    case 'reanchored':
      return `LOCK: this session already controls ${home(env)}.`;
    case 'reclaimed':
      return `LOCK: this session controls ${home(env)} (taken over from a session that is gone: ${describeHolder(got.previous!)}).`;
    case 'held':
      return `LOCK: READ-ONLY. Another amigo session controls ${home(env)} (${describeHolder(got.lock)}). This session can look (status, inbox) but not spawn, send, close, merge or drain wakes. Work in that session, or close it; a new session takes over once it is gone.`;
    case 'no-session':
      return `LOCK: READ-ONLY. ${me.session ? 'The Claude process id is unknown' : 'This is not a Claude Code session'}, so no session lock was taken.`;
  }
}

/**
 * Build the digest. `once` (the SessionStart hook, and `amigo digest` without --again) gives the full digest only on the
 * first run of a session; a later run says when it ran.
 */
export function sessionDigest(env: NodeJS.ProcessEnv, opts: { payloadSession?: string | null; once?: boolean } = {}): string {
  const me = identity(env, opts.payloadSession);
  if (opts.once && me.session) {
    const done = readJson<{ session?: string; at?: string } | null>(digestRecord(env), null);
    if (done?.session === me.session) return `The session-start digest already ran in this session (at ${done.at}). New events arrive as Stop hook wakes; amigo wake drain shows the queue, amigo digest --again the whole digest.`;
  }
  const got = acquireSessionLock(env, me);
  const locked = got.result === 'acquired' || got.result === 'reanchored' || got.result === 'reclaimed';
  const sections: string[] = [lockSection(got, me, env)];
  const boot = bootstrapProblems(env);
  sections.push(boot.length ? `BOOTSTRAP (detect only; install or upgrade only after the Boss says yes):\n${boot.map((l) => `- ${l}`).join('\n')}` : 'BOOTSTRAP: all tools present.');
  sections.push(locked ? describeDrain(drainWakes(env)) : 'WAKE QUEUE: not drained (read-only session).');
  const need = supervisionNeed(env);
  sections.push(`${SUPERVISION}\nNow: ${need.length ? `supervision needed (${need.join(', ')}); watcher ${watcherHealthy(env) ? 'running' : 'arms at the end of this turn'}` : 'nothing needs supervision'}.${listChecks(env).length ? ` Checks: ${listChecks(env).map((c) => c.name).join(', ')}.` : ''}`);
  const away = readAway(env);
  if (away) sections.push(`${describeAway(away)}\nRead the ${away.mode === 'afk' ? '/afk' : '/quiet'} skill and skills/agent/away-quiet-supervision.md before acting.`);
  sections.push(fleetState(env));
  if (locked && backlogActive(env)) {
    // A close whose backlog half failed is replayed here too, not only at the next spawn or close.
    try {
      const replayed = replayPendingCloses(env);
      sections.push(replayed.length ? `BACKLOG: replayed pending close(s):\n${replayed.map((l) => `- ${l}`).join('\n')}` : 'BACKLOG: no pending closes. amigo backlog ready lists what can start.');
    } catch (err) {
      sections.push(`BACKLOG: FAILED to replay pending closes: ${(err as Error).message}`);
    }
  }
  if (locked) {
    try {
      startNetworkChecks(env);
      sections.push(`NETWORK CHECKS: GitHub auth and the clone refresh are running in the background; the result lands in amigo inbox as "${NETWORK_TITLE}", and a problem also arrives as a wake.`);
    } catch (err) {
      sections.push(`NETWORK CHECKS: could not start: ${(err as Error).message}`);
    }
  } else {
    sections.push('NETWORK CHECKS: none (read-only session).');
  }
  sections.push(contextDigest(env));
  if (me.session) writeJsonAtomic(digestRecord(env), { session: me.session, at: new Date().toISOString() });
  return `${sections.join('\n\n')}\n`;
}
