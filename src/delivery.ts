import type { DeliveryMode } from './config.ts';
import { cliPath } from './paths.ts';
import { SUBJECT_FORMAT } from './commit.ts';

/**
 * A build's brief. amigo writes two sections; code writes the rest:
 *
 *   ## Boss's intent   the Boss's own ask plus the context needed to read it (no speaker label, no address). In no-mistakes
 *                      mode this, and only this, is what the crew member passes as `--intent`.
 *   ## amigo spec      amigo's build instructions, which are never the Boss's intent.
 *
 * Around them the scaffold puts the isolation check, the rules, the status protocol and declared waits, the steering inbox,
 * and the Definition of done of the task's delivery mode, which opens with a fixed `Delivery contract: mode=<mode>` line.
 */
export const INTENT_HEADING = "## Boss's intent";
export const SPEC_HEADING = '## amigo spec';
export const CONTRACT_RE = /^Delivery contract: mode=(\S+)/m;

/** The command a crew member reports status with: the CLI by its absolute path, so it works whatever amigo the PATH holds. */
export const reportCommand = (): string => `node "${cliPath.replaceAll('\\', '/')}" report`;

/** The instruction amigo sends a no-mistakes crew member after its first done (the pipeline handoff). */
export const VALIDATE_MESSAGE =
  'Your work is accepted for validation. Run /no-mistakes now as your Definition of done describes: pass only the "Boss\'s intent" section as --intent, drive every gate to an outcome, never pass --yes, and report `done: PR <url> checks green` when CI is green.';

export interface BriefInput {
  title?: string;
  intent: string;
  spec: string;
  /** The mode a `Delivery contract: mode=` line in the input named, if any. */
  contractMode?: string;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/[‘’]/g, "'");

/**
 * Split what amigo wrote into its sections. Accepts an optional `Title:` line first, then `## Boss's intent` and `## amigo spec`
 * (in either order). Throws, naming what is missing, before anything is made.
 */
export function parseBriefInput(text: string): BriefInput {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title: string | undefined;
  const contract = CONTRACT_RE.exec(text)?.[1];
  const sections: Record<'intent' | 'spec' | 'pre', string[]> = { intent: [], spec: [], pre: [] };
  let at: 'intent' | 'spec' | 'pre' = 'pre';
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && norm(line) === norm(INTENT_HEADING)) {
      at = 'intent';
      continue;
    }
    if (!fence && norm(line) === norm(SPEC_HEADING)) {
      at = 'spec';
      continue;
    }
    if (at === 'pre' && /^title:/i.test(line.trim()) && title === undefined) {
      title = line.trim().replace(/^title:\s*/i, '');
      continue;
    }
    if (CONTRACT_RE.test(line)) continue;
    sections[at].push(line);
  }
  const body = (k: 'intent' | 'spec' | 'pre') => sections[k].join('\n').trim();
  const shape = `Write the brief as:\nTitle: <short title>\n${INTENT_HEADING}\n<the Boss's own words and the context to read them>\n${SPEC_HEADING}\n<your build instructions>`;
  if (!body('intent') || !body('spec')) throw new Error(`A build's brief needs both "${INTENT_HEADING}" and "${SPEC_HEADING}" with text under each. ${shape}`);
  if (body('pre')) throw new Error(`The brief has text before its sections (${JSON.stringify(body('pre').split('\n')[0]!.slice(0, 60))}): put it under "${INTENT_HEADING}" (the Boss's words) or "${SPEC_HEADING}" (your instructions).`);
  for (const k of ['intent', 'spec'] as const) if (/\{(BOSS_INTENT|AMIGO_SPEC|TASK)\}/.test(body(k))) throw new Error(`The brief still holds a placeholder under ${k === 'intent' ? INTENT_HEADING : SPEC_HEADING}: fill it in.`);
  const addressed = body('intent')
    .split('\n')
    .find((l) => /^\s*(\[boss\]|boss('s (words|ask|intent))?:|boss,)/i.test(l));
  if (addressed) throw new Error(`"${INTENT_HEADING}" must hold the Boss's words without a speaker label or address, but a line opens with one: ${JSON.stringify(addressed.trim().slice(0, 80))}`);
  return { ...(title ? { title } : {}), intent: body('intent'), spec: body('spec'), ...(contract ? { contractMode: contract } : {}) };
}

export interface ScaffoldInput {
  id: string;
  project: string;
  mode: DeliveryMode;
  branch: string;
  /** amigo's clone, which the crew member's worktree must not be. */
  clone: string;
  intent: string;
  spec: string;
  /** Where the crew member keeps proof and scratch output: data/<id>/. */
  dataDir: string;
  statusFile: string;
  inboxDir: string;
}

/** Rule 1 of a build: what the crew member may push, per mode. */
export function ruleOne(mode: DeliveryMode, branch: string): string {
  switch (mode) {
    case 'direct-PR':
      return `1. Never push to the default branch (push only your \`${branch}\` branch). Never merge a PR.`;
    case 'local-only':
      return `1. Never push to any remote and never open a PR. Work only on your \`${branch}\` branch; amigo handles the merge into the local default branch.`;
    case 'no-mistakes':
      return '1. Never push to the default branch. Never merge a PR.';
  }
}

const p = (path: string): string => path.replaceAll('\\', '/');

function askUserBlock(dataDir: string): string {
  return [
    '   For a no-mistakes ask-user gate specifically, escalate all ask-user findings as one event plus one snapshot file, using that same shape even when the gate holds only a single ask-user finding: write only the ask-user findings, verbatim and unparaphrased (id, severity, file, line, description, authority), to `' + p(dataDir) + '/nm-<run>-findings.txt`, then report the gate with',
    `   \`${reportCommand()} needs-decision --key nm-<run>-<step> "ask-user findings=<id1>,<id2>,... file=${p(dataDir)}/nm-<run>-findings.txt"\``,
    '   naming every ask-user finding id from that gate. The status line only points at the file; it never restates or summarizes a finding\'s content.',
  ].join('\n');
}

/** How a crew member drives no-mistakes (GitHub, with a backgrounded drive call). */
function nmDrivingBlock(): string {
  return `You drive no-mistakes by responding to its gates, not by implementing fixes.
Follow the guidance no-mistakes itself provides for the mechanics: it loads when you invoke /no-mistakes, and \`no-mistakes axi run --help\` plus the \`help\` lines in each \`axi\` response are authoritative and version-matched to the installed binary.
When starting no-mistakes, pass \`--intent\` as only this brief's \`${INTENT_HEADING}\` section body, not its heading, plus any later words the Boss actually said.
Preserve the actual words without adding speaker labels or direct address; the section heading supplies provenance outside the pipeline input.
Do not include \`${SPEC_HEADING}\`, later amigo build constraints, or your own decisions and tradeoffs.
The \`--intent\` string you pass must be self-sufficient: that string plus the codebase must let a reader reconstruct roughly the same specification, without depending on a separate report, a PR, or context that lives only in this conversation.
When the Boss's intent refers to a report, decision, or PR ("do items 1, 2, 3, and 7 of the report"), write the substance of the referenced items into \`--intent\` in the Boss's terms, not only the pointer; that substance is the Boss's ask by reference, while amigo's build instructions and your own decisions still stay out.
This replaces the no-mistakes skill's advice to enrich \`--intent\` with decisions and tradeoffs; that advice does not apply to amigo-dispatched work.
Do not hand-edit, commit, or fix findings yourself while a run is active - the pipeline applies every fix.

One drive call blocks until the next gate or outcome, which routinely outlives what your harness lets a single command run: Claude Code kills a command at ten minutes maximum, while one fix round is capped around thirty minutes and up to three rounds chain.
So background the drive call instead of sitting in one blocking hold your harness will kill, and read its return when it finishes.
Declare that wait using the brief's status-reporting rule before waiting on the backgrounded drive call.
Where a harness's own command limit is not established, assume it bounds commands and use that same backgrounded shape.
Only a drive call's return reports the green PR: \`no-mistakes axi status\` shows progress but never reports \`checks-passed\` while the ci step is still monitoring the PR for merge, so never wait on a status poll for the next gate or outcome.
Whenever a drive call returns without a gate or an outcome - its own wait elapsed, or it was killed or timed out - reattach at once by re-running \`no-mistakes axi run\` without flags, backgrounded the same way; once checks are green it returns \`checks-passed\` immediately, and if it refuses because no run is active, read the finished outcome from \`no-mistakes axi status\`.
A killed or timed-out call is never evidence the daemon died: the daemon accepts your response immediately and runs the round in the background, so the call was only ever waiting for a read while the run kept working.
Reattach and keep going rather than reporting the pipeline blocked; rule 7 owns the checks that decide when a pipeline block is real.

Two amigo-specific rules layer on top of that guidance:
- ask-user findings are never yours to answer: escalate to amigo using rule 6's ask-user format and stop.
  amigo applies its ask-Boss authority policy and obtains any required Boss decision.
  When the decision comes back, feed it to the gate with \`no-mistakes axi respond\` and let the pipeline apply it - do not route the question to "the user" or implement the fix yourself.
- NEVER pass \`--yes\` (or \`-y\`) to \`no-mistakes axi run\` or \`no-mistakes axi respond\`. It is banned for every crew member.
  It auto-resolves every gate including ask-user findings with no escalation, and answering your own ask-user finding is a hard rule violation.`;
}

const DRAFT_CHECK = '(`gh pr view <number> --json isDraft` must print `"isDraft": false`, where <number> is the PR number from your PR URL); if it is a draft, mark it ready with `gh pr ready <number>`.';

/** The Definition of done of a build, per delivery mode. Opens with the machine-read contract and branch lines. */
export function dodBlock(mode: DeliveryMode, branch: string): string {
  const R = reportCommand();
  switch (mode) {
    case 'direct-PR':
      return `# Definition of done
Delivery contract: mode=direct-PR
Build branch: ${branch}
This build ships **direct-PR**: you raise the PR yourself, without the no-mistakes pipeline.
The task is complete only when committed on your branch.
When it is implemented and committed, push your branch and open a PR with \`gh pr create\` that is ready for review, not a draft.
Before you report done, read the PR back from GitHub and confirm it is not a draft ${DRAFT_CHECK}
A draft cannot be merged, so a done report on one leaves the merge unasked.
Then report \`${R} done "PR <url>"\` and stop.
That done is accepted only when this copy's HEAD - your latest commit - is pushed to your PR branch; the check tests that commit, not merely that a branch moved.
If you deliberately keep the PR a draft, report \`${R} paused "<why the draft is held>"\` instead of done.
Do NOT run /no-mistakes. The configured merge authority decides whether to merge the PR; amigo relays the outcome.`;
    case 'local-only':
      return `# Definition of done
Delivery contract: mode=local-only
Build branch: ${branch}
This build ships **local-only**: no remote, no PR, no pipeline.
The task is complete only when committed on your branch \`${branch}\`. Do NOT push, do NOT open a PR, do NOT merge.
A done is accepted when the named head is your branch \`${branch}\` itself and the worktree is clean; the check tests that head, not merely that a branch moved.
Keep your branch a clean fast-forward onto the current default branch - if the default branch has advanced, rebase onto it so the eventual merge stays a fast-forward.
When it is implemented and committed, report \`${R} done "ready in branch ${branch}"\` and stop.
The configured merge authority approves the ready branch, then amigo merges it into the local default branch through the guarded fast-forward path.`;
    case 'no-mistakes':
      return `# Definition of done
Delivery contract: mode=no-mistakes
Build branch: ${branch}
The task is complete only when committed on your branch.
When you believe it is complete, report \`${R} done "<summary>"\` and stop.
amigo will then instruct you to run /no-mistakes to validate and ship a PR.
That first done is the handoff that starts the pipeline, which owns the push; it is not a request to push from this copy.

${nmDrivingBlock()}

After /no-mistakes reports CI green (the CI-ready return point - do not wait for it to keep monitoring in the background until merge), read the PR back from GitHub and confirm it is not a draft ${DRAFT_CHECK}
A draft cannot be merged, so a done report on one leaves the merge unasked.
Then report \`${R} done "PR <url> checks green"\` and stop. You are finished.
That CI-ready done is accepted only when this copy's HEAD - your latest commit - is one the /no-mistakes run pushed, so commit nothing after the run; the check tests that commit, not merely that a branch moved.
If you deliberately keep the PR a draft, report \`${R} paused "<why the draft is held>"\` instead of done.`;
  }
}

/** The status-reporting rules every crew member gets (rules 4 to 6), with the declared-wait instructions. */
export function statusRules(o: { statusFile: string; dataDir?: string; noMistakes?: boolean }): string {
  const R = reportCommand();
  return `4. Report status with one command:
   \`${R} <state> "<one short line>"\`
   (it appends \`<state> [at=<epoch>]: <line>\` to \`${p(o.statusFile)}\`; appending such a line yourself counts the same).
   States: working, needs-decision, blocked, paused, done, failed, resolved. Add \`--key <slug>\` to name a decision or phase.
   Each report wakes amigo, so report sparingly: only phase changes a supervisor
   would act on (setup done, bug reproduced, fix implemented, validation passed) and the
   needs-decision/blocked/paused/done/failed states. No step-by-step FYI progress lines;
   amigo reads your terminal for that.
   Whenever you mention a PR anywhere - a status line, your terminal, a summary - write its full
   https:// URL exactly as GitHub printed it, never a bare number such as "PR 108"; amigo
   copies that URL from your line rather than assembling one.
   A mid-task working report (including setup complete) is nonterminal: do not end the
   turn after it; continue the same stage until a defined done gate under Definition of done.
   Use \`paused\` - distinct from \`blocked\` - when deliberately waiting for work or an external condition expected to clear on its own, including your own validation round.
   Before ending your turn with your own background shell or monitor still running, or before waiting on your own pipeline run or a long foreground command, report \`${R} paused "<job and completion condition>"\`.
   Name what you are waiting for and what will let you resume; do not repeat the declaration on every poll.
   Do not declare active implementation or reasoning as a wait.
   amigo may still raise one first-sight alert; the declared wait then uses the long recheck cadence instead of repeated possible-wedge alarms.
   When you know when the wait clears, include \`until <YYYY-MM-DDTHH:MMZ>\` (UTC) for a recheck at that time; for your own background job or command with a timeout, that time is its start plus its timeout, rounded up to the minute.
   Follow the resolution rule below when the wait clears, then resume the task.
   Use \`blocked\` when you are stuck and need help.
5. If you hit the same obstacle twice, report \`${R} blocked "<why>"\` and stop; amigo will help.
6. If a decision belongs above you (product choices, destructive actions),
   report \`${R} needs-decision "<summary of options>"\` and stop. amigo will reply with the decision.
${o.noMistakes && o.dataDir ? `${askUserBlock(o.dataDir)}\n` : ''}   A decision or blocker you opened stays open until a \`resolved\` line carrying its exact key lands; a later done or working report never closes it, even when the answer is what started that work.
   amigo's reply normally writes that closing line at answer time; when a blocker or wait clears WITHOUT a reply from amigo, report \`${R} resolved "<how it cleared>"\` yourself (same \`--key\` if you opened it with one) as you resume.`;
}

/** The receive-and-acknowledge half of the steering inbox (see steer.ts). */
export function inboxSection(inboxDir: string): string {
  const d = p(inboxDir);
  return `# amigo instruction inbox
amigo steers you through durable message files in \`${d}\`.
When a terminal message says an instruction is waiting there - and at any natural checkpoint when you are unsure - list the \`*.msg\` files there in numeric order, read the complete contents of each, act on each message in order, then acknowledge each handled message by moving it into \`${d}/handled/\`.
The message text is everything after the \`--\` line. A header line \`body-terminator=1\` means the writer added exactly one final newline that is not part of the message.
The move IS the acknowledgement: without it amigo rings again and eventually treats you as stuck. An empty or absent inbox needs no action.`;
}

const SHARED_INFRA_RULE = `7. Never administer infrastructure that every lane shares. Two things are shared:
   - The \`no-mistakes\` daemon - one instance serving every crew member, so stopping, restarting, or
     updating it kills other crew members' in-flight pipeline runs; only amigo manages the daemon.
     Before you report blocked about the pipeline, run \`no-mistakes daemon status\` and
     \`no-mistakes axi status\`. If the daemon refuses connections or is missing, report
     blocked with the daemon error and stop even when the local run record still says running or
     fixing, because that record can be stale after the daemon exits; amigo starts it again and
     tells you to reattach. A run record failed with a daemon error is also a real block.
     Only after ruling out a refused daemon, if the run is still running or fixing, reattach and keep
     going. A drive-call error, timeout, slow read, or generic unreachability is NOT a daemon error:
     the daemon accepts \`respond\` immediately and runs the round in the background, so a killed or
     timed-out call was only waiting for a read while the run kept working.
   - The worktree pool your own worktree came from, and the repository every crew member's worktree
     shares. Never create, remove, return, prune, move, or reassign a worktree or pool slot, and
     never write into a sibling slot's directory. The act is the rule and commands are only examples
     of it - \`treehouse\` get/return/remove/prune and \`git worktree add|remove|move|prune\`. A slot that
     looks unused is not evidence that it is free, and returning your own worktree is amigo's job at
     cleanup, not yours.
   If you genuinely need a second checkout, another slot, or the daemon touched, report
   blocked with what you need and stop; amigo arranges it.`;

const NO_CD_RULE = `8. Never start a shell command with \`cd\`, and never run a search whose path depends on the current directory.
   Use absolute paths, \`git -C <abs>\`, or a \`( cd <abs> && ... )\` subshell.
   Pass this rule to every sub-agent you launch.`;

/** The full brief of a build: data/<id>/brief.md. */
export function renderBrief(o: ScaffoldInput): string {
  const setup2 = o.mode === 'no-mistakes' ? '\n2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.' : '';
  return `You are a crew member: an autonomous worker agent managed by amigo. Work on your own; do not wait for a human.
# Task
${INTENT_HEADING}
${o.intent.trim()}
${SPEC_HEADING}
${o.spec.trim()}
# Setup
You are in a disposable git worktree of ${o.project}, made fresh from origin's default branch, with your branch \`${o.branch}\` already checked out.
**Verify isolation before anything else.** Run \`git rev-parse --show-toplevel\`; it must be the folder you were launched in, never amigo's clone at \`${p(o.clone)}\`.
If the top-level path is that clone or not the worktree you were launched in, STOP - do not commit here - report \`${reportCommand()} blocked "launched in amigo's clone, not an isolated worktree"\` and stop.
1. Confirm \`git branch --show-current\` prints \`${o.branch}\`.${setup2}
# Rules
${ruleOne(o.mode, o.branch)}
2. Keep project edits inside this worktree; keep proof and scratch output outside it, under \`${p(o.dataDir)}/\` or a temporary directory.
   Outside the worktree, write only that task material and the status and steering-inbox records authorized below.
   Leave the worktree clean before reporting done.
3. Use gh for GitHub operations.
${statusRules({ statusFile: o.statusFile, dataDir: o.dataDir, noMistakes: o.mode === 'no-mistakes' })}
${SHARED_INFRA_RULE}
${NO_CD_RULE}
9. Every commit message is ${SUBJECT_FORMAT}, with no co-author or "generated by" lines.
${inboxSection(o.inboxDir)}
# Project memory
A project's \`AGENTS.md\` or \`CLAUDE.md\` is loaded into every agent session in that project, so edit it only to correct information that is factually wrong - including information your own change made wrong - and never to add knowledge because it is missing.
A correction edits only the wrong text: do not create either file, or add sections, headings, or pointers alongside it.
${dodBlock(o.mode, o.branch)}
`;
}

/** The PR URL a ready line names, as GitHub printed it. */
export function prUrlOf(note: string): string | null {
  return /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/.exec(note)?.[0] ?? null;
}

/**
 * What a build's done line claims, by mode: the no-mistakes handoff (a summary, no PR), a PR ready line (`PR <url>`, and for
 * no-mistakes `PR <url> checks green`), or a local-only ready branch. Anything else is `unready`.
 */
export function classifyDone(mode: DeliveryMode, note: string): { kind: 'handoff' } | { kind: 'pr'; url: string } | { kind: 'branch' } | { kind: 'unready'; why: string } {
  const url = prUrlOf(note);
  if (mode === 'local-only') return /^ready in branch\b/i.test(note.trim()) ? { kind: 'branch' } : { kind: 'unready', why: 'a local-only done reads "ready in branch <branch>"' };
  if (mode === 'direct-PR') return url && /^PR\s+https:/i.test(note.trim()) ? { kind: 'pr', url } : { kind: 'unready', why: 'a direct-PR done reads "PR <full https URL>"' };
  // In no-mistakes mode only the CI-ready line is gated; any other done is the pipeline handoff.
  return url && /^PR\s+https:\S+\s+checks green\b/i.test(note.trim()) ? { kind: 'pr', url } : { kind: 'handoff' };
}
