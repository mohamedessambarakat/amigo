![amigo wordmark beside a white square with an amber square at its lower right. Your right hand. Runs the squad.](docs/images/2026-11-21-banner.png)

# amigo

Your right hand. Runs the squad. You talk to one agent, **amigo**, about anything: code, research, errands. It plans, hands every piece of work to a **squad member** (another agent in its own tab, and its own git worktree for code) and runs them in parallel. Finished work passes your project's checks and, when it is not trivial, a fresh reviewer before amigo brings it to you. Accepted work is committed to its own branch. Nothing is pushed unless a policy you approved allows it, and amigo never merges.

Works with any agent CLI that takes a prompt on the command line (Claude Code, Codex, Gemini CLI, Antigravity, Grok, ...), on Linux, macOS and Windows. It is a small Node.js tool with no runtime dependencies.

Made by [essam](https://essam.pro).

```
you ──▶ amigo ──spawn──▶ squad member 1 (worktree, branch amigo/<id>)
         ▲   ◀──inbox──  squad member 2
         │               squad member 3 (queued until memory or its folder frees up)
         └── "fix-footer is done, 1 file changed. Commit it?"
```

## Install

You need Node.js 24.3 or newer, git, and an agent CLI that already works on your machine. Nothing to set up for the terminal: amigo finds the one amigo runs in and opens squad member tabs there (a new window, if that terminal has no way to open a tab).

```sh
git clone https://github.com/mohamedessambarakat/amigo
cd amigo
npm install -g .
amigo install-skill
```

- `npm install -g .` links the `amigo` command to this folder, so keep the folder where it is (moving or deleting it breaks the command; `git pull` updates it). Installing straight from GitHub (`npm install -g github:...`) does not work: Node will not run TypeScript from inside `node_modules`.
- `amigo install-skill` adds an `/amigo` command to every supported agent CLI it finds, and adds that agent to your config. It prints every file it writes; `amigo install-skill --remove` takes them out again.
- Everything amigo stores lives in `~/.amigo/` (set `AMIGO_HOME` to put it elsewhere).
- **Coming from octomaxxing?** The first amigo command moves `~/.octomaxxing` to `~/.amigo` (once, and only while no task is running), rewrites the paths inside it, repairs the git worktrees of open tasks and removes the old `/octomaxxing` command; run `amigo install-skill` afterwards. Old `octomaxxing/<id>` branches stay as they are, and tasks on them still close and push. There is no `octomaxxing` alias, and the old `OCTOMAXXING_*` variables are not read.

## Add your projects

```sh
amigo add ~/code/my-app
amigo add ~/code/website --name site --notes "Never touch .env. Run npm test before reporting."
```

Notes are hard rules for every squad member on that project (add one later with `amigo note my-app "Use the v2 endpoint."`). A project can also carry **checks** (shell commands that must pass before work counts as done) and extra **risky paths** (see below):

```sh
amigo add ~/code/my-app --check "npm test" --check "npm run lint" --risky "src/legacy/**"
```

Running `add` again with the same name and folder updates the project and keeps what you leave out; a repeated `--check` or `--risky` replaces the whole list, and `--check ""` clears it. In a git repository each squad member gets its own worktree on a new branch `amigo/<id>`, starting from the repo's current commit (uncommitted changes in your checkout are not included). Any other folder is worked on in place, by one squad member at a time.

## Start working

In an agent session you already have open, type `/amigo` (`$amigo` in Codex). Or start amigo from any terminal:

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

It writes a brief with Done-when criteria for each task and starts each squad member in a new tab. Each squad member gets a short id: its number and a few words of its title, like `7-fix-footer`. Every command takes the number alone (`amigo status 7`), and numbers are never reused. Ask it what is done whenever you like. When a squad member finishes, amigo checks the result and asks you to accept, telling you how many files changed. Bigger work first gets a separate reviewer squad member, which checks the Done-when criteria and the blast radius: what the change could break outside its own diff, with the fact its safety rests on proven by running code or flagged as unproven. On your yes it runs `amigo close <id> --commit`: the work is committed to branch `amigo/<id>` and the worktree is removed. Merging and pushing stay with you.

amigo reports in short plain prose: what happened, with real numbers, and what it holds up; then, only if something needs you, its recommendation and why, with the choices as options (clickable where the agent has a question tool, otherwise `A)`, `B)`, `C)`).

Squad members that need an answer stop and ask; amigo brings the question to you and sends your answer back, and the squad member carries on in the same folder. To type into a Claude Code squad member yourself, switch to its tab.

### Startup checks

Besides the local state, the briefing starts checks that report to your inbox. Both are set per project with `add`. They run something at every start, so they are gated like checks: a project's own live commands and watch items are used only after you confirm them with `amigo confirm-gates <project>` in a terminal, and changing them needs confirming again. Until then the briefing says in one line that it skipped them. The squad member that looks at watch items is told to change nothing (no edits, commits or pushes); that is a rule given to it, as for every squad member, not something amigo enforces.

- **Live commands** (`--live <cmd>`, repeatable) are shell commands run in the project folder, each with a time limit (60 seconds), by a background process. Their output arrives in the inbox as one entry, "briefing: live checks". A git project whose `origin` is on GitHub gets `gh pr list --limit 5` and `gh run list --limit 3` by default when `gh` is installed: those need no confirmation because amigo runs `gh` by its absolute path with a fixed argument list, through no shell, so a program a repository ships under that name is never started. `--live ""` turns the defaults off.
- **Watch items** (`--watch <text>`, repeatable) are plain-words things for an agent to look at, such as "any failing deploy this week?". If any project has them, one scratch squad member titled "Briefing checks" gets them as its brief and reports like any other.

```sh
amigo add ~/code/my-app --live "npm outdated" --watch "Is the staging site up?"
```

### Scratch work

Work that belongs to no project runs in a scratch folder: `amigo spawn --scratch` gives the squad member its own folder `~/.amigo/scratch/<id>/` (not git, so no checks: its result shows as "unverified"). Several scratch squad members run in parallel, each in its own folder. `close` keeps the folder and prints its path.

You can use every command yourself too:

```
amigo: your right hand. Runs the squad.

  amigo [--agent <name>] [--dry-run]                start amigo in this terminal: a briefing first, then you just talk to it
  amigo install-skill [<agent>] [--remove]          add /amigo to your agent CLIs (all found on PATH, or one)
  amigo brief --agent <name>                        print amigo's instructions and the briefing (what /amigo runs)
  amigo add <path> [--name <name>] [--notes <text>] [--check <cmd>]... [--risky <glob>]... [--live <cmd>]... [--watch <text>]...
                                                    register a project folder; the same name and folder again updates it
  amigo projects                                    list registered projects
  amigo note <project> <text>                       add a line to a project's notes (every later squad member gets it)
  amigo spawn (--project <name> | --review <id> | --scratch) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start a squad member; the brief comes from stdin unless --brief-file is given
  amigo status [<id>]                               tasks by station, or one in detail (checks, risk, changed files)
  amigo inbox                                       squad members that finished since you last looked, and background results
  amigo wait [<id>...] [--timeout-min <n>]          wait until a squad member finishes a turn (default 60 min)
  amigo send <id> [--file <file> | <message>]       follow-up for a finished squad member (message from stdin if neither is given)
  amigo attach <id>                                 print a squad member's results and follow it while it runs
  amigo close <id> [--commit [-m <message>] [--pr] [--self]] [--force]
                                                    finish a squad member: --commit keeps its work on branch amigo/<id>; --pr needs an approved policy whose pr is not never
  amigo policy                                      show the self-approval policy and whether it is approved
  amigo approve-policy                              approve the policy as it is now (needs a terminal and your typed yes)
  amigo confirm-gates <project>                     confirm a project's checks, risky paths, live commands and watch items as they are now, so --self and the briefing may rely on them (terminal + typed yes)
  amigo undo <id>                                   take back a self-approved commit: delete its branch (never a pushed one)
  amigo help                                        this text (-h or --help anywhere in a command prints it too)
  amigo --version                                   print the version

Data lives in $AMIGO_HOME (default ~/.amigo).
```

## Checks, review and delivery

amigo runs these gates in its own code, so they work with every agent CLI and the agent cannot talk its way past them.

**Checks.** When a squad member says `STATUS: done`, amigo (not the agent) runs each of the project's checks in the squad member's folder, through the shell, each with a time limit (10 minutes; `"checkTimeoutMin"` in `config.json`). The task shows as `verifying` meanwhile. If a check fails, the squad member gets a follow-up with the failing command and the tail of its output, fixes it and reports again: a Claude Code squad member is sent back inside the same session by its Stop hook, any other agent is run again with the follow-up. After two automatic retries the task becomes `blocked` and its summary names the failing check. A project without checks shows its finished tasks as `unverified`. A follow-up from amigo resets the retry count. Reviewer squad members are not checked.

**Risk and review.** `amigo status <id>` shows the risk of a squad member's work, measured against the commit its worktree started from (files, lines added and removed, deleted files, risky paths):

- `small`: at most 3 files and 100 lines, no deletions, no risky path.
- `needs-you`: any deletion or any risky path, however small. Risky paths are auth and auth-like names (`session`, `jwt`, `token`, `oauth`, `login`, `permission`, `middleware`), payments, billing and checkout, database migrations, `.env` and other secret or credential files, dependency manifests and lockfiles (`package.json`, `package-lock.json`, `yarn.lock`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile*`, `composer.*`, `.npmrc` and the like), production config (`config/production*`, `*.prod.*`), deploy and CI config (`.github/workflows`, `Dockerfile`, `vercel.json`, `fly.toml`, terraform, k8s), git hook and tooling folders (`.husky`, `.githooks`, `.git-hooks`, `lefthook*`, `.pre-commit-config.yaml`), the files the checks run (`Makefile`, `justfile`, `scripts`, `jest`, `vitest`, `playwright`, `karma`, `eslint` and `prettier` config, `tsconfig*.json`, `biome.json*`), the public API surface (`api`, `routes`, `openapi`, `.proto`), and the project's own `--risky` globs. A glob without a `/` matches a file or folder name anywhere (`migrations`, `*.sql`); with a `/` it matches from the repo root; `**` crosses folders.
- `non-trivial`: everything else. A binary file, a submodule change or a file mode change is never `small`, whatever its line count says.

Anything but `small` makes `close --commit` refuse until a reviewer squad member for that task (`spawn --review <id>`) has finished with a `PASS` verdict; there is no override. The task's work is recorded when the reviewer starts, and the `PASS` counts only if the work is unchanged when the reviewer finishes and when you close, so changing the work needs a new review. `send` refuses while a reviewer is open on the task (close it first). A `FAIL` on some work is final for that exact work: a later `PASS` on the same work does not count, so it must change first.

**Self-approval.** `~/.amigo/policy.json` (a starter is created on first run, inactive) says what an agent may approve without asking you. The starter allows `close --commit --self` only for low-risk work: a git repo, checks configured and all passed on exactly this work, risk `small`, and either only docs and tests changed or a reviewer `PASS` on exactly this work. Its `"pr"` field says who may open pull requests: `"never"` (the starter), `"after-human-yes"` (`close --pr` after your yes) or `"also-self-approved"` (also `close --self --pr`). There is nothing for merging. Docs-only does not cover agent instruction files (`CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `prompts/`, `.claude/`, `.github/`), and a test file that loses an existing line is not "only tests" (additions are fine), so that work needs a reviewer `PASS`. The checks that passed must be the project's current checks, and `--self` is refused for a project whose checks or risky globs you have not confirmed: changing them (with `add` or by editing `projects.json`) marks the project unconfirmed until you run `amigo confirm-gates <project>` in a terminal and type the confirmation (`gates.confirmed.json` holds a hash of what you confirmed). Human-approved closes are not affected. The commit is exactly the work the gates checked: if a file changes between the gate and the commit, or the branch's tree is not the checked work, nothing is committed. amigo's own commit and push run with git hooks switched off (`core.hooksPath` points at an empty folder it owns), because a squad member can edit the repo's hooks. `amigo policy` prints the policy and whether it is approved. `amigo approve-policy` stores a hash of the policy as it is now, and only from an interactive terminal after you type a confirmation; editing the file later switches self-approval off until you approve it again. Every self-approved close is appended to `~/.amigo/approvals.jsonl` (time, id, project, branch, sha, reasons, how to undo it), and `amigo undo <id>` deletes that branch again unless it was pushed, has an upstream, or moved since.

**Tasks that depend on each other.** `spawn --after <id>` (same project) keeps the new task queued until the other one is closed with a commit, then starts its worktree from that commit. If the other task is discarded, the new one becomes `blocked` with the reason.

**Issues and pull requests.** `spawn --project <p> --issue <n>` reads GitHub issue `n` with `gh issue view` and puts its title, link and text in front of the brief (its title becomes the task's title unless the brief has a `Title:` line). `close <id> --commit --pr` then, only when the approved policy's `"pr"` is not `"never"` (the starter has `"never"`; `--pr` refuses with no approved policy, and `--self --pr` needs `"also-self-approved"`), pushes branch `amigo/<id>` (never any other branch) to `origin` and opens a draft pull request with `gh pr create` against the repo's default branch, titled after the commit subject, with its summary and `Closes #n` when the task came from an issue. It refuses if there is no `origin` or no `gh`, or when the title cannot pass the Windows `gh.cmd` shim, before pushing anything. `--pr` refuses unless the task's starting commit is already on origin's default branch (as of the last fetch), so the pull request carries only the task's own work (for a task started with `--after`, that means the work it builds on must be merged first). Committing without `--pr` stays a local branch commit. The issue's title and text are put in the brief as quoted data from GitHub, not instructions.

**Status by station.** `amigo status` groups tasks into queued, building, verifying, in review, closing, waiting on you (finished turns awaiting a decision, blocked, question, failed) and done (the few most recently closed).

## Agents

`~/.amigo/config.json` holds one entry per agent. `amigo` starts the interactive session you talk to. `member` starts a squad member: Claude Code runs it as an interactive session (see below); other agents run one task and exit. `{prompt}` is replaced by the instructions. `install-skill` fills this in for you; edit it to change flags.

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
3. Run `amigo install-skill <your agent>` (claude, codex, gemini, antigravity or grok). For other agents, add an entry to `~/.amigo/config.json` from the table above. **Ask the user** whether the squad member permission flags are right for them; never switch to flags that skip all checks on your own.
4. **Ask the user** which project folders to add and whether any project has rules, then run `amigo add <path> [--notes "..."]` for each. Check: `amigo projects` lists them.
5. Check the template: `amigo spawn --project <name> --dry-run --brief-file README.md` must print a command, not an error.
6. Tell the user to type `/amigo` in a new session of their agent (or run `amigo` in a terminal). Do not start it yourself.

## How it works

- `~/.amigo/` holds `config.json`, `projects.json`, `notices.json` (background results waiting for your inbox), `scratch/<id>/`, `policy.json` (with `policy.approved.json`, `gates.confirmed.json` and `approvals.jsonl`, see above), `tasks/<id>/` (brief, prompt, task state, output log) and `worktrees/`.
- `/amigo` runs `amigo brief --agent <name>`, which prints amigo's instructions with the briefing and starts the briefing's background checks; the session you are in becomes amigo.
- Every squad member opens in a new tab of the terminal amigo runs in, found from the variables that terminal sets. A terminal with no way to open a tab from outside gets a new window instead. In herdr, a squad member with its own worktree gets a workspace of its own (named `<id> · <title>`) and any other squad member a tab in amigo's workspace; nothing is focused, and herdr closes the workspace with its last tab. On Windows the squad member's tab is a PowerShell pane (herdr's default shell); with another `default_shell` the squad member never starts and is reported as failed. Queued squad members that start later open in the same terminal. The tab closes by itself when the squad member ends, also after an error; the error stays in `amigo status`, `inbox` and `attach`.
- Squad members end each turn with `STATUS: done - ...`, `STATUS: blocked - ...` or `STATUS: question - ...`; that line is the result amigo sees in `amigo inbox` and `amigo wait`.
- **Claude Code squad members** are interactive sessions named `amigo-<id>` (you can type into them in their tab). Hooks (in `tasks/<id>/claude-settings.json`) record each turn's STATUS line. When amigo is Claude Code too, each squad member messages the session that spawned it (by its messaging address, so amigo can be named anything and renamed freely) with SendMessage when a turn ends, and amigo can message a squad member whose session is open. A turn that ends without a STATUS line, or without that message, is sent back once. `amigo send` resumes the squad member's session. Before a squad member starts, amigo marks its folder as trusted in `~/.claude.json` (so the session opens without the trust dialog) and removes that entry when the squad member's worktree is closed.
- **Other agents** run their `member` command once; the output stays in `tasks/<id>/output.log` (`amigo attach <id>` follows it). Without a STATUS line, the squad member is `done` if the agent exited cleanly, else `failed`. A follow-up runs it again with the brief, its last result and every follow-up.
- On Windows, agents installed by npm are `.cmd` files that only start through `cmd.exe`, which cannot carry a multi-line prompt. Those agents get one line instead: "Read the file <path> and follow the instructions in it exactly." The same happens for any prompt longer than 24,000 characters.

## Safety

- Squad members work without step-by-step approval, with exactly the permissions their template gives the agent. Start with the narrow ones.
- amigo marks only its own squad member folders as trusted in `~/.claude.json`, keeps every other field of that file, and removes the entry for a worktree it closes.
- Squad members cannot run amigo's managing commands (`spawn`, `send`, `close`, `add`, `note`, `undo`, `approve-policy`, `confirm-gates`, `install-skill`, `inbox`, `wait`, `brief`) or start a session (bare `amigo`); only amigo can.
- amigo commits only to `amigo/<id>` branches, and only when you close a task with `--commit`. The commit subject must read `type: imperative summary` or `type(scope): ...` (type one of feat, fix, refactor, docs, style, test, chore, perf, build, ci), at most 50 chars, with at most a one-line body and no co-author or "generated by" lines. It comes from `-m`, or else from the squad member's latest done report: a Claude Code squad member puts it in its own final message as the line right before its STATUS line (exactly `COMMIT: <subject>`, nothing around it), read by the stop hook; any other agent writes it to `tasks/<id>/commit-subject.txt` (the path is in its prompt), which amigo reads (its first line, within the first 512 bytes; UTF-8, or UTF-16 with a BOM) and deletes when the run ends. A run log is never read for it, since it can hold echoed input such as an issue. A done report without one clears the earlier subject, and a missing or invalid subject is refused before anything is touched. Any task commit already on the branch (one the squad member made itself) must follow the same rule, or close refuses before it commits, pushes or opens anything; the pull request is titled after the newest task commit on the branch, so after a checked commit. It refuses if the squad member moved its worktree to another branch. It also refuses when a changed file looks like it holds secrets (`.env`, private keys, credential files): delete it or add it to `.gitignore`, then close again. It never merges. It pushes only with `close --commit --pr` under an approved policy whose `pr` is not `never`, and then only the task's own `amigo/<id>` branch to `origin`. It deletes only an `amigo/<id>` branch that has no commits (and, for `undo`, a self-approved one that was never pushed).
- Self-approval is off until you approve the policy by typing in a terminal, and the code (not amigo) checks the policy hash, the confirmed gates, the checks, the risk and the review on every `--self`. The approval is a file on your disk, so an agent that can write anywhere in your home folder could forge it: keep squad members in permission modes that confine them to their worktree (the defaults in the table above do), and read `approvals.jsonl` now and then.
- Checks run code the squad member wrote (tests, scripts) with your own permissions, so a squad member's permission mode is not a sandbox. Run squad members only on projects whose code you would run yourself. If you need a real sandbox, run amigo inside OS-level isolation such as a container or a VM.
- `close` refuses to throw away a squad member's changes unless you add `--force`.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run the real CLI against a fake agent (`test/fake-agent.mjs`) and a fake GitHub CLI (`test/fake-gh.mjs`, found through `AMIGO_GH`, with a local bare repo as `origin`) in temporary folders, with squad member tabs replaced by detached processes (`AMIGO_TERMINAL=test`).

| Folder | What is in it |
|---|---|
| `src/` | The CLI: commands, agent launching, task state, git worktrees, skill files |
| `prompts/` | The instructions given to amigo (`amigo.md`) and to every squad member (`member.md`) |
| `test/` | Unit tests, end-to-end tests and the fake agent |
| `docs/` | Images for this README, and the plans (`docs/plans/`) |

## License

MIT
