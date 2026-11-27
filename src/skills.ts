import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutable } from './command.ts';
import { loadConfig } from './config.ts';
import { writeJsonAtomic } from './fsx.ts';
import { codeRoot, configPath } from './paths.ts';
import { TEMPLATES } from './templates.ts';
import { installT3Hooks, removeT3Hooks, t3Installed, userSettingsPath } from './t3-lead.ts';

/** Marks files amigo wrote, so --remove never deletes anything else. */
export const MARKER = 'installed by amigo';

const DESCRIPTION = "Reload amigo's instructions in a session started with the amigo command (it hands tasks to the crew: parallel worker agents). Use only when the user runs /amigo.";

const skillMd = (body: string): string => `---\nname: amigo\ndescription: ${DESCRIPTION}\n---\n\n<!-- ${MARKER} -->\n\n${body}\n`;

const runLine = (agent: string): string => `Run this shell command and follow the instructions it prints, exactly:\n\n    amigo brief --agent ${agent}`;

interface SkillTarget {
  /** Agent name in TEMPLATES and config.json. */
  agent: string;
  /** What the user types in that CLI. */
  invoke: string;
  file: (userHome: string) => string;
  content: () => string;
}

/**
 * amigo runs as the lead only on Claude Code (its Stop hook arms the watcher and the turn-end guard), so /amigo exists only
 * there. Other agent CLIs are crew-member templates: install-skill adds their template and writes no slash command.
 */
export const TARGETS: SkillTarget[] = [
  { agent: 'claude', invoke: '/amigo', file: (h) => join(h, '.claude', 'skills', 'amigo', 'SKILL.md'), content: () => skillMd(runLine('claude')) },
];

/** Slash commands older versions wrote for other agent CLIs: removed by --remove, never written again. */
const LEGACY_FILES = (h: string): string[] => [
  join(h, '.agents', 'skills', 'amigo', 'SKILL.md'),
  join(h, '.gemini', 'commands', 'amigo.toml'),
  join(h, '.gemini', 'config', 'skills', 'amigo', 'SKILL.md'),
];

const commandOf = (agent: string): string => TEMPLATES[agent]?.member[0] ?? agent;

/** The known agents to set up: one named, or every one found on PATH. */
export function agentsFor(agent: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (agent) {
    if (!TEMPLATES[agent]) throw new Error(`No built-in template for "${agent}". Known: ${Object.keys(TEMPLATES).join(', ')} (add others to config.json by hand)`);
    return [agent];
  }
  return Object.keys(TEMPLATES).filter((a) => resolveExecutable(commandOf(a), env) !== null);
}

const ours = (file: string): boolean => existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);

/**
 * The Boss's own slash commands inside an amigo session (/catchup, /rundown, /remember, /updateamigo, /afk, /quiet), from
 * skills/user/<name>/SKILL.md. amigo itself runs only on Claude Code, so only Claude Code gets them, in ~/.claude/skills/<name>/.
 */
export const userSkillsDir = (root: string = codeRoot): string => join(root, 'skills', 'user');
export const USER_SKILLS: readonly string[] = ['catchup', 'rundown', 'remember', 'updateamigo', 'afk', 'quiet'];
const userSkillFile = (userHome: string, name: string): string => join(userHome, '.claude', 'skills', name, 'SKILL.md');

/** A user skill's text with amigo's marker after its front matter. */
export function userSkillContent(name: string, root: string = codeRoot): string {
  const src = readFileSync(join(userSkillsDir(root), name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const end = src.indexOf('\n---\n', 4);
  if (!src.startsWith('---\n') || end < 0) throw new Error(`skills/user/${name}/SKILL.md has no front matter`);
  return `${src.slice(0, end + 5)}\n<!-- ${MARKER} -->\n${src.slice(end + 5)}`;
}

/** Write the user skills. A file of the same name that amigo did not write is left alone and reported. */
function installUserSkills(userHome: string): string[] {
  return USER_SKILLS.map((name) => {
    const file = userSkillFile(userHome, name);
    if (existsSync(file) && !ours(file)) return `claude: skipped /${name}: ${file} exists and was not written by amigo; move it away and run install-skill again`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, userSkillContent(name));
    return `claude: wrote ${file} (type /${name} in an amigo session)`;
  });
}

/** Write the skill files (and a config entry for agents that have none). Returns one line per thing done. */
export function installSkills(agent: string | undefined, env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): string[] {
  const agents = agentsFor(agent, env);
  if (!agents.length) return [`None of ${Object.keys(TEMPLATES).map(commandOf).join(', ')} is on PATH. Name one to install anyway: amigo install-skill <agent>`];
  const out: string[] = [];
  const config = loadConfig(env);
  let configChanged = false;
  for (const name of agents) {
    const t = TARGETS.find((x) => x.agent === name);
    if (t) {
      const file = t.file(userHome);
      if (existsSync(file) && !ours(file)) throw new Error(`${file} exists and was not written by amigo; move it away first`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, t.content());
      out.push(`${t.agent}: wrote ${file} (type ${t.invoke} in a session started with amigo)`);
      out.push(...installUserSkills(userHome));
      // In T3 Code amigo cannot pass hooks to a session: one user-level hook dispatches for the threads amigo registered.
      if (t3Installed(env, userHome)) out.push(installT3Hooks(userSettingsPath(env, userHome)));
    } else {
      out.push(`${name}: crew members only - amigo itself runs on Claude Code, so there is no slash command here`);
    }
    const configured = Object.entries(config.agents).some(([n, a]) => n === name || a.member[0] === commandOf(name));
    if (!configured) {
      config.agents[name] = TEMPLATES[name]!;
      configChanged = true;
      out.push(`${name}: added its template to ${configPath(env)} (member: ${TEMPLATES[name]!.member.join(' ')})`);
    }
  }
  if (configChanged) writeJsonAtomic(configPath(env), config);
  return out;
}

/** Delete only files amigo wrote, plus their folder when it is left empty. */
export function removeSkills(agent: string | undefined, userHome: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  agentsFor(agent ?? 'claude');
  const targets = !agent || agent === 'claude' ? TARGETS : [];
  const out: string[] = [];
  for (const file of new Set([...targets.map((t) => t.file(userHome)), ...(agent && agent !== 'claude' ? [] : LEGACY_FILES(userHome))])) {
    if (!ours(file)) continue;
    rmSync(file);
    const dir = dirname(file);
    if (dir.endsWith('amigo') && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    out.push(`removed ${file}`);
  }
  if (targets.some((t) => t.agent === 'claude')) {
    for (const name of USER_SKILLS) {
      const file = userSkillFile(userHome, name);
      if (!ours(file)) continue;
      rmSync(file);
      if (readdirSync(dirname(file)).length === 0) rmSync(dirname(file), { recursive: true });
      out.push(`removed ${file}`);
    }
    out.push(...removeT3Hooks(userSettingsPath(env, userHome)));
  }
  return out.length ? out : ['Nothing to remove.'];
}
