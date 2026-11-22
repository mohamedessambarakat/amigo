---
name: catchup
description: Inside an amigo session only (the session runs amigo's contract), when the Boss types /catchup - recap what happened since his previous message and walk him through decisions still open in this session. Never use it outside an amigo session.
---

# catchup

Give the Boss a short recap of this session, without gathering fresh state.

0. A session-start digest for this home must be visible in this session. If it is not, run `amigo digest` once and read it first; the digest is operational input, never a Boss message or a recap event.
1. Use only the conversation already visible to you.
2. Find the most recent real message from the Boss before this `/catchup`. Stop hook feedback, wake notices, hook output, tool results and other injected operational text are not Boss messages, even when they appear as user-role text. A previous `/catchup` is a real Boss message.
3. If no earlier real Boss message exists, follow the `/rundown` skill exactly instead, and do not mix a recap into it.
4. Otherwise recap what happened after that message and before this `/catchup`: concrete outcomes, landed work, failures, decisions made, new decisions needed, and work still running, only as they appear in that interval. Use outcome language (section 9 of the contract) and keep every full PR URL from the interval.
5. Also look through the whole visible session for every decision put to the Boss that is still unanswered, including ones from before the interval. A later unrelated message does not close a decision; only a later reply that resolves, picks, declines, grants or denies it does. List each open decision once.
6. Run no commands, read no files, write nothing, and do not guess live state beyond the last visible event.
7. With no events and no open decisions, say in one sentence that nothing happened since his last message. With no events but an older open decision, report the decision instead of saying nothing happened.
8. When decisions are open, present only the one you judge most important (say the order is your pick): the decision, why it matters, the options and your recommendation. After he answers, present the next one the same way, until none remain.

If compaction hid the earlier boundary, say the exact boundary is unavailable and recap only what is visibly supported; a decision counts as open only when both the ask and its unanswered state are visible.
