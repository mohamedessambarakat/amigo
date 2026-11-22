![amigo wordmark beside a white square with an amber square at its lower right. Your right hand. Runs the squad.](docs/images/2026-11-21-banner.png)

# amigo

Your right hand. Runs the squad. You talk to one agent, **amigo**, about anything: code, research, errands. It plans, hands every piece of work to a **squad member** (another agent in its own tab, and its own git worktree for code) and runs them in parallel. Each project has a delivery mode: the crew member commits on its own branch and, depending on the mode, runs the no-mistakes pipeline to a pull request, opens the pull request itself, or leaves a clean ready branch. amigo merges only green work, and only on your word or when you made the project yolo.

Works with any agent CLI that takes a prompt on the command line (Claude Code, Codex, Gemini CLI, Antigravity, Grok, ...), on Linux, macOS and Windows. It is a small Node.js tool with no runtime dependencies.

Made by [essam](https://essam.pro).

```
you ──▶ amigo ──spawn──▶ squad member 1 (worktree, branch amigo/<id>)
         ▲   ◀──inbox──  squad member 2
         │               squad member 3 (queued until memory or its folder frees up)
         └── "fix-footer is done, 1 file changed. Commit it?"
```

## Install

You need Node.js 24.3 or newer, git, an agent CLI that already works on your machine, and the herdr desktop app (`herdr-app`, with `herdr-app` and `hc` on PATH). amigo runs only inside a herdr-app terminal and refuses to start anywhere else; it opens each crew member in a herdr-app tab. It was tested with herdr-app 0.1.16 and hc 0.1.21; the briefing warns when another version is installed.

```sh
git clone https://github.com/mohamedessambarakat/amigo
cd amigo
npm install -g .
amigo install-skill
```

- `npm install -g .` links the `amigo` command to this folder, so keep the folder where it is (moving or deleting it breaks the command; `git pull` updates it). Installing straight from GitHub (`npm install -g github:...`) does not work: Node will not run TypeScript from inside `node_modules`.
- `amigo install-skill` adds an `/amigo` command to every supported agent CLI it finds, and adds that agent to your config. It prints every file it writes; `amigo install-skill --remove` takes them out again.
- Everything amigo stores lives in `~/.amigo/` (set `AMIGO_HOME` to put it elsewhere), split by what each record is: `config/` (local choices), `data/` (durable records: the project registry, briefs and reports), `state/` (runtime records) and `projects/` (amigo's own clones).
- amigo takes every worktree from [treehouse](https://github.com/kunchenguid/treehouse)'s pool, so install it first. amigo finds it on `PATH`, or on Windows where its installer puts it (`%LOCALAPPDATA%\treehouse\treehouse.exe`). The pool lives in `~/.amigo/state/worktrees/` unless `TREEHOUSE_ROOT` names another folder.
- **Coming from an older amigo?** A home with `config.json` and `projects.json` at its top is refused until you convert it: close every open task first, then run `amigo migrate --dry-run` to see the plan and `amigo migrate` to do it. Each registered folder becomes a clone in `~/.amigo/projects/<name>`, made from the folder's `origin` (registered `no-mistakes` with yolo on; a folder without an origin is cloned as it is and registered `local-only`). `--live <project>` records that project's old folder as its live install, `--drop <project>` leaves one out. The old gate files (`policy.json`, `policy.approved.json`, `gates.confirmed.json`, `approvals.jsonl`) and each project's checks and risky paths are dropped; task history moves to `state/tasks/`. A run that stops halfway is simply run again.

## Add your projects

```sh
amigo add https://github.com/me/my-app.git
amigo add git@github.com:me/website.git --name site --notes "Never touch .env. Run npm test before reporting."
```

`add` clones the project into `~/.amigo/projects/<name>` and registers it with its delivery posture: `--mode no-mistakes` (the default: the no-mistakes pipeline runs before a pull request), `direct-PR` (push and open a pull request) or `local-only` (no remote or pull request), `--yolo` (amigo may merge green work itself; off by default) and `--branch-prefix` (build branches are `amigo/<id>` unless you name another prefix; `--branch-prefix ""` gives a bare id). `--live <folder>` marks a folder you run the project from, to be fast-forwarded after a confirmed merge. amigo never writes to a clone except through `amigo sync`, which fast-forwards it from `origin` when that is safe and reports anything else as STUCK without touching it.

Notes are hard rules for every crew member on that project (add one later with `amigo note my-app "Use the v2 endpoint."`).

```sh
amigo add https://github.com/me/my-app.git --name my-app --mode direct-PR --yolo
```

Running `add` again with the same name and source updates the project and keeps what you leave out. Each crew member gets a worktree leased from treehouse's pool, checked to be a separate worktree of the clone (never the clone itself), required clean, then reset to origin's current default branch (never the clone's checkout) with a new branch `amigo/<id>`. Closing the task returns the worktree to the pool.

## Start working

In an agent session you already have open in a herdr-app terminal, type `/amigo` (`$amigo` in Codex). Or start amigo from a herdr-app terminal:

```sh
amigo
```

Add `--agent <name>` to pick the agent (`amigo --agent codex`) and `--dry-run` to see the command without starting anything. amigo opens with a briefing: what finished since you last looked, what is waiting on you, and what is open. Then you just talk to it:

```
3 projects registered.
Finished since your last look (1):
7-fix-footer  done  [my-app] Fix the broken footer link
    changed the link in footer.html, npm test passes
Open:
queued (1)
  8-dark-mode  [site] Add a dark mode toggle  (2m 05s)

> fix the broken footer link in my-app, and add a dark mode toggle to site
```

It writes a brief with Done-when criteria for each task and starts each squad member in a new tab. Each squad member gets a short id: its number and a few words of its title, like `7-fix-footer`. Every command takes the number alone (`amigo status 7`), and numbers are never reused. Ask it what is done whenever you like. When a crew member reports done, amigo checks the result against the brief and brings you the pull request (or the ready branch). On your "merge it", or by itself for a yolo project, it merges the green work, refreshes its clone, fast-forwards the project's live folder and cleans up.

amigo reports in short plain prose: what happened, with real numbers, and what it holds up; then, only if something needs you, its recommendation and why, with the choices as options (clickable where the agent has a question tool, otherwise `A)`, `B)`, `C)`).

Crew members that need an answer stop and ask; amigo brings the question to you and sends your answer back through the crew member's inbox, and it carries on in the same folder. To type into a Claude Code squad member yourself, switch to its tab.

### Startup checks

Besides the local state, the briefing starts checks that report to your inbox. Both are set per project with `add`. The crew member that looks at watch items is told to change nothing (no edits, commits or pushes); that is a rule given to it, as for every squad member, not something amigo enforces.

- **Live commands** (`--live-command <cmd>`, repeatable) are shell commands run in the clone, each with a time limit (60 seconds), by a background process. Their output arrives in the inbox as one entry, "briefing: live checks". A git project whose `origin` is on GitHub gets `gh pr list --limit 5` and `gh run list --limit 3` by default when `gh` is installed; amigo runs `gh` by its absolute path with a fixed argument list, through no shell, so a program a repository ships under that name is never started. `--live-command ""` turns the defaults off.
- **Watch items** (`--watch <text>`, repeatable) are plain-words things for an agent to look at, such as "any failing deploy this week?". If any project has them, one scratch squad member titled "Briefing checks" gets them as its brief and reports like any other.

```sh
amigo add https://github.com/me/my-app.git --name my-app --live-command "npm outdated" --watch "Is the staging site up?"
```

### Scratch work

Work that belongs to no project runs in a scratch folder: `amigo spawn --scratch` gives the squad member its own folder `~/.amigo/state/scratch/<id>/` (not git). Several scratch squad members run in parallel, each in its own folder. `close` keeps the folder and prints its path.

### Builds and surveys

A task is a **build** (the default: it changes a project) or a **survey** (`spawn --survey`): its deliverable is a written report at `~/.amigo/data/<id>/report.md`, never a commit or a pull request. A survey's worktree is a laboratory whose edits and scratch commits are thrown away when it is closed, and every push from its session is refused. `close` refuses a survey until its report exists and its open questions for the Boss are recorded: each one is held in the backlog (`amigo hold <id> --reason "<question and options>" --origin <survey>`), then `amigo complete <survey> <held ids>` (or `--none`, which the survey may run itself when it found no such question). `close --force` discards a survey without its report.

### Backlog, dispatch and capacity

- **Backlog.** Once `~/.amigo/data/backlog.md` exists (the first `amigo backlog add` or `amigo hold` creates it), the work queue is kept there by [tasks-axi](https://github.com/kunchenguid/tasks-axi) (0.2.6 or newer, `npm install -g tasks-axi`). `spawn` adds the task's item (or dispatches an existing one with `--task <id>`, which refuses one that is held, blocked or already In flight), the crew member's start moves it In flight, and `close` moves it to Done with what it delivered. A decision is an item held for the Boss (`amigo hold`, `--until <date>` when he says "later"); `amigo answer` records his exact words and closes the call, or `--release` lets the held work go on. Closing a task whose item is still held for the Boss keeps the item open.
- **Dispatch profiles.** An optional `~/.amigo/config/crew-dispatch.json` lists rules (`when` a kind of task, `use` profiles of `agent`, `model`, `effort`) and a `default`. amigo picks the rule that fits; `amigo dispatch <n>` resolves it in declared order to spawn flags, and while the file exists every spawn names its `--agent`. A Claude Code crew member gets `--model` and `--effort`; other agents record them only. `--effort max` needs the Boss (`--boss-max`, or a profile of his that declares it).
- **Capacity.** An optional `~/.amigo/config/lane-capacity` caps how many crew members run at once: a number, or `auto` to measure free memory, CPU load and disk on every start (keys: `min-avail-gb`, `min-disk-gb`, `max-load1`, `max-lanes`, `reserve-flag`). With `admit-spawns` a crew member beyond it stays queued; without it `amigo capacity` only reports. `~/.amigo/config/project-capacity` holds `<project> <n>` lines: at most n crew members of that project at once, counted until each one's PR is recorded or it is closed.

You can use every command yourself too:

```
amigo: your right hand. Runs the squad.

  amigo [--agent <name>] [--dry-run]                start amigo in this terminal: a briefing first, then you just talk to it
  amigo install-skill [<agent>] [--remove]          add /amigo to your agent CLIs (all found on PATH, or one)
  amigo brief --agent <name>                        print amigo's instructions and the briefing (what /amigo runs)
  amigo add <git url or path> [--name <name>] [--mode no-mistakes|direct-PR|local-only] [--yolo | --no-yolo] [--branch-prefix <p>]
            [--live <folder>] [--notes <text>] [--live-command <cmd>]... [--watch <text>]...
                                                    clone a project into projects/<name> and register it; the same name and source again updates it
  amigo projects                                    list registered projects
  amigo sync [<project>]                            refresh the clones from origin (fast-forward only; anything unsafe is reported, never touched)
  amigo migrate [--live <project>]... [--drop <project>]... [--dry-run]
                                                    convert a home from before this version: projects become clones, the old gate files go
  amigo note <project> <text>                       add a line to a project's notes (every later squad member gets it)
  amigo spawn (--project <name> | --review <id> | --scratch) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start a squad member; the brief comes from stdin unless --brief-file is given. A build's
                                                    brief is "## Boss's intent" and "## amigo spec"; amigo adds the rules and the definition of done
            [--survey] [--task <backlog id>] [--model <m>] [--effort low|medium|high|xhigh|max] [--boss-max]
                                                    a survey writes data/<id>/report.md and never pushes; --task dispatches a backlog item
  amigo status [<id>]                               tasks by station, or one in detail (status, inbox, PR, uncommitted files)
  amigo inbox                                       squad members that finished since you last looked, and background results
  amigo wait [<id>...] [--timeout-min <n>]          wait until a squad member finishes a turn (default 60 min)
  amigo send <id> [--resolve-key <key>]... [--validate | --file <file> | <message>]
                                                    steer a crew member: the message goes to its durable inbox and its tab is rung
                                                    (--validate: tell a no-mistakes build to run its pipeline; --resolve-key closes that open decision)
  amigo control <id> interrupt|exit|relaunch [--note <text>]
                                                    lifecycle: stop its turn, stop its agent (worktree kept), or start it again with a note
  amigo report <state> [--key <key>] <text>         (crew members) append a status line: working, needs-decision, blocked, paused, done, failed, resolved, note
  amigo attach <id>                                 print a squad member's results and follow it while it runs
  amigo pr-check <id> [<pr url>] [--watch [--timeout-min <n>]]
                                                    read a build's PR live (CI, merge state); a merge on GitHub is recorded and cleaned up after
  amigo merge <id> [--boss] [--pr <url>] [--expected-head <sha>] [--allow-red <check>] [--allow-missing <check>] [--method squash|merge|rebase]
                                                    land a build: a PR only when open, not a draft, mergeable and green at its pinned head;
                                                    local-only by a guarded fast-forward. Without --boss (the Boss said "merge it") only a yolo project
  amigo land <id>                                   finish after a merge: refresh the clone, fast-forward the live folder, clean up once landed
  amigo close <id> [--force]                        tear a crew member down; a build only once its work has landed (--force: the Boss said discard it)
  amigo digest [--again]                            the session-start digest: take the session lock, drain wakes, show the fleet (once per session)
  amigo wake (drain | ack --through <seq> --generation <n> | status)
                                                    the durable wake queue: show it, acknowledge what was handled, or count it
  amigo watch                                       run one watcher cycle here and print the wake it closes on (the Stop hook does this itself)
  amigo check (add <name> [--every <s>] [--cwd <dir>] -- <command>... | rm <name> | list)
                                                    commands the watcher runs on an interval; anything they print wakes amigo
  amigo backlog [<tasks-axi command> [args...]]     the work queue (data/backlog.md) through tasks-axi: list, ready, add, show, update...
  amigo hold <id> --reason <text> [--until YYYY-MM-DD] [--title <t> [--project <p>]] [--origin <survey id>]
                                                    hold a backlog item for the Boss's call (--title creates it); --until defers it to a date
  amigo answer <id> [--release] (<the Boss's words> | --file <file>)
                                                    record the Boss's exact answer: closes the call, or --release lets the held work go on
  amigo complete <survey id> (--none | <held item id>...)
                                                    attest a survey's open Boss calls (or none), so close may tear it down
  amigo dispatch [<rule number> | default]          the dispatch profiles, or one rule resolved to spawn flags
  amigo capacity                                    lanes in use, open lanes and host headroom, and project caps
  amigo help                                        this text (-h or --help anywhere in a command prints it too)
  amigo --version                                   print the version

Data lives in $AMIGO_HOME (default ~/.amigo): config/, data/, state/ and projects/.
```

## Delivery, merge and after the PR

amigo enforces these in its own code, so they work with every agent CLI and the agent cannot talk its way past them.

**The brief.** A build's brief is two sections amigo writes, `## Boss's intent` (your own words) and `## amigo spec` (its build instructions). `spawn` refuses a brief without them, and one whose `Delivery contract: mode=` line disagrees with the project's registered mode. Around them it writes the rest from code (`data/<id>/brief.md`): an isolation check, the rules, the status protocol, the steering inbox and the definition of done of the project's mode, which opens with a fixed `Delivery contract: mode=<mode>` line.

**Delivery modes.** `no-mistakes`: the crew member commits, reports a first done (the handoff), then on `amigo send <id> --validate` runs the no-mistakes pipeline, which pushes and opens the pull request, and reports `done: PR <url> checks green`; only your own words go to the pipeline as `--intent`, and `--yes` is banned. `direct-PR`: the crew member pushes its branch and opens a ready (not draft) pull request itself and reports `done: PR <url>`. `local-only`: it commits on its branch and reports `done: ready in branch <branch>`; nothing is pushed.

**Status protocol.** A crew member reports with `amigo report <state> "<one line>"`, which appends `<state> [at=<epoch>]: <line>` to `state/tasks/<id>/status`: working, needs-decision, blocked, paused (a declared wait, with `until <UTC time>` when it knows), done, failed, resolved (closes an open decision with the same `--key`) and note. A build's done is gated: a pull request ready line is accepted only when the worktree is clean and its head is on a remote branch after a fetch, and not a draft; a local-only ready line only when the head is the branch itself, which is then latched as the one commit `merge` may land. A refused done reads as `blocked` with the reason.

**Steering.** `amigo send <id>` writes the message to the crew member's durable inbox (`state/tasks/<id>/inbox/NNN.msg`) and types one constant doorbell line into its tab; the crew member acknowledges by moving the message into `handled/`. `--resolve-key <key>` also closes that open decision. Lifecycle is separate: `amigo control <id> interrupt` stops its turn, `exit` stops its agent and keeps the worktree, `relaunch --note <text>` starts it again in the same worktree.

**Merge.** `amigo merge <id>` reads the pull request live and merges only when it is open, not a draft, mergeable, free of conflicts, every check green at its current head and every check the base branch requires reported; it reports every failing condition, and merges with that head pinned (`gh pr merge --squash --match-head-commit <head>`), then counts it only once GitHub reads back merged. A local-only build lands by a guarded fast-forward of the clone's default branch to its latched head (the clone on its default branch and clean, a fast-forward only, the branch still at that head). Without `--boss` (you said "merge it") only a yolo project's work is merged, and a red or missing check is waived (`--allow-red`, `--allow-missing`) only with `--boss`.

**After the PR.** `amigo pr-check <id> [--watch]` reads the pull request's CI and merge state; a merge made on GitHub is recorded too. The watcher does the same for every recorded, unmerged PR on its own cadence (`AMIGO_PR_POLL_SECS`, default 120) and wakes amigo once per change: CI red, green and mergeable, closed, or merged on GitHub (which it lands as pr-check does); CI still running wakes nobody. After a confirmed merge amigo refreshes the clone, fast-forwards the project's `--live` folder (skipped and reported when it is dirty, on another branch or diverged) and tears the build down, but only after the landed-work test: uncommitted work never counts, committed work counts when its head is on a remote branch, in the local default branch (local-only), in the merged pull request's head, or its content is already in origin's default branch. `amigo close` applies the same test and refuses unlanded work; `--force` discards it, only on your explicit word.

**Tasks that depend on each other.** `spawn --after <id>` (same project) keeps the new task queued until the other one is closed with landed commits, then starts its worktree from that commit. If the other task is discarded, the new one becomes `blocked` with the reason.

**Issues.** `spawn --project <p> --issue <n>` reads GitHub issue `n` with `gh issue view` and puts its title, link and text in the brief's spec as quoted data from GitHub, not instructions (its title becomes the task's title unless the brief has a `Title:` line).

**Status by station.** `amigo status` groups tasks into queued, building, in review, closing, waiting on you (finished turns awaiting a decision, blocked, question, failed) and done (the few most recently closed).

## Agents

`~/.amigo/config/config.json` holds one entry per agent. `amigo` starts the interactive session you talk to. `member` starts a squad member: Claude Code runs it as an interactive session (see below); other agents run one task and exit. `{prompt}` is replaced by the instructions. `install-skill` fills this in for you; edit it to change flags.

```json
{
  "agents": {
    "claude": {
      "amigo": ["claude", "{prompt}"],
      "member": ["claude", "--permission-mode", "auto", "{prompt}"]
    }
  },
  "memberMb": 600,
  "reserveMb": 2048
}
```

| Agent | Slash command | `amigo` | `member` |
|---|---|---|---|
| Claude Code | `/amigo` | `["claude", "{prompt}"]` | `["claude", "--permission-mode", "auto", "{prompt}"]` |
| Codex | `$amigo` | `["codex", "{prompt}"]` | `["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{prompt}"]` |
| Gemini CLI | `/amigo` | `["gemini", "-i", "{prompt}"]` | `["gemini", "--approval-mode", "auto_edit", "-p", "{prompt}"]` |
| Antigravity | `/amigo` | `["agy", "-i", "{prompt}"]` | `["agy", "-p", "{prompt}"]` |
| Grok | `/amigo` | none | `["grok", "-p", "--always-approve", "{prompt}"]` |

Flags come from each tool's documentation; check them against your installed version.

- **Permissions are yours to choose.** Squad members work without anyone approving each step, so a squad member can only do what its flags allow, and whatever you allow applies to every squad member.
  - Claude Code's `auto` mode lets a classifier approve safe actions, such as edits and running tests, and blocks risky ones.
  - Codex works in a sandbox limited to the squad member's folder.
  - Gemini CLI approves edits only.
  - Grok's `--always-approve` approves everything except what your Grok deny rules forbid.
  - Antigravity documents no headless approval flag, so its squad members may stop and ask.
  - Every agent also has a flag that skips all checks (for example `--dangerously-skip-permissions` for Claude Code). Its docs recommend that only inside a container or VM.
- An agent without `amigo` (Grok) can still be amigo through its slash command.
- Squad members use the same agent as amigo unless amigo picks another one for a task (`--agent`). Bare `amigo` uses `"defaultAgent"`, or the first agent listed.
- A squad member starts only while free memory, minus `memberMb` (what one squad member needs, in MB), stays at or above `reserveMb`. Other tasks wait in a queue and start by themselves as memory frees up. Only one squad member runs in a folder at a time.

Check a template without running anything: `amigo spawn --project <name> --dry-run --brief-file README.md` prints the exact command.

## Install with an AI agent

Give your agent the link to this repository and ask it to set up amigo. Agent, do these steps in order:

1. Check `node --version` (24.3 or newer) and `git --version`. If one is missing, stop and tell the user.
2. Clone the repository into a folder the user will keep, and run `npm install -g .` inside it. Check: `amigo help` prints the command list.
3. Run `amigo install-skill <your agent>` (claude, codex, gemini, antigravity or grok). For other agents, add an entry to `~/.amigo/config/config.json` from the table above. **Ask the user** whether the squad member permission flags are right for them; never switch to flags that skip all checks on your own.
4. **Ask the user** which projects to add (git URL or folder) and whether any project has rules, then run `amigo add <git url or path> [--notes "..."]` for each. Check: `amigo projects` lists them.
5. Check the template: `amigo spawn --project <name> --dry-run --brief-file README.md` must print a command, not an error.
6. Tell the user to type `/amigo` in a new session of their agent (or run `amigo` in a terminal). Do not start it yourself.

## How it works

- `~/.amigo/` holds `config/` (`config.json`), `data/` (`projects.json`, the registry, and `<id>/brief.md` per task), `state/` (`tasks/<id>/` with prompt, task state, output log, status file and inbox, `notices.json` with background results waiting for your inbox, `scratch/<id>/` and the worktree pool `worktrees/`) and `projects/<name>/`, amigo's clones.
- `/amigo` runs `amigo brief --agent <name>`, which prints amigo's instructions with the briefing and starts the briefing's background checks; the session you are in becomes amigo.
- amigo runs only inside the herdr desktop app. It knows it is there when its own herdr-core terminal (`HC_TERMINAL_ID`) is live, shown by the app (it carries a `herdr.space` label) and shares this process's console (or tty); anywhere else `amigo`, `amigo brief` and `spawn` refuse and say why. Every terminal action goes through one backend (`src/terminal.ts`): open a crew member's tab, send it a line, read whether it is live and busy, close it, list this home's tabs. A crew member with its own worktree gets a space of its own (named `<id> · <title>`) and any other crew member a tab in amigo's space; nothing is focused, and the app closes the space with its last tab. Each crew member terminal is labelled `amigo.task=<id>` and `amigo.home=<tag>`, and amigo never types into or closes a terminal whose labels do not match. On Windows the tab's shell is PowerShell (herdr-core's default shell). The tab closes by itself when the crew member ends, also after an error; the error stays in `amigo status`, `inbox` and `attach`.
- Crew members report through their status file (`amigo report`), and end each turn with a matching `STATUS: done - ...`, `STATUS: blocked - ...` or `STATUS: question - ...` line, the fallback for a turn that filed nothing; the result is what amigo sees in `amigo inbox` and `amigo wait`.
- **Claude Code squad members** are interactive sessions named `amigo-<id>` (you can type into them in their tab). Hooks (in `state/tasks/<id>/claude-settings.json`) record each turn's report. When amigo is Claude Code too, each squad member messages the session that spawned it (by its messaging address, so amigo can be named anything and renamed freely) with SendMessage when a turn ends, and amigo can message a squad member whose session is open. A turn that ends without a report (a status line that ends the turn or declares a wait, or a STATUS line), or without that message, is sent back once. `amigo control <id> relaunch` resumes the squad member's session. Before a squad member starts, amigo marks its folder as trusted in `~/.claude.json` (so the session opens without the trust dialog) and removes that entry when the squad member's worktree is closed.
- **Other agents** run their `member` command once; the output stays in `tasks/<id>/output.log` (`amigo attach <id>` follows it). Without a STATUS line, the squad member is `done` if the agent exited cleanly, else `failed`. A relaunch runs it again with the brief, its last result and every note.
- On Windows, agents installed by npm are `.cmd` files that only start through `cmd.exe`, which cannot carry a multi-line prompt. Those agents get one line instead: "Read the file <path> and follow the instructions in it exactly." The same happens for any prompt longer than 24,000 characters.

## Safety

- Squad members work without step-by-step approval, with exactly the permissions their template gives the agent. Start with the narrow ones.
- amigo marks only its own squad member folders as trusted in `~/.claude.json`, keeps every other field of that file, and removes the entry for a worktree it closes.
- Squad members cannot run amigo's managing commands (`spawn`, `send`, `control`, `merge`, `land`, `pr-check`, `close`, `add`, `note`, `install-skill`, `inbox`, `wait`, `brief`) or start a session (bare `amigo`); only amigo can.
- amigo itself never commits or pushes a crew member's work: the crew member commits on its own `amigo/<id>` branch (or `<prefix><id>`), and its delivery mode says what it may push. amigo writes to a clone only through `amigo sync`, the guarded local-only fast-forward and the post-merge refresh, and merges only through `amigo merge`.
- Crew members run code they wrote (tests, scripts, the no-mistakes pipeline) with your own permissions, so a permission mode is not a sandbox. Run squad members only on projects whose code you would run yourself. If you need a real sandbox, run amigo inside OS-level isolation such as a container or a VM.
- `close` refuses to throw away work that has not landed unless you add `--force`.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run the real CLI against a fake agent (`test/fake-agent.mjs`) and a fake GitHub CLI (`test/fake-gh.mjs`, found through `AMIGO_GH`, with a local bare repo as `origin`) in temporary folders, with crew member tabs replaced by detached processes (the test terminal backend, `AMIGO_TERMINAL=test`).

| Folder | What is in it |
|---|---|
| `src/` | The CLI: commands, agent launching, task state, git worktrees, skill files |
| `prompts/` | The instructions given to amigo (`amigo.md`) and to every squad member (`member.md`) |
| `test/` | Unit tests, end-to-end tests and the fake agent |
| `docs/` | Images for this README, and the plans (`docs/plans/`) |

## License

MIT. Workflow ported from firstmate by Kun Chen (MIT).
