import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { clonePath, configDir, configPath, dataDir, home, OLD_LAYOUT_FILES, projectsDir, projectsPath, stateDir } from './paths.ts';

/** How to start one agent CLI. Each is an argv array; `{prompt}` is replaced by the prompt text. */
export interface AgentTemplate {
  /** Interactive session that stays open for the user (amigo). Optional: some agents can only be crew members. */
  amigo?: string[];
  /** A crew member. Claude Code runs it as an interactive session (any -p is dropped); other agents run one task and exit. */
  member: string[];
}

export interface Config {
  agents: Record<string, AgentTemplate>;
  /** Agent used when --agent is not given. Defaults to the first one in `agents`. */
  defaultAgent?: string;
  /** Memory one crew member needs, in MB. A crew member starts only while free memory minus this stays at or above reserveMb. */
  memberMb: number;
  /** Free memory, in MB, that must remain after a crew member starts. */
  reserveMb: number;
}

/** How a project's work is delivered. */
export type DeliveryMode = 'no-mistakes' | 'direct-PR' | 'local-only';
export const DELIVERY_MODES: readonly DeliveryMode[] = ['no-mistakes', 'direct-PR', 'local-only'];
/** What an unregistered project, or a registry entry without one, resolves to. */
export const DEFAULT_MODE: DeliveryMode = 'no-mistakes';
export const DEFAULT_BRANCH_PREFIX = 'amigo/';

/**
 * One registered project. amigo works on its own clone in projects/<name> (`path`, derived, never stored), made from `source`
 * by `amigo add`. The registry records the Boss's standing delivery posture: `mode`, `yolo` (merge authority only: amigo may
 * merge green, in-scope work itself) and the build branch prefix.
 */
export interface Project {
  name: string;
  /** What the clone was made from: a URL or a local path, as given to git clone. */
  source: string;
  /** amigo's clone: projects/<name> under the home. Read-only to amigo except through the guarded sync (see sync.ts). */
  path: string;
  mode: DeliveryMode;
  yolo: boolean;
  /** Build branches are named <branchPrefix><task id>. "" gives a bare task id. */
  branchPrefix: string;
  /** A live install of this project (a folder the Boss runs it from), fast-forwarded after a confirmed merge. */
  live?: string;
  addedAt?: string;
  /** Rules every crew member working on this project must follow. */
  notes?: string;
  /** Shell commands the startup briefing runs in the clone (see briefing.ts). Not gates. Left out: the defaults for a GitHub repo; an empty list: none. */
  liveCommands?: string[];
  /** Plain-words things a crew member looks at for the startup briefing. Not gates. */
  watch?: string[];
}

const STARTER_CONFIG: Config = { agents: {}, memberMb: 600, reserveMb: 2048 };

/** True when the home still has the layout from before projects became clones (config.json and projects.json at its top). */
export function oldLayout(env: NodeJS.ProcessEnv = process.env): boolean {
  return OLD_LAYOUT_FILES.some((f) => existsSync(join(home(env), f)));
}

/** Refuse to work on a home in the old layout: `amigo migrate` converts it first. */
export function requireNewLayout(env: NodeJS.ProcessEnv = process.env): void {
  if (oldLayout(env)) throw new Error(`${home(env)} still has the layout from before this version (config.json and projects.json at its top). Run: amigo migrate --dry-run, then amigo migrate.`);
}

/** Create the home's folders with an empty config and project registry. Returns true on the first run. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): boolean {
  requireNewLayout(env);
  let created = false;
  for (const dir of [configDir(env), dataDir(env), stateDir(env), projectsDir(env)]) mkdirSync(dir, { recursive: true });
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
    for (const kind of ['amigo', 'member'] as const) {
      const argv = (t as Partial<AgentTemplate> | null)?.[kind];
      if (kind === 'amigo' && argv === undefined) continue;
      if (!isArgv(argv)) throw new Error(`${where}: agents.${name}.${kind} must be a non-empty array of strings`);
      if (!argv.slice(1).some((a) => a.includes('{prompt}'))) throw new Error(`${where}: agents.${name}.${kind} needs a "{prompt}" argument`);
    }
  }
  const mb = (key: 'memberMb' | 'reserveMb'): number => {
    const v = o[key] ?? STARTER_CONFIG[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${where}: "${key}" must be a number of MB, 0 or more`);
    return v;
  };
  const memberMb = mb('memberMb');
  const reserveMb = mb('reserveMb');
  if (o.defaultAgent !== undefined && !(o.defaultAgent in agents)) throw new Error(`${where}: defaultAgent "${o.defaultAgent}" is not in "agents"`);
  return { agents, memberMb, reserveMb, ...(o.defaultAgent ? { defaultAgent: o.defaultAgent } : {}) };
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

export function validProjectName(name: string): boolean {
  return NAME_RE.test(name);
}

const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** The registry as stored: every field but the derived `path`. */
export type StoredProject = Omit<Project, 'path'>;

export function validateProjects(raw: unknown, where = 'projects.json', env: NodeJS.ProcessEnv = process.env): Project[] {
  const list = (raw as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) throw new Error(`${where}: must look like {"projects": [...]}`);
  const seen = new Set<string>();
  return list.map((p: Partial<Project> & Record<string, unknown>, i) => {
    if (typeof p?.name !== 'string' || !NAME_RE.test(p.name)) throw new Error(`${where}: project #${i + 1} needs a "name" (letters, digits, . _ -)`);
    const bad = (what: string) => new Error(`${where}: project "${p.name}": ${what}`);
    if (seen.has(p.name)) throw new Error(`${where}: project "${p.name}" is listed twice`);
    seen.add(p.name);
    if (typeof p.source !== 'string' || !p.source.trim()) throw bad('needs a "source" (the URL or path its clone was made from)');
    const mode = p.mode ?? DEFAULT_MODE;
    if (!DELIVERY_MODES.includes(mode)) throw bad(`"mode" must be one of ${DELIVERY_MODES.join(', ')}`);
    if (p.yolo !== undefined && typeof p.yolo !== 'boolean') throw bad('"yolo" must be true or false');
    const branchPrefix = p.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    if (typeof branchPrefix !== 'string' || /\s/.test(branchPrefix)) throw bad('"branchPrefix" must be text without spaces');
    if (p.live !== undefined && (typeof p.live !== 'string' || !isAbsolute(p.live))) throw bad('"live" must be an absolute folder path');
    if (p.notes !== undefined && typeof p.notes !== 'string') throw bad('"notes" must be text');
    if (p.addedAt !== undefined && typeof p.addedAt !== 'string') throw bad('"addedAt" must be text');
    // checks and risky (the per-project gates before the delivery modes) are no longer read: an old entry keeps working without them.
    for (const key of ['liveCommands', 'watch'] as const) {
      if (p[key] !== undefined && !isTextList(p[key])) throw bad(`"${key}" must be a list of non-empty strings`);
    }
    return {
      name: p.name,
      source: p.source,
      path: clonePath(p.name, env),
      mode,
      yolo: p.yolo ?? false,
      branchPrefix,
      ...(p.live ? { live: p.live } : {}),
      ...(p.addedAt ? { addedAt: p.addedAt } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.liveCommands ? { liveCommands: p.liveCommands } : {}),
      ...(p.watch?.length ? { watch: p.watch } : {}),
    };
  });
}

export function loadProjects(env: NodeJS.ProcessEnv = process.env): Project[] {
  return validateProjects(readJson<unknown>(projectsPath(env), { projects: [] }), projectsPath(env), env);
}

/** Write the registry (validated first). `path` is derived, so it is never stored. */
export function saveProjects(projects: Project[], env: NodeJS.ProcessEnv = process.env): Project[] {
  const stored: StoredProject[] = projects.map(({ path: _path, ...rest }) => rest);
  const next = validateProjects({ projects: stored }, projectsPath(env), env);
  writeJsonAtomic(projectsPath(env), { projects: next.map(({ path: _path, ...rest }) => rest) });
  return next;
}

export function findProject(projects: Project[], name: string): Project {
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown project "${name}". Known: ${projects.map((x) => x.name).join(', ') || '(none yet: amigo add <git url or path>)'}`);
  return p;
}

/** A project name from a clone source: "https://github.com/me/My App.git" -> "my-app". */
export function nameFromSource(source: string): string {
  const last = source.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '';
  const slug = last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|-+$/g, '');
  return slug || 'project';
}

/** A registered project's delivery posture, or the default for an unregistered one (`warning` says so). */
export function projectPosture(name: string, env: NodeJS.ProcessEnv = process.env): { mode: DeliveryMode; yolo: boolean; branchPrefix: string; warning?: string } {
  const p = loadProjects(env).find((x) => x.name === name);
  if (!p) return { mode: DEFAULT_MODE, yolo: false, branchPrefix: DEFAULT_BRANCH_PREFIX, warning: `project "${name}" is not registered; defaulting to ${DEFAULT_MODE}, yolo off` };
  return { mode: p.mode, yolo: p.yolo, branchPrefix: p.branchPrefix };
}

/** Add a line to a project's notes (the hard rules every later crew member gets). */
export function addNote(name: string, text: string, env: NodeJS.ProcessEnv = process.env): Project {
  const projects = loadProjects(env);
  const old = findProject(projects, name);
  if (!text.trim()) throw new Error('The note is empty');
  const project: Project = { ...old, notes: [old.notes?.trim(), text.trim()].filter(Boolean).join('\n') };
  return findProject(saveProjects(projects.map((p) => (p.name === name ? project : p)), env), name);
}
