# The host pull

A daily timer on the relay host that brings it to the tip of `main`: the broker's tree with core's signed build, then the broker's and the relay's install scripts.
Nothing outside the host can start it or reach the host through it: it has no token or key, and every request it makes is an anonymous read of this public repository.

It is opt-in.
Neither [`infra/relay/install.sh`](../relay/install.sh) nor [`infra/broker/install.sh`](../broker/install.sh) installs it, so a host built from either reference follows this repository's `main` only when its operator installs this directory as well.

## What a run does

1. Reads the tip of `main` with `git ls-remote` over HTTPS.
   When the deployed marker, `/var/lib/alcove-host-pull/deployed`, and the broker's tree link, `/opt/alcove-broker/src`, both name that commit, the run records `unchanged` and stops.
   Only a run whose installs and `verify.sh` all passed writes the marker.
   Otherwise the run takes every step below, even when the link already names the tip because an earlier run switched it and did not finish installing.
   A tree already on disk for the tip is never reused: step 4 stages a new one and replaces it.
2. Reads the tip's GitHub Actions workflow runs from GitHub's API without a token: `GET /repos/georgetown-mdi/alcove/actions/runs?head_sha=<commit>&event=push&per_page=100`, reading further pages while the answer's `total_count` is larger than the runs read, up to 10 pages.
   The tip is green when it has at least one workflow run triggered by a `push` and every one has completed with conclusion `success`.
   A push of the commit to `staging` counts as well as its push to `main`.
   Runs triggered by any other event, such as the scheduled nightly workflows or Dependabot's, do not gate the pull.
3. Downloads `alcove-broker-core-<commit>.tar.gz` and its Sigstore bundle from the `broker-core-build` prerelease ([docs/RELEASES.md](../../docs/RELEASES.md#the-broker-core-build)) and verifies the signature with the command in [`infra/broker/README.md`, Install](../broker/README.md#install), step 5.
   The identity is the publishing workflow on `refs/heads/main`, and `--certificate-github-workflow-sha` is the tip from step 1, so a correctly signed build of any other commit is refused.
4. Fetches `main` into a new tree, `/opt/alcove-broker/trees/<commit>`, and refuses it unless the fetched commit is the tip from step 1.
   It unpacks the build into the tree's `packages/core/dist`, checks the archive's `SHA256SUMS`, installs the broker workspace with `npm ci --ignore-scripts` at low priority, and makes the tree owned by root and readable by all.
   No package's install script runs: in the broker workspace's dependencies only `esbuild`, through `tsx`, and `tsx`'s optional, darwin-only `fsevents` (which Linux skips) declare one, and the broker started without it when that was measured, at `esbuild` 0.28.1.
5. Points `/opt/alcove-broker/src` at the new tree, restarts `alcove-broker.service` if it is running, and runs the tree's `infra/broker/install.sh`, then its `infra/relay/install.sh`, which ends with `verify.sh`.
   When both pass, it writes the tip to the deployed marker.

It never builds core.
It never runs code from a tree it is about to replace: the timer runs the copy of `pull.sh` this directory's `install.sh` put under `/opt/alcove-host-pull`.

## The window

The timer fires every day at 06:00 UTC, with up to 5 minutes of randomized delay.
That is after the other daily windows on the same host:

| unit | window (UTC) |
| --- | --- |
| `alcove-relay-cert.timer`, the relay's certificate renewal | 03:00 to 04:00 |
| `alcove-broker-cert.timer`, the broker's certificate renewal | 04:30 to 04:45 |
| `alcove-relay-os-update.timer`, the relay's OS updates | 05:00 to 05:30 |

The service is ordered after `alcove-relay-os-update.service`, so a pull that starts while an OS update is still running waits for it to finish; that wait has not been measured on a host.
A host that is down at 06:00 skips the day rather than pulling at boot.

## Outcomes

| outcome | exit | when |
| --- | --- | --- |
| `unchanged` | 0 | the tip of `main` is the deployed commit |
| `skipped` | 0 | a push-triggered workflow run has not completed, none has started yet, the prerelease does not yet have the tip's build, or `main` moved during the run |
| `refused` | 1 | a push-triggered workflow run completed with another conclusion, the signature does not verify, or the unpacked files do not match `SHA256SUMS` |
| `failed` | 1 | a step could not run: a download, the fetch, `npm ci`, either install script or `verify.sh`, a precondition below, or the run was stopped by a signal, such as systemd's at `TimeoutStartSec=` |
| `updated` | 0 | both install scripts and `verify.sh` passed on the new commit |

Every run writes its outcome to `/var/lib/alcove-host-pull/status`, renamed into place and readable by all, outside `/root` and `/home` so a unit run under `ProtectHome=` can read it:

```text
deployed_commit=<the commit in the deployed marker: the last whose installs passed>
linked_commit=<the commit /opt/alcove-broker/src links to>
main_commit=<the tip of main this run read>
outcome=<one of the outcomes above>
reason=<one line, also in the journal>
time=<the run's end, UTC>
```

`journalctl -u alcove-host-pull.service` shows each step of every run.

## Install

On a host already set up as [`infra/broker/README.md`, Install](../broker/README.md#install) and [`infra/relay/README.md`](../relay/README.md) describe, with Node and Cosign in `/usr/local/bin`:

1. Move the broker's clone into the tree layout, once, while the broker is stopped:

   ```sh
   systemctl stop alcove-broker.service
   commit="$(git -C /opt/alcove-broker/src rev-parse HEAD)"
   install -d -m 755 /opt/alcove-broker/trees
   mv /opt/alcove-broker/src "/opt/alcove-broker/trees/${commit}"
   ln -s "trees/${commit}" /opt/alcove-broker/src
   systemctl start alcove-broker.service
   ```

   `pull.sh` refuses to run while `/opt/alcove-broker/src` is a directory, or a link to anything but a tree under `/opt/alcove-broker/trees`.
   The broker unit's `WorkingDirectory=` has not yet been measured through the link on a host.
2. From a checkout of this directory, as root: `./install.sh`.
   It installs `pull.sh` and `workflow-runs.mjs` under `/opt/alcove-host-pull` and the service and timer under `/etc/systemd/system`, and enables nothing.
   Run it again from a newer checkout to update the pull itself: a pull never rewrites its own copy.
3. Enable the timer: `systemctl enable --now alcove-host-pull.timer`.
   To pull once by hand: `systemctl start alcove-host-pull.service`.

## Limits

- **No rollback.** A failed install or `verify.sh` leaves `/opt/alcove-broker/src` on the new commit with the units as far as the install got, and records `failed`; the previous tree stays under `/opt/alcove-broker/trees`.
  The deployed marker keeps the previous commit, so the next run checks, downloads and stages the new one again from step 2 and installs it, and records `failed` again until the installs pass.
- **Every tree is kept.** Nothing removes a tree, so each update adds one, with its `node_modules`, to the disk.
- **Relayed exchanges drop on an update.** `infra/relay/install.sh` restarts coturn, the 443 front and the registrar on every run, which drops allocations in progress. The pull installs only when `main` moved.
- **Node is not updated.** The host's Node is the tarball under `/usr/local/lib/nodejs`, which neither this pull nor the OS updates touch.
- **The tree is not signed.** Only core's build is. What binds the tree to `main` is the fetch over HTTPS from github.com and the check that the fetched commit is the tip `git ls-remote` named.

## The files

| path | what it is |
| --- | --- |
| `pull.sh` | One run, as above. Installed as `/opt/alcove-host-pull/pull.sh` |
| `workflow-runs.mjs` | Reads the pages of the workflow-runs answer and prints whether the commit's push runs passed, are pending or did not pass; `pull.sh` runs it with the host's Node |
| `alcove-host-pull.service`, `.timer` | Run `pull.sh` daily in the window above |
| `install.sh` | Installs the three above; enables nothing |

[`scripts/host-pull.test.mjs`](../../scripts/host-pull.test.mjs) drives `pull.sh` through each outcome against a fixture host with `git`, `curl`, `cosign`, `npm`, `systemctl` and both install scripts stubbed, and holds the timer to the window above.
