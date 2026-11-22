import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { codeRoot } from '../src/paths.ts';

/** Every text file under the given roots (folders are walked). */
function files(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else out.push(p);
  };
  for (const r of roots) walk(join(codeRoot, r));
  return out;
}

/** The ported workflow's ship words, and the retired "squad member". */
const FORBIDDEN = /\b(captain|firstmate|first mate|crewmates?|ahoy|shipshape|aye)\b|squad members?/gi;

/** The only places a forbidden word may appear: the credit line, and tasks-axi's fixed hold kind (its vocabulary, not amigo's). */
const ALLOWED: { file: string; line: RegExp }[] = [
  { file: 'README.md', line: /Workflow ported from firstmate by Kun Chen/ },
  { file: 'src/backlog.ts', line: /^export const BOSS_HOLD_KIND = 'captain';$/ },
];

describe('brand check', () => {
  it("prompts/, skills/, src/ and README.md use amigo's words only", () => {
    const hits: string[] = [];
    for (const f of files(['prompts', 'skills', 'src', 'README.md'])) {
      const rel = relative(codeRoot, f).replaceAll('\\', '/');
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!line.match(FORBIDDEN)) return;
          if (ALLOWED.some((a) => a.file === rel && a.line.test(line))) return;
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    assert.deepEqual(hits, [], 'use the Brand mapping words (Boss, amigo, crew member, build, survey...)');
  });

  it('the credit line is kept', () => {
    assert.match(readFileSync(join(codeRoot, 'README.md'), 'utf8'), /Workflow ported from firstmate by Kun Chen \(MIT\)/);
  });

  it('prompts and skills stay free of em and en dashes', () => {
    for (const f of files(['prompts', 'skills'])) assert.doesNotMatch(readFileSync(f, 'utf8'), /[–—]/, relative(codeRoot, f));
  });
});
