import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjects, type Project } from './config.ts';
import { run } from './proc.ts';

/** How long one fetch may take. */
const FETCH_TIMEOUT_MS = 5 * 60_000;

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.replace(/\s+/g, ' ') ?? '';

const realOf = (p: string): string => {
  try {
    const r = realpathSync.native(resolve(p)).replaceAll('\\', '/');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    return '';
  }
};

/**
 * Refresh one clone: fetch origin with --prune, prune local branches whose upstream is gone and
 * that no worktree holds, then fast-forward the checked-out default branch to origin/<default> when that is safe. The one safe drift
 * it heals is a clean detached HEAD with no commits of its own while <default> is free to check out. Every other off-default state
 * (another named branch, a dirty tree, a detached HEAD with its own commits, a diverged default) may hold real work: it is left
 * untouched and reported as STUCK with how far behind it is. Nothing is forced, stashed or discarded. Returns one line.
 */
export function syncProject(project: Pick<Project, 'name' | 'path' | 'mode'>, opts: { prune?: boolean } = {}): string {
  const label = project.name;
  const dir = project.path;
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `${label}: skipped: no clone at ${dir}`;
  // git discovery walks up: a plain folder under projects/ would resolve to an enclosing repository.
  const top = git('rev-parse', '--show-toplevel').stdout.trim();
  if (!top) return `${label}: skipped: not a git repo`;
  if (realOf(top) !== realOf(dir)) return `${label}: skipped: not a clone root (git would act on ${top})`;
  if (project.mode === 'local-only') return `${label}: skipped: local-only project`;
  if (git('remote', 'get-url', 'origin').status !== 0) return `${label}: skipped: no origin remote`;

  const fetch = run('git', ['-C', dir, 'fetch', 'origin', '--prune', '--quiet'], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetch.error || fetch.status !== 0) return `${label}: skipped: fetch failed${firstLine(fetch.error?.message || fetch.stderr || fetch.stdout) ? `: ${firstLine(fetch.error?.message || fetch.stderr || fetch.stdout)}` : ''}`;

  const pruned = opts.prune === false ? [] : pruneGoneBranches(dir);

  let def = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').stdout.trim().replace(/^origin\//, '');
  if (!def) def = ['main', 'master'].find((b) => git('show-ref', '--verify', '--quiet', `refs/heads/${b}`).status === 0) ?? '';
  if (!def) return withPruned(`${label}: skipped: cannot determine default branch`, label, pruned);
  const base = `origin/${def}`;
  if (git('rev-parse', '--verify', '--quiet', `${base}^{commit}`).status !== 0) return withPruned(`${label}: skipped: ${base} does not exist`, label, pruned);

  let cur = git('symbolic-ref', '--short', 'HEAD').stdout.trim();
  const dirty = git('status', '--porcelain').stdout.trim() !== '';
  const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).status === 0;
  const defaultElsewhere = () =>
    git('worktree', 'list', '--porcelain')
      .stdout.split(/\r?\n/)
      .some((l) => l === `branch refs/heads/${def}`);
  const localDefaultSafe = () => git('rev-parse', '--verify', '--quiet', `${def}^{commit}`).status !== 0 || isAncestor(def, base);
  const stuck = (state: string) => {
    const behind = git('rev-list', '--count', `HEAD..${base}`).stdout.trim() || '?';
    return withPruned(`${label}: STUCK: on ${state}, ${behind} commits behind ${base} - needs attention`, label, pruned);
  };
  const stuckState = (): string => {
    let s: string;
    if (cur) s = `branch ${cur}`;
    else if (dirty) s = 'detached HEAD';
    else if (!isAncestor('HEAD', base)) s = 'detached HEAD with unique commits';
    else if (defaultElsewhere()) s = `detached HEAD (${def} checked out in another worktree)`;
    else if (!localDefaultSafe()) s = `detached HEAD (local ${def} diverged from ${base})`;
    else s = 'detached HEAD';
    return dirty ? `${s} with uncommitted changes` : s;
  };

  let recovered = false;
  if (cur !== def) {
    if (!cur && !dirty && isAncestor('HEAD', base) && !defaultElsewhere() && localDefaultSafe()) {
      if (git('checkout', '--quiet', def).status !== 0) return stuck(stuckState());
      recovered = true;
      cur = def;
    } else {
      return stuck(stuckState());
    }
  } else if (dirty) {
    return stuck(stuckState());
  }

  const local = git('rev-parse', '--verify', '--quiet', def).stdout.trim();
  if (!local) return withPruned(`${label}: skipped: local ${def} does not exist`, label, pruned);
  const remote = git('rev-parse', base).stdout.trim();
  if (local === remote) return withPruned(recovered ? `${label}: recovered: re-attached ${def} (already current)` : `${label}: already current`, label, pruned);
  if (!isAncestor(def, base)) return stuck(`diverged ${def}`);
  const before = git('rev-parse', '--short', def).stdout.trim();
  const merged = git('merge', '--ff-only', '--quiet', base);
  if (merged.status !== 0) return withPruned(`${label}: skipped: fast-forward failed: ${firstLine(merged.stderr || merged.stdout)}`, label, pruned);
  const after = git('rev-parse', '--short', def).stdout.trim();
  return withPruned(recovered ? `${label}: recovered: re-attached ${def}, synced ${before}..${after}` : `${label}: synced ${before}..${after}`, label, pruned);
}

const withPruned = (line: string, label: string, pruned: string[]): string => [...pruned.map((b) => `${label}: pruned ${b}`), line].join('\n');

/**
 * Delete local branches whose upstream is gone (the remote branch was deleted: its PR merged), never the checked-out branch and never
 * one a worktree still holds. Squash merges mean a merged branch is not an ancestor of the default branch, so the no-worktree guard
 * is the safety net.
 */
function pruneGoneBranches(dir: string): string[] {
  const git = (...args: string[]) => run('git', ['-C', dir, ...args]);
  const held = new Set(
    git('worktree', 'list', '--porcelain')
      .stdout.split(/\r?\n/)
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  const current = git('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.trim();
  const pruned: string[] = [];
  for (const line of git('for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads').stdout.split(/\r?\n/)) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    const branch = line.slice(0, i);
    if (line.slice(i + 1) !== '[gone]' || !branch || branch === current || held.has(branch)) continue;
    if (git('branch', '-D', '--', branch).status === 0) pruned.push(branch);
  }
  return pruned;
}

/** Sync every registered project, or the one named. */
export function syncProjects(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const projects = loadProjects(env).filter((p) => !name || p.name === name);
  if (name && !projects.length) throw new Error(`Unknown project "${name}"`);
  return projects.map((p) => syncProject(p));
}
