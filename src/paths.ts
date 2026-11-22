import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed code: src/, prompts/. */
export const codeRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliPath: string = join(codeRoot, 'src', 'cli.ts');

/**
 * Everything amigo stores: ~/.amigo, or AMIGO_HOME. Split by what each record is:
 *   config/    local choices (agents)
 *   data/      durable records: the project registry, boss.md, learnings.md, backlog.md, <id>/brief.md and <id>/report.md
 *   state/     runtime records: task records, locks, notices, scratch folders, the worktree pool
 *   projects/  amigo's own clones, one per registered project, read-only to amigo except through the guarded sync
 */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMIGO_HOME ? resolve(env.AMIGO_HOME) : join(os.homedir(), '.amigo');
}

export const configDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'config');
export const dataDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'data');
export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'state');
export const projectsDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'projects');

export const configPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'config.json');
/** The project registry: each project's clone source and standing delivery posture (see config.ts). */
export const projectsPath = (env: NodeJS.ProcessEnv = process.env): string => join(dataDir(env), 'projects.json');
/** The Boss's preferences and working style. */
export const bossPath = (env: NodeJS.ProcessEnv = process.env): string => join(dataDir(env), 'boss.md');
/** Operational facts and gotchas amigo learned. */
export const learningsPath = (env: NodeJS.ProcessEnv = process.env): string => join(dataDir(env), 'learnings.md');
/** The task queue, kept by tasks-axi. */
export const backlogPath = (env: NodeJS.ProcessEnv = process.env): string => join(dataDir(env), 'backlog.md');
/** A task's durable records: its brief, and a survey's report. They outlive the task's runtime record. */
export const taskDataDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(dataDir(env), id);

/** Where amigo's clone of a project lives. */
export const clonePath = (name: string, env: NodeJS.ProcessEnv = process.env): string => join(projectsDir(env), name);

export const tasksDir = (env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'tasks');
export const taskDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(tasksDir(env), id);
/** treehouse's pool of worktrees (its TREEHOUSE_ROOT), unless the environment names another. */
export const worktreePoolDir = (env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'worktrees');
export const lockPath = (name: string, env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'locks', `${name}.lock`);
/** Where a scratch crew member works: its own folder, never a git repo. */
export const scratchDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'scratch', id);
/** Results that are not crew members' (the briefing's live checks): inbox prints them once. */
export const noticesPath = (env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'notices.json');
/** Where amigo writes the briefs and messages it drafts. */
export const draftsDir = (env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'drafts');

/** Files at the top of a home that only the old layout has: their presence means `amigo migrate` has not run. */
export const OLD_LAYOUT_FILES: readonly string[] = ['config.json', 'projects.json'];
