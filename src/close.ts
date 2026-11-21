import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logApproval } from './approvals.ts';
import { drain } from './squad.ts';
import { forgetFolder } from './claude.ts';
import { loadProjects } from './config.ts';
import { gatesConfirmed, reviewProblem, selfApproval } from './gates.ts';
import { branchSha, changedFiles, commitAll, commitsAhead, committedFiles, deleteBranchIfUnused, hasRemote, onOriginDefault, pushBranch, removeWorktree } from './git.ts';
import { checkPrTitle, openDraftPr, requireGh } from './github.ts';
import { scratchDir, taskDir } from './paths.ts';
import { policyState } from './policy.ts';
import { killTree } from './proc.ts';
import { assessChanges, snapshot } from './risk.ts';
import { removeTabConfig } from './terminal.ts';
import { listTasks, mutateTask, requireTask, runnerAlive, type Task } from './tasks.ts';

export interface CloseOptions {
  commit?: boolean;
  message?: string;
  force?: boolean;
  /** After committing, push the branch to origin and open a draft pull request. Only under an approved policy whose pr is not "never". */
  pr?: boolean;
  /** The agent approves its own commit under the user's approved policy (see policy.ts). */
  self?: boolean;
}

/** What the gate saw: the reasons a self-approval rests on, and the git tree of the work it checked (the commit must be exactly that). */
interface Gate {
  reasons?: string[];
  tree?: string;
}

/**
 * Checks that must hold before anything is touched: what a pull request needs (an approved policy that allows it, origin,
 * gh), the review a non-trivial change needs, or the policy and the rules of self-approval. Throws.
 */
function commitGate(t: Task, opts: CloseOptions, env: NodeJS.ProcessEnv): Gate {
  if (opts.pr) {
    const policy = policyState(env);
    if (!policy.approved) throw new Error(`--pr needs an approved policy that allows pull requests, and ${policy.problem}. Ask the user, or close without --pr.`);
    if (policy.policy?.pr === 'never') throw new Error(`The approved policy does not allow pull requests ("pr": "never" in ${policy.file}). Close without --pr, or ask the user to change it and run amigo approve-policy.`);
    if (!t.repo || !t.branch) throw new Error(`Task ${t.id} has no git branch, so there is nothing to open a pull request for`);
    if (!hasRemote(t.repo, 'origin')) throw new Error(`${t.repo} has no remote named origin to push ${t.branch} to. Close without --pr, or add the remote.`);
    checkPrTitle(t.title, requireGh(env));
    if (t.baseSha && !onOriginDefault(t.repo, t.baseSha)) {
      const why = t.after ? `it builds on the commits of ${t.after}, which are` : 'its starting commit has commits that are';
      throw new Error(`${t.id} cannot open a pull request: ${why} not on origin's default branch (as of the last fetch), so the pull request would carry work that is not this task's. Push or merge those commits and fetch, or close without --pr.`);
    }
  }
  if (!t.worktree || !t.repo || !t.baseSha || !existsSync(t.worktree)) {
    if (opts.self) throw new Error(`Task ${t.id} cannot be self-approved: it has no git worktree to check`);
    return {};
  }
  const snap = snapshot(t.repo, t.worktree, t.baseSha, t.gitDir);
  const project = loadProjects(env).find((p) => p.name === t.project);
  const risk = assessChanges(snap.changes, project?.risky);
  if (opts.self) {
    const { problems, reasons } = selfApproval(t, snap, risk, policyState(env), project, project ? gatesConfirmed(project, env) : false, Boolean(opts.pr));
    if (problems.length) throw new Error(`${t.id} cannot be self-approved:\n${problems.map((p) => `  - ${p}`).join('\n')}\nAsk the user, then close --commit without --self.`);
    return { reasons, tree: snap.tree };
  }
  const problem = reviewProblem(t, snap, risk);
  if (problem) throw new Error(problem);
  return { tree: snap.tree };
}

/** Push the task's branch (that one only) to origin and open a draft pull request. Returns what to tell the user, and the URL. */
function openPullRequest(t: Task, env: NodeJS.ProcessEnv): { lines: string[]; url?: string } {
  if (t.pr) return { lines: [`The pull request is already open: ${t.pr}`], url: t.pr };
  if (!t.repo || !t.branch || !t.baseSha || commitsAhead(t.repo, t.branch, t.baseSha) === 0) return { lines: ['Nothing was committed, so no pull request was opened.'] };
  pushBranch(t.repo, t.branch, env, t.id);
  const body = [t.summary || t.title, ...(t.issue ? [`Closes #${t.issue.number}`] : [])].join('\n\n') + '\n';
  const bodyFile = join(taskDir(t.id, env), 'pr-body.md');
  writeFileSync(bodyFile, body);
  const url = openDraftPr(t.repo, t.branch, t.title, bodyFile, env);
  mutateTask(t.id, () => ({ pr: url }), env);
  return { lines: [`Pushed ${t.branch} to origin.`, `Opened a draft pull request: ${url}`], url };
}

/**
 * Close a squad member: stop its session, optionally commit its work to its branch (and open a draft pull request for it), then
 * remove its worktree. Never merges, and pushes only its own amigo/<id> branch, only with --pr.
 */
export function closeMember(id: string, opts: CloseOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  const reviewers = listTasks(env).filter((r) => r.reviewOf === id && r.status !== 'closed');
  if (reviewers.length) throw new Error(`Close the review first: ${reviewers.map((r) => r.id).join(', ')}`);
  if ((opts.pr || opts.self) && !opts.commit) throw new Error('--pr and --self only make sense with --commit');
  if (opts.self && opts.force) throw new Error('--self cannot be combined with --force: self-approval has no overrides');
  const gate: Gate = opts.commit ? commitGate(requireTask(id, env), opts, env) : {};
  const selfReasons = gate.reasons;
  // Claim the task first: from here on, drain will not start it and its tab will not overwrite it.
  let previous = 'queued' as Task['status'];
  const t = mutateTask(
    id,
    (cur) => {
      if (cur.status === 'closed' || cur.status === 'closing') throw new Error(`Task ${id} is already ${cur.status}`);
      if ((cur.status === 'running' || cur.status === 'verifying') && !opts.force) throw new Error(`Task ${id} is still ${cur.status}. Wait for it, or use --force to stop it.`);
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
      if (existsSync(t.worktree)) {
        if (opts.commit) {
          const sha = commitAll(t.repo, t.worktree, t.branch, opts.message?.trim() || t.title, gate.tree, env, t.gitDir);
          out.push(sha ? `Committed ${sha} to branch ${t.branch}:` : 'Nothing to commit.', ...(sha ? committedFiles(t.repo, sha).map((f) => `  ${f}`) : []));
          if (sha && selfReasons) {
            logApproval({ event: 'approve', id, project: t.project, branch: t.branch, sha: branchSha(t.repo, t.branch) as string, reasons: selfReasons, undo: `amigo undo ${id}` }, env);
            out.push(`Self-approved under the policy (logged in approvals.jsonl). Undo: amigo undo ${id}`);
          }
          if (opts.pr) {
            const pr = openPullRequest(t, env);
            out.push(...pr.lines);
            if (pr.url && selfReasons) logApproval({ event: 'pr', id, project: t.project, branch: t.branch, url: pr.url }, env);
          }
        } else {
          const changes = opts.force ? [] : changedFiles(t.repo, t.worktree, t.gitDir);
          if (changes.length) throw new Error(`Task ${id} has ${changes.length} changed files. Use --commit to keep them on branch ${t.branch}, or --force to discard them.`);
        }
      }
      if (opts.commit && t.baseSha && commitsAhead(t.repo, t.branch, t.baseSha) > 0) committed = branchSha(t.repo, t.branch) ?? undefined;
      removeWorktree(t.repo, t.worktree);
      if (deleteBranchIfUnused(t.repo, t.branch, t.baseSha)) out.push(`Removed the unused branch ${t.branch}.`);
      else if (branchSha(t.repo, t.branch)) out.push(`Branch ${t.branch} kept. Nothing was merged${opts.pr ? '' : ' or pushed'}.`);
    } else if (t.scratch && !t.reviewOf && t.briefing && t.cwd === scratchDir(t.id, env)) {
      // The briefing's own squad member leaves nothing worth keeping; every other scratch member keeps its folder.
      rmSync(t.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      out.push("Removed the briefing squad member's scratch folder.");
    } else if (t.scratch && !t.reviewOf) {
      out.push(`Kept the scratch folder (nothing was committed, it is not git): ${t.cwd}`);
    } else if (opts.commit) {
      out.push('This squad member worked in place (not a git worktree), so there is nothing to commit.');
    }
    // Claude Code adds an entry for every folder a session ran in: drop the squad member's worktree, and a folder only we trusted.
    for (const dir of [t.worktree, t.trustAdded && !t.worktree ? t.cwd : null]) {
      if (!dir) continue;
      try {
        forgetFolder(dir, env);
      } catch (err) {
        out.push(`Warning: could not remove ${dir} from ~/.claude.json: ${(err as Error).message}`);
      }
    }
    removeTabConfig(t.tabConfig);
    mutateTask(id, () => ({ status: 'closed', pid: null, tabConfig: null, ...(committed ? { committed } : {}) }), env);
    out.push(`Closed ${id}.`);
  } catch (err) {
    mutateTask(id, () => ({ status: previous === 'running' || previous === 'verifying' ? 'failed' : previous, pid: null }), env);
    throw err;
  }
  const started = drain(env);
  if (started.length) out.push(`Started queued: ${started.join(', ')}`);
  return out;
}
