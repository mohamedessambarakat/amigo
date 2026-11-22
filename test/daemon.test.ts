import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { daemonRunProcesses, describeTend, ensureDaemon, launchStart, openPipelineBuilds, quoteWinArg, readDaemon, tendDaemon, type Tend } from '../src/nmdaemon.ts';
import { codeRoot, lockPath } from '../src/paths.ts';
import { claimTaskDir, saveTask, type Task } from '../src/tasks.ts';
import { scan } from '../src/watch.ts';
import { cleanup, cli, makeHome } from './helpers.ts';

const fakeNm = join(codeRoot, 'test', 'fake-no-mistakes.mjs');
const win = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A home whose no-mistakes is test/fake-no-mistakes.mjs with its daemon in `state`, a temporary NM_HOME, and autostart on. */
function nmHome(state: string, extra: NodeJS.ProcessEnv = {}) {
  const { dir, env } = makeHome();
  const stateFile = join(dir, 'nm-state');
  const log = join(dir, 'nm.log');
  writeFileSync(stateFile, state);
  const e: NodeJS.ProcessEnv = {
    ...env,
    AMIGO_NO_MISTAKES: fakeNm,
    FAKE_NM_STATE: stateFile,
    FAKE_NM_LOG: log,
    AMIGO_NM_AUTOSTART: '1',
    AMIGO_NM_STATUS_TIMEOUT_MS: '3000',
    AMIGO_NM_START_WAIT_MS: '20000',
    AMIGO_NM_DOWN_GAP_MS: '1',
    AMIGO_NM_DAEMON_SECS: '0',
    CLAUDE_CODE_SESSION_ID: 'lead-session',
    ...extra,
  };
  const calls = (): { args: string[]; nmHome: string | null; leaked: string[] }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const starts = () => calls().filter((c) => c.args[0] === 'daemon' && c.args[1] !== 'status');
  return { dir, env: e, stateFile, calls, starts, state: () => readFileSync(stateFile, 'utf8').trim(), set: (s: string) => writeFileSync(stateFile, s) };
}

/** Tend until something other than "pending" comes back (or `stopOn` matches), bounded. */
async function drive(env: NodeJS.ProcessEnv, stopOn: (t: Tend) => boolean = () => false, ms = 30_000): Promise<Tend[]> {
  const seen: Tend[] = [];
  const end = Date.now() + ms;
  for (;;) {
    const t = tendDaemon(env);
    seen.push(t);
    if (t.kind !== 'pending' || stopOn(t) || Date.now() > end) return seen;
    await sleep(100);
  }
}

function build(env: NodeJS.ProcessEnv, id: string, patch: Partial<Task> = {}): void {
  const now = new Date().toISOString();
  assert.ok(claimTaskDir(id, env));
  saveTask({ id, title: id, project: '(scratch)', agent: 'fake', cwd: '.', repo: null, worktree: null, branch: null, baseSha: null, status: 'done', createdAt: now, updatedAt: now, startedAt: now, runs: 1, followUps: [], seen: true, mode: 'no-mistakes', ...patch }, env);
}

describe('no-mistakes daemon', () => {
  it('reads only positive evidence as down: a timeout or unknown output is never down', () => {
    for (const [state, want] of [['up', 'up'], ['down', 'down'], ['refused', 'down'], ['stale', 'down'], ['garbled', 'unknown']] as const) {
      const h = nmHome(state);
      try {
        assert.equal(readDaemon(h.env)?.state, want, state);
      } finally {
        cleanup(h.dir);
      }
    }
    const h = nmHome('hang', { AMIGO_NM_STATUS_TIMEOUT_MS: '500' });
    try {
      const r = readDaemon(h.env);
      assert.equal(r?.state, 'unknown');
      assert.match(r?.detail ?? '', /timed out/);
    } finally {
      cleanup(h.dir);
    }
  });

  it('confirms a down daemon across reads, then starts it once, without amigo or Claude variables, in the home NM_HOME', async () => {
    const h = nmHome('stale', { AMIGO_NM_DOWN_GAP_MS: '60000' });
    try {
      const t0 = Date.now();
      const first = tendDaemon(h.env, t0);
      assert.equal(first.kind, 'pending');
      assert.match(describeTend(first, []), /is no longer running.*confirming it stays down/);
      assert.equal(tendDaemon(h.env, t0 + 30_000).kind, 'pending', 'still inside the gap: a starting daemon reads down for up to 45 s');
      assert.deepEqual(h.starts(), []);
      assert.equal(tendDaemon(h.env, t0 + 61_000).kind, 'pending', 'the gap passed: the start is launched, not waited on');
      let last: Tend | null = null;
      for (let i = 0; i < 200 && last?.kind !== 'restarted'; i++) {
        await sleep(100);
        last = tendDaemon(h.env, t0 + 62_000 + i);
      }
      assert.equal(last?.kind, 'restarted', JSON.stringify(last));
      assert.match(describeTend(last!, []), /was down \(.*no longer running.*\); amigo started it again/);
      assert.equal(tendDaemon(h.env).kind, 'none', 'reported once');
      assert.equal(h.starts().length, 1);
      assert.equal(h.starts()[0]!.nmHome, h.env.NM_HOME);
      assert.deepEqual(h.starts()[0]!.leaked, [], 'the daemon never inherits AMIGO_* or CLAUDE* variables');
    } finally {
      cleanup(h.dir);
    }
  });

  it('leaves a live, unreadable or service-managed daemon alone', async () => {
    for (const [state, extra] of [['up', {}], ['hang', { AMIGO_NM_STATUS_TIMEOUT_MS: '500' }], ['garbled', {}], ['down', { AMIGO_NM_AUTOSTART: '0' }]] as const) {
      const h = nmHome(state, extra);
      try {
        const seen = await drive(h.env);
        assert.equal(seen.at(-1)?.kind, 'none', state);
        assert.deepEqual(h.starts(), [], `${state}: no start, stop or restart`);
        if (state === 'hang') assert.match(describeTend(seen.at(-1)!, []), /unknown.*left alone - a timeout is not evidence/);
      } finally {
        cleanup(h.dir);
      }
    }
  });

  it('never starts over a daemon run process that is starting for this NM_HOME, or while another tender holds the lock', async () => {
    const h = nmHome('down');
    mkdirSync(h.env.NM_HOME as string, { recursive: true });
    const starting = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'daemon', 'run', '--root', h.env.NM_HOME as string], { stdio: 'ignore' });
    try {
      const end = Date.now() + 10_000;
      while (!(daemonRunProcesses(h.env) ?? []).includes(starting.pid!) && Date.now() < end) await sleep(200);
      assert.ok(daemonRunProcesses(h.env)?.includes(starting.pid!), 'the starting daemon run is seen');
      const seen = await drive(h.env, (t) => t.kind === 'pending' && /already starting/.test(t.note), 15_000);
      assert.match(describeTend(seen.at(-1)!, []), /a daemon run process \(pid \d+\) is already starting/);
      assert.deepEqual(h.starts(), []);
    } finally {
      starting.kill();
    }
    try {
      // Another tender (the watcher, amigo daemon, a spawn) holds the lock: a non-waiting caller gives up instead of starting.
      mkdirSync(join(h.env.AMIGO_HOME as string, 'state', 'locks'), { recursive: true });
      writeFileSync(lockPath('nm-daemon', h.env), `${process.pid} other-tender`);
      build(h.env, 'nm1');
      assert.deepEqual(scan(h.env).filter((w) => w.key === 'daemon:no-mistakes'), []);
      assert.deepEqual(h.starts(), []);
    } finally {
      cleanup(h.dir);
    }
  });

  it('the watcher tends the daemon only while open no-mistakes builds use it, and wakes amigo once it answers', async () => {
    const h = nmHome('stale');
    try {
      build(h.env, 'lo1', { mode: 'local-only' });
      build(h.env, 'nm0', { status: 'closed' });
      assert.deepEqual(scan(h.env), [], 'no open no-mistakes build: the daemon is not even read');
      assert.deepEqual(h.calls(), []);

      build(h.env, 'nm1');
      assert.deepEqual(openPipelineBuilds(h.env).map((t) => t.id), ['nm1']);
      const wakes = [];
      for (let i = 0; i < 200 && !wakes.length; i++) {
        wakes.push(...scan(h.env).filter((w) => w.key === 'daemon:no-mistakes'));
        await sleep(100);
      }
      assert.equal(wakes.length, 1);
      assert.match(wakes[0]!.reason, /^check: no-mistakes daemon was down .* amigo started it again .*\(nm1\) to reattach: `no-mistakes axi run`/);
      assert.equal(h.state(), 'up');
      assert.deepEqual(scan(h.env).filter((w) => w.key === 'daemon:no-mistakes'), [], 'a running daemon wakes nobody');
      assert.equal(h.starts().length, 1);
    } finally {
      cleanup(h.dir);
    }
  });

  it('a failed start is reported once; a daemon that keeps dying is reported once and no longer started', async () => {
    const f = nmHome('down', { FAKE_NM_START_FAILS: '1', AMIGO_NM_START_WAIT_MS: '1500' });
    try {
      const seen = await drive(f.env);
      assert.equal(seen.at(-1)?.kind, 'failed');
      assert.match(describeTend(seen.at(-1)!, []), /could not start it: daemon start was launched, but the daemon did not answer/);
      const again = await drive(f.env, (t) => t.kind === 'pending' && t.note === 'already reported');
      assert.equal(again.at(-1)?.kind, 'pending', 'not reported twice in one episode');
    } finally {
      cleanup(f.dir);
    }
    const k = nmHome('down');
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await drive(k.env)).at(-1)?.kind, 'restarted');
        k.set('down'); // it died again
      }
      const seen = await drive(k.env);
      assert.equal(seen.at(-1)?.kind, 'keeps-dying');
      assert.match(describeTend(seen.at(-1)!, []), /keeps dying: amigo started it 3 times in 30 min/);
      assert.equal((await drive(k.env, (t) => t.kind === 'pending' && t.note === 'already reported')).at(-1)?.kind, 'pending');
      assert.equal(k.starts().length, 3);
    } finally {
      cleanup(k.dir);
    }
  });

  it('amigo daemon reports and starts through the same path', () => {
    const h = nmHome('down');
    try {
      const r = cli(h.env, ['daemon']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /amigo started it again/);
      assert.match(cli(h.env, ['daemon']).out, /daemon is running \(daemon running \(pid 4242\)\)/);
    } finally {
      cleanup(h.dir);
    }
  });

  it('quotes Windows command-line arguments', () => {
    assert.equal(quoteWinArg('plain'), 'plain');
    assert.equal(quoteWinArg('C:\\Program Files\\x.exe'), '"C:\\Program Files\\x.exe"');
    assert.equal(quoteWinArg('a "b"'), '"a \\"b\\""');
    assert.equal(quoteWinArg('dir with space\\'), '"dir with space\\\\"');
    assert.equal(quoteWinArg(''), '""');
  });

  it('runs a .cmd shim in a folder with spaces, parentheses and an ampersand', { skip: !win && 'Windows only' }, async () => {
    const h = nmHome('down');
    try {
      const odd = join(h.dir, 'nm (x86) & co');
      mkdirSync(odd);
      const shim = join(odd, 'no-mistakes.cmd');
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeNm}" %*\r\n`);
      const env = { ...h.env, AMIGO_NO_MISTAKES: shim };
      assert.equal(readDaemon(env)?.state, 'down');
      assert.equal((await drive(env)).at(-1)?.kind, 'restarted');
      assert.equal(h.state(), 'up');
    } finally {
      cleanup(h.dir);
    }
  });

  it('the started daemon outlives a terminal job that kills its members on close', { skip: !win && 'Windows only' }, async (t) => {
    // A PowerShell that puts itself in a kill-on-close job (as a herdr terminal is), runs amigo's launcher in node, and exits.
    const jobRunner = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, byte[] i, int l);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
}
'@
$job = [TestJob]::CreateJobObjectW([IntPtr]::Zero, $null)
$info = New-Object byte[] 144
[BitConverter]::GetBytes([uint32]0x2800).CopyTo($info, 16)
if (-not [TestJob]::SetInformationJobObject($job, 9, $info, 144)) { throw 'SetInformationJobObject failed' }
if (-not [TestJob]::AssignProcessToJobObject($job, [TestJob]::GetCurrentProcess())) { throw 'AssignProcessToJobObject failed' }
& $env:T_NODE $env:T_SCRIPT
exit $LASTEXITCODE`;
    const run = (extra: NodeJS.ProcessEnv) => {
      const h = nmHome('down', { FAKE_NM_START_DELAY_MS: '3000', ...extra });
      const script = join(h.dir, 'launch.mjs');
      writeFileSync(script, `import { launchStart } from ${JSON.stringify(pathToFileURL(join(codeRoot, 'src', 'nmdaemon.ts')).href)};\nconsole.log(JSON.stringify(launchStart(process.env)));\n`);
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(jobRunner, 'utf16le').toString('base64')], {
        env: { ...h.env, T_NODE: process.execPath, T_SCRIPT: script },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stderr);
      return { h, launch: JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as ReturnType<typeof launchStart> };
    };
    const detached = run({});
    const inJob = run({ AMIGO_NM_NO_BREAKAWAY: '1' });
    try {
      assert.ok(detached.launch.ok && inJob.launch.ok, JSON.stringify([detached.launch, inJob.launch]));
      await sleep(6000);
      assert.equal(inJob.h.state(), 'down', 'control: a start left inside the job dies when the job closes');
      if (!(detached.launch.ok && /outside/.test(detached.launch.how))) return t.diagnostic("this machine's own job forbids breakaway: only the control was checked");
      assert.equal(detached.h.state(), 'up', 'the start launched outside the job finished after the job closed');
    } finally {
      cleanup(detached.h.dir);
      cleanup(inJob.h.dir);
    }
  });

  it('ensureDaemon is what amigo daemon runs: it waits out the confirmation and the start', () => {
    const h = nmHome('refused');
    try {
      assert.equal(ensureDaemon(h.env).kind, 'restarted');
      assert.equal(h.state(), 'up');
    } finally {
      cleanup(h.dir);
    }
  });
});
