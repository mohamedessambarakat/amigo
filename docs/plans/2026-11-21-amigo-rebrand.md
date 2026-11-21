# amigo rebrand and software factory

Decided 2026-11-21 in a grilling session. octomaxxing becomes **amigo**: your loyal right hand that runs a software factory.

## Factory (steps 1-8, built first)

1. Verification gates: per-project `checks`, run by the runner after an arm reports done; failures loop back to the arm (max 2 retries), then blocked. No checks = "unverified".
2. Risk scoring in code (size, deletions, risky globs, per-project globs) + mandatory reviewer PASS for non-trivial work before `close --commit`.
3. Approval policy (`policy.json`, inactive until the user runs `approve-policy` in a real TTY; hash-locked), `close --self`, `approvals.jsonl` log, `undo <id>`.
4. Dependent tasks: `spawn --after <id>`, worktree from the dependency's commit.
5. Feedback loop: `note <project> <text>`; on rejection the head offers the strongest lasting fix as options.
6. PR delivery: `close --commit --pr` pushes only the task branch and opens a draft PR; one-line delivery reason in every report.
7. Issue intake: `spawn --issue <n>`.
8. `status` grouped by station: queued, building, verifying, in review, waiting on you, done.

Cut as overengineering: separate backlog system, separate planner station, dashboard/TUI, auto-generated lint rules, self-approval merging into non-default branches.

Hard rules: no push/PR/self-approval outside an approved policy; never merge into the default branch or deploy; no runtime deps; cross-platform; any agent CLI; minimal prompts; new stations are proposed, not added.

### Starter policy (inactive until approved)

| Task type | Delivery | Approval | Why |
|---|---|---|---|
| Docs, comments, typos | Commit | Self | No runtime effect |
| Tests only | Commit | Self | Adds safety, can't break the app |
| Small internal change (<=3 files, <=100 lines, no risky path, checks pass, reviewer PASS) | Commit | Self | Strong gates, small reach |
| Feature / larger change | Commit, PR if remote + CI | Human | Too much reach to approve unseen |
| Dependency bump | PR | Human | Runtime risk CI should show |
| Auth, payments, migrations, secrets, deletions, public API, prod config | PR if remote | Human, always | Hard rule |
| Project without checks | Commit | Human | Nothing proves it |
| Not a git repo | - | Human | No branch to undo |

Self-approval v1 may only commit to the task's own branch.

## Rebrand (step 9, after 1-8)

- Name **amigo**: command `amigo`, slash command `/amigo`, branches `amigo/<id>`, home `~/.amigo`. GitHub repo renamed to `amigo` (ask the user right before doing it). npm name doesn't matter (installed from git).
- Known name overlap, accepted: Amigo (amigo.ai, AI-agent company with a CLI) and YoAmigo (wraps Claude Code/Codex).
- Tagline: "Your right hand. Runs the squad." Visual: simple wordmark + symbol (hand-made SVG), no mascot, no octopus.
- Workers are "the squad"; one worker is referred to by its id, or "a squad member".
- Voice: loyal right hand; personality in how it talks (direct, on your side, says when something's off). No jokes or catchphrases; remove gym-bro lines from both prompts.
- Opening: straight to a briefing: finished, waiting on you, noticed, suggested next moves. A background squad member runs live checks at startup (per-project config, defaults CI + open PRs via gh).
- Delegation: everything goes to the squad; amigo only does bookkeeping (status, inbox, briefing, memory).
- Memory: reads and writes `~/.claude` memory, says so in one line.
- Scope: front door for everything; non-project tasks run in a built-in scratch workspace.
- Audience: public, personal to each user. Claude Code head fully supported at launch; adapters for other head CLIs later; squad on any agent.
- Migration: move `~/.octomaxxing` to `~/.amigo` once on first run; no `octomaxxing` alias; old `octomaxxing/<id>` branches stay.
