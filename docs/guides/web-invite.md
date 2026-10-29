---
reader: An analyst who invites a partner to an exchange
needs: A CSV file with a header row, up to 200 MB; a partner who uses the web app; a trusted channel such as secure email
before: "[Agree on terms](./agree-on-terms.md)"
partner: "[Accept with the web app](./web-accept.md)"
timing: The invitation lasts 1 hour unless you choose longer. Your page waits 10 minutes for your partner each time it listens. Measured runs, both browsers on one computer - sample files of 100 and 200 rows took 6 to 10 seconds; 10,000 records a side took 4 minutes 44 seconds.
next: "[Run it on a schedule](./web-schedule.md)"
---

# Invite with the web app

Create an invitation at [psi.data-bridge.org](https://psi.data-bridge.org/), send it to your partner, and run the exchange with both of your pages open.

## Practice with sample data

Try the whole exchange alone first, playing both parties.

### 1. Open the sample invitation

On the start page, choose **See how it works with example data**.
The invite screen opens with the sample file `alcove-sample-inviter.csv` (100 rows) loaded and the name Sample County Agency filled in.

### 2. Create it

Choose **Continue to matching & sharing**, then **Continue to review & create**.
To accept in a different browser, choose **download the partner CSV** in the side panel now: it saves `alcove-sample-partner.csv` (200 rows), and the link is gone once the invitation exists.
Choose **Create the invitation**.

### 3. Accept it as your partner

Choose **Copy** beside **Invitation as a link**, and leave this tab open: reloading it starts the practice over.

- **In another tab of this browser:** open the invitation link. On **Consent & your file**, tick the consent box, enter any name, and choose **Use the sample partner file**.
- **In a different browser:** open the link there, and on **Consent & your file** choose `alcove-sample-partner.csv`.

Then choose **Accept and continue** and **Start the exchange**.

You should see: **Exchange complete - 41 matched records** in both tabs.

A practice run does not offer **Save as a recurring exchange**, and nothing from it carries over. For the real run, create a new invitation from your own file.

## Create the invitation

On the start page, choose **Create an invitation**.

### 1. Your file

Screen: Step 1 of 3 - Your file

Enter **Your name or agency**. Your partner sees it in the invitation.
Drag your CSV onto the page, or select it to browse.
Leave **How your file separates fields** at **Comma** unless your file uses tabs, pipes or semicolons.
If the screen lists **Problems** such as "produces no value in any row", Alcove found no usable value in that column, so it cannot match on it. Check the column; made-up test values such as `123-45-6789` are rejected.
Choose **Continue to matching & sharing**.

### 2. Matching & sharing

Screen: Step 2 of 3 - Matching & sharing

**Matching method**: leave **Reveal the matched identifiers (standard)** for a list of matched records. For a count only, choose **Reveal only the count (psi-c)**, then untick every key but one on **Matching keys** (step 3 below; [A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)).

**Who receives the matched results** ([Who receives the result](./agree-on-terms.md#who-receives-the-result)):

| Option | What it does | Pick it when |
| --- | --- | --- |
| **You and your partner** | Both of you get the result | Usual: both of you need the matches |
| **Only you** | Your partner gets "Results withheld by the terms" | Only you need the matches. What your partner can still learn: [What each party learns](./agree-on-terms.md#what-each-party-learns). |
| **Only your partner** | You get "Results withheld by the terms" | Only your partner needs them |

Alcove fills in each column's type and use from its name. It sends nothing by default, your ID column included.

**Your ID column.** Set your own ID column, whatever it is called, to **Unique record identifier - not sent**. Your result then starts each row with your own ID, and your partner never receives it. Alcove recognizes common ID names, such as `id`, `Client ID`, `MRN`, and `case_number` ([inference table](../EXCHANGE_REFERENCE.md#input-metadata)), and starts the first one as **Unique record identifier - not sent**, taking a record number such as `case_number` only when the file has no other ID column. To send your ID for matched records, choose **Unique record identifier - sent to your partner**. A column the app does not recognize starts as **Ignored**. With no column set as your ID, your result holds row numbers only, counting from 0.

Change any other column's use only as you agreed ([What each of you sends](./agree-on-terms.md#what-each-of-you-sends)).

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Used to match - not sent** | Matches on the column and never sends it | Usual: names, date of birth, SSN, ZIP code |
| **Used to match - sent to your partner** | Matches on it, and sends its value for matched records | Your partner agreed to receive this column |
| **Unique record identifier - not sent** | Starts each row of your result with your own ID | Usual: your own ID column, whatever it is called |
| **Unique record identifier - sent to your partner** | Does the same, and sends the ID for matched records | Your partner agreed to receive your IDs |
| **Sent to your partner** | Sends the value for matched records; not used to match | Your partner agreed to receive this column |
| **Ignored** | Neither matches on it nor sends it | Usual: every other column |

**Your own columns in the result** changes only your own result file, never what your partner gets:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Nothing of mine - my partner's values only** | Your result holds your ID, your partner's row number, and what your partner sends | Usual: you can join the result back to your file by ID |
| **The columns I send my partner** | Adds the columns you send | You want them beside each match |
| **Every column of my file** | Adds all your columns | You want a self-contained result file |

**The key each match was made on** adds a column naming the key each match was made on. Leave it as you like: it changes only your own result.

Choose **Continue to review & create**.

### 3. Matching keys, if you agreed on something other than the default

In the side panel, under **Customize**, choose **Matching keys**. The **Matching keys** screen opens.

- **Built-in rules**: **Broader matching** is the default; **Highest precision** keeps only the most precise keys. Untick any key you agreed to leave out ([What you match on](./agree-on-terms.md#what-you-match-on)).
- For a count only, untick every key but one. Keep the first key in the list whose columns both files fill for most records ([A list or only a count](./agree-on-terms.md#a-list-or-only-a-count)).

Choose **Back to Review & create**.

### 4. Review & create

Screen: Step 3 of 3 - Review & create

**Invitation duration** sets how long your partner can accept:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **1 hour** | The invitation expires 1 hour after you create it | Usual: you have agreed on a time with your partner |
| **6 hours**, **1 day**, **7 days**, **30 days**, **1 year** | The invitation lasts that long | You cannot agree on a time within the hour |

**How will this exchange run?**:

| Option | What it does | Pick it when |
| --- | --- | --- |
| **Live, in this browser** | Your browsers connect directly | Usual: your partner uses the web app |
| **Over SFTP, run by the Alcove command-line tool** | Saves an exchange file for the command line | Your side runs on the command line ([Your partner uses a different app](./index.md#your-partner-uses-a-different-app)) |
| **Over a shared folder, run by the command-line tool** | Saves an exchange file for the command line | The same, through a shared folder |

Check each line under **Exchange proposal**, then choose **Create the invitation**.

> [!WARNING]
> Creating the invitation seals the terms. To change any term afterwards, create a new invitation.

### 5. Send the invitation

Screen: Your invitation is ready

Choose **Copy** beside **A message to send**. The message holds the link, when it expires, and a note that your page must stay open.
The link is about 10,000 characters long, so send it as text over your trusted channel, such as secure email. It holds a one-time secret: anyone who has it can take your partner's place.
Send your partner this page's companion too: [Accept with the web app](./web-accept.md).

> [!WARNING]
> Keep this tab open: closing it cancels the invitation. During the exchange, closing or reloading either tab stops it for both of you.

### 6. Your partner: open the link while your page waits

The page waits 10 minutes for your partner and shows the time it stops, as "This page waits until 10:24 AM for your partner to connect".
If your partner has not connected by then, the page shows **Your partner did not connect**. Agree on a time, then choose **Keep waiting** to listen again.
Once the invitation has expired, choose **Start over with a fresh invitation** and send the new one.
If you reload the page, it shows **Your invitation is still open**: choose **Choose the file again** and pick the same file to keep waiting.

The exchange starts when your partner chooses **Start the exchange**.

You should see: **Exchange complete** with the downloads below.

## What you get

**Exchange complete** lists a download for each file:

| File | What it holds | Share or keep |
| --- | --- | --- |
| `results.csv` (**Download result**) | One row per matched record: your ID, `row_id` (your partner's row number, counting from 0, so row 0 is the first data row, row 2 in Excel), and the columns your partner sends. With no ID column set, `row_id` is your own row number and `their_row_id` your partner's. | Keep private |
| `alcove-record-<time>.json` (**Download record (safe to share)**) | What you and your partner agreed to and what matched, for your disclosure log | Keep; not secret |
| `alcove-record-<time>.keys.json` (**Download verification keys**, marked keep private) | The keys that check the record against your files. They cannot be recreated. | Keep private |

Use your ID to join the result back to your file; you can ignore `row_id`.

Two outcomes have no `results.csv`:

- **Count only**: the screen reads "Exchange complete - count only" and gives the number of records in common. If your partner computed it, the screen says the figure is your partner's word for it.
- **Results withheld by the terms**: the terms give you no result, so the screen shows no list and no count. You still get the record and its keys.

> [!NOTE]
> The files exist only in this page. Download each one before you close the tab or choose **Set up another exchange**.

Keep the record, keys, input and result together as long as your records schedule requires.

To run the same exchange again with this partner, follow [Run it on a schedule](./web-schedule.md) before you leave this screen: the save offer appears only here.

More detail: [How to check a record against your files later](../WEB_APP.md#checking-a-record-later), [How large a file the web app can match](../DEPLOYMENT.md#how-large-an-exchange-can-be).
