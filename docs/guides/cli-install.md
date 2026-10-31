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

The image is published to two registries with the same images, tags, and digests: Docker Hub, as `docker.io/gumdi/alcove`, and the GitHub Container Registry, as `ghcr.io/georgetown-mdi/alcove`. They are equally useful, equally recommended, and equally secure, so pull from whichever one your network reaches. These pages name the ghcr.io image; to use Docker Hub, pull `docker.io/gumdi/alcove:latest` and put that name in place of `ghcr.io/georgetown-mdi/alcove:latest` in each command. If a pull from one registry is refused, try the other: a network can block one and allow the other, and Docker Hub limits how often one network downloads from it.

Each registry holds the release's signature. To check that an image is the one the release published, install Cosign (see the Cosign documentation for your platform) and run either command, putting the tag you pulled, such as `latest`, in place of `X.Y.Z`:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/alcove/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  docker.io/gumdi/alcove:X.Y.Z

cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/alcove/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/georgetown-mdi/alcove:X.Y.Z
```

Run the one for the registry you pulled from. The other registry's command verifies the same image only when you give it your image's digest in place of the tag (`docker.io/gumdi/alcove@sha256:...` or `ghcr.io/georgetown-mdi/alcove@sha256:...`), because the signature covers the digest, not the tag. What each argument pins, and how to verify by digest: [Verifying a Release](../RELEASES.md#container-image).

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

Once you are both running, two things set the run's length:

- **Waiting.** On SFTP and a shared folder, each linkage key passes about 9 messages, and each one waits for your partner's next check: every 250 milliseconds on a shared folder and every 5 seconds on SFTP by default. The number of keys and the interval set this part. WebRTC has no check interval.
- **Computing.** This grows with the record count: about 2 seconds in all for 20 records a side, and about 1 minute for 5,000 against 150,000, or about 2 seconds a key.

Measured with 25 linkage keys, both parties on one machine, and a test SFTP server on that machine:

| Channel and check interval | 20 records a side | 5,000 against 150,000 |
| --- | --- | --- |
| Shared folder, 250 milliseconds (default) | about 1 minute | 1.6 to 1.7 minutes |
| SFTP, 1 second | about 4.5 minutes | about 3.6 minutes |
| SFTP, 5 seconds (default) | about 21 minutes | about 13 minutes |

At 5 seconds, waiting is over 90% of a run even at the larger size. On a shared folder, computing is most of a large run. The 5-second rows come from one run each, and a repeat can differ by minutes, because the two sides' checks drift in and out of step. More keys make every row longer.

The 5-second SFTP default is a cautious setting for servers that limit or block rapid requests, not the fastest an exchange can go. On a server that allows it, a shorter interval shortens the run several-fold: both of you add `--polling-frequency 1s` to `alcove exchange`. Use a server you control or know the limits of, because a shorter interval can trip a server's limit on rapid requests.

Set any outer timeout, such as a scheduler's, above the wait for your partner plus the run length for your channel, interval and number of keys. For 25 keys over SFTP at the 5-second default, that is more than 1 hour and 21 minutes, with room for a run that takes some minutes longer.

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
