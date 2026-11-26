// A stand-in for an interactive agent session (as `agy -i`), used by the tests. It draws its "screen" on stdout, writes a line
// to stderr, reports through the status command and then stays open, as a session waiting for its next message does, until
// it is stopped. MODE:quit ends the session at once without reporting.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let prompt = process.argv.slice(2).join(' ');
const pointer = /^Read the file (.+?) and follow the instructions in it exactly\.$/.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], 'utf8');

// What its stdout is: the tab's own terminal in a real tab (here the null device the test tab has), never a pipe to amigo.
writeFileSync(join(process.cwd(), 'session.txt'), `stdout=${process.stdout._type}\nnotes=${prompt.includes('Nothing reads your screen')}\n`);
console.log('fake interactive screen');
console.error('fake interactive stderr');
if (prompt.includes('MODE:quit')) process.exit(4);

const cli = /node "([^"]+)" report/.exec(prompt)?.[1];
const r = spawnSync(process.execPath, [cli, 'report', 'done', 'screen is up'], { encoding: 'utf8' });
if (r.status !== 0) console.error(`report failed: ${r.stderr.trim()}`);
// The session stays open for the next message; the time limit only stops an orphan when a test fails before it ends this.
setTimeout(() => process.exit(0), 120_000);
