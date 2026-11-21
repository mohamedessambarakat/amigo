import { rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { looksSecret, worktreeGit } from './git.ts';

/** One file an arm changed, measured against the commit its worktree started from. */
export interface Change {
  path: string;
  added: number;
  removed: number;
  deleted: boolean;
  /** A binary file, a submodule or a file mode change: its size says nothing, so it is never small. */
  opaque?: boolean;
}

export type RiskLevel = 'small' | 'non-trivial' | 'needs-you';

export interface Risk {
  level: RiskLevel;
  files: number;
  lines: number;
  deleted: string[];
  /** Changed paths that match a risky glob, with the reason. */
  risky: { path: string; why: string }[];
  reasons: string[];
}

/** Small means at most this many files and lines, and no deletions. */
export const SMALL_FILES = 3;
export const SMALL_LINES = 100;

/**
 * Paths where a mistake costs the most. A glob without a "/" matches a file or folder name anywhere in the path; with a
 * "/" it matches from the repo root. "*" stays inside one name, "**" crosses folders. Case does not matter.
 */
const DEFAULT_RISKY: [why: string, globs: string[]][] = [
  ['auth', ['auth', 'auth.*', 'auth-*', 'auth_*', '*auth.*', 'authn*', 'authz*', 'authentication*', 'authorization*']],
  ['payments', ['payment*', 'billing*', 'checkout*', 'stripe*']],
  ['database migration', ['migration', 'migrations', 'migrate', 'schema.prisma', 'alembic', 'flyway']],
  ['deploy or CI config', ['.github/workflows/**', '.gitlab-ci.yml', '.circleci', 'jenkinsfile', 'dockerfile*', 'docker-compose*', 'vercel.json', 'netlify.toml', 'fly.toml', 'wrangler.toml', 'procfile', '*.tf', 'terraform', 'k8s', 'kubernetes', 'deploy', 'deployment', 'prod', 'production']],
  ['public API surface', ['api', 'routes', 'openapi*', 'swagger*', '*.proto']],
  [
    'dependency manifest or lockfile',
    ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock*', 'requirements*.txt', 'pyproject.toml', 'poetry.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile*', 'composer.*', '.npmrc', '.yarnrc*'],
  ],
  ['production config', ['**/config/production*', '*.prod.*']],
  ['git hooks or tooling', ['.husky', '.githooks', '.git-hooks', 'lefthook*', '.pre-commit-config.yaml']],
  ['build, test or lint config the checks run', ['makefile', 'justfile', 'scripts', 'jest.config*', 'vitest.config*', 'playwright.config*', 'karma.conf*', 'eslint.config*', '.eslintrc*', 'tsconfig*.json', '.prettierrc*', 'biome.json*']],
  ['auth-related code', ['*session*', '*jwt*', '*token*', '*oauth*', '*login*', '*permission*', '*middleware*']],
];

const normalize = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

function globToRegex(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*')
    .replace(/\.\*\//g, '(?:.*/)?');
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Does the glob match the path, or a folder the path is inside? */
export function globMatches(glob: string, path: string): boolean {
  const g = normalize(glob).replace(/^\.?\/+|\/+$/g, '');
  const p = normalize(path);
  if (!g) return false;
  if (!g.includes('/')) return p.split('/').some((segment) => globToRegex(g).test(segment));
  return globToRegex(g).test(p);
}

/** Why a path is risky ("auth", "secret file", a project glob), or null. */
export function riskyReason(path: string, extra: string[] = []): string | null {
  if (looksSecret(path)) return 'secret or credential file';
  for (const [why, globs] of DEFAULT_RISKY) if (globs.some((g) => globMatches(g, path))) return why;
  const mine = extra.find((g) => globMatches(g, path));
  return mine ? `project risky path ${mine}` : null;
}

/** Size, deletions and risky paths of a set of changes. */
export function assessChanges(changes: Change[], extraRisky: string[] = []): Risk {
  const lines = changes.reduce((n, c) => n + c.added + c.removed, 0);
  const deleted = changes.filter((c) => c.deleted).map((c) => c.path);
  const risky = changes.flatMap((c) => {
    const why = riskyReason(c.path, extraRisky);
    return why ? [{ path: c.path, why }] : [];
  });
  const opaque = changes.filter((c) => c.opaque).map((c) => c.path);
  const reasons: string[] = [];
  if (risky.length) reasons.push(...risky.map((r) => `touches ${r.path} (${r.why})`));
  if (deleted.length) reasons.push(`deletes ${deleted.length} file${deleted.length === 1 ? '' : 's'}: ${deleted.slice(0, 5).join(', ')}${deleted.length > 5 ? ', ...' : ''}`);
  if (opaque.length) reasons.push(`changes a binary file, submodule or file mode, whose size cannot be measured: ${opaque.slice(0, 5).join(', ')}${opaque.length > 5 ? ', ...' : ''}`);
  const sizeOk = changes.length <= SMALL_FILES && lines <= SMALL_LINES;
  const small = sizeOk && !opaque.length;
  if (!sizeOk) reasons.push(`${changes.length} files and ${lines} lines changed (small is at most ${SMALL_FILES} files and ${SMALL_LINES} lines)`);
  const level: RiskLevel = risky.length || deleted.length ? 'needs-you' : small ? 'small' : 'non-trivial';
  if (level === 'small') reasons.push(`${changes.length} file${changes.length === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'}, no risky paths, no deletions`);
  return { level, files: changes.length, lines, deleted, risky, reasons };
}

export interface Snapshot {
  changes: Change[];
  /** The git tree of the whole working folder: equal trees mean identical work, whatever happened in between. */
  tree: string;
}

/**
 * What an arm's folder holds now compared with the commit it started from, committed or not, untracked files included
 * (what `close --commit` would commit). Done in a throw-away index, so the arm's own index is never touched.
 */
export function snapshot(repo: string, cwd: string, baseSha: string, gitDir?: string): Snapshot {
  const index = join(os.tmpdir(), `octomaxxing-index-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const git = (...args: string[]) => worktreeGit(repo, cwd, args, { env: { GIT_INDEX_FILE: index }, gitDir });
  try {
    git('read-tree', baseSha);
    git('add', '-A');
    const numstat = git('diff', '--cached', '--no-renames', '--numstat', '-z', baseSha).split('\0').filter(Boolean);
    // --raw -z gives ":<old mode> <new mode> <old sha> <new sha> <status>" and the path, as two entries.
    const raw = git('diff', '--cached', '--no-renames', '--raw', '-z', baseSha).split('\0').filter(Boolean);
    const kind = new Map<string, { deleted: boolean; odd: boolean }>();
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:(\d+) (\d+) \S+ \S+ (\w)/.exec(raw[i] as string);
      if (!m) continue;
      const [, from = '', to = '', status = ''] = m;
      kind.set(raw[i + 1] as string, { deleted: status === 'D', odd: from === '160000' || to === '160000' || (Number(from) !== 0 && Number(to) !== 0 && from !== to) });
    }
    const changes = numstat.map((entry): Change => {
      const [added = '0', removed = '0', ...rest] = entry.split('\t');
      const path = rest.join('\t');
      const k = kind.get(path);
      return { path, added: Number(added) || 0, removed: Number(removed) || 0, deleted: k?.deleted ?? false, opaque: added === '-' || (k?.odd ?? false) };
    });
    return { changes, tree: git('write-tree').trim() };
  } finally {
    rmSync(index, { force: true });
  }
}

/** Files that steer agents: a doc-looking change to them is never "only docs". */
const AGENT_INSTRUCTION_GLOBS = ['CLAUDE.md', 'AGENTS.md', 'SKILL.md', 'prompts', '.claude', '.github'];

const isTestPath = (path: string): boolean => normalize(path).split('/').some((s) => /^(tests?|__tests__|specs?)$/.test(s) || /.(test|spec)./.test(s));

/**
 * Is every changed path a doc or a test, by the policy's globs, none an agent instruction file, and no test file losing an
 * existing line (a weakened test is not "only tests")? An empty change counts.
 */
export function docsOrTestsOnly(changes: Change[], globs: string[]): boolean {
  return changes.every((c) => globs.some((g) => globMatches(g, c.path)) && !AGENT_INSTRUCTION_GLOBS.some((g) => globMatches(g, c.path)) && !(c.removed > 0 && isTestPath(c.path)));
}

export function describeRisk(r: Risk): string {
  return `${r.level} - ${r.reasons.join('; ')}`;
}
