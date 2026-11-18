import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleepSync } from './fsx.ts';
import { run, runOrThrow } from './proc.ts';

export const branchName = (id: string): string => `octomaxxing/${id}`;

export function isGitRepo(path: string): boolean {
  const r = run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** New worktree on a new branch, starting from the repo's current HEAD. Returns the commit it starts from. */
export function createWorktree(repo: string, worktree: string, branch: string): string {
  const head = run('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) throw new Error(`${repo} has no commits yet, so octomaxxing cannot create a worktree for it`);
  runOrThrow('git', ['-C', repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']);
  return head.stdout.trim();
}

/** Changed, new and deleted files (git status --porcelain), every untracked file listed. */
export function changedFiles(cwd: string): string[] {
  return runOrThrow('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
}

/** The path in a `git status --porcelain` line (the new name for a rename), without quotes. */
export const porcelainPath = (line: string): string => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');

/** File names that usually hold secrets: .env files (not .env.example and the like), private keys, certificates and credential files. */
export function looksSecret(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name);
  return /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/.test(name) || name === '.netrc';
}

/**
 * Commit everything in the worktree to `branch`. Returns the short sha, or null when there was nothing to commit.
 * Refuses when the worktree is no longer on that branch (the agent switched or detached it), so nothing lands where nobody looks,
 * and when a changed file looks like it holds secrets (looksSecret).
 */
export function commitAll(worktree: string, branch: string, message: string): string | null {
  const head = run('git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD']).stdout.trim();
  if (head !== `refs/heads/${branch}`) throw new Error(`The worktree is on ${head || 'a detached HEAD'}, not ${branch}. Check it by hand: ${worktree}`);
  const changes = changedFiles(worktree);
  if (changes.length === 0) return null;
  const secrets = changes.map(porcelainPath).filter(looksSecret);
  if (secrets.length) throw new Error(`Refusing to commit files that may hold secrets: ${secrets.join(', ')}. Delete them or add them to .gitignore, then close again.`);
  runOrThrow('git', ['-C', worktree, 'add', '-A']);
  // A machine without a full git identity cannot commit: fill in only the missing part.
  const has = (key: string) => run('git', ['-C', worktree, 'config', key]).stdout.trim() !== '';
  const identity = [...(has('user.name') ? [] : ['-c', 'user.name=octomaxxing']), ...(has('user.email') ? [] : ['-c', 'user.email=octomaxxing@localhost'])];
  runOrThrow('git', ['-C', worktree, ...identity, 'commit', '-q', '-m', message]);
  return runOrThrow('git', ['-C', worktree, 'rev-parse', '--short', 'HEAD']).trim();
}

export function committedFiles(worktree: string, sha: string): string[] {
  return runOrThrow('git', ['-C', worktree, 'show', '--name-only', '--format=', sha])
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
}

const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => resolve(p).replaceAll('\\', '/').toLowerCase();
  return n(a) === n(b);
};

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
