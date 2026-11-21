import { spawnSync } from 'node:child_process';
import { resolveExecutable, quoteForCmd } from './command.ts';
import { run, type RunResult } from './proc.ts';

/** The GitHub CLI: `gh` on PATH, or OCTOMAXXING_GH (a path to another program, for tests). */
export function ghPath(env: NodeJS.ProcessEnv): string | null {
  return resolveExecutable(env.OCTOMAXXING_GH || 'gh', env);
}

export function requireGh(env: NodeJS.ProcessEnv): string {
  const file = ghPath(env);
  if (!file) throw new Error('The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run "gh auth login", or leave out --pr / --issue.');
  return file;
}

/** Can this title reach gh? A Windows .cmd shim cannot carry a double quote, a percent sign or a newline. Throws before anything is pushed. */
export function checkPrTitle(title: string, gh: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(gh)) return;
  try {
    quoteForCmd(title);
  } catch {
    throw new Error(`The pull request title ${JSON.stringify(title.slice(0, 80))} cannot be passed to the gh .cmd shim (no ", % or line breaks). Close without --pr, or give the task a plainer title.`);
  }
}

/** Run gh in `cwd`. A Windows .cmd shim only starts through cmd.exe. */
export function runGh(args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  const file = requireGh(env);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const r = spawnSync([file, ...args].map(quoteForCmd).join(' '), { cwd, encoding: 'utf8', shell: true, windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  }
  return run(file, args, { cwd });
}

function ghOrThrow(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const r = runGh(args, cwd, env);
  if (r.error) throw new Error(`gh failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Read a GitHub issue of the repo in `cwd` (read only). */
export function fetchIssue(number: number, cwd: string, env: NodeJS.ProcessEnv): Issue {
  const raw = ghOrThrow(['issue', 'view', String(number), '--json', 'title,body,url'], cwd, env);
  const j = JSON.parse(raw) as Partial<Issue>;
  if (typeof j.title !== 'string' || typeof j.url !== 'string') throw new Error(`gh issue view ${number}: unexpected answer`);
  return { number, title: j.title, body: j.body ?? '', url: j.url };
}

/** Open a draft pull request from `branch` (already pushed) against the repo's default branch. Returns its URL. */
export function openDraftPr(repo: string, branch: string, title: string, bodyFile: string, env: NodeJS.ProcessEnv): string {
  const out = ghOrThrow(['pr', 'create', '--draft', '--head', branch, '--title', title, '--body-file', bodyFile], repo, env);
  const url = out.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => /^https?:\/\/\S+$/.test(l));
  if (!url) throw new Error(`gh pr create did not print the pull request URL. It said: ${out.trim()}`);
  return url;
}
