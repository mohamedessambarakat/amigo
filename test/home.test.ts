import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadProjects, projectPosture } from '../src/config.ts';
import { syncProject } from '../src/sync.ts';
import { getTask, listTasks } from '../src/tasks.ts';
import { leasedPath } from '../src/worktree.ts';
import { addOrigin, cleanup, cli, cloneOf, fakeTreehouseEnv, git, idFrom, makeHome, makeRepo, releaseHeld, waitFor } from './helpers.ts';

const home = (env: NodeJS.ProcessEnv): string => env.AMIGO_HOME as string;

/** A source repo with a bare origin holding its main, registered with `amigo add <origin>` under the name `repo`. */
function project(dir: string, env: NodeJS.ProcessEnv, ...flags: string[]): { repo: string; bare: string; clone: string } {
  const repo = makeRepo(join(dir, 'repo'));
  const bare = addOrigin(dir, repo);
  const added = cli(env, ['add', bare, '--name', 'repo', ...flags]);
  assert.equal(added.code, 0, added.err);
  return { repo, bare, clone: cloneOf(env, 'repo') };
}

/** Advance origin's main by one commit, made in the source repo and pushed. */
function advanceOrigin(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', `add ${file}`);
  git(repo, 'push', '-q', 'origin', 'main');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

describe('home layout', () => {
  it('the first command creates config/, data/, state/ and projects/', () => {
    const { dir, env } = makeHome();
    try {
      const fresh = { ...env, AMIGO_HOME: join(dir, 'fresh') };
      assert.equal(cli(fresh, ['projects']).code, 0);
      for (const sub of ['config', 'data', 'state', 'projects']) assert.ok(existsSync(join(dir, 'fresh', sub)), `${sub}/ exists`);
      assert.ok(existsSync(join(dir, 'fresh', 'config', 'config.json')));
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fresh', 'data', 'projects.json'), 'utf8')), { projects: [] });
      assert.ok(!existsSync(join(dir, 'fresh', 'config.json')) && !existsSync(join(dir, 'fresh', 'projects.json')), 'nothing at the top of the home');
    } finally {
      cleanup(dir);
    }
  });

  it('a home in the old layout is refused by every command but help and migrate', () => {
    const { dir, env } = makeHome();
    try {
      writeFileSync(join(home(env), 'projects.json'), JSON.stringify({ projects: [] }));
      for (const args of [['projects'], ['status'], ['spawn', '--scratch']]) {
        const r = cli(env, args, 'Title: x');
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.err, /still has the layout from before this version[\s\S]*amigo migrate --dry-run/);
      }
      assert.equal(cli(env, ['help']).code, 0);
      assert.match(cli(env, ['migrate', '--dry-run']).out, /Would migrate/);
    } finally {
      cleanup(dir);
    }
  });

  it('a session of the former name still counts as a crew member: managing commands are refused', () => {
    const { dir, env } = makeHome();
    try {
      const refused = cli({ ...env, OCTOMAXXING_TASK: '1-old' }, ['spawn', '--scratch'], 'x');
      assert.equal(refused.code, 1);
      assert.match(refused.err, /You are running inside crew member 1-old/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('projects are clones', () => {
  it('add clones into projects/<name> and records the delivery posture; the same source again updates it', () => {
    const { dir, env } = makeHome();
    try {
      const live = join(dir, 'live-install');
      mkdirSync(live);
      const { repo, bare, clone } = project(dir, env, '--mode', 'direct-PR', '--yolo', '--branch-prefix', 'feat/', '--live', live);
      assert.equal(git(clone, 'remote', 'get-url', 'origin').trim(), bare);
      assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), git(repo, 'rev-parse', 'HEAD').trim());
      const [p] = loadProjects(env);
      assert.deepEqual({ ...p, addedAt: undefined }, { name: 'repo', source: bare, path: clone, mode: 'direct-PR', yolo: true, branchPrefix: 'feat/', live, addedAt: undefined });
      const stored = JSON.parse(readFileSync(join(home(env), 'data', 'projects.json'), 'utf8')).projects[0];
      assert.equal(stored.path, undefined, 'the clone path is derived, never stored');
      assert.deepEqual(projectPosture('repo', env), { mode: 'direct-PR', yolo: true, branchPrefix: 'feat/' });
      assert.match(projectPosture('nope', env).warning ?? '', /not registered; defaulting to no-mistakes, yolo off/);
      assert.deepEqual({ ...projectPosture('nope', env), warning: undefined }, { mode: 'no-mistakes', yolo: false, branchPrefix: 'amigo/', warning: undefined });

      const again = cli(env, ['add', bare, '--name', 'repo', '--no-yolo', '--mode', 'local-only']);
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /^Updated repo: clone of /);
      assert.deepEqual([loadProjects(env)[0]?.mode, loadProjects(env)[0]?.yolo, loadProjects(env)[0]?.branchPrefix, loadProjects(env)[0]?.live], ['local-only', false, 'feat/', live]);
      assert.match(cli(env, ['projects']).out, /repo  \[local-only\]  .*\(clone, from [\s\S]*branches: feat\/<task id>[\s\S]*live install: /);
    } finally {
      cleanup(dir);
    }
  });

  it('add defaults to no-mistakes, yolo off, amigo/ branches, and refuses what it must not touch', () => {
    const { dir, env } = makeHome();
    try {
      const { clone } = project(dir, env);
      assert.deepEqual([loadProjects(env)[0]?.mode, loadProjects(env)[0]?.yolo, loadProjects(env)[0]?.branchPrefix], ['no-mistakes', false, 'amigo/']);

      const other = makeRepo(join(dir, 'other'));
      assert.match(cli(env, ['add', other, '--name', 'repo']).err, /already exists, cloned from/);
      mkdirSync(join(home(env), 'projects', 'taken'));
      const taken = cli(env, ['add', other, '--name', 'taken']);
      assert.equal(taken.code, 1);
      assert.match(taken.err, /already exists and is not a registered project; amigo never overwrites a folder/);
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      const notGit = cli(env, ['add', plain]);
      assert.equal(notGit.code, 1);
      assert.match(notGit.err, /git clone .* failed/);
      assert.ok(!existsSync(join(home(env), 'projects', 'plain')), 'a failed clone leaves nothing behind');
      assert.match(cli(env, ['add', other, '--mode', 'fast']).err, /--mode must be one of no-mistakes, direct-PR, local-only/);
      assert.match(cli(env, ['add', other, '--live', join(dir, 'missing')]).err, /is not a folder/);
      assert.deepEqual(loadProjects(env).map((p) => p.name), ['repo'], 'nothing else was registered');
      assert.ok(existsSync(clone));
    } finally {
      cleanup(dir);
    }
  });
});

describe('worktrees from the pool', () => {
  it("a build starts from origin's tip on the project's branch prefix, never from the clone's checkout, and goes back to the pool", async () => {
    const { dir, env } = makeHome();
    try {
      const { repo, clone } = project(dir, env, '--branch-prefix', 'feat/');
      // The clone's checkout drifts: a feature branch with a local commit. Origin moves on meanwhile.
      git(clone, 'checkout', '-q', '-b', 'stray');
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'local only');
      const tip = advanceOrigin(repo, 'fresh.txt');
      assert.match(cli(env, ['projects']).out, /CLONE ON BRANCH stray, not its default/);

      const id = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Fresh base').out);
      const t = await waitFor(id, env, ['done', 'failed']);
      assert.equal(t.status, 'done', t.summary);
      assert.equal(t.branch, `feat/${id}`);
      assert.equal(t.baseSha, tip, "origin's tip, fetched at spawn");
      assert.equal(git(t.worktree as string, 'rev-parse', 'HEAD~1').trim(), tip, 'its one commit sits on the base');
      assert.ok(existsSync(join(t.worktree as string, 'fresh.txt')));
      assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'stray', 'the clone was not touched');
      assert.ok(t.worktree?.startsWith(join(home(env), 'state', 'worktrees')), 'the pool lives in the home');
      const log = readFileSync(join(dir, 'treehouse.log'), 'utf8');
      assert.match(log, new RegExp(`"args":\\["get","--lease","--lease-holder","${id}","--json"\\]`));

      assert.match(cli(env, ['close', id]).err, /has not landed/, 'committed work nobody pushed is not discarded');
      assert.equal(cli(env, ['close', id, '--force']).code, 0);
      assert.equal(git(clone, 'log', '-1', '--format=%s', `feat/${id}`).trim(), 'feat: write member output', 'a discarded build keeps its branch');
      assert.equal(git(t.worktree as string, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'returned detached');
      assert.match(readFileSync(join(dir, 'treehouse.log'), 'utf8'), /"args":\["return","--force",/);

      // The next build reuses the returned slot, still from origin's tip.
      const next = idFrom(cli(env, ['spawn', '--project', 'repo'], 'Title: Again').out);
      const n = await waitFor(next, env, ['done', 'failed']);
      assert.equal(n.worktree, t.worktree, 'the same pool slot');
      assert.equal(n.baseSha, tip);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses a worktree that is not isolated, and a pooled slot that is dirty, leaving it leased', async () => {
    const { dir, env: base } = makeHome();
    try {
      const { clone } = project(dir, base);
      // A treehouse that answers with the clone itself.
      const evilDir = join(dir, 'evil');
      mkdirSync(evilDir);
      const script = join(evilDir, 'treehouse.mjs');
      writeFileSync(script, `if (process.argv[2] === 'get' && process.argv.includes('--help')) console.log('--lease'); else console.log(JSON.stringify({ path: ${JSON.stringify(clone)} }));\n`);
      const evil = { ...base, ...fakeTreehouseEnv(evilDir, script) };
      const r = cli(evil, ['spawn', '--project', 'repo'], 'Title: Tangle');
      assert.equal(r.code, 1);
      assert.match(r.err, /treehouse did not yield an isolated worktree .*it is the project clone itself/);
      assert.equal(listTasks(base).length, 0, 'no task was made');

      // A pooled slot left dirty is never reset.
      const first = cli(base, ['spawn', '--project', 'repo'], 'Title: First\nMODE:hold');
      const id = idFrom(first.out);
      const wt = getTask(id, base)?.worktree as string;
      releaseHeld(base);
      await waitFor(id, base, ['done']);
      assert.equal(cli(base, ['close', id, '--force']).code, 0);
      writeFileSync(join(wt, 'left-behind.txt'), 'x');
      const dirty = cli(base, ['spawn', '--project', 'repo'], 'Title: Second');
      assert.equal(dirty.code, 1);
      assert.match(dirty.err, /is not clean; refusing to discard uncommitted work[\s\S]*stays leased[\s\S]*treehouse return --force/);
      assert.ok(existsSync(join(wt, 'left-behind.txt')), 'the work is kept');
    } finally {
      releaseHeld(base);
      cleanup(dir);
    }
  });

  it('reads the leased path from JSON or a bare line', () => {
    assert.equal(leasedPath('banner\n{"path":"/p/1","lease_id":"x"}\n'), '/p/1');
    assert.equal(leasedPath('/p/2\n'), '/p/2');
    assert.equal(leasedPath(''), null);
  });
});

describe('guarded sync', () => {
  it('fast-forwards a clean clone, prunes merged branches no worktree holds, and leaves anything unsafe untouched', () => {
    const { dir, env } = makeHome();
    try {
      const { repo, bare, clone } = project(dir, env);
      const p = loadProjects(env)[0]!;
      assert.equal(syncProject(p), 'repo: already current');
      const tip = advanceOrigin(repo, 'b.txt');
      const synced = syncProject(p);
      assert.match(synced, /^repo: synced [0-9a-f]+\.\.[0-9a-f]+$/);
      assert.equal(git(clone, 'rev-parse', 'main').trim(), tip);

      // A merged branch: pushed, tracked, then deleted on origin.
      git(clone, 'branch', 'amigo/1-done');
      git(clone, 'push', '-q', '-u', 'origin', 'amigo/1-done');
      git(bare, 'branch', '-D', 'amigo/1-done');
      advanceOrigin(repo, 'c.txt');
      assert.match(syncProject(p), /^repo: pruned amigo\/1-done\nrepo: synced /);
      assert.equal(git(clone, 'branch', '--list', 'amigo/1-done').trim(), '');

      writeFileSync(join(clone, 'a.txt'), 'dirty\n');
      advanceOrigin(repo, 'd.txt');
      assert.match(syncProject(p), /^repo: STUCK: on branch main with uncommitted changes, 1 commits behind origin\/main - needs attention$/);
      assert.equal(readFileSync(join(clone, 'a.txt'), 'utf8'), 'dirty\n', 'nothing was discarded');
      git(clone, 'checkout', '-q', '--', 'a.txt');

      git(clone, 'checkout', '-q', '--detach');
      assert.match(syncProject(p), /^repo: recovered: re-attached main, synced /, 'a clean detached HEAD with no commits of its own is healed');
      git(clone, 'checkout', '-q', '-b', 'stray');
      assert.match(syncProject(p), /^repo: STUCK: on branch stray, 0 commits behind origin\/main - needs attention$/);

      assert.match(syncProject({ ...p, mode: 'local-only' }), /skipped: local-only project/);
      assert.match(cli(env, ['sync']).out, /^repo: STUCK: on branch stray/m);
      assert.match(cli(env, ['sync', 'nope']).err, /Unknown project "nope"/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('migration to the clone layout', () => {
  /** A home as the amigo before this version left it. */
  function oldHome() {
    const { dir, env } = makeHome();
    const h = home(env);
    const config = JSON.parse(readFileSync(join(h, 'config', 'config.json'), 'utf8'));
    cleanup(h);
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, 'config.json'), JSON.stringify(config));
    const remote = makeRepo(join(dir, 'remote-src'));
    const bare = addOrigin(dir, remote);
    const withOrigin = join(dir, 'with-origin');
    git(dir, 'clone', '-q', bare, withOrigin);
    const local = makeRepo(join(dir, 'local'));
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFileSync(
      join(h, 'projects.json'),
      JSON.stringify({
        projects: [
          { name: 'web', path: withOrigin, notes: 'be kind', checks: ['npm test'], risky: ['src/**'], live: ['echo hi'], watch: ['site up?'], wasGit: true },
          { name: 'tool', path: local, wasGit: true },
          { name: 'plain', path: plain, wasGit: false },
        ],
      }),
    );
    for (const f of ['policy.json', 'policy.approved.json', 'gates.confirmed.json']) writeFileSync(join(h, f), '{}');
    writeFileSync(join(h, 'approvals.jsonl'), '');
    writeFileSync(join(h, 'notices.json'), '[]');
    mkdirSync(join(h, 'scratch', '1-s'), { recursive: true });
    mkdirSync(join(h, 'locks'));
    mkdirSync(join(h, 'worktrees'));
    const task = (id: string, status: string, cwd: string) => {
      mkdirSync(join(h, 'tasks', id), { recursive: true });
      writeFileSync(join(h, 'tasks', id, 'brief.md'), `Title: ${id}\n`);
      writeFileSync(join(h, 'tasks', id, 'task.json'), JSON.stringify({ id, title: id, project: 'web', agent: 'fake', cwd, repo: null, worktree: null, branch: null, baseSha: null, status, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', runs: 1, followUps: [], seen: true }));
    };
    task('1-s', 'closed', join(h, 'scratch', '1-s'));
    task('2-w', 'closed', join(h, 'worktrees', 'web-2-w'));
    return { dir, env, h, bare, withOrigin, local, plain, task };
  }

  it('dry run shows the plan and changes nothing; problems are listed all at once', () => {
    const s = oldHome();
    try {
      const refused = cli(s.env, ['migrate', '--dry-run']);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /plain: .* is not a git repo, and amigo now works only on clones \(leave it out with --drop plain\)/);
      const before = readdirSync(s.h).sort();
      const dry = cli(s.env, ['migrate', '--dry-run', '--drop', 'plain', '--live', 'web']);
      assert.equal(dry.code, 0, dry.err);
      assert.match(dry.out, /Would migrate/);
      assert.match(dry.out, new RegExp(`web: clone ${s.bare.replaceAll('\\', '\\\\')} into .*\\[no-mistakes \\+yolo\\], live: .*; its checks are dropped \\(npm test\\)`));
      assert.match(dry.out, /tool: clone .*local into .*\[local-only \+yolo\]/);
      assert.match(dry.out, /Dry run: nothing was changed\./);
      assert.deepEqual(readdirSync(s.h).sort(), before);
      assert.match(cli(s.env, ['migrate', '--live', 'nope', '--drop', 'plain']).err, /"nope" is not a registered project/);
    } finally {
      cleanup(s.dir);
    }
  });

  it('refuses while a task is open', () => {
    const s = oldHome();
    try {
      s.task('3-open', 'done', s.dir);
      const r = cli(s.env, ['migrate', '--drop', 'plain']);
      assert.equal(r.code, 1);
      assert.match(r.err, /Cannot migrate while tasks are open: 3-open \(done\)/);
      assert.ok(existsSync(join(s.h, 'projects.json')), 'nothing moved');
    } finally {
      cleanup(s.dir);
    }
  });

  it('converts the home: clones, registry, moved records, dropped gate files; a second run has nothing to do', async () => {
    const s = oldHome();
    try {
      const r = cli(s.env, ['migrate', '--drop', 'plain', '--live', 'web']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Done: 2 projects registered as clones, 2 task records kept in state\/tasks\./);
      const h = s.h;
      assert.deepEqual(readdirSync(h).sort(), ['config', 'data', 'projects', 'state']);
      assert.ok(existsSync(join(h, 'config', 'config.json')));
      const projects = loadProjects(s.env);
      const web = projects.find((p) => p.name === 'web')!;
      assert.deepEqual({ ...web, addedAt: undefined }, {
        name: 'web',
        source: s.bare,
        path: cloneOf(s.env, 'web'),
        mode: 'no-mistakes',
        yolo: true,
        branchPrefix: 'amigo/',
        live: s.withOrigin,
        notes: 'be kind',
        liveCommands: ['echo hi'],
        watch: ['site up?'],
        addedAt: undefined,
      });
      assert.equal((web as unknown as Record<string, unknown>).checks, undefined, 'checks are dropped');
      assert.equal((web as unknown as Record<string, unknown>).risky, undefined, 'risky paths are dropped');
      const tool = projects.find((p) => p.name === 'tool')!;
      assert.deepEqual([tool.source, tool.mode, tool.yolo, tool.live], [s.local, 'local-only', true, undefined]);
      assert.equal(projects.length, 2);
      assert.equal(git(cloneOf(s.env, 'web'), 'remote', 'get-url', 'origin').trim(), s.bare, "the clone's origin is the folder's origin");
      assert.equal(git(cloneOf(s.env, 'tool'), 'remote', 'get-url', 'origin').trim(), s.local);
      for (const f of ['policy.json', 'policy.approved.json', 'gates.confirmed.json']) assert.ok(!existsSync(join(h, 'config', f)) && !existsSync(join(h, f)), `${f} is gone`);
      assert.ok(!existsSync(join(h, 'state', 'approvals.jsonl')));
      assert.equal(readFileSync(join(h, 'data', '1-s', 'brief.md'), 'utf8'), 'Title: 1-s\n');
      assert.equal(getTask('1-s', s.env)?.cwd, join(h, 'state', 'scratch', '1-s'), 'a scratch record follows its folder');
      assert.equal(getTask('2-w', s.env)?.cwd, join(h, 'worktrees', 'web-2-w'), 'other paths are history and stay');
      assert.ok(existsSync(join(h, 'state', 'scratch', '1-s')) && existsSync(join(h, 'state', 'notices.json')));
      assert.ok(existsSync(join(h, 'state', 'migration.json')));
      assert.ok(existsSync(s.withOrigin) && existsSync(s.local), "the Boss's own folders are untouched");

      assert.match(cli(s.env, ['migrate']).out, /already has the new layout/);
      assert.equal(cli(s.env, ['projects']).code, 0, 'the new home works');
      // A build on a migrated project starts from origin's tip in a pooled worktree.
      const id = idFrom(cli(s.env, ['spawn', '--project', 'web'], 'Title: After migrate').out);
      const t = await waitFor(id, s.env, ['done', 'failed']);
      assert.equal(t.status, 'done', t.summary);
      assert.equal(t.baseSha, git(s.bare, 'rev-parse', 'main').trim());
    } finally {
      cleanup(s.dir);
    }
  });

  it('a run that stopped halfway is run again: clones made before are kept', () => {
    const s = oldHome();
    try {
      // What a crash after the clones leaves: the clone is there, the old registry and files too.
      git(s.dir, 'clone', '-q', s.bare, join(s.h, 'projects', 'web'));
      const r = cli(s.env, ['migrate', '--drop', 'plain']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /web: clone already there/);
      assert.match(r.out, /tool: cloned/);
      // A folder in the way that is not a clone of the source is never overwritten.
      const t = oldHome();
      try {
        mkdirSync(join(t.h, 'projects', 'web'), { recursive: true });
        git(join(t.h, 'projects', 'web'), 'init', '-q');
        const refused = cli(t.env, ['migrate', '--drop', 'plain']);
        assert.equal(refused.code, 1);
        assert.match(refused.err, /already exists and is not a clone of/);
      } finally {
        cleanup(t.dir);
      }
    } finally {
      cleanup(s.dir);
    }
  });
});

