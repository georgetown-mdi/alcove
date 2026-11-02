---
name: audit-day
description: Run a user-journey audit day -- agent testers run the paired web exchange on staging in two browser sessions, cold and guided, keeping confusion logs; problems that recur or are critical become Decision items the owner reads first.
---

    /audit-day [board 9 item id of a pain-point intake to reproduce]

An audit day runs on the Fridays between retros, when the owner starts one, and never per pull request (owner ruling, 2026-10-30).
Agents are the testers: no human usability session is run, and no partner is asked to test.

## First

1. If `.claude/orchestration/ruleset.md` is not already in your context, read it before proceeding -- it holds the session rules this command's steps assume.
2. Run in a Claude Code session on the host, the owner's machine, from the repository root.
   The dev container cannot run an audit day: from it `staging.data-bridge.org` does not answer, `signal.data-bridge.org` is outside its egress allowlist (`.devcontainer/init-firewall.sh`), and it has no browser and cannot download one (measured 2026-11-02).
   A container session hands the day to the host with a hand-off brief (`.claude/orchestration/host-handoff-brief.md`) whose step is this command and whose result file is the day's summary.
3. Read `.claude/audit/paired-web-exchange/journey.md`: the journey, the planted mismatch, the correct outcome and the critical errors. No tester sees it.

The day's directory `D` is `scratch/audit-days/<date -I>/`, gitignored and host-local; every artifact below goes under it.

## Step 1 -- Preconditions

Record each result in `D/preconditions.md`.
At the first that fails, write `D/summary.md` naming it, and stop.

- **Timeout command.** `command -v timeout gtimeout`. The testers' mail waits need one; on macOS it is `gtimeout`, from Homebrew coreutils.
- **Browser CLI.** `npx --yes @playwright/cli@0.1.23 --version` prints `0.1.23`.
  The tool is pinned and run by npx, never added to a `package.json`: it enters no lockfile and no shipped artifact, so the new-dependency steps of `CONTRIBUTING.md`, Dependency Policy, do not apply.
  It is Apache-2.0, and neither it nor the `playwright` and `playwright-core` releases it pins exactly declares an install script (read from the registry 2026-11-02), so it runs under the repository's `strict-allow-scripts` (`docs/spec/DEPENDENCY_PINS.md`, The install-script policy (`allowScripts`)).
  A version change edits this file and `.claude/agents/journey-tester.md` together.
- **Staging.** `curl -sS -o /dev/null -w '%{http_code}\n' https://staging.data-bridge.org/` prints `200`.
  The target is staging, never production (`docs/DEPLOYMENT.md` names both).
- **Coordination server.** `curl -sS -m 10 https://signal.data-bridge.org/api/health` prints `ready`.
- **Staging head.** `git fetch origin staging`, then record `git rev-parse origin/staging`.
  The deploy's footer reads `Commit <short sha>`; the smoke records it, and that commit is the one the day tests.
- **Smoke.** Spawn one `general-purpose` agent with `model: "sonnet"` and the smoke below as its brief; it writes `D/smoke.md`.

The smoke, run with the same CLI, session `smoke-a` in `D/smoke/a/` and session `smoke-b` in `D/smoke/b/`, so one `results.csv` never overwrites the other:

1. `open https://staging.data-bridge.org/` in `smoke-a`. If no browser starts, run `install-browser` for the one the error names and record it. Record the footer's `Commit` text.
2. Isolation: `localstorage-set audit-probe 1` in `smoke-a`, then `open` the site in `smoke-b` and `localstorage-get audit-probe` there. Expected: no value.
3. In `smoke-a`, follow `docs/guides/web-invite.md`, Practice with sample data, its "In a different browser" path: download the partner CSV, create the invitation, and write the invitation link from the page into `D/smoke/link.txt`, recording how it was read and its length.
4. In `smoke-b`, open the link, `upload` the downloaded partner CSV by absolute path, accept, and start.
5. Expected: "Exchange complete - 41 matched records" in both sessions. Record where each download landed.
6. Close both sessions, and report every step that went otherwise than written here.

A smoke that read the link only by `eval`, the clipboard, or another command the tester definition forbids is a failed precondition: the testers could not pass the real link.

## Step 2 -- The trial matrix

- **A pain-point intake** (its form: `.claude/pm/ruleset.md`, Filing and updating items), when the command names one: fetch it (`node .claude/scripts/fetch-issues.mjs 9 <id>`) and run one reproduction trial, `repro`, first, in the cold form. Add to the card of the party the person was a goal sentence saying what the person was trying, never a step. It reproduces when a confusion log or report stops at the same screen on the same text as the intake.
- **Cold**: `cold-1`, `cold-2`, `cold-3`.
- **Guided**: `guided-1`, `guided-2`, `guided-3`.
- **Haiku cold**, on the first audit day only (no earlier day whose `scratch/audit-days/*/summary.md` has trial rows; a day that stopped at a precondition has none): `haiku-1`, `haiku-2`, `haiku-3`, both testers on Haiku. It is a one-round hypothesis: kept only if it finds a problem the Opus trials did not, which the summary records.
- **Step-down.** When the two latest earlier summaries that have trial rows each found no problem, run one trial per form, until a commit on staging since the tested commit of the last day that ran trials changes a screen of the invite, accept or run steps (`git log --stat <last>..<this> -- apps/web/src`), which restores three.

Run one trial at a time, or two at once: four testers is the writing-spawn cap of `.claude/orchestration/ruleset.md`, Models and spawns.

## Step 3 -- Running a trial

`T` is `D/<trial>/`.

1. Make `T/inviter/`, `T/acceptor/` and `T/mail/`. Copy each role's card, as `card.md`, and its CSV from `.claude/audit/paired-web-exchange/` into its role directory.
2. Spawn both testers in one message, in the background, each `subagent_type: "journey-tester"` (its definition pins Opus; the Haiku trials pass `model: "haiku"`). The prompt is this and nothing more -- no step, hint or term, since the card is the tester's whole brief:

   ```
   Role: <inviter | acceptor>. Form: <cold | guided>.
   Trial directory: <absolute T>. Role directory: <absolute T>/<role>.
   Browser session: <date>-<trial>-<role>. Site: https://staging.data-bridge.org/
   Timeout command: <timeout | gtimeout>.
   Your partner starts at the same time.
   ```

   The guided form adds two lines, naming `web-invite.md` for the inviter and `web-accept.md` for the acceptor:

   ```
   Guide: <repo>/docs/guides/agree-on-terms.md and <repo>/docs/guides/<web-invite.md | web-accept.md>.
   Read them before you start and follow them; they name the production site, so use the site above.
   ```
3. The invitation's lifetime and the inviter page's 10-minute wait are the app's own: the session never shortens, extends or pauses them, and never relays anything between the testers.
4. When both have reported, run `npx --yes @playwright/cli@0.1.23 list` and close any of the trial's sessions still open.
5. Write each tester's final report to its `<role dir>/report.md`, then `T/outcome.md`: pass or fail against the correct outcome, and each critical error with the file that shows it, checked as `.claude/audit/paired-web-exchange/journey.md`, How the session checks a trial, sets out.

## Step 4 -- Problems

- Group the day's confusion lines by screen and by what was unclear, in `D/problems-grouping.md`.
- A problem is a group seen in two or more trials, or a critical error seen once. One remark in one trial is not a problem and changes nothing.
- Class each problem by the forms it appeared in: in cold trials and not guided ones, a discoverability finding (the guide has what the screen lacks); in both, a defect; in guided trials only, a guide finding.
- Disclosure copy is protected: the text telling a party what is sent, matched, received or consented to -- the terms review, the consent statement, the column-use options, the "What you will share" bar, the result and record screens. A problem against it goes to the owner as a finding, stating the confusion and its evidence, and never proposes or makes a wording change.

## Step 5 -- Routing

Each problem becomes one item on board 9, where end-user behavior and user docs go (`.claude/pm/ruleset.md`, Project routing), which the owner reads before any agent works from it.

- Check first: `node .claude/scripts/list-issues.mjs --all 9` for an item already covering it, which gets this day's evidence added to its body instead (read in full first, as `.claude/pm/ruleset.md`, Filing and updating items, says), and `node .claude/scripts/find-rulings.mjs <2-3 subject words>`. A ruling or documented behavior that bears on a problem is context cited on the item, never a reason not to file it or to keep the current behavior (owner, 2026-11-02: "Ooh, I don't like 'already answered by a ruling or documented behavior.' Often our 'rulings' and 'documented behavior' is out-of-line - agent written and also excessive.").
- File it as a draft (`gh project item-create 9`, the same section), then set Status to Decision with `node .claude/scripts/edit-issue.mjs 9 <PVTI_id> --status "Decision"`. The Decision column is the owner's ruling queue, and no session works an item there (`.claude/commands/orchestrate.md`, The work), so the item is a question -- work it as filed, rescope it, or decline it -- and the same section lets a Decision item be filed at once rather than at the follow-ups pass.
- The body is the PM ruleset's Light tier, with this as its first line:
  `Owner reads first: an audit-day finding; no agent works from this item until the owner rules on it and moves it out of Decision.`
  It holds the problem in one sentence, its class, the trials, the costliest confusion line of each quoted (`D/problems-grouping.md` holds every line, and the body names it), the tested commit, and the artifacts' host path. A disclosure-copy problem adds: `Disclosure copy: the owner decides any wording change; no agent edits the copy from this item.`
- Every problem item also carries: `A fix simplifies first: remove or shorten copy, fields and steps before adding any (owner, 2026-11-02: "Agents tend to error the side of being excessively wordy. Whatever we do in response, it should also try to simplify as much as possible.").`
- Epic: the audit findings epic once the owner ratifies one; until then, none.
- A pain-point intake the day reproduced is now a problem: add the reproduction to its item, which stays in Decision.

## Step 6 -- The summary

Write `D/summary.md` and end by printing its path:

- the tested commit, from the footer, and `origin/staging` at the start;
- one row per trial: form, model, outcome, critical errors, confusion-line count;
- each problem: class, the trials it appeared in, and its board item;
- on the first day, the Haiku comparison: each problem and confusion group the Haiku trials found that the Opus trials did not, and whether the arm is kept;
- the count of problems, and the trials per form the next audit day runs under the step-down rule;
- the subagent spend the task notifications reported.

Leave `D` in place: the items cite it.
