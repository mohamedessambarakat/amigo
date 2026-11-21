import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { moveFolderTrust } from './claude.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { findAdminDir } from './git.ts';
import { LEGACY_MARKER, LEGACY_NAME, legacyHomeVar, legacySkillFiles } from './legacy.ts';
import { configPath, home, oldHome } from './paths.ts';
import { run } from './proc.ts';
import { listTasks, mutateTask, runnerAlive, type Task } from './tasks.ts';

/** Written into the old home before it moves and removed when everything inside is rewritten: a crash in between leaves it, and the next command finishes the job. */
export const MIGRATION_MARKER = '.migration-incomplete';

const norm = (p: string): string => {
  const slashed = p.replaceAll('\\', '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};

/** A path (or a string starting with one) that pointed inside `from`, rewritten to point inside `to`. Anything else is returned as it is. */
export function movePath(value: string, from: string, to: string): string {
  const f = norm(from);
  const v = norm(value);
  return v === f || v.startsWith(`${f}/`) ? to + value.slice(from.length) : value;
}

/** Every string inside a JSON value, with movePath applied. */
function movePaths(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return movePath(v, from, to);
  if (Array.isArray(v)) return v.map((x) => movePaths(x, from, to));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, movePaths(x, from, to)]));
  return v;
}

/** Is a task still at work? Its tab is open (whatever its status says), or it was touched a moment ago. A record left by a crashed tab is not. */
function working(t: Task, env: NodeJS.ProcessEnv): boolean {
  if (runnerAlive(t.id, env)) return true;
  if (t.status !== 'running' && t.status !== 'verifying' && t.status !== 'closing') return false;
  return Date.now() - Date.parse(t.updatedAt) < 2 * 60_000;
}

/** The old config's keys under their new names: head, arm and armMb became amigo, member and memberMb. Safe to apply twice. */
function renameConfigKeys(config: Record<string, unknown>): Record<string, unknown> {
  const { armMb, ...rest } = config;
  const agents = Object.fromEntries(
    Object.entries((config.agents as Record<string, Record<string, unknown>> | undefined) ?? {}).map(([name, a]) => {
      const { head, arm, ...others } = a;
      return [name, { ...(head !== undefined ? { amigo: head } : {}), ...(arm !== undefined ? { member: arm } : {}), ...others }];
    }),
  );
  return { ...rest, agents, ...(armMb !== undefined ? { memberMb: armMb } : {}) };
}

/** Remove the slash command files the former name installed (only ones it wrote). Returns the files removed. */
function removeLegacySkills(userHome: string): string[] {
  const removed: string[] = [];
  for (const file of legacySkillFiles(userHome)) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(LEGACY_MARKER)) continue;
    rmSync(file);
    const dir = dirname(file);
    if (dir.endsWith(LEGACY_NAME) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    removed.push(file);
  }
  return removed;
}

/**
 * Everything that has to change inside the moved home: config keys first, then each task's paths and worktree, then the old
 * slash commands. Every step is safe to repeat, so a run that stopped halfway is simply run again. Returns the line to print.
 */
function rewriteMovedHome(env: NodeJS.ProcessEnv, from: string, to: string, userHome: string, marker: string, resumed: boolean): string {
  const warnings: string[] = [];
  if (existsSync(configPath(env))) writeJsonAtomic(configPath(env), movePaths(renameConfigKeys(readJson<Record<string, unknown>>(configPath(env), {})), from, to));

  let updated = 0;
  let repaired = 0;
  for (const listed of listTasks(env)) {
    // Under the task's own lock, on its current content: a status change made meanwhile is never overwritten, and a record
    // that no longer holds old paths (an earlier run did it) is not written at all.
    const t = mutateTask(
      listed.id,
      (cur) => {
        const { headAddress, ...moved } = movePaths(cur, from, to) as Task & { headAddress?: string };
        const next: Task = { ...moved, ...(headAddress ? { amigoAddress: headAddress } : {}) };
        if (JSON.stringify(next) === JSON.stringify(cur)) return null;
        updated++;
        return { ...next, headAddress: undefined } as Partial<Task>;
      },
      env,
    );
    if (t.status === 'closed' || !t.worktree || !t.repo || !existsSync(t.worktree)) continue;
    const r = run('git', ['-C', t.repo, 'worktree', 'repair', t.worktree]);
    if (r.status !== 0) {
      // Reported here, once: the marker goes either way, so this never repeats at every command.
      warnings.push(`git worktree repair failed for ${t.id}: ${(r.stderr || r.stdout || r.error?.message || 'no answer').trim()}`);
      continue;
    }
    repaired++;
    try {
      const gitDir = findAdminDir(t.repo, t.worktree);
      if (gitDir !== t.gitDir) mutateTask(t.id, () => ({ gitDir }), env);
    } catch (err) {
      warnings.push(`${t.id}: ${(err as Error).message}`);
    }
    if (t.trustAdded) {
      try {
        moveFolderTrust(movePath(t.worktree, to, from), t.worktree, env);
      } catch (err) {
        warnings.push(`${t.id}: could not update ~/.claude.json: ${(err as Error).message}`);
      }
    }
  }

  const skills = removeLegacySkills(userHome);
  // Every record is rewritten: the job is done. Warnings are told once, not kept alive by the marker.
  rmSync(marker, { force: true });
  return [
    `${resumed ? 'Finished moving' : 'Moved'} ${from} to ${to} (${updated} task${updated === 1 ? '' : 's'}, ${repaired} worktree${repaired === 1 ? '' : 's'} repaired).`,
    skills.length ? `Removed the old /${LEGACY_NAME} command (${skills.length} file${skills.length === 1 ? '' : 's'}): run amigo install-skill to add /amigo.` : '',
    ...warnings.map((w) => `Warning: ${w}`),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Throws while a task in `where` is at work: its tab holds paths inside the folder that is being moved or rewritten. */
function refuseWhileWorking(env: NodeJS.ProcessEnv, where: string, to: string): void {
  const inWhere = { ...env, AMIGO_HOME: where };
  const busy = listTasks(inWhere).filter((t) => working(t, inWhere));
  if (busy.length) {
    throw new Error(`amigo now lives in ${to}, but ${where} still has tasks at work (${busy.map((t) => `${t.id} ${t.status}`).join(', ')}). Wait for them to finish, then run amigo again: it moves everything once.`);
  }
}

/**
 * Once: when the home of the former name exists and the new one does not, move it. Refuses while any task is at work (its tab
 * is open, whatever its status). Rewrites the paths in task and config files, repairs the git worktrees of open tasks, moves
 * their ~/.claude.json trust entries and removes the old slash commands. A marker kept in the moved home until all of that is
 * done makes the next command finish a move that stopped halfway. Returns the one line to tell the user, or null when nothing
 * was to be done. Does nothing when AMIGO_HOME is set (an explicit home is never a migration).
 */
export function migrateOldHome(env: NodeJS.ProcessEnv, userHome: string = os.homedir()): string | null {
  if (env.AMIGO_HOME) return null;
  const to = home(env);
  const from = oldHome(env);
  const marker = join(to, MIGRATION_MARKER);
  if (existsSync(to)) {
    if (!existsSync(marker)) return null;
    refuseWhileWorking(env, to, to);
    return rewriteMovedHome(env, readJson<{ from?: string }>(marker, {}).from ?? from, to, userHome, marker, true);
  }
  if (!existsSync(from)) return null;

  refuseWhileWorking(env, from, to);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(join(from, MIGRATION_MARKER), JSON.stringify({ from }));
  try {
    renameSync(from, to);
  } catch (err) {
    rmSync(join(from, MIGRATION_MARKER), { force: true });
    throw new Error(`Could not move ${from} to ${to}: ${(err as Error).message}. Close any terminal or program that has a folder inside it open, then run amigo again.`);
  }
  return rewriteMovedHome(env, from, to, userHome, marker, false);
}

/** One line for a user whose shell still sets the former name's home variable while amigo has no home yet: amigo does not read it. */
export function legacyHomeHint(env: NodeJS.ProcessEnv): string | null {
  const set = legacyHomeVar(env);
  if (env.AMIGO_HOME || !set || existsSync(home(env))) return null;
  return `The former name's home variable is set (${set}), but amigo does not read it: set AMIGO_HOME to that folder to keep using it, or move it to ${home(env)}.`;
}
