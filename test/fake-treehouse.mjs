// A stand-in for treehouse in tests: a pool of git worktrees under TREEHOUSE_ROOT, leased and returned the way the real one does
// (get --lease --lease-holder <id> [--json], return [--force] <path>, status --json). Every call is logged to FAKE_TREEHOUSE_LOG.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const root = process.env.TREEHOUSE_ROOT;
if (process.env.FAKE_TREEHOUSE_LOG) appendFileSync(process.env.FAKE_TREEHOUSE_LOG, `${JSON.stringify({ cwd: process.cwd(), args })}\n`);
if (args[0] === '--version') {
  console.log('treehouse v3.1.8 (fake)');
  process.exit(0);
}
if (!root) {
  console.error('fake treehouse: TREEHOUSE_ROOT is not set');
  process.exit(2);
}
mkdirSync(root, { recursive: true });
const stateFile = join(root, 'fake-pool.json');
const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { slots: [] });
const save = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const norm = (p) => {
  const r = realpathSync.native(resolve(p)).replaceAll('\\', '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === 'get') {
  if (args.includes('--help')) {
    console.log('Usage: treehouse get [--lease] [--lease-holder <holder>] [--json] [-b <branch>]');
    process.exit(0);
  }
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const s = load();
  let slot = s.slots.find((x) => norm(x.repo) === norm(repo) && !x.lease_holder && existsSync(x.path));
  if (!slot) {
    const n = s.slots.filter((x) => norm(x.repo) === norm(repo)).length + 1;
    const path = join(root, `${basename(repo)}-${n}`);
    git(repo, 'worktree', 'add', '--quiet', '--detach', path, 'HEAD');
    slot = { repo, path: realpathSync.native(path), lease_holder: null };
    s.slots.push(slot);
  }
  if (args.includes('--lease')) {
    slot.lease_holder = opt('--lease-holder') ?? 'anonymous';
    slot.leased_at = new Date().toISOString();
  }
  save(s);
  console.error('fake treehouse: preparing worktree');
  console.log(args.includes('--json') ? JSON.stringify({ path: slot.path, lease_id: `lease-${s.slots.indexOf(slot) + 1}`, lease_holder: slot.lease_holder, leased_at: slot.leased_at, base_branch: 'main' }) : slot.path);
  process.exit(0);
}

if (args[0] === 'return') {
  const target = args.filter((a) => !a.startsWith('--')).slice(1)[0];
  const s = load();
  const slot = target && s.slots.find((x) => existsSync(x.path) && norm(x.path) === norm(target));
  if (!slot) {
    console.error(`fake treehouse: ${target} is not a pool worktree`);
    process.exit(1);
  }
  const dirty = git(slot.path, 'status', '--porcelain').trim() !== '';
  if (dirty && !args.includes('--force')) {
    console.error('stdin reached EOF while asking to discard changes; use --force');
    process.exit(1);
  }
  for (const a of [['reset', '--hard', '--quiet'], ['clean', '-fdq'], ['checkout', '--quiet', '--detach']]) spawnSync('git', ['-C', slot.path, ...a]);
  slot.lease_holder = null;
  delete slot.leased_at;
  save(s);
  console.log('Worktree returned to pool');
  process.exit(0);
}

if (args[0] === 'status') {
  const s = load();
  console.log(JSON.stringify(s.slots.map((x, i) => ({ name: String(i + 1), path: x.path, status: x.lease_holder ? 'leased' : 'available', lease_holder: x.lease_holder, processes: [] }))));
  process.exit(0);
}

console.error(`fake treehouse: unknown command ${args.join(' ')}`);
process.exit(2);
