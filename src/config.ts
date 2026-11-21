import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { isGitRepo } from './git.ts';
import { configPath, home, projectsPath } from './paths.ts';
import { ensurePolicy } from './policy.ts';

/** How to start one agent CLI. Each is an argv array; `{prompt}` is replaced by the prompt text. */
export interface AgentTemplate {
  /** Interactive session that stays open for the user (the head). Optional: some agents can only be arms. */
  head?: string[];
  /** An arm. Claude Code runs it as an interactive session (any -p is dropped); other agents run one task and exit. */
  arm: string[];
}

export interface Config {
  agents: Record<string, AgentTemplate>;
  /** Agent used when --agent is not given. Defaults to the first one in `agents`. */
  defaultAgent?: string;
  /** Memory one arm needs, in MB. An arm starts only while free memory minus this stays at or above reserveMb. */
  armMb: number;
  /** Free memory, in MB, that must remain after an arm starts. */
  reserveMb: number;
  /** How long one project check may run, in minutes, before it counts as failed. */
  checkTimeoutMin: number;
}

export interface Project {
  name: string;
  path: string;
  /** Rules every arm working on this project must follow. */
  notes?: string;
  /** Shell commands run in an arm's folder when it says done; all must pass (see verify.ts). */
  checks?: string[];
  /** Globs for paths that make a change need the user's attention, on top of the built-in ones (see risk.ts). */
  risky?: string[];
  /** Was the folder a git repo when it was added? An arm working in a non-git folder can `git init` it and plant config there, so spawn refuses once this changes (see checkGitState). */
  wasGit?: boolean;
}

const STARTER_CONFIG: Config = { agents: {}, armMb: 600, reserveMb: 2048, checkTimeoutMin: 10 };

/** Create the home folder with an empty config and project list. Returns true on the first run. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): boolean {
  let created = false;
  mkdirSync(home(env), { recursive: true });
  if (!existsSync(configPath(env))) {
    writeJsonAtomic(configPath(env), STARTER_CONFIG);
    created = true;
  }
  if (!existsSync(projectsPath(env))) writeJsonAtomic(projectsPath(env), { projects: [] });
  ensurePolicy(env);
  return created;
}

function isArgv(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');
}

export function validateConfig(raw: unknown, where = 'config.json'): Config {
  const o = raw as Partial<Config> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${where}: must be a JSON object`);
  const agents = o.agents ?? {};
  if (typeof agents !== 'object' || Array.isArray(agents)) throw new Error(`${where}: "agents" must be an object`);
  for (const [name, t] of Object.entries(agents)) {
    for (const kind of ['head', 'arm'] as const) {
      const argv = (t as Partial<AgentTemplate> | null)?.[kind];
      if (kind === 'head' && argv === undefined) continue;
      if (!isArgv(argv)) throw new Error(`${where}: agents.${name}.${kind} must be a non-empty array of strings`);
      if (!argv.slice(1).some((a) => a.includes('{prompt}'))) throw new Error(`${where}: agents.${name}.${kind} needs a "{prompt}" argument`);
    }
  }
  const mb = (key: 'armMb' | 'reserveMb'): number => {
    const v = o[key] ?? STARTER_CONFIG[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${where}: "${key}" must be a number of MB, 0 or more`);
    return v;
  };
  const armMb = mb('armMb');
  const reserveMb = mb('reserveMb');
  const checkTimeoutMin = o.checkTimeoutMin ?? STARTER_CONFIG.checkTimeoutMin;
  if (typeof checkTimeoutMin !== 'number' || !(checkTimeoutMin > 0)) throw new Error(`${where}: "checkTimeoutMin" must be a number of minutes above 0`);
  if (o.defaultAgent !== undefined && !(o.defaultAgent in agents)) throw new Error(`${where}: defaultAgent "${o.defaultAgent}" is not in "agents"`);
  return { agents, armMb, reserveMb, checkTimeoutMin, ...(o.defaultAgent ? { defaultAgent: o.defaultAgent } : {}) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return validateConfig(readJson<unknown>(configPath(env), STARTER_CONFIG), configPath(env));
}

/** The agent to use: the one asked for, else defaultAgent, else the first configured. */
export function pickAgent(config: Config, wanted: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const names = Object.keys(config.agents);
  if (names.length === 0) throw new Error(`No agent configured yet. Add one to ${configPath(env)} (see "Configure your agent" in the README).`);
  const name = wanted ?? config.defaultAgent ?? (names[0] as string);
  if (!config.agents[name]) throw new Error(`Unknown agent "${name}". Configured: ${names.join(', ')}`);
  return name;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProjects(raw: unknown, where = 'projects.json'): Project[] {
  const list = (raw as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) throw new Error(`${where}: must look like {"projects": [...]}`);
  const seen = new Set<string>();
  return list.map((p: Partial<Project>, i) => {
    if (typeof p?.name !== 'string' || !NAME_RE.test(p.name)) throw new Error(`${where}: project #${i + 1} needs a "name" (letters, digits, . _ -)`);
    if (seen.has(p.name)) throw new Error(`${where}: project "${p.name}" is listed twice`);
    seen.add(p.name);
    if (typeof p.path !== 'string' || !isAbsolute(p.path)) throw new Error(`${where}: project "${p.name}" needs an absolute "path"`);
    if (p.notes !== undefined && typeof p.notes !== 'string') throw new Error(`${where}: project "${p.name}": "notes" must be text`);
    for (const key of ['checks', 'risky'] as const) {
      const v = p[key];
      if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== ''))) throw new Error(`${where}: project "${p.name}": "${key}" must be a list of non-empty strings`);
    }
    if (p.wasGit !== undefined && typeof p.wasGit !== 'boolean') throw new Error(`${where}: project "${p.name}": "wasGit" must be true or false`);
    return { name: p.name, path: p.path, ...(p.wasGit !== undefined ? { wasGit: p.wasGit } : {}), ...(p.notes ? { notes: p.notes } : {}), ...(p.checks?.length ? { checks: p.checks } : {}), ...(p.risky?.length ? { risky: p.risky } : {}) };
  });
}

export function loadProjects(env: NodeJS.ProcessEnv = process.env): Project[] {
  return validateProjects(readJson<unknown>(projectsPath(env), { projects: [] }), projectsPath(env));
}

export function findProject(projects: Project[], name: string): Project {
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown project "${name}". Known: ${projects.map((x) => x.name).join(', ') || '(none yet: octomaxxing add <path>)'}`);
  return p;
}

/** A project name from a folder name: "My App" -> "my-app". */
export function nameFromPath(path: string): string {
  const slug = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|-+$/g, '');
  return slug || 'project';
}

const samePlace = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export interface ProjectFields {
  name?: string;
  notes?: string;
  /** A list replaces the project's list; an empty list clears it. Left out, the old list stays. */
  checks?: string[];
  risky?: string[];
}

/** Register a folder. Adding a name that already points at this folder updates the fields given and keeps the rest. */
export function addProject(path: string, opts: ProjectFields, env: NodeJS.ProcessEnv = process.env): { project: Project; updated: boolean } {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder`);
  const projects = loadProjects(env);
  const name = opts.name ?? nameFromPath(abs);
  const old = projects.find((p) => p.name === name);
  if (old && !samePlace(old.path, abs)) throw new Error(`A project named "${name}" already exists for ${old.path}; pick another with --name`);
  const project: Project = {
    name,
    path: abs,
    notes: opts.notes ?? old?.notes,
    checks: opts.checks ?? old?.checks,
    risky: opts.risky ?? old?.risky,
    wasGit: isGitRepo(abs), // adding it again is the user vouching for the folder as it is now
  };
  const list = old ? projects.map((p) => (p.name === name ? project : p)) : [...projects, project];
  const next = validateProjects({ projects: list }, projectsPath(env));
  writeJsonAtomic(projectsPath(env), { projects: next });
  return { project: next.find((p) => p.name === name) as Project, updated: Boolean(old) };
}

/** Add a line to a project's notes (the hard rules every later arm gets). */
export function addNote(name: string, text: string, env: NodeJS.ProcessEnv = process.env): Project {
  const projects = loadProjects(env);
  const old = findProject(projects, name);
  if (!text.trim()) throw new Error('The note is empty');
  const project: Project = { ...old, notes: [old.notes?.trim(), text.trim()].filter(Boolean).join('\n') };
  writeJsonAtomic(projectsPath(env), { projects: projects.map((p) => (p.name === name ? project : p)) });
  return project;
}

/**
 * Refuse a project whose folder stopped being what it was when added: a non-git folder an arm turned into a repo (git init
 * plus config and .gitattributes) would run its filters as the head on the next `worktree add`. A project added before this
 * was recorded is taken as it is the first time it is checked (kept when `record` is set).
 */
export function checkGitState(project: Project, record: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const now = isGitRepo(project.path);
  if (project.wasGit === undefined) {
    if (record) writeJsonAtomic(projectsPath(env), { projects: loadProjects(env).map((p) => (p.name === project.name ? { ...p, wasGit: now } : p)) });
    return;
  }
  if (project.wasGit !== now) {
    throw new Error(`Project ${project.name} ${project.wasGit ? 'was a git repo' : 'was not a git repo'} when you added it, but ${project.path} ${now ? 'is one now' : 'no longer is'}. An arm may have changed it. Look at the folder yourself, then add it again (octomaxxing add ${project.path} --name ${project.name}) before spawning more arms.`);
  }
}
