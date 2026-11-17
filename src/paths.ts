import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed code: src/, prompts/. */
export const codeRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliPath: string = join(codeRoot, 'src', 'cli.ts');

/** Everything octomaxxing stores: ~/.octomaxxing, or OCTOMAXXING_HOME. */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOMAXXING_HOME ? resolve(env.OCTOMAXXING_HOME) : join(os.homedir(), '.octomaxxing');
}

export const configPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'config.json');
export const projectsPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'projects.json');
export const tasksDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'tasks');
export const taskDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(tasksDir(env), id);
export const worktreesDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'worktrees');
export const lockPath = (name: string, env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'locks', `${name}.lock`);
