# Stuck crew recovery

Read when a crew member's tab is dead, it stopped responding, loops, stays confused, asks a question its brief already answers, ignores a steer, or claims its no-mistakes pipeline is dead.

A stopped crew member whose PR already landed is not a recovery case: the work is finished, so clean it up with `amigo close <id>`, never `--force`.

Interrupt, stop and relaunch only through `amigo control <id> interrupt|exit|relaunch`, which never tears down or discards anything.

## A dead tab

1. Treat the dead tab as a presence signal, not proof the work or its validation run is gone. Read `amigo status <id>` first.
2. A no-mistakes run that matches the crew member's branch and current code is still authoritative: keep supervising it instead of starting a duplicate.
3. Otherwise check that no live agent still owns the task and that its worktree still exists. Keep its uncommitted changes and commits and the same task, and relaunch it in that worktree: `amigo control <id> relaunch --note "<what is done, what is left>"`.
4. Never spawn a fresh copy while the recorded worktree is unaccounted for: two copies of one task split the work. If the worktree or ownership cannot be reconciled safely, leave everything as it is and report the task blocked with the conflicting evidence.

## A live crew member claiming the pipeline is dead

Its timed-out or killed wait proves nothing: the pipeline usually keeps running. Check both yourself:

1. `amigo daemon`: it reads `no-mistakes daemon status`, and only when that is positive evidence the daemon is down (not running, or a refused connection) starts it again outside every terminal. When it did, or a `check: no-mistakes daemon was down` wake says the watcher did, steer every build it names to reattach with `no-mistakes axi run` from its own worktree. A timeout or unknown reading leaves the daemon alone. When it could not start it, escalate with its error.
2. `no-mistakes axi status --run <id>`: when the run is still running or fixing with recent activity, the claim is wrong. Steer the crew member to reattach with `no-mistakes axi run` from its own worktree and tell it a timeout is not daemon death. Nothing reaches the Boss.

Never stop, restart or update the shared daemon: it serves every lane, and a restart kills their runs. Starting one that is positively down is the only exception, and only through `amigo daemon` or the watcher: a dead daemon has no runs to kill, and a plain `no-mistakes daemon start` from a terminal dies with that terminal on Windows.

## A live crew member that is stuck

Escalate in order:

1. Look at its tab (`amigo attach <id>`) and its inbox (`amigo status <id>` lists unacknowledged messages). A stale wake naming an unread instruction means it never acknowledged a steer. A crew member that declared a `paused` wait has only said what it waits for: check that condition, and when it has already cleared, steer it to read the result and resume.
2. It asks a question its brief answers: answer in one line with `amigo send`.
3. It is confused or looping: `amigo control <id> interrupt`, then one corrective line with `amigo send`.
4. It is genuinely wedged after that (looping, unresponsive, repeating the same obstacle, or dead): `amigo control <id> relaunch --note "<progress so far>"`. A low context reading is not wedging. The worktree and commits persist, so a relaunch is cheap.
5. If a second relaunch fails too, mark the backlog item failed and tell the Boss the plain failure, the preserved work and the consequence, in section 9 language.
