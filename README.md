![octomaxxing: a buff octopus with a laptop, phone, coffee and a keyboard dumbbell in its arms. One head. Many arms.](docs/images/2026-11-17-banner.jpg)

# octomaxxing

One head, many arms. You talk to one coding agent, the **head**. It splits your requests into tasks and hands each one to an **arm**: another agent in its own tab and its own git worktree, working in parallel. Arms open as new tabs of whatever terminal you started the head in, so you can watch every arm and type into a Claude Code arm yourself. When an arm finishes, the head checks the work and asks you to accept it. Accepted work is committed to its own branch, never merged for you, and pushed only when you ask for a draft pull request.

Works with any agent CLI that takes a prompt on the command line (Claude Code, Codex, Gemini CLI, Antigravity, Grok, ...), on Linux, macOS and Windows. It is a small Node.js tool with no runtime dependencies.

Made by [essam](https://essam.pro).

```
you ──▶ head ──spawn──▶ arm 1 (worktree, branch octomaxxing/<id>)
         ▲  ◀──inbox──  arm 2
         │              arm 3 (queued until memory or its folder frees up)
         └── "fix-footer is done, 1 file changed. Commit it?"
```

## Install

You need Node.js 24.3 or newer, git, and an agent CLI that already works on your machine. Nothing to set up for the terminal: octomaxxing finds the one the head runs in and opens arm tabs there (a new window, if that terminal has no way to open a tab).

```sh
git clone https://github.com/mohamedessambarakat/octomaxxing
cd octomaxxing
npm install -g .
octomaxxing install-skill
```

- `npm install -g .` links the `octomaxxing` command to this folder, so keep the folder where it is (moving or deleting it breaks the command; `git pull` updates it). Installing straight from GitHub (`npm install -g github:...`) does not work: Node will not run TypeScript from inside `node_modules`.
- `octomaxxing install-skill` adds an `/octomaxxing` command to every supported agent CLI it finds, and adds that agent to your config. It prints every file it writes; `octomaxxing install-skill --remove` takes them out again.
- Everything octomaxxing stores lives in `~/.octomaxxing/` (set `OCTOMAXXING_HOME` to put it elsewhere).

## Add your projects

```sh
octomaxxing add ~/code/my-app
octomaxxing add ~/code/website --name site --notes "Never touch .env. Run npm test before reporting."
```

Notes are hard rules for every arm on that project (add one later with `octomaxxing note my-app "Use the v2 endpoint."`). A project can also carry **checks** (shell commands that must pass before work counts as done) and extra **risky paths** (see below):

```sh
octomaxxing add ~/code/my-app --check "npm test" --check "npm run lint" --risky "src/legacy/**"
```

Running `add` again with the same name and folder updates the project and keeps what you leave out; a repeated `--check` or `--risky` replaces the whole list, and `--check ""` clears it. In a git repository each arm gets its own worktree on a new branch `octomaxxing/<id>`, starting from the repo's current commit (uncommitted changes in your checkout are not included). Any other folder is worked on in place, by one arm at a time.

## Start working

In an agent session you already have open, type `/octomaxxing` (`$octomaxxing` in Codex). Or start a fresh head from any terminal:

```sh
octomaxxing head
```

The head greets you with what is free and what finished, then you just talk to it:

```
🐙 Tentacles warmed up.
2 projects · 0 arms running · inbox: empty

> fix the broken footer link in my-app, and add a dark mode toggle to site
```

It writes a brief with Done-when criteria for each task and starts each arm in a new tab. Each arm gets a short id: its number and a few words of its title, like `7-fix-footer`. Every command takes the number alone (`octomaxxing status 7`), and numbers are never reused. Ask it what is done whenever you like. When an arm finishes, the head checks the result and asks you to accept, telling you how many files changed. Bigger work first gets a separate reviewer arm, which checks the Done-when criteria and the blast radius: what the change could break outside its own diff, with the fact its safety rests on proven by running code or flagged as unproven. On your yes it runs `octomaxxing close <id> --commit`: the work is committed to branch `octomaxxing/<id>` and the worktree is removed. Merging and pushing stay with you.

The head reports in short plain prose: what happened, with real numbers, and what it holds up; then, only if something needs you, its recommendation and why, with the choices as options (clickable where the agent has a question tool, otherwise `A)`, `B)`, `C)`). It has a gym-bro streak, kept to its greeting and one tag line per reply, and drops it entirely for failures, security warnings and anything you have to approve.

Arms that need an answer stop and ask; the head brings the question to you and sends your answer back, and the arm carries on in the same folder. To type into a Claude Code arm yourself, switch to its tab.

You can use every command yourself too:

```
octomaxxing: one head agent, many arms.

  octomaxxing head [--agent <name>] [--dry-run]     start the head agent in this terminal
  octomaxxing install-skill [<agent>] [--remove]    add /octomaxxing to your agent CLIs (all found on PATH, or one)
  octomaxxing brief --agent <name>                  print the head instructions (what /octomaxxing runs)
  octomaxxing add <path> [--name <name>] [--notes <text>] [--check <cmd>]... [--risky <glob>]...
                                                    register a project folder; the same name and folder again updates it
  octomaxxing projects                              list registered projects
  octomaxxing note <project> <text>                 add a line to a project's notes (every later arm gets it)
  octomaxxing spawn (--project <name> | --review <id>) [--title <t>] [--agent <name>] [--after <id>] [--issue <n>] [--brief-file <file>] [--dry-run]
                                                    start an arm; the brief comes from stdin unless --brief-file is given
  octomaxxing status [<id>]                         tasks by station, or one in detail (checks, risk, changed files)
  octomaxxing inbox                                 arms that finished since you last looked
  octomaxxing wait [<id>...] [--timeout-min <n>]    wait until an arm finishes a turn (default 60 min)
  octomaxxing send <id> [--file <file> | <message>] follow-up for a finished arm (message from stdin if neither is given)
  octomaxxing attach <id>                           print an arm's results and follow it while it runs
  octomaxxing close <id> [--commit [-m <message>] [--pr] [--self]] [--force]
                                                    finish an arm: --commit keeps its work on branch octomaxxing/<id>; --pr needs an approved policy whose pr is not never
  octomaxxing policy                                show the self-approval policy and whether it is approved
  octomaxxing approve-policy                        approve the policy as it is now (needs a terminal and your typed yes)
  octomaxxing confirm-gates <project>               confirm a project's checks and risky paths as they are now, so --self may rely on them (terminal + typed yes)
  octomaxxing undo <id>                             take back a self-approved commit: delete its branch (never a pushed one)
  octomaxxing help                                  this text

Data lives in $OCTOMAXXING_HOME (default ~/.octomaxxing).
```

## Checks, review and delivery

octomaxxing runs these gates in its own code, so they work with every agent CLI and the agent cannot talk its way past them.

**Checks.** When an arm says `STATUS: done`, octomaxxing (not the head, not the agent) runs each of the project's checks in the arm's folder, through the shell, each with a time limit (10 minutes; `"checkTimeoutMin"` in `config.json`). The task shows as `verifying` meanwhile. If a check fails, the arm gets a follow-up with the failing command and the tail of its output, fixes it and reports again: a Claude Code arm is sent back inside the same session by its Stop hook, any other agent is run again with the follow-up. After two automatic retries the task becomes `blocked` and its summary names the failing check. A project without checks shows its finished tasks as `unverified`. A follow-up from the head resets the retry count. Reviewer arms are not checked.

**Risk and review.** `octomaxxing status <id>` shows the risk of an arm's work, measured against the commit its worktree started from (files, lines added and removed, deleted files, risky paths):

- `small`: at most 3 files and 100 lines, no deletions, no risky path.
- `needs-you`: any deletion or any risky path, however small. Risky paths are auth and auth-like names (`session`, `jwt`, `token`, `oauth`, `login`, `permission`, `middleware`), payments, billing and checkout, database migrations, `.env` and other secret or credential files, dependency manifests and lockfiles (`package.json`, `package-lock.json`, `yarn.lock`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile*`, `composer.*`, `.npmrc` and the like), production config (`config/production*`, `*.prod.*`), deploy and CI config (`.github/workflows`, `Dockerfile`, `vercel.json`, `fly.toml`, terraform, k8s), git hook and tooling folders (`.husky`, `.githooks`, `.git-hooks`, `lefthook*`, `.pre-commit-config.yaml`), the files the checks run (`Makefile`, `justfile`, `scripts`, `jest`, `vitest`, `playwright`, `karma`, `eslint` and `prettier` config, `tsconfig*.json`, `biome.json*`), the public API surface (`api`, `routes`, `openapi`, `.proto`), and the project's own `--risky` globs. A glob without a `/` matches a file or folder name anywhere (`migrations`, `*.sql`); with a `/` it matches from the repo root; `**` crosses folders.
- `non-trivial`: everything else. A binary file, a submodule change or a file mode change is never `small`, whatever its line count says.

Anything but `small` makes `close --commit` refuse until a reviewer arm for that task (`spawn --review <id>`) has finished with a `PASS` verdict; there is no override. The task's work is recorded when the reviewer starts, and the `PASS` counts only if the work is unchanged when the reviewer finishes and when you close, so changing the work needs a new review. `send` refuses while a reviewer is open on the task (close it first). A `FAIL` on some work is final for that exact work: a later `PASS` on the same work does not count, so it must change first.

**Self-approval.** `~/.octomaxxing/policy.json` (a starter is created on first run, inactive) says what an agent may approve without asking you. The starter allows `close --commit --self` only for low-risk work: a git repo, checks configured and all passed on exactly this work, risk `small`, and either only docs and tests changed or a reviewer `PASS` on exactly this work. Its `"pr"` field says who may open pull requests: `"never"` (the starter), `"after-human-yes"` (`close --pr` after your yes) or `"also-self-approved"` (also `close --self --pr`). There is nothing for merging. Docs-only does not cover agent instruction files (`CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `prompts/`, `.claude/`, `.github/`), and a test file that loses an existing line is not "only tests" (additions are fine), so that work needs a reviewer `PASS`. The checks that passed must be the project's current checks, and `--self` is refused for a project whose checks or risky globs you have not confirmed: changing them (with `add` or by editing `projects.json`) marks the project unconfirmed until you run `octomaxxing confirm-gates <project>` in a terminal and type the confirmation (`gates.confirmed.json` holds a hash of what you confirmed). Human-approved closes are not affected. The commit is exactly the work the gates checked: if a file changes between the gate and the commit, or the branch's tree is not the checked work, nothing is committed. octomaxxing's own commit and push run with git hooks switched off (`core.hooksPath` points at an empty folder it owns), because an arm can edit the repo's hooks. `octomaxxing policy` prints the policy and whether it is approved. `octomaxxing approve-policy` stores a hash of the policy as it is now, and only from an interactive terminal after you type a confirmation; editing the file later switches self-approval off until you approve it again. Every self-approved close is appended to `~/.octomaxxing/approvals.jsonl` (time, id, project, branch, sha, reasons, how to undo it), and `octomaxxing undo <id>` deletes that branch again unless it was pushed, has an upstream, or moved since.

**Tasks that depend on each other.** `spawn --after <id>` (same project) keeps the new task queued until the other one is closed with a commit, then starts its worktree from that commit. If the other task is discarded, the new one becomes `blocked` with the reason.

**Issues and pull requests.** `spawn --project <p> --issue <n>` reads GitHub issue `n` with `gh issue view` and puts its title, link and text in front of the brief (its title becomes the task's title unless the brief has a `Title:` line). `close <id> --commit --pr` then, only when the approved policy's `"pr"` is not `"never"` (the starter has `"never"`; `--pr` refuses with no approved policy, and `--self --pr` needs `"also-self-approved"`), pushes branch `octomaxxing/<id>` (never any other branch) to `origin` and opens a draft pull request with `gh pr create` against the repo's default branch, titled after the task, with its summary and `Closes #n` when the task came from an issue. It refuses if there is no `origin` or no `gh`, or when the title cannot pass the Windows `gh.cmd` shim, before pushing anything. `--pr` refuses unless the task's starting commit is already on origin's default branch (as of the last fetch), so the pull request carries only the task's own work (for a task started with `--after`, that means the work it builds on must be merged first). Committing without `--pr` stays a local branch commit. The issue's title and text are put in the brief as quoted data from GitHub, not instructions.

**Status by station.** `octomaxxing status` groups tasks into queued, building, verifying, in review, closing, waiting on you (finished turns awaiting a decision, blocked, question, failed) and done (the few most recently closed).

## Agents

`~/.octomaxxing/config.json` holds one entry per agent. `head` starts an interactive session. `arm` starts an arm: Claude Code runs it as an interactive session (see below); other agents run one task and exit. `{prompt}` is replaced by the instructions. `install-skill` fills this in for you; edit it to change flags.

```json
{
  "agents": {
    "claude": {
      "head": ["claude", "{prompt}"],
      "arm": ["claude", "--permission-mode", "auto", "{prompt}"]
    }
  },
  "armMb": 600,
  "reserveMb": 2048
}
```

| Agent | Slash command | `head` | `arm` |
|---|---|---|---|
| Claude Code | `/octomaxxing` | `["claude", "{prompt}"]` | `["claude", "--permission-mode", "auto", "{prompt}"]` |
| Codex | `$octomaxxing` | `["codex", "{prompt}"]` | `["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{prompt}"]` |
| Gemini CLI | `/octomaxxing` | `["gemini", "-i", "{prompt}"]` | `["gemini", "--approval-mode", "auto_edit", "-p", "{prompt}"]` |
| Antigravity | `/octomaxxing` | `["agy", "-i", "{prompt}"]` | `["agy", "-p", "{prompt}"]` |
| Grok | `/octomaxxing` | none | `["grok", "-p", "--always-approve", "{prompt}"]` |

Flags come from each tool's documentation; check them against your installed version.

- **Permissions are yours to choose.** Arms work without anyone approving each step, so an arm can only do what its flags allow, and whatever you allow applies to every arm.
  - Claude Code's `auto` mode lets a classifier approve safe actions, such as edits and running tests, and blocks risky ones.
  - Codex works in a sandbox limited to the arm's folder.
  - Gemini CLI approves edits only.
  - Grok's `--always-approve` approves everything except what your Grok deny rules forbid.
  - Antigravity documents no headless approval flag, so its arms may stop and ask.
  - Every agent also has a flag that skips all checks (for example `--dangerously-skip-permissions` for Claude Code). Its docs recommend that only inside a container or VM.
- An agent without `head` (Grok) can still be the head through its slash command.
- Arms use the same agent as the head unless the head picks another one for a task (`--agent`). `octomaxxing head` uses `"defaultAgent"`, or the first agent listed.
- An arm starts only while free memory, minus `armMb` (what one arm needs, in MB), stays at or above `reserveMb`. Other tasks wait in a queue and start by themselves as memory frees up. Only one arm runs in a folder at a time.

Check a template without running anything: `octomaxxing spawn --project <name> --dry-run --brief-file README.md` prints the exact command.

## Install with an AI agent

Give your agent the link to this repository and ask it to set up octomaxxing. Agent, do these steps in order:

1. Check `node --version` (24.3 or newer) and `git --version`. If one is missing, stop and tell the user.
2. Clone the repository into a folder the user will keep, and run `npm install -g .` inside it. Check: `octomaxxing help` prints the command list.
3. Run `octomaxxing install-skill <your agent>` (claude, codex, gemini, antigravity or grok). For other agents, add an entry to `~/.octomaxxing/config.json` from the table above. **Ask the user** whether the arm permission flags are right for them; never switch to flags that skip all checks on your own.
4. **Ask the user** which project folders to add and whether any project has rules, then run `octomaxxing add <path> [--notes "..."]` for each. Check: `octomaxxing projects` lists them.
5. Check the template: `octomaxxing spawn --project <name> --dry-run --brief-file README.md` must print a command, not an error.
6. Tell the user to type `/octomaxxing` in a new session of their agent (or run `octomaxxing head` in a terminal). Do not start it yourself.

## How it works

- `~/.octomaxxing/` holds `config.json`, `projects.json`, `policy.json` (with `policy.approved.json`, `gates.confirmed.json` and `approvals.jsonl`, see above), `tasks/<id>/` (brief, prompt, task state, output log) and `worktrees/`.
- `/octomaxxing` runs `octomaxxing brief --agent <name>`, which prints the head's instructions with a live greeting; the session you are in becomes the head.
- Every arm opens in a new tab of the terminal the head runs in, found from the variables that terminal sets. A terminal with no way to open a tab from outside gets a new window instead. In herdr, an arm with its own worktree gets a workspace of its own (named `<id> · <title>`) and any other arm a tab in the head's workspace; nothing is focused, and herdr closes the workspace with its last tab. On Windows the arm's tab is a PowerShell pane (herdr's default shell); with another `default_shell` the arm never starts and is reported as failed. Queued arms that start later open in the same terminal. The tab closes by itself when the arm ends, also after an error; the error stays in `octomaxxing status`, `inbox` and `attach`.
- Arms end each turn with `STATUS: done - ...`, `STATUS: blocked - ...` or `STATUS: question - ...`; that line is the result the head sees in `octomaxxing inbox` and `octomaxxing wait`.
- **Claude Code arms** are interactive sessions named `octomaxxing-<id>` (you can type into them in their tab). Hooks (in `tasks/<id>/claude-settings.json`) record each turn's STATUS line. When the head is Claude Code too, each arm messages the session that spawned it (by its messaging address, so the head can be named anything and renamed freely) with SendMessage when a turn ends, and the head can message an arm whose session is open. A turn that ends without a STATUS line, or without that message, is sent back once. `octomaxxing send` resumes the arm's session. Before an arm starts, octomaxxing marks its folder as trusted in `~/.claude.json` (so the session opens without the trust dialog) and removes that entry when the arm's worktree is closed.
- **Other agents** run their `arm` command once; the output stays in `tasks/<id>/output.log` (`octomaxxing attach <id>` follows it). Without a STATUS line, the arm is `done` if the agent exited cleanly, else `failed`. A follow-up runs it again with the brief, its last result and every follow-up.
- On Windows, agents installed by npm are `.cmd` files that only start through `cmd.exe`, which cannot carry a multi-line prompt. Those agents get one line instead: "Read the file <path> and follow the instructions in it exactly." The same happens for any prompt longer than 24,000 characters.

## Safety

- Arms work without step-by-step approval, with exactly the permissions their template gives the agent. Start with the narrow ones.
- octomaxxing marks only its own arm folders as trusted in `~/.claude.json`, keeps every other field of that file, and removes the entry for a worktree it closes.
- Arms cannot run octomaxxing's managing commands (`spawn`, `send`, `close`, `add`, `note`, `undo`, `approve-policy`, `confirm-gates`, `install-skill`); only the head can.
- octomaxxing commits only to `octomaxxing/<id>` branches, and only when you close a task with `--commit`. It refuses if the arm moved its worktree to another branch. It also refuses when a changed file looks like it holds secrets (`.env`, private keys, credential files): delete it or add it to `.gitignore`, then close again. It never merges. It pushes only with `close --commit --pr` under an approved policy whose `pr` is not `never`, and then only the task's own `octomaxxing/<id>` branch to `origin`. It deletes only an `octomaxxing/<id>` branch that has no commits (and, for `undo`, a self-approved one that was never pushed).
- Self-approval is off until you approve the policy by typing in a terminal, and the code (not the head) checks the policy hash, the confirmed gates, the checks, the risk and the review on every `--self`. The approval is a file on your disk, so an agent that can write anywhere in your home folder could forge it: keep arms in permission modes that confine them to their worktree (the defaults in the table above do), and read `approvals.jsonl` now and then.
- Checks run code the arm wrote (tests, scripts) with your own permissions, so an arm's permission mode is not a sandbox. Run arms only on projects whose code you would run yourself. If you need a real sandbox, run octomaxxing inside OS-level isolation such as a container or a VM.
- `close` refuses to throw away an arm's changes unless you add `--force`.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run the real CLI against a fake agent (`test/fake-agent.mjs`) and a fake GitHub CLI (`test/fake-gh.mjs`, found through `OCTOMAXXING_GH`, with a local bare repo as `origin`) in temporary folders, with arm tabs replaced by detached processes (`OCTOMAXXING_TERMINAL=test`).

| Folder | What is in it |
|---|---|
| `src/` | The CLI: commands, agent launching, task state, git worktrees, skill files |
| `prompts/` | The instructions given to the head (`head.md`) and to every arm (`arm.md`) |
| `test/` | Unit tests, end-to-end tests and the fake agent |
| `docs/` | Images for this README |

## License

MIT
