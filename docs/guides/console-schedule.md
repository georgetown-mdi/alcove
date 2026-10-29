---
reader: A console user whose exchange worked and who wants it to run on a schedule
needs: A finished console run whose result screen is still open, and the cadence and time you agreed on with your partner
before: "[Invite from the console](./console-invite.md) or [Accept in the console](./console-accept.md)"
partner: "[Schedule it](./cli-schedule.md) on the command line, or [Run it on a schedule](./web-schedule.md) in the web app"
timing: Each scheduled run waits 1 hour for your partner over SFTP or a shared folder, 10 minutes over WebRTC. Measured - sample files of 100 and 200 records, 30 keys, over SFTP - 15.5 minutes a run.
next: "[Schedule it](./cli-schedule.md) on the command line, for cadences, failure signals and exit codes"
---

# Move it to a schedule

Copy the exchange from the console to the command line, and have cron or the Windows Task Scheduler run it at the time you agreed on with your partner.

## The scheduling machine

From now on, only this machine runs the exchange. It can be the same computer as the console. At the agreed time, it must:

- be on and awake, with Docker running;
- run the job as an account that owns the exchange folder and `.alcove.key`;
- reach the SFTP server, shared folder or coordination server;
- run at the same time as your partner's side, since both of you run at once.

On Windows with Docker Desktop: a task that runs while no one is signed in has not been tested. Keep the task's account signed in, Docker Desktop running and the computer awake at the scheduled time, or schedule on a server instead. If you cannot, run the command under **Run the exchange** by hand at the agreed time each period.

Stop running this exchange in the console once you schedule it: the secret in `.alcove.key` changes at every run, so a second copy falls out of step with your partner.

## Copy it from the console

### 1. Open the schedule panel

On the result screen, find **Run this exchange on a schedule**. While the run is going it is a collapsed section, **Run this on a schedule**.
It fills in this exchange's settings, and shows paths on the scheduling machine as placeholders such as `/path/to/your/exchange-folder`.

> [!WARNING]
> Do this before you choose **Set up another exchange** or **Discard**: both delete the run's folder and its `.alcove.key`.

### 2. Make the exchange folder

Make one folder on the scheduling machine for this exchange, such as `C:\alcove\state-county` or `/srv/alcove/state-county`. Then put three things in it:

- **The configuration.** Under **Save this as alcove.yaml in a folder on the scheduling machine**, choose **Copy** and save it as `alcove.yaml`. For a WebRTC exchange the panel shows none: copy `alcove.yaml` from your working folder instead.
- **Your input file**, under the name the panel gives in **Put your input file in that folder as**. Replace it with current data before each run. Whatever produces your extract must save it there before the scheduled time; Alcove does not fetch it. A run with no input file exits 66 (`0x42` in Task Scheduler).
- **The shared secret.** Under **Copy the shared secret into that folder**, the panel names where `.alcove.key` is. Copy it as it stands after your last run here, and make it readable only by you.

Where `.alcove.key` is:

| Run | `.alcove.key` is in |
| --- | --- |
| SFTP or shared folder | The run's folder in your working folder, such as `aea282aa-f2d3-40fc-b3de-e84c74ceb416` |
| WebRTC | Your working folder, beside `alcove.yaml` |

### 3. Set the paths under Before you schedule it

**Before you schedule it** lists each path to set on the scheduling machine.
For SFTP, it says "the credential path is a placeholder": in `alcove.yaml`, the line `password: "@/path/to/your/credential-file"` (or `private_key:`) must name your password or key file on the scheduling machine.
The host key is already pinned, so scheduled runs connect without a prompt.

Set each path the same way in the commands, then:

::: tabs platform

== Windows

The Task Scheduler line mounts only the exchange folder. For a password file at `C:\alcove\secrets\sftp-password.txt`, set `password: "@/secrets/sftp-password.txt"` in `alcove.yaml`, and add this before the image name in the line:

```text
--mount type=bind,src=C:\alcove\secrets\sftp-password.txt,dst=/secrets/sftp-password.txt,readonly
```

For WebRTC, add no mount. For a shared folder, add one for the shared folder instead, mounted at the path `alcove.yaml` gives under `connection.path`, as **Before you schedule it** lists: `--mount "type=bind,src=D:\shares\state-county,dst=<that path>"`.

== macOS

Replace `/path/to/your/credential-file` in `alcove.yaml` and in each Docker command with the real path, such as `/Users/you/alcove-secrets/sftp-password.txt`. The commands mount it at that same path.

== Linux

Replace `/path/to/your/credential-file` in `alcove.yaml` and in each Docker command with the real path, such as `/home/you/alcove-secrets/sftp-password.txt`. The commands mount it at that same path.

:::

Replace `/path/to/your/exchange-folder` in each command with your exchange folder.

### 4. Both of you: run it once by hand

At a time agreed on with your partner, run the exchange once from a terminal on the scheduling machine.

::: tabs platform

== Windows

The panel shows the **Run the exchange** command for Windows too, labeled **Windows (in PowerShell)**. Run it with your exchange folder and the credential mount from step 3, keeping the panel's arguments after the image name:

```powershell
docker run --rm --mount "type=bind,src=C:\alcove\state-county,dst=/work" --mount "type=bind,src=C:\alcove\secrets\sftp-password.txt,dst=/secrets/sftp-password.txt,readonly" ghcr.io/georgetown-mdi/alcove:latest exchange --log-file=exchange.log alcove-sample-partner.csv ./
```

Use your input file's name from the panel in place of `alcove-sample-partner.csv`. For WebRTC, leave out the second `--mount`. For a shared folder, replace it with one for the shared folder, mounted at the path `alcove.yaml` gives under `connection.path`, as **Before you schedule it** lists: `--mount "type=bind,src=D:\shares\state-county,dst=<that path>"`.

== macOS

Run the **Linux/macOS** command under **Run the exchange**, with the paths you set in step 3.

== Linux

Run the **Linux/macOS** command under **Run the exchange**, with the paths you set in step 3. It runs Alcove as your own account, so it can write your folder. With rootless Podman, run the Podman command printed after the schedule lines instead.

:::

You should see: a new `alcove-results-<time>.csv` in the exchange folder, and the run's log in `exchange.log`.

### 5. Schedule it at your cadence

Under **Schedule it (set the time you agreed with your partner)**, the panel gives two Docker lines, both daily at 2am:

- **cron (Linux/macOS), daily at 2am, running Alcove from its Docker image**
- **Windows Task Scheduler (in PowerShell), daily at 2am, running Alcove from its Docker image**

It offers no other cadence. For weekly, monthly or quarterly, replace the cron `0 2 * * *` with the row for your cadence in [Cadences](./cli-schedule.md#cadences). Your partner uses the same row and time.
In the Task Scheduler command, for weekly on Mondays replace `-Daily` with `-Weekly -DaysOfWeek Monday`. It has no monthly option: for monthly or quarterly, write a `schtasks` line instead, as [Schedule it](./cli-schedule.md#1-write-the-schedule-line) shows.
Add the cron line with `crontab -e`, or run the Task Scheduler command once in PowerShell.
On Linux and macOS, the cron line names `/usr/bin/docker`. A scheduled job does not use your shell's PATH, so check where Docker is with `command -v docker` and correct the line if it differs. With rootless Podman, use the Podman cron line printed after the schedule lines, and check `command -v podman` the same way.

The configuration the console writes sets no inactivity limit on the secret, so a missed run does not end the exchange.

## What you get

Each scheduled run writes its files into the exchange folder, under that run's time:

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<time>.csv` | That run's matched records | Keep private |
| `alcove-record-<time>.json` | What that run disclosed, for your disclosure log | Keep; not secret |
| `alcove-record-<time>.keys.json` | The keys that check that run's record | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' agreed terms | Keep; not secret |
| `exchange.log` | Every run's log, added to each time | Keep private |
| `.alcove.key` | The shared secret, replaced at every run | Keep private |

A run does not overwrite the last one's files.
On Windows, check the task's **Last Run Result** in Task Scheduler after each run: `0x0` is success, `0x42` means the input file was missing, `0x45` that the server or your partner was not reached. All codes: [Exit codes](./cli-schedule.md#exit-codes).
For failure alerts, see [Schedule it](./cli-schedule.md) on the command line.

More detail: [What the scheduling machine needs](../CLI.md#scheduling-the-run), [Moving the key file to another machine](../CLI.md#the-key-file-on-the-scheduling-machine).
