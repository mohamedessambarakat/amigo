import { existsSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DELIVERY_MODES, DEFAULT_BRANCH_PREFIX, DEFAULT_MODE, findProject, loadProjects, nameFromSource, saveProjects, validProjectName, type DeliveryMode, type Project } from './config.ts';
import { clonePath } from './paths.ts';
import { run } from './proc.ts';

export interface ProjectFields {
  name?: string;
  mode?: string;
  yolo?: boolean;
  branchPrefix?: string;
  /** A folder path; "" clears it. */
  live?: string;
  notes?: string;
  /** A list replaces the project's list; an empty list clears it. Left out, the old list stays. */
  checks?: string[];
  risky?: string[];
  liveCommands?: string[];
  watch?: string[];
}

/** How long one clone may take. */
const CLONE_TIMEOUT_MS = 30 * 60_000;

/** A local path as given to git clone is made absolute (the clone's origin must not depend on the caller's folder); a URL stays as it is. */
export function normalizeSource(source: string): string {
  const s = source.trim();
  if (!s) throw new Error('add needs a git URL or a folder to clone');
  if (isAbsolute(s) || existsSync(s)) return resolve(s);
  return s;
}

function checkMode(mode: string | undefined): DeliveryMode | undefined {
  if (mode === undefined) return undefined;
  if (!DELIVERY_MODES.includes(mode as DeliveryMode)) throw new Error(`--mode must be one of ${DELIVERY_MODES.join(', ')}`);
  return mode as DeliveryMode;
}

function checkLive(live: string | undefined): string | undefined {
  if (live === undefined || live === '') return live;
  const abs = resolve(live);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--live ${abs} is not a folder`);
  return abs;
}

const sameSource = (a: string, b: string): boolean => {
  const n = (s: string) => (isAbsolute(s) ? (process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s)) : s.replace(/\/+$/, ''));
  return n(a) === n(b);
};

/**
 * Register a project: clone `source` into projects/<name> and record it with its delivery posture (default no-mistakes, yolo
 * off, branch prefix amigo/). The same name and source again updates the fields given and keeps the rest, without cloning.
 * Never overwrites or repurposes an existing path; a registry write that fails after the clone removes the clone it just made.
 */
export function addProject(source: string, opts: ProjectFields, env: NodeJS.ProcessEnv = process.env): { project: Project; updated: boolean; cloned: boolean } {
  const src = normalizeSource(source);
  const name = opts.name ?? nameFromSource(src);
  if (!validProjectName(name)) throw new Error(`"${name}" is not a valid project name (letters, digits, . _ -); pick one with --name`);
  const mode = checkMode(opts.mode);
  const live = checkLive(opts.live);
  if (opts.branchPrefix !== undefined && /\s/.test(opts.branchPrefix)) throw new Error('--branch-prefix cannot contain spaces');
  const projects = loadProjects(env);
  const old = projects.find((p) => p.name === name);
  if (old && !sameSource(old.source, src)) throw new Error(`A project named "${name}" already exists, cloned from ${old.source}; pick another name with --name`);
  const dest = clonePath(name, env);
  let cloned = false;
  if (!old || !existsSync(dest)) {
    if (existsSync(dest)) throw new Error(`${dest} already exists and is not a registered project; amigo never overwrites a folder. Move it away, or pick another name with --name.`);
    const r = run('git', ['clone', '--quiet', src, dest], { timeoutMs: CLONE_TIMEOUT_MS });
    if (r.error || r.status !== 0) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      throw new Error(`git clone ${src} failed: ${(r.error?.message || r.stderr || r.stdout).trim()}`);
    }
    cloned = true;
  }
  const project: Project = {
    name,
    source: src,
    path: dest,
    mode: mode ?? old?.mode ?? DEFAULT_MODE,
    yolo: opts.yolo ?? old?.yolo ?? false,
    branchPrefix: opts.branchPrefix ?? old?.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
    addedAt: old?.addedAt ?? new Date().toISOString().slice(0, 10),
    ...(live === '' ? {} : (live ?? old?.live) ? { live: live ?? old?.live } : {}),
    ...((opts.notes ?? old?.notes) ? { notes: opts.notes ?? old?.notes } : {}),
    ...((opts.checks ?? old?.checks) ? { checks: opts.checks ?? old?.checks } : {}),
    ...((opts.risky ?? old?.risky) ? { risky: opts.risky ?? old?.risky } : {}),
    ...((opts.liveCommands ?? old?.liveCommands) ? { liveCommands: opts.liveCommands ?? old?.liveCommands } : {}),
    ...((opts.watch ?? old?.watch) ? { watch: opts.watch ?? old?.watch } : {}),
  };
  try {
    const next = saveProjects(old ? projects.map((p) => (p.name === name ? project : p)) : [...projects, project], env);
    return { project: findProject(next, name), updated: Boolean(old), cloned };
  } catch (err) {
    if (cloned) rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw err;
  }
}

/** The default branch of a clone: origin/HEAD, else a local main or master. Null when none is found. */
export function defaultBranch(dir: string): string | null {
  const ref = run('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).stdout.trim();
  if (ref) return ref.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (run('git', ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0) return b;
  return null;
}

/**
 * The branch a clone is tangled on: a named branch other than its default one. Null for every
 * healthy state: not a work tree, a detached HEAD, or the default branch.
 */
export function tangleBranch(dir: string): string | null {
  if (run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return null;
  const cur = run('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  if (!cur) return null;
  const def = defaultBranch(dir);
  if (!def || cur === def) return null;
  return cur;
}
