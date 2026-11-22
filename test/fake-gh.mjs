// A stand-in for the GitHub CLI, used by the tests. It logs every call (FAKE_GH_LOG) and answers the calls amigo makes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const entry = { cwd: process.cwd(), args };
const bodyAt = args.indexOf('--body-file');
if (bodyAt >= 0) entry.body = readFileSync(args[bodyAt + 1], 'utf8');
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(entry)}\n`);

if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(process.env.FAKE_GH_ISSUE ?? '{}');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log('FAKE-PR-LIST #1 add dark mode (open)');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'list') {
  console.log('FAKE-RUN-LIST ci passed on main');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  // FAKE_GH_FAIL_PR_ONCE names a marker file: the first create fails (and writes it), later ones succeed.
  const once = process.env.FAKE_GH_FAIL_PR_ONCE;
  if (once && !existsSync(once)) {
    writeFileSync(once, '');
    console.error('fake gh: pr create failed');
    process.exit(1);
  }
  console.log('https://github.com/example/repo/pull/7');
  process.exit(0);
}
console.error(`fake gh: unexpected call: ${args.join(' ')}`);
process.exit(1);
