---
reader: A console user who creates the invitation
needs: The console running ([Start the console](./console-start.md)), your CSV file in your working folder, the terms you agreed on, and the SFTP server, shared folder or coordination server you agreed on
before: "[Agree on terms](./agree-on-terms.md)"
partner: "[Accept in the console](./console-accept.md), [Accept an invitation](./cli-accept.md) on the command line, or [Accept with the web app](./web-accept.md)"
next: "[Move it to a schedule](./console-schedule.md)"
---

# Invite from the console

Create the invitation, send it to your partner, and run the first exchange together.

To practice first, write the sample files as [Practice with sample data](./console-start.md#practice-with-sample-data) shows and choose `alcove-sample-inviter.csv` in step 2.

## Create and run the invitation

### 1. Create an invitation

On the start page, under **Start a private data exchange**, choose **Create an invitation**.

### 2. Your file

Screen: Step 1 of 3 - Your file

Enter **Your name or agency**. Your partner sees it in the terms.
Leave **How your file separates fields** at **Comma** unless your file uses tabs, pipes or semicolons.
Under **Choose a file from your folder**, choose **Select** beside your CSV file, check the columns and sample values it shows, and choose **Use this file**.
Choose **Continue to matching & sharing**.

### 3. Matching & sharing

Screen: Step 2 of 3 - Matching & sharing

Set the two choices at the top:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Matching method**: **Reveal the matched identifiers (standard)** | Matches records and writes a result file | Usual |
| **Reveal only the count (psi-c)** | Reports only how many records you have in common | You agreed on a count only ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)) |
| **Who receives the matched results**: **You and your partner** | Both of you get the result | Usual ([Who receives the result](./agree-on-terms.md#who-receives-the-result)) |
| **Only you** or **Only your partner** | One of you gets it. The other still contributes records and sees **Results withheld by the terms** ([What each party learns](./agree-on-terms.md#what-each-party-learns)) | You agreed on one side only |

Alcove fills in each column's type and use from its name. It sends nothing by default, your ID column included.

**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**. Your result then starts each row with your own ID, and your partner never receives it. Alcove recognizes common ID names, such as `id`, `Client ID`, `MRN`, and `case_number` ([inference table](../EXCHANGE_REFERENCE.md#input-metadata)), and starts the first one as **Unique record identifier - not sent**, taking a record number such as `case_number` only when the file has no other ID column. To send your ID for matched records, choose **Unique record identifier - sent to your partner**. A column the app does not recognize starts as **Ignored**. With no column set as your ID, your result holds row numbers only, counting from 0.

Change **How it is used** only as you agreed ([What each of you sends](./agree-on-terms.md#what-each-of-you-sends)):

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Matches on the column and never sends it | Usual: names, date of birth, SSN, ZIP code |
| **Used to match - sent to your partner** | Matches on it, and sends its value for matched records | Your partner agreed to receive this column |
| **Unique record identifier - not sent** | Starts each row of your result with your own ID | Usual: your own ID column, whatever it is called |
| **Unique record identifier - sent to your partner** | Does the same, and sends the ID for matched records | Your partner agreed to receive your IDs |
| **Sent to your partner** | Sends the value for matched records; not used to match | Your partner agreed to receive this column |
| **Ignored** | Neither matches on it nor sends it | Usual: every other column |

Under **Your own columns in the result**, leave **Nothing of mine - my partner's values only** unless you want more of your own columns in your result file. It changes nothing your partner sees.
Choose **Continue to review & create**.

### 4. Review & create

Screen: Step 3 of 3 - Review & create

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Invitation duration**: **1 hour** | Your partner must accept within 1 hour | Usual: your partner is ready to accept now |
| **Invitation duration**: **6 hours**, **1 day**, **7 days**, **30 days** or **1 year** | Gives your partner longer to accept | Your partner accepts later |

If you agreed on a count only, other built-in rules, or a different strategy, choose **Change** beside **Matching keys** under **Exchange proposal**. That opens **Matching keys**, with **Built-in rules** (default **Broader matching**) and **Linkage strategy** (default **Cascade**). For a count only, untick each key with a name containing `split(`, `swap(`, `+/-` or `day/month exchanged`. Choose **Back to Review & create** when done. What each one means: [Agree on terms](./agree-on-terms.md#where-each-decision-is-set).

Under **How will this exchange run?**, choose your channel:

::: tabs channel

== SFTP

Choose **Over SFTP, run here**, then **Add connection**, and fill in your own account on the server:

- **SFTP server address**: the host only, such as `sftp.example.org`. For a port other than 22, choose **Advanced** and fill in **Port**.
- **Username**: your account on the server.
- **Remote directory**: the folder on the server both of you use, such as `/exchanges/state-county`.
- **Server identity fingerprint**: ask whoever runs the server. It starts with `SHA256:`. Or choose **Read the fingerprint from the server**, compare what it shows with theirs, and choose **Use this fingerprint**.
- **How Alcove signs in**: **Password** or **Private key**. Choose **Choose the credential file**, then **Use this file** beside your password or key file.

Choose **Save connection**. The card shows **READY TO TRY**.
The invitation holds the server and directory, never your credentials. Your partner signs in with their own account.

== Shared folder

Choose **Over a shared folder, run here**. It uses the shared folder you added when you started the console ([Your working folder](./console-start.md#your-working-folder)). Your partner uses the same folder from their side.

== WebRTC

Choose **Over WebRTC, run here**, then **Use the Alcove web app's server**. It fills in `https://psi.data-bridge.org`: your partner can accept in the web app there, and the server sees both of your network addresses, not your data.
To use another coordination server, type its `wss://` address under **Coordination server or web app address** and choose **Set address and relay**.

:::

Check each line under **Exchange proposal**. Creating the invitation seals the terms.
Choose **Create the invitation**.

### 5. Send the invitation

Screen: Your invitation is ready - Share this invitation

Under **Invitation as text**, choose **Show full invitation**, then **Copy**. Send it to your partner over a channel you trust, such as secure email.
Send the text. A link on this screen that starts `http://127.0.0.1` opens only on your computer.

| Your partner uses | Send them |
| --- | --- |
| The console | The invitation text, and [Accept in the console](./console-accept.md) |
| The command line | The invitation text and [Accept an invitation](./cli-accept.md). For SFTP or a shared folder, also the file from **Download instructions for your partner** (`alcove-accept-instructions-<date>.txt`) |
| The web app (WebRTC only) | The invitation text, and [Accept with the web app](./web-accept.md) |

> [!WARNING]
> The invitation holds a one-time secret: anyone who has it can take your partner's place. Send it only over a channel you trust. The instructions file holds no secret.

### 6. Both of you: run the exchange

Your console starts waiting as soon as you create the invitation. It waits 1 hour over SFTP or a shared folder, 10 minutes over WebRTC, so agree on the time.
Keep the console running. You can leave the page: the run keeps going, and the start page brings you back to it.
The status panel shows **Getting ready**, **Checking settings match**, then **Matching records (key 1 of 30)** and on through each key.

You should see: **Exchange complete - 41 matched records**, with **Download result** below it. 41 is the count for the sample files.
If the terms give you no result, you see **Exchange complete** and **Results withheld by the terms**, with no list and no count.

If your partner does not start within the wait, the screen shows **Your partner did not arrive** with **Try again**. Once the invitation has expired, create a new one.

## What you get

The result screen offers the downloads. The same files are in this run's folder inside your working folder, named by the run's id, such as `0770d1b1-eeb2-4882-9cfe-4073136b871d`:

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
> **Set up another exchange** and **Discard** delete this run's folder, `.alcove.key` included. Copy out what you need first. Restarting the console cancels a running exchange and forgets it ([Stop or restart the console](./console-start.md#stop-or-restart-the-console)).

If you run the SFTP server yourself, set it up as [If you run the SFTP server](./cli-invite.md#if-you-run-the-sftp-server) shows.

More detail: [Every file a run writes](../CONSOLE.md#where-a-runs-files-land), [What the instructions file tells your partner](../CONSOLE.md#sending-the-partner-an-accept-kit).
