import { acceptDone, type PrPeek } from './landing.ts';
import { viewPr } from './pr.ts';
import { ghPath } from './github.ts';
import { appendStatus, formatStatusLine, latestEvent, readStatus, TERMINAL_VERBS, type StatusEvent } from './status.ts';
import { FINISHED, mutateTask, requireTask, type Status, type Task } from './tasks.ts';

/** What a status verb makes of the task record: a terminal verb ends the turn and waits on amigo; working and paused mean under way. */
export function statusFor(state: string): Status | null {
  switch (state) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'needs-decision':
      return 'question';
    case 'working':
    case 'paused':
      return 'running';
    default:
      return null;
  }
}

/** A live, best-effort PR read for the done gate: null when gh is missing or the read fails (which never refuses). */
export function ghPeek(t: Task, env: NodeJS.ProcessEnv): PrPeek | undefined {
  if (!ghPath(env) || !t.repo) return undefined;
  return (url) => {
    try {
      const v = viewPr(url, t.repo as string, env);
      return { ...(v.isDraft === null ? {} : { isDraft: v.isDraft }), headRefOid: v.headRefOid };
    } catch {
      return null;
    }
  };
}

const live = (s: Status): boolean => s === 'running' || FINISHED.includes(s);

/**
 * Take in status lines this record has not seen yet: the newest one that is a state sets the task's status and summary. A done
 * appended by hand goes through the same gate `amigo report` applies; a refused one reads as blocked with the reason.
 */
export function ingestStatus(id: string, env: NodeJS.ProcessEnv = process.env, accepted?: { line: number; patch: Partial<Task> }): Task {
  const events = readStatus(id, env);
  let gate: { line: number; patch?: Partial<Task>; refused?: string } | undefined = accepted;
  const before = requireTask(id, env);
  const fresh = events.slice(before.statusSeen ?? 0);
  const last = latestEvent(fresh);
  if (last?.state === 'done' && (!gate || gate.line !== last.line)) {
    try {
      gate = { line: last.line, patch: acceptDone(before, last.text, ghPeek(before, env)) };
    } catch (err) {
      gate = { line: last.line, refused: (err as Error).message };
    }
  }
  return mutateTask(
    id,
    (cur) => {
      const now = readStatus(id, env);
      if ((cur.statusSeen ?? 0) >= now.length) return null;
      const newest = latestEvent(now.slice(cur.statusSeen ?? 0));
      const base: Partial<Task> = { statusSeen: now.length };
      if (!newest || !live(cur.status)) return base;
      if (newest.state === 'done' && gate?.line === newest.line && gate.refused) return { ...base, status: 'blocked', summary: gate.refused, seen: false };
      const next = statusFor(newest.state);
      if (!next) return base;
      const terminal = (TERMINAL_VERBS as readonly string[]).includes(newest.state);
      return { ...base, ...(newest.state === 'done' && gate?.line === newest.line ? gate.patch : {}), status: next, summary: newest.text, ...(terminal ? { seen: false } : {}) };
    },
    env,
  );
}

/** Status events written at or after the start of the current turn. */
export function eventsThisTurn(t: Task, env: NodeJS.ProcessEnv): StatusEvent[] {
  const since = t.turnStartedAt ? Math.floor(Date.parse(t.turnStartedAt) / 1000) : 0;
  return readStatus(t.id, env).filter((e) => e.at !== null && e.at >= since);
}

/**
 * `amigo report <state> <text>`, run by a crew member: append one status line and apply it. A done goes through the Definition
 * of done gate first and is refused (nothing appended) with the reason, which the crew member reads and fixes.
 */
export function reportStatus(id: string, state: string, text: string, opts: { key?: string } = {}, env: NodeJS.ProcessEnv = process.env): string {
  const t = requireTask(id, env);
  if (t.status === 'closed' || t.status === 'closing') throw new Error(`Task ${id} is ${t.status}`);
  const line = formatStatusLine(state, text, { key: opts.key });
  const patch = state === 'done' ? acceptDone(t, text.trim(), ghPeek(t, env)) : {};
  appendStatus(id, line, env);
  const lineNo = readStatus(id, env).at(-1)?.line ?? 0;
  const after = ingestStatus(id, env, { line: lineNo, patch });
  const pr = state === 'done' && after.pr && patch.pr ? ` PR recorded: ${after.pr}` : '';
  const latched = patch.localDoneHead ? ` Ready head ${patch.localDoneHead.slice(0, 12)} recorded.` : '';
  return `reported: ${line}${pr}${latched}`;
}
