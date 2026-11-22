// A stand-in for no-mistakes' daemon commands, used by the tests. Its daemon is the word in FAKE_NM_STATE:
//   up        `daemon status` says running
//   down      `daemon status` says not running
//   refused   `daemon status` fails with a refused socket, as v1.84 does when the daemon died without cleaning up
//   hang      `daemon status` never answers (a timeout is not evidence the daemon is down)
//   garbled   `daemon status` prints something it does not recognise
// `daemon start` turns the state to up (FAKE_NM_START_FAILS: it fails instead). Every call is logged to FAKE_NM_LOG with NM_HOME.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_NM_STATE;
if (process.env.FAKE_NM_LOG) appendFileSync(process.env.FAKE_NM_LOG, `${JSON.stringify({ args, nmHome: process.env.NM_HOME ?? null })}\n`);
const state = () => readFileSync(stateFile, 'utf8').trim();

if (args[0] === 'daemon' && args[1] === 'status') {
  const s = state();
  if (s === 'hang') setTimeout(() => process.exit(0), 30_000);
  else if (s === 'up') console.log('  ● daemon running (pid 4242)');
  else if (s === 'down') console.log('  ○ daemon not running');
  else if (s === 'refused') {
    console.error('connect to daemon socket: dial ipc: dial tcp 127.0.0.1:1: connectex: No connection could be made because the target machine actively refused it.');
    process.exit(1);
  } else console.log('something else entirely');
} else if (args[0] === 'daemon' && args[1] === 'start') {
  if (process.env.FAKE_NM_START_FAILS) {
    console.error('managed startup failed');
    process.exit(1);
  }
  writeFileSync(stateFile, 'up');
  console.log('daemon started');
} else {
  console.error(`fake no-mistakes: unexpected call ${args.join(' ')}`);
  process.exit(2);
}
