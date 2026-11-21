import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { policyApprovalPath, policyPath } from './paths.ts';

/** Who may open a pull request: nobody, `close --pr` after the user's yes, or also `close --self --pr`. */
export type PrMode = 'never' | 'after-human-yes' | 'also-self-approved';
const PR_MODES: PrMode[] = ['never', 'after-human-yes', 'also-self-approved'];

/**
 * What agents may do without asking again. `pr`: whether close --pr may push a branch and open a pull request (see PrMode).
 * `selfApproval`: its rules are enforced by the code (see selfApproval in gates.ts, which never merges); the file sets what
 * counts as a docs or tests file.
 */
export interface Policy {
  pr: PrMode;
  selfApproval: {
    docsAndTestsGlobs: string[];
  };
}

export const STARTER_POLICY: Policy = {
  pr: 'never',
  selfApproval: {
    docsAndTestsGlobs: ['*.md', 'docs', 'test', 'tests', '__tests__', '*.test.*', '*.spec.*'],
  },
};

/** Create the starter policy on first run. It is inactive until the user approves it. */
export function ensurePolicy(env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(policyPath(env))) writeJsonAtomic(policyPath(env), STARTER_POLICY);
}

export function validatePolicy(raw: unknown): Policy {
  const p = raw as Partial<Policy> | null;
  const s = p?.selfApproval;
  if (!p || !PR_MODES.includes(p.pr as PrMode)) throw new Error(`policy.json: "pr" must be one of ${PR_MODES.map((m) => `"${m}"`).join(', ')} (it replaces allowPr and selfApproval.allowedAction)`);
  if (!s || typeof s !== 'object') throw new Error('policy.json: needs a "selfApproval" object');
  if (!Array.isArray(s.docsAndTestsGlobs) || !s.docsAndTestsGlobs.every((g) => typeof g === 'string' && g.trim() !== '')) {
    throw new Error('policy.json: selfApproval.docsAndTestsGlobs must be a list of globs');
  }
  return { pr: p.pr as PrMode, selfApproval: { docsAndTestsGlobs: s.docsAndTestsGlobs } };
}

export interface PolicyState {
  file: string;
  /** The policy, when the file is valid. */
  policy: Policy | null;
  /** Why the policy is unusable or unapproved, in words. */
  problem: string | null;
  /** sha256 of the file as it is now. */
  hash: string | null;
  /** True only when the file is valid and is byte for byte what the user approved. */
  approved: boolean;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function policyState(env: NodeJS.ProcessEnv = process.env): PolicyState {
  const file = policyPath(env);
  if (!existsSync(file)) return { file, policy: null, problem: 'there is no policy.json (run any amigo command to create the starter)', hash: null, approved: false };
  const text = readFileSync(file, 'utf8');
  const hash = sha256(text);
  let policy: Policy;
  try {
    policy = validatePolicy(JSON.parse(text));
  } catch (err) {
    return { file, policy: null, problem: `policy.json is invalid: ${(err as Error).message}`, hash, approved: false };
  }
  const approvedHash = readJson<{ sha256?: string } | null>(policyApprovalPath(env), null)?.sha256;
  if (!approvedHash) return { file, policy, problem: 'the policy has not been approved yet (amigo approve-policy)', hash, approved: false };
  if (approvedHash !== hash) return { file, policy, problem: 'policy.json was edited after it was approved (amigo approve-policy approves the new version)', hash, approved: false };
  return { file, policy, problem: null, hash, approved: true };
}

/**
 * Store the hash of the policy as it is now. Callers must have a person's yes first (the CLI insists on a terminal and a
 * typed confirmation); nothing here can tell a person from a script.
 */
export function storeApproval(env: NodeJS.ProcessEnv = process.env): PolicyState {
  const state = policyState(env);
  if (!state.policy || !state.hash) throw new Error(state.problem ?? 'no policy to approve');
  writeJsonAtomic(policyApprovalPath(env), { sha256: state.hash, approvedAt: new Date().toISOString() });
  return policyState(env);
}

export function describePolicy(state: PolicyState): string {
  const lines = [
    `policy:  ${state.file}`,
    state.approved ? 'status:  APPROVED - agents may self-approve work that meets it (close --commit --self)' : `status:  NOT APPROVED - self-approval is off: ${state.problem}`,
  ];
  if (state.policy) lines.push(`pull requests: ${state.policy.pr}`, '', readFileSync(state.file, 'utf8').trim());
  return lines.join('\n');
}
