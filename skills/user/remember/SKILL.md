---
name: remember
description: Inside an amigo session only, when the Boss types /remember or asks amigo to save what it learned, and before a session reset or compaction - sweep the session for durable knowledge and unfiled open work, and curate amigo's startup memory (data/boss.md, data/learnings.md). Never use it outside an amigo session.
---

# remember

Sweep this session for knowledge and open-work state that exist only in the conversation, then leave the next session a compact, current operating map rather than a growing journal. Write only through amigo's existing owners and boundaries.

## Memory tiers

The startup memory is `data/boss.md` and `data/learnings.md` in amigo's home; both are printed by every session-start digest. Entries are one-line bullets. Trailing markers name the tier:

- `<!--a:YYYY-MM-DD-->` aging: must re-prove itself; stale 30 days after the date (its last reinforcement).
- `<!--p:YYYY-MM-DD-->` perishable: stale after 7 days, and its text must name a checkable expiry (a backlog id, a version, a dated expectation); one that cannot is aging.
- `<!--P-->` pinned, in a file whose default is not pinned. Pinned entries have no clock and change only when the Boss or reality changes them.
- `<!--g-->` an old unmarked learning that used its one grace pass.

`boss.md` entries default to pinned (preferences and authority do not age) and carry no marker; `learnings.md` entries default to aging and always carry a dated marker. Each file's first line is at most the pointer `<!-- memory tiers: see the remember skill -->`.

## The pass (every /remember, even with nothing new)

1. Measure both files: estimated tokens are bytes / 4, and the budget is 7,500 for the two together.
2. Read both files completely. An absent file is absent, not an invitation to invent content.
3. Plan the whole retention before editing, ordered by how likely each entry is to matter in a future session. Always keep: current Boss preferences, authority and safety boundaries, recurring working style, fleet-wide operating facts, and short pointers that are expensive to rediscover.
4. Reinforce: refresh an entry's date to today only when this session actually used, confirmed or re-derived it, with evidence you can name. Plausibility or importance is not evidence. An unmarked learning with no evidence gets `<!--g-->` and stays for this pass; one that already had `<!--g-->` is confirmed (dated marker) or archived as `legacy-unvalidated`. Stamp new entries with today's date and tier.
5. Decay: a stale aging entry is re-validated from current evidence (date refreshed) or archived; a stale perishable entry is re-checked against its named condition: still open refreshes the date, resolved or no longer checkable archives it.
6. Consolidate both files: one current rule or pointer over duplicate prose; archive finished incident history, old versions and paths, transient task state and long procedures. Never just delete a unique current fact: archive it or merge it somewhere that keeps it.
7. Over budget after that: archive stale, superseded and low-value aging entries, oldest reinforcement first, only when archiving the whole eligible pool would actually reach the budget. Never move a pinned entry automatically. If pinned entries alone exceed the budget, hold one decision for the Boss (`amigo hold`) naming the shortfall and the entries: raise the budget, or approve trimming named entries.
8. Measure again and finish within budget or with that decision open. Never call the session reset-safe while over budget.

**Cold tier.** Archiving moves an entry to `data/memory-archive.md` (append-only, never loaded, never counted) under a `## YYYY-MM-DD remember` heading, keeping its source file, tier, last date and reason (`unreinforced <N>d`, `budget oldest-first`, `legacy-unvalidated`). Recovery is copying it back.

## Knowledge sweep

1. Look through the session for operational learnings, preferences the Boss stated in passing, project facts, standing decisions and undone next steps, including what crew members reported.
2. Route each by the contract's section 6: preferences to `boss.md` (inspect, then update), home operational facts to `learnings.md`, task notes to the backlog item (read it with `amigo backlog show <id>`, then replace its body with a considered version; never just append), findings to the survey report. Project knowledge never goes into a project's `AGENTS.md` through the crew: keep it in `learnings.md` and name it in the receipt so the Boss can add it by hand.
3. File every undone next step as a queued backlog item, with its real dependency when there is one.

## Open work

A reset loses whatever exists only in this session, including what you learned about work under way. Make sure the open work you are holding is durably recorded: file what was never filed, correct records you now know are stale, through the command that owns each record. This covers only the open work you hold in context; it is not a reconciliation of the records against GitHub or the repositories, and never report it as one. Where the right correction is a judgment you cannot make, leave the record and raise the question.

## Receipt

Tell the Boss in plain words: tokens before and after against the budget; for each of `boss.md` and `learnings.md` its actions (`unchanged`, `added`, `rewritten`, `pruned`, `archived`); each finding filed elsewhere and where; each archived entry's reason; every open decision about the budget; each open-work record filed or corrected, and each one left alone with why; and whether the session is safe to reset. Reset-safe means nothing this session knew is lost, and only when every finding is captured, every held open record is filed or explained, and memory is within budget. It never means the durable records are correct.
