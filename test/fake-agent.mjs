// A stand-in for a real agent CLI, used by the tests. Behaviour comes from MODE: words in the brief.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

let prompt = process.argv.slice(2).join(' ');
const pointer = /^Read the file (.+?) and follow the instructions in it exactly\.$/.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], 'utf8');

const has = (w) => prompt.includes(w);
if (has('MODE:sleep')) await new Promise((r) => setTimeout(r, 2500));
console.log(`fake agent in ${process.cwd()} (task ${process.env.OCTOMAXXING_TASK ?? '?'})`);
if (has('MODE:head')) {
  console.log(prompt.split('## Start')[1] ?? '');
  process.exit(0);
}
if (has('MODE:fail')) {
  console.error('something broke');
  process.exit(3);
}
if (has('You are a reviewer')) {
  console.log('STATUS: done - looks good');
  process.exit(0);
}
if (has('MODE:manage')) {
  // An arm trying to run octomaxxing itself must be refused.
  const r = spawnSync(process.execPath, [process.env.CLI_PATH, 'close', 'anything', '--force'], { encoding: 'utf8' });
  const inbox = spawnSync(process.execPath, [process.env.CLI_PATH, 'inbox'], { encoding: 'utf8' });
  console.log(`STATUS: done - manage exit ${r.status}: ${r.stderr.trim()} | inbox exit ${inbox.status}`);
  process.exit(0);
}
if (has('MODE:switch')) execFileSync('git', ['checkout', '-q', '-b', 'elsewhere']);
const followUps = has('## Follow-ups from the head');
if (has('MODE:question') && !followUps) {
  console.log('**STATUS: question** — which color?');
  process.exit(0);
}
const file = join(process.cwd(), 'arm-output.txt');
if (followUps) appendFileSync(file, 'follow-up handled\n');
else writeFileSync(file, `pointer=${Boolean(pointer)}\n`);
console.log('STATUS: done - wrote arm-output.txt');
