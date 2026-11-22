import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { stateDir } from './paths.ts';

/**
 * The away posture, ported as an afk record: one file, state/away.json, written only by `amigo away` in the turn the
 * Boss types /afk or /quiet. Nothing infers the posture from chat. `afk` holds what needs the Boss for his return and narrows
 * what merge may do; `quiet` is presentation only. Neither ever expands authority. Leaving archives the record.
 */

export type AwayMode = 'afk' | 'quiet';
export const AWAY_MODES: readonly AwayMode[] = ['afk', 'quiet'];

export interface AwayRecord {
  mode: AwayMode;
  /** The Boss's away words, verbatim; null when he gave none. Never parsed. */
  words: string | null;
  enteredAt: string;
  /** When the words were last replaced (a refresh with new words). */
  wordsAt?: string;
  /** Words a later /afk replaced, oldest first, for the return brief. */
  superseded?: { words: string; at: string }[];
  expectedReturn?: string;
}

export const awayPath = (env: NodeJS.ProcessEnv = process.env): string => join(stateDir(env), 'away.json');
const archiveDir = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'away-archive');

/** The current posture, or null. An unreadable record counts as afk (the safer reading) with no words. */
export function readAway(env: NodeJS.ProcessEnv = process.env): AwayRecord | null {
  const file = awayPath(env);
  if (!existsSync(file)) return null;
  const r = readJson<AwayRecord | null>(file, null);
  if (!r || !AWAY_MODES.includes(r.mode)) return { mode: 'afk', words: null, enteredAt: new Date(0).toISOString() };
  return r;
}

/** True while the Boss is away (afk): merges narrow to green work under standing authority. */
export const bossAway = (env: NodeJS.ProcessEnv = process.env): boolean => readAway(env)?.mode === 'afk';

/**
 * Why a merge must wait while the Boss is away, or null. Away never widens authority: waiving a check is attended-only, and a
 * local-only landing waits for his return. Quiet mode changes nothing here.
 */
export function awayMergeRefusal(m: { localOnly: boolean; waiving: boolean }, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!bossAway(env)) return null;
  if (m.waiving) return 'The Boss is away (afk): waiving a check needs him present. Nothing was merged.';
  if (m.localOnly) return 'The Boss is away (afk): a local-only landing waits for his return. Nothing was merged.';
  return null;
}

/**
 * Enter or refresh a posture. The same mode again with no words keeps the record; new words replace the mandate and keep the
 * original entry time. Switching mode starts a fresh record (an /afk over quiet starts holding for a return).
 */
export function enterAway(mode: AwayMode, words: string | null, opts: { expectedReturn?: string } = {}, env: NodeJS.ProcessEnv = process.env): { record: AwayRecord; refreshed: boolean } {
  if (!AWAY_MODES.includes(mode)) throw new Error(`Unknown mode "${mode}": afk or quiet`);
  if (opts.expectedReturn !== undefined && Number.isNaN(Date.parse(opts.expectedReturn))) throw new Error(`--expected-return must be a date and time, such as 2026-11-23T08:00Z (got "${opts.expectedReturn}")`);
  const now = new Date().toISOString();
  const text = words?.trim() ? words : null;
  const cur = readAway(env);
  let record: AwayRecord;
  let refreshed = false;
  if (cur && cur.mode === mode) {
    refreshed = true;
    record = { ...cur };
    if (text !== null && text !== cur.words) {
      if (cur.words) record.superseded = [...(cur.superseded ?? []), { words: cur.words, at: cur.wordsAt ?? cur.enteredAt }];
      record.words = text;
      record.wordsAt = now;
    }
  } else {
    record = { mode, words: text, enteredAt: now };
  }
  if (opts.expectedReturn !== undefined) record.expectedReturn = new Date(opts.expectedReturn).toISOString();
  writeJsonAtomic(awayPath(env), record);
  return { record, refreshed };
}

/** Leave the posture: move the record into state/away-archive/ and return it (null when there was none). */
export function leaveAway(env: NodeJS.ProcessEnv = process.env): AwayRecord | null {
  const record = readAway(env);
  if (!record) return null;
  mkdirSync(archiveDir(env), { recursive: true });
  renameSync(awayPath(env), join(archiveDir(env), `${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  return record;
}

/** The record in plain lines, for `amigo away`, the digest and the return brief. */
export function describeAway(r: AwayRecord): string {
  const lines = [
    r.mode === 'afk'
      ? `AWAY (afk) since ${r.enteredAt}: the Boss is away. What needs him waits for his return; his first ordinary message is the return (amigo away return).`
      : `AWAY (quiet) since ${r.enteredAt}: the Boss is present; batch routine updates. Only /quiet off ends it (amigo away return).`,
  ];
  if (r.expectedReturn) lines.push(`Expected back: ${r.expectedReturn}`);
  lines.push(r.words ? `His words (verbatim):\n${r.words}` : 'His words: none recorded.');
  for (const s of r.superseded ?? []) lines.push(`Replaced words (from ${s.at}):\n${s.words}`);
  return lines.join('\n');
}
