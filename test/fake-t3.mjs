#!/usr/bin/env node
// A fake t3 CLI (T3 Code v0.1.13's command shapes): projects and threads live in the JSON file FAKE_T3_STATE, and every call
// is logged there too. Answers mirror the real CLI's (see test/t3.test.ts for where each shape was taken from).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.env.FAKE_T3_STATE;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { projects: {}, threads: {}, calls: [], n: 0 };
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const args = process.argv.slice(2);
const stdin = () => (args.includes('-') ? readFileSync(0, 'utf8') : null);
state.calls.push(args);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fail = (text, code = 1) => {
  save();
  process.stderr.write(`[00:00:00.000] ERROR (#2): ${text}\n    at fake\n`);
  process.exit(code);
};
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const projectOf = (ref) => Object.keys(state.projects).find((id) => id === ref || same(state.projects[id].path, ref));

const [group, verb, target] = args;
if (group === '--version') {
  process.stdout.write('t3 v0.1.13\n');
} else if (group === 'project' && verb === 'add') {
  if (projectOf(target)) fail(`ProjectAlreadyExistsError: An active project already exists for '${target}'.`);
  const id = `proj-${++state.n}`;
  state.projects[id] = { path: target, title: flag('--title') ?? null };
  process.stdout.write(`Added project ${id} (${flag('--title') ?? 'x'}) at ${target}.\n`);
} else if (group === 'project' && verb === 'remove') {
  const id = projectOf(target);
  if (!id) fail(`ProjectNotFoundError: No active project found for '${target}'.`);
  const threads = Object.keys(state.threads).filter((t) => state.threads[t].projectId === id);
  if (threads.length && !args.includes('--force')) fail('ProjectLiveServerDeclaredResponseError: Server request failed (invalid_request).');
  for (const t of threads) delete state.threads[t];
  delete state.projects[id];
  process.stdout.write(`Removed project ${id} (x).\n`);
} else if (group === 'thread' && verb === 'start') {
  const projectId = projectOf(target);
  if (!projectId) fail(`ProjectNotFoundError: No active project found for '${target}'.`);
  const threadId = `mcp:fake-${++state.n}`;
  state.threads[threadId] = { threadId, projectId, title: flag('--title'), providerInstanceId: flag('--provider'), model: flag('--model'), options: args.filter((_, i) => args[i - 1] === '--option'), status: process.env.FAKE_T3_STATUS || 'completed', activeRunId: null, pendingRequestCount: 0, archived: false, messages: [{ role: 'user', text: stdin() }] };
  process.stdout.write(JSON.stringify({ threadId, projectId, runId: `run:thread:${threadId}:ordinal:1` }));
} else if (group === 'thread' && (verb === 'show' || verb === 'send')) {
  const t = state.threads[target];
  if (!t) {
    save();
    process.stdout.write(`Thread ${target} is no longer available.\n`);
    process.exit(1);
  }
  if (verb === 'send') {
    t.messages.push({ role: 'user', text: stdin() });
    process.stdout.write(JSON.stringify({ threadId: target, status: 'starting', delivery: 'started' }));
  } else {
    const { messages, options, ...thread } = t;
    process.stdout.write(JSON.stringify({ thread: { ...thread, link: 'https://app.t3.codes/x', runCount: 1 }, messages: [], error: null }));
  }
} else {
  fail(`fake t3: unknown command ${args.join(' ')}`);
}
save();
