import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchSha } from './git.ts';
import { surveyGateProblem } from './holds.ts';
import { run } from './proc.ts';
import { cliPath, taskDataDir, taskDir } from './paths.ts';
import type { Task, TaskKind } from './tasks.ts';

/**
 * Task shapes. A build changes a project through its delivery mode. A survey produces knowledge: its
 * deliverable is data/<id>/report.md, never a PR. Its worktree is a laboratory whose scratch edits and commits are discarded at
 * close; it never pushes; and it is closed only once its report exists and its open Boss calls are recorded (holds.ts).
 */

export const TASK_KINDS: readonly TaskKind[] = ['build', 'survey'];

export const kindOf = (t: Pick<Task, 'kind'>): TaskKind => t.kind ?? 'build';

/** Where a survey writes its report. */
export const reportPath = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(taskDataDir(id, env), 'report.md');

/** The survey part of a crew member's prompt: its setup, rules and definition of done. */
export function surveyContract(t: Pick<Task, 'id' | 'worktree' | 'report'>): string {
  const lab = t.worktree
    ? 'Your worktree is your laboratory: install, run, edit and make scratch commits freely; all of it is discarded when the survey is closed.'
    : 'Your folder is your laboratory: nothing in it is delivered.';
  const done = `"${process.execPath}" "${cliPath}" complete ${t.id} --none`;
  return [
    '## This is a survey',
    '',
    `The deliverable is a written report, not a PR or a commit. ${lab} The report is the only thing that survives, so anything worth keeping must be in it. This replaces the commit rules above: leave nothing for amigo to commit.`,
    '',
    '1. Never push to any remote and never open a PR. Pushes from this session are blocked.',
    `2. Stay inside your working directory; outside it, write only the report below, and run only the one command under Definition of done.`,
    '3. A decision that belongs to the Boss (product choices, destructive actions) is not yours to make: list it in the report and report it.',
    '',
    '## Definition of done',
    '',
    `Write your findings to \`${t.report}\`. The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.`,
    'Before reporting done, go through the whole report for questions only the Boss can answer (not findings, and not recommendations that need no choice from him).',
    `- If there are none, run exactly \`${done}\`. That is the only amigo command you may run.`,
    '- If any remain, do not run it: list each one, with its options, under a heading "Open decisions for the Boss" in the report and in your final message. amigo records them for the Boss.',
    '- If the command refuses, report the refusal and stop.',
    'If your findings show work that should ship (you reproduced a bug and the fix is clear), say so in the report. A report recommends work; it never authorizes it.',
  ].join('\n');
}

/** A pre-push hook that refuses every push: a survey never publishes anything. */
const PRE_PUSH = '#!/bin/sh\necho "amigo: this is a survey: it never pushes. Put what you found in the report." >&2\nexit 1\n';

/** The hooks folder whose pre-push refuses, made in the task's runtime folder. */
export function noPushHooks(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(taskDir(id, env), 'no-push-hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pre-push'), PRE_PUSH, { mode: 0o755 });
  return dir;
}

/**
 * The git settings a survey's agent runs with: core.hooksPath pointed at the refusing pre-push hook, added through git's
 * GIT_CONFIG_COUNT variables, so every git command of the session (and nothing else, and no config file of the clone) sees it.
 * Empty for a build.
 */
export function surveyGitEnv(t: Pick<Task, 'id' | 'kind'>, env: NodeJS.ProcessEnv): Record<string, string> {
  if (kindOf(t) !== 'survey') return {};
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: noPushHooks(t.id, env).replace(/\\/g, '/') };
}

/** True when the survey's report exists and has something in it. */
export function reportWritten(t: Pick<Task, 'report'>): boolean {
  if (!t.report || !existsSync(t.report)) return false;
  try {
    return statSync(t.report).isFile() && readFileSync(t.report, 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Close's survey gate, checked before anything is touched: a survey delivers no commit or PR, and without --force (the Boss's
 * explicit discard) it is closed only once its report is written and its open Boss calls are recorded.
 */
export function surveyCloseProblem(t: Task, opts: { commit?: boolean; pr?: boolean; force?: boolean }, env: NodeJS.ProcessEnv): string | null {
  if (kindOf(t) !== 'survey') return null;
  if (opts.commit || opts.pr) return `${t.id} is a survey: it delivers its report, never a commit or a pull request. Close it without --commit.`;
  if (opts.force) return null;
  if (!reportWritten(t)) return `${t.id} is a survey with no report at ${t.report}. The report is the work product: have the crew member write it (amigo send), or use --force once the Boss agreed to discard it.`;
  const gate = surveyGateProblem(t.id, env);
  return gate ? `${t.id} has not passed the Boss-call completion gate: ${gate}.` : null;
}

/** A survey's branch holds only scratch commits: delete it once its worktree is back in the pool. */
export function discardSurveyBranch(repo: string, branch: string): string[] {
  if (!branchSha(repo, branch)) return [];
  const r = run('git', ['-C', repo, 'branch', '-D', branch]);
  return [r.status === 0 ? `Removed the survey's scratch branch ${branch}.` : `Could not remove the survey's scratch branch ${branch}: ${(r.stderr || r.stdout).trim()}`];
}
