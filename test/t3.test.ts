import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeRoot } from '../src/paths.ts';
import { installSkills, removeSkills } from '../src/skills.ts';
import { adoptT3Env, readRegistry, t3Runner, type T3Registry } from '../src/t3.ts';
import { t3HookCommand, T3_HOOK_EVENTS, withoutT3Hooks, withT3Hooks } from '../src/t3-lead.ts';
import { getTask, runnerAlive } from '../src/tasks.ts';
import { backendVersionWarnings, terminalBackend, type Endpoint } from '../src/terminal.ts';
import { cleanup, cli, idFrom, makeHome, waitFor } from './helpers.ts';

const fakeT3 = join(codeRoot, 'test', 'fake-t3.mjs');
const gate = join(codeRoot, 'src', 't3-hook.ts');
const LEAD = 'mcp:lead-thread';

/**
 * A home inside a fake T3 Code: T3CODE_* point at test/fake-t3.mjs (a .cmd shim on Windows, as the real t3 is), whose state
 * file holds the lead thread. The registry and the Claude settings are files of the test's own.
 */
function t3Home(): { dir: string; env: NodeJS.ProcessEnv; state: () => { projects: Record<string, { path: string }>; threads: Record<string, Record<string, unknown> & { messages: { text: string | null }[] }>; calls: string[][] } } {
  const { dir, env } = makeHome();
  const win = process.platform === 'win32';
  const shim = join(dir, win ? 't3.cmd' : 't3');
  writeFileSync(shim, win ? `@echo off\r\n"${process.execPath}" "${fakeT3}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakeT3}" "$@"\n`, { mode: 0o755 });
  const stateFile = join(dir, 'fake-t3.json');
  writeFileSync(stateFile, JSON.stringify({ projects: { 'proj-lead': { path: dir } }, threads: { [LEAD]: { threadId: LEAD, projectId: 'proj-lead', model: 'sonnet', status: 'running', activeRunId: 'run:1', pendingRequestCount: 0, archived: false, messages: [] } }, calls: [], n: 0 }));
  // Claude Code crew members only: the t3 backend starts them as T3 threads.
  writeFileSync(join(env.AMIGO_HOME as string, 'config', 'config.json'), JSON.stringify({ agents: { claude: { amigo: ['claude', '{prompt}'], member: ['claude', '--permission-mode', 'auto', '{prompt}'] } }, memberMb: 0, reserveMb: 0 }));
  const t3env: NodeJS.ProcessEnv = { ...env, AMIGO_TERMINAL: undefined, T3CODE_THREAD_ID: LEAD, T3CODE_CLI_PATH: shim, FAKE_T3_STATE: stateFile, AMIGO_T3_REGISTRY: join(dir, 't3-threads.json'), AMIGO_CLAUDE_SETTINGS: join(dir, 'claude-settings.json'), CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: 'lead-session' };
  delete t3env.AMIGO_TERMINAL;
  return { dir, env: t3env, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

const registry = (env: NodeJS.ProcessEnv): T3Registry => readRegistry(env);

describe('t3 backend', () => {
  it('is picked inside a T3 thread; herdr-app carried into a tab still wins, and the refusal names both hosts', () => {
    assert.equal(terminalBackend({ T3CODE_THREAD_ID: 'mcp:x', T3CODE_CLI_PATH: 't3' }).name, 't3');
    assert.equal(terminalBackend({ AMIGO_TERMINAL: 't3', T3CODE_CLI_PATH: 't3' }).name, 't3');
    assert.equal(terminalBackend({ AMIGO_TERMINAL: 'herdr-app', T3CODE_THREAD_ID: 'mcp:x', T3CODE_CLI_PATH: 't3' }).name, 'herdr-app');
    assert.throws(() => terminalBackend({ T3CODE_THREAD_ID: 'mcp:x' }), /herdr desktop app \(herdr-app\) or a T3 Code thread[\s\S]*no HC_TERMINAL_ID/, 'a thread id alone does not make a T3 thread');
  });

  it("checks t3's version, not herdr-app's, inside a T3 thread", () => {
    const inT3 = { T3CODE_THREAD_ID: 'mcp:x', T3CODE_CLI_PATH: 't3' };
    const herdrNotAsked = () => assert.fail('herdr-app is not asked in T3');
    const t3Says = (stdout: string) => () => ({ status: 0, stdout, stderr: '' });
    assert.deepEqual(backendVersionWarnings(inT3, herdrNotAsked, t3Says('t3 v0.1.13\n')), []);
    assert.deepEqual(backendVersionWarnings(inT3, herdrNotAsked, t3Says('t3 v0.2.0\n')), ['t3 0.2.0 is installed, but amigo was tested with 0.1.13: crew member threads may misbehave until amigo is checked against it.']);
    assert.match(backendVersionWarnings(inT3, herdrNotAsked, () => ({ status: 1, stdout: '', stderr: 'gone' }))[0]!, /t3 did not report its version/);
  });

  it('starts a crew thread in its folder with the prompt on stdin, records it, and reads, rings and closes only its own', () => {
    const { dir, env, state } = t3Home();
    try {
      const work = join(dir, 'work');
      mkdirSync(work);
      const backend = terminalBackend(env);
      // The runner argv names no program here: its detached spawn fails on its own, which open() ignores.
      const open = (task: string, cwd: string, agent: { model?: string; effort?: string } = {}) =>
        backend.open({ task, cwd: dir, argv: [join(dir, 'no-runner')], dir, env: {}, placement: { label: `${task} · Fix "the" 100% footer`, ownSpace: true, spaces: [] }, agent: { cwd, prompt: `brief of ${task}\nline two`, ...agent } });
      const ep = open('1-fix', work, { effort: 'high' });
      assert.equal(ep.backend, 't3');
      const s = state();
      const thread = s.threads[ep.terminal]!;
      assert.equal(thread.providerInstanceId, 'claudeAgent');
      assert.equal(thread.model, 'opus', 'no lead registered: the default model');
      assert.deepEqual(thread.options, ['effort=high']);
      assert.equal(thread.title, '1-fix · Fix  the  100  footer'.replace(/\s+/g, ' '), 'characters cmd.exe cannot carry are taken out of the title');
      assert.equal(thread.messages[0]!.text!.replace(/\r\n/g, '\n'), 'brief of 1-fix\nline two', 'the prompt goes in on stdin');
      assert.equal(s.projects[thread.projectId as string]!.path, work);
      const reg = registry(env);
      assert.deepEqual({ ...reg.threads[ep.terminal], at: 'x' }, { role: 'crew', home: env.AMIGO_HOME, task: '1-fix', project: thread.projectId, at: 'x' });
      assert.deepEqual(reg.projects[thread.projectId as string], { cwd: work, home: env.AMIGO_HOME });

      assert.deepEqual(backend.state(ep), { liveness: 'live', busy: 'idle', input: 'ready' });
      backend.send(ep, '--looks like a flag');
      assert.equal(state().threads[ep.terminal]!.messages.at(-1)!.text!.trim(), '--looks like a flag');
      assert.throws(() => backend.interrupt(ep), /t3_thread_interrupt tool, threadId "mcp:fake-\d+"/);
      assert.deepEqual(backend.list().map((e) => [e.task, e.terminal, e.liveness]), [['1-fix', ep.terminal, 'live']]);

      // Not ours: another task, another home, a thread amigo never started, a thread T3 no longer has.
      const other: Endpoint = { ...ep, task: '2-other' };
      assert.equal(backend.state(other).liveness, 'foreign');
      assert.throws(() => backend.send(other, 'hi'), /Cannot send to 2-other: its T3 thread .* is foreign/);
      assert.throws(() => backend.close(other), /not 2-other's in amigo's registry/);
      assert.equal(terminalBackend({ ...env, AMIGO_HOME: join(dir, 'another-home') }).state(ep).liveness, 'foreign', 'the same task id in another home is not ours');
      assert.equal(backend.state({ ...ep, terminal: LEAD }).liveness, 'foreign', 'the lead thread is never a crew member');
      assert.equal(backend.state({ ...ep, terminal: 'mcp:gone' }).liveness, 'absent');
      assert.equal(terminalBackend({ ...env, T3CODE_CLI_PATH: join(dir, 'no-such-t3') }).state(ep).liveness, 'unreadable');

      // A reviewer in the same folder shares amigo's project: closing it keeps the project, closing the last one removes it.
      const reviewer = open('3-review', work);
      assert.equal(state().threads[reviewer.terminal]!.projectId, thread.projectId, 'one T3 project per folder');
      backend.close(reviewer);
      assert.ok(state().projects[thread.projectId as string], 'the project stays while 1-fix uses it');
      assert.equal(registry(env).threads[reviewer.terminal], undefined);
      // A relaunch after the thread was archived starts a new thread in the same project: the old one is no longer the task's,
      // and it does not keep the project alive at close.
      const again = open('1-fix', work);
      assert.deepEqual(Object.keys(registry(env).threads), [again.terminal]);
      assert.equal(backend.state(ep).liveness, 'foreign', "the earlier thread is not the task's any more");
      backend.close(again);
      assert.equal(state().projects[thread.projectId as string], undefined, 'removed with both threads');
      assert.equal(state().threads[ep.terminal], undefined);
      assert.deepEqual(registry(env), { threads: {}, projects: {} });
      backend.close(again); // gone already is success

      // A folder the Boss added himself: the thread runs there, and the project is never removed.
      const own = join(dir, 'boss-project');
      mkdirSync(own);
      spawnSync(process.execPath, [fakeT3, 'project', 'add', own], { env: { ...process.env, FAKE_T3_STATE: env.FAKE_T3_STATE } });
      const inOwn = open('4-own', own);
      backend.close(inOwn);
      assert.ok(Object.values(state().projects).some((p) => p.path === own), "the Boss's project stays");
      assert.ok(state().threads[inOwn.terminal], 'its thread stays too (T3 cannot delete one thread), forgotten by amigo');
      assert.equal(backend.state(inOwn).liveness, 'foreign');
    } finally {
      cleanup(dir);
    }
  });

  it('fails loudly when T3 refuses, and removes the project it added for nothing', () => {
    const { dir, env, state } = t3Home();
    try {
      const work = join(dir, 'work');
      mkdirSync(work);
      const run = t3Runner(env);
      const refusing = (args: string[], input?: string) => (args[1] === 'start' ? { status: 1, stdout: '', stderr: 'Model x on provider claudeAgent rejected options: Option effort must be one of: low, medium.' } : run(args, input));
      const backend = terminalBackend(env, { t3Runner: refusing });
      assert.throws(() => backend.open({ task: '1-x', cwd: dir, argv: ['runner'], dir, env: {}, placement: { label: '1-x', ownSpace: true, spaces: [] }, agent: { cwd: work, prompt: 'p', effort: 'bogus' } }), /Could not start the crew member's T3 thread: Model x on provider claudeAgent rejected options/);
      assert.deepEqual(Object.keys(state().projects), ['proj-lead']);
      assert.deepEqual(registry(env), { threads: {}, projects: {} });
      assert.throws(() => backend.open({ task: '1-x', cwd: dir, argv: ['runner'], dir, env: {}, placement: { label: '1-x', ownSpace: true, spaces: [] } }), /starts the agent itself/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('t3 hooks in user settings', () => {
  it('adds one dispatcher entry per event beside the user\'s own hooks, replaces an older one, and removes only its own', () => {
    const mine = { type: 'command', command: 'node guard-edits.js' };
    const user = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }], PreToolUse: [{ matcher: 'Edit', hooks: [mine] }] } };
    const once = withT3Hooks(user);
    for (const e of T3_HOOK_EVENTS) assert.equal(once.hooks![e]!.filter((g) => JSON.stringify(g).includes('t3-hook.ts')).length, 1, e);
    assert.deepEqual(once.hooks!.Stop![0], { hooks: [mine] }, "the user's Stop hook is kept, first");
    assert.deepEqual(once.hooks!.Stop![1], { hooks: [{ type: 'command', command: t3HookCommand('Stop'), timeout: 90 }] });
    const moved = JSON.parse(JSON.stringify(once).replaceAll(codeRoot.replace(/\\/g, '/'), 'C:/old/amigo'));
    assert.deepEqual(withT3Hooks(moved), once, 'an entry from another code folder is replaced, not doubled');
    assert.deepEqual(withoutT3Hooks(once), user);
    assert.deepEqual(withoutT3Hooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t3HookCommand('Stop') }, mine] }] } }), { hooks: { Stop: [{ hooks: [mine] }] } }, 'a shared group keeps its other hooks');
  });

  it('install-skill writes it only where T3 Code is installed, and --remove takes it out', () => {
    const { dir, env } = makeHome();
    try {
      const userHome = join(dir, 'user');
      const settings = join(userHome, '.claude', 'settings.json');
      installSkills('claude', env, userHome);
      assert.equal(existsSync(settings), false, 'no T3 Code here: no hook');
      mkdirSync(join(userHome, '.t3', 'bin'), { recursive: true });
      mkdirSync(join(userHome, '.claude'), { recursive: true });
      writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
      assert.match(installSkills('claude', env, userHome).join('\n'), /t3: added the T3 Code hook to .*settings\.json/);
      assert.match(installSkills('claude', env, userHome).join('\n'), /t3: the T3 Code hook is already in/);
      assert.equal(JSON.parse(readFileSync(settings, 'utf8')).theme, 'dark');
      writeFileSync(join(dir, 'broken.json'), '{ not json');
      assert.throws(() => installSkills('claude', { ...env, AMIGO_CLAUDE_SETTINGS: join(dir, 'broken.json') }, userHome), /Cannot read .*broken\.json/, 'a settings file amigo cannot read is never overwritten');
      assert.match(removeSkills('claude', userHome, env).join('\n'), /removed the T3 Code hook from/);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { theme: 'dark' });
    } finally {
      cleanup(dir);
    }
  });
});

describe('amigo in a T3 thread', () => {
  it('gives every registered thread its home and task, and leaves other threads alone', () => {
    const { dir, env } = t3Home();
    try {
      writeFileSync(env.AMIGO_T3_REGISTRY as string, JSON.stringify({ threads: { 'mcp:c': { role: 'crew', home: '/h', task: '5-x', at: '' }, 'mcp:l': { role: 'lead', home: '/h', at: '' } }, projects: {} }));
      const base = { AMIGO_T3_REGISTRY: env.AMIGO_T3_REGISTRY };
      assert.deepEqual(adoptT3Env({ ...base, T3CODE_THREAD_ID: 'mcp:c' }), { ...base, T3CODE_THREAD_ID: 'mcp:c', AMIGO_HOME: '/h', AMIGO_TASK: '5-x' });
      assert.deepEqual(adoptT3Env({ ...base, T3CODE_THREAD_ID: 'mcp:l' }), { ...base, T3CODE_THREAD_ID: 'mcp:l', AMIGO_HOME: '/h' });
      assert.deepEqual(adoptT3Env({ ...base, T3CODE_THREAD_ID: 'mcp:l', AMIGO_HOME: '/mine' }).AMIGO_HOME, '/mine', 'a home that is set wins');
      assert.equal(adoptT3Env({ ...base, T3CODE_THREAD_ID: 'mcp:c', AMIGO_HOME: '/mine' }).AMIGO_TASK, undefined, 'a task id of another home names no task here');
      assert.deepEqual(adoptT3Env({ ...base, T3CODE_THREAD_ID: 'mcp:other' }), { ...base, T3CODE_THREAD_ID: 'mcp:other' });
    } finally {
      cleanup(dir);
    }
  });

  it('`amigo` becomes the lead: digest, lock and contract; a scratch crew member runs as a thread, reports through the hook and closes', async () => {
    const { dir, env, state } = t3Home();
    try {
      const lead = cli(env, []);
      assert.equal(lead.code, 0, lead.err);
      assert.match(lead.out, /LOCK: this session controls/);
      assert.match(lead.out, /you run in a T3 Code thread/);
      assert.match(lead.out, /SUPERVISION IS DOWN: amigo's T3 hook is not in/, 'no dispatcher hook installed in this test');
      assert.doesNotMatch(lead.out, /SendMessage to `amigo-<id>`/);
      assert.equal(registry(env).threads[LEAD]?.role, 'lead');
      assert.equal(registry(env).threads[LEAD]?.model, 'sonnet', "the lead thread's model, read from T3");
      assert.equal(cli(env, ['brief']).code, 0, '/amigo in the same thread runs the same brief');
      assert.equal(cli(env, ['rotate']).code, 1);
      // A second T3 thread while this one leads: the digest says read-only, and it gets no contract.
      const second = cli({ ...env, T3CODE_THREAD_ID: 'mcp:second', CLAUDE_PID: String(process.ppid), CLAUDE_CODE_SESSION_ID: 'second-session' }, []);
      assert.equal(second.code, 0, second.err);
      assert.match(second.out, /LOCK: READ-ONLY[\s\S]*This T3 thread is not amigo/);
      assert.doesNotMatch(second.out, /you run in a T3 Code thread/);
      assert.equal(registry(env).threads['mcp:second'], undefined);

      const spawned = cli(env, ['spawn', '--scratch', '--title', 'Probe the thing'], 'Look around and report.');
      assert.equal(spawned.code, 0, spawned.err);
      assert.match(spawned.out, /in a new T3 Code thread, provider claudeAgent/);
      const id = idFrom(spawned.out);
      const task = getTask(id, env)!;
      assert.equal(task.status, 'running');
      assert.equal(task.endpoint?.backend, 't3');
      assert.equal(task.amigoAddress, undefined, 'T3 crew members report through amigo report, not SendMessage');
      const thread = state().threads[task.endpoint!.terminal]!;
      assert.equal(thread.model, 'sonnet', "a task without a model gets the lead's");
      assert.match(thread.messages[0]!.text!, /You are a T3 Code thread amigo started[\s\S]*Look around and report\./);

      // The crew thread's own commands and hooks know their task from the registry alone.
      const crew: NodeJS.ProcessEnv = { ...env, AMIGO_HOME: undefined, T3CODE_THREAD_ID: task.endpoint!.terminal, CLAUDE_PID: undefined };
      delete crew.AMIGO_HOME;
      assert.match(cli(crew, ['spawn', '--scratch'], 'x').err, new RegExp(`running inside crew member ${id}`));
      assert.equal(cli(crew, ['report', 'working', 'reading files']).code, 0);
      const hook = (event: string, payload: object) => spawnSync(process.execPath, [gate, event], { input: JSON.stringify(payload), encoding: 'utf8', env: crew });
      assert.equal(hook('SessionStart', { session_id: 'crew-session', source: 'startup' }).stdout, '', "the thread's own session is pinned");
      const nested = hook('Stop', { session_id: 'nested-session', last_assistant_message: 'I am a claude -p run inside the thread.', stop_hook_active: false });
      assert.deepEqual([nested.status, nested.stdout], [0, ''], "a nested session's turn end is not the crew member's");
      assert.equal(getTask(id, env)!.status, 'running');
      const blocked = hook('Stop', { session_id: 'crew-session', last_assistant_message: 'I looked.', stop_hook_active: false });
      assert.equal(blocked.status, 0, blocked.stderr);
      assert.match(blocked.stdout, /"decision":"block".*STATUS: done\|blocked\|question/, 'a turn without its STATUS line is sent back');
      const done = hook('Stop', { last_assistant_message: 'Looked.\nSTATUS: done - it is fine', stop_hook_active: false });
      assert.equal(done.stdout, '');
      assert.equal((await waitFor(id, env, ['done'])).summary, 'it is fine');

      // The runner beats while the thread lives, so a relaunch goes into the same thread as its next turn.
      for (let i = 0; i < 100 && !runnerAlive(id, env); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(runnerAlive(id, env), 'the runner beats for the thread');
      const relaunched = cli(env, ['control', id, 'relaunch', '--note', 'check the second folder too']);
      assert.equal(relaunched.code, 0, relaunched.err);
      assert.match(relaunched.out, /Relaunched/);
      assert.match(state().threads[task.endpoint!.terminal]!.messages.at(-1)!.text!, /Follow-up from amigo:[\s\S]*check the second folder too/);
      assert.equal(Object.keys(state().threads).length, 2, 'no second crew thread');
      assert.equal(getTask(id, env)!.status, 'running');
      assert.equal(hook('Stop', { last_assistant_message: 'STATUS: done - both folders fine', stop_hook_active: false }).stdout, '');
      await waitFor(id, env, ['done']);

      const sent = cli(env, ['send', id, 'one more thing']);
      assert.equal(sent.code, 0, sent.err);
      assert.match(state().threads[task.endpoint!.terminal]!.messages.at(-1)!.text!, /inbox/i, 'the doorbell is queued as the thread\'s next turn');

      // T3 not answering is never a reason to start a second thread beside one that may still work.
      const blind = cli({ ...env, T3CODE_CLI_PATH: join(dir, 'no-such-t3.cmd') }, ['control', id, 'relaunch', '--note', 'again']);
      assert.match(blind.out, /Could not relaunch .*is unreadable, so no new thread was started beside it/);
      assert.equal(Object.keys(state().threads).length, 2, 'still one crew thread');

      const closed = cli(env, ['close', id]);
      assert.equal(closed.code, 0, closed.err);
      assert.equal(getTask(id, env)!.status, 'closed');
      assert.equal(state().threads[task.endpoint!.terminal], undefined, "the crew member's project went with its thread");
      assert.deepEqual(Object.keys(registry(env).threads), [LEAD]);
    } finally {
      cleanup(dir);
    }
  });

  it('the dispatcher hook does nothing, fast, outside threads amigo registered', () => {
    const { dir, env } = t3Home();
    try {
      for (const thread of [undefined, 'mcp:not-amigos']) {
        const e: NodeJS.ProcessEnv = { ...env, T3CODE_THREAD_ID: thread };
        if (!thread) delete e.T3CODE_THREAD_ID;
        const started = Date.now();
        const r = spawnSync(process.execPath, [gate, 'Stop'], { input: '{}', encoding: 'utf8', env: e });
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], String(thread));
        process.stdout.write(`# dispatcher no-op (${thread ?? 'no T3 thread'}): ${Date.now() - started} ms\n`);
      }
    } finally {
      cleanup(dir);
    }
  });
});
