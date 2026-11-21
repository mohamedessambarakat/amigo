import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_HOME_DIR } from './legacy.ts';

/** The installed code: src/, prompts/. */
export const codeRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cliPath: string = join(codeRoot, 'src', 'cli.ts');

/** Everything amigo stores: ~/.amigo, or AMIGO_HOME. */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMIGO_HOME ? resolve(env.AMIGO_HOME) : join(os.homedir(), '.amigo');
}

export const configPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'config.json');
export const projectsPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'projects.json');
export const tasksDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'tasks');
export const taskDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(tasksDir(env), id);
export const worktreesDir = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'worktrees');
export const lockPath = (name: string, env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'locks', `${name}.lock`);
export const policyPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'policy.json');
/** The sha256 of the policy the user approved (see policy.ts). */
export const policyApprovalPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'policy.approved.json');
/** The sha256 of each project's checks and risky globs as the user last confirmed them (see gates.ts). */
export const gatesConfirmedPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'gates.confirmed.json');
/** One JSON line per self-approved close, PR and undo. */
export const approvalsPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'approvals.jsonl');

/** The home of the product's former name, moved to home() once (see migrate.ts). AMIGO_OLD_HOME overrides it, for tests. */
export function oldHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMIGO_OLD_HOME ? resolve(env.AMIGO_OLD_HOME) : join(os.homedir(), LEGACY_HOME_DIR);
}

/** Where a scratch squad member works: its own folder, never a git repo. */
export const scratchDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'scratch', id);
/** Results that are not squad members' (the briefing's live checks): inbox prints them once. */
export const noticesPath = (env: NodeJS.ProcessEnv = process.env): string => join(home(env), 'notices.json');
