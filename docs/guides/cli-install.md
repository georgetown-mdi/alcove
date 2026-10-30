---
reader: An IT engineer at either party, comfortable with a shell and a container engine
needs: Docker Desktop, Docker Engine or Podman, and your input CSV
next: "[Invite a partner](./cli-invite.md) or [Accept an invitation](./cli-accept.md)"
---

# Install and run

Install the Alcove image, learn the one command form every page uses, and know how long a run takes and what it leaves behind.

## Install

Choose the tab for the machine that will run the exchange; for a schedule, that is the scheduling machine. On Windows with Podman, follow the Podman tab; it was tested on Linux only.

::: tabs platform

== Linux

Install Docker Engine, then pull the image:

```sh
docker pull ghcr.io/georgetown-mdi/alcove:latest
```

Docker Engine needs `--user "$(id -u):$(id -g)"` on every run, which the command form below includes: it runs the container as your own account, so it can write your folder.

== Windows

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it. On a work laptop, installing Docker Desktop needs administrator rights, and Docker's terms may require a paid subscription for your organization: check with your IT department before the agreed date.

Open PowerShell and pull the image:

```powershell
docker pull ghcr.io/georgetown-mdi/alcove:latest
```

== macOS

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it. Open Terminal and pull the image:

```sh
docker pull ghcr.io/georgetown-mdi/alcove:latest
```

== Podman

Pull the image:

```sh
podman pull ghcr.io/georgetown-mdi/alcove:latest
```

Rootless Podman needs `--userns=keep-id:uid=1000,gid=1000` on every run, which the command form below includes. Without it, the first write fails with exit 64 and `EACCES: permission denied, open './alcove.yaml.tmp.1'`.

This form was tested with rootless Podman 4.9.3 on Linux. Podman on Windows or macOS has not been tested.

:::

More detail: [Which account the image runs as, and what each engine needs](../DEPLOYMENT.md#the-user-the-image-runs-as).

## The command form

These pages write each command as `alcove ...`. Run it from the folder that holds this exchange's files, with this in place of `alcove`:

::: tabs platform

== Linux

```sh
docker run -it --rm --user "$(id -u):$(id -g)" -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest
```

For example, `alcove exchange input.csv ./` becomes:

```sh
docker run -it --rm --user "$(id -u):$(id -g)" -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./
```

== Windows

```powershell
docker run -it --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest
```

For example, `alcove exchange input.csv ./` becomes:

```powershell
docker run -it --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./
```

== macOS

```sh
docker run -it --rm -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest
```

For example, `alcove exchange input.csv ./` becomes:

```sh
docker run -it --rm -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./
```

== Podman

```sh
podman run -it --rm --userns=keep-id:uid=1000,gid=1000 -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest
```

For example, `alcove exchange input.csv ./` becomes:

```sh
podman run -it --rm --userns=keep-id:uid=1000,gid=1000 -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest exchange input.csv ./
```

:::

The container reads and writes only that folder, so keep your input file, any password file and the results in it.

`-it` gives the command a terminal, which `alcove accept` and a first SFTP run need to ask you a question. Leave `-it` out in two places:

- **When you save the output to a file**, as `alcove invite ... > invitation.txt` does. With `-it`, the log lines land in the file too.
- **In a schedule.** A scheduled job has no terminal.

You should see, for `alcove --version`: a version number, such as `0.1.0`.

## How long a run takes

Both of you run at the same time. Each side waits up to 1 hour for the other over SFTP or a shared folder, and 10 minutes over WebRTC.

On SFTP and a shared folder, each linkage key takes several rounds, and each round waits up to one check interval for your partner's file: 250 milliseconds on a shared folder and 5 seconds on SFTP by default. The number of keys and the interval set the pace, far more than the record count.

To shorten an SFTP test run, add `--polling-frequency 1s` to `alcove exchange`, on a server you control: a shorter interval can trip a server's limit on rapid requests.

Set any outer timeout, such as a scheduler's, above the run length.

## What you get

Every run writes into the folder you name as its output (`./` on these pages). Each file name carries the run's time stamp.

| File | What it holds | Share or keep |
| --- | --- | --- |
| `alcove-results-<time>.csv` | One row per matched record: your ID column, `row_id` (your partner's row number, counting from 0), then the columns your partner sends. With no ID column, `row_id` is your own row number and `their_row_id` your partner's. | Keep private |
| `alcove-record-<time>.json` | The exchange record: both names, the method, the columns sent and received, your record count, and the match count when the terms give both of you the result. You wrote it; your partner did not sign it. | Keep; not secret |
| `alcove-record-<time>.keys.json` | The values that open the record's checks, for `alcove verify-receipt`. | Keep private |
| `alcove-record-<time>.terms.json` | Both parties' agreed terms, for `alcove verify-receipt`. | Keep; not secret |
| `alcove-receipt-<time>.json` | A receipt signed by both of you. Written only when the exchange is set up to sign (`signing.mode: certificate`). | Keep; not secret |
| `alcove.yaml` | This exchange's configuration. | Keep; not secret if credentials are `@` file references |
| `.alcove.key` | The shared secret. It changes after every run. | Keep private |

A count-only exchange writes no results file: the run prints `exchange complete: N records in common, no result file (count only)`, or, where only your partner computed the count, `exchange complete: your partner reported N records in common ...`. The record holds the count. A party the terms give no result gets no results file: the run prints `exchange complete: no result file for you under the agreed terms`.

> [!WARNING]
> Keep `.alcove.key` on one machine. A stale or second copy that runs desynchronizes the secret, and both of you must start over with a new invitation.

More detail: [What the result file holds](../CLI.md#the-result-file), [Setting up signed receipts](../CLI.md#from-a-quick-exchange-to-signed-receipts).
