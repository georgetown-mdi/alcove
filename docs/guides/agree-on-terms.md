---
reader: Both partners, before anyone creates an invitation
needs: Your partner, and the column names in each of your files
timing: "An invitation lasts 1 hour unless you choose longer. Each side waits 10 minutes (browser, WebRTC) or 1 hour (SFTP, shared folder) for the other."
next: "[Invite with the web app](./web-invite.md), [Invite from the console](./console-invite.md) or [Invite a partner](./cli-invite.md)"
---

# Agree on terms

Settle these decisions with your partner before anyone creates an invitation.

Once the invitation is created, its terms are locked. Your partner accepts them whole or asks you for a new invitation.

## What you match on

Alcove matches records on keys built from identifiers such as names, date of birth, SSN, ZIP code and phone number. The built-in rules come in two sets.

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Highest precision** | Pairs a name or date of birth with an SSN, ZIP code or phone number. Published studies of similar rules suggest no more than 1 in 100 of its matches are wrong. | A wrong match is costly, and both files have an SSN, ZIP code or phone number. |
| **Broader matching** | Highest precision, then rules that find more people, with a few more wrong matches. | Usual: you want to find as many shared people as you can. |

Broader matching has 41 rules and Highest precision has 24. An invitation keeps only the rules the inviter's file can supply.

**Keys marked (less certain).** Three Broader matching rules use only first name, last name and date of birth. Different people share these more often the more people the two files cover, so leave these keys out when the files cover many people. A file of one age group, such as one school class, counts as covering many people.

A ZIP code or phone number column must be the person's own. A site's or agency's ZIP code or phone number matches unrelated people served there.

More detail: [How the rules are ranked by precision](../EXCHANGE_REFERENCE.md#choosing-the-built-in-rules), [How to leave out the less certain rules](../EXCHANGE_REFERENCE.md#rules-marked-less-certain).

## What each of you sends

Each of you sets a use for every column in your own file. The inviter does it on **Matching & sharing**; the accepting party does it on **Confirm your columns**. On the command line, each column's entry in `metadata` sets it ([Where each decision is set](#where-each-decision-is-set)).

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Builds the matching keys. The value never leaves your machine. | Usual: names, date of birth, SSN and other identifiers. |
| **Used to match - sent to your partner** | Builds the keys, and sends the value to your partner for matched records. | Your partner agreed to receive that identifier. |
| **Unique record identifier - not sent** | Labels your own records in your result file. | Usual: your own ID column, whatever it is called. |
| **Unique record identifier - sent to your partner** | Labels your records, and sends the ID to your partner for matched records. | Your partner needs your ID to follow up on each match. |
| **Sent to your partner** | Not matched on. Sent to your partner for matched records. | Your partner agreed to receive that column, such as an enrollment date. |
| **Ignored** | Not matched on and not sent. | Usual: every other column. |

"Sent" means the values of matched records only, and only to a party that receives the result. A party that receives no result is sent no columns, whatever its partner's file sets.

Alcove fills in each column's type and use from its name. It sends nothing by default, your ID column included.

**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**. Your result then starts each row with your own ID, and your partner never receives it. Alcove recognizes a column named `id`, `identifier`, `ClientID`, `PersonID`, or `PersonalID`, or one whose name ends in `_id` once spaces, dots, and dashes count as `_` (so `Client ID` counts), and starts it as **Unique record identifier - not sent**; if several qualify, only the first starts as an ID. A column the app does not recognize starts as **Ignored**. With no column set as your ID, your result holds row numbers only, counting from 0. To send your ID for matched records, choose **Unique record identifier - sent to your partner**. On the command line, its `metadata` entry reads `role: identifier`, with `is_payload: false` to keep it or `is_payload: true` to send it.

## Who receives the result

Choose under **Who receives the matched results**. The party that receives no result still contributes records to the match.

| Option | What it does | Pick it when |
| --- | --- | --- |
| **You and your partner** | Each of you gets a result file: your own matched records, with the columns your partner sends. | Usual: both of you need to act on the matches. |
| **Only you** | The inviter gets the result. The accepting party gets none, so the inviter sends it no columns. | Only the inviter needs the list. |
| **Only your partner** | The accepting party gets the result. The inviter gets none, so the accepting party sends it no columns. | Only the accepting party needs the list. |

> [!NOTE]
> Under **Cascade**, the party that receives no result can still work out which of its own records are in the other's file, though not which of the other's records they are. Alcove shows it neither that list nor a count; a command line debug log shows the count. Keeping the result itself from that party depends on it honoring the agreed terms. If you only need to know how many people you have in common, choose a count instead: [A list or only a count](#a-list-or-only-a-count).

## A list or only a count

Choose under **Matching method**, at the top of **Matching & sharing**.

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Reveal the matched identifiers (standard)** | Matches records and writes a result file of matched records. | Usual: you will act on the matched records. |
| **Reveal only the count (psi-c)** | Reports how many records you have in common. No records are matched to each other and no columns are sent either way. | You only need the size of the overlap, such as to decide whether a data sharing agreement is worth making. |

This choice is the same for both of you: Alcove cannot give one of you a list and the other only a count. Under **Only you**, your partner sees neither a list nor a count (a command line debug log shows the count); if you agreed to tell them how many matched, tell them yourself.

A count-only exchange matches on one key, so turn off all keys but one. It also needs **Linkage strategy** at **Cascade**, every column set so it is not sent, and **Allow several of your records to match one partner record** cleared.

A count only is the choice for a question such as "how many of our clients are also your members": neither of you can work out which of your records matched. Keep one key that both files fill for most people. The keys are listed most precise first, so keep the first one whose columns both of you hold for most records. If many records have no SSN, an SSN key misses them; `LN + FN + DOB` reaches more people but is less certain, so the count may include some pairs of different people.

Only one of you computes the count. Under **You and your partner**, the other is sent that number, which Alcove does not check.

> [!WARNING]
> Your partner can learn whether one person is in your data by choosing which records to ask about. A crafted list, or a second run differing by one record, turns a count into an answer about one person. Alcove does not check what your partner contributes.

Against a partner that contributes its real file, a count only reveals neither side's matched records.

## What each party learns

Each row is what one party can work out about the other's file from the exchange itself: its copy of Alcove receives this, whether or not Alcove shows it. Alcove shows a party only its own result. A party the terms give no result sees no list and no count, only that the exchange completed: **Results withheld by the terms** in the web app and console, `exchange complete: no result file for you under the agreed terms` on the command line. The one exception is a debug log: a command line run with `--log-level debug -v` logs how many records matched on each key. The table assumes **Cascade**, the default.

| What a party can work out about the other's file, under Cascade | List, receives the result | List, does not receive | Count only |
| --- | --- | --- | --- |
| How many records the file holds | Yes | Yes | Yes, both parties |
| Which of its own records are also in the other's file | Yes | Yes, though Alcove shows it nothing | No |
| How many records matched | Yes | Yes, in total and for each key, though Alcove shows it only in a debug log | Only a party that receives the count |
| The other's row number for each matched record | Yes | No | No |
| The columns the other set to send, for matched records | Yes | No | No; none are sent |
| The other's identifiers, such as names or SSNs | Only those set to a use ending "sent to your partner" | No | No |
| For each key, how many of the other's records have a value for it | Yes | Yes | Yes, for the one key |
| Anything else about the other's unmatched records, except as listed below | No | No | No |

In the last but one row, counted are values that appear once in their file and are not yet matched.

The defaults suit most exchanges. These notes matter only if you change a setting or a key.

- **Linkage strategy.** Leave it at **Cascade**. With **Single-pass**, every key is matched against every record, so the receiving side observes matches on weaker keys that the cascade would have filtered out.
- **Single-pass and one receiver.** With **Single-pass**, a party that receives no result can work out which of its own records matched if it sends columns, and cannot if the terms say it sends none.
- **Duplicate matches.** **Allow several of your records to match one partner record** is off by default. Turning it on lets more of the accepting party's records match, and each match discloses that record's membership and any columns it sends.
- **Keys that run only where a date of birth is missing.** Five Broader matching rules match a name with a phone number or email only where one record has no valid date of birth. A match through one of these keys tells whoever receives the result which of the two records had none, and your partner can work out how many of your unmatched records have no valid date of birth.

The coordination server, the STUN server (Google's, unless your settings or the invitation name another) and any relay or relay registrar of a WebRTC exchange see both parties' network addresses and connection times, never the exchange's content. A relay also sees how much traffic it carries. The SFTP server or shared folder of an invited exchange sees the exchange's data only encrypted, and sees when each file is written. None of them sees the identifiers you match on. In the web app, the site's host (Cloudflare) also sees your network address when it serves the page.

More detail: [What the coordination server, relays and SFTP server can observe](../../PRIVACY.md#what-supporting-services-can-observe), [Why record counts are revealed](../SECURITY_DESIGN.md#private-set-intersection), [What a count-only exchange protects](../SECURITY_DESIGN.md#count-only-exchanges-and-the-pre-agreement-assumption).

## Timing

| | Web app | Console | Command line |
| --- | --- | --- | --- |
| The invitation lasts | 1 hour by default; up to 1 year | 1 hour by default; up to 1 year | 1 hour by default; up to 365 days |
| Each side waits for the other | 10 minutes, then **Keep waiting** to wait again | 1 hour over SFTP or a shared folder; 10 minutes over WebRTC | 1 hour over SFTP or a shared folder; 10 minutes over WebRTC |

The web app and console offer 1 hour, 6 hours, 1 day, 7 days, 30 days and 1 year. The invitation's lifetime is how long your partner has to accept it and run the first exchange.

The wait is how long a running side waits for the other to start. On the console and command line it can be set up to 7 days.

Both of you run at the same time, on every channel. One of you can start first; the other must start before the first one's wait runs out. In the web app, both of you keep the page open until the run ends.

A run's length grows with the number of keys, since each key is one round between you. It also grows with the channel's checking interval (250 milliseconds on a shared folder, 5 seconds on SFTP) and with the record count. A count-only run is one round.

Measured with 20 records a side and 27 keys, both parties on one machine:

| Channel | Run length |
| --- | --- |
| WebRTC (command line) | 3 to 5 seconds |
| Shared folder | 1 minute |
| SFTP, default 5-second check | 14 minutes |
| SFTP, `--polling-frequency 1s` | 4 minutes |

In the web app, 10,000 records a side took 4 minutes 44 seconds, with both browsers on one computer.

## Where each decision is set

| Decision | Web app | Console | Command line |
| --- | --- | --- | --- |
| Built-in rules | Customize > **Matching keys**, then **Built-in rules** | **Change** beside **Matching keys**, then **Built-in rules** | `alcove init` writes the Broader matching keys into `linkage_terms.linkage_keys`; delete keys to narrow them |
| Leave out a less certain key | Customize > **Matching keys**, then turn off the key's checkbox | **Change** beside **Matching keys**, then turn off the key's checkbox | Delete the key from `linkage_terms.linkage_keys` |
| Each column's use | **How it is used**, on **Matching & sharing** or **Confirm your columns** | **How it is used**, on **Matching & sharing** or **Confirm your columns** | `metadata`: each column's `role` and `is_payload` |
| Who receives the result | **Matching & sharing**: **Who receives the matched results** | **Matching & sharing**: **Who receives the matched results** | `linkage_terms.output`: `expects_output` (you) and `share_with_partner` (your partner) |
| A list or only a count | **Matching & sharing**: **Matching method** | **Matching & sharing**: **Matching method** | `linkage_terms.algorithm`: `psi` or `psi-c` |
| Linkage strategy | Customize > **Matching keys**, then **Linkage strategy** | **Change** beside **Matching keys**, then **Linkage strategy** | `linkage_terms.linkage_strategy`: `cascade` or `single-pass` |
| Invitation lifetime | **Review & create**: **Invitation duration** | **Review & create**: **Invitation duration** | `alcove invite --expires-in`, such as `--expires-in 2d` |
| Wait for the other side | Fixed at 10 minutes | **Connection tuning**: **How long to wait for your partner** | `--peer-timeout`, or `connection.options.peer_timeout_ms` |

On the command line, `alcove init` writes `alcove.yaml` with every key above, and `alcove invite` takes its terms from that file. The accepting party's `alcove accept` writes its own `alcove.yaml`, whose `metadata` sets its columns.

Each use on **How it is used** is a pair of values in `metadata`:

| Use | `role` | `is_payload` |
| --- | --- | --- |
| **Used to match - not sent** | `linkage` | `false` |
| **Used to match - sent to your partner** | `linkage` | `true` |
| **Unique record identifier - not sent** | `identifier` | `false` |
| **Unique record identifier - sent to your partner** | `identifier` | `true` |
| **Sent to your partner** | `payload` | `true` |
| **Ignored** | `ignored` | `false` |

A column left out of `metadata` is not sent.

More detail: [Which settings each app can change](../EXCHANGE_REFERENCE.md#where-each-setting-is-edited), [The output setting](../EXCHANGE_REFERENCE.md#linkage_termsoutput).

## A checklist for your partner

Copy this into an email to your partner, and agree on each line before anyone creates the invitation.

```
Before I create the Alcove invitation, let's agree on:

1. App: which Alcove app each of us uses (web app, console, or command line).
2. Channel: our SFTP server, a shared folder, or WebRTC (the web app runs WebRTC only).
3. Matching: Broader matching or Highest precision, and whether to drop the "(less certain)" keys.
4. Columns: which columns each of us sends for matched records, if any.
5. Results: both of us, only me, or only you.
6. A list of matched records, or only the count.
7. When: a date and time we both run, and how long the invitation should last.
8. For a recurring exchange: how often, and the time we both run.
9. On SFTP: whoever runs the server sends the other the host name, port, directory, an account and the server's fingerprint.

The invitation holds a one-time secret: anyone who has it can take your place.
I will send it by: ____________
```
