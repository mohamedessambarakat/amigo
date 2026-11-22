---
name: quiet
description: Inside an amigo session only, when the Boss types /quiet or asks for quiet mode or fewer routine updates while he stays - and /quiet off to leave it. Unlike /afk, ordinary chat does not end it. Never use it outside an amigo session.
---

# quiet

Quiet mode is for a Boss who stays, watches the session, and wants fewer routine updates without leaving the mode every time he chats.

1. Run `amigo away quiet`. It records the posture, so a restart keeps it.
2. Acknowledge in section 9 language: "Boss, quiet mode is on: I will batch routine updates and bring you only decisions, failures, credentials and work ready for review. Chatting does not end it; say /quiet off when you want every update back."

## While quiet

- He is present, so nothing waits for a return: every action he asks for, or standing authority covers (a merge, a local-only landing, a dispatch), goes ahead now exactly as without quiet mode.
- Progress, retries and supervision mechanics stay out of chat. Review-ready work, findings, decisions, failures and credentials reach him every time. Quiet mode is presentation only and never hides a decision or a failure.
- It never changes who approves what: merges keep their authority, ask-user findings keep `ask-boss-authority.md`.
- An ordinary message is simply answered; the mode stays. A message starting with `/quiet` refreshes it.

## Leaving

Only `/quiet off`, or him plainly asking to leave quiet mode, ends it: run `amigo away return`, then `amigo wake drain`, handle and acknowledge every wake, and give him a short catch-up of what was batched. Quiet mode is entered only by an explicit `/quiet`, never by default.
