import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sleepSync } from './fsx.ts';
import { run, runOrThrow, type RunOptions, type RunResult } from './proc.ts';

/** Do two paths name the same place (real paths, case-insensitive on Windows)? */
export const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => {
    let r = resolve(p);
    try {
      // native: on Windows it also expands 8.3 short names (C:\Users\RUNNER~1), which git records in full
      r = realpathSync.native(r);
    } catch {
      // a path that does not exist is compared as written
    }
    r = r.replaceAll('\\', '/');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
};

/**
 * A crew member controls its worktree, including the `.git` file in it. Pointing that file at a git dir the crew member made lets that
 * dir's config (core.fsmonitor, filter.*.clean, diff.external ...) run a program the moment amigo runs git there,
 * outside the crew member's sandbox. So before amigo runs git in a worktree, `.git` must be a regular file naming a git dir
 * that `git worktree add` made under the repo's own .git/worktrees, whose commondir leads back to the repo and which points
 * back at this worktree. Throws otherwise. A "worktree" that is the repo itself (a project without worktrees) is trusted.
 */
export function assertWorktreeIntact(repo: string, worktree: string, adminDir?: string): void {
  if (samePath(repo, worktree)) return;
  const bad = (why: string) => new Error(`worktree .git was changed; refusing to run git in it (${why}): ${worktree}`);
  const dotGit = join(worktree, '.git');
  let isFile = false;
  try {
    isFile = lstatSync(dotGit).isFile();
  } catch {
    throw bad('.git is missing');
  }
  if (!isFile) throw bad('.git is not a regular file');
  const named = /^gitdir: (.+)$/.exec(readFileSync(dotGit, 'utf8').trim());
  if (!named) throw bad('.git does not name a git dir');
  const gitdir = resolve(worktree, named[1] as string);
  const common = resolve(repo, runOrThrow('git', ['-C', repo, 'rev-parse', '--git-common-dir']).trim());
  if (!samePath(dirname(gitdir), join(common, 'worktrees'))) throw bad(`it points to ${gitdir}, not a worktree git dir of ${repo}`);
  if (adminDir && !samePath(gitdir, adminDir)) throw bad(`it points to ${gitdir}, not to the git dir recorded for this worktree`);
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(gitdir, name), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const commondir = read('commondir');
  if (commondir === null || !samePath(resolve(gitdir, commondir), common)) throw bad("its git dir does not belong to the task's repo");
  const back = read('gitdir');
  if (back === null || !samePath(back, dotGit)) throw bad('its git dir belongs to another worktree');
}

/** Options for every git call amigo makes inside a crew member's worktree: the file system monitor (a program named in config) stays off. */
const WORKTREE_GIT = ['-c', 'core.fsmonitor=false'];

/**
 * The git dir `git worktree add` made for a worktree, found from the repo's own records (each <common>/worktrees/<name>/gitdir
 * names the .git of its worktree). Never reads <worktree>/.git, which the crew member controls.
 */
export function findAdminDir(repo: string, worktree: string): string {
  const common = resolve(repo, runOrThrow('git', ['-C', repo, 'rev-parse', '--git-common-dir']).trim());
  const root = join(common, 'worktrees');
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // no worktrees at all: reported below
  }
  for (const name of names) {
    try {
      if (samePath(readFileSync(join(root, name, 'gitdir'), 'utf8').trim(), join(worktree, '.git'))) return join(root, name);
    } catch {
      // not a worktree record
    }
  }
  throw new Error(`${repo} has no git worktree record for ${worktree}`);
}

/**
 * The arguments for one git call in a crew member's worktree. The git dir is named outright (amigo's own record, else the
 * repo's), so git never reads <worktree>/.git: swapping that file between the guard and git cannot plant a config or filter.
 * A "worktree" that is the repo itself is trusted and found the usual way.
 */
export function worktreeGitArgs(repo: string, worktree: string, args: string[], adminDir?: string): string[] {
  if (samePath(repo, worktree)) return ['-C', worktree, ...WORKTREE_GIT, ...args];
  return ['-C', worktree, `--git-dir=${adminDir ?? findAdminDir(repo, worktree)}`, `--work-tree=${worktree}`, ...WORKTREE_GIT, ...args];
}

export interface WorktreeOptions extends RunOptions {
  /** The task's recorded git dir; found from the repo when missing (tasks made before it was recorded). */
  gitDir?: string;
}

/** Run git in a crew member's worktree, after assertWorktreeIntact (a tamper alarm). The one door for every git call there. */
export function worktreeRun(repo: string, worktree: string, args: string[], opts: WorktreeOptions = {}): RunResult {
  const { gitDir, ...runOpts } = opts;
  assertWorktreeIntact(repo, worktree, gitDir);
  return run('git', worktreeGitArgs(repo, worktree, args, gitDir), runOpts);
}

/** Like worktreeRun, but throws when git fails and returns stdout. */
export function worktreeGit(repo: string, worktree: string, args: string[], opts: WorktreeOptions = {}): string {
  const { gitDir, ...runOpts } = opts;
  assertWorktreeIntact(repo, worktree, gitDir);
  return runOrThrow('git', worktreeGitArgs(repo, worktree, args, gitDir), runOpts);
}

/**
 * File names that usually hold secrets: .env files (.env, .env.local, .env-prod, .env_local, .envrc; not .env.example and the
 * like), private keys, certificates and credential files. amigo never merges or lands work that adds or changes one (see
 * secretRefusal).
 */
export function looksSecret(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (/^\.env([._-].*|rc)?$/.test(name)) return !/[._-](example|sample|template|dist)$/.test(name);
  return /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/.test(name) || name === '.netrc';
}

/**
 * The refusal for work whose final files (`paths`) or any of whose commits (`history`) add or change secret-looking files, or
 * null when none does. Not a waivable check: --boss does not bypass it.
 */
export function secretRefusal(what: string, paths: string[], history: string[] = []): string | null {
  const now = [...new Set(paths.filter(looksSecret))];
  const past = [...new Set(history.filter(looksSecret))].filter((p) => !now.includes(p));
  if (!now.length && !past.length) return null;
  const found = [
    now.length ? `it adds or changes files that may hold secrets: ${now.join(', ')}` : '',
    past.length ? `its history contains files that may hold secrets, even where a later commit deletes them: ${past.join(', ')}` : '',
  ].filter(Boolean);
  return `refusing to land ${what}: ${found.join('; ')}. Have the crew member remove them from the branch, rewriting its commits when the history holds them (and rotate the secret if it was real), then merge again. This check is not waivable, not even with --boss; the Boss can still merge by hand on GitHub. Nothing was merged.`;
}

/** The kinds of change a build's branch can be named after: the commit types. */
export const BRANCH_TYPES: readonly string[] = ['feat', 'fix', 'refactor', 'docs', 'style', 'test', 'chore', 'perf', 'build', 'ci'];

const SLUG_MAX = 40;

/**
 * A branch named after its task: <type>/<the title in a few words>, as "fix/sidebar-alignment" for "Fix sidebar alignment"
 * (a title that starts with the type word drops it). A title with no latin letters or digits gives <type>/task.
 */
export function branchName(type: string, title: string): string {
  let words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 1 && words[0] === type) words = words.slice(1);
  let slug = (words[0] ?? '').slice(0, SLUG_MAX);
  for (const w of words.slice(1)) {
    if (slug.length + 1 + w.length > SLUG_MAX) break;
    slug += `-${w}`;
  }
  return `${type}/${slug || 'task'}`;
}

/** The branch names `repo` already has: local, origin's as it is now (ls-remote), and the tracking refs from its last fetch. */
function branchNames(repo: string): Set<string> {
  const names = new Set<string>();
  // origin is asked directly because the tracking refs can be stale; if it cannot be reached, the tracking refs are all there is.
  const remote = run('git', ['-C', repo, 'ls-remote', '--heads', 'origin'], { timeoutMs: 60_000 });
  for (const line of remote.status === 0 ? remote.stdout.split(/\r?\n/) : []) {
    const ref = line.split('\t')[1];
    if (ref?.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length));
  }
  const local = run('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']).stdout;
  for (const ref of local.split(/\r?\n/)) {
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') names.add(ref.slice('refs/remotes/origin/'.length));
  }
  return names;
}

/**
 * `name`, else name-2, name-3...: the first that no branch of `repo` (local or origin's) and nothing in `taken` holds. Git
 * cannot keep a/b beside a or a/b/c, so a name also counts as taken when an existing one is a folder of it or inside it.
 */
export function freeBranch(repo: string, name: string, taken: ReadonlySet<string>): string {
  const names = new Set([...branchNames(repo), ...taken]);
  const type = name.split('/')[0] as string;
  if (names.has(type)) throw new Error(`${repo} has a branch named "${type}", so git cannot make ${name} beside it. Rename or delete that branch, or pick another --type.`);
  const used = (b: string) => [...names].some((n) => n === b || b.startsWith(`${n}/`) || n.startsWith(`${b}/`));
  for (let i = 1; i <= 100; i++) {
    const b = i === 1 ? name : `${name}-${i}`;
    if (!used(b)) return b;
  }
  throw new Error(`Branches ${name} to ${name}-100 are all taken in ${repo}; give the task a more specific title`);
}

/** A branch amigo made for a task: <type>/..., survey/..., or amigo/... from before branches were named after their task. */
const TASK_BRANCH_RE = new RegExp(`^refs/heads/(${[...BRANCH_TYPES, 'survey', 'amigo'].join('|')})/`);

export function isGitRepo(path: string): boolean {
  const r = run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** Changed, new and deleted files (git status --porcelain), every untracked file listed. */
export function changedFiles(repo: string, cwd: string, gitDir?: string): string[] {
  return worktreeGit(repo, cwd, ['status', '--porcelain', '--untracked-files=all'], { gitDir })
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
}

function listWorktrees(repo: string): string[] {
  return runOrThrow('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** Remove a worktree (the branch stays). Retries because a just-stopped process can still hold files on Windows. */
export function removeWorktree(repo: string, worktree: string): void {
  if (!existsSync(worktree)) {
    run('git', ['-C', repo, 'worktree', 'prune']);
    return;
  }
  try {
    assertWorktreeIntact(repo, worktree);
  } catch {
    // A tampered .git makes `git worktree remove` fail its own validation: delete the folder and let the repo forget it.
    // Nothing runs git inside the worktree (rmSync does not follow links).
    rmSync(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    run('git', ['-C', repo, 'worktree', 'prune']);
    return;
  }
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
    if (r.status === 0) return;
    last = (r.stderr || r.stdout).trim();
    // git can drop its metadata and then fail to delete the folder: finish the delete ourselves.
    if (!listWorktrees(repo).some((p) => samePath(p, worktree))) {
      run('git', ['-C', repo, 'worktree', 'prune']);
      rmSync(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      return;
    }
    sleepSync(400);
  }
  throw new Error(`git worktree remove failed: ${last}`);
}

/** Delete a branch only if nothing was committed on it since it was created. */
export function deleteBranchIfUnused(repo: string, branch: string, baseSha: string | null): boolean {
  if (!baseSha) return false;
  const tip = run('git', ['-C', repo, 'rev-parse', '--verify', branch]);
  if (tip.status !== 0 || tip.stdout.trim() !== baseSha) return false;
  return run('git', ['-C', repo, 'branch', '-D', branch]).status === 0;
}

/** The full sha a branch points at, or null when it does not exist. */
export function branchSha(repo: string, branch: string): string | null {
  const r = run('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function commitRefExists(repo: string, ref: string): boolean {
  return run('git', ['-C', repo, 'rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0;
}

/** Origin's default branch ref (origin/HEAD, else origin/main or origin/master), or null when none exists. */
function originDefaultRef(repo: string): string | null {
  const head = run('git', ['-C', repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).stdout.trim();
  return [head, 'refs/remotes/origin/main', 'refs/remotes/origin/master'].find((r) => r && commitRefExists(repo, r)) ?? null;
}

/**
 * Refs for the repo's default branch (local and on origin) that exist as commits, never including `selfBranch`.
 * Checks origin/HEAD (and its local counterpart), then main/master on origin and locally, falling back to the
 * repo's current HEAD branch (and its origin counterpart) when none of those exist.
 */
function defaultBranchRefs(repo: string, selfBranch?: string): string[] {
  const selfRef = selfBranch ? `refs/heads/${selfBranch}` : '';
  const refs: string[] = [];
  const add = (ref: string | null) => {
    if (ref && ref !== selfRef && !refs.includes(ref) && commitRefExists(repo, ref)) refs.push(ref);
  };
  const origin = originDefaultRef(repo);
  if (origin) {
    add(origin);
    if (origin.startsWith('refs/remotes/origin/')) add(`refs/heads/${origin.slice('refs/remotes/origin/'.length)}`);
  }
  if (!refs.some((r) => r.startsWith('refs/heads/'))) {
    for (const name of ['main', 'master']) {
      if (commitRefExists(repo, `refs/heads/${name}`)) {
        add(`refs/heads/${name}`);
        break;
      }
    }
  }
  if (!refs.length) {
    const localHead = run('git', ['-C', repo, 'symbolic-ref', '-q', 'HEAD']).stdout.trim();
    if (localHead && localHead !== selfRef && !TASK_BRANCH_RE.test(localHead)) {
      add(localHead);
      if (localHead.startsWith('refs/heads/')) add(`refs/remotes/origin/${localHead.slice('refs/heads/'.length)}`);
    }
  }
  return refs;
}

/** Rev-list arguments for a task branch: commits on `branch` excluding `baseSha` and the repo's local/origin default branch. */
function taskCommitArgs(repo: string, branch: string, baseSha: string): string[] {
  const excluded = [baseSha, ...defaultBranchRefs(repo, branch)].map((ref) => `^${ref}`);
  return [`refs/heads/${branch}`, ...excluded];
}

/** How many non-merge commits a branch has on top of `baseSha` and the repo's default branch. */
export function commitsAhead(repo: string, branch: string, baseSha: string): number {
  return Number(runOrThrow('git', ['-C', repo, 'rev-list', '--count', '--no-merges', ...taskCommitArgs(repo, branch, baseSha), '--']).trim());
}

export function deleteBranch(repo: string, branch: string): void {
  runOrThrow('git', ['-C', repo, 'branch', '-D', branch]);
}
