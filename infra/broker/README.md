# The standalone peer-coordination broker: host units

The units, the TLS front's configuration and the certificate renewal that run the broker workspace's standalone entry point (`packages/peerjs-broker`, `npm start`) on a host of its own.
The project runs it on the standing relay's instance, beside coturn ([`../relay/README.md`](../relay/README.md)).
What the deployment measured is recorded in [the deployment record](../../docs/notes/webrtc-relay-deployment.md#does-the-coordination-server-leave-the-web-apps-deployment).

## Port 8443, and the limit it sets

The front listens on **8443**, not 443, because coturn listens on 443 on the same host for TURN over TLS.
A party whose network admits outbound TCP only to 443 cannot reach the broker there.
That remains so until 443 is split between coturn and the front on the one host; until then, the broker's URL names `:8443`.

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
| `alcove-broker-cert.service`, `.timer` | Runs `renew.sh` daily at 04:30 UTC plus up to 15 minutes, after the relay's own renewal window |
| `install.sh` | Creates the broker's system user if it is missing, installs all of the above and converges on a re-run, then checks `/api/health` through the front |
| `broker.env.example` | The host's one configuration file, copied to `/etc/alcove-broker/broker.env` |

## Install

The broker's workspace is a precondition `install.sh` checks for and does not create.
On a host the size of the relay's (412 MB of memory), a full-workspace `npm ci` OOM-killed coturn, so the install is scoped to the broker workspace and core is built elsewhere:

1. Install Node under `/usr/local/lib/nodejs`, from the official tarball checked against its published `SHASUMS256.txt`, with `node` and `npm` linked into `/usr/local/bin`; the unit runs `/usr/local/bin/npm`.
   On Amazon Linux 2023 the tarball needs `tar`, `xz` and `libatomic`, and the clone needs `git`.
2. Clone the repository at the commit to deploy into `/opt/alcove-broker/src`.
3. In that clone, install the broker workspace alone, at low priority beside coturn:

   ```sh
   nice -n 10 ionice -c 3 npm ci --no-audit --no-fund --workspace packages/peerjs-broker
   ```

4. Build core on another machine at the same commit (`npm run build -w packages/core`) and copy `packages/core/dist/untrusted-text.esm.js` and the one chunk it imports into the clone's `packages/core/dist/`, checking their sha256 sums on arrival.
   That entry point is the whole of the broker's reach into core.
5. Leave the tree owned by root and readable by all, so the broker's account cannot rewrite the code it runs: `chown -R root:root /opt/alcove-broker && chmod -R u=rwX,go=rX /opt/alcove-broker`.

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

The name's DNS record points at the host and is DNS-only, and the host's firewall admits TCP 8443; both are the operator's, outside this directory.
The ACME contact and the DNS provider credential come from the relay's `/etc/alcove-relay/acme.env` by default ([`../relay/certs/env.example`](../relay/certs/env.example)); `ALCOVE_BROKER_ACME_ENV` in `broker.env` names another file.

## Logging

All three services write to the host's journal, under the retention the relay's drop-in sets ([`../relay/journald-alcove-relay.conf`](../relay/journald-alcove-relay.conf)).

- **The front's access log names the request path and never its query string.**
  A signaling URL's query contains the rendezvous identifier and the client token, so the log format writes `$request_method $uri $server_protocol`, not `$request`.
  [`scripts/broker-front.test.mjs`](../../scripts/broker-front.test.mjs) fails if a log format in the template writes any variable outside the documented fields, or if the template drops the `http`-level access log and so falls back to nginx's built-in format, which writes the query string.
- **The front's error log** is at `warn`, and the test fails below `warn`. A request line in one of its lines can include the query string ([PRIVACY.md](../../PRIVACY.md)).

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

`systemd-analyze security alcove-broker.service` scored the unit 8.6 EXPOSED with `NoNewPrivileges=`, `PrivateTmp=`, `ProtectSystem=strict` and `ProtectHome=` as its only sandboxing.
With the sandbox measured on the host on 2026-10-08 (systemd 252) and set in the tracked unit, it scored 1.3 OK, the broker answered `/api/health` and a CLI invite/accept exchange completed through the front ([the deployment note's Unit exposure bullet](../../docs/notes/webrtc-relay-deployment.md)).
The tracked unit, deployed on 2026-10-09, scored the same 1.3 OK, still as `nobody`, and `systemd-analyze verify` warned `Special user nobody configured, this is not safe!`.
On the same day, the sandbox under the system user `alcove-broker` instead scored 0.9 SAFE, and the broker answered `/api/health` and a WebSocket upgrade, with no restarts; the tracked unit runs as that user.

`DynamicUser=yes` with a home directory also scored 0.9 SAFE and served, with `Environment=HOME=/run/alcove-broker` and `RuntimeDirectory=alcove-broker`.
It is not used: it left `/run/alcove-broker` behind owned by the released uid, and `getent` does not resolve the dynamic user on this host.
Without a home directory, npm exits at start with status 254 and the unit restarts in a loop.
The journal line: `A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)`.

`MemoryDenyWriteExecute=yes` is left out because the broker did not start under it: node aborts at start with a core dump on SIGTRAP; V8 cannot change a mapping's permissions.
The journal line: `# Check failed: 12 == (*__errno_location ()).`, from `v8::base::OS::SetPermissions`.

A stop leaves the broker `inactive`, not `failed`: npm exits 143 on the stop's SIGTERM, and `SuccessExitStatus=143` counts that as a clean exit (measured on the host).

## What is not tracked

Each is ignored by this directory's `.gitignore`, and every script refuses to run rather than defaulting to a value it was not given.

| path | what goes there |
| --- | --- |
| `/etc/alcove-broker/broker.env` | The host's name. Copy [`broker.env.example`](broker.env.example) |
| `/etc/alcove-broker/nginx.conf` | The rendered front configuration |
| `/etc/alcove-broker/acme/` | lego's account and certificates, mode 700 |
| `/etc/alcove-broker/tls/` | The certificate and key the front reads; the key is mode 600 |
| `/etc/alcove-relay/acme.env` | The ACME contact, provider and provider credential, shared with the relay |
