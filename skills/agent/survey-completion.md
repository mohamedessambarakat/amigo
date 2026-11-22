# Survey completion

Read when a survey reports done or is being considered for implementation.

A finished survey must leave a self-contained report (`data/<id>/report.md`) before its scratch worktree may go. Read the whole report and relay its findings to the Boss as findings, not just a completion notice; its path is the Done record.

A report may recommend implementation; it never authorizes it. Before treating the survey as complete, read `boss-hold-lifecycle.md`: `amigo close` refuses a survey until its open Boss calls are recorded (`amigo complete`).

When the Boss separately authorizes the work, dispatch a build whose spec carries what the survey found. The build starts from a clean copy of the project's default branch: it carries over only the intended fix, leaves scratch commits and debug edits behind, and turns a reproduced bug into the regression test. Then close the survey.
