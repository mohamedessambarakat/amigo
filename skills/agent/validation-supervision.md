# Validation supervision

Read when a no-mistakes build starts or already has a validation run going, including a mid-run requirement change or finding, and before deciding or answering any ask-user finding.

The crew member that starts a no-mistakes run drives it: it owns every `no-mistakes axi run` and `no-mistakes axi respond` through the next gate or outcome. You never run `respond` for a crew member's run. `src/delivery.ts` owns what it may pass as `--intent`.

Once validation starts, route new requirements to follow-up work rather than growing the task. Still inside the task, even when they touch files not named at intake: the smallest downstream changes that keep already accepted behavior correct, behavioral tests where an executable contract exists, accurate docs, and corrections the accepted intent already requires.

Only a current, explicit Boss instruction that completely invalidates the work being validated keeps the task with the same crew member. Then it aborts the run through no-mistakes' supported abort, confirms through `no-mistakes axi status` that the run stopped, and follows `branch_sync.next_action` from that status (`no-mistakes axi sync` only when the code is `recover_custody`). It rebuilds from the correct base before the invalidation, keeping the obsolete run's fix commits out, and validates exactly once against the final head. No hand edits, commits, restarts or second run while the obsolete run owns the branch.

An ask-user finding comes back as `needs-decision`: read `ask-boss-authority.md` and decide or escalate. Send the same crew member one exact decision naming the decision key, step, action, affected finding ids, instructions where needed, and the exact response command, with `amigo send <id> --resolve-key <key>`. Require the matching `resolved` event, forbid `--yes`, and require it to process every return until completion or a genuinely new escalation. Resume supervision at once.

Judge validation by `amigo status <id>` and the run's own status, never by whether the shell is alive or the last status line. A crew member hand-editing, committing, aborting or restarting during an active run is duplicating the pipeline's ownership: steer it back to the gate's response flow. It reports the PR when CI first turns green, without waiting for merge monitoring.
