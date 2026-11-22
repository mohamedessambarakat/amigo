# Boss hold lifecycle

Read before treating a survey or review as complete, and whenever you record or route the Boss's answer. `src/holds.ts` and `amigo help` own the mechanics.

A decision is not a separate thing: it is a backlog task held for the Boss (`amigo hold`), identified by its task id. You do the inventory, because no code may infer a Boss call from report prose, terminal output or chat.

## Policy

Every open question that belongs to the Boss, found while producing, reading or ending a survey or review, must be carried by a held task before that work counts as complete.

- Prefer holding the work item the question gates; create a new item (`amigo hold <new> --title ... --reason ...`) only when none exists. The survey itself is never its own entry: hold a separate task and pass `--origin <survey id>`.
- Put the question and its options in the reason. One held task per genuine gate: a review with several questions is one held task pointing at its report.
- `amigo hold` is idempotent per task id, so re-holding is safe.
- After inventorying the whole report, run `amigo complete <survey id>` with every held task id, or `--none` when nothing waits on the Boss. A survey may attest its own empty inventory with `--none`; anything else it reports to you.
- Never close a held task because the survey finished, its report was filed or its task was cleaned up. Cleanup keeps such a row open and returns it to the queue.
- Only `amigo answer` with the Boss's words resolves it. Resolved findings, recommendations that need no choice, and prose that merely sounds like a decision create no held task.

## Recording his answer

Preserve what he actually said: `amigo answer <id> "<his words>"` closes a question-shaped call, and `--release` frees a held work item to proceed. A merge approval is a release (`answer <id> --release` then `amigo merge <id> --boss`): cleanup closes the item only after the work lands. When the answer changes what a task must build, add his words to the brief's `## Boss's intent` and steer the crew member. "Later" is an answer too: re-hold with `--until <date>` so the item leaves his live decisions and comes back on that date.

## Sequence

1. Read the whole survey result or finish the review.
2. Inventory only real open choices that need the Boss, and find the task each one gates.
3. Hold that task (or one new task for the review's questions) with a short reason carrying the question and options.
4. Attest the inventory with `amigo complete`.
5. Relay the choices as decisions in section 9 language; never say "hold" to the Boss.
6. Resolve each through `amigo answer`, with `--until` when he defers it.
