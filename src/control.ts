import { killTree } from './proc.ts';
import { drain, isActive, sendFollowUp } from './squad.ts';
import { mutateTask, requireTask, runnerAlive } from './tasks.ts';
import { terminalBackend, type Runner } from './terminal.ts';

/**
 * The control plane for a crew member: a closed list of lifecycle verbs, separate from `amigo send`,
 * which only ever delivers text to read. Every verb keeps the worktree and every uncommitted change.
 *
 * interrupt  press the agent's stop key: the turn ends, the session stays.
 * exit       stop the agent. Its terminal closes with it; the worktree and the task stay, as blocked, for a relaunch.
 * relaunch   start the agent again in the same worktree with a note: a Claude Code session resumes; other agents run again.
 */
export const CONTROL_VERBS = ['interrupt', 'exit', 'relaunch'] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

export function controlTask(id: string, verb: string, opts: { note?: string } = {}, env: NodeJS.ProcessEnv = process.env, runner?: Runner): string[] {
  if (!(CONTROL_VERBS as readonly string[]).includes(verb)) throw new Error(`Unknown control verb "${verb}": use ${CONTROL_VERBS.join(', ')}`);
  const t = requireTask(id, env);
  if (t.status === 'closed' || t.status === 'closing') throw new Error(`Task ${id} is ${t.status}`);
  if (verb === 'interrupt') {
    if (!t.endpoint) throw new Error(`${id} has no terminal to interrupt`);
    const backend = terminalBackend(env, runner ? { runner } : {});
    backend.interrupt(t.endpoint);
    const after = backend.state(t.endpoint);
    if (after.liveness !== 'live') throw new Error(`Sent the stop key to ${id}, but its terminal is now ${after.liveness}`);
    return [`Interrupted ${id}: its turn was stopped and the session kept. Steer it with amigo send ${id} <message>.`];
  }
  if (verb === 'exit') {
    if (opts.note) throw new Error('exit takes no --note');
    // The record changes first, so the tab's wrapper reads the end as a stop, not a crash.
    const before = mutateTask(id, () => ({ status: 'blocked', seen: true, summary: `Stopped by amigo (control exit). The worktree is kept; start it again with: amigo control ${id} relaunch --note "<what to do>"` }), env);
    if (before.pid && runnerAlive(id, env)) {
      killTree(before.pid);
      return [`Stopped ${id}'s agent. Its worktree and changes are kept.`];
    }
    return [`${id}'s agent was not running (already stopped). Marked it stopped; its worktree is kept.`];
  }
  if (!opts.note?.trim()) throw new Error(`relaunch needs a note saying what to do: amigo control ${id} relaunch --note "<text>"`);
  if (isActive(t) && runnerAlive(id, env)) throw new Error(`${id} is still running: amigo control ${id} exit first, or steer it with amigo send`);
  if (t.status === 'running' || t.status === 'queued') mutateTask(id, (cur) => (cur.status === 'running' || cur.status === 'queued' ? { status: 'blocked' } : null), env);
  const after = sendFollowUp(id, opts.note, env);
  drain(env);
  return [after.status === 'running' ? `Relaunched ${id} in its worktree.` : after.status === 'failed' ? `Could not relaunch ${id}: ${after.summary}` : `${id} will relaunch as soon as its old tab has closed and memory allows.`];
}
