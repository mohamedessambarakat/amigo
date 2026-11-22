import { closeMember } from './close.ts';
import { loadProjects, type Project } from './config.ts';
import { fastForwardLive, mergeLocal } from './landing.ts';
import { describePr, mergePinned, parsePrUrl, requiredChecks, verifyMergeable, viewPr, type PrView } from './pr.ts';
import { appendStatus, formatStatusLine } from './status.ts';
import { syncProject } from './sync.ts';
import { isActive } from './squad.ts';
import { mutateTask, requireTask, type MergeRecord, type Task } from './tasks.ts';

export interface MergeOptions {
  /** The PR to merge; else the one the task recorded. */
  url?: string;
  /** The Boss explicitly said to merge this, now. Without it only a yolo project's green work may be merged. */
  boss?: boolean;
  /** Waive exactly this one check that is not green (needs --boss). */
  allowRed?: string;
  /** Waive exactly this one required check that has not reported (needs --boss). */
  allowMissing?: string;
  /** Merge only if the PR's head is exactly this commit. */
  expectedHead?: string;
  method?: 'squash' | 'merge' | 'rebase';
}

/** How long to keep re-reading a PR whose mergeability GitHub is still computing. AMIGO_MERGE_RETRY_MS overrides the pause (tests). */
const UNKNOWN_BUDGET_MS = 15_000;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function projectOf(t: Task, env: NodeJS.ProcessEnv): Project {
  const p = loadProjects(env).find((x) => x.name === t.project);
  if (!p) throw new Error(`Task ${t.id}'s project ${t.project} is no longer registered`);
  return p;
}

/**
 * Who may merge: the Boss's current, explicit instruction, or yolo (the project's standing routine merge authority) for green
 * work only. A red or unreported check is waived only on the Boss's word.
 */
function authority(t: Task, p: Project, opts: MergeOptions): 'boss' | 'yolo' {
  if ((opts.allowRed || opts.allowMissing) && !opts.boss) throw new Error('Waiving a check that is not green or has not reported needs a current, explicit instruction from the Boss (--boss). Nothing was merged.');
  if (opts.boss) return 'boss';
  if (p.yolo) return 'yolo';
  throw new Error(`${p.name} is not yolo, so ${t.id} merges only when the Boss says "merge it" (then: amigo merge ${t.id} --boss). Nothing was merged.`);
}

function record(id: string, merge: MergeRecord, env: NodeJS.ProcessEnv): void {
  mutateTask(id, () => ({ merge }), env);
  appendStatus(id, formatStatusLine('note', `merged by amigo (${merge.authority}): ${merge.url ?? merge.how} at ${merge.head.slice(0, 12)}`), env);
}

/**
 * `amigo merge <id>`: land a build. A PR is merged only after a live check that it is open, not a draft, mergeable and green on
 * every required check at its current head, with that head pinned (--match-head-commit), and counts only once GitHub reads
 * back merged. A local-only build lands by the guarded fast-forward. Then the after-merge steps run.
 */
export function mergeTask(id: string, opts: MergeOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  const t = requireTask(id, env);
  if (t.merge) throw new Error(`${id} is already merged (${t.merge.url ?? t.merge.how}, ${t.merge.at}). Run amigo land ${id} to finish the cleanup.`);
  if (!t.mode || !t.branch) throw new Error(`${id} is not a build, so there is nothing to merge`);
  const p = projectOf(t, env);
  const by = authority(t, p, opts);
  const out: string[] = [];
  if (t.mode === 'local-only') {
    if (opts.url) throw new Error('A local-only build has no PR: leave out --pr');
    const line = mergeLocal(t, env);
    out.push(line);
    record(id, { how: 'local fast-forward', head: t.localDoneHead as string, at: new Date().toISOString(), authority: by }, env);
    return [...out, ...afterMerge(id, env)];
  }
  const url = opts.url ?? t.pr;
  if (!url) throw new Error(`${id} has no recorded PR. Wait for its ready line (done: PR <url>), or pass --pr <url>.`);
  const ref = parsePrUrl(url);
  if (t.pr && opts.url && opts.url !== t.pr) throw new Error(`${id} recorded ${t.pr}, not ${opts.url}; refusing to merge a PR the task did not report`);
  const cwd = t.repo ?? p.path;
  const retryMs = Number(env.AMIGO_MERGE_RETRY_MS) || 3000;
  let view: PrView;
  let checks: ReturnType<typeof verifyMergeable>;
  for (const end = Date.now() + UNKNOWN_BUDGET_MS; ; ) {
    view = viewPr(url, cwd, env);
    checks = verifyMergeable(view, requiredChecks(ref, view.baseRefName, cwd, env), { allowRed: opts.allowRed, allowMissing: opts.allowMissing, expectedHead: opts.expectedHead });
    if (!checks.unknownOnly || Date.now() >= end) break;
    sleep(retryMs);
  }
  if (checks.refusals.length) {
    const pending = checks.unknownOnly ? ' (GitHub is still computing mergeability: run the merge again shortly)' : '';
    throw new Error(`refusing to merge ${url}${pending}:\n${checks.refusals.map((r) => `  - ${r}`).join('\n')}`);
  }
  out.push(`verified: ${url} is open and mergeable, with every unwaived required check reported and every unwaived check green at head ${checks.head}`);
  const method = opts.method ?? 'squash';
  const merged = mergePinned(url, checks.head, method, cwd, env);
  const after = viewPr(url, cwd, env);
  if (after.state.toUpperCase() !== 'MERGED') {
    throw new Error(`${merged.ok ? 'gh reported success, but' : `gh pr merge failed (${merged.said}), and`} ${url} reads ${after.state.toLowerCase()}, not merged. Nothing is recorded as landed.`);
  }
  record(id, { url, head: checks.head, at: new Date().toISOString(), authority: by, how: method, ...(after.mergeCommit?.oid ? { commit: after.mergeCommit.oid } : {}) }, env);
  mutateTask(id, () => ({ prHead: checks.head }), env);
  out.push(`merged ${url} (${method}, head ${checks.head.slice(0, 12)}, authority: ${by === 'boss' ? 'the Boss' : 'yolo'})`);
  return [...out, ...afterMerge(id, env)];
}

/**
 * After a confirmed merge: refresh the clone, fast-forward the live install, then tear the build down, but only once the
 * landed-work test passes (close refuses otherwise). A crew member still at work keeps its worktree until it stops.
 */
export function afterMerge(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const t = requireTask(id, env);
  if (!t.merge) throw new Error(`${id} has no confirmed merge`);
  const out: string[] = [];
  const p = loadProjects(env).find((x) => x.name === t.project);
  if (p && t.mode !== 'local-only') out.push(`clone: ${syncProject(p)}`);
  const live = p ? fastForwardLive(p) : null;
  if (live) out.push(live);
  if (t.status === 'closed') return out;
  if (isActive(t)) {
    out.push(`cleanup waits: ${id} is still ${t.status}. When it stops: amigo land ${id}`);
    return out;
  }
  try {
    out.push(...closeMember(id, {}, env));
  } catch (err) {
    out.push(`cleanup refused: ${(err as Error).message}`);
  }
  return out;
}

/**
 * `amigo pr-check <id>`: the after-PR watch. Reads the PR live and reports CI and merge state; a PR merged on GitHub (by the Boss
 * or anyone) is recorded and the after-merge steps run. With watchMs, polls until it is merged or closed, CI turns red, or time
 * runs out.
 */
export async function prCheck(id: string, opts: { url?: string; watchMs?: number; pollMs?: number }, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let t = requireTask(id, env);
  const url = opts.url ?? t.pr;
  if (!url) throw new Error(`${id} has no recorded PR: pass its URL`);
  parsePrUrl(url);
  if (!t.pr || t.pr !== url) {
    if (t.pr && !t.merge) throw new Error(`${id} recorded ${t.pr}; refusing to replace it with ${url} while it is not merged`);
    t = mutateTask(id, () => ({ pr: url }), env);
  }
  const cwd = t.repo ?? process.cwd();
  const end = Date.now() + (opts.watchMs ?? 0);
  let last = '';
  for (;;) {
    const view = viewPr(url, cwd, env);
    const line = describePr(view);
    if (view.state.toUpperCase() === 'MERGED') return [`${url}: merged`, ...forgeMerged(id, url, view, env)];
    if (view.state.toUpperCase() === 'CLOSED') return [`${url}: closed without merging. The work is not landed; the worktree stays until the Boss decides.`];
    if (/CI red/.test(line) || Date.now() >= end) return [`${url}: ${line}`];
    if (line !== last && opts.watchMs) last = line;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? (Number(env.AMIGO_PR_POLL_MS) || 30_000)));
  }
}

/** A PR found merged on GitHub (by the Boss or anyone): record it, if not yet, then run the after-merge steps. */
function forgeMerged(id: string, url: string, view: PrView, env: NodeJS.ProcessEnv): string[] {
  if (!requireTask(id, env).merge) {
    record(id, { url, head: view.headRefOid, at: new Date().toISOString(), authority: 'forge', how: 'merged on GitHub', ...(view.mergeCommit?.oid ? { commit: view.mergeCommit.oid } : {}) }, env);
    mutateTask(id, () => ({ prHead: view.headRefOid }), env);
  }
  return afterMerge(id, env);
}

/**
 * One live read of a build's recorded PR, for the watcher: a signature of its state (`merged`, `closed`, `red:<head>`,
 * `green:<head>:<mergeable>`, or `pending:<head>` while CI runs) and a line to show. A PR merged on GitHub is recorded and
 * cleaned up here, as pr-check does. Throws when the PR cannot be read.
 */
export function prWatch(id: string, env: NodeJS.ProcessEnv = process.env): { sig: string; line: string } {
  const t = requireTask(id, env);
  if (!t.pr) throw new Error(`${id} has no recorded PR`);
  const view = viewPr(t.pr, t.repo ?? process.cwd(), env);
  const state = view.state.toUpperCase();
  if (state === 'MERGED') return { sig: 'merged', line: `${t.pr}: merged on GitHub. ${forgeMerged(id, t.pr, view, env).join(' ')}` };
  if (state === 'CLOSED') return { sig: 'closed', line: `${t.pr}: closed without merging. The work is not landed; the worktree stays until the Boss decides.` };
  const line = describePr(view);
  const head = view.headRefOid;
  if (/CI red/.test(line)) return { sig: `red:${head}`, line: `${t.pr}: ${line}` };
  if (/CI running/.test(line) || view.isDraft) return { sig: `pending:${head}`, line: `${t.pr}: ${line}` };
  const project = loadProjects(env).find((p) => p.name === t.project);
  const next = project?.yolo ? `ready: amigo merge ${id}` : `ready for the Boss's "merge it" (amigo merge ${id} --boss)`;
  return { sig: `green:${head}:${view.mergeable}`, line: `${t.pr}: ${line}${view.mergeable === 'MERGEABLE' ? ` - ${next}` : ''}` };
}

/** `amigo land <id>`: finish the after-merge steps of a merged build (after its crew member stopped, or a refusal was fixed). */
export function landTask(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const t = requireTask(id, env);
  if (!t.merge) throw new Error(`${id} has no confirmed merge: amigo merge ${id}, or amigo pr-check ${id} when it was merged on GitHub`);
  return afterMerge(id, env);
}
