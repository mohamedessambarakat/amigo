#!/usr/bin/env node
/**
 * The user-level hook amigo installs for T3 Code (`amigo install-skill`, see t3-lead.ts). Claude Code runs it for every
 * session on this machine, so it must cost next to nothing: it loads none of amigo, reads no stdin, prints nothing and
 * exits 0 unless this session is a T3 thread in amigo's registry (t3.ts). Only then does it hand the event to amigo.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const thread = process.env.T3CODE_THREAD_ID;
let known = false;
if (thread) {
  try {
    const registry = JSON.parse(readFileSync(process.env.AMIGO_T3_REGISTRY || join(os.homedir(), '.amigo', 'state', 't3-threads.json'), 'utf8')) as { threads?: Record<string, unknown> };
    known = Boolean(registry.threads && Object.hasOwn(registry.threads, thread));
  } catch {
    // no registry: amigo never ran in T3
  }
}
if (known) {
  const { main } = await import('./cli.ts');
  process.exitCode = await main(['_t3-hook', process.argv[2] ?? '']);
}
