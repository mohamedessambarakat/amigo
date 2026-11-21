import { join } from 'node:path';

/** What the product was called before amigo: only the one-time migration (migrate.ts) and branches of migrated tasks look at it. */
export const LEGACY_HOME_DIR = '.octomaxxing';
export const LEGACY_NAME = 'octomaxxing';

/** The branch a task made before the rename: migrated tasks keep it. */
export const legacyBranchName = (id: string): string => `${LEGACY_NAME}/${id}`;

/** The marker the former name wrote into its skill files, so only files it wrote are removed. */
export const LEGACY_MARKER = `installed by ${LEGACY_NAME}`;

/** Where the former name installed its /octomaxxing command, per agent CLI (the same places skills.ts uses now). */
export const legacySkillFiles = (userHome: string): string[] => [
  join(userHome, '.claude', 'skills', LEGACY_NAME, 'SKILL.md'),
  join(userHome, '.gemini', 'commands', `${LEGACY_NAME}.toml`),
  join(userHome, '.gemini', 'config', 'skills', LEGACY_NAME, 'SKILL.md'),
  join(userHome, '.agents', 'skills', LEGACY_NAME, 'SKILL.md'),
];

const LEGACY_TASK = `${LEGACY_NAME.toUpperCase()}_TASK`;
const LEGACY_HOME = `${LEGACY_NAME.toUpperCase()}_HOME`;

/**
 * A session started by the former name (still open while amigo is already installed) carries its OCTOMAXXING_TASK and
 * OCTOMAXXING_HOME. It is a squad member all the same: amigo's member guard and Stop hook must see it as one, working in the
 * home it was started with.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const task = env[LEGACY_TASK];
  if (env.AMIGO_TASK || !task) return env;
  const home = env[LEGACY_HOME];
  return { ...env, AMIGO_TASK: task, ...(!env.AMIGO_HOME && home ? { AMIGO_HOME: home } : {}) };
}

/** The former name's home variable, when it is set: amigo does not read it. */
export const legacyHomeVar = (env: NodeJS.ProcessEnv): string | undefined => env[LEGACY_HOME] || undefined;
