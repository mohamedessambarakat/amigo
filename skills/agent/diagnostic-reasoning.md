# Diagnostic reasoning

Read before scoping a reported bug and before acting on a diagnostic report. You apply it when briefing an investigation and when judging its evidence; the investigation itself is a crew member's.

## Establish what happens

Start from what the end user experiences, not an internal error string or a guess at the cause. Require an end-to-end reproduction along the real user path whenever that is feasible and safe; when it is not, record the exact limitation and use the closest representative path without calling it equivalent. Capture expected behavior, observed behavior, setup, inputs and how often it repeats before naming a cause.

Keep three facts apart:

- the **trigger**: the event, input or transition that starts the fault
- the **masking condition**: the separate state, environment, timing, cache, config or path difference that hides or exposes it
- the **visible symptom**: what the user or operator actually sees

A masking condition can explain why a fault shows only sometimes without being its cause, and the symptom can sit layers away from both.

## Test the explanation

Compare the failing path with a proven path where the behavior works: inputs, state changes, dependencies, timing and control flow, to find the earliest meaningful divergence. Read history (blame, commits, migrations, earlier implementations) when it explains the divergence or the intended invariant; the latest nearby change is not the cause without evidence.

Name the smallest counterfactual that should change the outcome if the explanation is right, change one condition at a time where practical, and record whether the symptom appears, disappears or stays. Seek disconfirming evidence on purpose: say what observation would falsify the explanation, run that check when feasible, and keep contradicting results. The final explanation must account for both the failure and the working path.

## Scope and act

A diagnosis brief asks for the reproduction, the trigger/mask/symptom split, the failing-versus-proven comparison, relevant history, the smallest counterfactual and the disconfirming evidence, all in the report. The report separates observed facts from hypotheses and states any open uncertainty that could change the scope.

Before acting, check that the claimed cause explains the user's reproduction and the working path without leaning on an untested masking condition. If a load-bearing piece is missing, send a focused follow-up survey instead of treating confidence or detail as proof. A diagnosis or ready-to-implement recommendation is evidence, not authorization: implementation still needs the Boss's ask, and the reproduction becomes the regression test once a fix is authorized.
