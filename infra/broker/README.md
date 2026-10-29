# The standalone peer-coordination broker: host units

The units, the TLS front's configuration and the certificate renewal that run the broker workspace's standalone entry point (`packages/peerjs-broker`, `npm start`) on a host of its own.
The project runs it on the standing relay's instance, beside coturn ([`../relay/README.md`](../relay/README.md)).
What the deployment measured is recorded in [the deployment record](../../docs/notes/webrtc-relay-deployment.md#does-the-coordination-server-leave-the-web-apps-deployment).

## Port 8443, and 443 through the relay's front

The front listens on **8443**, because the relay's front holds 443 on the same host ([`../relay/README.md`, The 443 front](../relay/README.md#the-443-front)).
That front passes a connection asking for the broker's name, TLS unopened, to this one on loopback, where a host's `relay.env` routes it:

```sh
ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"
```

The relay's registrar, where the host runs one, then listens on another port: `ALCOVE_RELAY_REGISTRAR_PORT` defaults to 8443, so set it, as `relay.env.example` does to 8444; the relay's `render-front.sh` refuses two services on one port.
The broker's URL then names no port (`wss://signal.example.org/api/`), and a party whose network admits outbound TCP only to 443 reaches it.
The published URL is the web build's `VITE_SIGNALING_SERVER_URL` ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)); an invitation or a kept exchange that names `:8443` reaches the broker only while the host's firewall admits 8443.
A connection through 443 reaches this front from `127.0.0.1`, so its access log line names that address rather than the client's.

The front listens on IPv4 only.

## The files

| path | what it is |
| --- | --- |
| `alcove-broker.service` | The broker: `npm start -w packages/peerjs-broker -- --path /api` from `/opt/alcove-broker/src`, as the system user `alcove-broker` under the sandbox in [Exposure](#exposure), on `127.0.0.1:9411` only |
| `nginx.conf.tmpl` | The front's nginx configuration, with the host's name as `__ALCOVE_BROKER_NAME__`: TLS on 8443, `/api/` proxied to the broker with WebSocket upgrade, everything else `404` |
| `render-config.sh` | Prints the template with the name from `broker.env` substituted; refuses a value that is not a DNS name |
| `Dockerfile` | The front's nginx image, registry-qualified and pinned by digest: the one place it is named. Nothing builds it; `install.sh` reads its `FROM` line, refuses a reference without a digest, and writes the reference to `/etc/alcove-broker/front-image.env` for the front's unit, restarting the front when it changes |
| `alcove-broker-tls.service` | The front: the pinned image under `docker run`, host network, read-only root, the rendered configuration and `/etc/alcove-broker/tls` mounted read-only, logging to the journal |
| `renew.sh` | ACME DNS-01 issue and renewal through lego, installed as `/etc/alcove-broker/renew.sh`; then restarts each running unit whose inputs are newer than its start, whether or not the renewal succeeded, except under `install.sh`, which does that itself after its writes |
| `unit-state.sh` | Sourced by both scripts and installed beside `renew.sh`: decides from systemd's state and file times which running units to restart |
| `alcove-broker-cert.service`, `.timer` | Runs `renew.sh` daily at 08:15 UTC plus up to 5 minutes, after the relay's own renewal, under the relay host's maintenance lock ([`../relay/README.md`, The daily schedule](../relay/README.md#the-daily-schedule)) |
| `install.sh` | Creates the broker's system user if it is missing, installs all of the above and converges on a re-run, then checks `/api/health` through the front |
| `broker.env.example` | The host's one configuration file, copied to `/etc/alcove-broker/broker.env` |

## Install

These steps bring up a new host.
Later commits reach the project's host through [the host pull](../host-pull/README.md), which stages each commit of `main` as its own tree under `/opt/alcove-broker/trees` with core's signed build, runs this directory's `install.sh` and the relay's from it, and rolls back to the previous tree when either fails; its own Install section moves the clone from step 2 into that layout.
A host without the pull takes a later commit by fetching and checking out that commit in the clone at `/opt/alcove-broker/src`, then repeating steps 3, 5 and 6 and `install.sh`.

The broker's workspace is a precondition `install.sh` checks for and does not create.
On a host the size of the relay's (412 MB of memory), a full-workspace `npm ci` OOM-killed coturn, so the install is scoped to the broker workspace and core is built elsewhere:

1. Install Node under `/usr/local/lib/nodejs`, from the official tarball checked against its published `SHASUMS256.txt`, with `node` and `npm` linked into `/usr/local/bin`; the unit runs `/usr/local/bin/npm`.
   On Amazon Linux 2023 the tarball needs `tar`, `xz` and `libatomic`, and the clone needs `git`.
2. Clone the repository at the commit to deploy into `/opt/alcove-broker/src`.
3. In that clone, install the broker workspace alone, at low priority beside coturn:

   ```sh
   nice -n 10 ionice -c 3 npm ci --no-audit --no-fund --workspace packages/peerjs-broker
   ```

4. Install Cosign v3.0.6, the version the repository's workflows run through `sigstore/cosign-installer@v4.1.2`, from its release binary for the host's architecture: `cosign-linux-arm64` on the project's t4g instance, `cosign-linux-amd64` on an x86-64 host (`uname -m` prints `aarch64` or `x86_64`).
   The repository states no checksum for that binary, so check it against the `cosign_checksums.txt` the same Cosign release publishes:

   ```sh
   version=v3.0.6
   binary=cosign-linux-arm64  # cosign-linux-amd64 on x86-64
   curl -fsSLO "https://github.com/sigstore/cosign/releases/download/${version}/${binary}"
   curl -fsSLO "https://github.com/sigstore/cosign/releases/download/${version}/cosign_checksums.txt"
   grep " ${binary}\$" cosign_checksums.txt | sha256sum -c -
   install -m 755 "${binary}" /usr/local/bin/cosign
   ```

   The checksums file comes from the same release as the binary, so it catches a damaged download, not a replaced release.
5. Take core's build for that commit from the `broker-core-build` prerelease ([docs/RELEASES.md, The broker core build](../../docs/RELEASES.md#the-broker-core-build)): `alcove-broker-core-<commit>.tar.gz` and its bundle `alcove-broker-core-<commit>.tar.gz.sigstore.json`, `<commit>` being the full commit the clone is at.
   The archive holds `untrusted-text.esm.js`, the WebSocket relay's `websocket-relay.esm.js` ([`infra/relay/README.md`, The WebSocket relay](../relay/README.md#the-websocket-relay)), the chunks either imports and a `SHA256SUMS` manifest of all of them; the first entry point is the whole of the broker's reach into core.
   Verify its signature with Cosign, which needs no credential on the host, then unpack it into the clone and check the manifest:

   ```sh
   commit=<the full commit the clone is at>
   cosign verify-blob \
     --bundle "alcove-broker-core-${commit}.tar.gz.sigstore.json" \
     --certificate-identity https://github.com/georgetown-mdi/alcove/.github/workflows/broker_core_build.yaml@refs/heads/main \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-sha "${commit}" \
     "alcove-broker-core-${commit}.tar.gz"
   mkdir -p packages/core/dist
   tar -xzf "alcove-broker-core-${commit}.tar.gz" -C packages/core/dist
   (cd packages/core/dist && sha256sum -c SHA256SUMS)
   diff <(sed -E 's/^[0-9a-f]{64} [ *]//' packages/core/dist/SHA256SUMS | sort) \
     <(tar -tzf "alcove-broker-core-${commit}.tar.gz" | grep -v '/$' | grep -vx SHA256SUMS | sort)
   ```

   `sha256sum -c` passes a file the manifest does not list, so `diff` then compares the archive's file names with the manifest's.
   Refuse the build if it prints anything: a `>` line names a file the manifest does not list, a `<` line a listed file the archive does not hold.

   The identity names the publishing workflow on `main`, and `--certificate-github-workflow-sha` refuses a correctly signed build of any other commit.
   Measured on the relay host (Amazon Linux 2023, t4g.nano) on 2026-10-12, Cosign v3.0.6 verified a signed archive with no token or cloud credential in its environment, refused a bundle for another identity, another commit and an altered archive, and peaked at about 66 MB of memory.
   The prerelease holds the latest commit on `main` only.
   For any other commit, build core on another machine at that commit (`npm run build -w packages/core`), pack it with `node scripts/pack-broker-core.mjs packages/core/dist <out-dir>`, and copy the files `<out-dir>` holds into the clone's `packages/core/dist/`, checking the manifest on arrival.
6. Leave the tree owned by root and readable by all, so the broker's account cannot rewrite the code it runs: `chown -R root:root /opt/alcove-broker && chmod -R u=rwX,go=rX /opt/alcove-broker`.

Then the host's configuration, and the install:

```sh
install -d -m 700 /etc/alcove-broker
install -m 600 broker.env.example /etc/alcove-broker/broker.env  # set ALCOVE_BROKER_NAME
./install.sh
```

Before it writes the broker's unit, `install.sh` creates the system user and group `alcove-broker` that the unit runs as, if the user does not exist:

```sh
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin alcove-broker
```

It refuses to run when only one of the user and the group exists.
The account needs no files of its own: the broker reads the root-owned tree under `/opt/alcove-broker` and Node under `/usr/local/lib/nodejs`, both readable by all, and nothing under `/etc/alcove-broker`.

The name's DNS record points at the host and is DNS-only, and the host's firewall admits TCP 443 for the relay's front, and TCP 8443 while any client still names that port; both are the operator's, outside this directory.
The ACME contact and the DNS provider credential come from the relay's `/etc/alcove-relay/acme.env` by default ([`../relay/certs/env.example`](../relay/certs/env.example)); `ALCOVE_BROKER_ACME_ENV` in `broker.env` names another file.

## Logging

All three services write to the host's journal, under the retention the relay's drop-in sets ([`../relay/journald-alcove-relay.conf`](../relay/journald-alcove-relay.conf)).

- **The front's access log names the request path and never its query string.**
  A signaling URL's query contains the rendezvous identifier and the client token, so the log format writes `$request_method $uri $server_protocol`, not `$request`.
  [`scripts/broker-front.test.mjs`](../../scripts/broker-front.test.mjs) fails if a log format in the template writes any variable outside the documented fields, or if the template drops the `http`-level access log and so falls back to nginx's built-in format, which writes the query string.
- **The front's error log** is at `crit`, and the test fails below `crit`.
  At `warn`, nginx writes a line about a refused, reset, timed-out, too-large or buffered request, and at `error` about each of them but the buffered one; the line holds the request line with its query string and the client's address.
  At `crit` none of those requests writes a line ([PRIVACY.md](../../PRIVACY.md)).
- **The access log shows what became of a request passed to the broker**, in place of the error log: `request_bytes` (`$request_length`), `upstream_status`, `upstream_connect` (the time to connect to the broker, `-` when no connection was made) and `upstream_dur`.
  Each failure has its own reading:

  | failure | status | `upstream_status` | `upstream_connect` | `request_bytes` |
  | --- | --- | --- | --- | --- |
  | the broker refused the connection | 502 | 502 | `-` | |
  | the broker closed or reset it before answering | 502 | 502 | a time | |
  | the broker did not answer within 300 s (`proxy_read_timeout`) | 504 | 504 | a time | |
  | the body is over 1 MiB (`client_max_body_size`), refused before reaching the broker | 413 | `-` | `-` | |
  | a body over the default `client_body_buffer_size` (two memory pages, 8 KiB on x86-64), buffered to a file under `/tmp` | | | | over 8192, headers included |

  [`scripts/check-broker-front-logs.mjs`](../../scripts/check-broker-front-logs.mjs), run by `broker_front_logs.yaml` on a pull request that changes the template or the image, drives each of these through the pinned image and fails if any log line holds a request's query string, if any of them writes an error-log line, or if a failure's access-log line does not match its row.

The front closes a WebSocket idle for 300 s (`proxy_read_timeout`); the PeerJS client sends a heartbeat every 5 s by default (`pingInterval = 5000` in `node_modules/peerjs/dist/peerjs.js`, peerjs 1.5.5, not overridden in `apps/` or `packages/`), so a live connection stays open.

## How a change reaches the units

A change to the template reaches a running front through `install.sh`.
It renders the configuration to a root-only file under `/etc/alcove-broker` and checks it with `nginx -t` in a throwaway container of the pinned image, mounted as the unit mounts it with the installed certificate, before it restarts the broker or runs a renewal.
Only a first install, which has no certificate yet, runs a renewal before the check, and the front is not running then: `install.sh` refuses a running front with no certificate.
A configuration that fails the check stops the install with both units, the certificate, `/etc/alcove-broker/nginx.conf` and the running front unchanged.
Every file the units read is written, each only when its content changed, before any unit is touched.
Each is staged beside its target and renamed over it, then given a modification time read from the clock after the rename, so a unit that started before the file went live has an earlier start.
Then each running unit is restarted when one of its inputs was written at or after its start (`ActiveEnterTimestamp`), or systemd has not reloaded its unit file (`NeedDaemonReload`), after a `systemctl daemon-reload`.
The front's inputs are its unit file, `front-image.env`, `nginx.conf` and the certificate and key; the broker's is its unit file, and restarting the broker restarts the front with it.
The renewal timer's input is its unit file, and only `install.sh` restarts it: `renew.sh` runs as the service that timer starts.
A configuration change restarts the front too and drops its open WebSockets: a reload would not move the start time, so a reload decided this way would repeat on every run.
Nothing records a restart still to make: a run that dies after its writes leaves the inputs newer than the start, and the next `install.sh` or the renewal timer's `renew.sh` restarts the unit, the timer even when its own renewal fails.
Both scripts hold an exclusive `flock` on `/etc/alcove-broker/lock` for their whole run, so one never acts on the other's half-written state; `install.sh` passes its descriptor to the `renew.sh` it runs.
`renew.sh` reads `unit-state.sh` only once it holds the lock, so a renewal that waited on `install.sh` uses the copy `install.sh` put in place.

### Limits

Each costs availability only: it leaves a unit on older inputs, or stopped, until they change again or the unit restarts for another reason.

- **The wall clock.** The rule compares file times with unit start times on the system clock.
  A clock stepped backwards between a write and the next run can make an input written after a unit started look older than that start, and that restart is missed.
- **The key and certificate.** They are renamed into place one after the other, not in one step.
  A front that starts between the two renames reads a key and certificate that do not match and fails to start, and systemd starts it again 5 s later.
  A run that stops between them leaves the pair mismatched on disk until the next run of either script installs it again.
  Swapping both in one step needs a change to what the front mounts, which has not been measured on the host.
- **A unit systemd restarts by itself.** A broker or front that systemd restarts (`Restart=always`) between `install.sh`'s write of its unit file and the `daemon-reload` starts on the old definition.
  The same run restarts it after the reload, but a run that stops between the reload and that restart leaves it there: its start is later than the file.
- **The renewal timer's unit.** An `install.sh` run that stops before restarting the timer leaves it for the next `install.sh` run; the renewal timer's `renew.sh` does not restart it.

## Certificates

Let's Encrypt over DNS-01 through lego v5, as for the relay ([`../relay/README.md`, Certificates](../relay/README.md#certificates)).
`lego run --renew-days 30` issues the first certificate and after that renews only inside its window, so the daily timer is a no-op on most days and the front keeps running.
The provider credential is exported only to lego's subshell.

Two overrides exist for a run by hand: `ALCOVE_BROKER_RENEW_DAYS` widens the window (365 forces a renewal) and `ALCOVE_BROKER_LEGO_EXTRA` appends lego flags (`--no-random-sleep`).
Each forced renewal counts against Let's Encrypt's limit of five duplicate certificates a week.

## Exposure

The unit runs as the dedicated system user `alcove-broker` and scores 0.9 SAFE under `systemd-analyze security` (measured on the host on 2026-10-09).
The measurements, the earlier `nobody` result and the rejected `DynamicUser=yes` alternative are in [the deployment note's Unit exposure bullet](../../docs/notes/webrtc-relay-deployment.md).

`MemoryDenyWriteExecute=yes` is left out because the broker did not start under it: node aborts at start with a core dump on SIGTRAP; V8 cannot change a mapping's permissions.
The journal line: `# Check failed: 12 == (*__errno_location ()).`, from `v8::base::OS::SetPermissions`.

A stop leaves the broker `inactive`, not `failed`: npm exits 143 on the stop's SIGTERM, and `SuccessExitStatus=143` counts that as a clean exit (measured on the host).

## The deployment check

The broker's `/api/health` answer has three headers about the host's deployment: the commit [the host pull](../host-pull/README.md) last deployed, and its last run's outcome and time.
The broker reads them from the pull's deployed marker and status record under `/var/lib/alcove-host-pull`, and publishes nothing else from those files: no `reason` line, no other commit, no path and no error detail.
The headers, their values and the `unknown` each takes when it cannot be read: [`packages/peerjs-broker/README.md`, Deployment headers](../../packages/peerjs-broker/README.md#deployment-headers).
The unit's sandbox leaves `/var/lib` readable; that the broker reads the two files under it has not yet been measured on the host.

[`nightly_relay_deployment.yaml`](../../.github/workflows/nightly_relay_deployment.yaml) reads those headers every day at 11:23 UTC, after the pull's run and the daily verification, through [`scripts/relay-deployment-check.mjs`](../../scripts/relay-deployment-check.mjs).
It finds the broker from the repository variable `VITE_SIGNALING_SERVER_URL`, the web build's `wss:` URL of this broker, and reads `/api/health` at the same host over `https:`.
It goes red when:

- a header is missing, or its value is `unknown`;
- the last pull run ended `refused`, `failed`, `rolled-back` or `rollback-failed`;
- the deployed commit is not on `main`;
- `main` has held commits the host has not deployed for more than 48 hours, counted from the update of `main` that first moved it past the deployed commit, as GitHub's repository activity API records it.

The 48 hours are a working value, not a measured one, and can be raised on request (`MAX_LAG_HOURS` in the script).
The pull runs daily and skips a commit whose CI has not finished, so 48 hours admit one skipped day.
The run's log and its summary print the published values and one `red (<kind>)` line per finding.

### When it is red

- **Before anything else**, confirm the host has pulled a `main` that has this check's broker change.
  Until it has, the broker publishes no deployment headers, and every run is red with `red (missing)`.
  The host pull's timer is the operator's to enable ([`../host-pull/README.md`, Install](../host-pull/README.md#install)); until a pull deploys such a commit, this red is expected.
- **`missing`**: the broker answering does not publish the headers, so it runs a commit from before them, or `/api/health` is answered by something other than this broker.
  Read the commit the host's tree is at: `readlink /opt/alcove-broker/src`.
- **`unknown`**: the broker could not read a file or found a value out of shape.
  Either the host has not run a pull that wrote the files yet, or the broker cannot read them: check that `/var/lib/alcove-host-pull/deployed` and `/var/lib/alcove-host-pull/status` exist, are regular files readable by all (the pull writes them mode 644), and hold what [the pull's Outcomes](../host-pull/README.md#outcomes) shows.
  A host without the pull has neither file, so this check is red for it by design.
- **`failed-pull`**: read the status record, `cat /var/lib/alcove-host-pull/status`, whose `reason` names the step that failed, and `journalctl -u alcove-host-pull.service` for the run.
  After `rolled-back`, the host runs the deployed commit again and the failing commit is tried again at the next run ([`../host-pull/README.md`, What a run does](../host-pull/README.md#what-a-run-does), step 6); after `rollback-failed`, the units are as far as the second attempt got, and the host needs the operator.
- **`lag`**: check that the timer is enabled and has fired, `systemctl list-timers alcove-host-pull.timer`, and read the status record: a run of `skipped` outcomes names what the pull is waiting for, such as CI on the tip or the tip's core build.
- **`not-on-main`**: the marker names a commit `main` does not contain; read the marker and correct it as the pull's Install step 1 says.
- **`unread`**: the check could not reach `/api/health`, read `main`'s history or read GitHub's record of `main`'s updates; the line names which.
  Check that `VITE_SIGNALING_SERVER_URL` is set to a `wss:` URL and that `/api/health` answers `200` at its host and port.

## What is not tracked

Each is ignored by this directory's `.gitignore`, and every script refuses to run rather than defaulting to a value it was not given.

| path | what goes there |
| --- | --- |
| `/etc/alcove-broker/broker.env` | The host's name. Copy [`broker.env.example`](broker.env.example) |
| `/etc/alcove-broker/nginx.conf` | The rendered front configuration |
| `/etc/alcove-broker/acme/` | lego's account and certificates, mode 700 |
| `/etc/alcove-broker/tls/` | The certificate and key the front reads; the key is mode 600 |
| `/etc/alcove-relay/acme.env` | The ACME contact, provider and provider credential, shared with the relay |
