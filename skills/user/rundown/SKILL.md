---
name: rundown
description: Inside an amigo session only, when the Boss types /rundown (or /rundown file) or asks where things stand, for a status report, a catch-up after a break, or "what's in the works" - a fresh four-section digest of the whole fleet. Never use it outside an amigo session.
---

# rundown

A complete current snapshot, so the Boss can pick up in one read after a break, a night or a reset. Plain `/rundown` answers in chat only. Only `/rundown file` also writes the dated report; a request in other words ("write that down", "save it") is not file mode.

This is read-only: during it, never close a task, merge, dispatch, steer, answer a decision or change the backlog. When the snapshot suggests an action, name it in its section and leave it to the normal lifecycle.

## Gather

Read current state with commands that change nothing: `amigo status`, `amigo status <id>` for each task you report on (PR URL, open decisions, declared wait), and `amigo backlog list` when `data/backlog.md` exists. Never run `amigo inbox` or `amigo wait` for a rundown: they mark results seen. Do not scrape old reports, status tails or chat history to fill gaps.

## The four sections

Every chat rundown has exactly these four sections, in this order, each always present, with its empty sentence when it has nothing:

1. **Boss's Call** - only what needs his own action now: a decision to make, a PR to approve or merge, a credential or login to provide, a blocker only he can clear. Empty: "Nothing needs your action right now."
2. **Recently Landed** - merged PRs, finished surveys and local-only landings among the recently closed tasks. Empty: "Nothing landed recently."
3. **Underway** - live work moving on its own, one line of current state each. Empty: "Nothing is underway."
4. **Next Up** - queued or gated work with its blocker or date, and decisions he deferred to a date. Empty: "Nothing is queued."

Rules:

- Work that is running, queued behind another task or a date, already landed, a finished survey's report, an outside wait, or a PR with no ready signal never goes in Boss's Call.
- A held decision with a future `--until` date goes in Next Up with its date; a live one in Boss's Call.
- Every PR is its full `https://` URL; a bare `#number` only as a back-reference after the full URL appeared.
- One scannable line per item, in section 9 language. Say "Boss" once, inside an item or an empty sentence.
- Every rundown is a full snapshot, never a delta against an earlier one.

## File mode

`/rundown file` also writes `data/status-report-<YYYY-MM-DD>.md` (today, replaced from scratch if it exists; never read an earlier report to decide anything): a title `# Rundown - <day> <YYYY-MM-DD>`, two or three sentences on where things stand, then the same four sections with the detail chat leaves out (decision options, gate reasons, survey report paths). This private report may name task ids and paths. Then give the same four-section chat rundown with the report path inside it, without a fifth section. Never put secret values in it.
