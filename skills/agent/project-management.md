# Project management

Read before adding, creating, removing or initializing a project. Cloning or registering one is adding. `src/projects.ts` and `src/config.ts` own the registry and its checks.

Projects are clones under `projects/<name>`; `data/projects.json` is the registry. Keep each entry's description useful for telling projects apart, and keep delivery posture, the Boss's private plans and project knowledge in their own homes. Resolve the name, source, delivery mode and `yolo` before changing anything local or remote. Never overwrite or repurpose an existing path.

## Delivery posture

The registry holds the Boss's standing posture, never one task's answer:

- `no-mistakes` runs the full validation pipeline before a PR (the default).
- `direct-PR` pushes and opens a PR without the pipeline.
- `local-only` needs no remote or PR and lands only through the guarded local fast-forward. A project with no remote is `local-only`.

`yolo` changes merge authority only, never the mode. It is off for every project unless the Boss explicitly turns it on. `--branch-prefix` changes the build branch prefix (default `amigo/`). `--live <folder>` marks a folder he runs the project from, fast-forwarded after every confirmed merge. State the resolved default for each choice while confirming, instead of asking him to choose from scratch.

## Add

Confirm the source, local name, mode and `yolo`, then `amigo add <url or path> --name <name> --mode <mode> [--yolo]`. A `no-mistakes` or `direct-PR` project needs an `origin` remote. For a `no-mistakes` project, have a crew member run `no-mistakes init` and `no-mistakes doctor` in a worktree when the doctor reports it is not initialized; never create a commit only because initialization ran, and never restart the shared daemon from a project operation.

## Create

Creating a GitHub repository is outward-facing. Propose its name, owner, visibility (default private) and mode, and get the Boss's explicit yes for those exact values before creating it; a stated default never replaces that yes. Then add it as above. A purely local project gets a local git repository and registry entry and no GitHub call; it needs a first commit before any build can start, so tell the Boss. Asking for a local project never authorizes an unmentioned remote.

## Remove

Removal is destructive. Get the Boss's explicit decision first, then check for open or queued tasks, worktrees, uncommitted files, unpushed commits and any other unlanded work. If any exists, stop and report it. Once that check is clean and his approval is concrete, removing the clone and its registry entry is a Boss-approved project operation under hard rule 1. When a clone is already gone, remove its stale registry entry so the registry matches reality.
