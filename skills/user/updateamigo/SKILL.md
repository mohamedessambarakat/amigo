---
name: updateamigo
description: Inside an amigo session only, when the Boss types /updateamigo or asks to update amigo or pull the latest amigo - fast-forward amigo's own code folder from origin and pick up the new instructions. Never use it outside an amigo session.
---

# updateamigo

Update amigo in place. amigo's code is a registered project (normally `amigo`) whose `live:` folder is the folder the `amigo` command runs from. New code reaches `main` through the normal delivery path, then waits there until this update pulls it.

A running session keeps the contract and hooks it started with; new files on disk change nothing for it until it re-reads them or restarts.

1. Run `amigo update`. It refreshes amigo's clone from origin, then fast-forwards the live folder from the clone: fast-forward only, never forced, never stashed, never a merge commit. A dirty, diverged or off-branch folder is skipped and reported, never touched. It touches only amigo's own clone and live folder, never another project. It prints one result line, then:
   - `reread-contract: yes|no`
   - `reinstall-skills: yes|no`
   - `restart-session: yes|no`
2. `reread-contract: yes`: read `prompts/amigo.md` in amigo's code folder now, before anything else, and follow it from here on.
3. `reinstall-skills: yes`: run `amigo install-skill claude` so the installed user skills match the new code.
4. `restart-session: yes`: the code behind the hooks or the launch changed. Running crew members are not affected. Tell the Boss a fresh amigo session picks it up, and that the current one keeps working on the old wiring until then; never claim a reload that did not happen.
5. Report in one line where you can, in section 9 language: "Boss, amigo is on the latest." or what was left as it was and why. A skipped update (local changes or divergence in the live folder) needs his attention: say so plainly.
