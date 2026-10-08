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
| `alcove-broker.service` | The broker: `npm start -w packages/peerjs-broker -- --path /api` from `/opt/alcove-broker/src`, as `nobody`, on `127.0.0.1:9411` only |
| `nginx.conf.tmpl` | The front's nginx configuration, with the host's name as `__ALCOVE_BROKER_NAME__`: TLS on 8443, `/api/` proxied to the broker with WebSocket upgrade, everything else `404` |
| `render-config.sh` | Prints the template with the name from `broker.env` substituted; refuses a value that is not a DNS name |
| `alcove-broker-tls.service` | The front: `nginx:1.29-alpine` under `docker run`, host network, read-only root, the rendered configuration and `/etc/alcove-broker/tls` mounted read-only, logging to the journal |
| `renew.sh` | ACME DNS-01 issue and renewal through lego, installed as `/etc/alcove-broker/renew.sh`; restarts the front only when the certificate or key changed |
| `alcove-broker-cert.service`, `.timer` | Runs `renew.sh` daily at 04:30 UTC plus up to 15 minutes, after the relay's own renewal window |
| `install.sh` | Installs all of the above and converges on a re-run, then checks `/api/health` through the front |
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
5. `chown -R nobody:nobody /opt/alcove-broker`.

Then the host's configuration, and the install:

```sh
install -d -m 700 /etc/alcove-broker
install -m 600 broker.env.example /etc/alcove-broker/broker.env  # set ALCOVE_BROKER_NAME
./install.sh
```

The name's DNS record points at the host and is DNS-only, and the host's firewall admits TCP 8443; both are the operator's, outside this directory.
The ACME contact and the DNS provider credential come from the relay's `/etc/alcove-relay/acme.env` by default ([`../relay/certs/env.example`](../relay/certs/env.example)); `ALCOVE_BROKER_ACME_ENV` in `broker.env` names another file.

## Logging

All three services write to the host's journal, under the retention the relay's drop-in sets ([`../relay/journald-alcove-relay.conf`](../relay/journald-alcove-relay.conf)).

- **The front's access log names the request path and never its query string.**
  A signaling URL's query contains the rendezvous identifier and the client token, so the log format writes `$request_method $uri $server_protocol`, not `$request`.
  [`scripts/broker-front.test.mjs`](../../scripts/broker-front.test.mjs) fails if a log format in the template writes any variable outside the documented fields, or if the template drops the `http`-level access log and so falls back to nginx's built-in format, which writes the query string.
- **The front's error log** is at `warn`, and the test fails below `warn`. A request line in one of its lines can include the query string ([PRIVACY.md](../../PRIVACY.md)).

A change to the template reaches a running front through `install.sh`.
It renders the configuration to a root-only file under `/etc/alcove-broker` and checks it with `nginx -t` in a throwaway container of the front's image, mounted as the unit mounts it with the installed certificate (on a first install, renewal obtains the certificate before the check).
A configuration that fails the check stops the install with `/etc/alcove-broker/nginx.conf` and the running front unchanged.
One that passes is copied over `/etc/alcove-broker/nginx.conf` in place (the container bind-mounts that file, so a new inode would not reach it) and the front reloads it, keeping open WebSockets.
The front closes a WebSocket idle for 300 s (`proxy_read_timeout`); the PeerJS client sends a heartbeat every 5 s by default (`pingInterval = 5000` in `node_modules/peerjs/dist/peerjs.js`, peerjs 1.5.5, not overridden in `apps/` or `packages/`), so a live connection stays open.

## Certificates

Let's Encrypt over DNS-01 through lego v5, as for the relay ([`../relay/README.md`, Certificates](../relay/README.md#certificates)).
`lego run --renew-days 30` issues the first certificate and after that renews only inside its window, so the daily timer is a no-op on most days and the front keeps running.
The provider credential is exported only to lego's subshell.

Two overrides exist for a run by hand: `ALCOVE_BROKER_RENEW_DAYS` widens the window (365 forces a renewal) and `ALCOVE_BROKER_LEGO_EXTRA` appends lego flags (`--no-random-sleep`).
Each forced renewal counts against Let's Encrypt's limit of five duplicate certificates a week.

## Exposure

`systemd-analyze security alcove-broker.service` scores the unit EXPOSED (the score is in the [deployment note's Unit exposure bullet](../../docs/notes/webrtc-relay-deployment.md)), and systemd warns at load that `User=nobody` is not safe.
The unit is the deployed one; tightening it is a change to measure on the host first.

## What is not tracked

Each is ignored by this directory's `.gitignore`, and every script refuses to run rather than defaulting to a value it was not given.

| path | what goes there |
| --- | --- |
| `/etc/alcove-broker/broker.env` | The host's name. Copy [`broker.env.example`](broker.env.example) |
| `/etc/alcove-broker/nginx.conf` | The rendered front configuration |
| `/etc/alcove-broker/acme/` | lego's account and certificates, mode 700 |
| `/etc/alcove-broker/tls/` | The certificate and key the front reads; the key is mode 600 |
| `/etc/alcove-relay/acme.env` | The ACME contact, provider and provider credential, shared with the relay |
