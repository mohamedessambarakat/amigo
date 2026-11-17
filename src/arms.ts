import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLaunch, describeLaunch } from './command.ts';
import { findProject, loadConfig, loadProjects, pickAgent } from './config.ts';
import { withLock } from './fsx.ts';
import { branchName, changedFiles, commitAll, committedFiles, createWorktree, deleteBranchIfUnused, isGitRepo, removeWorktree } from './git.ts';
import { cliPath, codeRoot, home, lockPath, worktreesDir } from './paths.ts';
import { killTree } from './proc.ts';
import {
  FINISHED,
  HEARTBEAT_MS,
  beat,
  briefFile,
  claimTaskDir,
  lastLines,
  listTasks,
  logFile,
  mutateTask,
  newId,
  parseStatus,
  promptFile,
  requireTask,
  runnerAlive,
  saveTask,
  type Task,
} from './tasks.ts';

const readPrompt = (name: string): string => readFileSync(join(codeRoot, 'prompts', name), 'utf8').trim();

/** Everything an arm gets for one run: the arm rules, the project notes, the brief and any follow-ups. */
export function armPrompt(t: Task, brief: string, notes: string | undefined): string {
  const parts = [readPrompt('arm.md'), `## Your task\n\nTask id: ${t.id}\nProject: ${t.project}\nWorking directory: ${t.cwd}`];
  if (t.reviewOf) {
    parts.push(
      `## You are a reviewer\n\nYou check the work of task ${t.reviewOf} in this folder. Read, run and report only: do not edit, commit, stage, reset or delete anything. End with STATUS: done followed by your verdict.`,
    );
  }
  parts.push(`## Project notes (hard rules)\n\n${notes?.trim() || 'None.'}`);
  parts.push(`## Brief\n\n${brief.trim()}`);
  if (t.followUps.length) {
    if (t.summary) parts.push(`## Your previous run ended with\n\n${t.summary}`);
    parts.push(`## Follow-ups from the head (newest last)\n\n${t.followUps.map((m, i) => `${i + 1}. ${m.trim()}`).join('\n')}`);
  }
  return parts.join('\n\n') + '\n';
}

function notesFor(project: string, env: NodeJS.ProcessEnv): string | undefined {
  return loadProjects(env).find((p) => p.name === project)?.notes;
}

export interface SpawnInput {
  project?: string;
  review?: string;
  title?: string;
  agent?: string;
  brief: string;
}

/** "Title: Fix the footer" on the brief's first line, else the first line itself. */
export function titleOf(brief: string): string {
  const first = brief.trim().split(/\r?\n/)[0] ?? '';
  return first.replace(/^title:\s*/i, '').replace(/^#+\s*/, '').trim().slice(0, 80) || 'task';
}

/** Plan a new arm. With dryRun, nothing is written: the plan is returned as text, which also proves the agent can be found. */
export function spawnArm(input: SpawnInput, opts: { dryRun?: boolean }, env: NodeJS.ProcessEnv = process.env): { task: Task; text: string } {
  if (!input.brief.trim()) throw new Error('The brief is empty');
  if (!input.project === !input.review) throw new Error('Give either --project <name> or --review <task-id>');
  const config = loadConfig(env);
  const agent = pickAgent(config, input.agent, env);
  const title = input.title?.trim() || titleOf(input.brief);
  let id = newId(title);
  if (!opts.dryRun) {
    for (let i = 0; !claimTaskDir(id, env); i++) {
      if (i >= 5) throw new Error('Could not find a free task id');
      id = newId(title);
    }
  }
  const now = new Date().toISOString();
  const base = { id, title, agent, status: 'queued' as const, createdAt: now, updatedAt: now, runs: 0, followUps: [], seen: true };

  let task: Task;
  if (input.review) {
    const parent = requireTask(input.review, env);
    if (parent.status === 'closed' || parent.status === 'closing') throw new Error(`Task ${parent.id} is ${parent.status}; there is nothing left to review`);
    task = { ...base, project: parent.project, cwd: parent.cwd, repo: null, worktree: null, branch: null, baseSha: null, reviewOf: parent.id };
  } else {
    const project = findProject(loadProjects(env), input.project as string);
    if (!existsSync(project.path)) throw new Error(`Project folder ${project.path} does not exist`);
    if (isGitRepo(project.path)) {
      const worktree = join(worktreesDir(env), `${project.name}-${id}`);
      task = { ...base, project: project.name, cwd: worktree, repo: project.path, worktree, branch: branchName(id), baseSha: null };
    } else {
      task = { ...base, project: project.name, cwd: project.path, repo: null, worktree: null, branch: null, baseSha: null };
    }
  }

  const prompt = armPrompt(task, input.brief, notesFor(task.project, env));
  const launch = buildLaunch(config.agents[agent]!.arm, { prompt, promptFile: promptFile(id, env) }, env);
  const where = task.worktree ? `new worktree ${task.worktree} on branch ${task.branch} (from ${task.repo})` : `${task.cwd} (in place${task.reviewOf ? `, reviewing ${task.reviewOf}` : ''})`;
  const text = [`task:    ${id}  "${title}"`, `folder:  ${where}`, `agent:   ${agent}`, `command: ${describeLaunch(launch)}`].join('\n');
  if (opts.dryRun) return { task, text: `DRY RUN, nothing was started.\n${text}` };

  writeFileSync(briefFile(id, env), input.brief.trim() + '\n');
  if (task.worktree && task.repo && task.branch) {
    mkdirSync(worktreesDir(env), { recursive: true });
    task.baseSha = createWorktree(task.repo, task.worktree, task.branch);
  }
  saveTask(task, env);
  drain(env);
  const after = requireTask(id, env);
  return { task: after, text: `${after.status === 'running' ? 'Started' : 'Queued (waiting for a free arm)'}\n${text}` };
}

/** Mark arms whose runner stopped without reporting (crash, reboot) as failed. */
export function refresh(env: NodeJS.ProcessEnv = process.env): void {
  for (const t of listTasks(env)) {
    if (t.status !== 'running' || runnerAlive(t.id, env)) continue;
    if (Date.now() - Date.parse(t.updatedAt) < 30_000) continue; // just started: the runner has not beaten yet
    mutateTask(
      t.id,
      (cur) => (cur.status === 'running' && !runnerAlive(cur.id, env) ? { status: 'failed', pid: null, seen: false, summary: 'The arm stopped without reporting (see its output with attach).' } : null),
      env,
    );
  }
}

/** Start queued arms, oldest first, while fewer than maxArms run. Only one arm at a time per folder. */
export function drain(env: NodeJS.ProcessEnv = process.env): string[] {
  return withLock(lockPath('queue', env), () => {
    refresh(env);
    const { maxArms } = loadConfig(env);
    const tasks = listTasks(env);
    const busy = new Set(tasks.filter((t) => t.status === 'running').map((t) => t.cwd));
    const started: string[] = [];
    for (const t of tasks.filter((x) => x.status === 'queued')) {
      if (busy.size >= maxArms) break;
      if (busy.has(t.cwd)) continue;
      startArm(t, env);
      started.push(t.id);
      busy.add(t.cwd);
    }
    return started;
  });
}

function startArm(t: Task, env: NodeJS.ProcessEnv): void {
  const brief = readFileSync(briefFile(t.id, env), 'utf8');
  writeFileSync(promptFile(t.id, env), armPrompt(t, brief, notesFor(t.project, env)));
  mutateTask(t.id, (cur) => ({ status: 'running', pid: null, runs: cur.runs + 1, seen: true, exitCode: null }), env);
  // A detached runner owns the agent process, so arms keep going after this command exits.
  const child = spawn(process.execPath, [cliPath, '_run', t.id], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, OCTOMAXXING_HOME: home(env) } });
  child.on('error', () => {});
  child.unref();
  mutateTask(t.id, (cur) => (cur.status === 'running' ? { pid: child.pid ?? null } : null), env);
}

/** The detached runner (`octomaxxing _run <id>`): runs the agent once, records how it ended, starts the next queued arm. */
export async function runArm(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const t = requireTask(id, env);
  if (t.status !== 'running') return;
  beat(id, env);
  const heartbeat = setInterval(() => beat(id, env), HEARTBEAT_MS);
  const log = logFile(id, env);
  const start = existsSync(log) ? statSync(log).size : 0;
  let code: number | null = null;
  try {
    const template = loadConfig(env).agents[t.agent]?.arm;
    if (!template) throw new Error(`Agent "${t.agent}" is no longer in config.json`);
    const launch = buildLaunch(template, { prompt: readFileSync(promptFile(id, env), 'utf8'), promptFile: promptFile(id, env) }, env);
    appendFileSync(log, `\n=== octomaxxing: run ${t.runs}, ${new Date().toISOString()} ===\n`);
    const fd = openSync(log, 'a');
    // OCTOMAXXING_TASK marks the arm's environment: octomaxxing refuses to manage tasks from inside an arm.
    const opts = { cwd: t.cwd, stdio: ['ignore', fd, fd] as ['ignore', number, number], env: { ...env, OCTOMAXXING_TASK: id }, windowsHide: true };
    const child = launch.shell ? spawn(launch.commandLine as string, { ...opts, shell: true }) : spawn(launch.file, launch.args, opts);
    code = await new Promise<number | null>((done) => {
      child.on('error', (err) => {
        appendFileSync(log, `octomaxxing: the agent could not start: ${err.message}\n`);
        done(null);
      });
      child.on('close', (c) => done(c));
    });
    closeSync(fd);
  } catch (err) {
    appendFileSync(log, `octomaxxing: ${(err as Error).message}\n`);
  } finally {
    clearInterval(heartbeat);
  }
  const output = readFileSync(log).subarray(start).toString('utf8');
  const reported = parseStatus(output);
  mutateTask(
    id,
    (cur) =>
      cur.status !== 'running'
        ? null
        : {
            status: reported?.status ?? (code === 0 ? 'done' : 'failed'),
            summary: reported?.summary || lastLines(output, 1) || `exited with code ${code}`,
            exitCode: code,
            pid: null,
            seen: false,
          },
    env,
  );
  drain(env);
}

/** Give a finished arm a follow-up: it runs again in the same folder with the brief, its last result and every follow-up. */
export function sendFollowUp(id: string, message: string, env: NodeJS.ProcessEnv = process.env): Task {
  if (!message.trim()) throw new Error('The message is empty');
  mutateTask(
    id,
    (cur) => {
      if (!FINISHED.includes(cur.status)) throw new Error(`Task ${id} is ${cur.status}; send works once the arm has finished a run`);
      return { followUps: [...cur.followUps, message.trim()], status: 'queued', seen: true };
    },
    env,
  );
  drain(env);
  return requireTask(id, env);
}

export interface CloseOptions {
  commit?: boolean;
  message?: string;
  force?: boolean;
}

/** Close an arm: optionally commit its work to its branch, then remove its worktree. Never merges or pushes. */
export function closeArm(id: string, opts: CloseOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  const reviewers = listTasks(env).filter((r) => r.reviewOf === id && r.status !== 'closed');
  if (reviewers.length) throw new Error(`Close the review first: ${reviewers.map((r) => r.id).join(', ')}`);
  // Claim the task first: from here on, drain will not start it and the runner will not overwrite it.
  let previous = 'queued' as Task['status'];
  const t = mutateTask(
    id,
    (cur) => {
      if (cur.status === 'closed' || cur.status === 'closing') throw new Error(`Task ${id} is already ${cur.status}`);
      if (cur.status === 'running' && !opts.force) throw new Error(`Task ${id} is still running. Wait for it, or use --force to stop it.`);
      previous = cur.status;
      return { status: 'closing' };
    },
    env,
  );
  try {
    if (previous === 'running' && t.pid && runnerAlive(id, env)) killTree(t.pid);
    const out: string[] = [];
    if (t.worktree && t.repo && t.branch) {
      if (existsSync(t.worktree)) {
        if (opts.commit) {
          const sha = commitAll(t.worktree, t.branch, opts.message?.trim() || t.title);
          out.push(sha ? `Committed ${sha} to branch ${t.branch}:` : 'Nothing to commit.', ...(sha ? committedFiles(t.worktree, sha).map((f) => `  ${f}`) : []));
        } else {
          const changes = changedFiles(t.worktree);
          if (changes.length && !opts.force) throw new Error(`Task ${id} has ${changes.length} changed files. Use --commit to keep them on branch ${t.branch}, or --force to discard them.`);
        }
      }
      removeWorktree(t.repo, t.worktree);
      out.push(deleteBranchIfUnused(t.repo, t.branch, t.baseSha) ? `Removed the unused branch ${t.branch}.` : `Branch ${t.branch} kept. Nothing was merged or pushed.`);
    } else if (opts.commit) {
      out.push('This arm worked in place (not a git worktree), so there is nothing to commit.');
    }
    mutateTask(id, () => ({ status: 'closed', pid: null }), env);
    out.push(`Closed ${id}.`);
    const started = drain(env);
    if (started.length) out.push(`Started queued: ${started.join(', ')}`);
    return out;
  } catch (err) {
    mutateTask(id, () => ({ status: previous === 'running' ? 'failed' : previous, pid: null }), env);
    throw err;
  }
}

/** Arms that finished since the head last looked; marks them seen. */
export function inbox(env: NodeJS.ProcessEnv = process.env): string {
  refresh(env);
  const fresh = listTasks(env).filter((t) => FINISHED.includes(t.status) && !t.seen);
  for (const t of fresh) mutateTask(t.id, () => ({ seen: true }), env);
  if (!fresh.length) return 'Inbox empty.';
  return fresh.map((t) => `${t.id}  ${t.status}  [${t.project}] ${t.title}\n    ${t.summary ?? ''}`).join('\n');
}

function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

export function statusText(id: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  refresh(env);
  if (id) {
    const t = requireTask(id, env);
    const lines = [
      `${t.id}  ${t.status}  [${t.project}] ${t.title}`,
      `agent:   ${t.agent}   runs: ${t.runs}   updated ${age(t.updatedAt)} ago`,
      `folder:  ${t.cwd}${t.branch ? `   branch: ${t.branch}` : ''}${t.reviewOf ? `   reviewing: ${t.reviewOf}` : ''}`,
    ];
    if (t.summary) lines.push(`result:  ${t.summary}`);
    if (t.followUps.length) lines.push(`follow-ups: ${t.followUps.length}`);
    if (t.worktree && existsSync(t.worktree)) {
      const files = changedFiles(t.worktree);
      lines.push(files.length ? `changed files (what close --commit would commit):\n${files.map((f) => `  ${f}`).join('\n')}` : 'changed files: none');
    }
    lines.push(`output:  ${logFile(t.id, env)}`);
    return lines.join('\n');
  }
  const open = listTasks(env).filter((t) => t.status !== 'closed');
  const { maxArms } = loadConfig(env);
  const running = open.filter((t) => t.status === 'running').length;
  const head = `Arms: ${running}/${maxArms} running, ${open.filter((t) => t.status === 'queued').length} queued.`;
  if (!open.length) return `${head} No open tasks.`;
  return [head, ...open.map((t) => `${t.id}  ${t.status.padEnd(8)}  [${t.project}] ${t.title}  (${age(t.updatedAt)})`)].join('\n');
}

const GREETINGS = [
  '🐙 Tentacles warmed up.',
  "🐙 Ready to maxx. Hand me the work, I'll hand it out.",
  '🐙 Head online.',
  '🐙 All arms stretched. Point me at something.',
  '🐙 Octomaxxing online. What are we maxxing today?',
  '🐙 Eight arms, zero excuses.',
];

/** The head's opening lines: a rotating one-liner plus live status. */
export function greeting(env: NodeJS.ProcessEnv = process.env, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  refresh(env);
  const tasks = listTasks(env);
  const { maxArms } = loadConfig(env);
  const free = Math.max(0, maxArms - tasks.filter((t) => t.status === 'running').length);
  const waiting = tasks.filter((t) => FINISHED.includes(t.status) && !t.seen).map((t) => t.id);
  const projects = loadProjects(env).length;
  const status = `${projects} project${projects === 1 ? '' : 's'} · ${free}/${maxArms} arms free · inbox: ${waiting.length ? waiting.join(', ') : 'empty'}`;
  return `${GREETINGS[pick(GREETINGS.length)]}\n${status}`;
}

/** The head's full instructions, for `octomaxxing head` and for the /octomaxxing skill (`octomaxxing brief`). */
export function headPrompt(agent: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = loadConfig(env);
  const others = Object.keys(config.agents).filter((a) => a !== agent);
  const drafts = join(home(env), 'drafts');
  return [
    readPrompt('head.md'),
    `## Your setup\n\n- You run as the "${agent}" agent. Pass \`--agent ${agent}\` to every spawn so arms use the same agent${others.length ? `, unless a task is better suited to another configured agent: ${others.join(', ')}` : ''}.\n- Write briefs and messages to new files in ${drafts} (create the folder if needed) and pass them with \`--brief-file\` or \`--file\`.`,
    `## Start\n\nBegin your first reply with exactly these two lines, then wait for the user:\n\n${greeting(env)}`,
  ].join('\n\n') + '\n';
}

/** Start the head in this terminal and wait for it to exit. */
export async function runHead(agentName: string | undefined, opts: { dryRun?: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const agent = pickAgent(config, agentName, env);
  const template = config.agents[agent]!.head;
  if (!template) throw new Error(`Agent "${agent}" has no "head" template: start the head with /octomaxxing inside it (octomaxxing install-skill), or use --agent with another agent.`);
  const file = join(home(env), 'head-prompt.md');
  const prompt = headPrompt(agent, env);
  const launch = buildLaunch(template, { prompt, promptFile: file }, env);
  if (opts.dryRun) {
    process.stdout.write(`DRY RUN: would start the head (${agent}) in ${home(env)}:\n${describeLaunch(launch)}\n`);
    return 0;
  }
  writeFileSync(file, prompt);
  const childEnv = { ...env, OCTOMAXXING_HOME: home(env) };
  const child = launch.shell
    ? spawn(launch.commandLine as string, { cwd: home(env), stdio: 'inherit', env: childEnv, shell: true })
    : spawn(launch.file, launch.args, { cwd: home(env), stdio: 'inherit', env: childEnv });
  return await new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', (c) => done(c ?? 1));
  });
}

/** Print an arm's output, then keep following it while it runs. */
export async function attach(id: string, env: NodeJS.ProcessEnv = process.env, out: NodeJS.WritableStream = process.stdout): Promise<void> {
  const log = logFile(id, env);
  let offset = 0;
  const flush = () => {
    if (!existsSync(log)) return;
    const buf = readFileSync(log);
    if (buf.length > offset) out.write(buf.subarray(offset));
    offset = buf.length;
  };
  for (;;) {
    flush();
    refresh(env);
    const t = requireTask(id, env);
    if (t.status !== 'running' && t.status !== 'queued') {
      flush();
      out.write(`\n[${t.id} is ${t.status}${t.summary ? `: ${t.summary}` : ''}]\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
