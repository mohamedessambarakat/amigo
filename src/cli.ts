#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { undoSelfApproved } from './approvals.ts';
import { applyHook, attach, amigoPrompt, inbox, runAmigo, runTab, sendFollowUp, spawnMember, statusText, waitForMembers } from './squad.ts';
import { runLiveChecks, startBriefing } from './briefing.ts';
import { adoptLegacyEnv } from './legacy.ts';
import { legacyHomeHint, migrateOldHome } from './migrate.ts';
import { closeMember } from './close.ts';
import { confirmGates, gatesConfirmed } from './gates.ts';
import { addNote, addProject, ensureHome, findProject, loadConfig, loadProjects, pickAgent } from './config.ts';
import { describePolicy, policyState, storeApproval } from './policy.ts';
import { isGitRepo } from './git.ts';
import { resolveId } from './tasks.ts';
import { codeRoot, configPath, home } from './paths.ts';
import { installSkills, removeSkills } from './skills.ts';
import { terminalBackend } from './terminal.ts';

export const HELP = `amigo: your right hand. Runs the squad.

  amigo [--agent <name>] [--dry-run]                start amigo in this terminal: a briefing first, then you just talk to it
  amigo install-skill [<agent>] [--remove]          add /amigo to your agent CLIs (all found on PATH, or one)
  amigo brief --agent <name>                        print amigo's instructions and the briefing (what /amigo runs)
  amigo add <path> [--name <name>] [--notes <text>] [--check <cmd>]... [--risky <glob>]... [--live <cmd>]... [--watch <text>]...
                                                    register a project folder; the same name and folder again updates it
  amigo projects                                    list registered projects
  amigo note <project> <text>                       add a line to a project's notes (every later squad member gets it)
  amigo spawn (--project <name> | --review <id> | --scratch) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start a squad member; the brief comes from stdin unless --brief-file is given
  amigo status [<id>]                               tasks by station, or one in detail (checks, risk, changed files)
  amigo inbox                                       squad members that finished since you last looked, and background results
  amigo wait [<id>...] [--timeout-min <n>]          wait until a squad member finishes a turn (default 60 min)
  amigo send <id> [--file <file> | <message>]       follow-up for a finished squad member (message from stdin if neither is given)
  amigo attach <id>                                 print a squad member's results and follow it while it runs
  amigo close <id> [--commit [-m <message>] [--pr] [--self]] [--force]
                                                    finish a squad member: --commit keeps its work on branch amigo/<id>; --pr needs an approved policy whose pr is not never
  amigo policy                                      show the self-approval policy and whether it is approved
  amigo approve-policy                              approve the policy as it is now (needs a terminal and your typed yes)
  amigo confirm-gates <project>                     confirm a project's checks, risky paths, live commands and watch items as they are now, so --self and the briefing may rely on them (terminal + typed yes)
  amigo undo <id>                                   take back a self-approved commit: delete its branch (never a pushed one)
  amigo help                                        this text (-h or --help anywhere in a command prints it too)
  amigo --version                                   print the version

Data lives in ${'$'}AMIGO_HOME (default ~/.amigo).`;

/** Every command the help lists, for the tests that keep the help and the dispatch below in step. */
export const COMMANDS: readonly string[] = ['install-skill', 'brief', 'add', 'projects', 'note', 'spawn', 'status', 'inbox', 'wait', 'send', 'attach', 'close', 'policy', 'approve-policy', 'confirm-gates', 'undo', 'help'];

function readStdin(what: string): string {
  if (process.stdin.isTTY) throw new Error(`Pass the ${what} on stdin or as a file (see amigo help)`);
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

/** Commands that start, change or close squad members. A squad member must never run them on other squad members. */
// Commands only amigo may run. inbox, wait and brief count too: a squad member running them marks results seen or starts the briefing's checks. So does the bare start.
const MANAGING = new Set(['spawn', 'send', 'close', 'install-skill', 'add', 'note', 'approve-policy', 'confirm-gates', 'undo', 'inbox', 'wait', 'brief']);

export async function main(argv: string[], rawEnv: NodeJS.ProcessEnv = process.env): Promise<number> {
  // A session the former name started still counts as a squad member, in the home it was started with.
  const env = adoptLegacyEnv(rawEnv);
  const internal = argv[0]?.startsWith('_') ?? false;
  // -h or --help anywhere asks for the help; nothing else runs.
  const wantsHelp = !internal && argv.some((a) => a === '--help' || a === '-h');
  // No command, or only flags (amigo --agent claude, amigo --dry-run): start amigo in this terminal.
  const bare = !wantsHelp && argv[0] !== '--version' && (argv.length === 0 || argv[0]!.startsWith('-'));
  const [cmd = '', ...rest] = wantsHelp ? ['help'] : bare ? ['', ...argv] : argv;
  const out = (s: string) => {
    if (s) process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  };
  // Internal: the command a squad member's tab runs, and the Claude Code hooks inside a squad member.
  if (cmd === '_tab') {
    const { values, positionals } = parse(rest, { home: { type: 'string' }, run: { type: 'string' }, env: { type: 'string', multiple: true } });
    const extra = Object.fromEntries(
      ((values.env as string[] | undefined) ?? []).filter((kv) => kv.startsWith('AMIGO_') && kv.includes('=')).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
    const tabEnv = { ...env, ...extra, ...(values.home ? { AMIGO_HOME: values.home as string } : {}) };
    return await runTab(positionals[0] ?? '', tabEnv, values.run === undefined ? undefined : Number(values.run));
  }
  if (cmd === '_live') {
    // The briefing's detached process: it runs the projects' live commands and fills in the inbox notice.
    await runLiveChecks(rest[0] ?? '', env);
    return 0;
  }
  if (cmd === '_hook') {
    // A hook must never break the session: errors go to a log and the exit code stays 0.
    try {
      const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
      if (env.AMIGO_TASK) out(await applyHook(rest[0] ?? '', raw.trim() ? JSON.parse(raw) : {}, env.AMIGO_TASK, env));
    } catch (err) {
      appendFileSync(join(home(env), 'hook-errors.log'), `${new Date().toISOString()} ${rest[0]}: ${(err as Error).message}\n`);
    }
    return 0;
  }
  if (env.AMIGO_TASK && (bare || MANAGING.has(cmd))) {
    throw new Error(`You are running inside squad member ${env.AMIGO_TASK}: only amigo can ${bare ? 'start a session' : cmd}. Report back with a STATUS line instead.`);
  }
  if (cmd === '--version') {
    out(String((JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8')) as { version?: string }).version));
    return 0;
  }
  const helping = cmd === 'help';
  // Once: the home of the former name moves to ~/.amigo (it refuses while tasks are running; help still works). A squad member never moves anything.
  if (!helping && !env.AMIGO_TASK) {
    const hint = legacyHomeHint(env);
    if (hint) process.stderr.write(`${hint}\n`);
    const moved = migrateOldHome(env);
    if (moved) process.stderr.write(`${moved}\n`);
  }
  const removing = cmd === 'install-skill' && rest.includes('--remove');
  if (!removing && !helping && ensureHome(env)) {
    process.stderr.write(
      `Created ${home(env)} (config.json, projects.json).\nNext: amigo install-skill (or add your agent to ${configPath(env)}, see the README), then: amigo add <project folder>\n\n`,
    );
  }
  switch (cmd) {
    case 'help':
      out(HELP);
      if (Object.keys(loadConfig(env).agents).length === 0) out(`\nNo agent configured yet: run amigo install-skill, or edit ${configPath(env)}.`);
      return 0;

    case '': {
      const { values } = parse(rest, { agent: { type: 'string' }, 'dry-run': { type: 'boolean' } });
      const dryRun = Boolean(values['dry-run']);
      // amigo starts only inside herdr-app: this throws with the reason anywhere else, before the briefing starts anything.
      terminalBackend(env);
      const agent = pickAgent(loadConfig(env), values.agent as string | undefined, env);
      const briefing = startBriefing(agent, env, { dryRun });
      return await runAmigo(agent, { dryRun, briefing: briefing.text, live: briefing.live }, env);
    }

    case 'brief': {
      const { values } = parse(rest, { agent: { type: 'string' } });
      terminalBackend(env);
      const agent = pickAgent(loadConfig(env), values.agent as string | undefined, env);
      const briefing = startBriefing(agent, env);
      out(amigoPrompt(agent, env, briefing.text, { live: briefing.live }));
      return 0;
    }

    case 'install-skill': {
      const { values, positionals } = parse(rest, { remove: { type: 'boolean' } });
      const lines = values.remove ? removeSkills(positionals[0]) : installSkills(positionals[0], env);
      for (const line of lines) out(line);
      return 0;
    }

    case 'add': {
      const { values, positionals } = parse(rest, { name: { type: 'string' }, notes: { type: 'string' }, check: { type: 'string', multiple: true }, risky: { type: 'string', multiple: true }, live: { type: 'string', multiple: true }, watch: { type: 'string', multiple: true } });
      if (!positionals[0]) throw new Error('add needs a folder: amigo add <path>');
      // A repeated flag replaces the whole list; an empty value (--check "") clears it.
      const list = (v: unknown): string[] | undefined => (v === undefined ? undefined : (v as string[]).filter((x) => x.trim() !== ''));
      const { project: p, updated } = addProject(positionals[0], { name: values.name as string | undefined, notes: values.notes as string | undefined, checks: list(values.check), risky: list(values.risky), live: list(values.live), watch: list(values.watch) }, env);
      out(`${updated ? 'Updated' : 'Added'} ${p.name} -> ${p.path} (${isGitRepo(p.path) ? 'git: each squad member gets its own worktree' : 'not git: one squad member at a time works in the folder itself'})`);
      out(p.checks?.length ? `checks: ${p.checks.join(' | ')}` : 'checks: none (finished work will show as unverified)');
      if (p.risky?.length) out(`risky paths: ${p.risky.join(', ')}`);
      if (p.live) out(p.live.length ? `live commands (briefing): ${p.live.join(' | ')}` : 'live commands (briefing): none');
      if (p.watch?.length) out(`watch (briefing): ${p.watch.join(' | ')}`);
      if ((p.checks?.length || p.risky?.length || p.live?.length || p.watch?.length) && !gatesConfirmed(p, env)) out(`These checks and risky paths${p.live?.length || p.watch?.length ? ', live commands and watch items' : ''} are not confirmed by you yet, so close --self refuses for ${p.name}${p.live?.length || p.watch?.length ? ', and the briefing skips its live commands and watch items' : ''}. To confirm, run in a terminal: amigo confirm-gates ${p.name}`);
      return 0;
    }

    case 'note': {
      const { positionals } = parse(rest, {});
      const [name, ...words] = positionals;
      if (!name) throw new Error('note needs a project: amigo note <project> <text>');
      const text = words.length ? words.join(' ') : readStdin('note');
      addNote(name, text, env);
      out(`Added to the notes of ${name}: every squad member started from now on gets it.`);
      return 0;
    }

    case 'projects': {
      parse(rest, {});
      const projects = loadProjects(env);
      if (!projects.length) {
        out('No projects yet: amigo add <path>');
        return 0;
      }
      for (const p of projects) {
        const mode = !existsSync(p.path) ? 'MISSING FOLDER' : isGitRepo(p.path) ? 'git, worktree per squad member' : 'in place, one squad member at a time';
        out(`${p.name}  ${p.path}  (${mode})${p.notes ? `\n    notes: ${p.notes.replace(/\n/g, '\n           ')}` : ''}${p.checks?.length ? `\n    checks: ${p.checks.join(' | ')}` : ''}${p.risky?.length ? `\n    risky paths: ${p.risky.join(', ')}` : ''}${p.live ? `\n    live: ${p.live.length ? p.live.join(' | ') : '(none)'}` : ''}${p.watch?.length ? `\n    watch: ${p.watch.join(' | ')}` : ''}`);
      }
      return 0;
    }

    case 'spawn': {
      const { values } = parse(rest, {
        project: { type: 'string' },
        review: { type: 'string' },
        scratch: { type: 'boolean' },
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
      const { text } = spawnMember(
        {
          brief,
          project: values.project as string | undefined,
          review: values.review === undefined ? undefined : resolveId(values.review as string, env),
          scratch: Boolean(values.scratch),
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
      out(await waitForMembers(positionals.map((r) => resolveId(r, env)), minutes * 60_000, env));
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
      for (const line of closeMember(resolveId(positionals[0], env), opts, env)) out(line);
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
      if (!positionals[0]) throw new Error('confirm-gates needs a project: amigo confirm-gates <project>');
      const p = findProject(loadProjects(env), positionals[0]);
      const shown = `project ${p.name}\nchecks:      ${p.checks?.length ? p.checks.join(' | ') : '(none)'}\nrisky paths: ${p.risky?.length ? p.risky.join(', ') : '(none beyond the built-in ones)'}${p.live?.length ? `\nlive:        ${p.live.join(' | ')}` : ''}${p.watch?.length ? `\nwatch:       ${p.watch.join(' | ')}` : ''}`;
      await personSays('confirm-gates', shown, 'confirm', `that ${p.name} is gated by exactly these checks and risky paths, and may run exactly these live commands and hand exactly these watch items to an agent at every start`, out);
      confirmGates(p.name, env);
      out("Confirmed. Any later change to this project's checks, risky paths, live commands or watch items needs confirming again before --self works or the briefing uses them.");
      return 0;
    }

    case 'undo': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('undo needs a task id');
      for (const line of undoSelfApproved(resolveId(positionals[0], env), env)) out(line);
      return 0;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run: amigo help`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`amigo: ${err.message}\n`);
      process.exit(1);
    },
  );
}
