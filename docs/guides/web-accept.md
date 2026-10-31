---
reader: An analyst who was sent an invitation to an exchange in the web app
needs: The invitation link from your partner; a CSV file with a header row, up to 200 MB; a time when your partner's page is open
before: "[Agree on terms](./agree-on-terms.md)"
partner: "[Invite with the web app](./web-invite.md)"
next: "[Run it on a schedule](./web-schedule.md)"
---

# Accept with the web app

Review your partner's invitation at [psi.data-bridge.org](https://psi.data-bridge.org/), consent, and run the exchange from your browser.

## Before you open the link

- **Ask your partner for a web app invitation.** The web app accepts an invitation your partner created with **Live, in this browser**, or a WebRTC invitation from the console or the command line ([If your partner uses the console or the web app](./cli-invite.md#if-your-partner-uses-the-console-or-the-web-app)). Any other invitation stops with "This invitation does not include a connection endpoint this build can accept, so it cannot be run here." Which app accepts what: [Your partner uses a different app](./index.md#your-partner-uses-a-different-app).
- **Agree on a time.** Your partner's page must be open while you accept and run. It waits 10 minutes, and your partner can choose **Keep waiting** to listen again.
- **Know what you agreed on.** Check each term against [Agree on terms](./agree-on-terms.md) as you go.

To practice first with sample data, follow [Practice with sample data](./web-invite.md#practice-with-sample-data): you play both parties.

## Accept the invitation

### 1. Open the link

Open the link your partner sent.
If your partner sent the invitation as text rather than a link, or the link arrived in pieces, paste it under **Have an invitation? Paste it here** on the start page and choose **Review invitation**.

### 2. Review the terms

Screen: Step 1 of 3 - Invitation from (your partner's name)

Alcove does not verify the name shown: your partner typed it. If the invitation names a legal agreement, check it against the one you signed.
Read each section against what you agreed on:

- **What you will send to your partner**: the columns that leave your file, for matched records only.
- **Matching method**: a list of matched records, or "Only the number of records you have in common is revealed" for a count only ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)).
- **Result sharing**: "You will receive the matched result" and "Your partner (the inviter) will receive the result", each Yes or No ([Who receives the result](./agree-on-terms.md#who-receives-the-result)).
- **Matching strategies**: the fields you match on. If the screen says some keys are marked less certain, open **Matching strategies** to see which ([What you match on](./agree-on-terms.md#what-you-match-on)).

Open **Other details** and leave **Let several of my records match one of my partner's** unticked unless you agreed otherwise. **Other details** also lists the personal data used, any allowed-character rules your partner set, and notes on fields with several values per record: ask your partner about anything you did not agree on.
If anything differs from what you agreed on, stop and ask your partner for a new invitation. Otherwise choose **Continue: consent & your file**.

### 3. Consent & your file

Screen: Step 2 of 3 - Consent & your file

Tick **I have reviewed the terms my partner proposed and I consent to this exchange**.
Enter **Your name or agency**. Your partner sees it.
Drag your CSV onto the page, or select it to browse. Leave **How your file separates fields** at **Comma** unless your file uses tabs, pipes or semicolons.
Choose **Accept and continue**.

### 4. Confirm your columns

Screen: Step 3 of 3 - Confirm your columns

Check that the screen says every key can match, such as "All 30 keys can match".
Alcove fills in each column's type and use from its name. It sends nothing by default, your ID column included.

**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**. Your result then starts each row with your own ID, and your partner never receives it. Alcove recognizes common ID names, such as `id`, `Client ID`, `MRN`, and `case_number` ([inference table](../EXCHANGE_REFERENCE.md#input-metadata)), and starts the first one as **Unique record identifier - not sent**, taking a record number such as `case_number` only when the file has no other ID column. To send your ID for matched records, choose **Unique record identifier - sent to your partner**. A column the app does not recognize starts as **Ignored**. With no column set as your ID, your result holds row numbers only, counting from 0.

Change any other column's use only as you agreed:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Matches on the column and never sends it | Usual: names, date of birth, SSN, ZIP code |
| **Used to match - sent to your partner** | Matches on it, and sends its value for matched records | Your partner agreed to receive this column |
| **Unique record identifier - not sent** | Starts each row of your result with your own ID | Usual: your own ID column, whatever it is called |
| **Unique record identifier - sent to your partner** | Does the same, and sends the ID for matched records | Your partner agreed to receive your IDs |
| **Sent to your partner** | Sends the value for matched records; not used to match | Your partner agreed to receive this column |
| **Ignored** | Neither matches on it nor sends it | Usual: every other column |

A use ending "sent to your partner" sends that column for matched records. If your partner receives no result, the screen says nothing is sent, whatever you choose.

### 5. Start the exchange

Choose **Start the exchange**. The status panel shows **Connecting to your partner**, then **Checking settings match**, then **Matching records** with a count of keys.

> [!WARNING]
> Keep this tab open until the exchange completes: closing or reloading either tab stops it for both of you.

If your partner's page is not open, the screen shows **Your partner's page did not answer**. Ask your partner to open their invitation page again, then choose **Keep waiting**. If they no longer have it, ask them for a new invitation.

You should see: **Exchange complete** with the downloads below.

## What you get

**Exchange complete** lists a download for each file:

| File | What it holds | Share or keep |
| --- | --- | --- |
| `results.csv` (**Download result**) | One row per matched record: your ID, `row_id` (your partner's row number, counting from 0, so row 0 is the first data row, row 2 in Excel), and the columns your partner sends. With no ID column set, `row_id` is your own row number and `their_row_id` your partner's. | Keep private |
| `alcove-record-<time>.json` (**Download record (safe to share)**) | What you and your partner agreed to and what matched, for your disclosure log | Keep; not secret |
| `alcove-record-<time>.keys.json` (**Download verification keys**, marked keep private) | The keys that check the record against your files. They cannot be recreated. | Keep private |

Two outcomes have no `results.csv`:

- **Count only**: the screen reads "Exchange complete - count only" and gives the number of records in common. If your partner computed it, the screen says the figure is your partner's word for it.
- **Results withheld by the terms**: the terms give you no result, so the screen shows no list and no count. You still get the record and its keys.

> [!NOTE]
> The files exist only in this page. Download each one before you close the tab or choose **Set up another exchange**.

To run the same exchange again with this partner, follow [Run it on a schedule](./web-schedule.md) before you leave this screen: the save offer appears only here.

More detail: [How to check a record against your files later](../WEB_APP.md#checking-a-record-later).

## If the link does not open

**Cannot accept this invitation** comes with one of these:

| The screen says | What to do |
| --- | --- |
| "This link looks incomplete or changed in transit." | Copy the whole link from your partner's message again and paste it under **Have an invitation? Paste it here**, or ask your partner to send it again. |
| "This invitation has expired. Ask your partner to send a new one." | Ask your partner for a new invitation. |
| "This invitation does not include a connection endpoint this build can accept, so it cannot be run here." | Your partner made it for SFTP or a shared folder. Ask for a **Live, in this browser** invitation, or use another app ([Your partner uses a different app](./index.md#your-partner-uses-a-different-app)). |
