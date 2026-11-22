import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { configDir } from './paths.ts';

/**
 * Crew dispatch profiles (config/crew-dispatch.json; no quota ranking, as with `shared_quota: true`). An optional
 * file of natural-language rules. amigo picks the best-fitting rule with judgment (code never matches the prose); code validates
 * the file, resolves the rule's profiles in declared order, and makes every spawn carry a concrete --agent while the file exists.
 *
 *   {
 *     "shared_quota": true,
 *     "preferred_provider": "anthropic",
 *     "rules": [{ "when": "<a kind of task>", "use": [{ "agent": "claude", "model": "opus", "effort": "xhigh", "provider": "anthropic" }], "why": "..." }],
 *     "default": { "agent": "claude" }
 *   }
 *
 * Precedence: the Boss's explicit choice for the task, then the best-fit rule, then `default`, then the configured default agent.
 * Effort without a declared one follows EFFORT_FALLBACK.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_FALLBACK =
  'Effort, when neither the Boss nor the profile names one: low for well-understood work with an explicit bounded path, xhigh for ambiguous investigation or design, the levels between as complexity, uncertainty, blast radius or open-ended reasoning rise. Never max unless the Boss asked for it.';

export interface Profile {
  agent: string;
  model?: string;
  effort?: Effort;
  provider?: string;
}

export interface Rule {
  when: string;
  use: Profile[];
  why?: string;
}

export interface Dispatch {
  sharedQuota: boolean;
  preferredProvider?: string;
  rules: Rule[];
  default?: Profile[];
}

export const dispatchPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'crew-dispatch.json');

const PROVIDER_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function profiles(v: unknown, where: string): Profile[] {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) throw new Error(`${where}: an empty profile list`);
  return list.map((p: unknown, i) => {
    const at = Array.isArray(v) ? `${where}[${i}]` : where;
    const o = p as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${at}: a profile must be an object`);
    for (const key of Object.keys(o)) if (!['agent', 'model', 'effort', 'provider'].includes(key)) throw new Error(`${at}: unknown field "${key}" (a profile has agent, model, effort, provider)`);
    if (typeof o.agent !== 'string' || !o.agent) throw new Error(`${at}: "agent" is required`);
    if (o.model !== undefined && (typeof o.model !== 'string' || !o.model.trim())) throw new Error(`${at}: "model" must be text`);
    if (o.effort !== undefined && !EFFORTS.includes(o.effort as Effort)) throw new Error(`${at}: "effort" must be one of ${EFFORTS.join(', ')}`);
    if (o.provider !== undefined && (typeof o.provider !== 'string' || !PROVIDER_RE.test(o.provider))) throw new Error(`${at}: "provider" must be lowercase words joined by -`);
    return { agent: o.agent, ...(o.model ? { model: o.model as string } : {}), ...(o.effort ? { effort: o.effort as Effort } : {}), ...(o.provider ? { provider: o.provider as string } : {}) };
  });
}

export function validateDispatch(raw: unknown, where = 'crew-dispatch.json'): Dispatch {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${where}: must be a JSON object`);
  for (const key of Object.keys(o)) if (!['shared_quota', 'preferred_provider', 'rules', 'default'].includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  if (o.shared_quota !== undefined && typeof o.shared_quota !== 'boolean') throw new Error(`${where}: "shared_quota" must be true or false`);
  if (o.preferred_provider !== undefined && (typeof o.preferred_provider !== 'string' || !PROVIDER_RE.test(o.preferred_provider))) throw new Error(`${where}: "preferred_provider" must be lowercase words joined by -`);
  const rules = o.rules ?? [];
  if (!Array.isArray(rules)) throw new Error(`${where}: "rules" must be a list`);
  return {
    // amigo ranks by nothing but declared order: a home on one shared budget, whatever the file says.
    sharedQuota: true,
    ...(o.preferred_provider ? { preferredProvider: o.preferred_provider as string } : {}),
    rules: rules.map((r: unknown, i) => {
      const at = `${where}: rules[${i}]`;
      const x = r as Record<string, unknown> | null;
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${at}: a rule must be an object`);
      for (const key of Object.keys(x)) if (!['when', 'use', 'why'].includes(key)) throw new Error(`${at}: unknown field "${key}" (a rule has when, use, why)`);
      if (typeof x.when !== 'string' || !x.when.trim()) throw new Error(`${at}: "when" is required`);
      if (x.why !== undefined && typeof x.why !== 'string') throw new Error(`${at}: "why" must be text`);
      return { when: x.when, use: profiles(x.use, `${at}.use`), ...(x.why ? { why: x.why as string } : {}) };
    }),
    ...(o.default !== undefined ? { default: profiles(o.default, `${where}: default`) } : {}),
  };
}

/** The dispatch profiles, or null when the file is absent. A malformed file throws: it is reported and fixed, never selected around. */
export function loadDispatch(env: NodeJS.ProcessEnv = process.env): Dispatch | null {
  const file = dispatchPath(env);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  return validateDispatch(raw, file);
}

export interface Candidate {
  profile: Profile;
  eligible: boolean;
  why: string;
}

/**
 * A rule's (or the default's) profiles in declared order, each eligible or not with its reason; the first eligible one is the pick.
 * preferred_provider narrows the pool to that provider's profiles when any of them is eligible; declared order picks within it.
 */
export function resolveProfiles(d: Dispatch, which: number | 'default', agents: string[]): { candidates: Candidate[]; pick: Profile | null; note?: string } {
  const list = which === 'default' ? (d.default ?? []) : (d.rules[which]?.use ?? []);
  const candidates: Candidate[] = list.map((p) =>
    agents.includes(p.agent)
      ? { profile: p, eligible: true, why: 'eligible (quota ranking off: declared order)' }
      : { profile: p, eligible: false, why: `not eligible: agent "${p.agent}" is not configured` },
  );
  const preferred = d.preferredProvider ? candidates.filter((c) => c.eligible && c.profile.provider === d.preferredProvider) : [];
  const pool = preferred.length ? preferred : candidates.filter((c) => c.eligible);
  const note = d.preferredProvider ? (preferred.length ? `preferred_provider ${d.preferredProvider} narrows the pool` : `preferred_provider ${d.preferredProvider}: no eligible profile, declared order over all`) : undefined;
  return { candidates, pick: pool[0]?.profile ?? null, ...(note ? { note } : {}) };
}

/** The spawn flags a profile resolves to. */
export const profileFlags = (p: Profile): string => [`--agent ${p.agent}`, ...(p.model ? [`--model ${p.model}`] : []), ...(p.effort ? [`--effort ${p.effort}`] : [])].join(' ');

const describe = (p: Profile): string => `${p.agent}${p.model ? `:${p.model}` : ''}${p.effort ? ` effort=${p.effort}` : ''}${p.provider ? ` provider=${p.provider}` : ''}`;

/** `amigo dispatch [<rule>|default]`: the rules to choose from, or one rule resolved to concrete spawn flags. */
export function dispatchText(which: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const d = loadDispatch(env);
  if (!d) return `No dispatch profiles (${dispatchPath(env)} does not exist): spawn uses --agent, else the configured default agent.\n${EFFORT_FALLBACK}`;
  const agents = Object.keys(loadConfig(env).agents);
  if (which === undefined) {
    const rules = d.rules.map((r, i) => `  ${i + 1}. when ${r.when}\n     use ${r.use.map(describe).join(' | ')}${r.why ? `\n     why ${r.why}` : ''}`);
    return [
      `Dispatch profiles (${dispatchPath(env)}). Pick the rule that fits the task best, then: amigo dispatch <number> (or default).`,
      ...(rules.length ? rules : ['  (no rules)']),
      `  default: ${d.default ? d.default.map(describe).join(' | ') : '(none: the configured default agent)'}`,
      'Precedence: the Boss\'s explicit choice for this task, then the best-fit rule, then default. Every spawn needs a concrete --agent while this file exists.',
      EFFORT_FALLBACK,
    ].join('\n');
  }
  let index: number | 'default';
  if (which === 'default') {
    if (!d.default) throw new Error('No default profile in the dispatch file: name a rule, or pass --agent yourself');
    index = 'default';
  } else {
    const n = Number(which);
    if (!Number.isInteger(n) || n < 1 || n > d.rules.length) throw new Error(`No rule ${which}: there ${d.rules.length === 1 ? 'is 1 rule' : `are ${d.rules.length} rules`} (amigo dispatch lists them)`);
    index = n - 1;
  }
  const { candidates, pick, note } = resolveProfiles(d, index, agents);
  const lines = [`dispatch: ${index === 'default' ? 'default' : `rule ${index + 1}: ${d.rules[index]?.when}`}`, ...(note ? [`  ${note}`] : []), ...candidates.map((c) => `  candidate: ${describe(c.profile)} -> ${c.why}`)];
  if (!pick) return [...lines, '  no eligible profile: configure the agent, or pick another rule.'].join('\n');
  return [...lines, `  profile: ${profileFlags(pick)}`, ...(pick.effort ? [] : [`  ${EFFORT_FALLBACK}`])].join('\n');
}

/**
 * Spawn's dispatch checks. While the profile file exists every spawn names its agent (a malformed file refuses every spawn).
 * max effort needs the Boss: his explicit word for this task (bossMax), or a profile of this agent he declared with it.
 */
export function checkDispatch(o: { agent?: string; effort?: string; model?: string; bossMax?: boolean }, env: NodeJS.ProcessEnv = process.env): void {
  if (o.effort !== undefined && !EFFORTS.includes(o.effort as Effort)) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (o.model !== undefined && !o.model.trim()) throw new Error('--model is empty');
  const d = loadDispatch(env);
  if (d && !o.agent) throw new Error(`Dispatch profiles are configured (${dispatchPath(env)}): pass the resolved profile's --agent (see amigo dispatch).`);
  if (o.effort === 'max' && !o.bossMax) {
    const declared = d ? [...d.rules.flatMap((r) => r.use), ...(d.default ?? [])].some((p) => p.agent === o.agent && p.effort === 'max' && (!o.model || !p.model || p.model === o.model)) : false;
    if (!declared) throw new Error('--effort max needs the Boss: pass --boss-max when he asked for it on this task (or declare it in a dispatch profile).');
  }
}

/** The launch flags for a Claude Code crew member's model and effort. Other agents get none: the values are recorded on the task only. */
export const claudeProfileArgs = (t: { model?: string; effort?: string }): string[] => [...(t.model ? ['--model', t.model] : []), ...(t.effort ? ['--effort', t.effort] : [])];
