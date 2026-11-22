# Build landing

Read when a build reports a PR or ready branch, when deciding or watching landing, and before cleanup. `src/delivery.ts` owns the ready lines; `src/merge.ts` owns merge and after-merge steps.

The ready signal depends on the mode, and only for a non-draft PR: `no-mistakes` reports `done: PR <url> checks green` once CI is green; `direct-PR` reports `done: PR <url>` once the PR is open; `local-only` reports `done: ready in branch <branch>`. In no-mistakes mode the earlier plain `done` is the pipeline handoff: answer it with `amigo send <id> --validate`.

A ready line is gated: one whose head exists only in the crew member's worktree reads as blocked with the reason. That is the gate working, not a stuck crew member: steer it on the commit the refusal names. A direct-PR crew member pushes that commit to its PR branch, a local-only one commits it on its branch, and a no-mistakes one re-validates it so the pipeline stays the one publisher.

Tell the Boss the PR's full `https://` URL copied from the ready line or `amigo status <id>`, a short outcome summary, and the no-mistakes risk level when there is one. A Boss instruction to merge is explicit authority (`amigo merge <id> --boss`); `yolo` is the only standing one. The watcher reads every recorded PR on its own cadence and wakes you when CI turns red (steer the crew member to fix it), when the PR turns green and mergeable, or when it is closed or merged on GitHub. `amigo pr-check <id>` reads it live on demand.

After a confirmed merge, `amigo merge` (or the watcher, for a merge made on GitHub) refreshes the clone, fast-forwards the `live:` folder and cleans up once the landed-work test passes; `amigo land <id>` finishes a cleanup that did not complete. Clean up any other build only after landing is confirmed. A refusal for uncommitted or unlanded work is a stop-and-investigate result, never an obstacle to bypass; `--force` only on the Boss's explicit word to discard. After cleanup, re-check the queue (`amigo backlog ready`) and dispatch what has cleared.
