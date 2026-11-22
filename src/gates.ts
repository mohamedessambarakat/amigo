import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { findProject, loadProjects, type Project } from './config.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { gatesConfirmedPath } from './paths.ts';
import { describeRisk, docsOrTestsOnly, snapshot, type Risk, type Snapshot } from './risk.ts';
import { getTask, mutateTask, type Task } from './tasks.ts';
import type { PolicyState } from './policy.ts';

/** PASS or FAIL as the first word of a reviewer's STATUS summary ("PASS - ..."), else null. */
export function parseVerdict(summary: string): 'PASS' | 'FAIL' | null {
  const m = /^[\s*_`>#-]*(?:verdict:?\s*)?(PASS|FAIL)\b/i.exec(summary);
  return m ? (m[1]!.toUpperCase() as 'PASS' | 'FAIL') : null;
}

/** The parent's git tree now, or undefined when it has none to measure. */
export function treeOf(t: Task): string | undefined {
  if (!t.worktree || !t.repo || !t.baseSha || !existsSync(t.worktree)) return undefined;
  try {
    return snapshot(t.repo, t.worktree, t.baseSha, t.gitDir).tree;
  } catch {
    return undefined; // a verdict that cannot be tied to the work never opens the gate
  }
}

/**
 * A reviewer squad member is about to say done with this summary: record its verdict on the task it reviewed, with the work it
 * saw. Done before the reviewer's status changes, so whoever hears "done" finds the verdict in place. The verdict does not
 * count when the work changed while the reviewer read it, and a PASS never overrides a FAIL of the same work.
 */
export function recordVerdict(reviewer: Task, summary: string, env: NodeJS.ProcessEnv): void {
  if (!reviewer.reviewOf) return;
  const verdict = parseVerdict(summary);
  const parent = getTask(reviewer.reviewOf, env);
  if (!verdict || !parent) return;
  const seen = reviewer.reviewedTree;
  let voided: string | undefined;
  if (!seen || treeOf(parent) !== seen) voided = 'the work changed while the reviewer was reading it (or could not be measured)';
  else if (verdict === 'PASS' && parent.reviewFailedTrees?.includes(seen)) voided = 'a reviewer already failed exactly this work: change it, then review again';
  mutateTask(
    parent.id,
    (cur) => ({
      review: { by: reviewer.id, verdict, ...(seen ? { tree: seen } : {}), at: new Date().toISOString(), ...(voided ? { void: voided } : {}) },
      ...(verdict === 'FAIL' && seen ? { reviewFailedTrees: [...(cur.reviewFailedTrees ?? []), seen] } : {}),
    }),
    env,
  );
}

/** Is the task's latest review a PASS of exactly the work in its folder now? */
export function reviewPassed(t: Task, snap: Snapshot): boolean {
  return t.review?.verdict === 'PASS' && !t.review.void && t.review.tree === snap.tree;
}

/** Why `close --commit` must refuse for lack of a review, or null when it may go on. Small changes need none. */
export function reviewProblem(t: Task, snap: Snapshot, risk: Risk): string | null {
  if (risk.level === 'small') return null;
  const r = t.review;
  const need = `Spawn a reviewer (amigo spawn --review ${t.id}), and close --commit once it says PASS.`;
  const head = `${t.id} is ${describeRisk(risk)}, so it needs a reviewer's PASS before close --commit.`;
  if (!r) return `${head} No reviewer has judged it yet. ${need}`;
  if (r.verdict === 'FAIL') return `${head} Reviewer ${r.by} said FAIL: fix the findings (amigo send ${t.id}), then review again. ${need}`;
  if (r.void) return `${head} Reviewer ${r.by}'s PASS does not count: ${r.void}. ${need}`;
  if (r.tree !== snap.tree) return `${head} Its work changed since reviewer ${r.by} passed it. ${need}`;
  return null;
}

/**
 * What a project's checks, risky globs, live commands and watch items hash to: the gates a self-approval rests on, and what the
 * startup briefing may run or hand to an agent. Live and watch count only when set, so a project without them keeps its old hash.
 */
export const gatesHash = (p: Pick<Project, 'checks' | 'risky' | 'liveCommands' | 'watch'>): string =>
  createHash('sha256')
    .update(JSON.stringify({ checks: p.checks ?? [], risky: p.risky ?? [], ...(p.liveCommands?.length ? { live: p.liveCommands } : {}), ...(p.watch?.length ? { watch: p.watch } : {}) }))
    .digest('hex');

/** Have the project's checks, risky globs, live commands and watch items, as they are now, been confirmed by the user (see confirmGates)? */
export function gatesConfirmed(p: Project, env: NodeJS.ProcessEnv): boolean {
  return readJson<Record<string, { sha256?: string }>>(gatesConfirmedPath(env), {})[p.name]?.sha256 === gatesHash(p);
}

/** Store the project's gates as they are now as confirmed. Callers must have a person's yes first (the CLI insists on a terminal and a typed confirmation). */
export function confirmGates(name: string, env: NodeJS.ProcessEnv = process.env): Project {
  const p = findProject(loadProjects(env), name);
  const all = readJson<Record<string, unknown>>(gatesConfirmedPath(env), {});
  writeJsonAtomic(gatesConfirmedPath(env), { ...all, [p.name]: { sha256: gatesHash(p), confirmedAt: new Date().toISOString() } });
  return p;
}

/** What `close --commit --self` needs, checked by code: the problems that stop it, or the reasons that let it through. */
export function selfApproval(t: Task, snap: Snapshot, risk: Risk, policy: PolicyState, project: Project | undefined, gatesOk: boolean, pr: boolean): { problems: string[]; reasons: string[] } {
  const problems: string[] = [];
  const reasons: string[] = [];
  const need = (ok: boolean, good: string, bad: string) => (ok ? reasons.push(good) : problems.push(bad));
  need(policy.approved, 'the user approved the policy', `the policy is not approved: ${policy.problem}`);
  need(Boolean(t.worktree && t.repo), 'git repo', 'the project is not a git repo, so there is no branch to approve');
  need(gatesOk, "the user confirmed the project's checks and risky paths", `the project's checks or risky paths were not confirmed by the user (they ran: amigo confirm-gates ${t.project}, in a terminal)`);
  const v = t.verification;
  need(v?.state === 'passed' && v.results.length > 0, 'checks configured and all passed', v?.state === 'unverified' ? 'the project has no checks configured' : `the checks have not all passed (${v ? v.state : 'not run'})`);
  const current = project?.checks ?? [];
  need(v?.state !== 'passed' || (v.results.length === current.length && v.results.every((r, i) => r.command === current[i])), "the checks that passed are the project's current checks", "the project's checks changed after these results were recorded");
  need(v?.state !== 'passed' || (v.tree !== undefined && v.tree === snap.tree), 'the checks ran on exactly this work', 'the work changed after the checks passed');
  need(t.status === 'done', 'the squad member reported done', `the squad member is ${t.status}, not done`);
  need(risk.level === 'small', `risk small (${risk.files} files, ${risk.lines} lines, no risky paths, no deletions)`, `risk is ${describeRisk(risk)}`);
  const globs = policy.policy?.selfApproval.docsAndTestsGlobs ?? [];
  const docsOnly = docsOrTestsOnly(snap.changes, globs);
  const reviewed = reviewPassed(t, snap);
  need(docsOnly || reviewed, docsOnly ? 'only docs and tests changed' : `reviewer ${t.review?.by} passed exactly this work`, 'it changes more than docs and tests (agent instruction files never count as docs) and has no reviewer PASS for this exact work (a test file that loses a line is not "only tests" either)');
  if (pr) need(policy.policy?.pr === 'also-self-approved', 'the policy lets self-approved work open a pull request', `the policy's "pr" is "${policy.policy?.pr ?? 'unset'}", so a pull request needs the user's yes, not --self`);
  return { problems, reasons };
}
