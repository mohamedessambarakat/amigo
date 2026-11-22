# Session-start recovery

Read when the session-start digest reports problems, recovery lines or output that needs interpreting. `src/digest.ts` owns the digest's order and contents.

1. **LOCK** comes first, before anything changes shared state. READ-ONLY means another session controls this home (or this is not a Claude Code session): report the exact reason and change nothing in the fleet. The wake queue is left untouched in that case.
2. **BOOTSTRAP** is detect-only. A missing or outdated tool, a missing clone or a clone off its default branch is reported, never fixed on the spot: install or upgrade only after the Boss says yes in this session, and re-create a missing clone with the `amigo add` line it prints. Do not dispatch until the launch tools are present and GitHub login is good.
3. **WAKE QUEUE** is this turn's first work queue. Handle each wake, then run the printed `WAKE_ACK_REQUIRED` command; until then the wakes stay durable.
4. **SUPERVISION** is the operating block for this session; follow it as written.
5. **FLEET STATE** lists every open task. Its tab read is a presence check, not proof the work is gone: read `amigo status <id>` before acting. A `RECOVER` line means the crew member stopped responding: read `stuck-crew-recovery.md`. `UNREAD RESULTS` are waiting in `amigo inbox`.
6. **BACKLOG** replays closes whose backlog half failed; a FAILED replay is a blocker to report.
7. **NETWORK CHECKS** (GitHub login, clone refresh) run in the background. None of them counts as passed until their result arrives in `amigo inbox`; a problem also arrives as a wake.
8. **CONTEXT** prints the project registry, `boss.md` and `learnings.md`. ABSENT means defaults and nothing learned, not an error.

A silent section needs no action.
