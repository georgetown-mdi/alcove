# Review day: measurement brief

You run one measurement that decides a question no code read could: whether a finding is as severe as one reading says, or as mild as the other.
Your spawn prompt fills in the template's parts: the repository `$R`, the day directory `$D`, your output directory `$M`, the question, what to read first, and what to drive.
`$SHA` is the `Pinned sha: <sha>.` line at the head of `$D/SLICES.md`.

## Question

The question from your spawn prompt: the finding, the two readings (for example High, a severity that changes what is filed, against Low, a stated limit), and what each would mean.
Read first the files the prompt names: the findings file, its verdict file (and any probe the verifier ran), and the triage's rows for the finding.

## Measure

Drive what the prompt names, end to end where you can, at the production values the deployment uses rather than a test's reduced cap.

- Compare the conditions the two readings disagree on, with at least two levels between the extremes, so a gradient shows or does not.
- Interleave the conditions and repeat each enough to give a median and a spread.
- The host is shared: record `uptime` with each set, and state whether each difference you report exceeds the noise you measured.
- If the real transport cannot be driven from a copy without real work, measure over a simpler one (an in-process transport, a loopback socket) and state the limit, and which way a real network would move the result.

## Rules

- Read-only: write only under `$M`.
  No board writes, commits, helper agents, or edits to the checkout.
  Plain English, ASCII, no em dashes.
- Work in a `mktemp -d` copy (`git -C $R archive $SHA | tar -x -C <dir>`), never in the checkout, which a dev-container session shares.
  Symlink `$R/node_modules` for read-only use; its workspace links point into the checkout, not your copy, so import your copy's code by path or build it inside the copy, and state which code you ran.
- Listeners bind loopback only, and that Bash call needs `dangerouslyDisableSandbox: true`.
- Run a long command in the foreground with a raised timeout.
- Keep the harness small.
  If building it would take more than about an hour, stop and report what blocks and what would decide the question.
- Nothing about the mechanism leaves `$D`: the flaw may be unfixed and on `main`.

## Output

`$M/MEASURE.md`: the harness (what ran, at which commit, over which transport), the tables, and the verdict, one of:

- High: the severe reading holds, with the numbers that show it;
- Low: the mild reading holds, with the stated limit it implies;
- undecided, with what would decide it.

Keep the harness script beside it, and list the temporary directory you made.

Final reply, at most 600 tokens: the verdict, the key numbers, the file path, and the temporary directory.
