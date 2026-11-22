import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BRANCH_PREFIX, saveProjects, validProjectName, type DeliveryMode, type Project } from './config.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { clonePath, configDir, configPath, dataDir, home, OLD_LAYOUT_FILES, projectsDir, projectsPath, stateDir, taskDataDir, tasksDir } from './paths.ts';
import { run } from './proc.ts';

/**
 * The one-time cutover from the old home layout (config.json, projects.json, tasks/, worktrees/ and the gate files at the top
 * of ~/.amigo, projects registered as the Boss's own folders) to the new one: config/, data/, state/
 * and projects/, with every project an amigo-owned clone. Each step is safe to repeat, and the old registry goes last, so a run
 * that stopped halfway is simply run again.
 */

/** A project as the old projects.json held it. */
interface OldProject {
  name: string;
  path: string;
  notes?: string;
  checks?: string[];
  risky?: string[];
  live?: string[];
  watch?: string[];
}

export interface MigrateOptions {
  /** Projects whose old folder is a live install: their new entry gets `live` set to that folder. */
  live?: string[];
  /** Projects to leave out of the new registry. */
  drop?: string[];
  dryRun?: boolean;
}

interface PlannedProject {
  old: OldProject;
  entry: Project;
}

/** The gate files and leftovers of the old layout that are dropped, not moved. */
const DROPPED = ['policy.json', 'policy.approved.json', 'gates.confirmed.json', 'approvals.jsonl', 'locks', 'no-hooks', 'amigo-prompt.md', 'amigo-settings.json', 'test-terminals'];

/** What moves into state/ as it is. */
const TO_STATE = ['scratch', 'notices.json', 'drafts', 'hook-errors.log'];

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args]);

function oldRegistry(env: NodeJS.ProcessEnv): OldProject[] {
  const file = join(home(env), 'projects.json');
  const list = readJson<{ projects?: OldProject[] }>(file, { projects: [] }).projects;
  if (!Array.isArray(list)) throw new Error(`${file}: must look like {"projects": [...]}`);
  return list;
}

/** Every old task that is not closed: its worktree and tab point at the old layout, so the cutover waits for it. */
function openTasks(env: NodeJS.ProcessEnv): string[] {
  const dir = join(home(env), 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => {
    const t = readJson<{ status?: string } | null>(join(dir, id, 'task.json'), null);
    return t && t.status !== 'closed' ? [`${id} (${t.status})`] : [];
  });
}

/** Plan the new registry entry of every old project, or throw with every problem at once. */
function plan(env: NodeJS.ProcessEnv, opts: MigrateOptions): PlannedProject[] {
  const old = oldRegistry(env);
  const names = new Set(old.map((p) => p.name));
  const problems: string[] = [];
  for (const n of [...(opts.live ?? []), ...(opts.drop ?? [])]) if (!names.has(n)) problems.push(`"${n}" is not a registered project (known: ${[...names].join(', ') || 'none'})`);
  const today = new Date().toISOString().slice(0, 10);
  const planned: PlannedProject[] = [];
  for (const p of old) {
    if (opts.drop?.includes(p.name)) continue;
    if (!validProjectName(p.name)) {
      problems.push(`${p.name}: not a valid project name`);
      continue;
    }
    if (!p.path || !existsSync(p.path) || !statSync(p.path).isDirectory()) {
      problems.push(`${p.name}: its folder ${p.path} is missing (leave it out with --drop ${p.name})`);
      continue;
    }
    const top = git(p.path, 'rev-parse', '--show-toplevel');
    if (top.status !== 0) {
      problems.push(`${p.name}: ${p.path} is not a git repo, and amigo now works only on clones (leave it out with --drop ${p.name})`);
      continue;
    }
    // The clone comes from the folder's origin, so pull requests and merges go where they always went; a folder without one is
    // cloned as it is and stays local-only.
    const origin = git(p.path, 'remote', 'get-url', 'origin');
    const source = origin.status === 0 && origin.stdout.trim() ? origin.stdout.trim() : p.path;
    const mode: DeliveryMode = source === p.path ? 'local-only' : 'no-mistakes';
    planned.push({
      old: p,
      entry: {
        name: p.name,
        source,
        path: clonePath(p.name, env),
        mode,
        yolo: true,
        branchPrefix: DEFAULT_BRANCH_PREFIX,
        addedAt: today,
        ...(opts.live?.includes(p.name) ? { live: p.path } : {}),
        ...(p.notes ? { notes: p.notes } : {}),
        ...(p.risky?.length ? { risky: p.risky } : {}),
        ...(p.live ? { liveCommands: p.live } : {}),
        ...(p.watch?.length ? { watch: p.watch } : {}),
      },
    });
  }
  if (problems.length) throw new Error(`Cannot migrate ${home(env)}:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
  return planned;
}

const describe = (p: PlannedProject): string =>
  `  ${p.entry.name}: clone ${p.entry.source} into ${p.entry.path} [${p.entry.mode}${p.entry.yolo ? ' +yolo' : ''}]${p.entry.live ? `, live: ${p.entry.live}` : ''}${p.old.checks?.length ? `; its checks are dropped (${p.old.checks.join(' | ')})` : ''}`;

/** Move `from` to `to` unless `to` is already there (an earlier run moved it): then the leftover is removed. */
function move(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  mkdirSync(join(to, '..'), { recursive: true });
  if (existsSync(to)) {
    rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return false;
  }
  renameSync(from, to);
  return true;
}

/** Make the clone, or accept the one an earlier run made from the same source. */
function ensureClone(p: Project): 'cloned' | 'kept' {
  if (existsSync(p.path)) {
    const origin = git(p.path, 'remote', 'get-url', 'origin');
    if (origin.status === 0 && origin.stdout.trim() === p.source) return 'kept';
    throw new Error(`${p.path} already exists and is not a clone of ${p.source}; amigo never overwrites a folder. Move it away, then run amigo migrate again.`);
  }
  mkdirSync(join(p.path, '..'), { recursive: true });
  const r = run('git', ['clone', '--quiet', p.source, p.path], { timeoutMs: 30 * 60_000 });
  if (r.error || r.status !== 0) {
    rmSync(p.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw new Error(`git clone ${p.source} failed: ${(r.error?.message || r.stderr || r.stdout).trim()}`);
  }
  return 'cloned';
}

/** Is this home still in the old layout? */
export const needsMigration = (env: NodeJS.ProcessEnv): boolean => OLD_LAYOUT_FILES.some((f) => existsSync(join(home(env), f)));

/** `amigo migrate`: convert the home. Returns the lines to print. */
export function migrateHome(env: NodeJS.ProcessEnv, opts: MigrateOptions = {}): string[] {
  const root = home(env);
  if (!needsMigration(env)) return [`${root} already has the new layout (config/, data/, state/, projects/). Nothing to migrate.`];
  const open = openTasks(env);
  if (open.length) throw new Error(`Cannot migrate while tasks are open: ${open.join(', ')}. Close them with the amigo you have now, then run amigo migrate again.`);
  const planned = plan(env, opts);
  const lines = [
    `${opts.dryRun ? 'Would migrate' : 'Migrating'} ${root} to config/, data/, state/ and projects/:`,
    ...(planned.length ? planned.map(describe) : ['  (no projects)']),
    `  config.json -> config/config.json; projects.json -> data/projects.json; tasks/ -> state/tasks/ (briefs to data/<id>/brief.md)`,
    `  ${TO_STATE.join(', ')} -> state/`,
    `  removed: ${DROPPED.join(', ')}`,
  ];
  if (opts.dryRun) return [...lines, 'Dry run: nothing was changed.'];

  for (const dir of [configDir(env), dataDir(env), stateDir(env), projectsDir(env)]) mkdirSync(dir, { recursive: true });
  for (const p of planned) lines.push(`  ${p.entry.name}: ${ensureClone(p.entry) === 'cloned' ? 'cloned' : 'clone already there'}`);
  saveProjects(planned.map((p) => p.entry), env);

  move(join(root, 'config.json'), configPath(env));

  const oldTasks = join(root, 'tasks');
  let tasks = 0;
  if (existsSync(oldTasks)) {
    for (const id of readdirSync(oldTasks)) {
      move(join(oldTasks, id, 'brief.md'), join(taskDataDir(id, env), 'brief.md'));
      const file = join(oldTasks, id, 'task.json');
      const t = readJson<Record<string, unknown> | null>(file, null);
      // A closed scratch task's folder moves with scratch/: its record follows it.
      if (t && typeof t.cwd === 'string') {
        const from = join(root, 'scratch');
        if (t.cwd.replaceAll('\\', '/').toLowerCase().startsWith(`${from.replaceAll('\\', '/').toLowerCase()}/`)) {
          writeJsonAtomic(file, { ...t, cwd: join(stateDir(env), 'scratch') + t.cwd.slice(from.length) });
        }
      }
      if (move(join(oldTasks, id), join(tasksDir(env), id))) tasks++;
    }
    rmSync(oldTasks, { recursive: true, force: true });
  }
  for (const name of TO_STATE) move(join(root, name), join(stateDir(env), name));
  for (const name of DROPPED) rmSync(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  const worktrees = join(root, 'worktrees');
  if (existsSync(worktrees)) {
    if (readdirSync(worktrees).length === 0) rmSync(worktrees, { recursive: true, force: true });
    else lines.push(`  kept ${worktrees}: it still holds folders (old worktrees of closed tasks?); look at them, then delete it yourself`);
  }
  writeJsonAtomic(join(stateDir(env), 'migration.json'), { at: new Date().toISOString(), projects: planned.map((p) => p.entry.name), tasks });
  // Last: with the old registry gone the home reads as migrated, so a run that stopped before this point is run again.
  rmSync(join(root, 'projects.json'), { force: true });
  if (!existsSync(projectsPath(env))) saveProjects([], env);
  lines.push(`Done: ${planned.length} project${planned.length === 1 ? '' : 's'} registered as clones, ${tasks} task record${tasks === 1 ? '' : 's'} kept in state/tasks.`);
  return lines;
}
