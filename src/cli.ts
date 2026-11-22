#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyHook, attach, amigoPrompt, inbox, runAmigo, runTab, spawnMember, statusText, waitForMembers } from './squad.ts';
import { controlTask } from './control.ts';
import { VALIDATE_MESSAGE } from './delivery.ts';
import { landTask, mergeTask, prCheck } from './merge.ts';
import { reportStatus } from './report.ts';
import { sendMessage } from './steer.ts';
import { runLiveChecks, startBriefing } from './briefing.ts';
import { adoptLegacyEnv } from './legacy.ts';
import { migrateHome } from './migrate.ts';
import { addProject, tangleBranch } from './projects.ts';
import { syncProjects } from './sync.ts';
import { closeMember } from './close.ts';
import { addNote, ensureHome, loadConfig, loadProjects, pickAgent } from './config.ts';
import { resolveId } from './tasks.ts';
import { codeRoot, configPath, home, stateDir } from './paths.ts';
import { installSkills, removeSkills } from './skills.ts';
import { terminalBackend } from './terminal.ts';
import { runNetworkChecks, sessionDigest } from './digest.ts';
import { controlRefusal } from './session.ts';
import { autoArm, turnEndGuard, type HookPayload } from './supervise.ts';
import { ackWakes, describeDrain, drainWakes, readQueue } from './wakes.ts';
import { listChecks, registerCheck, removeCheck, supervisionNeed, watchCycle, watcherHealthy } from './watch.ts';
import { planCommand } from './plan-commands.ts';

export const HELP = `amigo: your right hand. Runs the squad.

  amigo [--agent <name>] [--dry-run]                start amigo in this terminal: a briefing first, then you just talk to it
  amigo install-skill [<agent>] [--remove]          add /amigo to your agent CLIs (all found on PATH, or one)
  amigo brief --agent <name>                        print amigo's instructions and the briefing (what /amigo runs)
  amigo add <git url or path> [--name <name>] [--mode no-mistakes|direct-PR|local-only] [--yolo | --no-yolo] [--branch-prefix <p>]
            [--live <folder>] [--notes <text>] [--live-command <cmd>]... [--watch <text>]...
                                                    clone a project into projects/<name> and register it; the same name and source again updates it
  amigo projects                                    list registered projects
  amigo sync [<project>]                            refresh the clones from origin (fast-forward only; anything unsafe is reported, never touched)
  amigo migrate [--live <project>]... [--drop <project>]... [--dry-run]
                                                    convert a home from before this version: projects become clones, the old gate files go
  amigo note <project> <text>                       add a line to a project's notes (every later squad member gets it)
  amigo spawn (--project <name> | --review <id> | --scratch) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start a squad member; the brief comes from stdin unless --brief-file is given. A build's
                                                    brief is "## Boss's intent" and "## amigo spec"; amigo adds the rules and the definition of done
            [--survey] [--task <backlog id>] [--model <m>] [--effort low|medium|high|xhigh|max] [--boss-max]
                                                    a survey writes data/<id>/report.md and never pushes; --task dispatches a backlog item
  amigo status [<id>]                               tasks by station, or one in detail (status, inbox, PR, uncommitted files)
  amigo inbox                                       squad members that finished since you last looked, and background results
  amigo wait [<id>...] [--timeout-min <n>]          wait until a squad member finishes a turn (default 60 min)
  amigo send <id> [--resolve-key <key>]... [--validate | --file <file> | <message>]
                                                    steer a crew member: the message goes to its durable inbox and its tab is rung
                                                    (--validate: tell a no-mistakes build to run its pipeline; --resolve-key closes that open decision)
  amigo control <id> interrupt|exit|relaunch [--note <text>]
                                                    lifecycle: stop its turn, stop its agent (worktree kept), or start it again with a note
  amigo report <state> [--key <key>] <text>         (crew members) append a status line: working, needs-decision, blocked, paused, done, failed, resolved, note
  amigo attach <id>                                 print a squad member's results and follow it while it runs
  amigo pr-check <id> [<pr url>] [--watch [--timeout-min <n>]]
                                                    read a build's PR live (CI, merge state); a merge on GitHub is recorded and cleaned up after
  amigo merge <id> [--boss] [--pr <url>] [--expected-head <sha>] [--allow-red <check>] [--allow-missing <check>] [--method squash|merge|rebase]
                                                    land a build: a PR only when open, not a draft, mergeable and green at its pinned head;
                                                    local-only by a guarded fast-forward. Without --boss (the Boss said "merge it") only a yolo project
  amigo land <id>                                   finish after a merge: refresh the clone, fast-forward the live folder, clean up once landed
  amigo close <id> [--force]                        tear a crew member down; a build only once its work has landed (--force: the Boss said discard it)
  amigo digest [--again]                            the session-start digest: take the session lock, drain wakes, show the fleet (once per session)
  amigo wake (drain | ack --through <seq> --generation <n> | status)
                                                    the durable wake queue: show it, acknowledge what was handled, or count it
  amigo watch                                       run one watcher cycle here and print the wake it closes on (the Stop hook does this itself)
  amigo check (add <name> [--every <s>] [--cwd <dir>] -- <command>... | rm <name> | list)
                                                    commands the watcher runs on an interval; anything they print wakes amigo
  amigo backlog [<tasks-axi command> [args...]]     the work queue (data/backlog.md) through tasks-axi: list, ready, add, show, update...
  amigo hold <id> --reason <text> [--until YYYY-MM-DD] [--title <t> [--project <p>]] [--origin <survey id>]
                                                    hold a backlog item for the Boss's call (--title creates it); --until defers it to a date
  amigo answer <id> [--release] (<the Boss's words> | --file <file>)
                                                    record the Boss's exact answer: closes the call, or --release lets the held work go on
  amigo complete <survey id> (--none | <held item id>...)
                                                    attest a survey's open Boss calls (or none), so close may tear it down
  amigo dispatch [<rule number> | default]          the dispatch profiles, or one rule resolved to spawn flags
  amigo capacity                                    lanes in use, open lanes and host headroom, and project caps
  amigo help                                        this text (-h or --help anywhere in a command prints it too)
  amigo --version                                   print the version

Data lives in ${'$'}AMIGO_HOME (default ~/.amigo): config/, data/, state/ and projects/.`;

/** Every command the help lists, for the tests that keep the help and the dispatch below in step. */
export const COMMANDS: readonly string[] = ['install-skill', 'brief', 'add', 'projects', 'sync', 'migrate', 'note', 'spawn', 'status', 'inbox', 'wait', 'send', 'control', 'report', 'attach', 'pr-check', 'merge', 'land', 'close', 'digest', 'wake', 'watch', 'check', 'backlog', 'hold', 'answer', 'complete', 'dispatch', 'capacity', 'help'];

function readStdin(what: string): string {
  if (process.stdin.isTTY) throw new Error(`Pass the ${what} on stdin or as a file (see amigo help)`);
  return readFileSync(0, 'utf8');
}

function parse(argv: string[], options: ParseArgsOptionsConfig) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

/** Commands that start, change or close squad members. A squad member must never run them on other squad members. */
// Commands only amigo may run. inbox, wait and brief count too: a squad member running them marks results seen or starts the briefing's checks. So does the bare start.
const MANAGING = new Set(['spawn', 'send', 'control', 'merge', 'land', 'pr-check', 'close', 'install-skill', 'add', 'sync', 'migrate', 'note', 'inbox', 'wait', 'brief', 'wake', 'watch', 'check', 'digest']);
/** Managing commands a read-only session (another session holds the session lock) may still run; the digest says read-only itself. */
const READ_ONLY_OK = new Set(['digest', 'install-skill', 'brief']);
const readOnlyOk = (cmd: string, sub: string | undefined): boolean => READ_ONLY_OK.has(cmd) || (cmd === 'wake' && sub === 'status') || (cmd === 'check' && sub === 'list');

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
  if (cmd === '_amigo-hook') {
    // amigo's own hooks (supervise.ts, digest.ts). Exit 2 carries a wake or a block; any error is logged and the session goes on.
    try {
      const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
      const payload = (raw.trim() ? JSON.parse(raw) : {}) as HookPayload;
      const name = rest[0] ?? '';
      if (name === 'session-start') {
        if (!env.AMIGO_TASK) out(sessionDigest(env, { payloadSession: payload.session_id, once: true }));
        return 0;
      }
      const r = name === 'guard' ? await turnEndGuard(payload, env) : name === 'stop' || name === 'stop-failure' ? await autoArm(payload, env, name) : null;
      if (!r) throw new Error(`unknown amigo hook "${name}"`);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.code;
    } catch (err) {
      appendFileSync(join(stateDir(env), 'hook-errors.log'), `${new Date().toISOString()} amigo ${rest[0]}: ${(err as Error).message}\n`);
      return 0;
    }
  }
  if (cmd === '_netcheck') {
    // The session-start digest's detached network worker.
    await runNetworkChecks(rest[0] ?? '', env);
    return 0;
  }
  if (cmd === '_hook') {
    // A hook must never break the session: errors go to a log and the exit code stays 0.
    try {
      const raw = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
      if (env.AMIGO_TASK) out(await applyHook(rest[0] ?? '', raw.trim() ? JSON.parse(raw) : {}, env.AMIGO_TASK, env));
    } catch (err) {
      appendFileSync(join(stateDir(env), 'hook-errors.log'), `${new Date().toISOString()} ${rest[0]}: ${(err as Error).message}\n`);
    }
    return 0;
  }
  if (env.AMIGO_TASK && (bare || MANAGING.has(cmd))) {
    throw new Error(`You are running inside crew member ${env.AMIGO_TASK}: only amigo can ${bare ? 'start a session' : cmd}. Report back with amigo report instead.`);
  }
  if (MANAGING.has(cmd) && !readOnlyOk(cmd, rest[0])) {
    // One controlling session per home: another Claude session that does not hold the session lock is read-only.
    const refusal = controlRefusal(env);
    if (refusal) throw new Error(refusal);
  }
  if (cmd === '--version') {
    out(String((JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8')) as { version?: string }).version));
    return 0;
  }
  const helping = cmd === 'help';
  const removing = cmd === 'install-skill' && rest.includes('--remove');
  // migrate works on a home in the old layout, which ensureHome refuses.
  if (!removing && !helping && cmd !== 'migrate' && ensureHome(env)) {
    process.stderr.write(
      `Created ${home(env)} (config/, data/, state/, projects/).\nNext: amigo install-skill (or add your agent to ${configPath(env)}, see the README), then: amigo add <git url or path>\n\n`,
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

    case 'migrate': {
      const { values } = parse(rest, { live: { type: 'string', multiple: true }, drop: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } });
      for (const line of migrateHome(env, { live: values.live as string[] | undefined, drop: values.drop as string[] | undefined, dryRun: Boolean(values['dry-run']) })) out(line);
      return 0;
    }

    case 'install-skill': {
      const { values, positionals } = parse(rest, { remove: { type: 'boolean' } });
      const lines = values.remove ? removeSkills(positionals[0]) : installSkills(positionals[0], env);
      for (const line of lines) out(line);
      return 0;
    }

    case 'add': {
      const { values, positionals } = parse(rest, {
        name: { type: 'string' },
        mode: { type: 'string' },
        yolo: { type: 'boolean' },
        'no-yolo': { type: 'boolean' },
        'branch-prefix': { type: 'string' },
        live: { type: 'string' },
        notes: { type: 'string' },
        'live-command': { type: 'string', multiple: true },
        watch: { type: 'string', multiple: true },
      });
      if (!positionals[0]) throw new Error('add needs a git URL or a folder to clone: amigo add <git url or path>');
      if (values.yolo && values['no-yolo']) throw new Error('--yolo and --no-yolo contradict each other');
      // A repeated flag replaces the whole list; an empty value (--watch "") clears it.
      const list = (v: unknown): string[] | undefined => (v === undefined ? undefined : (v as string[]).filter((x) => x.trim() !== ''));
      const { project: p, updated, cloned } = addProject(
        positionals[0],
        {
          name: values.name as string | undefined,
          mode: values.mode as string | undefined,
          yolo: values.yolo ? true : values['no-yolo'] ? false : undefined,
          branchPrefix: values['branch-prefix'] as string | undefined,
          live: values.live as string | undefined,
          notes: values.notes as string | undefined,
          liveCommands: list(values['live-command']),
          watch: list(values.watch),
        },
        env,
      );
      out(`${updated ? 'Updated' : 'Added'} ${p.name}: ${cloned ? 'cloned' : 'clone of'} ${p.source} ${cloned ? 'into' : 'at'} ${p.path}`);
      out(`delivery: ${p.mode}${p.yolo ? ' +yolo (amigo may merge green work itself)' : ', yolo off (the Boss says "merge it")'}; branches ${p.branchPrefix}<task id>`);
      if (p.live) out(`live install: ${p.live} (fast-forwarded after a confirmed merge)`);
      if (p.liveCommands) out(p.liveCommands.length ? `live commands (briefing): ${p.liveCommands.join(' | ')}` : 'live commands (briefing): none');
      if (p.watch?.length) out(`watch (briefing): ${p.watch.join(' | ')}`);
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
        out('No projects yet: amigo add <git url or path>');
        return 0;
      }
      for (const p of projects) {
        const tangled = existsSync(p.path) ? tangleBranch(p.path) : null;
        const state = !existsSync(p.path) ? 'CLONE MISSING' : tangled ? `CLONE ON BRANCH ${tangled}, not its default` : 'clone';
        const extra = [
          p.branchPrefix !== 'amigo/' ? `branches: ${p.branchPrefix}<task id>` : '',
          p.live ? `live install: ${p.live}` : '',
          p.notes ? `notes: ${p.notes.replace(/\n/g, '\n           ')}` : '',
          p.liveCommands ? `live commands: ${p.liveCommands.length ? p.liveCommands.join(' | ') : '(none)'}` : '',
          p.watch?.length ? `watch: ${p.watch.join(' | ')}` : '',
        ].filter(Boolean);
        out([`${p.name}  [${p.mode}${p.yolo ? ' +yolo' : ''}]  ${p.path}  (${state}, from ${p.source})`, ...extra.map((l) => `    ${l}`)].join('\n'));
      }
      return 0;
    }

    case 'sync': {
      const { positionals } = parse(rest, {});
      for (const line of syncProjects(positionals[0], env)) out(line);
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
        survey: { type: 'boolean' },
        task: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        'boss-max': { type: 'boolean' },
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
          ...(values.survey ? { kind: 'survey' as const } : {}),
          task: values.task as string | undefined,
          model: values.model as string | undefined,
          effort: values.effort as string | undefined,
          bossMax: Boolean(values['boss-max']),
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
      const { values, positionals } = parse(rest, { file: { type: 'string' }, 'resolve-key': { type: 'string', multiple: true }, validate: { type: 'boolean' } });
      const [id, ...words] = positionals;
      if (!id) throw new Error('send needs a task id');
      const file = values.file as string | undefined;
      if (values.validate && (file || words.length)) throw new Error('--validate is the whole message: give no other text');
      const message = values.validate ? VALIDATE_MESSAGE : file && file !== '-' ? readFileSync(file, 'utf8') : words.length ? words.join(' ') : readStdin('message');
      for (const line of sendMessage(resolveId(id, env), message, { resolveKeys: values['resolve-key'] as string[] | undefined }, env)) out(line);
      return 0;
    }

    case 'control': {
      const { values, positionals } = parse(rest, { note: { type: 'string' }, 'note-file': { type: 'string' } });
      const [id, verb] = positionals;
      if (!id || !verb) throw new Error('control needs a task id and a verb: amigo control <id> interrupt|exit|relaunch');
      const noteFile = values['note-file'] as string | undefined;
      const note = noteFile ? readFileSync(noteFile, 'utf8') : (values.note as string | undefined);
      for (const line of controlTask(resolveId(id, env), verb, { note }, env)) out(line);
      return 0;
    }

    case 'report': {
      const { values, positionals } = parse(rest, { key: { type: 'string' }, task: { type: 'string' } });
      const [state, ...words] = positionals;
      const id = env.AMIGO_TASK ?? (values.task as string | undefined);
      if (!id) throw new Error('report is for crew members (it runs inside one, where AMIGO_TASK names the task); amigo itself passes --task <id>');
      if (!state) throw new Error('report needs a state: amigo report <state> "<one short line>"');
      out(reportStatus(env.AMIGO_TASK ? id : resolveId(id, env), state, words.join(' '), { key: values.key as string | undefined }, env));
      return 0;
    }

    case 'pr-check': {
      const { values, positionals } = parse(rest, { watch: { type: 'boolean' }, 'timeout-min': { type: 'string' } });
      if (!positionals[0]) throw new Error('pr-check needs a task id');
      const minutes = Number(values['timeout-min'] ?? 60);
      if (!(minutes > 0)) throw new Error('--timeout-min must be a positive number');
      for (const line of await prCheck(resolveId(positionals[0], env), { url: positionals[1], watchMs: values.watch ? minutes * 60_000 : 0 }, env)) out(line);
      return 0;
    }

    case 'merge': {
      const { values, positionals } = parse(rest, {
        boss: { type: 'boolean' },
        pr: { type: 'string' },
        'expected-head': { type: 'string' },
        'allow-red': { type: 'string' },
        'allow-missing': { type: 'string' },
        method: { type: 'string' },
      });
      if (!positionals[0]) throw new Error('merge needs a task id');
      const method = values.method as string | undefined;
      if (method && !['squash', 'merge', 'rebase'].includes(method)) throw new Error('--method is squash, merge or rebase');
      const head = values['expected-head'] as string | undefined;
      if (head && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) throw new Error('--expected-head takes one full lowercase commit id');
      const lines = mergeTask(
        resolveId(positionals[0], env),
        {
          boss: Boolean(values.boss),
          url: values.pr as string | undefined,
          expectedHead: head,
          allowRed: values['allow-red'] as string | undefined,
          allowMissing: values['allow-missing'] as string | undefined,
          method: method as 'squash' | 'merge' | 'rebase' | undefined,
        },
        env,
      );
      for (const line of lines) out(line);
      return 0;
    }

    case 'land': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('land needs a task id');
      for (const line of landTask(resolveId(positionals[0], env), env)) out(line);
      return 0;
    }

    case 'attach': {
      const { positionals } = parse(rest, {});
      if (!positionals[0]) throw new Error('attach needs a task id');
      await attach(resolveId(positionals[0], env), env);
      return 0;
    }

    case 'close': {
      const { values, positionals } = parse(rest, { force: { type: 'boolean' } });
      if (!positionals[0]) throw new Error('close needs a task id');
      for (const line of closeMember(resolveId(positionals[0], env), { force: Boolean(values.force) }, env)) out(line);
      return 0;
    }

    case 'backlog':
    case 'hold':
    case 'answer':
    case 'complete':
    case 'dispatch':
    case 'capacity':
      return await planCommand(cmd, rest, env, out);

    case 'digest': {
      const { values } = parse(rest, { again: { type: 'boolean' } });
      out(sessionDigest(env, { once: !values.again }));
      return 0;
    }

    case 'wake': {
      const { values, positionals } = parse(rest, { through: { type: 'string' }, generation: { type: 'string' } });
      const sub = positionals[0];
      if (sub === 'drain') {
        out(describeDrain(drainWakes(env)));
        return 0;
      }
      if (sub === 'ack') {
        if (values.through === undefined || values.generation === undefined) throw new Error('wake ack needs --through <seq> --generation <n>, exactly as amigo wake drain printed them');
        out(ackWakes(Number(values.through), Number(values.generation), env));
        return 0;
      }
      if (sub === 'status') {
        const q = readQueue(env);
        const need = supervisionNeed(env);
        out(`${q.rows.length} queued wake(s), generation ${q.generation}. Watcher ${watcherHealthy(env) ? 'running' : 'not running'}; supervision ${need.length ? `needed (${need.join(', ')})` : 'not needed'}.`);
        return 0;
      }
      throw new Error('wake needs drain, ack or status (see amigo help)');
    }

    case 'watch': {
      parse(rest, {});
      const r = await watchCycle(env);
      out(r.text);
      return r.kind === 'reason' ? 0 : 1;
    }

    case 'check': {
      const dash = rest.indexOf('--');
      const head = dash < 0 ? rest : rest.slice(0, dash);
      const argv = dash < 0 ? [] : rest.slice(dash + 1);
      const { values, positionals } = parse(head, { every: { type: 'string' }, cwd: { type: 'string' } });
      const [sub, name] = positionals;
      if (sub === 'list') {
        const checks = listChecks(env);
        out(checks.length ? checks.map((c) => `${c.name}  every ${c.every ?? 'default'}s  ${c.argv.join(' ')}${c.cwd ? `  (in ${c.cwd})` : ''}`).join('\n') : 'No checks registered.');
        return 0;
      }
      if (!name) throw new Error('check add|rm needs a name (see amigo help)');
      if (sub === 'rm') {
        out(removeCheck(name, env) ? `Removed check ${name}.` : `No check named ${name}.`);
        return 0;
      }
      if (sub === 'add') {
        if (!argv.length) throw new Error('check add needs the command after --: amigo check add <name> -- <command>...');
        const every = values.every === undefined ? undefined : Number(values.every);
        if (every !== undefined && !(every > 0)) throw new Error('--every takes a number of seconds');
        registerCheck({ name, argv, ...(values.cwd ? { cwd: values.cwd as string } : {}), ...(every ? { every } : {}) }, env);
        out(`Check ${name} registered: the watcher runs it${every ? ` every ${every}s` : ''}, and anything it prints wakes amigo.`);
        return 0;
      }
      throw new Error('check needs add, rm or list (see amigo help)');
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
