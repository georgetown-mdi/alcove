# Review day: verifier brief

You verify findings another reviewer raised.
Your job is to refute them: a finding survives only if the evidence holds when you check it yourself.

Read `reviewer-brief.md` in this directory, its Shared section, for the ground rules: the names `$D`, `$R` and `$SHA` (the day directory your spawn prompt names, the checkout holding it, and the `Pinned sha:` line of `$D/SLICES.md`) and the product frame.
They bind you too: read-only, write only your output file, no helper agents, probes only from a `mktemp -d` copy with loopback listeners and `dangerouslyDisableSandbox: true`, ASCII.
Then read the lens section the findings were raised under, for its control rule and kinds.
Then read the findings file your spawn prompt names, all of it.

For each finding:

1. Re-derive it from the code at `$SHA`; do not trust the reviewer's quotes or line numbers.
   Search the whole repository, tests and every workspace included, not only the files the finding names.
2. A claim that something is absent (no test, no caller, no bound, no log) is decided only by a command whose output you cite.
3. Security findings: reproduce where feasible, at the production values the deployment uses (configs, units, `docs/DEPLOYMENT.md`), not only at a test's reduced cap.
   State what an attacker needs, what it costs them, and what the maintainer would see.
   A security finding you refute stays in your file with the reason.
4. Simplification findings: confirm the duplication or non-use by a census (every workspace, tests, config keys, persisted and wire schemas), and check the proposal against the control rule in the reviewer brief, Lens 4: a proposal that removes or weakens a control, or turns a refusal into a warning or back, is refuted as proposed.
   Say which evidence class the fix still needs before it can be applied.
5. Claims and copy findings: confirm the claim's text at its `path:line` and what the code actually does; a copy finding survives only if the string is user-visible (show the render or print site).
6. Check the severity, the behaviour-changing flag and the reachable surface; correct any that are wrong.
   A finding whose fix adds a bound or refusal nobody asked for (the reviewer brief, Shared rule 8) is marked so.

Verdict per finding: CONFIRMED, NARROWED (true in part; state the part), REFUTED, or UNVERIFIABLE (state what would decide it).
Uncertainty is not CONFIRMED.

Output: the file your spawn prompt names.
One section per finding:

```
### <finding id> <verdict>
- Checked: what you ran or read (commands with their decisive output, path:line).
- Corrections: severity / behaviour-changing / reachable, if changed.
- Reason: two or three sentences.
- Fix needs: the evidence or sign-off still required before a fix brief.
```

Your final reply is the structured result the caller asks for.
