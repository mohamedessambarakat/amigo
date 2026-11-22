import { createHash } from 'node:crypto';
import { addItem, BOSS_HOLD_KIND, DECISION_KIND, findItem, holdActive, holdItem, isOpenBossHold, listItems, setBody, finishItem, unholdItem, type BacklogItem } from './backlog.ts';
import { getTask, mutateTask } from './tasks.ts';

/**
 * Boss holds. A decision is not a separate thing: it is a backlog item held for the Boss, and
 * its identity is the item id. This module owns the mechanics only; amigo decides what genuinely waits on the Boss, and nothing here
 * reads report or chat prose to guess it.
 *
 *   hold      put an item under a Boss hold (creating it when no work item exists to hold), with the question and options as the
 *             reason; --until defers it to a date ("later" is an answer too). Stamps "Boss hold set:" (and "Boss hold origin:").
 *   answer    record the Boss's exact words in the item and resolve the call: Done, or with --release lift the hold so held work goes on.
 *   complete  a survey's completion gate: attest the inventory of held items carrying its open Boss calls (or --none).
 *   verify    close's check that the attested inventory is still durable before a survey is torn down.
 */

const SET_LABEL = 'Boss hold set: ';
const ORIGIN_LABEL = 'Boss hold origin: ';
const RESOLUTION_LINE = 'Resolution recorded by amigo.';
/** The longest answer recorded, in bytes. */
const MAX_ANSWER_BYTES = 8192;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The origin a hold recorded (`hold --origin`), or null. */
export const holdOrigin = (body: string): string | null => body.split(/\r?\n/).find((l) => l.startsWith(ORIGIN_LABEL))?.slice(ORIGIN_LABEL.length).trim() || null;

/** True when the body carries a recorded Boss answer. */
export const hasResolution = (body: string): boolean => body.includes(RESOLUTION_LINE) && body.includes('Boss decision:');

/** True when the item carries Boss-hold provenance: an active Boss hold, or the stamp a hold leaves in the body. */
const bossProvenance = (item: BacklogItem): boolean => item.holdKind === BOSS_HOLD_KIND || item.body.split(/\r?\n/).some((l) => l.startsWith(SET_LABEL));

/** The body with the hold-set stamp first (kept while the hold is active, new when released work is held again) and the origin line. */
function stampedBody(item: BacklogItem | null, origin: string | undefined, now: Date): string {
  const lines = (item?.body ?? '').split(/\r?\n/);
  const existing = lines[0]?.startsWith(SET_LABEL) ? lines[0].slice(SET_LABEL.length) : null;
  const keep = existing && item && item.holdKind === BOSS_HOLD_KIND ? existing : now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const recordedOrigin = item ? holdOrigin(item.body) : null;
  const rest = lines.filter((l, i) => !(i === 0 && l.startsWith(SET_LABEL)) && !l.startsWith(ORIGIN_LABEL));
  const head = [`${SET_LABEL}${keep}`, ...(origin || recordedOrigin ? [`${ORIGIN_LABEL}${origin || recordedOrigin}`] : [])];
  const tail = rest.join('\n').trim();
  return [head.join('\n'), ...(tail ? [tail] : [])].join('\n\n');
}

export interface HoldInput {
  reason: string;
  until?: string;
  /** Create the item when it does not exist yet. */
  title?: string;
  project?: string;
  /** The survey (or other work) that found the question. */
  origin?: string;
}

/** Place an item under a Boss hold, idempotently. Refuses an item already Done (it is never reopened). */
export function holdForBoss(id: string, input: HoldInput, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string[] {
  if (!input.reason.trim()) throw new Error('A Boss hold needs a --reason: the question and its options');
  if (input.until && !DATE_RE.test(input.until)) throw new Error(`--until takes a date as YYYY-MM-DD, not "${input.until}"`);
  if (input.origin && input.origin === id) throw new Error('A hold cannot name itself as its origin: hold a separate item for the call');
  const out: string[] = [];
  let item = findItem(id, env);
  if (!item) {
    if (!input.title?.trim()) throw new Error(`No backlog item "${id}". To create one for this call, pass --title <title> (and --project <name>)`);
    const originRepo = input.origin ? (findItem(input.origin, env)?.repo ?? getTask(input.origin, env)?.project ?? undefined) : undefined;
    addItem({ id, title: input.title.trim(), kind: DECISION_KIND, repo: input.project ?? originRepo }, env);
    out.push(`Added backlog item ${id}.`);
    item = findItem(id, env);
  }
  if (!item) throw new Error(`Backlog item ${id} could not be read back after adding it`);
  if (item.state === 'done') throw new Error(`Backlog item ${id} is Done; a closed item is never reopened for a hold. Hold the work the question gates, or a new item.`);
  setBody(id, stampedBody(item, input.origin, now), env);
  holdItem(id, { reason: input.reason.trim(), kind: BOSS_HOLD_KIND, ...(input.until ? { until: input.until } : {}) }, env);
  out.push(`${id} is held for the Boss${input.until ? ` until ${input.until}` : ''}: ${input.reason.trim()}`);
  return out;
}

/** Record the Boss's exact words and resolve the call: Done, or (release) lift the hold so the held work resumes. */
export function answerBoss(id: string, words: string, opts: { release?: boolean }, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string[] {
  const text = words.trim();
  if (!text) throw new Error('The answer is empty: record what the Boss actually said');
  if (Buffer.byteLength(text, 'utf8') > MAX_ANSWER_BYTES) throw new Error(`The answer is over ${MAX_ANSWER_BYTES} bytes; record the Boss's words, not a transcript`);
  const item = findItem(id, env);
  if (!item) throw new Error(`No backlog item "${id}"`);
  if (!bossProvenance(item)) throw new Error(`${id} was never held for the Boss, so there is no call to answer. Record ordinary notes with amigo backlog update.`);
  const mode = opts.release ? 'released' : 'answered';
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (item.state === 'done') {
    if (opts.release) throw new Error(`${id} is Done: there is no held work left to release`);
    if (item.body.includes(`Decision digest: ${digest}`)) return [`${id} already records this answer.`];
    if (hasResolution(item.body)) throw new Error(`${id} is Done and already records a different answer`);
  } else if (item.body.includes(`Decision digest: ${digest}`) && item.body.includes(`Resolution mode: ${mode}`) && !holdActive(item)) {
    return [`${id} already records this answer.`];
  }
  const block = [RESOLUTION_LINE, `Decision digest: ${digest}`, `Resolution mode: ${mode}`, `Answered: ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`, '', 'Boss decision:', text].join('\n');
  setBody(id, [block, item.body.trim()].filter(Boolean).join('\n\n'), env);
  if (item.state === 'done') return [`Recorded the Boss's answer on ${id} (it was already Done).`];
  if (opts.release) {
    unholdItem(id, env);
    return [`Recorded the Boss's answer on ${id} and released it: the held work can go on.`];
  }
  finishItem(id, { note: 'answered by the Boss' }, env);
  return [`Recorded the Boss's answer on ${id} and closed it.`];
}

/** Why a listed hold does not durably carry a call for `origin`, or null when it does. */
function entryProblem(id: string, origin: string, items: BacklogItem[]): string | null {
  if (id === origin) return 'it is the survey itself: hold a separate item for the call';
  const item = items.find((i) => i.id === id);
  if (!item) return 'there is no such backlog item';
  const recorded = holdOrigin(item.body);
  if (recorded && recorded !== origin) return `it was held for ${recorded}, not ${origin}`;
  if (isOpenBossHold(item)) return null;
  if (hasResolution(item.body)) return null;
  if (item.state === 'done') return 'it is Done without a recorded Boss answer (record his words with amigo answer)';
  return 'it is not held for the Boss';
}

/**
 * A survey's completion gate: attest that its report was inventoried and these held items (none with `none`) carry every open
 * Boss call it found. Later passes may add ids. The survey itself may attest only an empty inventory.
 */
export function completeSurvey(origin: string, holds: string[], none: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  if (none === holds.length > 0) throw new Error('Pass --none, or the ids of the held items that carry the open Boss calls (not both)');
  const task = getTask(origin, env);
  if (!task) throw new Error(`No task "${origin}"`);
  const out: string[] = [];
  if (holds.length) {
    const items = listItems(env);
    const problems = holds.map((h) => [h, entryProblem(h, origin, items)] as const).filter(([, p]) => p);
    if (problems.length) throw new Error(`Cannot attest ${origin}'s Boss calls:\n${problems.map(([h, p]) => `  - ${h}: ${p}`).join('\n')}`);
    for (const h of holds) if (!holdOrigin(items.find((i) => i.id === h)?.body ?? '')) out.push(`${h} has no recorded origin; accepted because it is durably held.`);
  }
  const next = mutateTask(origin, (cur) => ({ decisions: { holds: [...new Set([...(cur.decisions?.holds ?? []), ...holds])], at: new Date().toISOString() } }), env);
  const list = next.decisions?.holds ?? [];
  out.push(list.length ? `${origin}: its open Boss calls are carried by ${list.join(', ')}.` : `${origin}: no open Boss call.`);
  return out;
}

/** Why a survey may not be torn down yet (its completion gate), or null. Read-only. */
export function surveyGateProblem(origin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const task = getTask(origin, env);
  if (!task?.decisions) return `its open Boss calls were never inventoried: list them with amigo hold ... --origin ${origin}, then run amigo complete ${origin} <ids> (or --none)`;
  if (!task.decisions.holds.length) return null;
  const items = listItems(env);
  const problems = task.decisions.holds.map((h) => [h, entryProblem(h, origin, items)] as const).filter(([, p]) => p);
  return problems.length ? `its recorded Boss calls are no longer durable: ${problems.map(([h, p]) => `${h} (${p})`).join('; ')}` : null;
}
