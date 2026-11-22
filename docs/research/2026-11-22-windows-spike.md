## Windows spike (plan step 0) - Done, all four tools PASS natively on Windows 11

I made no edits in D:/Projects/Personal/amigo-port. All scratch work is in D:/Projects/Personal/amigo-wt/spike/. The parent should copy this report into `docs/research/2026-11-22-windows-spike.md`.

**Deviations and side effects, read first**
- `no-mistakes init` silently installed a user-level skill at `~/.claude/skills/no-mistakes/` and created `~/.agents/skills/no-mistakes/`. Both were new, so this counted as an unapproved global change. I removed them right away, including the empty `~/.agents/skills`. **amigo must expect this side effect when it runs `no-mistakes init` for a project.** Decide whether the user wants that skill.
- The treehouse installer appended `%LOCALAPPDATA%\treehouse` to the user PATH. That is part of the approved install. Shells that are already open do not see it, so amigo should fall back to the full path. treehouse also wrote `~/.treehouse/update-check.json`, which is tool state.
- The installed no-mistakes is v1.84.0, which meets the v1.46.0 floor. v1.106.1 is available, but I did not update: `no-mistakes update` resets the daemon, which touches the user's real setup.
- Not mine to fix, but worth knowing: the user's real `~/.no-mistakes` daemon is not running (`daemon status`: "process 23016 is no longer running").
- The one real agent run cost a few Claude turns: claude in an hc tab answering "ok" and "two", and one mkdir. The no-mistakes pipeline used claude for its review, test and document steps, 3 runs of about 1 minute each.

---

### 1. no-mistakes - PASS
- Version: `no-mistakes version v1.84.0 (4822244)`. The floor is 1.46.0 (`docs/configuration.md` line 2359).
- Isolation: `NM_HOME=D:/.../spike/nmhome`. The user's real ~/.no-mistakes was not touched.
- Setup: a local repo `spike/work` with origin = a local bare repo `spike/origin.git`.
- `no-mistakes init`: 2.3 s, exit 0. It added the `no-mistakes` remote pointing at `nmhome/repos/<id>.git` and started the daemon (pid recorded). `doctor` shows every check green and "gate validation claude is runnable".
- `no-mistakes axi run --intent "..." --wait 8m --yes`: 58 s, exit 0.
  - Steps: intent, rebase, review (11 s), test (27 s), document (12 s), lint, push all completed.
  - pr and ci were skipped: "provider unknown is not supported yet", which is expected for a local remote.
  - `outcome: passed-with-skips`. The commit reached `origin.git`.
- A plain `git push no-mistakes spike/sub` took 1.5 s and printed "Pipeline started" (the post-receive hook works). `axi run --wait 8m --yes` then reattached and completed in 54 s.
- Gate path:
  - I committed a buggy `div` (`a + b`) and ran `axi run` without `--yes`. In 23 s it returned a `gate:` with step review, status `awaiting_approval`, and finding `div-returns-sum` (ask-user).
  - `axi respond --action fix --findings div-returns-sum --yes`: 68 s, completed. The pipeline pushed commit `no-mistakes(review): fix: make div return a divided by b`.
  - `axi sync` then brought the local branch to the pipeline head (`state: synchronized`).
- `axi status` took 1.2 s and `runs` took 0.1 s.
- Daemon lifecycle (all exit 0, all under 1.3 s): stop 0.8 s, status 0.4 s, start 1.1 s, restart 1.3 s.
  - No Windows service, scheduled task, Run key or Startup entry was created. The daemon runs as `no-mistakes.exe daemon run --root <NM_HOME>` plus a `daemon log-sink` process.
- Issue #1749, the Windows daemon hang, did not reproduce. That issue is on v1.37.0 with 13 parked legacy runs blocking the update. On v1.84.0 with a fresh home there were no hangs.
- Cleanup: spike daemon stopped.

### 2. treehouse - PASS
- Installer: I read `install.ps1` first. It downloads a release zip from GitHub, puts the exe in `%LOCALAPPDATA%\treehouse` and appends that folder to the user PATH. Then I ran it with `-File`. Version `v3.1.8`.
- Isolation: `TREEHOUSE_ROOT=D:/.../spike/th-pool`.
- `treehouse get --lease --lease-holder spike-1`: 0.5 s. stdout is only the absolute path; banners go to stderr.
- `get --lease --lease-holder spike-2 --json -b amigo/spike-2` printed `{"path","lease_id","lease_holder","leased_at","base_branch"}`.
- `treehouse status`:
  - The text form shows `leased ... (held by spike-1)`.
  - `status --json` returns an array of `{name, path, status, branch, detached, lease_id, lease_holder, leased_at, processes[]}`.
  - The status listing reported a hidden powershell process (Start-Sleep) running inside the worktree on Windows: `powershell.exe (79796)`.
- Return:
  - `treehouse return <path>` on a dirty worktree refused in 0.1 s: "stdin reached EOF ... use --force". It does not hang.
  - `return --force` printed "Terminated lingering processes: powershell.exe (79796)" and "Worktree returned to pool".
- A later `get --lease` reused pool slot 1, so pooling works.
- `treehouse lease 2 --lease-holder spike-4` leased an existing slot in place.
- Final state: both slots `available`.

### 3. tasks-axi - PASS
- Install: `npm install -g tasks-axi` gave 0.2.6, MIT, no install scripts. firstmate's floor is `FM_TASKS_AXI_MIN=0.2.6`.
- firstmate's capability probes both pass: `update --help` mentions `--archive-body`, and `mv --help` shows `[<id>...]`.
- Commands, all on a throwaway file `spike/backlog/backlog.md` with `--file <path>`:
  - `add spike-a1 "..." --kind ship --repo work`
  - `add spike-b2 "..." --blocked-by spike-a1`
  - `add "minted note" --mint --json`, which gave id `minted-note-fe`
  - `list` (TOON output)
  - `start spike-a1`, which moved it to In flight
  - `hold spike-b2 --reason "Boss decision pending" --kind captain --until 2026-12-31`
  - `list --state held --fields hold_kind,hold_reason,hold_until`
  - `mv spike-a1 spike-b2 --to other/backlog.md` (atomic; the blocked-by link was preserved)
  - `unhold`
  - `done spike-a1 --pr https://github.com/example/spike/pull/1`
  - `ready`, which listed spike-b2 as ready once its blocker was done
- Every call exited 0 and took well under 1 s. The file is plain markdown with LF endings and `## In flight / ## Queued / ## Done` sections.
- Caveats:
  - `done --pr` rejects any URL that is not a canonical GitHub or Forgejo PR URL.
  - The hold kind vocabulary is fixed at `captain|external|load|parked|future`, so the "Boss hold" label must map to `--kind captain` internally.
  - I did not run `tasks-axi setup hooks`.

### 4. hc / herdr-app - PASS, with two notable caveats
- Versions: `hc 0.1.21` and `herdr-app 0.1.16`. firstmate's floor is herdr-core 0.1.14 at protocol generation 1.
- This shell runs inside herdr-app terminal t1w (`HC_TERMINAL_ID=t1w`, `HC_TERMINAL_SOCKET=\\.\pipe\herdr-core-essam-default.sock`, `TERM_PROGRAM=ghostty`). The default core and the app window were reachable.
- Read-only checks: `hc server status --json` and `hc ls --json` (each entry has address, agent, cwd, state, status, turn, where). `herdr-app ls`, `herdr-app status` and `herdr-app commands` also work.
- Opening a tab: `herdr-app do space.new --name spike-probe --tab spike-probe --folder <dir> --focus false` returned `{"space","tab","terminal":"t27"}`. `herdr-app status` confirmed the user's focused space and tab were unchanged.
- Listing: `hc ls --json --label herdr.space=<id>` filtered to t27.
- `hc get --json t27` returns these fields:
  - `state`: live or finished
  - `status`: null, or `{app, state, msg?}`
  - `turn`
  - `foreground{name, pid, argv, cwd}`
  - `labels`, including `herdr.space`, `herdr.tab` and `where`
  - `exit_code`, `reason`, `finished_ms`
- Sending text: `hc send --json t27 'echo SPIKE_MARKER_42'` worked, and `hc read --lines 5 t27` showed the marker.
- Real agent run: I sent `claude "Reply with the single word ok..."` into the tab.
  - Status moved `{"app":"claude-code","state":"working"}` - `done`, and `turn` went 0 - 1.
  - In `herdr-app ls` the terminal status reads `idle` or `working`.
- Guards and waits:
  - `hc send --if working` against a done terminal returned `{"error":{"kind":"status_mismatch",...,"hint":"nothing was typed"}}` with exit 10.
  - `hc send --wait --timeout 45` returned `{"started":true,...,"wait":{"ended":true,"reason":"status","status":"done","turn":2}}` in 2.6 s.
  - `hc wait --json --timeout 10 t27` returned at once when the terminal was already settled.
- I could not provoke a blocked state: the permission prompt did not appear, because the user's settings auto-allow. firstmate documents exit 9 for a send to a blocked terminal; that is not verified here.
- **Caveat A: hc wraps sends from inside an hc terminal.** When the caller has `HC_TERMINAL_ID` set, hc delivers the text as `<hc from="t1w">...</hc>`. Claude then treats `/exit` as plain message text, not a command.
  - Running `env -u HC_TERMINAL_ID -u HC_SCOPE hc send ...` delivered the text raw, and `/exit` worked.
  - amigo itself runs inside an hc terminal, so it must drop those two variables when it types into a crew member's pane. The alternative is `notes = false` in `~/.config/herdr-core/config.toml`, which is global; I did not change it.
  - Also, Git Bash rewrites a `/exit` argument into a Windows path. That only affects shell tests, not Node `spawn`.
- **Caveat B: hc status goes stale after an agent crash.** After `taskkill /F` of claude.exe, `status` stayed `{"app":"claude-code","state":"idle"}` 13+ s later, while `foreground.name` had become `powershell.exe`.
  - Liveness must come from the foreground process, as firstmate's `fm_backend_hc_agent_state` does: agent alive, shell dead.
  - After a clean `/exit`, `status` became null and the foreground was powershell.
- Closing: `herdr-app do tab.close --id <tab> --confirmed true` returned `{"ok":true}`.
  - The terminal went to `state: finished`, `reason: killed`. The space disappeared from `herdr-app ls`, and focus never moved.
  - `hc rm --json t27` returned `{"removed":"t27"}`. After that, `hc get t27` printed `{"error":{"kind":"not_found",...}}` with **exit 3**, matching firstmate.
- firstmate's create path, run in an isolated `HC_SESSION=amigospike` core:
  - `hc run --bg --json --no-parent --outlive-parent --no-notify --cwd <dir> --label amigo.task=spike-1 --label amigo.home=spike` returned `{"address":"t1",...}`.
  - `ls --label` filtered correctly. `kill`, then `rm`, then `get` gave exit 3.
  - Terminals without `herdr.space` labels stay invisible in the app.
  - `hc server status` on a session that is not running returns an `unavailable` error without starting a core. Any other hc command does start that session's core: a stray `hc ls` restarted it, so I stopped it again.
- Hello handshake: `hc connect` answers `{"jsonrpc":"2.0","method":"hello","params":{"generation":1},"id":1}` with `"generation":1` **only while stdin stays open**. With `printf | hc connect` it printed nothing, so firstmate's piped hello returns empty on Windows. amigo should keep stdin open until it reads the reply, or use `hc server status --json` plus `hc --version` instead.
- Socket: on Windows it is a named pipe `\\.\pipe\herdr-core-<user>-<session>.sock`, not firstmate's unix path under `~/.local/state`.
- Cleanup: the test space was closed, the t27 record removed, and the spike core stopped. The user's default core processes (pids 49736, 64324 and 63228, started 2:11 PM) were untouched, and their terminals t1 and t1w were never sent anything.

### Verdict
| Tool | Version | Result |
|---|---|---|
| no-mistakes | v1.84.0 | PASS |
| treehouse | v3.1.8 | PASS |
| tasks-axi | 0.2.6 | PASS |
| hc / herdr-app | 0.1.21 / 0.1.16 | PASS, with caveats A and B |

No tool needs a "re-implement in TS" task.

Spike artifacts are in D:/Projects/Personal/amigo-wt/spike/: `work/`, `origin.git/`, `nmhome/` (daemon stopped), `th-pool/` (all slots available), `backlog/`, `dl/th-install.ps1` and `space.json`. You can delete the whole folder.
