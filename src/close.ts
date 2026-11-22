import { rmSync } from 'node:fs';
import { forgetFolder } from './claude.ts';
import { branchSha, deleteBranch, deleteBranchIfUnused, removeWorktree } from './git.ts';
import { landedWork } from './landing.ts';
import { scratchDir } from './paths.ts';
import { killTree } from './proc.ts';
import { drain } from './squad.ts';
import { listTasks, mutateTask, requireTask, runnerAlive, type Task } from './tasks.ts';
import { listChecks, removeCheck } from './watch.ts';
import { returnWorktree } from './worktree.ts';
import { closeItem, findItem, replayPendingCloses, reportLink } from './backlog.ts';
import { discardSurveyBranch, reportWritten, surveyCloseProblem } from './survey.ts';

export interface CloseOptions {
  /**
   * Discard authority: tear down even when the work has not landed, and stop a crew member still at work. Only on the Boss's
   * explicit word; never to get past a refusal.
   */
  force?: boolean;
}

/**
 * Tear a crew member down: stop its session, then give its worktree back to the pool. A build's
 * worktree goes only once its work has landed (see landedWork): a refusal is a stop-and-investigate result, never an
 * obstacle to bypass. Safety is proved again after the crew member's processes are stopped. Never commits, pushes or merges.
 */
export function closeMember(id: string, opts: CloseOptions = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  const reviewers = listTasks(env).filter((r) => r.reviewOf === id && r.status !== 'closed');
  if (reviewers.length) throw new Error(`Close the review first: ${reviewers.map((r) => r.id).join(', ')}`);
  const first = requireTask(id, env);
  const survey = surveyCloseProblem(first, opts, env);
  if (survey) throw new Error(survey);
  const refuse = (why: string) =>
    new Error(`${id} was not torn down: its work has not landed (${why}). Investigate: merge it (amigo merge ${id}), have the crew member push or commit it, or, only on the Boss's explicit word to discard it, amigo close ${id} --force.`);
  // A survey's worktree is a laboratory: its edits are discarded and its report is the deliverable, so the landed-work test does not apply.
  if (!opts.force && first.kind !== 'survey' && first.worktree && first.repo) {
    const landed = landedWork(first);
    if (!landed.landed) throw refuse(landed.why);
  }
  // A home that keeps a backlog needs a working tasks-axi before anything is cleaned up, so the transition cannot be skipped.
  if (first.backlogItem) {
    replayPendingCloses(env);
    findItem(id, env);
  }
  // Claim the task first: from here on, drain will not start it and its tab will not overwrite it.
  let previous = 'queued' as Task['status'];
  const t = mutateTask(
    id,
    (cur) => {
      if (cur.status === 'closed' || cur.status === 'closing') throw new Error(`Task ${id} is already ${cur.status}`);
      if ((cur.status === 'running' || cur.status === 'verifying') && !opts.force) throw new Error(`Task ${id} is still ${cur.status}. Wait for it, or stop it first: amigo control ${id} exit.`);
      previous = cur.status;
      return { status: 'closing' };
    },
    env,
  );
  const out: string[] = [];
  let committed: string | undefined;
  try {
    if (t.pid && runnerAlive(id, env)) killTree(t.pid);
    if (t.worktree && t.repo && t.branch) {
      if (!opts.force && t.kind !== 'survey') {
        const landed = landedWork(t);
        if (!landed.landed) throw refuse(landed.why);
        out.push(`Landed: ${landed.why}.`);
      }
      // Only landed work is a commit a later task may build on (--after); discarded work is not.
      const tip = branchSha(t.repo, t.branch);
      if (!opts.force && t.kind !== 'survey' && tip && tip !== t.baseSha) committed = tip;
      if (t.leased) returnWorktree(t.repo, t.worktree, env, t.gitDir);
      else removeWorktree(t.repo, t.worktree);
      if (t.kind === 'survey') out.push(...discardSurveyBranch(t.repo, t.branch));
      else if (deleteBranchIfUnused(t.repo, t.branch, t.baseSha)) out.push(`Removed the unused branch ${t.branch}.`);
      else if (branchSha(t.repo, t.branch) && !opts.force) {
        deleteBranch(t.repo, t.branch);
        out.push(`Removed the local branch ${t.branch} (its work has landed).`);
      } else if (branchSha(t.repo, t.branch)) out.push(`Discarded the worktree on the Boss's word; branch ${t.branch} is kept in ${t.repo}.`);
    } else if (t.scratch && !t.reviewOf && t.briefing && t.cwd === scratchDir(t.id, env)) {
      // The briefing's own crew member leaves nothing worth keeping; every other scratch member keeps its folder.
      rmSync(t.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      out.push("Removed the briefing crew member's scratch folder.");
    } else if (t.scratch && !t.reviewOf) {
      out.push(`Kept the scratch folder (it is not git): ${t.cwd}`);
    }
    // Claude Code adds an entry for every folder a session ran in: drop the crew member's worktree, and a folder only we trusted.
    for (const dir of [t.worktree, t.trustAdded && !t.worktree ? t.cwd : null]) {
      if (!dir) continue;
      try {
        forgetFolder(dir, env);
      } catch (err) {
        out.push(`Warning: could not remove ${dir} from ~/.claude.json: ${(err as Error).message}`);
      }
    }
    const closed = mutateTask(id, () => ({ status: 'closed', pid: null, ...(committed ? { committed } : {}) }), env);
    out.push(`Closed ${id}.`);
    // The watcher's checks registered for this task end with it.
    for (const c of listChecks(env)) if (c.task === id && removeCheck(c.name, env)) out.push(`Removed check ${c.name}.`);
    if (closed.backlogItem) {
      const deliverable =
        closed.kind === 'survey'
          ? opts.force && !reportWritten(closed) ? { note: 'discarded' } : { report: reportLink(id, env) }
          : closed.pr
            ? { pr: closed.pr }
            : committed
              ? { note: `committed ${committed.slice(0, 12)} on ${closed.branch}` }
              : { note: 'discarded' };
      out.push(...closeItem(id, deliverable, env));
    }
  } catch (err) {
    mutateTask(id, () => ({ status: previous === 'running' || previous === 'verifying' ? 'failed' : previous, pid: null }), env);
    throw err;
  }
  const started = drain(env);
  if (started.length) out.push(`Started queued: ${started.join(', ')}`);
  return out;
}
