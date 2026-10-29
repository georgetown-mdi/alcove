---
reader: Both partners, after a first exchange in the web app
needs: The completion screen of an exchange that was not a practice run; a desktop computer with Chrome or Edge for runs with nobody present
before: "[Invite with the web app](./web-invite.md)"
timing: A window opens every 1 to 366 days and stays open 1 to 12 hours. Both of you must be running during the same window.
---

# Run it on a schedule

Save an exchange in your browser and have the installed Alcove app run it with your partner at agreed windows, such as once a quarter, with no new invitation.

The computer that runs it must be:

- A desktop computer with Chrome or Edge, using the same browser profile as when you saved the exchange, in an ordinary window, not Incognito or Guest.
- Running Alcove installed from the browser as an app (step 6), with this exchange saved in it, during each window.
- Awake and online for the whole window.

If this computer is off or asleep in the window, that period's run is missed ([When a run is missed](./web-schedule.md#when-a-run-is-missed)).

## Set it up

### 1. Each of you: save the exchange

On the **Exchange complete** screen, under **Save as a recurring exchange**:

- Enter a **Label**, such as "Quarterly match". Your partner never sees it; it names your results and backup files.
- Leave **Shared secret expires after inactivity** unticked ([The shared secret's inactivity limit](./web-schedule.md#the-shared-secrets-inactivity-limit)).
- Add a **Retention note** if your records schedule needs one. It is never sent to your partner.

Choose **Save as a recurring exchange**. A practice run with sample data does not offer this.

You should see: "Saved as a recurring exchange."

From then on, the start page opens on **Recurring exchanges**. Choose **Run** (or **Open**) beside the label to open the exchange's page.

### 2. Both of you: agree on the schedule

Agree on four values over your usual channel: the date and time of the first window, how many days apart windows open, and how many hours each stays open.
A window is counted in days from the first one, not by the calendar:

| Cadence | **A window opens every (days)** |
| --- | --- |
| Weekly | `7` |
| Every four weeks | `28` |
| Quarterly | `91` |
| Twice a year | `182` |

Make the window hours long, not minutes: it absorbs the difference between your two computers' clocks. A window of `8` hours covers a working day.

### 3. You: enter the schedule and choose the folder

One of you, usually the inviter, does this first. On the exchange's page, under **Local settings**, tick **Run this exchange on an agreed schedule** and fill in:

| Field | What to enter | Quarterly example |
| --- | --- | --- |
| **First agreed run window (date)** | The first window's date, on your own calendar | January 4, 2027 |
| **Time the window opens** | On your own clock | 9:00 AM |
| **A window opens every (days)** | 1 to 366 | `91` |
| **Each window stays open (hours)** | 1 to 12 | `8` |

Check the line under the fields, such as "The first window opens January 4, 2027 at 9:00 AM PST."
Under **Folder**, choose **Choose folder**. Pick a folder only you can read, used for nothing else: Alcove can read and write every file in it.
Choose **Save settings**.

You should see: a **Run schedule** section with "Next run window" and "A run window opens every 91 days and stays open 8 hours."

### 4. You: send the schedule

Under **Copy this schedule for your partner**, choose **Copy** and send the text to your partner. It holds no secret and no invitation, and it states the next window in UTC.

### 5. Your partner: fill in from the schedule

On their exchange's page, under **Local settings**, your partner ticks **Run this exchange on an agreed schedule**.
They paste the text into **Your partner's schedule** and choose **Fill in from this schedule**, which converts the window to their own clock.
Under **Folder**, they choose **Choose folder**, then **Save settings**.

You should see: on both pages, the same **Next run window**, each on its own clock.

### 6. Each of you: keep it running

Once the schedule is saved, **Keep it running** appears on the exchange's page.
Choose **Install Alcove**. If there is no button, the page says "To install Alcove, open your browser's menu and choose to install it".
Open this exchange in the installed app. Turn on start at sign-in from the installed app's menu, or open the app before each window.
Choose **Check readiness for the next window**.

> [!NOTE]
> Firefox and Safari cannot hold a folder for a site. In them, a window passes with no run unless you open the exchange and run it yourself, choosing the file each time.

### 7. Each of you: back up the exchange

Under **Back up this exchange.**, choose **Download a backup**. The file is `alcove-backup-<label>-<date and time>.json`.

> [!WARNING]
> The backup holds the exchange's shared secret in plain text. Keep it where only you can read it, and never send it over an unencrypted channel.

The browser can lose a saved exchange, for example when someone clears the site's data. To bring it back, choose **Import a file** on **Recurring exchanges** and choose the backup.
After a run you start yourself, the page may offer **Download updated backup**. Choose it: the run changed the shared secret, so the earlier backup is out of date.

## Each period

### 1. Each of you: put the new file in the folder

Before each window, save the period's data in the folder as `input.csv`, replacing the last period's file. Every run reads `input.csv` and leaves it in place.

### 2. Both of you: leave the app running through the window

During the window, each app runs the exchange with no one present.

You should see: the run listed under **Run history** on the exchange's page.

## What you get

Each scheduled run that succeeds writes into the folder:

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<label>-<date and time>.csv` | This run's matched records. Each run writes a new file, so earlier results stay. | Keep private |
| `alcove-backup-<label>-<date and time>.json` | The exchange and its new shared secret. It replaces the backup the previous run wrote. | Keep private |
| `input.csv` | Your data for the period, read and left in place | Keep private |

A run you start yourself writes the results file only, and offers **Download updated backup**: choose it.

The first run may show **The exchange reported a warning** about which columns your partner sends. It records that list, and later runs refuse a different one. Nothing to do if the list is what you agreed on.

If the folder could not be written, the exchange's page says "Results ready to download" and keeps the results in this browser for 30 days.

## Run it by hand instead

### 1. Each of you: run it together each period

If you cannot install the app or keep the computer on, run each period by hand. You need not tick **Run this exchange on an agreed schedule**.
Once, at the top of the exchange's page, under "Choose this exchange's folder.", choose **Choose folder**. **Run exchange** stays greyed out until a folder is chosen.
Each period, agree on a time with your partner, put the new `input.csv` in the folder, and each of you choose **Run exchange** on the exchange's page.

You should see: **Run complete**, the downloads, and a line naming the results file written to the folder you chose.

## When a run is missed

"Your partner did not arrive" means nothing was exchanged and nothing left your computer. The app tries again at the next window, and no sooner: for a quarterly exchange, that is 91 days later.

To run before then, agree on a time with your partner and each choose **Run exchange** on the exchange's page, once a folder is chosen.
If misses repeat, compare the two schedules line by line, using the UTC time in **Copy this schedule for your partner**, and check this computer's clock.
If your partner was running in the window and misses continue, choose **Re-invite with the same terms**: the exchange keeps its terms and gets a new shared secret. Your partner accepts the new invitation ([Accept with the web app](./web-accept.md)), saves it as a recurring exchange, sets the schedule and folder again, and removes the old one under **Recurring exchanges**: the new one is a separate entry.

More detail: [How retries and repeated misses work](../MANAGED_EXCHANGE.md#retry-and-repeated-misses).

## The shared secret's inactivity limit

**Shared secret expires after inactivity** is off by default, and the page says "The shared secret does not expire."
Ticked, it starts at 90 days and the page says "This exchange must run within 90 days, or its shared secret expires and you re-invite your partner." The count restarts at each successful run.
For a quarterly exchange, leave it off. If your policy needs a limit, set **Days of inactivity** above two intervals, such as `200` for a 91-day cadence, so one missed window does not expire it.

More detail: [How a saved exchange survives the browser clearing its storage](../MANAGED_EXCHANGE.md#surviving-storage-eviction), [Moving the exchange to another computer](../MANAGED_EXCHANGE.md#moving-the-exchange-to-another-device).
