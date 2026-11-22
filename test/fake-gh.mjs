// A stand-in for the GitHub CLI, used by the tests. It logs every call (FAKE_GH_LOG) and answers the calls amigo makes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
// A pull request whose live state is a JSON file (FAKE_GH_PR): `pr view` prints it, `pr merge` merges it. With FAKE_GH_ORIGIN (a bare
// repo), a merge moves that repo's main to the PR head, as a fast-forward merge on GitHub would.
const prFile = process.env.FAKE_GH_PR;
const readPr = () => JSON.parse(readFileSync(prFile, 'utf8'));
if (args[0] === 'pr' && args[1] === 'view' && prFile) {
  const pr = readPr();
  // FAKE_GH_UNKNOWN_READS: the first N reads say mergeable UNKNOWN, as while GitHub is still computing it.
  const unknown = Number(process.env.FAKE_GH_UNKNOWN_READS ?? 0);
  const reads = existsSync(`${prFile}.reads`) ? Number(readFileSync(`${prFile}.reads`, 'utf8')) : 0;
  writeFileSync(`${prFile}.reads`, String(reads + 1));
  if (reads < unknown) pr.mergeable = 'UNKNOWN';
  console.log(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge' && prFile) {
  const pr = readPr();
  const pinned = args[args.indexOf('--match-head-commit') + 1];
  if (args.indexOf('--match-head-commit') < 0 || pinned !== pr.headRefOid) {
    console.error('fake gh: head commit does not match');
    process.exit(1);
  }
  if (process.env.FAKE_GH_ORIGIN) execFileSync('git', ['--git-dir', process.env.FAKE_GH_ORIGIN, 'update-ref', 'refs/heads/main', pr.headRefOid]);
  writeFileSync(prFile, JSON.stringify({ ...pr, state: 'MERGED', mergeCommit: { oid: pr.headRefOid } }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => /\/check-runs$/.test(a))) {
  // FAKE_GH_CHECK_RUNS: JSON lines {name, app, head_sha}, as amigo's --jq filter prints them; "fail" fails the read.
  if (process.env.FAKE_GH_CHECK_RUNS === 'fail') {
    console.error('gh: Server Error (HTTP 502)');
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_GH_CHECK_RUNS ?? '');
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => /\/pulls\/\d+\/files(\?|$)/.test(a))) {
  // FAKE_GH_PR_FILES: JSON lines {filename, status}, as amigo's --jq filter prints them; "fail" fails the read. Unset: no files.
  if (process.env.FAKE_GH_PR_FILES === 'fail') {
    console.error('gh: Server Error (HTTP 502)');
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_GH_PR_FILES ?? '');
  process.exit(0);
}
// FAKE_GH_PR_COMMITS: a JSON object {sha: [{filename, status}, ...]} in commit order, or "fail" (both reads fail). The PR's commit
// list prints {sha} lines, and each commit read prints its files, as amigo's --jq filters do.
const prCommits = () => {
  if (process.env.FAKE_GH_PR_COMMITS === 'fail') {
    console.error('gh: Server Error (HTTP 502)');
    process.exit(1);
  }
  return JSON.parse(process.env.FAKE_GH_PR_COMMITS ?? '{}');
};
if (args[0] === 'api' && args.some((a) => /\/pulls\/\d+\/commits(\?|$)/.test(a))) {
  process.stdout.write(Object.keys(prCommits()).map((sha) => JSON.stringify({ sha })).join('\n'));
  process.exit(0);
}
const commitArg = args.find((a) => /\/commits\/[0-9a-f]{40}(\?|$)/.test(a));
if (args[0] === 'api' && commitArg) {
  const files = prCommits()[/\/commits\/([0-9a-f]{40})/.exec(commitArg)[1]];
  if (!files) {
    console.error('gh: Not Found (HTTP 404)');
    process.exit(1);
  }
  process.stdout.write(files.map((f) => JSON.stringify(f)).join('\n'));
  process.exit(0);
}
if (args[0] === 'api' && /\/rules\/branches\//.test(args.at(-1))) {
  // FAKE_GH_RULES_ERR: the rules read fails with this message (a 404, or GitHub's plan-gated 403).
  if (process.env.FAKE_GH_RULES_ERR) {
    console.error(process.env.FAKE_GH_RULES_ERR);
    process.exit(1);
  }
  console.log(process.env.FAKE_GH_RULES ?? '[]');
  process.exit(0);
}
if (args[0] === 'api' && /\/branches\/[^/]+$/.test(args.at(-1))) {
  console.log(process.env.FAKE_GH_BRANCH ?? JSON.stringify({ protected: false }));
  process.exit(0);
}
console.error(`fake gh: unexpected call: ${args.join(' ')}`);
process.exit(1);
