/** What the product was called before amigo: only sessions it started look at it. */
export const LEGACY_NAME = 'octomaxxing';

const LEGACY_TASK = `${LEGACY_NAME.toUpperCase()}_TASK`;
const LEGACY_HOME = `${LEGACY_NAME.toUpperCase()}_HOME`;

/**
 * A session started by the former name (still open while amigo is already installed) carries its OCTOMAXXING_TASK and
 * OCTOMAXXING_HOME. It is a crew member all the same: amigo's member guard and Stop hook must see it as one, working in the
 * home it was started with.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const task = env[LEGACY_TASK];
  if (env.AMIGO_TASK || !task) return env;
  const home = env[LEGACY_HOME];
  return { ...env, AMIGO_TASK: task, ...(!env.AMIGO_HOME && home ? { AMIGO_HOME: home } : {}) };
}
