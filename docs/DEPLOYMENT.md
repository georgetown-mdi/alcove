---
title: "Alcove Deployment"
---

# Alcove deployment

This document covers the deployment and operation of the supporting services Alcove exchanges use, the network links each role opens, how large an exchange each approach can run, and Docker deployment of the CLI. It does not cover the communication protocol those services support (see [COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them (see [CLI.md](CLI.md)). Running the same image as the operator's local console is its own document (see [CONSOLE.md](CONSOLE.md)). Intended readers are system administrators and IT staff.

## Network requirements

Every link an Alcove deployment opens, by role. "Out" means the named party opens the connection; "in" means it accepts one. A default port is the one used when the configuration names none. Each row links to the field or command that sets it, which is the authoritative statement. What each service's operator can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe), and which links have the application-layer encryption is in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security).

Not documented for any role: the ports and transports of a direct (non-relayed) WebRTC path between the two parties, whether a WebRTC exchange works on an IPv6-only network, and whether the CLI's HTTPS and WebSocket links honor an outbound proxy. The one proxy behavior stated is how a coordination-server certificate failure is reported when Node's environment proxying is on ([CLI.md](CLI.md#when-a-webrtc-exchange-does-not-connect)).

### CLI over SFTP

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| SFTP server | SSH, TCP 22 | Out | The SSH session and the exchange's files | [`connection.server`](EXCHANGE_REFERENCE.md#connectionserver) |
| DNS resolver | DNS, UDP and TCP 53 | Out | The server's name; nothing when the server is named by address | The host, or `--dns` ([An allowlist for an SFTP exchange](#an-allowlist-for-an-sftp-exchange)) |
| Provisioning endpoint | HTTPS, 443 | Out, before each run, online invite, accept or quick exchange in start mode, once per invitation in create mode | A request to start or create the server, with optional credentials | [On-demand server provisioning](EXCHANGE_REFERENCE.md#on-demand-server-provisioning) |

`alcove probe-host-key` dials the same SFTP endpoint and sends no credential ([CLI.md](CLI.md#reading-a-host-key-with-probe-host-key)).

### CLI over a shared folder

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| The shared folder | A mount; the host performs any network file access | None from the container | The exchange's files | [`connection.path`](EXCHANGE_REFERENCE.md#connectionpath) |
| SMB file server, for `alcove doctor probe` only | SMB, TCP 445 | Out | The account's credentials and test file operations | [Checking a network shared folder](CLI.md#checking-a-network-shared-folder) |

### CLI over WebRTC

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| Coordination server | `wss:`, TCP 443; `ws:` and 80 with `secure: false` | Out | Rendezvous ids derived from the shared secret, session descriptions, candidate addresses | [`connection.server`](EXCHANGE_REFERENCE.md#connectionserver) |
| Web app's `/alcove.json` | HTTPS, or HTTP for an `http://` address; the address's port | Out, once, on `alcove invite` given a web app's address | One request; nothing about the exchange | [Inviting over WebRTC](CLI.md#inviting-over-webrtc) |
| STUN server | STUN, the url's port; default `stun:stun.l.google.com:19302`; transport not documented | Out | A query for the host's public address | [STUN, and what it discloses](CLI.md#stun-and-what-it-discloses) |
| TURN relay | `turn:` 3478, UDP then TCP (TCP alone with `?transport=tcp`); `turns:` 5349, TLS | Out, on the first TURN url the run lists | A derived or configured credential, and the WebRTC channel when relayed | [`connection.turn`](EXCHANGE_REFERENCE.md#connectionturn), [`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays) |
| WebSocket relay | `wss:`, 443 | Out, as the run starts waiting for the partner | The exchange id and role; the exchange's messages when no WebRTC path opens | [`connection.websocket_relay`](EXCHANGE_REFERENCE.md#connectionwebsocket_relay) |
| Relay registrar | HTTPS, 443; the url's port when it names one (the reference registrar's own is 8443) | Out: `alcove enroll-relay`; after each run that rotates the key; before contacting the partner when the last registration is unconfirmed; before connecting at an invitation's registrar; and on `alcove doctor relay` where the run would enroll there | The exchange id and its relay key (a rotation signed with the key it replaces); the relay-owner token on `enroll-relay` only | [Registering the relay key at your relay](CLI.md#registering-the-relay-key-at-your-relay) |
| Provisioning endpoint | HTTPS, 443 | Out, before each run, online invite, accept or quick exchange in start mode, once per invitation in create mode | A request to start or create the server, with optional credentials | [On-demand server provisioning](EXCHANGE_REFERENCE.md#on-demand-server-provisioning) |
| Partner's computer | WebRTC data channel; ports not documented | Both, by ICE | The exchange, under application-layer encryption | -- |

The CLI refuses [`connection.ice_provision`](EXCHANGE_REFERENCE.md#connectionice_provision), so it opens no link for it. To find which of these a failed run could not reach, see [When a WebRTC exchange does not connect](CLI.md#when-a-webrtc-exchange-does-not-connect) and [Checking the relay of a WebRTC exchange](CLI.md#checking-the-relay-of-a-webrtc-exchange).

### Console

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| Operator's browser | HTTP, `127.0.0.1:3000` on the host to container port 3000 | In | The web page and the job API, including any pasted SFTP credential | `-p`, `PORT` ([Running the container](CONSOLE.md#running-the-container)) |
| Each endpoint of the exchange's channel | As the CLI rows above | Out | As above | [Authoring the SFTP connection](CONSOLE.md#authoring-the-sftp-connection), [Running a WebRTC exchange](CONSOLE.md#running-a-webrtc-exchange) |

Given a web app's address, the console reads that app's `/alcove.json` once, as `alcove invite` does. Who can reach the inbound port is decided by the publish binding ([Reachable only where you publish it](CONSOLE.md#reachable-only-where-you-publish-it)).

### Browser

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| Web application host | HTTPS, or HTTP for a site served over `http` | Out | The static site | The site's address |
| Coordination server | `wss:` for a site served over `https`, `ws:` over `http` | Out | As for the CLI | `VITE_SIGNALING_SERVER_URL` ([Coordination server](#coordination-server)), the browser's relay settings, or the invitation |
| STUN server | Default `stun:stun.l.google.com:19302`, only where neither the relay settings nor the invitation names one | Out | A query for the browser's public address | [Relay settings](WEB_APP.md#relay-settings) |
| TURN relay, WebSocket relay, registrar | As for the CLI | Out | As for the CLI | [Relay settings](WEB_APP.md#relay-settings), [The default relay](#the-default-relay), the invitation |
| Partner's computer | WebRTC data channel; ports not documented | Both, by ICE | The exchange, under application-layer encryption | -- |

A browser that cannot reach its relay reports it as in [A relay that could not be reached](#a-relay-that-could-not-be-reached).

### Coordination-server operator

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| Parties, browsers and CLIs | `wss:` through a TLS reverse proxy; the broker itself listens on `--port` or `ALCOVE_BROKER_PORT`, default an ephemeral port on `127.0.0.1` | In | Signaling messages | [packages/peerjs-broker/README.md](../packages/peerjs-broker/README.md), [Hardening the coordination server](#hardening-the-coordination-server) |

The project's own broker is reached on TCP 443 through its relay host's front and on 8443 ([The project's hosted web deployment](#the-projects-hosted-web-deployment)).

### Relay operator

| Endpoint | Protocol and default port | Direction | What crosses it | Where configured |
| -------- | ------------------------- | --------- | --------------- | ---------------- |
| TURN clients | The port the published TURN url names; the reference relay takes TURN over TLS on its 443 front | In | Allocations, and the relayed WebRTC channel | [infra/relay/README.md](../infra/relay/README.md#the-443-front) |
| Registrar clients | HTTPS, 443 under a name of its own, otherwise `ALCOVE_RELAY_REGISTRAR_PORT` (8443 where unset; 8444 in `relay.env.example`, beside the broker) | In | Enrollments, rotations, revocations | [infra/relay/README.md](../infra/relay/README.md#the-registrar) |
| Peers of a relayed allocation | UDP, 49152-49200 in the reference (`ALCOVE_RELAY_MIN_PORT`, `ALCOVE_RELAY_MAX_PORT`) | In and out | The relayed WebRTC channel | [infra/relay/aws/provision.md](../infra/relay/aws/provision.md#ports) |
| WebSocket relay clients | `wss:`, 443, behind the 443 front | In | Paired parties' messages | [infra/relay/README.md](../infra/relay/README.md#the-websocket-relay) |

The reference relay opens no TURN listener on UDP and no port 3478: clients reach it only over TLS on the 443 front, and its relay range carries peer traffic whatever transport the client arrived on.

## How large an exchange can be

Each figure below is a fixed limit or a measured run recorded in the specification, linked beside it. The times are for whole runs on the machines the sources name; yours will differ with the hardware, the network between the parties, and the number of linkage keys.

### In the browser

- **The input file is at most 200 MiB.** That held 3.18 million rows of a six-column identifier file and 6.22 million rows of a two-column one in the measured runs ([The memory ceiling, and the CSV intake cap](spec/PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)).
- **A set the browser receives holds at most 8,388,608 values**, about one per record for each linkage key. Your partner's run refuses to send a larger set, before sending it, and names the remedies: split the input, or run the exchange with the command line app ([The receive ceiling](spec/PROTOCOL.md#the-receive-ceiling)).
- **The largest browser round measured to completion is 8,388,608 records a side, with the browser in either role.** Each took about 95 minutes on a 6-CPU machine with 31 GB of memory in headless Chromium ([What a browser tab can match](spec/PROTOCOL.md#what-a-browser-tab-can-match)). An exchange runs one such round for each linkage key, over the records an earlier key has not matched. At 10,000,000 records a side the round completed only with the browser as the joiner.

A command line party exchanging with a browser partner is held to the browser's limits above.

### Command line app over WebRTC

Two command line parties, measured to completion; the runs at 1 to 4 million records and the two-machine run used four linkage keys ([The main thread on an open channel](spec/WEBRTC_TRANSPORT.md#the-main-thread-on-an-open-channel), [The receive ceiling](spec/PROTOCOL.md#the-receive-ceiling), [A round between two hosts](spec/WEBRTC_TRANSPORT.md#a-round-between-two-hosts)):

| Records a side | Where the parties ran | Whole run | Peak memory a party |
| --- | --- | --- | --- |
| 1,000,000 | one machine | 229 s, about 4 minutes | not recorded |
| 2,000,000 | one machine | 379 s and 401 s in two runs, under 7 minutes | not recorded |
| 4,000,000 | one machine | 888 s, about 15 minutes | not recorded |
| 7,700,000 | one machine | 1,178,964 ms, about 20 minutes | 12.2 GB and 13.3 GB |
| 7,700,000 | two machines on one local network | 1,486,794 ms and 1,488,196 ms, about 25 minutes | 15.3 GB and 17.1 GB |

### Command line app over SFTP or a shared folder

- **A set holds at most 16,777,216 values**, the protocol's maximum ([Round set size limits](spec/FILE_SYNC.md#round-set-size-limits)).
- **Measured to completion at that maximum, 16,777,216 records a side**, one party on each of two machines on one local network, one reaching the folder directly and the other over SFTP: about 64 minutes (3,826,025 ms and 3,760,626 ms), with a peak memory of 29.9 GB and at least 22.5 GB a party ([Measured runs at 2^24](spec/FILE_SYNC.md#measured-runs-at-224)).
- **Preparing the input** at that size, from reading the file to the start of the first round, took within 27 s per million records on one 10-CPU machine ([Preparing the input at 2^24](spec/FILE_SYNC.md#preparing-the-input-at-224)).
- **Memory is checked before the run contacts anyone.** The matching needs about 271 MB plus 1.2 KB a record, and a run without that much stops with exit 64 naming both figures ([Memory for a large exchange](CLI.md#memory-for-a-large-exchange)). A whole run holds more than the matching alone, as the peak memory above shows.
- **Smaller sizes over SFTP or a shared folder are not measured** as whole runs. Each round waits on the partner's files, so the folder's polling interval and sync delay add to every round ([`poll_interval_ms`](EXCHANGE_REFERENCE.md#connectionoptions)).

## STUN/TURN

Alcove does not bundle a STUN or TURN server. A deployment needing NAT traversal for WebRTC either points at a commercial ICE-credential service (Twilio Network Traversal Service and equivalents return time-limited credentials on demand; see [COMMUNICATION.md#stunturn](COMMUNICATION.md#stunturn)) or operates a relay of its own.

For the self-hosted case, [`infra/relay/`](../infra/relay/README.md) is a reference deployment of coturn on a dedicated instance: a digest-pinned image, a hardened configuration, the unit that supervises it, ACME certificate renewal, scripts that register and revoke each exchange's relay key, and a verification script. Its README is the operational document -- what to launch, what to open, and the order of operations -- and its [Design records and tests](../infra/relay/README.md#design-records-and-tests) section states how far the reference is verified. Treat it as a starting point to verify in your own environment rather than a validated configuration.

The reference relay authenticates against a table of per-exchange keys ([Per-exchange keys](../infra/relay/README.md#per-exchange-keys)):

- **One key per exchange.** Each exchange's relay key, derived from its shared secret ([PROTOCOL.md](spec/PROTOCOL.md#relay-credential-derivation)), is a row the relay's operator adds with `register-exchange.sh` and removes with `revoke-exchange.sh`, on the relay host or through the optional HTTPS [registrar](../infra/relay/README.md#the-registrar), which writes the table through the same code. The registrar enrolls an exchange for a caller holding the relay-owner token, or, where the operator turns enrollment without a token on, for any caller under a per-address rate limit; it rotates or revokes it for a caller proving it holds the key the exchange has registered. The relay reads the table per request, so neither needs a restart.
- **What revoking stops.** New allocations under the key. An allocation already open is not cut: a client that keeps refreshing keeps it, past the revoke and past its credential's expiry, and one that stops refreshing loses it within the relay's `max-allocate-lifetime`. The measurements are under Revoking in [Per-exchange keys](../infra/relay/README.md#per-exchange-keys).
- **How long a row lives.** A row registered with a max age in days -- the managed-exchange record's `tokenMaxAgeDays` ([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)) -- lapses that many days after its registration, and a sweep on the relay every ten minutes revokes it. Each run registers the exchange's next key, which replaces the row and restarts the count, so the relay forgets an exchange after the same number of days of inactivity (no successful run) as the record's shared secret, and a re-invite is needed. A row registered without one lives until it is revoked or replaced. The relay has no setting of its own for this, except for a row the registrar enrolled without the relay-owner token, which lapses a time the registrar fixes after its enrollment ([PROTOCOL.md, Enrolling without a token](spec/PROTOCOL.md#enrolling-without-a-token)).
- **The static secret during a migration.** A relay may keep its single static secret set beside the table: coturn accepts a credential under either, so credentials issued under the static secret keep working until the operator removes it.

A relay forwards the encrypted WebRTC channel without terminating it. The same reference can run a [WebSocket relay](../infra/relay/README.md#the-websocket-relay) behind its 443 front, for two parties whose network stops TURN but passes a WebSocket on 443; it admits the exchanges the same key table holds and forwards their messages unread. No commercial service runs this relay, so a party that will not accept another's runs its own from this reference. When a run uses it: [COMMUNICATION.md](COMMUNICATION.md#websocket-relay). What a TURN or WebSocket relay's operator can observe: [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

## WebSocket-to-TCP proxy

A WebSocket-to-TCP proxy is required only when a browser-based party needs to reach an SFTP server, because browser runtimes cannot open raw TCP connections (see [COMMUNICATION.md#websocket-to-tcp-proxy](COMMUNICATION.md#websocket-to-tcp-proxy)). The CLI does not need this proxy.

The SFTP relay (`packages/sftp-relay`) is that proxy. The operator of an SFTP server runs it in front of that one server: it forwards each WebSocket from an allowed web application to the server, and SSH runs end to end through it. No browser SFTP client uses it yet. Its wire, close codes and bounds are in [SFTP_RELAY.md](spec/SFTP_RELAY.md).

### The relay's reference configuration

Three settings make a deployment:

- **The target.** `--target host:port` names the SFTP server as the relay's host reaches it. Every connection goes there, and nothing a browser sends changes it. A second SFTP server needs a second relay.
- **The allowlist.** `--allowed-origin` names the origin of a web application whose pages may use the relay, once for each, such as `https://alcove.example.org`. An upgrade from any other origin, or with none, is refused before the relay opens a connection to the server. The relay refuses to start on an entry not written as a browser sends it, and names the form it expects.
- **TLS in front.** The relay terminates no TLS. Put it behind a reverse proxy that does, on 443, so a browser dials `wss://`.

The image is not yet published, so build it from a checkout and run it with the two settings:

```sh
docker build -f packages/sftp-relay/Dockerfile -t alcove-sftp-relay .
docker run -d --name alcove-sftp-relay --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  alcove-sftp-relay \
  --target sftp.internal.example.org:22 \
  --allowed-origin https://alcove.example.org
```

The `-p` binding publishes the relay on the host's loopback only, for the reverse proxy beside it. The relay prints `alcove-sftp-relay 8080` once it is listening, and exits 64 on a missing or malformed setting.

The reverse proxy forwards the `/sftp` upgrade, passing the browser's `Origin` header through unchanged, as nginx does by default:

```nginx
# server{} context, inside the TLS server block for the relay's name.
location = /sftp {
    proxy_pass          http://127.0.0.1:8080;
    proxy_http_version  1.1;
    proxy_set_header    Upgrade    $http_upgrade;
    proxy_set_header    Connection "upgrade";
    proxy_set_header    Host       $host;
}
```

What the `Origin` check does and does not do:

- **It stops other pages.** A page from another origin cannot use the relay from a visitor's browser.
- **It is not authentication.** A client that is not a browser can send any `Origin`, so the relay exposes the SSH port to anyone who can reach the relay, about as widely as publishing that port would. The SFTP server's own authentication is the gate.
- **Per-address limits are the front's.** Behind the reverse proxy the relay sees only the proxy's address, so a limit on connections from one address belongs at the proxy, as for the [coordination server](#hardening-the-coordination-server).

The relay's container needs to reach the SFTP server and nothing else; [Restricting the container's outbound network access](#restricting-the-containers-outbound-network-access) shows how to hold a container to one endpoint.

## Coordination server

The coordination server is a PeerJS-compatible server that runs as a service of its own: the standalone server in `packages/peerjs-broker` (`npm start -w packages/peerjs-broker`), on a host of its own. The web application serves no coordination server. The public PeerJS service (`api.peerjs.com`) is also usable for evaluation but routes connection-establishment metadata through a third party.

To name the coordination server the web application's browser parties use, set `VITE_SIGNALING_SERVER_URL` when building the web application:

```sh
VITE_SIGNALING_SERVER_URL=wss://signaling.example.org/api/ npm run build -w apps/web
```

- The value is a `ws:` or `wss:` URL whose path is the server's mount; the server's mount and how to set it: [packages/peerjs-broker/README.md](../packages/peerjs-broker/README.md).
- The hosted build, `npm run build -w apps/web`, refuses to run without it. In the deploy workflow the repository variable `VITE_SIGNALING_SERVER_URL` is required for the deploy build; pull-request builds use a placeholder.
- The development server and the console builds keep a default: unset or blank, the browser parties dial the web application's own origin at `/api/`, which the development server (`npm run dev` from the repository root) forwards to a broker it starts.
- The URL's scheme must match the deployment's: `wss:` for one served over `https`, `ws:` for one served over `http`. A mismatch is refused when the app loads.
- Every invitation a browser on the deployment creates names that server, and its inviter registers there, so a party accepting a fresh invitation dials it from whatever deployment they open it in. A saved exchange's later runs do the same: each party's record keeps the server its invitation named, so the two parties' deployments need not name the same server.
- A user can set their own coordination server in the web application's relay settings, kept in that browser ([WEB_APP.md](WEB_APP.md#relay-settings)). The invitations that browser creates from then on name that server instead, and both parties reach it. The build's value stays the default for every browser that sets none, and the build still requires it.
- The value is fixed at build time, so changing it means rebuilding and redeploying; an invitation already sent keeps naming the server it was created with, as does a saved exchange until its inviter re-invites from it.
- The hosted build also publishes it as a static file, `/alcove.json`, which `alcove invite` reads when given the web application's address, so a CLI inviter dials the same server ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-published-coordination-server)). The file names the build's value, never a browser's own setting.

How the address is resolved, and what the invitation endpoint states: [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-browser-partys-own-signaling-address).

## The default relay

A web application build can name a TURN relay for its browser exchanges, so a party on a network that blocks direct paths still connects. `VITE_DEFAULT_RELAY_MODE` sets whether the build offers it switched off until the user turns it on, or turns it on in every browser exchange. Set two variables when building, both or neither:

```sh
VITE_DEFAULT_RELAY_TURN_URL=turns:relay.example.org:443?transport=tcp \
VITE_DEFAULT_RELAY_REGISTRAR_URL=https://registrar.example.org \
VITE_SIGNALING_SERVER_URL=wss://signaling.example.org/api/ npm run build -w apps/web
```

- **`VITE_DEFAULT_RELAY_TURN_URL`** is one `turn:` or `turns:` url, in the grammar of [`connection.turn`](EXCHANGE_REFERENCE.md#connectionturn).
- **`VITE_DEFAULT_RELAY_REGISTRAR_URL`** is the `https://` address of that relay's [registrar](../infra/relay/README.md#the-registrar), which must take an enrollment without a token ([PROTOCOL.md](spec/PROTOCOL.md#enrolling-at-a-default-relay)).
- **`VITE_DEFAULT_RELAY_MODE`** is `opt-in`, the value when it is unset, or `on`. Both modes cover the relay's TURN url and its WebSocket relay url alike.
  - **`opt-in`:** a browser exchange uses the relay only where the user turned on **use this site's relay server** on the Relay server page, which this browser keeps for the site ([WEB_APP.md](WEB_APP.md#relay-settings)); where the invitation it accepts names the relay, whichever site or command-line party made that invitation; or where the browser's own relay setting names the relay's TURN url, which the run then enrolls for as it does for an invitation's. An accepting run takes each of the relay's urls only where the invitation names that url. When a run's connection does not open while the relay is off, and the exchange's Allowed relays keep it, the failure message says that turning it on and trying again may let the exchange connect. The start page refuses a full invitation link made on [the demo site](#the-demo-site), saying to open the link itself, and takes the same invitation's bare code.
  - **`on`:** every browser exchange uses the relay, and the Relay server page offers no switch.
- **What each run does.** Right before it connects, each browser run that uses the relay, and whose allowed relays do not leave out its TURN url, enrolls the exchange's relay key at the registrar and lists the relay once enrolled ([PROTOCOL.md](spec/PROTOCOL.md#enrolling-at-a-default-relay)). A run whose enrollment fails says so and connects with its other relays. A run that does not use the relay neither enrolls there nor lists it.
- **`VITE_DEFAULT_RELAY_WEBSOCKET_URL`**, optional and set only beside the two above, is the `wss://` address of the relay host's [WebSocket relay](../infra/relay/README.md#the-websocket-relay), in the grammar of [`connection.websocket_relay`](EXCHANGE_REFERENCE.md#connectionwebsocket_relay). That relay admits the keys the registrar enrolls. Every browser invitation created with the relay in use names it, with the registrar, where the inviter's own relay setting names no WebSocket relay. A browser run that uses it enrolls at the registrar, for it alone where the run's allowed relays leave out the TURN url, and dials it as a fallback for when no WebRTC path opens ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)).
- **What each invitation names.** Every browser invitation created with the relay in use names the relay and its registrar, after the inviter's own relay, without contacting the registrar; one created with it switched off names neither. A command-line partner accepting it lists the relay beside its own, and enrolls the key at the registrar before it connects when it allocates on the relay's TURN url or dials its WebSocket relay url under the id derived from the secret ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)).
- **What the relay's operator learns** is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe). A deployment that names a default relay states it in its privacy statement, as [PRIVACY.md](../PRIVACY.md#hosted-web-application) does for the project's.
- **A misconfiguration stops the build.** The TURN url or the registrar set without the other, the WebSocket relay set without both, a value that is not a url of its kind, or a mode other than `opt-in` or `on`, is refused by the build and by the page at load.
- **Unset,** the build names no default relay, and each run lists any relay the invitation or the browser's own setting names, and the default STUN server only where neither names a STUN server ([WEB_APP.md](WEB_APP.md#relay-settings)).

### Hardening the coordination server

The coordination server relays setup messages and never sees exchange data (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)), so the exposure on its WebSocket upgrade surface is resource exhaustion and nuisance. The standalone coordination server enforces these guards itself, unconditionally:

- A slow, partial, or idle upgrade handshake (a "slowloris" that dribbles, stalls, or connects and sends nothing) is bounded by connection-level timeouts and closed server-side. These bounds cover the window before a request has wholly arrived; bounding the connection past that point is the deployment's, below.
- Each signaling message is size-capped.
- A client that registers but sends no heartbeat is reaped within seconds, well before the liveness timeout that governs an established peer; a real peer, which heartbeats within seconds of connecting, is never cut short.
- A registered client holds one connection at a time. A peer that connects again under credentials it has already registered attaches to that registration, and the connection it displaces is closed.
- The hold-for-reconnect message queues are bounded in count and depth, so a client cannot drive unbounded memory by addressing messages to many made-up recipients.

The constant values are in [SIGNALING_SERVER_BOUNDS.md](spec/SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds).

Three further protections are the reverse proxy's responsibility, because only the proxy sees the real client origin and address, and only the proxy stands between a slow reader and the application:

- **Response-drain limits.** A client that asks for a response and stops reading it holds the connection, and the bytes queued for it, as long as it likes. The application does not bound that; its connection timeouts cover only the window before a request has arrived. A reverse proxy that buffers the response releases the application's connection at the proxy's pace, and the proxy's own send and read timeouts close a client that has stopped reading. Confirm those timeouts and response buffering are on before exposing a deployment publicly.
- **Origin / cross-site enforcement.** The application does not restrict the WebSocket upgrade by Origin, because it is not configured with its public origin. A cross-site connection gains nothing an unauthenticated script does not already have. To restrict the upgrade by Origin, do it at the reverse proxy.
- **Per-address rate limiting.** Behind a proxy the application sees only the proxy's address, so per-address limits on connections or registrations belong at the proxy or hosting layer. The in-application reaper clears sockets that register and go silent, but a flood that keeps each socket alive with heartbeats meets only the global registered-client cap, shared across all clients.

A deployment with no reverse proxy gets the in-application guards above but none of these three. Run the coordination server behind a reverse proxy.

The Origin and rate-limiting controls scope to the `/api/peerjs` upgrade path; a drain limit is configured with the proxy's own timeout and buffering settings. The following nginx reference shows where each of the two scoped controls goes; the rate and connection limits are illustrative starting points to tune to your load, not recommended values:

```nginx
# http{} context: per-client-address shared-memory zones.
limit_req_zone  $binary_remote_addr  zone=alcove_sig_req:10m   rate=10r/s;
limit_conn_zone $binary_remote_addr  zone=alcove_sig_conn:10m;

# Optional Origin allowlist (a browser always sends Origin on a WS upgrade).
map $http_origin $alcove_origin_ok {
    default                        0;
    "https://alcove.example.org"  1;   # replace with your public origin(s)
}

# server{} context: scope the controls to the signaling upgrade location. The `^~`
# prefix makes this match win over the catch-all `location /` and stops a later
# regex location from taking precedence and silently dropping these limits.
location ^~ /api/peerjs {
    if ($alcove_origin_ok = 0) { return 403; }   # remove to skip Origin checks

    limit_req   zone=alcove_sig_req burst=20 nodelay;   # new-connection rate per address
    limit_conn  alcove_sig_conn 32;                     # concurrent connections per address

    proxy_pass          http://alcove_app;              # your upstream
    proxy_http_version  1.1;
    proxy_set_header    Upgrade    $http_upgrade;
    proxy_set_header    Connection "upgrade";
    proxy_set_header    Host       $host;
}
```

The controls belong in front of the standalone broker. Behind a load balancer, nginx sees the balancer's address rather than the client's, so recover the real client address from `X-Forwarded-For` (nginx's `real_ip` module, with `set_real_ip_from` scoped to the balancer's subnets -- not the whole VPC, which would let any host in it forge `X-Forwarded-For`). Before exposing a deployment publicly, confirm the limits suit your load, recover the real client address if you run load-balanced, and keep the Origin allowlist only with your public origins in it.

## The project's hosted web deployment

The project runs a public deployment of the web application at `psi.data-bridge.org`, suitable for real exchanges and operated on a best-effort basis with no uptime commitment; [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md#responsibility-split-hosted-web-application) states what operating it takes on. Its `staging` builds are served at `staging.data-bridge.org`, and [the demo site](#the-demo-site) at `demo.data-bridge.org`. An agency deploying the web application itself serves the same static build from a host of its own and owns every setting described here.

- **The site** is served by a Cloudflare Pages project with no Git source: GitHub Actions builds it and uploads each build. The Pages project, its custom domains, and the zone settings below are declared in the [OpenTofu root](../infra/hosted/README.md), which the maintainer applies from outside the container and nothing in the repository runs.
- **The coordination server, the TURN relay and the WebSocket relay are outside Cloudflare.** `signal.data-bridge.org`, `turn.data-bridge.org` and `relay.data-bridge.org` are DNS-only records in the zone, pointing at one host the project runs, which runs the broker, its nginx TLS front, the relay (coturn) and the WebSocket relay.
- **One listener on port 443, the relay's 443 front, routes each connection by the server name it asks for:** to the broker's front unopened; to coturn, terminating the TURN client's TLS itself and passing coturn the client's address; or to the WebSocket relay at `relay.data-bridge.org`, terminating the TLS itself and passing the relay no client address ([infra/relay/README.md](../infra/relay/README.md#the-websocket-relay)). The broker's front also answers on 8443.
- **The units and configuration** for the broker and its front are in [`infra/broker/`](../infra/broker/README.md), and the relay's in [`infra/relay/`](../infra/relay/README.md).

### Deploying to Cloudflare Pages

The web application builds only as a static site: `npm run build -w apps/web` writes `apps/web/dist/hosted/` and no server ([notes/hosted-static-build.md](notes/hosted-static-build.md)). [`pages_deploy.yaml`](../.github/workflows/pages_deploy.yaml) uploads that directory to the Pages project by direct upload, on a push to `main` or `staging` that changes a deploy-affecting source and by manual dispatch on either branch, and only when every suite in [`web_build_and_test.yaml`](../.github/workflows/web_build_and_test.yaml) passes. The trigger, path filter and gate are described in the workflow file.

- **Build and artifact:** the gate's packaging job builds the site with `VITE_SIGNALING_SERVER_URL` set from the variable of that name, and fails when it is unset. The same job builds [the demo site](#the-demo-site) as a second artifact.
- **Upload:** a job of its own, which checks out nothing, downloads the artifact and runs `wrangler pages deploy` with the branch name. A deployment to `main` is the production deployment; one to `staging` is a preview, served on the project's `staging` branch alias (`staging.<project>.pages.dev`). The same job then uploads the demo site's artifact to the demo project. It and the project site's upload job ([The project site](#the-project-site)) are the only jobs in any workflow that hold the deploy credentials, and neither runs repository code.
- **Environment rule:** give each GitHub environment a deployment branch rule allowing only its branch, under Settings -> Environments.

It reads two secrets and six variables. The upload job runs in the GitHub environment `Production` for `main` and `Staging` for `staging`, so the two secrets and the two Pages project names are set on each of those environments. `VITE_SIGNALING_SERVER_URL` and the default relay variables are read by the gate's builds, which run in no environment, so they are repository variables, under Settings -> Secrets and variables -> Actions.

| Name | Kind | Set on | What it is |
| ---- | ---- | ------ | ---------- |
| `CLOUDFLARE_API_TOKEN` | Secret | Environments `Production` and `Staging` | An API token scoped to Account -> Cloudflare Pages -> Edit on the one account, and nothing else |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Environments `Production` and `Staging` | The Cloudflare account the project is in |
| `CLOUDFLARE_PAGES_PROJECT` | Variable | Environments `Production` and `Staging` | The Pages project's name |
| `CLOUDFLARE_DEMO_PAGES_PROJECT` | Variable | Environments `Production` and `Staging` | The demo site's Pages project's name; unset, the job skips the demo site's upload |
| `VITE_SIGNALING_SERVER_URL` | Variable | Repository | The peer-coordination broker's `wss:` address, built into the site and the demo site |
| `VITE_DEFAULT_RELAY_TURN_URL` | Variable | Repository | The project relay's TURN url, `turns:turn.data-bridge.org:443?transport=tcp`, built into the site and the demo site as [the default relay](#the-default-relay); unset, neither names one |
| `VITE_DEFAULT_RELAY_REGISTRAR_URL` | Variable | Repository | That relay's registrar, `https://registrar.data-bridge.org`; set with the variable above or not at all |
| `VITE_DEFAULT_RELAY_WEBSOCKET_URL` | Variable | Repository | That relay host's WebSocket relay, `wss://relay.data-bridge.org/relay`, built into the site and the demo site; set only beside the two above |

The site's build sets no `VITE_DEFAULT_RELAY_MODE`, so production and staging offer the project's relay switched off ([The default relay](#the-default-relay)). The demo site's build sets `VITE_DEFAULT_RELAY_MODE=on` in the workflow, not as a repository variable ([The demo site](#the-demo-site)).

### Custom domains and zone settings

Both public names are custom domains of the Pages project, each a proxied DNS record in the Cloudflare zone: the production name points at the project's `pages.dev` name, and the staging name at the `staging` branch alias. The demo site's name is a custom domain of the demo site's project in the same way, its record pointing at that project's `pages.dev` name. Public TLS terminates on a Cloudflare-managed edge certificate for the zone. The zone settings the root declares:

| Setting | Value |
| ------- | ----- |
| SSL/TLS mode | `Full (strict)` |
| Always Use HTTPS | On, so plain HTTP to any of these names is answered `301` at the edge |
| HSTS | On, `max-age=15552000`, without `includeSubDomains` and without preload |

The root also declares the zone's own records:

- **`www.data-bridge.org`** serves no site: the edge answers every request on it with a `301` to the same path and query on `https://data-bridge.org`, the project site.
- **No mail.** No name in the zone sends or receives mail. Each name that answers with an address has a null MX (RFC 7505) and SPF `v=spf1 -all`, and DMARC `p=reject` at `_dmarc.data-bridge.org` covers every name, with no report address.
- **CAA** records limit certificate issuance to the authorities that issue for the zone's names: Cloudflare's edge and Pages certificates, and Let's Encrypt for the relay host ([infra/hosted/README.md](../infra/hosted/README.md#certificate-authorities)).
- **DNSSEC** is on, with the DS record at the registry ([infra/hosted/README.md](../infra/hosted/README.md#dnssec)).
- **`/.well-known/security.txt`** (RFC 9116) is served by the web application's build, on the two public names and the demo site's, and by the project site's build at the apex. It names the reporting routes [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) names, and its `Expires` date is renewed by hand: `scripts/security-txt.test.mjs` fails 45 days before it.

### Headers, caching, and the fallback document

The build writes a `_headers` file with four security headers under `/*` and the `/assets/*` cache rule, and no `_redirects` or `404.html`, so Pages answers an unmatched path with the root `index.html` ([notes/hosted-static-build.md](notes/hosted-static-build.md#no-catch-all-rewrite)). The console server applies the same headers to every response it returns.

| Header | Effect |
| ------ | ------ |
| `Referrer-Policy: no-referrer` | Keeps the invitation token out of the `Referer` header on older clients; the token rides in the URL fragment |
| `X-Frame-Options: DENY` and Content-Security-Policy `frame-ancestors 'none'` | Deny framing, for legacy and modern clients |
| `X-Content-Type-Options: nosniff` | Stops MIME-sniffing away from a declared `Content-Type` |

`Strict-Transport-Security` is not among them. On the names Cloudflare proxies (the production, staging, demo and project sites) it comes from the zone's HSTS setting above. The coordination server, relay, WebSocket relay and registrar names are DNS-only, and their TLS fronts send no HSTS header. Two limits of Pages, measured on the deployment:

- **Every response includes `access-control-allow-origin: *`.** Pages adds it, and `_headers` does not remove it. The site serves public static files and no response depends on a credential. On the project's `pages.dev` names, Pages also adds `x-robots-tag: noindex`; it does not add it on the custom domains.
- **A missing `/assets/` file answers with the root document,** with status 200 and the `/assets/*` rule's one-year `immutable` `Cache-Control`. Asset names contain a content hash, so a URL that misses never becomes valid later, and the service worker refuses to cache a response whose content type is not the asset's ([notes/hosted-static-build.md](notes/hosted-static-build.md#the-host-configuration-file)).

### What the deployment logs

Each log the project's hosted deployment keeps, its fields, and how long it is kept are in [PRIVACY.md](../PRIVACY.md#hosted-web-application); which service runs where is in [The project's hosted web deployment](#the-projects-hosted-web-deployment).

### The demo site

The demo site, at `demo.data-bridge.org`, is a second deployment of the web application, in a Cloudflare Pages project of its own, declared in the same [OpenTofu root](../infra/hosted/README.md).

- **What its build sets:** `VITE_SIGNALING_SERVER_URL`, `VITE_DEFAULT_RELAY_TURN_URL`, `VITE_DEFAULT_RELAY_REGISTRAR_URL` and `VITE_DEFAULT_RELAY_WEBSOCKET_URL` from the same repository variables as the site's build, so its invitations and its `/alcove.json` name the same coordination server as production and it names the project's relay as [the default relay](#the-default-relay). It sets `VITE_DEFAULT_RELAY_MODE=on`, so every browser exchange on it uses that relay.
- **Where data can flow by default:** a browser exchange on the demo site uses the project's coordination server and Google's STUN server, lists the project's TURN relay, enrolls at its registrar, and connects to the project's WebSocket relay; the pages come from Cloudflare. [PRIVACY.md](../PRIVACY.md#hosted-web-application) states what each of those services can observe.
- **When it deploys:** the deploy gate's packaging job builds it beside the site, and the upload job uploads it after the site's own upload. A push to `main` is the demo project's production deployment, served at `demo.data-bridge.org`; a push to `staging` is a preview on the demo project's `staging` branch alias, `staging.<demo project>.pages.dev`, which no custom domain names.
- **What a failed upload does:** the site's own upload has already finished, so the site stays deployed and the run fails.
- **Turning the upload on:** the upload job skips the demo site's steps while its environment sets no `CLOUDFLARE_DEMO_PAGES_PROJECT`. Set it on both environments only after the demo project exists ([infra/hosted/README.md](../infra/hosted/README.md#adopting-the-live-resources)).

## The project site

The project site, at `data-bridge.org`, publishes the Markdown under `docs/` and the repository's top-level changelog, contributing guide, license, privacy statement, security policy, and support page. [VitePress](https://vitepress.dev/) builds it, configured by `docs/.vitepress/config.mjs`, and a Cloudflare Pages project of its own serves it, declared in the same [OpenTofu root](../infra/hosted/README.md).

- **Two sections:** the step-by-step guides under `docs/guides/` are served at the site root, the guides' home page at `/` and each guide at `/<file name without .md>`, in a layout of their own (`docs/.vitepress/theme/GuideLayout.mjs`) whose menus list the guides and, under About, one link to the documentation. Every other page is reference documentation, served at its repository path in VitePress's default theme, with its own navigation and one link back to the guides; the overview, `docs/index.md`, is at `/docs/overview`.
- **Fonts:** the guides' fonts are npm packages (`@fontsource-variable/*`) bundled into the site.
- **Building it:** `npm run site:build` writes `docs/.vitepress/dist/`, and `npm run site:dev` serves the site locally. A relative link to a page the site publishes becomes that page's address, and one to any other file in the repository points at the file on GitHub. The build fails on a relative link to a Markdown page that does not exist; `npm run linkcheck` checks every other relative link and each `#anchor`.
- **When it runs:** [`site_deploy.yaml`](../.github/workflows/site_deploy.yaml) builds the site on a pull request and on a push to `main` or `staging` that changes a source the build reads, and uploads it on the push or on a manual dispatch on either branch. `main` is the production deployment; `staging` is a preview on the site project's `staging` branch alias.
- **Upload:** as for the web application, using the same environments and secrets, plus `CLOUDFLARE_SITE_PAGES_PROJECT`, the site project's name, a variable set on both environments.
- **Headers:** the build writes no `_headers` file, so Pages serves the site with its default headers and the zone settings above.
- **Redirects:** the build's `_redirects` file (`docs/.vitepress/public/_redirects`) sends `/instructions` to the root and `/instructions/<page>` to `/<page>`.

## Diagnosing web connection failures

By default the web client logs PeerJS connection activity at errors-only, so a normal exchange prints no connection-diagnostic detail to the browser console; PeerJS's more verbose levels print peer ids, which the app keeps out of its logs ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#console-and-log-hygiene)).

To diagnose a failing rendezvous or connect against a deployed client without a redeploy, raise that verbosity for a single browser, from the devtools console:

```js
localStorage.setItem("alcove:diagnostics", "1");  // then reload the page
```

With the flag set, the client raises PeerJS to its most verbose level, and re-enables the app's own diagnostic console output -- the raw exchange-failure `Error` object, with its stack and cause chain, and the acceptor's dial target. Clear it to return to the errors-only default:

```js
localStorage.removeItem("alcove:diagnostics");     // then reload the page
```

The flag is read once per page load, applies to the one browser that sets it, and persists across reloads until cleared. A development build (`npm run dev`) is in this diagnostic mode by default.

Rendezvous peer ids are redacted from the PeerJS output even with the flag on. A verbose capture still contains SDP and ICE candidates, which include the machine's private and LAN IP addresses, and the app's failure errors contain the partner's signaling host and port. It contains no invitation secrets, session keys, or record data. Share a capture only with trusted support, and review it first if your network layout is sensitive.

### A relay that could not be reached

When a browser exchange uses a relay (a TURN server, from the operator's own relay setting or the invitation) and the connection does not open, the failure alert says whether the relay gave the browser a relay address:

- The relay gave none and the browser reported an error for it: the alert names the relay url and each distinct error the browser reported -- for example `error 701: Failed to establish connection` for a relay the browser could not reach.
- The relay gave none and the browser reported no error before the attempt ended: the alert names the relay url alone. The browser can take longer to give up on an unanswered UDP relay than the exchange waits.
- The relay gave an address, or no relay is configured: the alert keeps the plain timeout, which points at the path between the two parties.

Check the relay url, that the relay is running, and that this network allows outbound connections to its host and port. Each party's alert reports the relay its own browser used.

To check a relay without running an exchange, open the Relay server page (`/relay`) and select **Test these relays**. It lists the relays it contacts first: the saved TURN urls and the site's relay where this browser uses it, not the relay an invitation names. It signs in to each with a placeholder credential and reports, per relay and transport, whether the relay answered, refused, or gave no answer, with what to check. An answer shows that this browser reaches the relay over that transport, not that the relay will pass an exchange's traffic. Whoever runs each relay learns the browser's network address. How each result is decided: [PROTOCOL.md](spec/PROTOCOL.md#testing-the-browsers-relays).

## Console

The web application also runs as the **console**: a single-party graphical front end that drives that party's own `alcove` exchange from a container on the operator's own machine. Its job API, environment variables, mounts, where to publish its port, and what an operator can author in it are in [CONSOLE.md](CONSOLE.md).

## SFTP server

Alcove does not include or require any particular SFTP server. Most deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties agree out of band on the directory path and on which accounts have access.

No feature of the server is required beyond ordinary SFTP. What an exchange does need is that nothing else edits the directory it runs in: the set of filenames present in it is the protocol state (see [FILE_SYNC.md](spec/FILE_SYNC.md#core-principle-the-directory-is-the-state-machine)), so a server-side rule that moves, renames, rewrites, quarantines, or deletes a file there breaks the exchange, usually as an unexplained stall. Work through the checklist below before the first exchange against a server you do not administer, and give the partner's administrator the same list.

### Shared folder checklist

Ordered by what they cost deployments, most damaging first.

1. **No upload-triggered automation on the directory.** Any Event Rule, Monitor, Trigger, or scheduled Task that moves, renames, or quarantines a newly uploaded file breaks the exchange, and it is the most common configuration-dependent failure. Alcove publishes every file the partner reads by writing a `temp-<uuid>.tmp` first and renaming it to the final name. An automation that grabs the temporary file races that rename; one that grabs the final file removes the message the partner is polling for. The result is a failed publish that ends the run, or a partner waiting until its inactivity timeout expires. Rules that only notify -- an email, a log entry, a webhook -- are harmless.

2. **Exclude the directory from antivirus, DLP, and ICAP scanning.** The files an exchange writes are opaque protocol frames; an invitation-based exchange encrypts them end to end, while a quick exchange runs under the SSH transport's encryption alone, and the rendezvous files, handshake frames, and abort marker sit outside the application-layer encryption and hold no exchange data ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). A scanner that holds a file until a scan completes, or quarantines it as unrecognized binary content, deletes it as far as the protocol is concerned. Exclude the path rather than tuning the scanner's verdicts.

3. **No aggressive or short-age auto-cleanup.** An exchange spans many poll cycles and can run for hours. Alcove removes files itself where the protocol calls for it; a cleanup rule that removes one first -- a hello during rendezvous, or a message the partner has not yet consumed -- fails the exchange with no error naming the cause. In retain mode nothing is deleted as a protocol step and the directory is kept as a permanent transcript (see the `retain_files` row in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-shared-folder-options)), so an age-based sweep there also destroys audit material. Where a mandatory retention policy cannot exempt the directory, set its age threshold well above the longest exchange you expect to run.

4. **Give the Alcove account rename and delete, not just write.** **Rename** is how every file the partner reads is published. **Delete** is a protocol step in the default (non-retain) mode: the receiver deletes each message it has consumed, and that deletion is the sender's go-ahead for the next one. It is also how a run clears its own files at close and how a starting run sweeps a temporary file orphaned by a crashed prior attempt.

   Under [`connection_per_poll`](#a-maximum-session-duration-needs-a-session-per-poll-cycle) only, on a shared folder whose permissions stop this party from unlinking files the partner wrote (a sticky-bit directory is the usual shape), a run can leave one of its own temporary files behind. No data is lost, nothing hangs, and no exchange fails. The mechanism and its bound are the second stated limit in [SFTP_SESSION_RECOVERY.md](spec/SFTP_SESSION_RECOVERY.md#the-deferred-cleanup-delete-record).

5. **Allow-list the parties' client addresses, and give each party its own account.** Alcove polls the directory on a cadence and re-dials after a dropped session, which an anti-flood or auto-ban rule can read as abuse. Some products (Cerberus FTP Server and Titan FTP among them) offer a permanent ban as the response, which turns one transient network drop into a lockout; check whether yours does and what its ban duration and thresholds are. Allow-list both parties' client addresses so the rule cannot fire against them. Give each party its own account: the two parties connect concurrently, so a shared account collides with per-account maximum-login and maximum-connection limits, and distinct accounts make the directory permissions meaningful per party.

### Server-enforced session limits

Establish which of these two limits your server enforces before configuring anything.

#### An idle timeout is already handled

Servers commonly close a session that has gone quiet for some window; Azure Blob Storage's SFTP endpoint uses a fixed two minutes that is not operator-adjustable. An exchange does go quiet: one party polls while the other computes its reply, which can run for minutes with no file traffic.

Alcove covers this itself, with nothing to configure. The SFTP adapter issues a real no-op SFTP command on a fixed interval once a session has been idle for it, so a server keying idleness on the last SFTP **request** sees activity. The interval is a constant sized below Azure's two minutes; the value is in [TRANSPORT_LIVENESS.md](spec/TRANSPORT_LIVENESS.md#sftp-session-heartbeat-and-tcp-keepalive). A TCP or SSH-transport keepalive is not a substitute and Alcove does not rely on one: transport traffic does not reset a timer keyed on SFTP requests.

Two cases are the operator's:

- a server whose idle window is shorter than the heartbeat interval; and
- a server that keys idleness on something other than SFTP request activity -- bytes transferred, or a wall clock the session's activity never resets.

For either, confirm the *effective* idle setting with the server's administrator, since it can be set per account or per group, then either raise it or treat the server as a session-lifetime case below.

#### A maximum session duration needs a session per poll cycle

Some servers cap a session's total lifetime: past a fixed age the session is closed however active it has been. No heartbeat defeats that.

The remedy is `connection_per_poll` (`--connection-per-poll` on the command line), which opens a fresh SFTP session at the start of each poll cycle and releases it before the loop goes idle again. When to set it, what it costs, and the two idle stretches that still hold a session are in the `connection_per_poll` row in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-only-options). At deployment time:

- **It is a local choice, not a bilateral one.** The partner's side is unaffected and need not match. Only the party facing the capped server sets it.
- **Pair it with a long poll interval.** Every cycle pays a full SSH handshake, so set a minutes-scale `poll_interval_ms`; a sub-minute interval draws a warning from the CLI.
- **It replaces the heartbeat.** No heartbeat is armed in this mode, so the two are alternatives, not layers.

Setting neither leaves the default held-session mode, where a clean mid-exchange drop is re-dialed and the interrupted operation re-issued, up to the `max_reconnect_attempts` budget over the whole exchange, after which the next drop ends it (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#shared-options)). That budget does not answer a server that caps every session.

### Object-store and managed SFTP front-ends

Object-store SFTP front-ends -- AWS Transfer Family over S3, Azure Blob Storage's SFTP endpoint, Google Cloud Storage bridges -- work with Alcove in **retain mode**: set `retain_files` on both parties, and on the command line `--retain-files` supplies the two settings it requires, `lockless_rendezvous` and `timestamp_in_filename` (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-shared-folder-options)). Retain mode rendezvouses through an acknowledgment-marker barrier instead of an exclusive-create lock, which an object-store front-end may not honor. Retain mode is bilateral: both parties set it, and a mismatch fails fast at rendezvous. A front-end that implements rename as copy-then-delete works in either mode, because Alcove never renames onto a name that already exists and a reader waits for a message's declared byte count before reading it.

Two checklist items still apply, the first more so in retain mode:

- **Keep the rendezvous prefix out of every lifecycle and auto-expiry rule** (S3 Lifecycle, Azure lifecycle management, and their equivalents). Retain mode leaves the exchange's files in place, so an expiry rule is more likely to reach them, during an exchange as well as after it.
- **No upload-triggered move or quarantine automation, and no antivirus/DLP scanning on the prefix.**

### Negotiating only FIPS-approved algorithms

A deployment required to use FIPS-approved cryptography constrains what the SSH layer will negotiate from the connection's own configuration, with no server-side cooperation needed. The settings, what each excludes, what happens when the partner's server offers nothing approved, and the host-key gap no client-side setting can close are in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md).

### Local development and testing

The test suite's own SFTP servers are for testing, not a production reference; see [TESTING.md](TESTING.md).

## Docker deployment

The published image `ghcr.io/georgetown-mdi/alcove` runs in either of two roles depending on its first argument; there is no separate console image.

It publishes two variants, differing only in what serves the cryptography. The unsuffixed tags (`X.Y.Z`, `X.Y`, `latest`) are the default and the one every command in this document names. The `-fips` tags (`X.Y.Z-fips`, `X.Y-fips`, `latest-fips`) include a CMVP-validated OpenSSL FIPS provider instead, at roughly 1.8x the size and with the SFTP restrictions in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md); take one only under a FIPS obligation. Which artifact has which posture is in [RELEASES.md](RELEASES.md#which-image-has-which-posture), and what may be claimed of the variant is in [COMPLIANCE.md](COMPLIANCE.md#fips-140). Everything below holds for both.

### The user the image runs as

Both roles run unprivileged in both variants. Left alone they run as the image's `node` account, **uid 1000, gid 1000**; both also run as an account you name with `--user` (below). Neither role runs as root, and the program files inside the container belong to `root`, so the running process cannot rewrite its own code. The number 1000 is the base image's default, not an Alcove requirement.

A bind mount keeps its host directory's ownership inside the container, so every directory the container writes -- `/work` for the CLI, and the data, input, and rendezvous mounts for the console -- has to be writable by uid 1000, and every file it reads readable by it. The container engine decides which case applies:

- **Docker Desktop**, on macOS, Windows, or Linux, presents a bind mount to whichever user the container runs as, so there is nothing to do.
- **Docker Engine on Linux** passes the host directory's real ownership through. Run the container as your own account, which needs no privilege and leaves everything Alcove writes owned by you:

  ```sh
  docker run --rm --user "$(id -u):$(id -g)" -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove exchange input.csv
  ```

  Rootless Podman takes `--userns=keep-id:uid=1000,gid=1000` in place of `--user`.

  The alternative is to hand the working directory to uid 1000 once, before the first run. A directory created by an account that is itself uid 1000 is already owned by the container's account; otherwise:

  ```sh
  sudo chown 1000:1000 /host/work
  ```

  The `sudo` is required; without it the command answers `Operation not permitted`.

  **If you have run this image before**, earlier images ran as root, so any `alcove.yaml`, `.alcove.key`, or results file already in the directory belongs to root at mode `0600` and is unreadable to uid 1000. Hand the contents over too:

  ```sh
  sudo chown -R 1000:1000 /host/work
  ```

  A working directory or input file that no other account can read (mode `0700`, `0600`) is unreadable inside the container even when it is yours on the host.

- **A CIFS network-share volume** -- the Docker volume the Windows shared-folder scripts create over `//server/share` -- presents the whole tree as owned by the volume's `uid=` and `gid=` mount options, and root when they name nothing. The volume must pin `uid=1000,gid=1000`, which is what `Setup-AlcoveFileDrop.ps1` and its Command Prompt counterpart create it with; a volume made by hand without them mounts and then refuses every write. The share's own access control still decides what the mount credential may do.

**When the container runs as your own account,** Alcove chooses no path under the home directory; it uses the home directory only to expand a `~` you wrote yourself, which in an ephemeral home is a different directory on every run, so write those paths out in full. The signing identity is written and read only where you name it (see [Mounting the signing identity](#mounting-the-signing-identity)).

**The console takes the same route.** Its one container-internal write outside the mounts is the directory a pasted SFTP credential is written to, which the image creates under root-owned `/run` for its own account. Under `--user`, point `JOB_SFTP_CREDENTIAL_DIR` at a path that account can create:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --user "$(id -u):$(id -g)" \
  --env JOB_SFTP_CREDENTIAL_DIR=/tmp/alcove-sftp-credentials \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  ghcr.io/georgetown-mdi/alcove:latest serve
```

The path must sit outside every folder you mounted -- the data root, the input directory, the shared folders, and the secrets directory -- or the console refuses to start. It is container-internal and goes with the container. The variable is required once you name an account: a console that cannot create the directory refuses to start, naming this variable.

**The console launcher does this for you.** On macOS and Linux, the `start-alcove.sh` published with each release runs the container as the account that started it, passes `JOB_SFTP_CREDENTIAL_DIR`, and runs the container's `alcove doctor mount` checks over every folder it is about to mount, as that account, before the console starts. The data root and the shared folder have to pass the write checks; the input folder has to be readable, and the launcher binds it read-only. Under `sudo` it runs the container as the account `sudo` came from; from a root login with no account to name, it passes no `--user`.

**On Windows, `Start-Alcove.ps1` fills the same variables from folders the operator picks.** It asks whether the partner named one shared folder or a pair and sets `JOB_RENDEZVOUS_DIR` alone, or with `JOB_RENDEZVOUS_OUTBOUND_DIR`, and `JOB_RENDEZVOUS_NAME` and `JOB_RENDEZVOUS_OUTBOUND_NAME` beside them ([CONSOLE.md](CONSOLE.md#turning-the-job-api-on)). One folder of a pair given without the other is refused.

Two folders on one share take **one** network-share volume, over the folder that holds them both. That folder is the share root when the two sit far apart, and the container then reaches the whole share, so keep the pair side by side inside one exchange folder. Two folders on different shares or servers take a volume each.

**What a mis-owned mount looks like.** The failure names `EACCES` and the path it could not write. The key file and config default to `./.alcove.key` and `./alcove.yaml`, resolved against the container's working directory:

- `alcove exchange` stops at the key-file preflight, before any key exchange, with `key file parent directory . is not writable: EACCES: permission denied, open '.alcove-write-probe-<pid>-<hex>'. Restore write access ...`.
- `alcove accept` displays and confirms the terms, then fails with `EACCES: permission denied, open './alcove.yaml.tmp.<pid>'` and exit 69. The invitation is still good: fix the ownership and run `accept` again.
- An existing `alcove.yaml` the container cannot read fails at config load: `config file ./alcove.yaml could not be read: EACCES: permission denied, open './alcove.yaml'`. The recursive `chown` above clears it.

In all three the remedy is ownership, not mode: a `chmod` on a directory or file the container's account does not own changes nothing it can reach.

### Running the CLI

By default the image runs the headless CLI. Mount a working directory and pass CLI arguments:

```sh
docker run --rm -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove exchange input.csv
```

What the container needs to reach while it runs is in [Network requirements](#network-requirements), and how to restrict it in [Restricting the container's outbound network access](#restricting-the-containers-outbound-network-access).

#### Giving a run more memory

The image starts the CLI with `NODE_OPTIONS=--max-old-space-size=19075`, the heap limit [FILE_SYNC.md](spec/FILE_SYNC.md#memory-a-psi-round-needs) sizes, along with the memory a run needs. Before it connects, each exchange logs the memory its input needs and the memory it has, the least of that heap limit, the host's memory, and the container's `--memory` limit, and stops with exit 64 when the need is over it.

- **Raise or remove `--memory`** to give the run what it needs:

  ```sh
  docker run --rm --memory 16g -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove exchange input.csv
  ```

- **Raise the heap limit** with your own `NODE_OPTIONS`, which the image places after its own and so takes precedence: `--env NODE_OPTIONS=--max-old-space-size=30000`.
- **Run anyway** with `--allow-memory-shortfall`, which turns the refusal into a warning; a run that then runs out of memory is killed (exit 137 under a `--memory` limit, 134 when the heap limit is reached).

The details are in [CLI.md](CLI.md#memory-for-a-large-exchange).

### Running the console

Pass `serve` as the first argument to run the console server as PID 1 in place of the CLI; it takes a published port and at least one mount, and the commands for each mount layout are in [Running the container](CONSOLE.md#running-the-container). The server's variables and shutdown are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md), and the console builds the image ships are in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md).

### Restricting the container's outbound network access

An SFTP or shared-folder exchange gives the container at most one reason to reach the network: the SFTP connection to the server the two parties agreed on. Holding its outbound access to that endpoint is defense in depth: were the process compromised, an egress allowlist bounds what it could reach. No exchange needs it to work. A WebRTC exchange reaches several endpoints, listed in [Network requirements](#network-requirements); no tested allowlist for it is documented.

`docker run` has no egress allowlist of its own, and the image runs unprivileged (see [The user the image runs as](#the-user-the-image-runs-as)), so restricting egress is host configuration. What each role needs outbound:

- **A shared-folder (filedrop) exchange needs no egress at all**, in either role. The host performs whatever network file access the mount stands for.
- **An SFTP exchange needs TCP to the server's host and port**, plus name resolution for that host unless it is named by address. This is the same in both roles: the console drives the same CLI inside the same container, and the console's "read the fingerprint from the server" probe reaches the same endpoint.
- **The console's browser traffic is inbound, not egress**, and is governed by the publish binding ([Reachable only where you publish it](CONSOLE.md#reachable-only-where-you-publish-it)).

#### No egress at all

For a shared-folder exchange on the CLI, take the network away outright:

```sh
docker run --rm --network none -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove exchange input.csv
```

This is the strongest option and the only portable one. It is not an option for the console, whose browser traffic has to reach the published port; a console that will only run shared-folder exchanges takes the allowlist below with no SFTP entry, which denies the same traffic outbound.

`alcove doctor probe` talks to the SMB server from inside the container (see [Checking a network shared folder](CLI.md#checking-a-network-shared-folder)). Run the checks before you take the network away, or allow tcp/445 to the file server while you run them.

#### An allowlist for an SFTP exchange

These steps are Linux-only. They assume Docker Engine on a Linux host with its default iptables integration (the daemon's `iptables` setting left on), and root on that host. The rules are host state: they govern every container on the network you create, they do not travel with the image or a Compose file, and they last until you delete them or the host reboots. Persist them with your distribution's own mechanism (`iptables-persistent`, a `firewalld` direct rule, a systemd unit) for a lasting deployment.

**Docker Desktop -- on macOS, Windows, or Linux -- and rootless Docker do not work this way.** The container's traffic is routed inside a virtual machine or a user-mode network stack these rules do not reach. There, `--network none` still restricts a shared-folder exchange, while an SFTP exchange's egress restriction has to come from the host's own firewall or the network the machine sits on.

**1. Give the container a network of its own, with a subnet you chose.**

```sh
docker network create --subnet 172.31.240.0/29 alcove-egress
```

The rules below name the subnet, so pin it rather than take one from Docker's default pool. Any private range the host does not already route elsewhere will do.

**2. Write the rules into the `DOCKER-USER` chain**, the chain Docker consults ahead of its own. Every rule is scoped to that subnet as its source, so it governs only this container's traffic.

```sh
SUBNET=172.31.240.0/29
SFTP_ADDR=203.0.113.24     # the address your SFTP server resolves to
SFTP_PORT=22               # connection.server.port; 22 when unset
RESOLVER=192.0.2.53        # the resolver you hand the container in step 3

# Replies on an already-permitted connection, matched before anything below.
sudo iptables -I DOCKER-USER 1 -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# The one endpoint an exchange needs.
sudo iptables -I DOCKER-USER 2 -s "$SUBNET" -p tcp -d "$SFTP_ADDR" --dport "$SFTP_PORT" -j ACCEPT
# Name resolution -- omit both if you pin the server by address instead.
sudo iptables -I DOCKER-USER 3 -s "$SUBNET" -p udp -d "$RESOLVER" --dport 53 -j ACCEPT
sudo iptables -I DOCKER-USER 4 -s "$SUBNET" -p tcp -d "$RESOLVER" --dport 53 -j ACCEPT
# Everything else the container tries to reach.
sudo iptables -I DOCKER-USER 5 -s "$SUBNET" -j DROP
```

The explicit rule numbers keep the `DROP` last: `-I` inserts at the top of the chain when given no position, and `-A` would append past the chain's trailing `RETURN`, where a rule is never reached. Read the result back with `sudo iptables -L DOCKER-USER -n --line-numbers`, and verify it as below.

**3. Run the container on that network.** Nothing else about either invocation changes.

```sh
# Headless CLI
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove exchange input.csv

# Console
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  ghcr.io/georgetown-mdi/alcove:latest serve
```

`--dns` names the resolver the container uses, so the address the rules permit is one you chose. Drop the flag along with the two resolver rules if you pin the server by address.

#### Substituting your own endpoint

`SFTP_ADDR` and `SFTP_PORT` stand for the server the two parties agreed on; there is no built-in endpoint to allow.

- **Headless CLI**: `connection.server.host` and `connection.server.port` from your `alcove.yaml`, the port being 22 when unset (see [`connection.server`](EXCHANGE_REFERENCE.md#connectionserver)).
- **Console**: the host and port you enter when you author the connection (see [Authoring the SFTP connection](CONSOLE.md#authoring-the-sftp-connection)). Re-authoring against a different server means revisiting the rules.

A hostname that resolves to several addresses needs a rule per address. Confirm the set with `dig +short <host>` and re-confirm it whenever the server's operator changes anything: an address that moves out of the allowlist stops the exchange with a connection failure.

**Pinning the server by address instead.** Naming the server by address takes name resolution out entirely: drop the two resolver rules and the `--dns` flag, and the allowlist is one endpoint. The server is still authenticated by its pinned `host_key_fingerprint`, which is mandatory for a console-authored connection and effectively so for a containerized CLI run, which has no terminal and fails closed (see [SFTP host-key trust](CLI.md#sftp-host-key-trust)). The cost is maintenance: an address the server's operator changes has to be changed in the configuration and in the rules.

#### Verify it rather than assuming it

An allowlist that drops name resolution, and one whose `DROP` sits above the permit rules, both look like a working one until an exchange fails. Check both directions with `probe-host-key`, which connects far enough to read the server's host key and sends no credential (see [Reading a host key with `probe-host-key`](CLI.md#reading-a-host-key-with-probe-host-key)); it exits 0 when it reached the server and 69 when it could not.

```sh
# Permitted: the endpoint you allowed. Prints a fingerprint, exits 0.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://sftp.partner.example --connect-timeout 10s

# Blocked: the same host on a port you did not allow. Exits 69.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://sftp.partner.example:2222 --connect-timeout 10s

# Blocked: a host you did not allow. Run it a second time without
# `--network alcove-egress`: a probe that fails for its own reasons proves
# nothing, so it has to succeed off the restricted network to count.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://some.other.host --connect-timeout 10s
```

A blocked endpoint answers nothing rather than refusing, so each blocked row takes about its `--connect-timeout` to exit.

Probing by name is also the name-resolution check. A probe that fails by name and succeeds against the address means the rules are dropping resolution: permit the resolver, or pin the server by address.

Alcove's image smoke workflow (`.github/workflows/image_smoke.yaml`) runs these steps against each image it builds: the permitted endpoint read by name, the denied port and the denied host refused, each of the three reached again off the restricted network, and the by-name probe refused once the resolver rules are removed. Your own subnet, resolver, server address, and port are still yours to check.

Finally, start the console once on the restricted network and confirm it still loads at `http://127.0.0.1:3000`.

#### What the restriction does not cover

- **The host and the operator's browser are unaffected.** This bounds one container's reach, not the machine's.
- **Name resolution is a permitted channel whenever you allow a resolver.** Pin the server by address and drop the resolver rules if you need that closed too.
- **Traffic the host delivers to itself is not forwarded**, so `DOCKER-USER` does not decide whether a container reaches a service on the host's own address; close that at the host's `INPUT` chain if it matters to you.
- **It is not a substitute for the controls that protect the exchange.** The partner's material is bounded by the exchange protocol (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)); who reaches the console is bounded by the publish binding (see [Reachable only where you publish it](CONSOLE.md#reachable-only-where-you-publish-it)).

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes init containers, and orchestration scripts -- must not leave `.alcove.key` readable by other processes or users. The permission rule and what violating it costs are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#required-permissions). In a container, the account the container runs as (see [The user the image runs as](#the-user-the-image-runs-as)) has to own the `0600` file: a key file owned by another uid is unreadable, and the exchange fails before it starts.

**Mount the file at runtime; never copy `.alcove.key` into an image layer**, which anyone with pull access to the registry can read.

- **Docker**: bind-mount the directory that holds the key file, read-write, and name the file inside it with `--key-file`: `--mount type=bind,src=/host/path/secrets,dst=/run/secrets` with `--key-file /run/secrets/.alcove.key`. Do not mount the key file on its own: the CLI saves the rotated token after each successful exchange by writing a new file beside the old one and renaming it into place, and a rename onto a file that is itself a mount point fails (`EBUSY`). On Linux the key-file pre-flight refuses such a mount before the key exchange; elsewhere the save fails after it, and both parties must re-invite where the partner had already saved ([Out-of-sync tokens](CLI.md#out-of-sync-tokens)). For the same reason do not use a read-only mount or a Docker secret. Set the directory's owner to uid 1000 and the file to mode `0600` and owner uid 1000 on the host before the container starts.
- **Kubernetes**: a `Secret` volume is mounted read-only, so the key-file pre-flight refuses a key file inside one. Use the `Secret` to seed a writable persistent volume: an init container copies it there, mode `0600`, when the volume holds no key file yet, and `--key-file` names the copy. Do not use a `ConfigMap` for the key file. Set the pod's `securityContext` so the copy belongs to the identity the container runs as. This bullet and the example below are not tested on a cluster: confirm the copied file's mode and owner on yours before relying on it.
- **CI runners**: write the token with `install -m 0600 /dev/stdin .alcove.key <<< "$TOKEN"` (bash) or `printf '%s' "$TOKEN" | install -m 0600 /dev/stdin .alcove.key` (POSIX sh) rather than `echo "$TOKEN" > .alcove.key`, which may leave a world-readable file depending on the runner's umask.

**Separate read-only config from read-write secrets.** If the working directory (containing `alcove.yaml` and input data) is mounted read-only, mount a separate read-write volume for the key file and use `--key-file` to redirect the CLI. One exception needs the directory holding the config writable: under `signing.mode: certificate` a first contact with a partner you have not pinned records the fingerprint into `alcove.yaml` by renaming a new file over it (see [CLI.md](CLI.md#pinning-the-partners-certificate)), so either set `signing.partner_fingerprint` before that run or mount the configuration writable for it; a run that can do neither is refused before it connects.

```sh
# Docker
# /run/secrets must be read-write; the CLI writes the rotated token after each successful exchange
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  ghcr.io/georgetown-mdi/alcove exchange input.csv --key-file /run/secrets/.alcove.key
```

```yaml
# Kubernetes: a writable key volume seeded once from a Secret, alongside a
# read-only configMap mount.
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
volumes:
  - name: config
    configMap:
      name: alcove-config
      defaultMode: 0444
  - name: key-seed
    secret:
      secretName: alcove-key
      defaultMode: 0400
  - name: secrets
    persistentVolumeClaim:
      claimName: alcove-key-state
initContainers:
  - name: seed-key
    image: busybox
    command:
      - sh
      - -c
      - "[ -e /run/secrets/.alcove.key ] || install -m 0600 /run/key-seed/.alcove.key /run/secrets/.alcove.key"
    volumeMounts:
      - name: key-seed
        mountPath: /run/key-seed
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
containers:
  - name: alcove
    volumeMounts:
      - name: config
        mountPath: /work
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
    args: ["exchange", "input.csv", "--key-file", "/run/secrets/.alcove.key"]
```

`--key-file` is accepted by `exchange` (reads the token on start and writes the rotated token back to the same path after a successful exchange) and by a quick exchange (the output path when `--save` is used).

**Verify before the first exchange:**

```sh
stat -c "%a %n" .alcove.key   # Linux
stat -f "%Lp %N" .alcove.key  # macOS
```

The output must show `600`. If it does not, the CLI emits a warning on load; correct the permissions before proceeding.

The manual procedure for confirming the Windows owner-only writers still
narrow ACLs correctly is in [TESTING.md](TESTING.md#verifying-windows-owner-only-file-protections).

### Mounting the signing identity

The signing identity is a long-lived P-256 private key that must stay byte-for-byte stable, because a partner pins its fingerprint; the key file rotates and must be written back. Mount them differently. Its custody properties are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#custody-and-persistence).

Alcove resolves no location for it. Name the path with `signing.identity_file` in the configuration, or `--identity-file` on the command line; a certificate-mode exchange configured with neither is refused before it connects. See [CLI.md](CLI.md#where-the-signing-identity-lives).

**Give it a mount of its own, and mount that read-only.** `alcove fingerprint` is the only command that writes it; an exchange and an `alcove verify-receipt` write neither the file, its directory, nor anything beside it. So it does not go in the read-write `/run/secrets` mount above. The console creates an identity only at its own default location in the data root and reads one it is pointed at elsewhere (see [CONSOLE.md](CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed)); mount that directory read-only there too.

Provision it once, against a directory writable for that one command:

```sh
docker run --rm \
  --mount type=bind,src=/data/signing,dst=/run/signing \
  ghcr.io/georgetown-mdi/alcove fingerprint \
  --identity-file /run/signing/alcove-signing-identity.json \
  --identity "Agency A, a@agency-a.gov"
```

Then mount it read-only for every exchange, beside the read-write mount the key file needs, with `signing.identity_file: /run/signing/alcove-signing-identity.json` in the mounted `alcove.yaml`. Give the exchange a writable output folder too: the image's `WORKDIR` is `/work`, which this example mounts read-only, and a run with no output folder writes its record and receipt to the working directory, where a failed write only warns, so the exchange would complete while landing neither. In the output folder each run writes its result, record, verification keys, and receipt under its own time-stamped names ([Where a run's files go](spec/EXCHANGE_RECORD.md#where-a-runs-files-go)).

```sh
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  --mount type=bind,src=/data/signing,dst=/run/signing,readonly \
  --mount type=bind,src=/data/out,dst=/run/out \
  ghcr.io/georgetown-mdi/alcove exchange input.csv /run/out/ \
  --key-file /run/secrets/.alcove.key
```

```yaml
# Kubernetes: the signing identity is a second Secret volume, mounted read-only
volumes:
  - name: signing
    secret:
      secretName: alcove-signing-identity
      defaultMode: 0600
containers:
  - name: alcove
    volumeMounts:
      - name: signing
        mountPath: /run/signing
        readOnly: true
```

On any platform:

- **Make the host directory durable, and back it up.** Losing the file means creating a new identity with a new fingerprint, which every partner must re-pin before your receipts verify again.
- **Never put it in a directory the partner writes into.** In a shared-folder exchange the shared folder is exactly that, and a signing identity there hands the partner the private key that signs for you with every partner. On the command line nothing checks this; the console checks its own mounts and refuses such a run (see [CONSOLE.md](CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed)).

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
- [CONSOLE.md](CONSOLE.md) - running the image as the operator's local console: its mounts, environment variables, and what an operator authors in it
- [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md) - constraining an SFTP exchange's SSH negotiation to FIPS-approved algorithms
