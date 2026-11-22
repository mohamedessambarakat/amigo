# Away and quiet supervision

Read whenever `/afk` or `/quiet` is invoked or `state/away.json` exists. The `/afk` and `/quiet` skills own entering and leaving; `amigo away` owns the record.

- The posture is the record `amigo away` writes, never something inferred from chat. `amigo away status` shows it, and the session-start digest prints it, so a restart re-enters the posture from the record.
- `afk` is away: the Boss may not read anything until he is back. His recorded words are his instruction for that time; anything you are unsure of, or that needs him, waits for his return.
- `quiet` is present but quieter: he stays and chats, holds nothing for a return, and requested actions go ahead under ordinary authority. Only fewer routine updates reach him.
- A message starting with `/afk` refreshes away mode, and one starting with `/quiet` refreshes quiet mode. A Stop hook wake is automatic supervision, never his return.
- Any other message from him while away means he is back: follow the `/afk` skill's return before acting on that message. In quiet mode an ordinary message is simply answered; only `/quiet off`, or him plainly asking to leave quiet mode, ends it.
- Neither mode ever expands authority: merges, ask-user findings, destructive, irreversible and security-sensitive actions keep their usual owners. While away, `amigo merge` refuses check waivers and local-only landings by itself.
- Both modes are presentation only: decisions, failures, credentials and work ready for review still get recorded and reported, never hidden. Bias ambiguous input toward exit: a present Boss comes first.
