// A stand-in for tasks-axi in tests: the commands amigo uses, on a JSON store at the --file path, with tasks-axi's output shapes
// (a JSON object for a mutation with --json, a TOON table for list, `error:` lines and a non-zero exit for a refusal).
// FAKE_TASKS_AXI_VERSION overrides the version it reports; FAKE_TASKS_AXI_FAIL=<command> makes that command fail.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(process.env.FAKE_TASKS_AXI_VERSION || '0.2.6');
  process.exit(0);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const fail = (msg, code = 2) => {
  console.error(`error: ${JSON.stringify(msg)}`);
  process.exit(code);
};
const file = opt('--file');
if (!file) fail('fake tasks-axi needs --file');
const [cmd, id] = args;
if (process.env.FAKE_TASKS_AXI_FAIL === cmd) fail(`fake failure of ${cmd}`, 1);
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { tasks: [] });
const db = load();
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
const today = new Date().toISOString().slice(0, 10);
const find = (x) => db.tasks.find((t) => t.id === x) ?? fail(`Task "${x}" not found in this backlog`, 1);
const result = (action, t) => {
  save();
  if (args.includes('--json')) console.log(JSON.stringify({ ok: true, action, task: t }, null, 2));
  else console.log(`${action}: ${t.id}`);
  process.exit(0);
};

switch (cmd) {
  case 'add': {
    if (db.tasks.some((t) => t.id === id)) fail(`Task "${id}" already exists`);
    const blocked = all('--blocked-by');
    for (const b of blocked) if (!db.tasks.some((t) => t.id === b)) fail(`blocked-by "${b}" does not exist`);
    const t = { id, title: args[2], state: args.includes('--start') ? 'in_flight' : 'queued', kind: opt('--kind') ?? 'task', repo: opt('--repo') ?? null, blocked_by: blocked, hold: null, closed: null, body: '', links: [] };
    db.tasks.push(t);
    result('add', t);
    break;
  }
  case 'start':
    result('start', Object.assign(find(id), { state: 'in_flight' }));
    break;
  case 'reopen':
    result('reopen', Object.assign(find(id), { state: 'queued', closed: null }));
    break;
  case 'rm': {
    find(id);
    db.tasks = db.tasks.filter((t) => t.id !== id);
    save();
    console.log(JSON.stringify({ ok: true, action: 'rm', id }));
    process.exit(0);
    break;
  }
  case 'done': {
    const t = find(id);
    const pr = opt('--pr');
    if (pr && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr)) fail('Task pr link must be a canonical pull request URL');
    for (const [flag, kind] of [['--pr', 'pr'], ['--report', 'report']]) if (opt(flag)) t.links.push({ kind, value: opt(flag) });
    if (opt('--note')) t.body = [t.body, opt('--note')].filter(Boolean).join('\n');
    result('done', Object.assign(t, { state: 'done', closed: t.closed ?? today }));
    break;
  }
  case 'hold': {
    const reason = opt('--reason');
    if (!reason) fail('--reason is required');
    if (/[()\n]/.test(reason)) fail('--reason must not contain parentheses');
    const until = opt('--until');
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail('--until must be YYYY-MM-DD');
    result('hold', Object.assign(find(id), { hold: { reason, kind: opt('--kind') ?? null, until: until ?? null } }));
    break;
  }
  case 'unhold':
    result('unhold', Object.assign(find(id), { hold: null }));
    break;
  case 'update': {
    const t = find(id);
    const bodyFile = opt('--body-file');
    if (!bodyFile && !opt('--pr') && !opt('--report') && !opt('--kind') && !opt('--title')) fail('Nothing to update');
    if (bodyFile) t.body = readFileSync(bodyFile, 'utf8');
    if (opt('--kind')) t.kind = opt('--kind');
    if (opt('--title')) t.title = opt('--title');
    for (const [flag, kind] of [['--pr', 'pr'], ['--report', 'report']]) if (opt(flag)) t.links.push({ kind, value: opt(flag) });
    result('update', t);
    break;
  }
  case 'list': {
    const extra = (opt('--fields') ?? '').split(',').filter(Boolean);
    const fields = ['id', 'state', 'kind', 'repo', 'title', ...extra];
    const cell = (v) => (v === null || v === undefined ? '"-"' : /^[A-Za-z0-9 ._:\/-]*$/.test(v) && v !== '' && !v.includes(',') ? v : JSON.stringify(v));
    const value = (t, f) => {
      switch (f) {
        case 'hold_kind':
          return t.hold?.kind ?? null;
        case 'hold_reason':
          return t.hold?.reason ?? null;
        case 'hold_until':
          return t.hold?.until ?? null;
        case 'blocked_by':
          return t.blocked_by.length ? t.blocked_by.join(',') : 'none';
        case 'body':
          return t.body ?? '';
        default:
          return t[f] ?? null;
      }
    };
    const rows = db.tasks.filter((t) => !opt('--state') || t.state === opt('--state'));
    console.log(`count: ${rows.length}`);
    console.log(`tasks[${rows.length}]{${fields.join(',')}}:`);
    for (const t of rows) console.log(`  ${fields.map((f) => (f === 'body' ? JSON.stringify(value(t, f)) : cell(value(t, f)))).join(',')}`);
    process.exit(0);
    break;
  }
  default:
    fail(`fake tasks-axi does not know "${cmd}"`);
}
