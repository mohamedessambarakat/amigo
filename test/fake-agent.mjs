// A stand-in for a real agent CLI, used by the tests. Behaviour comes from MODE: words in the brief.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

let prompt = process.argv.slice(2).join(' ');
const pointer = /^Read the file (.+?) and follow the instructions in it exactly\.$/.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], 'utf8');

const has = (w) => prompt.includes(w);
// MODE:hold keeps the crew member at work until the test calls releaseHeld, so a test can look at a running task without
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
  console.log('STATUS: done - PASS - looks good');
  process.exit(0);
}
if (has('MODE:manage')) {
  // A crew member trying to run amigo itself must be refused.
  const r = spawnSync(process.execPath, [process.env.CLI_PATH, 'close', 'anything', '--force'], { encoding: 'utf8' });
  const inbox = spawnSync(process.execPath, [process.env.CLI_PATH, 'inbox'], { encoding: 'utf8' });
  console.log(`STATUS: done - manage exit ${r.status}: ${r.stderr.trim()} | inbox exit ${inbox.status}`);
  process.exit(0);
}
if (has('MODE:survey')) {
  // A survey: scratch edits and a commit, a push attempt (it must be refused), the report, then the completion command.
  const report = /Write your findings to `([^`]+)`/.exec(prompt)?.[1];
  writeFileSync(join(process.cwd(), 'scratch.txt'), 'lab\n');
  const commit = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'scratch', '--allow-empty'], { encoding: 'utf8' });
  const push = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/survey-leak'], { encoding: 'utf8' });
  mkdirSync(dirname(report), { recursive: true });
  const open = has('MODE:surveycall');
  writeFileSync(report, `# Findings\n\npush exit ${push.status}: ${push.stderr.trim()}\ncommit exit ${commit.status}\n${open ? '\n## Open decisions for the Boss\n\n- a or b?\n' : ''}`);
  let completed = 'not run';
  if (!open) {
    const cmd = /run exactly `"([^"]+)" "([^"]+)" (complete [^`]+)`/.exec(prompt);
    const r = spawnSync(cmd[1], [cmd[2], ...cmd[3].split(' ')], { encoding: 'utf8' });
    completed = `exit ${r.status} ${r.stdout.trim()} ${r.stderr.trim()}`;
  }
  console.log(`STATUS: done - report written; complete: ${completed}`);
  process.exit(0);
}
if (has('MODE:switch')) execFileSync('git', ['checkout', '-q', '-b', 'elsewhere']);
const followUps = has('## Follow-ups from amigo');
if (has('MODE:question') && !followUps) {
  console.log('**STATUS: question** — which color?');
  process.exit(0);
}

// A build: its brief carries the delivery contract, the branch and the report command.
const mode = /^Delivery contract: mode=(\S+)/m.exec(prompt)?.[1] ?? null;
const branch = /^Build branch: (\S+)/m.exec(prompt)?.[1] ?? null;
const cli = /node "([^"]+)" report/.exec(prompt)?.[1] ?? null;
const report = (state, text) => {
  const r = spawnSync(process.execPath, [cli, 'report', state, text], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`STATUS: blocked - ${r.stderr.trim()}`);
    process.exit(0);
  }
};

const write = (rel, text = 'x\n') => {
  mkdirSync(dirname(join(process.cwd(), rel)), { recursive: true });
  writeFileSync(join(process.cwd(), rel), text);
};
const commit = (message) => {
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=member', '-c', 'user.email=member@localhost', 'commit', '-q', '--allow-empty', '-m', message]);
};
const finish = (what) => {
  if (mode && cli && !has('MODE:nocommit')) {
    commit('feat: write member output');
    if (mode === 'local-only') report('done', `ready in branch ${branch}`);
    else if (mode === 'direct-PR' || has('MODE:nmship')) {
      if (!has('MODE:nopush')) execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
      report('done', `PR ${process.env.FAKE_PR_URL ?? 'https://github.com/example/repo/pull/7'}${mode === 'no-mistakes' ? ' checks green' : ''}`);
    } else report('done', what);
  }
  console.log(`STATUS: done - ${what}`);
  if (has('MODE:echo')) console.log(prompt);
  process.exit(0);
};
if (has('MODE:docs')) {
  write('notes.md', 'docs\n');
  finish('wrote notes.md');
}
const file = join(process.cwd(), 'member-output.txt');
if (followUps) appendFileSync(file, 'follow-up handled\n');
else writeFileSync(file, `pointer=${Boolean(pointer)}\n`);
finish('wrote member-output.txt');
