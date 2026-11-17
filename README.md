# octomaxxing

One head, many arms. You talk to one coding agent, the **head**. It splits your requests into tasks and hands each one to an **arm**: another agent running in the background, in its own git worktree, in parallel. When an arm finishes, the head checks the work and asks you to accept it. Accepted work is committed to its own branch, never merged or pushed for you.

Works with any agent CLI that takes a prompt on the command line (Claude Code, Codex, Gemini CLI, Antigravity, Grok, ...), on Linux, macOS and Windows. It is a small Node.js tool with no runtime dependencies.

Made by [Essam](https://essam.pro).

```
you ──▶ head ──spawn──▶ arm 1 (worktree, branch octomaxxing/<id>)
         ▲  ◀──inbox──  arm 2
         │              arm 3 (queued until an arm is free)
         └── "fix-footer is done, 1 file changed. Commit it?"
```

## Install

You need Node.js 24.3 or newer, git, and an agent CLI that already works on your machine.

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

Notes are hard rules for every arm on that project. In a git repository each arm gets its own worktree on a new branch `octomaxxing/<id>`, starting from the repo's current commit (uncommitted changes in your checkout are not included). Any other folder is worked on in place, by one arm at a time.

## Start working

In an agent session you already have open, type `/octomaxxing` (`$octomaxxing` in Codex). Or start a fresh head from any terminal:

```sh
octomaxxing head
```

The head greets you with what is free and what finished, then you just talk to it:

```
🐙 Tentacles warmed up.
2 projects · 2/2 arms free · inbox: empty

> fix the broken footer link in my-app, and add a dark mode toggle to site
```

It writes a brief with Done-when criteria for each task and starts the arms. Ask it what is done whenever you like. When an arm finishes, the head checks the result (bigger work gets a separate reviewer arm), shows you the changed files and asks you to accept. On your yes it runs `octomaxxing close <id> --commit`: the work is committed to branch `octomaxxing/<id>` and the worktree is removed. Merging and pushing stay with you.

Arms that need an answer stop and ask; the head brings the question to you and sends your answer back (`octomaxxing send`), and the arm runs again in the same folder.

You can use every command yourself too:

```
octomaxxing: one head agent, many arms.

  octomaxxing head [--agent <name>] [--dry-run]     start the head agent in this terminal
  octomaxxing install-skill [<agent>] [--remove]    add /octomaxxing to your agent CLIs (all found on PATH, or one)
  octomaxxing brief --agent <name>                  print the head instructions (what /octomaxxing runs)
  octomaxxing add <path> [--name <name>] [--notes <text>]
                                                    register a project folder
  octomaxxing projects                              list registered projects
  octomaxxing spawn (--project <name> | --review <id>) [--title <t>] [--agent <name>] [--brief-file <file>] [--dry-run]
                                                    start an arm; the brief comes from stdin unless --brief-file is given
  octomaxxing status [<id>]                         all open arms, or one in detail (with its changed files)
  octomaxxing inbox                                 arms that finished since you last looked
  octomaxxing send <id> [--file <file> | <message>] follow-up for a finished arm (message from stdin if neither is given)
  octomaxxing attach <id>                           print an arm's output and follow it while it runs
  octomaxxing close <id> [--commit [-m <message>]] [--force]
                                                    finish an arm: --commit keeps its work on branch octomaxxing/<id>
  octomaxxing help                                  this text

Data lives in $OCTOMAXXING_HOME (default ~/.octomaxxing).
```

## Agents

`~/.octomaxxing/config.json` holds one entry per agent. `head` starts an interactive session; `arm` runs one task and exits. `{prompt}` is replaced by the instructions. `install-skill` fills this in for you; edit it to change flags.

```json
{
  "agents": {
    "claude": {
      "head": ["claude", "{prompt}"],
      "arm": ["claude", "-p", "--permission-mode", "auto", "{prompt}"]
    }
  },
  "maxArms": 2
}
```

| Agent | Slash command | `head` | `arm` |
|---|---|---|---|
| Claude Code | `/octomaxxing` | `["claude", "{prompt}"]` | `["claude", "-p", "--permission-mode", "auto", "{prompt}"]` |
| Codex | `$octomaxxing` | `["codex", "{prompt}"]` | `["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{prompt}"]` |
| Gemini CLI | `/octomaxxing` | `["gemini", "-i", "{prompt}"]` | `["gemini", "--approval-mode", "auto_edit", "-p", "{prompt}"]` |
| Antigravity | `/octomaxxing` | `["agy", "-i", "{prompt}"]` | `["agy", "-p", "{prompt}"]` |
| Grok | `/octomaxxing` | none | `["grok", "-p", "--always-approve", "{prompt}"]` |

Flags come from each tool's documentation; check them against your installed version.

- **Permissions are yours to choose.** An arm runs without anyone watching, so it can only do what its flags allow, and whatever you allow applies to every arm.
  - Claude Code's `auto` mode lets a classifier approve safe actions, such as edits and running tests, and blocks risky ones.
  - Codex works in a sandbox limited to the arm's folder.
  - Gemini CLI approves edits only.
  - Grok's `--always-approve` approves everything except what your Grok deny rules forbid.
  - Antigravity documents no headless approval flag, so its arms may stop and ask.
  - Every agent also has a flag that skips all checks (for example `--dangerously-skip-permissions` for Claude Code). Its docs recommend that only inside a container or VM.
- An agent without `head` (Grok) can still be the head through its slash command.
- Arms use the same agent as the head unless the head picks another one for a task (`--agent`). `octomaxxing head` uses `"defaultAgent"`, or the first agent listed.
- `maxArms` is how many arms run at once. More tasks wait in a queue and start by themselves.

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

- `~/.octomaxxing/` holds `config.json`, `projects.json`, `tasks/<id>/` (brief, prompt, task state, output log) and `worktrees/`.
- `/octomaxxing` runs `octomaxxing brief --agent <name>`, which prints the head's instructions with a live greeting; the session you are in becomes the head.
- An arm runs in a detached background process that starts the agent's `arm` command and writes its output to `tasks/<id>/output.log` (`octomaxxing attach <id>` follows it). Arms end their last message with `STATUS: done - ...`, `STATUS: blocked - ...` or `STATUS: question - ...`; that line is the result the head sees in `octomaxxing inbox`. An arm without that line is `done` if the agent exited cleanly, else `failed`.
- On Windows, agents installed by npm are `.cmd` files that only start through `cmd.exe`, which cannot carry a multi-line prompt. Those agents get one line instead: "Read the file <path> and follow the instructions in it exactly." The same happens for any prompt longer than 24,000 characters.

## Safety

- Arms work unattended, with exactly the permissions their template gives the agent. Start with the narrow ones.
- Arms cannot run octomaxxing's managing commands (`spawn`, `send`, `close`, `add`, `install-skill`); only the head can.
- octomaxxing commits only to `octomaxxing/<id>` branches, and only when you close a task with `--commit`. It refuses if the arm moved its worktree to another branch. It never merges or pushes, and it deletes only an `octomaxxing/<id>` branch that has no commits.
- `close` refuses to throw away an arm's changes unless you add `--force`.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run the real CLI against a fake agent (`test/fake-agent.mjs`) in temporary folders.

| Folder | What is in it |
|---|---|
| `src/` | The CLI: commands, agent launching, task state, git worktrees, skill files |
| `prompts/` | The instructions given to the head (`head.md`) and to every arm (`arm.md`) |
| `test/` | Unit tests, end-to-end tests and the fake agent |

## License

MIT
