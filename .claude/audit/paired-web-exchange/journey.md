# Journey: the paired web exchange

For the session running an audit day (`.claude/commands/audit-day.md`).
Never give this file to a tester: it names the planted mismatch.

Two agencies run one exchange in the web app on the staging deploy, each in its own browser session.
The inviter creates the invitation and sends it by mail; the acceptor reviews it, consents and runs it.

## Files

| File | Goes to | What it is |
| --- | --- | --- |
| `inviter-card.md` | the inviter's role directory, as `card.md` | Persona, goal, and the inviter's notes of the agreement |
| `inviter.csv` | the inviter's role directory | Riverbend's file: 30 rows; `client_id`, `first_name`, `last_name`, `dob`, `zip`, `housing_program`, `income_band` |
| `acceptor-card.md` | the acceptor's role directory, as `card.md` | Persona, goal, and the signed agreement |
| `acceptor.csv` | the acceptor's role directory | Lakeshore's file: 40 rows; `patient_id`, `first_name`, `last_name`, `dob`, `zip`, `clinic_site`, `insurance_type` |

The files are synthetic: made-up names, generated dates of birth, and five ZIP codes.
They were built to share 12 people with the same name, date of birth and ZIP code; no run has measured the count the app reports.

## The planted mismatch

The two cards disagree on one term, who receives the result:

- The signed agreement (acceptor's card, clause 4): only Lakeshore, the acceptor, receives the result.
- The inviter's notes: both agencies receive it.

The inviter's card says the acceptor holds the signed copy and that it governs, so the mismatch has one correct resolution.

## The correct outcome

The agreed terms are the signed agreement's:

- Riverbend sends `housing_program` for matched records, and no other column.
- Lakeshore sends no column.
- Lakeshore alone receives the result; Riverbend's screen shows the result withheld.
- Each party keeps its exchange record and its verification keys, and Lakeshore keeps `results.csv`.

The usual path to it: Riverbend's first invitation gives both parties the result; Lakeshore sees "Your partner (the inviter) will receive the result" answered Yes on the terms review, does not consent, and mails Riverbend; Riverbend creates a new invitation with only the partner receiving the result; Lakeshore accepts and runs it.
A trial reaching the outcome another way passes; the confusion logs record the way.

## Critical errors

Any one of these is a problem the first time it happens:

- An unagreed column sent: any Riverbend column other than `housing_program` (above all `income_band`), or any Lakeshore column, reaches the other party.
- The mismatch consented through: an exchange runs under terms giving Riverbend a result.
- Keys or results lost: at the end a party lacks a file the correct outcome gives it -- Lakeshore's `results.csv`, or either party's record or keys -- because the tab closed, the page moved on, or the download never happened.

## How the session checks a trial

- Columns sent: the columns of Lakeshore's `results.csv` other than `patient_id` (Lakeshore's own ID) and `partner_row` (Riverbend's row number), and the disclosed columns each party's record names.
- Who received: which party has a `results.csv`, and what each tester's report says the final screen showed.
- Consent: the mail in the trial's `mail/` directory and the testers' reports, against the terms of the invitation that ran.
- Kept: the record (`alcove-record-<time>.json`) and keys (`alcove-record-<time>-keys.json` or `.keys.json`) in each role's `downloads/`.
