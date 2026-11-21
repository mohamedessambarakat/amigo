import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { branchPushed, branchSha, deleteBranch } from './git.ts';
import { approvalsPath } from './paths.ts';
import { requireTask } from './tasks.ts';

/** One line of approvals.jsonl. `approve` is a self-approved commit, `pr` its pull request, `undo` the branch deleted again. */
export interface ApprovalRecord {
  time: string;
  event: 'approve' | 'pr' | 'undo';
  id: string;
  project?: string;
  branch?: string;
  /** Full sha of the commit. */
  sha?: string;
  reasons?: string[];
  /** How to take it back. */
  undo?: string;
  url?: string;
}

export function logApproval(record: Omit<ApprovalRecord, 'time'>, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dirname(approvalsPath(env)), { recursive: true });
  appendFileSync(approvalsPath(env), `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
}

/** Every readable line of approvals.jsonl. A damaged line is skipped with a warning, so one bad line cannot lock out every undo. */
export function readApprovals(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = (m) => process.stderr.write(`octomaxxing: ${m}\n`)): ApprovalRecord[] {
  if (!existsSync(approvalsPath(env))) return [];
  const records: ApprovalRecord[] = [];
  readFileSync(approvalsPath(env), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.trim() === '') return;
      try {
        records.push(JSON.parse(line) as ApprovalRecord);
      } catch {
        warn(`warning: line ${i + 1} of ${approvalsPath(env)} is not valid JSON and was skipped`);
      }
    });
  return records;
}

/** Take back a self-approved commit: delete its branch, unless the branch was pushed or moved. Logs the undo. */
export function undoSelfApproved(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const records = readApprovals(env).filter((r) => r.id === id);
  const approval = records.find((r) => r.event === 'approve');
  if (!approval) throw new Error(`${id} was not self-approved (no entry in ${approvalsPath(env)}), so there is nothing to undo here.`);
  if (records.some((r) => r.event === 'undo')) throw new Error(`${id} was already undone.`);
  const t = requireTask(id, env);
  if (!t.repo || !t.branch) throw new Error(`${id} has no branch to delete.`);
  const tip = branchSha(t.repo, t.branch);
  if (!tip) throw new Error(`Branch ${t.branch} no longer exists in ${t.repo}.`);
  if (branchPushed(t.repo, t.branch)) {
    throw new Error(`Branch ${t.branch} was pushed (or has an upstream), so other people may have it: octomaxxing will not delete it. Undo it by hand: close the pull request and delete the remote branch, then the local one.`);
  }
  if (tip !== approval.sha) throw new Error(`Branch ${t.branch} moved since it was approved (approved ${approval.sha?.slice(0, 8)}, now ${tip.slice(0, 8)}). Check it by hand in ${t.repo}.`);
  deleteBranch(t.repo, t.branch);
  logApproval({ event: 'undo', id, project: t.project, branch: t.branch, sha: tip }, env);
  return [`Deleted branch ${t.branch} (was ${tip.slice(0, 8)}) in ${t.repo}. Nothing else was touched.`];
}
