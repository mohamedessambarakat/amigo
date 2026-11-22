# Port firstmate's workflow into amigo

Created 2026-11-22. Status: approved design, not started.

## Goal

amigo works the way firstmate works, aspect by aspect, with amigo's own brand words. Behaviour, rules and their order are copied. Only labels that belong to firstmate's ship brand change.

Source of truth for "how firstmate does it": `github.com/kunchenguid/firstmate` at commit `427056c4181c41074ad24f051f79919330df0fa5` (MIT). Every step below names the firstmate files to port. Clone that commit before starting a step and read those files first; when the plan and firstmate disagree on behaviour, firstmate wins unless a decision below says otherwise.

Credit: keep firstmate's MIT notice for ported text and add "Workflow ported from firstmate by Kun Chen" to the README.

## Decisions

| Area | Decision |
|---|---|
| Implementation | Port behaviour into amigo's Node/TypeScript CLI. No bash scripts. Native Windows. |
| Terminal | **herdr-app only** (through `herdr-app` and `hc`), behind a backend interface. Other terminal paths are removed. amigo refuses to start outside herdr-app. |
| Primary agent | Claude Code only for amigo himself (Stop hook guard). Crew members may run on any supported agent CLI. |
| Written rules | firstmate's structure (short always-loaded contract, agent-only skills loaded at triggers, code that enforces), written as tersely as possible. |
| Precedence | Inside an amigo session amigo's contract wins over `~/.claude/CLAUDE.md`. The user's security rules (secrets, prod, money) still apply. |
| Projects | amigo owns clones in `~/.amigo/projects/<name>`, read-only to amigo. Projects that are live installs carry `live: <path>`; after a confirmed merge amigo fast-forwards that folder, skipping and reporting when it is dirty or diverged. |
| Delivery | Per-project mode `no-mistakes` / `direct-PR` / `local-only` plus `yolo`. Current projects start on `no-mistakes` + `yolo`. Unregistered default: `no-mistakes`, yolo off. |
| Review | firstmate's model: no separate reviewer; the delivery path owns rigor (Kun's `no-mistakes`). |
| Old gates | Removed: reviewer gate, risk scoring, `policy.json` / `approve-policy`, `confirm-gates`, per-project `--check`. |
| Backlog | `tasks-axi`, decisions held as tasks (`--until <date>` optional). |
| Dispatch | Dispatch profiles in declared order (firstmate's `shared_quota: true` mode) plus firstmate's effort fallback. No quota ranking. |
| Memory | amigo's own files: `data/boss.md` (preferences), `data/learnings.md`, curated by `/remember`. |
| Away | `/afk` and `/quiet` as firstmate; no alert channel (firstmate's default). |
| Tool fails the Windows spike | Re-implement that tool's behaviour in TypeScript. |
| Cutover | No tasks are open; migrate straight away. |

## Brand mapping

Behaviour is identical; only these labels change. Anything not listed keeps firstmate's plain wording.

| firstmate | amigo |
|---|---|
| captain (the user) | Boss |
| first mate / firstmate | amigo (the user's foreman) |
| crewmate / crewmates | crew member / the crew |
| ship task | build |
| scout task, `data/<id>/report.md` | survey, `data/<id>/report.md` |
| `/ahoy` | `/catchup` |
| `/bearings` | `/rundown` |
| `/stow` | `/remember` |
| `/updatefirstmate` | `/updateamigo` |
| "aye", "on deck", "shipshape", "under way", "ahoy" | "on it", "got it", "all good", "done and dusted" |
| exact no-op reply `Captain, shipshape.` | `All good, Boss.` |
| `data/captain.md` | `data/boss.md` |
| captain hold | Boss hold |
| `FM_HOME` | `AMIGO_HOME` (default `~/.amigo`) |
| branch prefix `fm/` | `amigo/` |
| "Scout and second mate are accepted house vocabulary" | "build, survey and crew are accepted house vocabulary" |

Address rule, as firstmate: amigo says "Boss" at least once in every chat message, never in commits, PRs, issues, briefs, code or comments. Seasoning is optional, never hides technical content, and is dropped for bad news.

## Out of scope

Secondmates, Relay, Gerrit/GitLab/Forgejo forges, Calm mode, Lavish, quota-axi ranking, voice relay, fleet ledger, every terminal backend except herdr-app, turn-end guards for agent CLIs other than Claude Code, firstmate's self-repo maintainer role.

## Done when

1. Typecheck and tests pass in CI on Windows, Linux and macOS (check: `npm run typecheck && npm test`, CI green on the PR).
2. End-to-end run in herdr-app on this PC: the Boss asks for a small change on a throwaway GitHub test repo registered as `no-mistakes` + `yolo`; amigo briefs a crew member, no-mistakes opens the PR, CI goes green, amigo merges it, refreshes the clone, cleans up, and reports with the full PR URL, with no human step after the request (check: run log saved to `docs/research/2026-11-xx-e2e-run.md`).
3. Recovery: closing amigo's session mid-task and starting a new one produces a digest that reconciles the task and resumes supervision; a crew member killed in herdr-app raises a "stopped responding" notification (check: both cases scripted in the e2e suite against the test backend, and once by hand in herdr-app).
4. Brand check: no `captain`, `firstmate`, `first mate`, `crewmate`, `ahoy`, `shipshape`, `aye` in `prompts/`, `skills/`, `src/` or `README.md` outside the credit line (check: a test that greps for them).

## Steps

Each step lists the firstmate files to port. Each step ends with typecheck and tests green and an Opus review of the finished step.

### 0. Windows spike

Install and exercise, natively on this PC: `no-mistakes` (≥ v1.46.0, the floor firstmate requires), `treehouse`, `tasks-axi`, and `hc` / `herdr-app` (open a tab, send text, read pane state, close, list). Record the commands, versions and results in `docs/research/2026-11-22-windows-spike.md`. A tool that fails gets a "re-implement in TS" task added to its step below.

Done when: every tool has a pass/fail with evidence in that file.

### 1. Terminal backend: herdr-app only

- One interface for every terminal action: open task endpoint, send text, read liveness/busy state, close, list. Implementations: `herdr-app` and the existing test fake (`AMIGO_TERMINAL=test`).
- Remove every other terminal path (plain herdr, other terminals' tabs, the new-window fallback) from code, tests and README.
- amigo refuses to start outside herdr-app, saying so.
- Pin the tested herdr-app version; the session-start digest warns when the installed version differs.
- firstmate refs: `bin/backends/hc.sh`, `docs/hc-backend.md`, `bin/fm-backend.sh`, `bin/fm-control.sh`, `docs/agent-control.md`.

### 2. Home layout, projects, cutover

- `~/.amigo/` gets firstmate's split: `config/` (local choices), `data/` (durable records: `boss.md`, `learnings.md`, `backlog.md`, survey reports), `state/` (runtime records, append-only status events, wake queue), `projects/` (clones).
- Project registry gains `mode`, `yolo`, `branchPrefix`, `live`. `amigo add` clones into `projects/<name>`; amigo never writes to a clone except through the guarded sync and merge paths.
- Worktrees come from `treehouse` (or the TS replacement), starting from origin's tip, never from the clone's checkout. Ship-brief isolation assertion included.
- Migration: register `noira-orders`, `tripwire`, `amigo` and `claude` as clones; `amigo` and `claude` get `live:` set to their current folders; drop `policy*.json`, `gates.confirmed.json`, `approvals.jsonl`, `checks`; keep task history.
- firstmate refs: `.agents/skills/operational-home-layout`, `.agents/skills/project-management`, `bin/fm-project-mode.sh`, `bin/fm-spawn.sh` (isolation and fresh-base rules), `bin/fm-tangle-lib.sh`, `bin/fm-fleet-sync.sh`.

### 3. Delivery, merge, after the PR

- Brief scaffold with `## Boss's intent` and `## amigo spec` sections and the per-mode definition of done, generated by code; spawn refuses a brief whose mode disagrees with the registry. Worker status protocol and declared waits as firstmate.
- `no-mistakes` mode: the crew member runs the pipeline to a PR. `direct-PR`: the crew member pushes and opens the PR. `local-only`: the crew member stops with a clean ready branch; amigo lands it with a guarded fast-forward.
- `amigo merge`: live check that the PR is open, not a draft, mergeable and green on every required check at the current head; merge pinned with `--match-head-commit`; confirm it landed; record the outcome. Refuse a red merge without a current explicit instruction from the Boss. `yolo` lets amigo merge green work itself; otherwise the Boss says "merge it".
- After the PR: watch CI and merge state, refresh the clone after a merge, fast-forward the `live:` folder, clean up only after the landed-work test passes.
- Steering: `amigo send` writes a durable inbox message and rings the crew member's tab; lifecycle control (interrupt, exit, relaunch) is a separate command.
- Remove the old gates listed in Decisions.
- firstmate refs: `bin/fm-brief.sh`, `bin/fm-dod-lib.sh`, `bin/fm-classify-lib.sh`, `bin/fm-send.sh`, `bin/fm-task-inbox-lib.sh`, `bin/fm-pr-merge.sh`, `bin/fm-merge-local.sh`, `bin/fm-pr-check.sh`, `bin/fm-teardown.sh`, `.agents/skills/ship-landing`, `.agents/skills/validation-supervision`, `.agents/skills/ask-user-authority`, `.no-mistakes.yaml`.

### 4. Supervision, stuck crew, restart, one session

- Zero-token watcher process: sleeps on the fleet, classifies wakes in code, and wakes amigo only for actionable ones (signal, stale, check, heartbeat). Durable wake queue with generation-bound acknowledgement.
- Turn-end guard for Claude Code (Stop hook): no turn ends blind while work is under way.
- Stale detection: a crew member with no progress and no declared wait past the threshold raises "stopped responding"; recovery as firstmate (preserve the worktree and unlanded work).
- Session lock: one controlling amigo per home; a second session is read-only and says why.
- Session-start digest run once per session: lock, bootstrap, wake drain, recovery inputs, network checks.
- firstmate refs: `bin/fm-watch.sh`, `bin/fm-wake-lib.sh`, `bin/fm-crew-state.sh`, `bin/fm-session-start.sh`, `bin/fm-session-lock-lib.sh`, `bin/fm-lock.sh`, `bin/fm-guard.sh`, `bin/fm-turnend-guard.sh`, `bin/fm-claude-stop-autoarm.sh`, `docs/turnend-guard.md`, `docs/watcher-continuity.md`, `docs/supervision-protocols/claude.md`, `.agents/skills/session-start-recovery`, `.agents/skills/stuck-crewmate-recovery`.

### 5. Task types, backlog, dispatch, capacity

- `build` and `survey` task shapes; surveys write `data/<id>/report.md`, never push, and are torn down only after their open decisions are recorded.
- Backlog through `tasks-axi`; spawn and teardown move items; Boss holds with `--until`.
- Dispatch profiles in declared order plus the effort fallback (low for well-understood work, xhigh for ambiguous investigation or design, never max without the Boss saying so).
- Capacity: firstmate's auto lanes from free memory, CPU load and disk, plus per-project caps; a spawn beyond capacity stays queued.
- firstmate refs: `.agents/skills/scout-completion`, `bin/fm-tasks-axi.sh`, `bin/fm-captain-hold.sh`, `.agents/skills/captain-hold-lifecycle`, `bin/fm-dispatch-resolve.sh`, `bin/fm-harness.sh`, `.agents/skills/harness-adapters` (Claude Code primary path only), `bin/fm-capacity.sh`, `docs/configuration.md` (crew dispatch profiles, lane capacity).

### 6. Contract, skills, voice

- Rewrite `prompts/amigo.md` as the lean port of firstmate's `AGENTS.md` sections that are in scope (identity and hard rules, layout, session start, dispatch, recovery, knowledge routing, task lifecycle, supervision, escalation and talking to the Boss, backlog, briefs, self-update, precedence), brand-mapped.
- Agent-only skills loaded at triggers, ported and brand-mapped: session-start recovery, stuck crew recovery, build landing, survey completion, validation supervision, ask-Boss authority, diagnostic reasoning, Boss hold lifecycle, project management, away/quiet supervision.
- User skills: `/catchup`, `/rundown`, `/remember`, `/updateamigo`, `/afk`, `/quiet`. `/updateamigo` fast-forwards amigo's own `live:` folder and restarts.
- Research rule: consult existing reports and evidence before sending out a survey.
- Talking to the Boss: firstmate's translation list for internal terms, a final message that stands alone, full PR URLs copied from records.
- firstmate refs: `AGENTS.md`, `.agents/skills/{ahoy,bearings,stow,afk,quiet,away-quiet-supervision,updatefirstmate,diagnostic-reasoning}`, `bin/fm-update.sh`.

### 7. Docs and wrap-up

- README rewritten for the new model, with the credit line.
- Brand-check test (Done when 4).
- Add one line to `~/.claude/CLAUDE.md`: inside an amigo session, amigo's contract wins except for the security rules.
- Remove "squad member" everywhere.

## Execution

Steps run in order 0 → 7; within a step, independent parts may run in parallel. Implementation by Sonnet subagents in worktrees (not by amigo's own crew, since amigo is being rebuilt); Opus reviews each finished step, including a real herdr-app run for steps 1, 3 and 4.

## Risks

- **herdr-app is a preview product.** Its commands and variables can change between releases. The backend interface keeps the blast radius to one file, and the version pin warns on drift.
- **no-mistakes on Windows** has an open issue about its daemon hanging. The spike decides; otherwise its pipeline is re-implemented in TS, which is the largest single piece of work in this plan.
- **Scale of the port.** firstmate's mechanisms carry many edge cases encoded in its scripts. Porting "lean" risks dropping some. Each step must read the named firstmate files, not only this plan.
