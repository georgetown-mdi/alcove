---
reader: An IT engineer at either party who has run the exchange once by hand
needs: "A first exchange that succeeded, from [Invite a partner](./cli-invite.md) or [Accept an invitation](./cli-accept.md)"
---

# Schedule it

Run the exchange on a cadence from cron or the Windows Task Scheduler, and act on each run's exit code.

## Before you schedule

- **A run by hand succeeded**, for both of you.
- **On SFTP, pin the host key.** The first run by hand saves it in `alcove.yaml`. A scheduled run with none exits 64 rather than ask.
- **Agree on the time with your partner.** Both of you schedule the same start. Each run waits 1 hour for the other (10 minutes on WebRTC), so your two starts must fall within that time. cron and the Task Scheduler use the machine's local time zone.
- **This machine must be** on and awake at that hour, with Docker running.
- **The scheduling account** must own the folder and the key file, and must find `docker`: give its full path, or put it on that account's `PATH`.
- **The shared secret does not expire between runs**, however long the gap, unless `authentication.token_max_age_days` is set in `alcove.yaml`. If you set it, make it longer than two intervals.
- **Each period, put the new `input.csv` in the folder** before the scheduled time, under the same column names. A run with none exits 66.
- **On SFTP or a shared folder, each of you names your side.** Under `connection` in `alcove.yaml`, add an `options:` block if there is none, and under it add `peer_id:` with a name for your side, different from your partner's, and set `timestamp_in_filename: true`. If `options` already lists `timestamp_in_filename: false`, change that line: the same key twice stops the run. `peer_id` without `timestamp_in_filename: true` stops the run with exit 64. With both set, a file a killed run left behind stops the next run with the file named. If your partner's file transfer refuses a file name it has passed before, add [fields](../EXCHANGE_REFERENCE.md#fields-in-peer_id) Alcove fills in for each run, as in `peer_id: agency-a_%Y%m%d-%H%M%S`; in a crontab line that passes `--peer-id`, write each `%` as `\%`.
- **If the machine cannot be on at that hour**, run `alcove exchange input.csv ./` by hand at the agreed time each period instead.

## Cadences

Each row starts at 02:00 on the days it names. Your partner uses the same row.

| Cadence | cron | Windows `schtasks` |
| --- | --- | --- |
| Daily | `0 2 * * *` | `/SC DAILY /ST 02:00` |
| Weekly, on Mondays | `0 2 * * 1` | `/SC WEEKLY /D MON /ST 02:00` |
| Monthly, on the 1st | `0 2 1 * *` | `/SC MONTHLY /D 1 /ST 02:00` |
| Quarterly, on 1 January, April, July and October | `0 2 1 1,4,7,10 *` | `/SC MONTHLY /M JAN,APR,JUL,OCT /D 1 /ST 02:00` |

## Add the schedule

### 1. Write the schedule line

Each line below is quarterly, for the folder `/srv/alcove/plan-coc` or `C:\alcove\plan-coc`. Put your own cadence from [Cadences](#cadences) in place of its schedule part.

::: tabs platform

== Linux

Add this to the scheduling account's crontab with `crontab -e`. Use the path to `docker` that `command -v docker` prints:

```text
MAILTO=alcove-owner@example.org
0 2 1 1,4,7,10 * /usr/bin/docker run --rm --user "$(id -u):$(id -g)" -v /srv/alcove/plan-coc:/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./ --log-file exchange.log || echo "alcove exchange failed with exit code $?; see /srv/alcove/plan-coc/exchange.log"
```

cron mails what the line prints to `MAILTO`, where the machine can send mail. On failure that is the error, its next step and the exit code. Where it cannot send mail, put a command that alerts you in place of the `echo`.

The `|| echo` makes the cron job itself end with 0; the exit code is in the mail and the log. A monitor that reads the job's own status needs a command that keeps the code, in place of the `echo`.

== Windows

In Command Prompt, as the account the task runs as:

```cmd
schtasks /Create /TN "alcove exchange" /SC MONTHLY /M JAN,APR,JUL,OCT /D 1 /ST 02:00 /TR "cmd /c cd /d C:\alcove\plan-coc && docker run --rm --mount type=bind,src=C:\alcove\plan-coc,dst=/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./ --log-file exchange.log"
```

Docker Desktop installs `docker.exe` in `C:\Program Files\Docker\Docker\resources\bin`; put that folder on the task account's `PATH`. The text after `/TR` may be at most 261 characters.

The task records each run's exit code as its **Last Run Result**, in Task Scheduler's task list, in hexadecimal: `0x0` is success and `0x45` is 69. The Windows column of [Exit codes](#exit-codes) gives each one. Check it after each run, or have your monitoring read it: the task sends no mail.

== macOS

Add this to the scheduling account's crontab with `crontab -e`. Use the path to `docker` that `command -v docker` prints:

```text
MAILTO=alcove-owner@example.org
0 2 1 1,4,7,10 * /usr/local/bin/docker run --rm -v /srv/alcove/plan-coc:/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./ --log-file exchange.log || echo "alcove exchange failed with exit code $?; see /srv/alcove/plan-coc/exchange.log"
```

cron mails what the line prints to `MAILTO`, where the machine can send mail. Where it cannot, put a command that alerts you in place of the `echo`.

The `|| echo` makes the cron job itself end with 0; the exit code is in the mail and the log. A monitor that reads the job's own status needs a command that keeps the code, in place of the `echo`.

== Podman

Add this to the scheduling account's crontab with `crontab -e`:

```text
MAILTO=alcove-owner@example.org
0 2 1 1,4,7,10 * /usr/bin/podman run --rm --userns=keep-id:uid=1000,gid=1000 -v /srv/alcove/plan-coc:/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./ --log-file exchange.log || echo "alcove exchange failed with exit code $?; see /srv/alcove/plan-coc/exchange.log"
```

This line was tested in a minimal environment like cron's, not under cron itself.

The `|| echo` makes the cron job itself end with 0; the exit code is in the mail and the log. A monitor that reads the job's own status needs a command that keeps the code, in place of the `echo`.

:::

On a shared folder, add the shared folder's mount (`-v` or `--mount`) as you did by hand.

### 2. Check the first scheduled run

You should see: a new `alcove-results-<time>.csv` in the folder, and a Last Run Result of `0x0` on Windows.

The first scheduled run also prints the display of what it sends, about 40 to 45 lines, even on success, and cron mails it. Later runs print it only when what it shows, your name or the connection changes. No flag silences only that display. To skip the first mail, give your run by hand the same `--log-file exchange.log`: a run whose display matches the last one in that log prints nothing.

With `--log-file`, the `exchange complete` line goes only to `exchange.log`, and paths there start `/work`, which is your folder as the container sees it.

More detail: [What a scheduled run refuses rather than asks](../CLI.md#what-an-unattended-run-refuses-rather-than-asking), [The key file on the scheduling machine](../CLI.md#the-key-file-on-the-scheduling-machine).

## What you get

Each scheduled run adds its own time-stamped files to the folder, beside earlier runs' files. Move or delete old results on your own schedule.

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<time>.csv` | This run's matched records. | Keep private |
| `alcove-record-<time>.json`, `.terms.json` | This run's exchange record and both parties' terms. | Keep; not secret |
| `alcove-record-<time>.keys.json` | The values that open this record's checks. | Keep private |
| `exchange.log` | Every run's log lines, appended. | Keep; not secret |
| `.alcove.key` | The shared secret, rewritten by each successful run. | Keep private |

## Never overlap runs

Alcove does not stop a second run of the same exchange from starting. Two runs at once both fail, and can leave the shared secret out of step, so both of you must start over with a new invitation.

- **Keep the interval longer than a run**, including its 1-hour wait for your partner. Every cadence in [Cadences](#cadences) does.
- **On Linux, skip a start while a run is going** by putting `flock` in front of the command. A skipped start exits 75:

```text
0 2 1 1,4,7,10 * flock -n -E 75 /srv/alcove/plan-coc/.run.lock /usr/bin/docker run --rm --user "$(id -u):$(id -g)" -v /srv/alcove/plan-coc:/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./ --log-file exchange.log || echo "alcove exchange failed with exit code $?; see /srv/alcove/plan-coc/exchange.log"
```

- **On Windows**, a task made with `schtasks /Create` does not start while its last run is still going.
- **Set any outer timeout above the run's length**: 1 hour of waiting plus the run itself.

## Exit codes

Act on the exit code alone. A `69` that comes quickly (the server or folder was not reached) can be retried up to a small fixed cap while your partner is still waiting; a `69` after the full wait means your partner never arrived and their run has ended too: agree on a time and both run by hand. Retry `66` once the input lands. Then alert a person.

| Code | Windows | Meaning | What to do |
| --- | --- | --- | --- |
| `0` | `0x0` | The exchange completed and its files were written. | Nothing. |
| `64` | `0x40` | Bad input or configuration, or a refusal a retry repeats, such as an unpinned host key or your partner's changed terms. | Fix what the message names; do not retry unchanged. |
| `66` | `0x42` | The input file is not there yet. | Retry once the input lands, then alert if it stays missing. |
| `69` | `0x45` | The server, the shared folder or your partner could not be reached, or your partner never arrived; also a wrong SFTP password (`All configured authentication methods failed`), which a retry does not fix. | Retry up to a small fixed cap, then alert. |
| `70` | `0x46` | A fault inside Alcove. | Report it with the message; do not retry. |
| `73` | `0x49` | The exchange completed, but a local file write did not. | Do not re-run; fix the local write the message names. |
| `76` | `0x4C` | Your partner or the agreed terms refused the run. | Do not retry; contact the partner. |
| `77` | `0x4D` | Authentication failed: the shared secret, or the SFTP host key did not match the pinned one. | Do not retry. Re-invite for the shared secret; verify the server out of band for the host key. Treat an unexpected one as a possible security event. |

> [!WARNING]
> Never retry `70`, `73`, `76` or `77`. A re-run of `73` runs a second exchange and sends your records again.

More detail: [Every exit code and its cases](../CLI.md#exit-codes), [Recovering an out-of-step secret](../CLI.md#out-of-sync-tokens).
