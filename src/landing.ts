import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Project } from './config.ts';
import { classifyDone } from './delivery.ts';
import { withLock } from './fsx.ts';
import { assertWorktreeIntact, branchSha, secretRefusal, worktreeRun } from './git.ts';
import { lockPath } from './paths.ts';
import { run } from './proc.ts';
import { defaultBranch } from './projects.ts';
import type { Task } from './tasks.ts';

/** How long a fetch the gates make may take before they decide on the refs they already have. */
const FETCH_TIMEOUT_MS = 60_000;

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? '';
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

/**
 * Refresh the clone's remote-tracking refs from origin (bounded). A no-mistakes pipeline pushes from its own clone, so nothing
 * else brings that push here. Returns why it could not, or null.
 */
export function refreshRemote(clone: string): string | null {
  if (git(clone, ['remote', 'get-url', 'origin']).status !== 0) return 'no origin remote';
  const r = run('git', ['-C', clone, 'fetch', '--quiet', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS });
  return r.error || r.status !== 0 ? firstLine(r.error?.message || r.stderr || r.stdout) || 'fetch failed' : null;
}

/** Remote-tracking refs (other than the local no-mistakes mirror, which is not a forge) that contain this exact commit. */
export function remoteRefsContaining(clone: string, sha: string): string[] {
  const r = git(clone, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/remotes']);
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('refs/remotes/no-mistakes/') && !l.endsWith('/HEAD'));
}

/** The worktree's uncommitted entries (all untracked files included), less the .claude/ allowance. */
function dirtyEntries(t: Task): string[] {
  const r = worktreeRun(t.repo as string, t.worktree as string, ['status', '--porcelain', '--untracked-files=all'], { gitDir: t.gitDir });
  if (r.status !== 0) throw new Error(`could not read the worktree's status: ${firstLine(r.stderr || r.stdout)}`);
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3))
    .filter((f) => !f.replace(/^"/, '').startsWith('.claude/'));
}

function worktreeHead(t: Task): string {
  const r = worktreeRun(t.repo as string, t.worktree as string, ['rev-parse', '--verify', 'HEAD'], { gitDir: t.gitDir });
  if (r.status !== 0) throw new Error(`could not read the worktree's HEAD: ${firstLine(r.stderr || r.stdout)}`);
  return r.stdout.trim();
}

/** What a live PR read gives the done gate; null when it could not be read (which does not refuse). */
export type PrPeek = (url: string) => { isDraft?: boolean; headRefOid?: string } | null;

/**
 * The Definition-of-done gate on a build's done line. Returns what to record on the task,
 * or throws with the refusal, which the crew member reads. Builds only; anything else passes.
 *
 * no-mistakes   the first done (a summary) is the pipeline handoff and is not gated; `PR <url> checks green` is.
 * direct-PR     `PR <url>`.
 * local-only    `ready in branch <branch>`: the worktree is clean and its HEAD is the branch itself; that head is latched.
 *
 * A PR ready line passes only when the worktree is clean and its HEAD is on a remote-tracking ref after a fetch: a done whose
 * named head exists only in the crew member's disposable copy is not ready. A PR GitHub reports as a draft is refused.
 */
export function acceptDone(t: Task, note: string, peek?: PrPeek): Partial<Task> {
  if (!t.mode || !t.repo || !t.branch || !t.worktree) return {};
  const claim = classifyDone(t.mode, note);
  if (claim.kind === 'handoff') return {};
  if (claim.kind === 'unready') throw new Error(`done refused: ${claim.why}.`);
  if (!existsSync(t.worktree)) throw new Error(`done refused: the worktree ${t.worktree} is gone.`);
  const dirty = dirtyEntries(t);
  if (dirty.length) throw new Error(`done refused: the worktree has uncommitted changes (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''}). Commit them on ${t.branch}, or remove scratch files, then report done again.`);
  const head = worktreeHead(t);
  if (claim.kind === 'branch') {
    const tip = branchSha(t.repo, t.branch);
    if (tip !== head) throw new Error(`done refused: your HEAD ${head.slice(0, 12)} is not your branch ${t.branch}${tip ? ` (${tip.slice(0, 12)})` : ' (it does not exist)'}. Commit on ${t.branch} itself, then report done again.`);
    return { localDoneHead: head };
  }
  const fetchProblem = refreshRemote(t.repo);
  if (!remoteRefsContaining(t.repo, head).length) {
    const how = t.mode === 'no-mistakes' ? 'Commit nothing after the /no-mistakes run, and recover its fix commits with `no-mistakes axi sync` if it made any' : `Push it to your PR branch (git push origin ${t.branch})`;
    throw new Error(`done refused: your HEAD ${head.slice(0, 12)} exists only in this copy, not on any remote branch${fetchProblem ? ` (could not refresh from origin: ${fetchProblem}; decided on the last-known refs, so retry once origin is reachable)` : ''}. ${how}, then report done again.`);
  }
  const live = peek?.(claim.url) ?? null;
  if (live?.isDraft === true) throw new Error(`done refused: ${claim.url} is a draft, and a draft cannot be merged. Mark it ready (gh pr ready), then report done again; to keep it a draft on purpose, report paused instead.`);
  return { pr: claim.url, ...(live?.headRefOid ? { prHead: live.headRefOid } : {}) };
}

export interface Landed {
  landed: boolean;
  why: string;
}

/**
 * The landed-work test teardown runs before it discards a worktree. Uncommitted changes are never
 * landed. Committed work has landed when its HEAD is on a remote-tracking ref (after a refresh), or is in the local default
 * branch (local-only, or a project without origin), or the task's merged PR head contains it, or its content is already in
 * origin's default branch (the squash-merge-then-delete-branch case). Anything else is not landed.
 */
export function landedWork(t: Task): Landed {
  if (!t.worktree || !t.repo) return { landed: true, why: 'no worktree' };
  if (!existsSync(t.worktree)) return { landed: true, why: 'the worktree is already gone' };
  try {
    assertWorktreeIntact(t.repo, t.worktree, t.gitDir);
  } catch (err) {
    return { landed: false, why: (err as Error).message };
  }
  let dirty: string[];
  let head: string;
  try {
    dirty = dirtyEntries(t);
    head = worktreeHead(t);
  } catch (err) {
    return { landed: false, why: (err as Error).message };
  }
  if (dirty.length) return { landed: false, why: `uncommitted changes in the worktree (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''})` };
  const short = head.slice(0, 12);
  if (remoteRefsContaining(t.repo, head).length) return { landed: true, why: `${short} is on a remote branch` };
  const problem = refreshRemote(t.repo);
  if (remoteRefsContaining(t.repo, head).length) return { landed: true, why: `${short} is on a remote branch` };
  const def = defaultBranch(t.repo);
  if (def && (t.mode === 'local-only' || problem === 'no origin remote') && git(t.repo, ['merge-base', '--is-ancestor', head, `refs/heads/${def}`]).status === 0) {
    return { landed: true, why: `${short} is in the local ${def}` };
  }
  const prHead = t.merge?.head ?? t.prHead;
  if (t.merge && prHead && git(t.repo, ['cat-file', '-e', `${prHead}^{commit}`]).status === 0 && git(t.repo, ['merge-base', '--is-ancestor', head, prHead]).status === 0) {
    return { landed: true, why: `${short} is in the merged PR's head` };
  }
  const base = def ? `refs/remotes/origin/${def}` : null;
  if (base && git(t.repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status === 0) {
    const merged = git(t.repo, ['merge-tree', '--write-tree', base, head]);
    const baseTree = git(t.repo, ['rev-parse', `${base}^{tree}`]).stdout.trim();
    if (merged.status === 0 && firstLine(merged.stdout) === baseTree) return { landed: true, why: `the content of ${short} is already in origin/${def}` };
  }
  return { landed: false, why: `${short} is on no remote branch, not in the default branch, and its content is not in origin's default branch${problem && problem !== 'no origin remote' ? ` (could not refresh from origin: ${problem})` : ''}` };
}

/**
 * Land a local-only build: fast-forward the clone's default branch to the latched done head. The
 * one sanctioned write to a clone outside the guarded sync, and narrow: the branch must still point at that exact head, the
 * clone must be on its default branch and clean, and the move must be a fast-forward. Git's ref transaction verifies the
 * branch and moves the default branch together. Returns one line; throws with the refusal.
 */
export function mergeLocal(t: Task, env: NodeJS.ProcessEnv): string {
  if (t.mode !== 'local-only') throw new Error(`Task ${t.id} is mode ${t.mode ?? 'unknown'}, not local-only: merge its PR instead`);
  const head = t.localDoneHead;
  if (!head || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new Error(`Task ${t.id} has no accepted done head: the crew member must report "done: ready in branch ${t.branch}" first`);
  const clone = t.repo as string;
  const branch = t.branch as string;
  return withLock(lockPath(`land-${t.project}`, env), () => {
    if (branchSha(clone, branch) !== head) throw new Error(`Branch ${branch} differs from the accepted done head ${head.slice(0, 12)}; refusing. Have the crew member report done again.`);
    const def = defaultBranch(clone);
    if (!def) throw new Error(`Cannot determine the default branch of ${clone}; expected origin/HEAD, main or master`);
    const cur = git(clone, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
    if (cur !== def) throw new Error(`${clone} is on '${cur || 'a detached HEAD'}', expected its default branch '${def}'; cannot merge safely`);
    if (git(clone, ['status', '--porcelain']).stdout.trim()) throw new Error(`${clone} has a dirty working tree; refusing to merge into it`);
    const before = git(clone, ['rev-parse', `refs/heads/${def}`]).stdout.trim();
    if (git(clone, ['merge-base', '--is-ancestor', before, head]).status !== 0) {
      throw new Error(`REFUSED: ${branch} is not a fast-forward of ${def} (it has diverged). Have the crew member rebase ${branch} onto ${def} and report done again.`);
    }
    // Not a waivable check: commits that add or change a secret-looking file never land, not even on the Boss's word. Every
    // commit is read (merges against each parent), so a secret added and later deleted still refuses: the history lands too.
    const diff = git(clone, ['log', '-m', '--no-renames', '--diff-filter=d', '--name-only', '--format=', '-z', `${before}..${head}`]);
    if (diff.status !== 0) throw new Error(`Could not read the files ${branch} changes in ${clone}: ${firstLine(diff.stderr || diff.stdout)}. Nothing was merged.`);
    const secrets = secretRefusal(branch, diff.stdout.split(/[\0\r\n]+/).filter(Boolean));
    if (secrets) throw new Error(secrets);
    // The two-tree checkout stages the fast-forward and refuses obstructing files; the transaction moves the ref only if the branch still holds the head.
    const staged = git(clone, ['read-tree', '-m', '-u', before, head]);
    if (staged.status !== 0) throw new Error(`Could not stage the fast-forward in ${clone}: ${firstLine(staged.stderr || staged.stdout)}`);
    const tx = spawnSync('git', ['-C', clone, 'update-ref', '-m', `merge ${branch}: Fast-forward`, '--stdin'], {
      input: `start\nverify refs/heads/${branch} ${head}\nupdate refs/heads/${def} ${head} ${before}\nprepare\ncommit\n`,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (tx.status !== 0) {
      git(clone, ['read-tree', '-m', '-u', head, before]);
      throw new Error(`The local merge was refused and ${def} left as it was: ${firstLine(tx.stderr || tx.stdout || String(tx.error ?? ''))}`);
    }
    return `merged ${branch} into local ${def} (${before.slice(0, 7)} -> ${head.slice(0, 7)}) in ${clone}`;
  });
}

/**
 * Bring a project's live install up to the merged default branch: fetch it from amigo's clone and fast-forward. Skipped and
 * reported, never forced, when the folder is not a git repo, is on another branch, has uncommitted changes, or has diverged.
 */
export function fastForwardLive(project: Pick<Project, 'name' | 'path' | 'live'>): string | null {
  const live = project.live;
  if (!live) return null;
  const label = `live ${live}`;
  if (!existsSync(live)) return `${label}: skipped: the folder is missing`;
  if (git(live, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return `${label}: skipped: not a git repo`;
  const def = defaultBranch(project.path);
  if (!def) return `${label}: skipped: cannot determine the default branch of ${project.path}`;
  const cur = git(live, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  if (cur !== def) return `${label}: skipped: on '${cur || 'a detached HEAD'}', not ${def} - needs attention`;
  if (git(live, ['status', '--porcelain']).stdout.trim()) return `${label}: skipped: uncommitted changes - needs attention`;
  const fetched = run('git', ['-C', live, 'fetch', '--quiet', project.path, `refs/heads/${def}`], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.error || fetched.status !== 0) return `${label}: skipped: could not fetch from ${project.path}: ${firstLine(fetched.error?.message || fetched.stderr || fetched.stdout)}`;
  const target = git(live, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
  const before = git(live, ['rev-parse', 'HEAD']).stdout.trim();
  if (before === target) return `${label}: already current`;
  if (git(live, ['merge-base', '--is-ancestor', before, target]).status !== 0) return `${label}: skipped: diverged from ${def} - needs attention`;
  const merged = git(live, ['merge', '--ff-only', '--quiet', target]);
  if (merged.status !== 0) return `${label}: skipped: fast-forward failed: ${firstLine(merged.stderr || merged.stdout)}`;
  return `${label}: fast-forwarded ${before.slice(0, 7)}..${target.slice(0, 7)}`;
}
