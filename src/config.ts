import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { configPath, home, projectsPath } from './paths.ts';

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
  /** Where arms run: background (default, no window), or a visible tab in warp, wt, terminal or tmux. */
  terminal?: string;
}

export interface Project {
  name: string;
  path: string;
  /** Rules every arm working on this project must follow. */
  notes?: string;
}

const STARTER_CONFIG: Config = { agents: {}, armMb: 600, reserveMb: 2048 };

/** Create the home folder with an empty config and project list. Returns true on the first run. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): boolean {
  let created = false;
  mkdirSync(home(env), { recursive: true });
  if (!existsSync(configPath(env))) {
    writeJsonAtomic(configPath(env), STARTER_CONFIG);
    created = true;
  }
  if (!existsSync(projectsPath(env))) writeJsonAtomic(projectsPath(env), { projects: [] });
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
  if (o.terminal !== undefined && !['background', 'warp', 'wt', 'terminal', 'tmux'].includes(o.terminal)) throw new Error(`${where}: "terminal" must be background, warp, wt, terminal or tmux`);
  if (o.defaultAgent !== undefined && !(o.defaultAgent in agents)) throw new Error(`${where}: defaultAgent "${o.defaultAgent}" is not in "agents"`);
  return { agents, armMb, reserveMb, ...(o.terminal ? { terminal: o.terminal } : {}), ...(o.defaultAgent ? { defaultAgent: o.defaultAgent } : {}) };
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
    return { name: p.name, path: p.path, ...(p.notes ? { notes: p.notes } : {}) };
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

export function addProject(path: string, opts: { name?: string; notes?: string }, env: NodeJS.ProcessEnv = process.env): Project {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder`);
  const projects = loadProjects(env);
  const project: Project = { name: opts.name ?? nameFromPath(abs), path: abs, ...(opts.notes ? { notes: opts.notes } : {}) };
  if (projects.some((p) => p.name === project.name)) throw new Error(`A project named "${project.name}" already exists; pick another with --name`);
  const next = validateProjects({ projects: [...projects, project] }, projectsPath(env));
  writeJsonAtomic(projectsPath(env), { projects: next });
  return project;
}
