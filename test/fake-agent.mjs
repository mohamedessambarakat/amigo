// A stand-in for a real agent CLI, used by the tests. Behaviour comes from MODE: words in the brief.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

let prompt = process.argv.slice(2).join(' ');
const pointer = /^Read the file (.+?) and follow the instructions in it exactly\.$/.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], 'utf8');

const has = (w) => prompt.includes(w);
// MODE:hold keeps the squad member at work until the test calls releaseHeld, so a test can look at a running task without
// racing it. The time limit only stops an orphan when a test fails before it releases.
if (has('MODE:hold')) {
  const gate = `${process.env.AMIGO_HOME}.release-held`;
  for (const end = Date.now() + 120_000; !existsSync(gate) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
}
console.log(`fake agent in ${process.cwd()} (task ${process.env.AMIGO_TASK ?? '?'})`);
if (has('MODE:amigo')) {
  console.log(prompt.split('## Briefing')[1] ?? '');
  process.exit(0);
}
if (has('MODE:fail')) {
  console.error('something broke');
  process.exit(3);
}
if (has('You are a reviewer')) {
  console.log(has('MODE:reviewfail') ? 'STATUS: done - FAIL - found a problem' : 'STATUS: done - PASS - looks good');
  process.exit(0);
}
if (has('MODE:manage')) {
  // A squad member trying to run amigo itself must be refused.
  const r = spawnSync(process.execPath, [process.env.CLI_PATH, 'close', 'anything', '--force'], { encoding: 'utf8' });
  const inbox = spawnSync(process.execPath, [process.env.CLI_PATH, 'inbox'], { encoding: 'utf8' });
  console.log(`STATUS: done - manage exit ${r.status}: ${r.stderr.trim()} | inbox exit ${inbox.status}`);
  process.exit(0);
}
if (has('MODE:switch')) execFileSync('git', ['checkout', '-q', '-b', 'elsewhere']);
const followUps = has('## Follow-ups from amigo');
if (has('MODE:question') && !followUps) {
  console.log('**STATUS: question** — which color?');
  process.exit(0);
}
const write = (rel, text = 'x\n') => {
  mkdirSync(dirname(join(process.cwd(), rel)), { recursive: true });
  writeFileSync(join(process.cwd(), rel), text);
};
// Every done report proposes a commit subject in the file the prompt names, as squad members without hooks are told to;
// MODE:nocommit, MODE:badcommit, MODE:dropcommit (no subject on follow-ups) and MODE:echo (prints its prompt, no file) break that.
const subjectFile = /`([^`\n]*commit-subject\.txt)`/.exec(prompt)?.[1];
const subject = has('MODE:nocommit') || has('MODE:echo') || (has('MODE:dropcommit') && followUps) ? null : has('MODE:badcommit') ? 'Wrote the member output file' : 'feat: write member output';
const finish = (what) => {
  if (subject && subjectFile) writeFileSync(subjectFile, `${subject}\n`);
  console.log(`STATUS: done - ${what}`);
  // Echoes its input after its own report, so the log ends with whatever the brief or issue said.
  if (has('MODE:echo')) console.log(prompt);
  process.exit(0);
};
if (has('MODE:big')) {
  for (let i = 1; i <= 4; i++) write(`big-${i}.txt`);
  finish('wrote 4 files');
}
if (has('MODE:risky')) {
  write('src/auth/login.txt');
  finish('wrote src/auth/login.txt');
}
if (has('MODE:manifest')) {
  write('package.json', '{}\n');
  finish('wrote package.json');
}
if (has('MODE:binary')) {
  // A binary file with a docs-looking name: git cannot count its lines.
  writeFileSync(join(process.cwd(), 'notes.md'), Buffer.from([0, 1, 2, 3, 255, 0]));
  finish('wrote a binary notes.md');
}
if (has('MODE:instructions')) {
  write('CLAUDE.md', 'be nice\n');
  finish('wrote CLAUDE.md');
}
if (has('MODE:testedit')) {
  write('test/a.test.js', 'one\n'); // the committed file has three lines: this deletes two
  finish('shortened test/a.test.js');
}
if (has('MODE:testadd')) {
  write('test/new.test.js', 'a new test\n');
  finish('added test/new.test.js');
}
if (has('MODE:docs')) {
  write('notes.md', 'docs\n');
  finish('wrote notes.md');
}
// MODE:badselfcommit and MODE:goodselfcommit commit the work themselves, which squad members are told never to do.
const selfCommit = has('MODE:badselfcommit') ? 'Totally not a valid subject' : has('MODE:goodselfcommit') ? 'fix: commit it myself' : null;
if (selfCommit) {
  write('member-output.txt', 'self\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=member', '-c', 'user.email=member@localhost', 'commit', '-q', '-m', selfCommit]);
  finish('committed member-output.txt myself');
}
const file = join(process.cwd(), 'member-output.txt');
if (followUps) appendFileSync(file, 'follow-up handled\n');
else writeFileSync(file, `pointer=${Boolean(pointer)}\n`);
finish('wrote member-output.txt');
