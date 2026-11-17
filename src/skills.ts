import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { resolveExecutable } from './command.ts';
import { loadConfig } from './config.ts';
import { writeJsonAtomic } from './fsx.ts';
import { configPath } from './paths.ts';
import { TEMPLATES } from './templates.ts';

/** Marks files octomaxxing wrote, so --remove never deletes anything else. */
export const MARKER = 'installed by octomaxxing';

const DESCRIPTION = 'Turn this session into the octomaxxing head, which hands tasks to parallel worker agents (arms). Use only when the user runs /octomaxxing or asks to start octomaxxing.';

const skillMd = (body: string): string => `---\nname: octomaxxing\ndescription: ${DESCRIPTION}\n---\n\n<!-- ${MARKER} -->\n\n${body}\n`;

const runLine = (agent: string): string => `Run this shell command and follow the instructions it prints, exactly:\n\n    octomaxxing brief --agent ${agent}`;

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
const SHARED = (h: string) => join(h, '.agents', 'skills', 'octomaxxing', 'SKILL.md');
const sharedContent = () =>
  skillMd(
    'Run this shell command and follow the instructions it prints, exactly. Use `--agent codex` if you are Codex and `--agent grok` if you are Grok:\n\n    octomaxxing brief --agent <codex or grok>',
  );

export const TARGETS: SkillTarget[] = [
  { agent: 'claude', invoke: '/octomaxxing', file: (h) => join(h, '.claude', 'skills', 'octomaxxing', 'SKILL.md'), content: () => skillMd(runLine('claude')) },
  {
    agent: 'gemini',
    invoke: '/octomaxxing',
    file: (h) => join(h, '.gemini', 'commands', 'octomaxxing.toml'),
    content: () => `# ${MARKER}\ndescription = "Turn this session into the octomaxxing head"\nprompt = """\n${runLine('gemini')}\n"""\n`,
  },
  { agent: 'antigravity', invoke: '/octomaxxing', file: (h) => join(h, '.gemini', 'config', 'skills', 'octomaxxing', 'SKILL.md'), content: () => skillMd(runLine('antigravity')) },
  { agent: 'codex', invoke: '$octomaxxing', file: SHARED, content: sharedContent },
  { agent: 'grok', invoke: '/octomaxxing', file: SHARED, content: sharedContent },
];

const commandOf = (agent: string): string => TEMPLATES[agent]?.arm[0] ?? agent;

export function targetsFor(agent: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  if (agent) {
    const t = TARGETS.find((x) => x.agent === agent);
    if (!t) throw new Error(`No slash command support for "${agent}". Supported: ${TARGETS.map((x) => x.agent).join(', ')} (others can use: octomaxxing head)`);
    return [t];
  }
  return TARGETS.filter((t) => resolveExecutable(commandOf(t.agent), env) !== null);
}

const ours = (file: string): boolean => existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);

/** Write the skill files (and a config entry for agents that have none). Returns one line per thing done. */
export function installSkills(agent: string | undefined, env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): string[] {
  const targets = targetsFor(agent, env);
  if (!targets.length) return [`None of ${TARGETS.map((t) => commandOf(t.agent)).join(', ')} is on PATH. Name one to install anyway: octomaxxing install-skill <agent>`];
  const out: string[] = [];
  const written = new Set<string>();
  const config = loadConfig(env);
  let configChanged = false;
  for (const t of targets) {
    const file = t.file(userHome);
    if (!written.has(file)) {
      if (existsSync(file) && !ours(file)) throw new Error(`${file} exists and was not written by octomaxxing; move it away first`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, t.content());
      written.add(file);
    }
    out.push(`${t.agent}: wrote ${file} (type ${t.invoke} in ${commandOf(t.agent)})`);
    const configured = Object.entries(config.agents).some(([name, a]) => name === t.agent || a.arm[0] === commandOf(t.agent));
    if (!configured && TEMPLATES[t.agent]) {
      config.agents[t.agent] = TEMPLATES[t.agent]!;
      configChanged = true;
      out.push(`${t.agent}: added its template to ${configPath(env)} (arm: ${TEMPLATES[t.agent]!.arm.join(' ')})`);
    }
  }
  if (configChanged) writeJsonAtomic(configPath(env), config);
  return out;
}

/** Delete only files octomaxxing wrote, plus their folder when it is left empty. */
export function removeSkills(agent: string | undefined, userHome: string = os.homedir()): string[] {
  const targets = agent ? targetsFor(agent) : TARGETS;
  const out: string[] = [];
  for (const file of new Set(targets.map((t) => t.file(userHome)))) {
    if (!ours(file)) continue;
    rmSync(file);
    const dir = dirname(file);
    if (dir.endsWith('octomaxxing') && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    out.push(`removed ${file}`);
  }
  return out.length ? out : ['Nothing to remove.'];
}
