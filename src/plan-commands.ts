import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { decodeOutput, runAxi } from './backlog.ts';
import { capacityReport } from './capacity.ts';
import { dispatchText } from './dispatch.ts';
import { answerBoss, completeSurvey, holdForBoss } from './holds.ts';
import { listTasks, resolveId } from './tasks.ts';

/** The planning commands: the backlog, Boss holds, a survey's completion gate, dispatch profiles and capacity. */
export async function planCommand(cmd: string, rest: string[], env: NodeJS.ProcessEnv, out: (s: string) => void): Promise<number> {
  const member = env.AMIGO_TASK;
  const managing = (what: string) => {
    if (member) throw new Error(`You are running inside crew member ${member}: only amigo can ${what}. Report back with a STATUS line instead.`);
  };
  const parse = (options: ParseArgsOptionsConfig) => parseArgs({ args: rest, options, allowPositionals: true, strict: true });

  switch (cmd) {
    case 'backlog': {
      managing('change or read the backlog');
      // Everything is passed to tasks-axi as given, on this home's backlog. A --file would silently fork it, and add --start would
      // put an item In flight with no crew member behind it: spawn starts items.
      if (rest.some((a) => a === '--file' || a.startsWith('--file='))) throw new Error('amigo backlog always works on this home\'s data/backlog.md: drop --file');
      if ((rest[0] === 'add' || rest[0] === 'create') && rest.includes('--start')) throw new Error('add --start would put an item In flight with no crew member: add it Queued and let amigo spawn --task start it');
      if (rest[0] === 'setup') throw new Error('tasks-axi setup changes your agent hooks: ask the Boss, then run it yourself outside amigo');
      // tasks-axi runs from the data folder: a relative --to or --*-file value keeps meaning the caller's folder.
      const args = rest.map((a, i) => {
        const prev = rest[i - 1] ?? '';
        if (/^--(to|[a-z-]+-file)$/.test(prev) && a !== '-') return resolve(a);
        const m = /^(--(?:to|[a-z-]+-file))=(.+)$/.exec(a);
        return m ? `${m[1]}=${resolve(m[2] as string)}` : a;
      });
      const r = runAxi(args.length ? args : ['list'], env);
      const show = ['list', 'show', 'view', 'ready'].includes(rest[0] ?? 'list') ? decodeOutput : (s: string) => s;
      if (r.stdout) process.stdout.write(show(r.stdout));
      if (r.stderr) process.stderr.write(r.stderr);
      return r.status ?? 1;
    }

    case 'hold': {
      managing('hold work for the Boss');
      const { values, positionals } = parse({ reason: { type: 'string' }, until: { type: 'string' }, title: { type: 'string' }, project: { type: 'string' }, origin: { type: 'string' } });
      if (!positionals[0]) throw new Error('hold needs a backlog item id: amigo hold <id> --reason "<question and options>"');
      const origin = values.origin === undefined ? undefined : resolveId(values.origin as string, env);
      for (const line of holdForBoss(positionals[0], { reason: (values.reason as string | undefined) ?? '', until: values.until as string | undefined, title: values.title as string | undefined, project: values.project as string | undefined, origin }, env)) out(line);
      return 0;
    }

    case 'answer': {
      managing("record the Boss's answer");
      const { values, positionals } = parse({ file: { type: 'string' }, release: { type: 'boolean' } });
      const [id, ...words] = positionals;
      if (!id) throw new Error('answer needs a backlog item id: amigo answer <id> [--release] (<the Boss\'s words> | --file <file>)');
      const file = values.file as string | undefined;
      const text = file ? readFileSync(file, 'utf8') : words.join(' ');
      for (const line of answerBoss(id, text, { release: Boolean(values.release) }, env)) out(line);
      return 0;
    }

    case 'complete': {
      const { values, positionals } = parse({ none: { type: 'boolean' } });
      const [ref, ...holds] = positionals;
      if (!ref) throw new Error('complete needs a survey: amigo complete <survey id> (--none | <held item id>...)');
      const origin = member ? ref : resolveId(ref, env);
      // A survey may attest only its own empty inventory; a non-empty one is amigo's to record.
      if (member && (origin !== member || !values.none || holds.length)) throw new Error(`You are running inside crew member ${member}: you may only run "complete ${member} --none". List the open Boss calls in your report instead.`);
      for (const line of completeSurvey(origin, holds, Boolean(values.none), env)) out(line);
      return 0;
    }

    case 'dispatch': {
      const { positionals } = parse({});
      out(dispatchText(positionals[0], env));
      return 0;
    }

    case 'capacity': {
      parse({});
      const report = capacityReport(listTasks(env), env);
      out(report.text);
      return report.ok ? 0 : 1;
    }

    default:
      throw new Error(`Unknown command "${cmd}"`);
  }
}
