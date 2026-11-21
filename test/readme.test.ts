import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HELP } from '../src/cli.ts';
import { validateConfig } from '../src/config.ts';
import { codeRoot } from '../src/paths.ts';
import { TARGETS } from '../src/skills.ts';
import { TEMPLATES } from '../src/templates.ts';

const readme = readFileSync(join(codeRoot, 'README.md'), 'utf8');

describe('README stays in sync with the code', () => {
  it('contains the exact help text', () => {
    assert.ok(readme.includes(HELP), 'update the command block in README.md to match HELP in src/cli.ts');
  });

  it('every file it links to exists', () => {
    for (const m of readme.matchAll(/\]\((docs\/[^)#]+)\)/g)) assert.ok(existsSync(join(codeRoot, m[1] as string)), `${m[1]} exists`);
  });

  it('only mentions commands that exist', () => {
    const known = new Set([...HELP.matchAll(/^ {2}amigo ([a-z-]+)/gm)].map((m) => m[1]));
    for (const m of readme.matchAll(/`amigo ([a-z][a-z-]*)/g)) {
      assert.ok(known.has(m[1]), `README mentions "amigo ${m[1]}", which is not a command`);
    }
  });

  it('the agent table matches the built-in templates and skill targets', () => {
    assert.doesNotThrow(() => validateConfig(JSON.parse(/```json\n([\s\S]*?)```/.exec(readme)?.[1] ?? '')));
    const json = (cell: string) => (cell === 'none' ? undefined : JSON.parse(cell.replace(/^`|`$/g, '')));
    const rows = [...readme.matchAll(/^\| (Claude Code|Codex|Gemini CLI|Antigravity|Grok) \| (.+?) \| (.+?) \| (.+?) \|$/gm)];
    const names: Record<string, string> = { 'Claude Code': 'claude', Codex: 'codex', 'Gemini CLI': 'gemini', Antigravity: 'antigravity', Grok: 'grok' };
    assert.equal(rows.length, Object.keys(TEMPLATES).length);
    for (const [, label, invoke, amigo, member] of rows) {
      const agent = names[label as string] as string;
      assert.deepEqual({ amigo: json(amigo as string), member: json(member as string) }, { amigo: TEMPLATES[agent]?.amigo, member: TEMPLATES[agent]?.member }, label);
      assert.equal(invoke === 'none' ? undefined : invoke?.replace(/`/g, ''), TARGETS.find((t) => t.agent === agent)?.invoke, `${label} slash command`);
    }
  });
});
