---
name: afk
description: Inside an amigo session only, when the Boss types /afk (optionally with instructions) or says he is going away - record the away posture before any other work; also when an away record exists and he sends his first ordinary message (his return). Never use it outside an amigo session.
---

# afk

Away mode is a posture of the one amigo session, not a second system. It changes two things only: how the Boss is told, and what happens at a decision that is his (it waits for his return, unless his away words already answered it). It never changes who may approve what. Typing `/afk` is itself the go: never wait for a reply or ask him to confirm.

## Entering: `/afk [words]`

1. **Write the record first, in this same turn, before any other work.** Put his words, exactly as given, in a file under your drafts folder and run `amigo away afk --words-file <file>` (or `amigo away afk` with no words). Add `--expected-return <ISO time>` when he said when he is back. His words are the whole mandate, recorded verbatim; no field list is parsed out of them. `/afk` again with no words is a refresh; new words replace the old ones.
2. **Announce, then read back.** Say: he is away; there is no phone channel, so anything needing him waits for his return; his instructions are recorded and you will carry them out where you can; destructive, irreversible and security-sensitive actions are never pre-authorized whatever the words say. Then restate his words in your own plain sentences, with the expected return, and name any sentence you cannot act on while away (a red merge, a discard, a local-only landing): it waits for him. This read-back is information, never a request for a go.

## While away

- Read his words at every wake and decide by your own judgment whether the event in front of you is the moment they name. Act on them only through amigo's guarded commands, under standing authority, never by analogy. When in doubt, hold it for his return.
- Open every outcome you report for an action taken under the words with "per your away instructions:".
- A PR green at its live head may merge when his words call for it or the project is yolo; a merge the words do not call for waits. `amigo merge` refuses check waivers and local-only landings while away, and a held decision is never released under away authority.
- Ask-user findings keep `ask-boss-authority.md` unless his words answer that exact decision.
- Record everything that needs him (decisions, review-ready PRs, failures, credentials) so the return brief carries it.

## The return

No `/back` is needed: his first ordinary message is the return. A message starting with `/afk` is a refresh, and Stop hook wakes are automatic supervision, not his return. Bias ambiguous cases toward return: a present Boss comes first, and a false return corrects itself (he types `/afk` again).

1. Before acting on the message that brought him back, run `amigo away return`. It archives the record and prints the return brief basis: when he left, his words, what finished, what waits on him, what is open.
2. Run `amigo wake drain`, handle and acknowledge every wake, and reconcile every open blocker through the normal lifecycle before acting on the fleet for him (dispatching, steering, merging).
3. Give him the return brief in section 9 language: what you did under his words, what landed (full PR URLs), what failed, and what waits on him, decisions first. Close work that landed while he was away through ordinary cleanup (`amigo close`, never forced), and say so as an outcome.
4. Then handle the message he sent.

When he wants the same quieter supervision while staying and chatting, that is `/quiet`, not `/afk`.
