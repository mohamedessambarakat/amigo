#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { undoSelfApproved } from './approvals.ts';
import { applyHook, attach, headPrompt, inbox, runHead, runTab, sendFollowUp, spawnArm, statusText, waitForArms } from './arms.ts';
import { closeArm } from './close.ts';
import { confirmGates, gatesConfirmed } from './gates.ts';
import { addNote, addProject, ensureHome, findProject, loadConfig, loadProjects, pickAgent } from './config.ts';
import { describePolicy, policyState, storeApproval } from './policy.ts';
import { isGitRepo } from './git.ts';
import { resolveId } from './tasks.ts';
import { configPath, home } from './paths.ts';
import { installSkills, removeSkills } from './skills.ts';

export const HELP = `octomaxxing: one head agent, many arms.

  octomaxxing head [--agent <name>] [--dry-run]     start the head agent in this terminal
  octomaxxing install-skill [<agent>] [--remove]    add /octomaxxing to your agent CLIs (all found on PATH, or one)
  octomaxxing brief --agent <name>                  print the head instructions (what /octomaxxing runs)
  octomaxxing add <path> [--name <name>] [--notes <text>] [--check <cmd>]... [--risky <glob>]...
                                                    register a project folder; the same name and folder again updates it
  octomaxxing projects                              list registered projects
  octomaxxing note <project> <text>                 add a line to a project's notes (every later arm gets it)
  octomaxxing spawn (--project <name> | --review <id>) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start an arm; the brief comes from stdin unless --brief-file is given
  octomaxxing status [<id>]                         tasks by station, or one in detail (checks, risk, changed files)
  octomaxxing inbox                                 arms that finished since you last looked
  octomaxxing wait [<id>...] [--timeout-min <n>]    wait until an arm finishes a turn (default 60 min)
  octomaxxing send <id> [--file <file> | <message>] follow-up for a finished arm (message from stdin if neither is given)
  octomaxxing attach <id>                           print an arm's results and follow it while it runs
  octomaxxing close <id> [--commit [-m <message>] [--pr] [--self]] [--force]
                                                    finish an arm: --commit keeps its work on branch octomaxxing/<id>; --pr needs an approved policy whose pr is not never
  octomaxxing policy                                show the self-approval policy and whether it is approved
  octomaxxing approve-policy                        approve the policy as it is now (needs a terminal and your typed yes)
  octomaxxing confirm-gates <project>               confirm a project's checks and risky paths as they are now, so --self may rely on them (terminal + typed yes)
  octomaxxing undo <id>                             take back a self-approved commit: delete its branch (never a pushed one)
  octomaxxing help                                  this text

Data lives in ${'$'}OCTOMAXXING_HOME (default ~/.octomaxxing).`;

function readStdin(what: string): string {
  if (process.stdin.isTTY) throw new Error(`Pass the ${what} on stdin or as a file (see octomaxxing help)`);
  return readFileSync(0, 'utf8');
}

/** Only a person at a terminal may say yes: an agent's shell has no TTY, and the answer must be typed. Throws unless they typed `word`. */
async function personSays(command: string, shown: string, word: string, what: string, out: (s: string) => void): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${command} needs an interactive terminal and your typed confirmation. Run it yourself, not through an agent.`);
  out(shown);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType "${word}" ${what}: `);
  rl.close();
  if (answer.trim().toLowerCase() !== word) throw new Error('Not confirmed.');
}

function parse(argv: string[], options: ParseArgsOptionsConfig) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

/** Commands that start, change or close arms. An arm must never run them on other arms. */
// Head-only commands. inbox, wait and brief count too: an arm running them marks results seen or rewrites head.json.
const MANAGING = new Set(['spawn', 'send', 'close', 'install-skill', 'add', 'note', 'approve-policy', 'confirm-gates', 'undo', 'inbox', 'wait', 'brief']);

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd = 'help', ...rest] = argv;
  const out = (s: string) => {
    if (s) process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  };
  // Internal: the command an arm's tab runs, and the Claude Code hooks inside an arm.
  if (cmd === '_tab') {
    const { values, positionals } = parse(rest, { home: { type: 'string' }, run: { type: 'string' }, env: { type: 'string', multiple: true } });
    const extra = Object.fromEntries(
      ((values.env as string[] | undefined) ?? []).filter((kv) => kv.startsWith('OCTOMAXXING_') && kv.includes('=')).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
    const tabEnv = { ...env, ...extra, ...(values.home ? { OCTOMAXXING_HOME: values.home as string } : {}) };
    return await runTab(positionals[0] ?? '', tabEnv, values.run === undefined ? undefined : Number(values.run));
  }
  if (cmd === '_hook') {
    // A hook must never break the session: errors go to a log and the exit code stays 0.
    try {
      const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
      if (env.OCTOMAXXING_TASK) out(await applyHook(rest[0] ?? '', raw.trim() ? JSON.parse(raw) : {}, env.OCTOMAXXING_TASK, env));
    } catch (err) {
      appendFileSync(join(home(env), 'hook-errors.log'), `${new Date().toISOString()} ${rest[0]}: ${(err as Error).message}\n`);
    }
    return 0;
  }
  if (env.OCTOMAXXING_TASK && MANAGING.has(cmd)) {
    throw new Error(`You are running inside arm ${env.OCTOMAXXING_TASK}: only the head can ${cmd}. Report back with a STATUS line instead.`);
  }
  const removing = cmd === 'install-skill' && rest.includes('--remove');
  if (!removing && ensureHome(env)) {
    process.stderr.write(
      `Created ${home(env)} (config.json, projects.json).\nNext: octomaxxing install-skill (or add your agent to ${configPath(env)}, see the README), then: octomaxxing add <project folder>\n\n`,
    );
  }
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      if (Object.keys(loadConfig(env).agents).length === 0) out(`\nNo agent configured yet: run octomaxxing install-skill, or edit ${configPath(env)}.`);
      return 0;

    case 'head': {
      const { values } = parse(rest, { agent: { type: 'string' }, 'dry-run': { type: 'boolean' } });
      return await runHead(values.agent as string | undefined, { dryRun: Boolean(values['dry-run']) }, env);
    }

    case 'brief': {
      const { values } = parse(rest, { agent: { type: 'string' } });
      const agent = pickAgent(loadConfig(env), values.agent as string | undefined, env);
      out(headPrompt(agent, env));
      return 0;
    }

    case 'install-skill': {
      const { values, positionals } = parse(rest, { remove: { type: 'boolean' } });
      const lines = values.remove ? removeSkills(positionals[0]) : installSkills(positionals[0], env);
      for (const line of lines) out(line);
      return 0;
    }

    case 'add': {
      const { values, positionals } = parse(rest, { name: { type: 'string' }, notes: { type: 'string' }, check: { type: 'string', multiple: true }, risky: { type: 'string', multiple: true } });
      if (!positionals[0]) throw new Error('add needs a folder: octomaxxing add <path>');
      // A repeated flag replaces the whole list; an empty value (--check "") clears it.
      const list = (v: unknown): string[] | undefined => (v === undefined ? undefined : (v as string[]).filter((x) => x.trim() !== ''));
      const { project: p, updated } = addProject(positionals[0], { name: values.name as string | undefined, notes: values.notes as string | undefined, checks: list(values.check), risky: list(values.risky) }, env);
      out(`${updated ? 'Updated' : 'Added'} ${p.name} -> ${p.path} (${isGitRepo(p.path) ? 'git: each arm gets its own worktree' : 'not git: one arm at a time works in the folder itself'})`);
      out(p.checks?.length ? `checks: ${p.checks.join(' | ')}` : 'checks: none (finished work will show as unverified)');
      if (p.risky?.length) out(`risky paths: ${p.risky.join(', ')}`);
      if ((p.checks?.length || p.risky?.length) && !gatesConfirmed(p, env)) out(`These checks and risky paths are not confirmed by you yet, so close --self refuses for ${p.name}. To confirm, run in a terminal: octomaxxing confirm-gates ${p.name}`);
      return 0;
    }

    case 'note': {
      const { positionals } = parse(rest, {});
      const [name, ...words] = positionals;
      if (!name) throw new Error('note needs a project: octomaxxing note <project> <text>');
      const text = words.length ? words.join(' ') : readStdin('note');
      addNote(name, text, env);
      out(`Added to the notes of ${name}: every arm started from now on gets it.`);
      return 0;
    }

    case 'projects': {
      parse(rest, {});
      const projects = loadProjects(env);
      if (!projects.length) {
        out('No projects yet: octomaxxing add <path>');
        return 0;
      }
      for (const p of projects) {
        const mode = !existsSync(p.path) ? 'MISSING FOLDER' : isGitRepo(p.path) ? 'git, worktree per arm' : 'in place, one arm at a time';
        out(`${p.name}  ${p.path}  (${mode})${p.notes ? `\n    notes: ${p.notes.replace(/\n/g, '\n           ')}` : ''}${p.checks?.length ? `\n    checks: ${p.checks.join(' | ')}` : ''}${p.risky?.length ? `\n    risky paths: ${p.risky.join(', ')}` : ''}`);
      }
      return 0;
    }

    case 'spawn': {
      const { values } = parse(rest, {
        project: { type: 'string' },
        review: { type: 'string' },
        title: { type: 'string' },
        agent: { type: 'string' },
        after: { type: 'string' },
        issue: { type: 'string' },
        'brief-file': { type: 'string' },
        'dry-run': { type: 'boolean' },
      });
      const file = values['brief-file'] as string | undefined;
      const issue = values.issue === undefined ? undefined : Number(values.issue);
      if (issue !== undefined && !/^\d+$/.test(values.issue as string)) throw new Error('--issue takes an issue number');
      // An issue is a brief by itself: with no brief file and nothing piped in, it is used alone.
      const brief = file && file !== '-' ? readFileSync(file, 'utf8') : issue !== undefined && process.stdin.isTTY ? '' : readStdin('brief');
      const { text } = spawnArm(
        {
          brief,
          project: values.project as string | undefined,
          review: values.review === undefined ? undefined : resolveId(values.review as string, env),
          title: values.title as string | undefined,
          agent: values.agent as string | undefined,
          after: values.after === undefined ? undefined : resolveId(values.after as string, env),
          issue,
        },
        { dryRun: Boolean(values['dry-run']) },
        env,
      );
      out(text);
      return 0;
    }

    case 'status': {
      const { positionals } = parse(rest, {});
      out(statusText(positionals[0] === undefined ? undefined : resolveId(positionals[0], env), env));
      return 0;
    }

    case 'inbox':
      parse(rest, {});
      out(inbox(env));
      return 0;

    case 'wait': {
      const { values, positionals } = parse(rest, { 'timeout-min': { type: 'string' } });
      const minutes = Number(values['timeout-min'] ?? 60);
      if (!(minutes > 0)) throw new Error('--timeout-min must be a positive number');
      out(await waitForArms(positionals.map((r) => resolveId(r, env)), minutes * 60_000, env));
      return 0;
    }

    case 'send': {
      const { values, positionals } = parse(rest, { file: { type: 'string' } });
      const [id, ...words] = positionals;
      if (!id) throw new Error('send needs a task id');
      const file = values.file as string | undefined;
      const message = file && file !== '-' ? readFileSync(file, 'utf8') : words.length ? words.join(' ') : readStdin('message');
      const t = sendFollowUp(resolveId(id, env), message, env);
      out(`${t.id} ${t.status === 'running' ? 'is running again' : t.status === 'failed' ? `could not restart: ${t.summary}` : 'will reopen with your follow-up as soon as its old tab has closed and memory allows'}.`);
      return 0;
    }

    case 'attach': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('attach needs a task id');
      await attach(resolveId(positionals[0], env), env);
      return 0;
    }

    case 'close': {
      const { values, positionals } = parse(rest, {
        commit: { type: 'boolean' },
        message: { type: 'string', short: 'm' },
        force: { type: 'boolean' },
        pr: { type: 'boolean' },
        self: { type: 'boolean' },
      });
      if (!positionals[0]) throw new Error('close needs a task id');
      if (values.message && !values.commit) throw new Error('-m only makes sense with --commit');
      const opts = { commit: Boolean(values.commit), message: values.message as string | undefined, force: Boolean(values.force), pr: Boolean(values.pr), self: Boolean(values.self) };
      for (const line of closeArm(resolveId(positionals[0], env), opts, env)) out(line);
      return 0;
    }

    case 'policy':
      parse(rest, {});
      out(describePolicy(policyState(env)));
      return 0;

    case 'approve-policy': {
      parse(rest, {});
      await personSays('approve-policy', describePolicy(policyState(env)), 'approve', 'to let agents self-approve work under exactly this policy', out);
      storeApproval(env);
      out('Approved. Any later edit to policy.json switches self-approval off again.');
      return 0;
    }

    case 'confirm-gates': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('confirm-gates needs a project: octomaxxing confirm-gates <project>');
      const p = findProject(loadProjects(env), positionals[0]);
      const shown = `project ${p.name}\nchecks:      ${p.checks?.length ? p.checks.join(' | ') : '(none)'}\nrisky paths: ${p.risky?.length ? p.risky.join(', ') : '(none beyond the built-in ones)'}`;
      await personSays('confirm-gates', shown, 'confirm', `that ${p.name} is gated by exactly these checks and risky paths`, out);
      confirmGates(p.name, env);
      out("Confirmed. Any later change to this project's checks or risky paths needs confirming again before --self works.");
      return 0;
    }

    case 'undo': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('undo needs a task id');
      for (const line of undoSelfApproved(resolveId(positionals[0], env), env)) out(line);
      return 0;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run: octomaxxing help`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`octomaxxing: ${err.message}\n`);
      process.exit(1);
    },
  );
}
