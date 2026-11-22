import { runGh } from './github.ts';

/**
 * GitHub pull requests: the live reads `amigo merge` and the after-PR watch rely on (GitHub
 * only). Every condition is read live, never taken from recorded metadata.
 */
export interface PrRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/** Parse a canonical GitHub PR URL. Throws on anything else. */
export function parsePrUrl(url: string): PrRef {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(url.trim());
  if (!m) throw new Error(`Not a canonical GitHub pull request URL: ${url}`);
  return { url: url.trim(), owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** One entry of gh's statusCheckRollup: a check run or a commit status. */
export interface RollupEntry {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
  context?: string;
  state?: string;
}

export interface PrView {
  state: string;
  isDraft: boolean | null;
  mergeable: string;
  mergeStateStatus: string;
  headRefOid: string;
  baseRefName: string;
  statusCheckRollup: RollupEntry[];
  mergeCommit?: { oid?: string } | null;
}

const VIEW_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,mergeCommit';

function gh(args: string[], cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string } {
  const r = runGh(args, cwd, env);
  if (r.error) return { ok: false, out: '', err: `gh failed to start: ${r.error.message}` };
  return { ok: r.status === 0, out: r.stdout, err: (r.stderr || r.stdout).trim() };
}

/** The live state of a PR. Throws when it cannot be read: a merge never proceeds on a guess. */
export function viewPr(url: string, cwd: string, env: NodeJS.ProcessEnv): PrView {
  const r = gh(['pr', 'view', url, '--json', VIEW_FIELDS], cwd, env);
  if (!r.ok) throw new Error(`could not read the GitHub pull request state of ${url}: ${r.err}`);
  let j: Partial<PrView>;
  try {
    j = JSON.parse(r.out) as Partial<PrView>;
  } catch {
    throw new Error(`could not read the GitHub pull request state of ${url}: gh printed no JSON`);
  }
  if (typeof j.state !== 'string' || typeof j.headRefOid !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(j.headRefOid) || typeof j.baseRefName !== 'string' || !j.baseRefName || !Array.isArray(j.statusCheckRollup)) {
    throw new Error(`could not read the GitHub pull request state of ${url}: unexpected answer`);
  }
  return {
    state: j.state,
    isDraft: typeof j.isDraft === 'boolean' ? j.isDraft : null,
    mergeable: String(j.mergeable ?? ''),
    mergeStateStatus: String(j.mergeStateStatus ?? ''),
    headRefOid: j.headRefOid,
    baseRefName: j.baseRefName,
    statusCheckRollup: j.statusCheckRollup,
    mergeCommit: j.mergeCommit ?? null,
  };
}

const isRun = (e: RollupEntry): boolean => e.__typename === 'CheckRun';
const runOk = (e: RollupEntry): boolean => e.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(e.conclusion));
const settledAt = (e: RollupEntry): string | null => (typeof e.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.startedAt) ? e.startedAt : null);
export const checkName = (e: RollupEntry): string => (isRun(e) ? e.name : e.context) || '(unnamed check)';

/**
 * The checks that are not green. A commit status counts by its state. Check runs of one name
 * are judged by their current run: a red run is superseded only by a newer green run of the same name. With settledOnly, checks
 * still running are left out (what has actually failed, rather than what is not green yet).
 */
export function checksNotGreen(rollup: RollupEntry[], settledOnly = false): string[] {
  const bad = new Set<string>();
  const entries = rollup.filter((e) => !settledOnly || (isRun(e) ? e.status === 'COMPLETED' : e.state !== 'PENDING' && e.state !== 'EXPECTED'));
  for (const e of entries) if (!isRun(e) && e.state !== 'SUCCESS') bad.add(checkName(e));
  const groups = new Map<string, RollupEntry[]>();
  entries.filter(isRun).forEach((e, i) => {
    const key = e.name ? `n:${e.name}` : `i:${i}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  });
  for (const runs of groups.values()) {
    const reds = runs.filter((e) => !runOk(e));
    if (!reds.length) continue;
    const greens = runs.filter(runOk).map(settledAt).filter((s): s is string => s !== null);
    const newestGreen = greens.sort().at(-1) ?? null;
    const redTimes = reds.map(settledAt);
    if (newestGreen === null || reds.some((e) => e.status !== 'COMPLETED') || redTimes.some((s) => s === null) || (redTimes as string[]).sort().at(-1)! >= newestGreen) bad.add(checkName(runs[0] as RollupEntry));
  }
  return [...bad];
}

export function pendingChecks(rollup: RollupEntry[]): string[] {
  return rollup.filter((e) => (isRun(e) ? e.status !== 'COMPLETED' : e.state === 'PENDING' || e.state === 'EXPECTED')).map(checkName);
}

/**
 * GitHub's own words (its plan-gated 403) when branch rules are a paid feature on this plan: then there are none to read, which
 * is not an error. Any other failure (auth, rate limit, network, a 404, an unrelated 403) stays unreadable.
 */
const RULES_UNAVAILABLE = /Upgrade to GitHub Pro or make this repository public/;

/** A required check: its name, and the GitHub app that must produce it when the rule binds one (null: any producer). */
export interface Requirement {
  context: string;
  appId: number | null;
}

export interface RequiredChecks {
  names: string[];
  errors: string[];
  /** Requirements bound to a producing app: a same-named check run from another app does not satisfy them. */
  bound?: Requirement[];
  /** The check runs at the head with their producing app, read only when a requirement is bound. */
  producers?: { name: string; appId: number }[];
}

/** An app id as GitHub gives it: -1 and null both mean any producer. */
const appIdOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The checks the base branch requires (classic branch protection and active rulesets), by name, keeping each one's producer
 * app binding. A source that cannot be read is an error, so a required check that never reported cannot be ruled out.
 */
export function requiredChecks(ref: PrRef, base: string, cwd: string, env: NodeJS.ProcessEnv): RequiredChecks {
  const all: Requirement[] = [];
  const names = { add: (context: string, appId: unknown = null) => all.push({ context, appId: appIdOf(appId) }) };
  const errors: string[] = [];
  const branch = encodeURIComponent(base);
  const b = gh(['api', `repos/${ref.owner}/${ref.repo}/branches/${branch}`], cwd, env);
  try {
    if (!b.ok) throw new Error(b.err);
    const j = JSON.parse(b.out) as { protected?: boolean; protection?: { required_status_checks?: { checks?: { context?: string; app_id?: number | null }[]; contexts?: string[] } } };
    if (typeof j.protected !== 'boolean') throw new Error('unreadable');
    if (j.protected) {
      const rsc = j.protection?.required_status_checks;
      if (!rsc || typeof rsc !== 'object') throw new Error('unreadable');
      for (const c of rsc.checks ?? []) if (c.context) names.add(c.context, c.app_id);
      for (const c of rsc.contexts ?? []) if (c) names.add(c);
    }
  } catch {
    errors.push(`the branch protection summary for base branch ${base} could not be read`);
  }
  const rules = gh(['api', '--paginate', `repos/${ref.owner}/${ref.repo}/rules/branches/${branch}`], cwd, env);
  if (!rules.ok) {
    if (!RULES_UNAVAILABLE.test(rules.err)) errors.push(`the branch rules for base branch ${base} could not be read`);
  } else {
    try {
      const list = JSON.parse(rules.out || '[]') as { type?: string; parameters?: { required_status_checks?: { context?: string; integration_id?: number | null }[] } }[];
      if (!Array.isArray(list)) throw new Error('unreadable');
      for (const rule of list) {
        if (rule.type !== 'required_status_checks') continue;
        for (const c of rule.parameters?.required_status_checks ?? []) if (c.context) names.add(c.context, c.integration_id);
      }
    } catch {
      errors.push(`the branch rules for base branch ${base} could not be read`);
    }
  }
  // A name bound to an app anywhere is judged by its bound producers only (an unbound duplicate adds nothing).
  const bound = all.filter((r, i) => r.appId !== null && all.findIndex((x) => x.context === r.context && x.appId === r.appId) === i);
  return { names: [...new Set(all.map((r) => r.context))], errors, bound };
}

/**
 * The check runs at `head` with their producing app, needed only when a requirement is bound to an app. A read that fails is
 * an error: a bound requirement cannot then be proven satisfied.
 */
export function readProducers(ref: PrRef, head: string, required: RequiredChecks, cwd: string, env: NodeJS.ProcessEnv): RequiredChecks {
  if (!required.bound?.length) return required;
  const unreadable = { ...required, producers: [], errors: [...required.errors, `the check runs at head ${head} (their producing apps) could not be read`] };
  const r = gh(['api', '--paginate', `repos/${ref.owner}/${ref.repo}/commits/${head}/check-runs`, '--jq', '.check_runs[] | {name, app: .app.id, head_sha}'], cwd, env);
  if (!r.ok) return unreadable;
  const producers: { name: string; appId: number }[] = [];
  for (const line of r.out.split(/\r?\n/).filter((l) => l.trim())) {
    try {
      const c = JSON.parse(line) as { name?: unknown; app?: unknown; head_sha?: unknown };
      if (typeof c.name !== 'string' || typeof c.app !== 'number' || c.head_sha !== head) return unreadable;
      producers.push({ name: c.name, appId: c.app });
    } catch {
      return unreadable;
    }
  }
  return { ...required, producers };
}

export interface MergeChecks {
  /** Every failing condition, not just the first. */
  refusals: string[];
  /** mergeable=UNKNOWN is the only failing condition: GitHub is still computing it, so read again. */
  unknownOnly: boolean;
  head: string;
  red: string[];
  pending: string[];
  unreported: string[];
}

/**
 * The pre-merge conditions: open, not a draft, mergeable, no conflicts, every unwaived
 * check green at the current head, every unwaived required check reported, and the head the caller pinned (if any).
 */
export function verifyMergeable(view: PrView, required: RequiredChecks, opts: { allowRed?: string; allowMissing?: string; expectedHead?: string } = {}): MergeChecks {
  const refusals: string[] = [];
  if (view.state.toUpperCase() !== 'OPEN') refusals.push(`state is "${view.state || 'unreadable'}", not open`);
  if (view.isDraft !== false) refusals.push('the pull request is a draft');
  if (view.mergeStateStatus === 'DIRTY') refusals.push('mergeStateStatus is DIRTY (conflicts)');
  const red = checksNotGreen(view.statusCheckRollup).filter((n) => n !== opts.allowRed);
  for (const n of red) refusals.push(`check '${n}' is not green`);
  for (const e of required.errors) refusals.push(`${e}, so a required check that has not reported cannot be ruled out`);
  const reported = (n: string): boolean => {
    const apps = (required.bound ?? []).filter((r) => r.context === n).map((r) => r.appId);
    if (!apps.length) return view.statusCheckRollup.some((e) => checkName(e) === n);
    // A bound requirement: a commit status of that name, or a check run of that name from one of the bound apps.
    return view.statusCheckRollup.some((e) =>
      isRun(e) ? e.name === n && (required.producers ?? []).some((p) => p.name === n && apps.includes(p.appId)) : e.context === n,
    );
  };
  const unreported = required.names.filter((n) => !reported(n) && n !== opts.allowMissing);
  for (const n of unreported) refusals.push(`required check '${n}' has not reported at head ${view.headRefOid}`);
  if (opts.expectedHead && opts.expectedHead !== view.headRefOid) refusals.push(`the head is ${view.headRefOid}, not the expected ${opts.expectedHead}`);
  const unknownOnly = !refusals.length && view.mergeable === 'UNKNOWN';
  if (view.mergeable !== 'MERGEABLE') refusals.push(`mergeable is "${view.mergeable || 'unreadable'}", not MERGEABLE`);
  return { refusals, unknownOnly, head: view.headRefOid, red, pending: pendingChecks(view.statusCheckRollup), unreported };
}

/** Merge with the verified head pinned: a push that lands between the read and the merge fails the merge. */
export function mergePinned(url: string, head: string, method: 'squash' | 'merge' | 'rebase', cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; said: string } {
  const r = gh(['pr', 'merge', url, `--${method}`, '--match-head-commit', head], cwd, env);
  return { ok: r.ok, said: r.err || r.out.trim() };
}

/** One line on CI and merge state, for the after-PR watch. */
export function describePr(view: PrView): string {
  const red = checksNotGreen(view.statusCheckRollup, true);
  const pending = pendingChecks(view.statusCheckRollup);
  const ci = red.length ? `CI red (${red.join(', ')})` : pending.length ? `CI running (${pending.join(', ')})` : view.statusCheckRollup.length ? 'CI green' : 'no checks reported';
  return `${view.state.toLowerCase()}${view.isDraft ? ', draft' : ''}, ${ci}, mergeable ${view.mergeable || 'unknown'}, head ${view.headRefOid.slice(0, 12)}`;
}
