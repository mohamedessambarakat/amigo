import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { quoteForCmd, resolveExecutable } from './command.ts';
import { readJson, writeJsonAtomic } from './fsx.ts';
import { backlogPath, dataDir, stateDir, taskDataDir } from './paths.ts';

/**
 * The backlog: the durable queue of work items, kept by tasks-axi in data/backlog.md. It tracks work items only, never agents.
 *
 * Gate: the backlog is active once data/backlog.md exists. A home without that file
 * keeps no backlog, and spawn and close move nothing (an exemption, never an error). Once it exists, tasks-axi at TASKS_AXI_MIN or
 * newer is required, and spawn and close refuse rather than report success without their transition.
 *
 * Transitions: a task that is running or finished but not closed has its backlog
 * item In flight. spawn adds the item Queued (or dispatches an existing one, `spawn --task <id>`), the start of the crew member
 * moves it In flight, and close moves it to Done with its deliverable (the PR, the survey's report, the commit, or "discarded").
 * When the item is still an open Boss hold, close records the deliverable and returns it to Queued, still held: cleanup never
 * retires the Boss's own question. A close whose backlog half fails leaves a pending record that the next spawn or close replays.
 */

/** The oldest tasks-axi amigo works with: the first with update --archive-body and mv of several ids. */
export const TASKS_AXI_MIN = '0.2.6';
/** How long one tasks-axi call may take. */
const AXI_TIMEOUT_MS = 30_000;
/**
 * tasks-axi's fixed hold kind for a hold on the user's own call (its vocabulary, not amigo's): every Boss hold is stored with it.
 * The brand check allows this one tool token.
 */
export const BOSS_HOLD_KIND = 'captain';
/** The kind of an item amigo creates only to carry a Boss call (no work item existed to hold). */
export const DECISION_KIND = 'boss';

export type ItemState = 'queued' | 'in_flight' | 'done';

export interface BacklogItem {
  id: string;
  title: string;
  state: ItemState;
  kind: string | null;
  repo: string | null;
  blockedBy: string[];
  holdKind: string | null;
  /** Decoded (see encodeReason). */
  holdReason: string | null;
  holdUntil: string | null;
  closed: string | null;
  body: string;
}

/** The backlog is active once its file exists (see the gate above). */
export const backlogActive = (env: NodeJS.ProcessEnv = process.env): boolean => existsSync(backlogPath(env));

/** True while a hold stops dispatch: a hold with no date, or a date still ahead (tasks-axi: "inactive on and after that date"). */
export function holdActive(item: Pick<BacklogItem, 'holdKind' | 'holdUntil'>, today: string = todayUtc()): boolean {
  if (!item.holdKind) return false;
  return !item.holdUntil || today < item.holdUntil;
}

export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** An open Boss call: not Done, held with the Boss hold kind (an expired date still counts: the question stays his). */
export const isOpenBossHold = (item: BacklogItem): boolean => item.state !== 'done' && item.holdKind === BOSS_HOLD_KIND;

/**
 * The program to run: AMIGO_TASKS_AXI (another program, for tests), else `tasks-axi` on PATH. A Windows npm shim (.cmd) is read
 * for the script it starts, which then runs under this Node, so no argument ever passes through cmd.exe.
 */
function axiCommand(env: NodeJS.ProcessEnv): { file: string; pre: string[] } | null {
  const script = env.AMIGO_TASKS_AXI && /\.(m|c)?js$/i.test(env.AMIGO_TASKS_AXI) && existsSync(env.AMIGO_TASKS_AXI) ? env.AMIGO_TASKS_AXI : null;
  const found = script ?? resolveExecutable(env.AMIGO_TASKS_AXI || 'tasks-axi', env);
  if (!found) return null;
  if (/^\.(m|c)?js$/i.test(extname(found))) return { file: process.execPath, pre: [found] };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    const shim = readFileSync(found, 'utf8');
    const script = /"([^"]+\.(?:m|c)?js)"/i.exec(shim)?.[1]?.replace(/%~?dp0%?\\?/gi, `${dirname(found)}\\`);
    if (script && existsSync(script)) return { file: process.execPath, pre: [script] };
    return { file: found, pre: [] };
  }
  return { file: found, pre: [] };
}

interface AxiResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function execAxi(args: string[], env: NodeJS.ProcessEnv, cwd: string): AxiResult {
  const cmd = axiCommand(env);
  if (!cmd) throw new Error('tasks-axi is not installed, and this home keeps a backlog (data/backlog.md). Install it: npm install -g tasks-axi');
  const opts = { cwd, env, encoding: 'utf8' as const, windowsHide: true, timeout: AXI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 };
  const r =
    cmd.pre.length === 0 && process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd.file)
      ? spawnSync([cmd.file, ...args].map(quoteForCmd).join(' '), { ...opts, shell: true })
      : spawnSync(cmd.file, [...cmd.pre, ...args], opts);
  if (r.error) throw new Error(`tasks-axi ${args[0] ?? ''} could not run: ${(r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `timed out after ${AXI_TIMEOUT_MS / 1000}s` : r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** a >= b for dotted versions ("0.2.10" >= "0.2.6"). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const checked = new Set<string>();

/** Refuse a tasks-axi older than TASKS_AXI_MIN (checked once per program per process). */
function requireCompatible(env: NodeJS.ProcessEnv): void {
  const key = `${env.AMIGO_TASKS_AXI ?? ''}|${env.PATH ?? env.Path ?? ''}`;
  if (checked.has(key)) return;
  const r = execAxi(['--version'], env, process.cwd());
  const version = /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr)?.[1];
  if (r.status !== 0 || !version) throw new Error(`Could not read the tasks-axi version: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  if (!versionAtLeast(version, TASKS_AXI_MIN)) throw new Error(`tasks-axi ${version} is too old: amigo needs ${TASKS_AXI_MIN} or newer. Update it: npm install -g tasks-axi`);
  checked.add(key);
}

/**
 * Run tasks-axi on this home's backlog, from the data folder, whatever the caller's folder. Refuses a backlog file that is a symlink:
 * the first write would replace the link with a private copy and fork the backlog.
 */
export function runAxi(args: string[], env: NodeJS.ProcessEnv = process.env): AxiResult {
  const file = backlogPath(env);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; a tasks-axi write would replace it with a regular file and fork the backlog. Make it this home's real file.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  requireCompatible(env);
  mkdirSync(dataDir(env), { recursive: true });
  return execAxi([...args, '--file', file], env, dataDir(env));
}

/** What tasks-axi said when it refused: its `error:` line, else its output. */
const axiError = (r: AxiResult): string => {
  const text = `${r.stderr}\n${r.stdout}`;
  const line = /^error:\s*(.*)$/m.exec(text)?.[1]?.trim();
  return (line ? line.replace(/^"|"$/g, '').replace(/\\"/g, '"') : text.trim()) || `exit ${r.status}`;
};

/** A mutation with --json: the resulting task, or throws with tasks-axi's reason. */
function mutate(args: string[], env: NodeJS.ProcessEnv): void {
  const r = runAxi([...args, '--json'], env);
  if (r.status !== 0) throw new Error(`tasks-axi ${args[0]} ${args[1] ?? ''}: ${axiError(r)}`.replace(/\s+:/, ':'));
}

/** Split one TOON table row: comma-separated cells, a quoted cell is a JSON string. */
export function toonCells(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      cells.push(JSON.parse(line.slice(i, j + 1)) as string);
      i = j + 2;
    } else {
      const j = line.indexOf(',', i);
      const end = j === -1 ? line.length : j;
      cells.push(line.slice(i, end));
      i = end + 1;
    }
    if (i > line.length) break;
  }
  return cells;
}

const LIST_FIELDS = ['hold_kind', 'hold_reason', 'hold_until', 'blocked_by', 'closed', 'body'];

/** Parse `tasks-axi list --fields ...` output (a TOON table) into items. */
export function parseList(stdout: string): BacklogItem[] {
  const lines = stdout.split(/\r?\n/);
  const head = lines.findIndex((l) => /^tasks\[\d+\]\{.*\}:$/.test(l.trim()));
  if (head === -1) return [];
  const fields = /\{(.*)\}/.exec(lines[head] as string)?.[1]?.split(',') ?? [];
  const n = Number(/\[(\d+)\]/.exec(lines[head] as string)?.[1] ?? 0);
  const nul = (v: string | undefined): string | null => (v === undefined || v === '-' || v === '' ? null : v);
  return lines.slice(head + 1, head + 1 + n).map((line) => {
    const cells = toonCells(line.trim());
    const get = (f: string) => cells[fields.indexOf(f)];
    const blocked = nul(get('blocked_by'));
    return {
      id: get('id') ?? '',
      title: get('title') ?? '',
      state: (get('state') ?? 'queued') as ItemState,
      kind: nul(get('kind')),
      repo: nul(get('repo')),
      blockedBy: !blocked || blocked === 'none' ? [] : blocked.split(',').map((s) => s.trim()).filter(Boolean),
      holdKind: nul(get('hold_kind')),
      holdReason: decodeReason(nul(get('hold_reason'))),
      holdUntil: nul(get('hold_until')),
      closed: nul(get('closed')),
      body: get('body') ?? '',
    };
  });
}

/** Every item in the backlog (Done ones too). Empty when the backlog is not active. */
export function listItems(env: NodeJS.ProcessEnv = process.env): BacklogItem[] {
  if (!backlogActive(env)) return [];
  const r = runAxi(['list', '--fields', LIST_FIELDS.join(',')], env);
  if (r.status !== 0) throw new Error(`tasks-axi list: ${axiError(r)}`);
  return parseList(r.stdout);
}

export function findItem(id: string, env: NodeJS.ProcessEnv = process.env): BacklogItem | null {
  return listItems(env).find((i) => i.id === id) ?? null;
}

/**
 * Why an item cannot be dispatched now, or null when it can: Queued, every blocker Done, and no active hold.
 */
export function notDispatchable(item: BacklogItem, all: BacklogItem[], today: string = todayUtc()): string | null {
  if (item.state === 'done') return 'it is Done';
  if (item.state === 'in_flight') return 'it is already In flight (a crew member has it)';
  if (holdActive(item, today)) return `it is held${item.holdKind === BOSS_HOLD_KIND ? ' for the Boss' : ''}${item.holdUntil ? ` until ${item.holdUntil}` : ''}: ${item.holdReason ?? ''}`.trim();
  const open = item.blockedBy.filter((b) => all.find((x) => x.id === b)?.state !== 'done');
  if (open.length) return `it is blocked by ${open.join(', ')}`;
  return null;
}

/** tasks-axi keeps a hold reason on one markdown line inside parentheses, so it refuses parentheses and line breaks: such a reason is stored base64-encoded behind this prefix and decoded by every reader. */
const REASON_PREFIX = 'amigo-hold-v1:';

export function encodeReason(reason: string): string {
  return /[()\r\n"%]/.test(reason) ? `${REASON_PREFIX}${Buffer.from(reason, 'utf8').toString('base64')}` : reason;
}

export function decodeReason(stored: string | null): string | null {
  if (!stored?.startsWith(REASON_PREFIX)) return stored;
  const payload = stored.slice(REASON_PREFIX.length);
  const bytes = Buffer.from(payload, 'base64');
  return bytes.toString('base64') === payload ? bytes.toString('utf8') : stored;
}

/** Replace every encoded reason in tasks-axi's printed output with its text, quoted, so `amigo backlog list` shows what was written. */
export function decodeOutput(text: string): string {
  return text.replace(new RegExp(`${REASON_PREFIX}[A-Za-z0-9+/]*={0,2}`, 'g'), (m) => JSON.stringify(decodeReason(m)));
}

export function addItem(o: { id: string; title: string; kind: string; repo?: string; blockedBy?: string[] }, env: NodeJS.ProcessEnv = process.env): void {
  mutate(['add', o.id, o.title, '--kind', o.kind, ...(o.repo ? ['--repo', o.repo] : []), ...(o.blockedBy ?? []).flatMap((b) => ['--blocked-by', b]), '--queue'], env);
}

export const startItem = (id: string, env: NodeJS.ProcessEnv = process.env): void => mutate(['start', id], env);
export const reopenItem = (id: string, env: NodeJS.ProcessEnv = process.env): void => mutate(['reopen', id], env);
export const removeItem = (id: string, env: NodeJS.ProcessEnv = process.env): void => mutate(['rm', id], env);
export const unholdItem = (id: string, env: NodeJS.ProcessEnv = process.env): void => mutate(['unhold', id], env);

export function holdItem(id: string, o: { reason: string; kind: string; until?: string }, env: NodeJS.ProcessEnv = process.env): void {
  mutate(['hold', id, '--reason', encodeReason(o.reason), '--kind', o.kind, ...(o.until ? ['--until', o.until] : [])], env);
}

/** What a closed item delivered: a PR URL, a report (a path relative to the data folder), or a note. */
export interface Deliverable {
  pr?: string;
  report?: string;
  note?: string;
}

const deliverableArgs = (d: Deliverable): string[] => [...(d.pr ? ['--pr', d.pr] : []), ...(d.report ? ['--report', d.report] : []), ...(d.note ? ['--note', d.note] : [])];

export const finishItem = (id: string, d: Deliverable, env: NodeJS.ProcessEnv = process.env): void => mutate(['done', id, ...deliverableArgs(d)], env);

/** Replace an item's body (the previous one archived by tasks-axi). The body goes through a file, never the command line. */
export function setBody(id: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(stateDir(env), 'drafts', `body-${id}-${process.pid}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  try {
    mutate(['update', id, '--body-file', file, '--archive-body'], env);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Record a deliverable on an item that stays open (a held item whose work is finished). */
export function recordDeliverable(id: string, d: Deliverable, env: NodeJS.ProcessEnv = process.env): void {
  const args = [...(d.pr ? ['--pr', d.pr] : []), ...(d.report ? ['--report', d.report] : [])];
  if (args.length) mutate(['update', id, ...args], env);
  if (d.note) {
    const item = findItem(id, env);
    if (item) setBody(id, [item.body.trim(), `Deliverable: ${d.note}`].filter(Boolean).join('\n\n'), env);
  }
}

/** A report path as the backlog records it: relative to the data folder's parent, as `data/<id>/report.md`. */
export const reportLink = (id: string, env: NodeJS.ProcessEnv = process.env): string => relative(dirname(dataDir(env)), join(taskDataDir(id, env), 'report.md')).replace(/\\/g, '/');

// ---- spawn and close transitions ------------------------------------------------------------------------------------------------

/** A pending close: what close owes the backlog, written before it tries, removed once it landed (replayed by the next spawn or close). */
interface PendingClose {
  id: string;
  mode: 'done' | 'retain';
  deliverable: Deliverable;
}

const pendingDir = (env: NodeJS.ProcessEnv): string => join(stateDir(env), 'backlog-close');
const pendingFile = (id: string, env: NodeJS.ProcessEnv): string => join(pendingDir(env), `${id}.json`);

function applyClose(p: PendingClose, env: NodeJS.ProcessEnv): string {
  const item = findItem(p.id, env);
  if (!item) return `Backlog: ${p.id} has no item any more; nothing to close.`;
  // Re-checked at apply time: an item that became an open Boss call keeps its question open.
  if (p.mode === 'retain' || isOpenBossHold(item)) {
    if (item.state === 'done') return `Backlog: ${p.id} is already Done.`;
    recordDeliverable(p.id, p.deliverable, env);
    if (item.state === 'in_flight') reopenItem(p.id, env);
    return `Backlog: ${p.id} stays open, still held for the Boss, with its deliverable recorded. Relay the question; only amigo answer closes it.`;
  }
  finishItem(p.id, p.deliverable, env);
  return `Backlog: ${p.id} is Done. Check amigo backlog ready for work whose blockers are gone, and dispatch it.`;
}

/** Finish what an earlier close left owed to the backlog. Returns what it did. */
export function replayPendingCloses(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = pendingDir(env);
  if (!existsSync(dir) || !backlogActive(env)) return [];
  const out: string[] = [];
  for (const f of readdirNames(dir)) {
    const p = readJson<PendingClose | null>(join(dir, f), null);
    if (!p) continue;
    out.push(applyClose(p, env));
    rmSync(join(dir, f), { force: true });
  }
  return out;
}

function readdirNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Close's backlog half. Records what is owed first, then applies it; on failure the record stays for the next spawn or close and
 * the error is returned as a loud line (the task itself is already closed).
 */
export function closeItem(id: string, deliverable: Deliverable, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!backlogActive(env)) return [];
  const item = findItem(id, env);
  if (!item) return [];
  const pending: PendingClose = { id, mode: isOpenBossHold(item) ? 'retain' : 'done', deliverable };
  writeJsonAtomic(pendingFile(id, env), pending);
  try {
    const line = applyClose(pending, env);
    rmSync(pendingFile(id, env), { force: true });
    return [line];
  } catch (err) {
    return [`FAILED to update the backlog item ${id}: ${(err as Error).message}. It is retried by the next spawn or close (record: ${pendingFile(id, env)}).`];
  }
}
