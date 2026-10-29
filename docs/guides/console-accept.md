---
reader: A console user who was sent an invitation
needs: The console running ([Start the console](./console-start.md)), the invitation as text, your CSV file in your working folder, and for SFTP your own account on your partner's server with its password or key file
before: "[Agree on terms](./agree-on-terms.md)"
partner: "[Invite from the console](./console-invite.md), [Invite a partner](./cli-invite.md) on the command line, or [Invite with the web app](./web-invite.md)"
timing: The invitation lasts 1 hour unless your partner chose longer. Your console waits for your partner 1 hour over SFTP or a shared folder, 10 minutes over WebRTC, unless you set **How long to wait for your partner**. Measured - sample files of 100 and 200 records, 30 keys, over SFTP - 15.5 minutes from **Start the exchange** to the result.
next: "[Move it to a schedule](./console-schedule.md)"
---

# Accept in the console

Review your partner's invitation, connect, and run the exchange from the console on your own machine.

## Before you start

**Ask your partner for an invitation the console accepts.** The console runs the exchange itself, so the invitation must name the SFTP server, shared folder or coordination server.

| Your partner uses | Ask them for |
| --- | --- |
| The console | Any invitation, sent as text |
| The command line | An invitation on the WebRTC channel, made as [If your partner uses the console or the web app](./cli-invite.md#if-your-partner-uses-the-console-or-the-web-app) shows. Over their SFTP server or shared folder, invite them yourself from [Invite from the console](./console-invite.md), using an account they make for you. If you agreed on the default terms, the same command line section has their command for an SFTP invitation. |
| The web app | An invitation made with **Live, in this browser**, sent as the link or the message |

A command line invitation made without an address, such as `alcove invite --identity "State agency" input.csv`, stops with "This invitation does not include a connection endpoint this build can accept, so it cannot be run here."

**Agree on a time.** Both of you run at once. Your console waits 1 hour over SFTP or a shared folder, 10 minutes over WebRTC.

**For SFTP, have ready:** your username on your partner's server, your password or private key file, and the server's identity fingerprint from whoever runs the server. It starts with `SHA256:`.

**For a shared folder,** start the console with the shared folder added ([Your working folder](./console-start.md#your-working-folder)).

**To practice first.** The accept screens offer no sample file. On the start page, choose **See how it works with example data**: it writes `alcove-sample-inviter.csv` and `alcove-sample-partner.csv` into your working folder and opens the invite screen. Nothing is created until you choose **Create the invitation**.
Go back to `http://127.0.0.1:3000` and accept your partner's practice invitation with `alcove-sample-partner.csv`. Your partner invites from `alcove-sample-inviter.csv`; if they are not on the console, send it to them.
For the real run, your partner sends a new invitation: see [Then go live](./console-start.md#then-go-live).

## Accept and run

### 1. Paste the invitation

On the start page, paste the invitation text under **Have an invitation? Paste it here** and choose **Review invitation**.

### 2. Review the terms

Screen: Step 1 of 3 - Invitation from (your partner's name)

Alcove does not verify the name shown: your partner typed it.
Read each section against what you agreed on:

- **What you will send to your partner**: confirmed in step 4, from your own file.
- **Matching method**: a list of matched records, or a count only ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)).
- **Result sharing**: "You will receive the matched result" and "Your partner (the inviter) will receive the result", each Yes or No ([Who receives the result](./agree-on-terms.md#who-receives-the-result)).
- **Matching strategies**: the fields you match on. Keys marked less certain are listed there ([What you match on](./agree-on-terms.md#what-you-match-on)).
- **How it runs**, in the panel beside the steps, such as "SFTP (command-line tool)": the console runs the command line tool for you, so this is expected. For WebRTC, **How this console connects** names your partner's coordination server.

If anything differs from what you agreed on, stop and ask your partner for a new invitation. Otherwise choose **Continue: consent & your file**.

### 3. Consent & your file

Screen: Step 2 of 3 - Consent & your file

Tick **I have reviewed the terms my partner proposed and I consent to this exchange**.
Enter **Your name or agency**. Your partner sees it.
Leave **How your file separates fields** at **Comma** unless your file uses tabs, pipes or semicolons.
Under **Choose a file from your folder**, choose **Select** beside your CSV file, check its columns and sample values, and choose **Use this file**.
For a shared folder, the screen names the folder under **Confirm the shared folder**: check with your partner that you both use it.
Choose **Accept and continue**.

### 4. Confirm your columns

Screen: Step 3 of 3 - Confirm your columns

Check that the screen says every key can match, such as "All 30 keys can match".
Alcove fills in each column's type and use from its name. It sends nothing by default, your ID column included.

**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**. Your result then starts each row with your own ID, and your partner never receives it. Alcove recognizes a column named `id`, `identifier`, `MRN`, `ClientID`, `PersonID`, `PersonalID`, `PatientID`, `RecordID`, or `MemberID`, or one whose name ends in `_id` once spaces, dots, and dashes count as `_` (so `Client ID` counts), or in `number` or `no` as a word of its own (so `case_number` and `RecordNo` count, but not `phone_no`), and starts it as **Unique record identifier - not sent**. To send your ID for matched records, choose **Unique record identifier - sent to your partner**. A column the app does not recognize starts as **Ignored**. With no column set as your ID, your result holds row numbers only, counting from 0.

Change **How it is used** only as you agreed ([What each of you sends](./agree-on-terms.md#what-each-of-you-sends)):

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Matches on the column and never sends it | Usual: names, date of birth, SSN, ZIP code |
| **Used to match - sent to your partner** | Matches on it, and sends its value for matched records | Your partner agreed to receive this column |
| **Unique record identifier - not sent** | Starts each row of your result with your own ID | Usual: your own ID column, whatever it is called |
| **Unique record identifier - sent to your partner** | Does the same, and sends the ID for matched records | Your partner agreed to receive your IDs |
| **Sent to your partner** | Sends the value for matched records; not used to match | Your partner agreed to receive this column |
| **Ignored** | Neither matches on it nor sends it | Usual: every other column |

### 5. Connect

::: tabs channel

== SFTP

Under **Connect to your partner's SFTP server**, the screen reads "Your partner named this server:" with its address and directory. Choose **Set up connection**.
The address and **Remote directory** are fixed by the invitation. Fill in your own sign-in:

- **Username**: your account on the server.
- **Server identity fingerprint**: the value from whoever runs the server. Or choose **Read the fingerprint from the server**, compare what it shows with theirs, and choose **Use this fingerprint** only if they match.
- **How Alcove signs in**: **Password** or **Private key**. Choose **Choose the credential file**, then **Use this file** beside your password or key file.

Choose **Save connection**.

You should see: **READY TO TRY** and "Signs in to" with the server's address. A warning appears if the credential file is in your working folder; it does not stop the run.

== Shared folder

Nothing to set: the console uses the shared folder it was started with.

== WebRTC

Nothing to set. Your working folder must not already hold `alcove.yaml` or `.alcove.key`: the console writes both there when the exchange starts, and does not start if either is there.

:::

### 6. Both of you: start the exchange

Check that your partner's side is running, or will start within your console's wait. If your partner invited with the server's address on the command, their command is already waiting: start as soon as you accept.
Choose **Start the exchange**.
The status panel shows **Getting ready**, **Checking settings match**, then **Matching records (key 1 of 30)** and on through each key. You can leave the page: the run keeps going, and the start page brings you back to it.

You should see: **Exchange complete - 41 matched records**, with **Download result** below it. 41 is the count for the sample files.
If the terms give you no result, you see **Exchange complete** and **Results withheld by the terms**, with no list and no count.

If your partner does not start within the wait, the screen shows **Your partner did not arrive** with **Try again**.

## What you get

The result screen offers the downloads. The same files are in this run's folder inside your working folder, named by the run's id, such as `aea282aa-f2d3-40fc-b3de-e84c74ceb416`:

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<time>.csv` (**Download result**) | One row per matched record: your record ID, your partner's row number, and any columns your partner sends | Keep private |
| `alcove-record-<time>.json` (**Download record (safe to share)**) | What you agreed on and what matched, for your disclosure log | Keep; not secret |
| `alcove-record-<time>.keys.json` (**Download verification keys**, marked keep private) | The keys that check the record against your files | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' agreed terms | Keep; not secret |
| `alcove.yaml` | The configuration the console wrote for this run | Keep; not secret |
| `.alcove.key` | The shared secret your next run needs; it changes at every run | Keep private |

Your next run needs `.alcove.key`. Where to find it:

| Run | `.alcove.key` is in |
| --- | --- |
| SFTP or shared folder | This run's folder |
| WebRTC | Your working folder, beside `alcove.yaml` |

> [!WARNING]
> **Set up another exchange** and **Discard** delete this run's folder, `.alcove.key` included. Copy out what you need first.

## If the console refuses the invitation

**Cannot accept this invitation** comes with one of these:

| The screen says | What to do |
| --- | --- |
| "This invitation does not include a connection endpoint this build can accept, so it cannot be run here." | Your partner made it on the command line without naming the server. Ask for one as **Before you start** shows, or invite them yourself. |
| "This invitation has expired. Ask your partner to send a new one." | Ask your partner for a new invitation. |

More detail: [How the console accepts a WebRTC invitation](../CONSOLE.md#accepting-a-webrtc-invitation), [How the console holds your SFTP sign-in](../CONSOLE.md#authoring-the-sftp-connection).
