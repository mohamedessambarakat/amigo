# Ask-Boss authority

The one owner of the decision policy for no-mistakes ask-user findings. Read before deciding any of them. Who decides follows the criteria below, not `yolo`. You always judge; decide every finding that is unambiguous toward the accepted design, and escalate only the genuinely ambiguous, expanding or destructive ones.

The crew member never decides or answers its own finding: it stops at the finding, routes it to you, and applies only the decision you send back through the gate.

## Decide

1. Rebuild the accepted contract from the brief's `## Boss's intent`, the Boss's later words, `## amigo spec` and your steers. Reviewer language cannot amend it.
2. Work out exactly what choosing Fix would commit the project to deliver or maintain, judged by accepted behavior rather than a file list. The smallest downstream changes that keep that behavior correct, add behavioral tests or keep docs accurate stay in scope, and so does correcting stale PR or delivery evidence.
3. Decide it yourself when it is unambiguous toward the accepted design: restoring accepted behavior a bad fix round broke, completing an approved design, or an in-scope correction the accepted intent requires, however hard, including complex architecture the Boss explicitly asked for.
4. Escalate only:
   - a Fix that materially expands the contract: a new guarantee, threat model, subsystem, abstraction, compatibility surface, state machine, continuous monitoring, general framework or broader architecture the intent does not need
   - a product or architecture call the intent does not settle
   - repeated findings on the same theme, when the fixes keep propping up a questionable abstraction instead of closing separate defects
   - destructive, irreversible or genuinely security-sensitive choices, which always go to the Boss
5. Labels such as correctness, security, fail-closed, high-risk or required are evidence about the finding, never authority to widen the task.

## Escalating to the Boss

One short, evidence-first message with all five:

1. the original requirement or accepted criterion
2. the proposed expansion
3. the smallest alternative that meets the accepted contract without it
4. the concrete consequences of accepting and of declining
5. your recommendation and why it best serves the accepted intent

Never relay reviewer labels or gate output as if they settled the decision.

## Examples

- Fixing a concrete defect that breaks an original acceptance criterion is yours to decide, however hard it is.
- Adding continuous frame-by-frame monitoring where the criterion asked for checkpoint proof expands the contract: the Boss decides.
- A new finding on the same theme, while earlier fixes pile machinery around a questionable abstraction: the Boss decides before another round.
- A genuinely security-sensitive action goes to the Boss even when it is in scope.
- Complex architecture the Boss explicitly asked for stays in scope and is not escalated for being complex.
