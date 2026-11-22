import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutable } from './command.ts';
import { loadConfig } from './config.ts';
import { writeJsonAtomic } from './fsx.ts';
import { codeRoot, configPath } from './paths.ts';
import { TEMPLATES } from './templates.ts';

/** Marks files amigo wrote, so --remove never deletes anything else. */
export const MARKER = 'installed by amigo';

const DESCRIPTION = 'Turn this session into amigo, which hands tasks to the crew: parallel worker agents. Use only when the user runs /amigo or asks to start amigo.';

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
 * One file per agent CLI. Codex and Grok both read ~/.agents/skills, so they share one file that names both;
 * giving Grok its own copy in ~/.grok/skills would show it two skills with the same name.
 */
const SHARED = (h: string) => join(h, '.agents', 'skills', 'amigo', 'SKILL.md');
const sharedContent = () =>
  skillMd(
    'Run this shell command and follow the instructions it prints, exactly. Use `--agent codex` if you are Codex and `--agent grok` if you are Grok:\n\n    amigo brief --agent <codex or grok>',
  );

export const TARGETS: SkillTarget[] = [
  { agent: 'claude', invoke: '/amigo', file: (h) => join(h, '.claude', 'skills', 'amigo', 'SKILL.md'), content: () => skillMd(runLine('claude')) },
  {
    agent: 'gemini',
    invoke: '/amigo',
    file: (h) => join(h, '.gemini', 'commands', 'amigo.toml'),
    content: () => `# ${MARKER}\ndescription = "Turn this session into amigo"\nprompt = """\n${runLine('gemini')}\n"""\n`,
  },
  { agent: 'antigravity', invoke: '/amigo', file: (h) => join(h, '.gemini', 'config', 'skills', 'amigo', 'SKILL.md'), content: () => skillMd(runLine('antigravity')) },
  { agent: 'codex', invoke: '$amigo', file: SHARED, content: sharedContent },
  { agent: 'grok', invoke: '/amigo', file: SHARED, content: sharedContent },
];

const commandOf = (agent: string): string => TEMPLATES[agent]?.member[0] ?? agent;

export function targetsFor(agent: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  if (agent) {
    const t = TARGETS.find((x) => x.agent === agent);
    if (!t) throw new Error(`No slash command support for "${agent}". Supported: ${TARGETS.map((x) => x.agent).join(', ')} (others can use: amigo --agent <name>)`);
    return [t];
  }
  return TARGETS.filter((t) => resolveExecutable(commandOf(t.agent), env) !== null);
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
  const targets = targetsFor(agent, env);
  if (!targets.length) return [`None of ${TARGETS.map((t) => commandOf(t.agent)).join(', ')} is on PATH. Name one to install anyway: amigo install-skill <agent>`];
  const out: string[] = [];
  const written = new Set<string>();
  const config = loadConfig(env);
  let configChanged = false;
  for (const t of targets) {
    const file = t.file(userHome);
    if (!written.has(file)) {
      if (existsSync(file) && !ours(file)) throw new Error(`${file} exists and was not written by amigo; move it away first`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, t.content());
      written.add(file);
    }
    out.push(`${t.agent}: wrote ${file} (type ${t.invoke} in ${commandOf(t.agent)})`);
    if (t.agent === 'claude') out.push(...installUserSkills(userHome));
    const configured = Object.entries(config.agents).some(([name, a]) => name === t.agent || a.member[0] === commandOf(t.agent));
    if (!configured && TEMPLATES[t.agent]) {
      config.agents[t.agent] = TEMPLATES[t.agent]!;
      configChanged = true;
      out.push(`${t.agent}: added its template to ${configPath(env)} (member: ${TEMPLATES[t.agent]!.member.join(' ')})`);
    }
  }
  if (configChanged) writeJsonAtomic(configPath(env), config);
  return out;
}

/** Delete only files amigo wrote, plus their folder when it is left empty. */
export function removeSkills(agent: string | undefined, userHome: string = os.homedir()): string[] {
  const targets = agent ? targetsFor(agent) : TARGETS;
  const out: string[] = [];
  for (const file of new Set(targets.map((t) => t.file(userHome)))) {
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
  }
  return out.length ? out : ['Nothing to remove.'];
}
