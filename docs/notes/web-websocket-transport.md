---
title: "The Web Application's WebSocket Transport Path"
---

# The web application's WebSocket transport path: a relay for networks that stop TURN, and the browser SFTP proxy

_Status: the relay path is built and turned on in both applications: the relay proof derivation, the relay service and its deployment, both clients, the wrap on the web side, the relay locator and settings, and the automatic fallback; its disclosure documents and its stress-tier run remain ([Implementation items implied, not filed](#implementation-items-implied-not-filed)). The browser SFTP path is design only but for its relay ([SFTP_RELAY.md](../spec/SFTP_RELAY.md)).
The maintainer ruled on the seven forks on 2026-10-09 ([The forks and their rulings](#the-forks-and-their-rulings)).
What remains open is the spikes S2 and S4, neither of which has run, and S1's open parts, S1 having run in a narrower form with its decisive part met; S3, S5 and S6 passed with Node and Chromium parties on 2026-10-18, S6 through the 443 front on a host run (each [below](#the-spikes)).
The browser SFTP spikes ran on 2026-10-29.
S7 found no off-the-shelf raw relay, of the three tried, that both refuses by `Origin` and holds backpressure in both directions.
S8's PASS line was met by `@microsoft/dev-tunnels-ssh` with three additions in the spike's own code, and by `ssh2` bundled for the browser only against a server that also offers an ECDSA host key.
The relay is built first-party, its own package and image, by the maintainer's ruling of 2026-10-29 ([fork 5](#the-forks-and-their-rulings)); fork 5's earlier reading, an off-the-shelf relay S7 did not find, is superseded.
The client the browser SFTP path builds on was chosen by the maintainer on 2026-10-29, on the conditions [browser-sftp-proxy.md](browser-sftp-proxy.md#the-chosen-client-dependency-check-and-sizing) records.
The hosted relay admits one-shot exchanges, as part of the production default, by the maintainer's ruling of 2026-10-15 ([fork 1](#the-forks-and-their-rulings)).
The public web application is the consumer of both paths and the console ships neither, by the maintainer's ruling.
The note recommends a WebSocket relay for networks whose inspection stops TURN as the first thing to build, answers whether that relay and the browser SFTP proxy are one component, re-answers the browser SFTP note's open choices under the ruling, and ends with the sequence, the spikes, and the forks with the maintainer's rulings on them.
Nothing here is normative: the wrap rule is in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
the transport's bounds and budgets in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#budgets),
and the relay credential in
[PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation).
The earlier design of the SFTP proxy is [browser-sftp-proxy.md](browser-sftp-proxy.md).
See [docs/notes/README.md](README.md)._

## The rulings this note works under

- The public web application is the consumer: a transport nobody but the web application can use has no other consumer.
- The case that comes before browser SFTP is peer-to-peer through a network whose deep-packet inspection stops TURN, TURN over TLS on 443 included.
- The console ships neither path.
  It runs SFTP and shared-folder exchanges through the CLI it spawns, which opens sockets itself (`selectExchangeDriver` in `apps/web/src/psi/exchangeDriverSelection.ts` returns `server-job` for `sftp` on a console build), and it conducts no WebRTC exchange ([PRIVACY.md](../../PRIVACY.md#two-deployments)).
- The web application stays static: whatever the project operates stands apart from the site that delivers the code, as the broker and the TURN relay do ([web-server-runtime-role.md](web-server-runtime-role.md); `CLAUDE.md`, Applications).

Every claim about current code names its file.
A claim about a network product or a library this note could not drive is labelled unverified, with what would verify it.

## What exists today

The pieces a WebSocket path would build on, with where each is stated:

- **Two WebRTC implementations speak one wire.**
  The browser runs PeerJS (`apps/web/src/psi/transport/peerMessageConnection.ts`); the CLI drives werift and hand-writes the broker client and the framing (`apps/cli/src/connection/webrtc/`).
  Both present the exchange with core's `MessageConnection` (`packages/core/src/connection/messageConnection.ts`): `send`, `receive`, `close`, and a terminal state.
- **The framing and its bounds are transport-independent, in core.**
  `packages/core/src/connection/peerjsWire.ts` (the BinaryPack frame, the chunk envelope, the close sentinel) and `webrtcInboundBounds.ts` (the bounded reassembler) import only core and `peerjs-js-binarypack`, with no Node module, so they run in a browser bundle.
  The CLI's WebRTC transport imports them from `@alcove/core`.
  The constants they apply -- `MAX_WEBRTC_FRAME_BYTES` of 268,435,456 bytes, the chunk-count and concurrent-reassembly caps -- live in core (`packages/core/src/connection/binaryPackBounds.ts`; [TRANSPORT_BOUNDS.md](../spec/TRANSPORT_BOUNDS.md#webrtc-data-channel-inbound-bound)).
  The browser applies the same constants by wrapping PeerJS internals (`apps/web/src/psi/transport/boundedReassembly.ts`), which a transport that does not run PeerJS cannot reuse.
- **The wrap is a decorator over any `MessageConnection`.**
  `EncryptedMessageConnection` (`packages/core/src/connection/encryptedMessageConnection.ts`) runs on WebCrypto, and the request bit is the fourth argument of `authenticateConnection` (`packages/core/src/auth.ts`).
  The web application requests and applies the wrap on every WebRTC exchange (`apps/web/src/psi/authenticateExchange.ts`; [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#application-layer-encryption)).
  The earlier note stated as a limit that no browser exchange had run the wrap ([browser-sftp-proxy.md](browser-sftp-proxy.md#channel-security)); the web application now applies it on every WebRTC exchange, so this note does not inherit that limit.
- **Every web WebRTC exchange has a shared secret.**
  No secret-less rendezvous is offered on the web ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)), so a session key exists for the wrap on every browser exchange this note concerns.
- **A per-exchange relay key exists.**
  `relay_key = HKDF(secret, "alcove-relay-key-v2")`, registered at the relay's table per exchange, from which each party mints a time-limited TURN credential without contacting the relay ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation); `packages/core/src/relayCredential.ts`).
  The registrar's proof shows the pattern for a second use of the key under its own label ([PROTOCOL.md](../spec/PROTOCOL.md#the-registrar-request-proof)).
  Enrolling an exchange needs the relay-owner token: the CLI's `alcove enroll-relay`, or a saved exchange's page in the browser ([MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#when-your-relay-runs-a-registrar)); a one-shot browser exchange enrolls nothing ([PRIVACY.md](../../PRIVACY.md#what-supporting-services-can-observe), the registrar row).
- **The invitation carries the inviter's relay locator**, TURN and STUN urls and no credential, and the acceptor relays through it ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)).
  The browser keeps its own relay setting in `localStorage` (`apps/web/src/psi/transport/ownRelaySetting.ts`).
- **What the project operates for the hosted application:** the broker behind an nginx TLS front on port **8443**, beside coturn on the same host, and one listener on 443, the relay's 443 front, which routes each connection by the server name it asks for: to the broker's front unopened, or to coturn, terminating the TURN client's TLS itself ([DEPLOYMENT.md](../DEPLOYMENT.md#what-the-deployment-logs); [infra/broker/README.md](../../infra/broker/README.md#port-8443-and-443-through-the-relays-front)).
  The front closes a WebSocket idle for 300 s; the PeerJS heartbeat every 5 s keeps a signaling socket alive.
- **What the relay measurements established.**
  TURN over TLS on 443 carried a UDP-blocked CLI party on a real path, and through a TLS-inspecting proxy once that proxy's CA was trusted on the CLI host; the interception point read the STUN and TURN envelope in the clear and passed it ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-1-does-turn-over-tls-on-443-carry-a-restrictive-network)).
  A browser with UDP refused and TCP admitted only to 443 of the relay and the app completed a relayed exchange with a CLI party ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-remains-unmeasured), the registrar-path row).
  Whether a TURN client reaches a relay through an explicit proxy is unmeasured for the CLI and for a browser under `disable_non_proxied_udp` ([turn-provisioning-governance.md](turn-provisioning-governance.md#what-remains-unanswered)).
- **The project already names the case.**
  [DESIGN.md](../DESIGN.md#websocket-relay) describes a WebSocket relay for networks that fail WebRTC with TURN on 443 available, and the roadmap lists it as later work ([ROADMAP.md](../ROADMAP.md#possible-later-work)); the spec reserves the wrap's request bit for exactly a terminated leg ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it)).

## Question 1: when inspection stops TURN

### What "stops TURN" means on the wire

A TURN over TLS connection on 443 is a TLS session carrying STUN and TURN messages.
What a middlebox can do with it depends on how far it looks:

- **Port and address only.** TLS on 443 to a name passes; this is the class the relay measurements carried.
- **Name policy.** The relay's name meets the gateway's category filters -- a newly registered or newly observed name is blocked by the vendors the governance record cites ([turn-provisioning-governance.md](turn-provisioning-governance.md#outbound-tls-on-443-to-a-partners-relay-against-outbound-sftp)).
  This stops every candidate below equally, since each has a name; it is an onboarding request, not a transport choice.
- **Flow classification without decryption.** A TLS session that offers no ALPN, is long-lived, and carries two-way traffic of a fixed shape differs from a browser's HTTPS session.
  Whether coturn's clients offer an ALPN value, and whether a given gateway classifies on it, is unverified here; what would verify it is a packet capture of the Client Hello from Chromium and from werift, and a run against a gateway with its application-identification rules on.
- **TLS inspection with protocol enforcement.** The proxy terminates TLS, reads STUN message types where it expects an HTTP request line, and refuses.
  The measured class-B proxy terminated TLS and passed TURN; a proxy that enforces "HTTP inside TLS" is the case the maintainer describes.
  In [S1](#the-spikes) Squid stopped TURN once it intercepted TLS at all, with or without the directive that answers an unparseable request with an error, so interception and HTTP parsing were not separable there.
  This note takes that case as the one to design for, since it is the only one of the four a transport choice can answer.

### The candidates

| Candidate | What the middlebox sees | What the operator of the relay sees | Who runs it | Fits the transport |
| --- | --- | --- | --- | --- |
| **TURN over TLS on 443, public certificate** (built, measured) | TLS to a name; under inspection, STUN and TURN messages where an HTTP request is expected | Addresses, timing, volume; DTLS ciphertext it does not terminate ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-the-relay-sees)) | A party, the project for the hosted app, or a managed vendor | Yes: the data channel is unchanged |
| **TURN over TCP on 443, no TLS** | STUN and TURN in the clear | As above | As above | Yes; strictly worse under any inspection, and `turn:` with `transport=tcp` is already expressible ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn)) |
| **TURN through an explicit proxy** (`CONNECT`) | An HTTP `CONNECT` to the relay's name, then TLS; an enforcing proxy inside the tunnel sees TURN as above | As above | As above | Browsers: only under `disable_non_proxied_udp`, where Chrome moves WebRTC onto the proxy ([turn-provisioning-governance.md](turn-provisioning-governance.md#outbound-tls-on-443-to-a-partners-relay-against-outbound-sftp)); the CLI's TURN client through a proxy is unmeasured |
| **The exchange's frames through the signaling broker** | A WebSocket on 443 through the relay's front, or on 8443: HTTP upgrade, then text frames | Every frame's bytes, in JSON text | The project (hosted app) or a party | No: see below |
| **A WebSocket relay of its own on 443** | A WebSocket: a TLS session carrying an HTTP `GET` with `Upgrade: websocket`, then binary frames; an enforcing proxy reads a valid HTTP request and WebSocket frames, which is what the network exists to carry; an explicit proxy tunnels it as browsers do for every WebSocket | Addresses, timing, volume, the pairing of two parties, the handshake frames in the clear, and every later frame as the wrap's AEAD envelope | The project for the hosted app; a party from a reference deployment; no managed vendor offers it | Yes, with the framing and bounds the two implementations already share, and with the wrap |
| **Not candidates** | WebTransport and anything over QUIC are UDP, which the measured classes block outright; ICE-TCP host candidates need a reachable address on one side, which a party behind the inspecting network does not have | | | |

Measured in part by [S1](#the-spikes): through a TLS-intercepting proxy that parses HTTP inside TLS, TURN over TLS on 443 stalled with no reply and a WebSocket upgrade completed and held open 30 s.
S1's PASS line is not met as written: the proxy's log did not name a refusal of TURN, no Client Hello was captured, and no browser or werift client ran.
Still open: the ALPN and Client Hello question, and the real-client legs, a CLI party and a browser party.
The decisive observation stands for the one proxy and one client tested: a WebSocket connects where TURN does not.
A WebSocket's own exposure is a gateway that blocks WebSocket upgrades as a policy, which breaks ordinary web applications and is therefore rare; whether a given partner's gateway does is a question for onboarding, as the TURN name is.

### Why not carry the exchange through the broker

The broker is a WebSocket on 443-class transport the project already operates, so it is the obvious first thought.
It does not fit, for reasons in its own specification:

- Each signaling frame is capped at 256 KiB and parsed as JSON through `parseBoundedJson` ([SIGNALING_SERVER_BOUNDS.md](../spec/SIGNALING_SERVER_BOUNDS.md#signaling-server-inbound-frame-bound)); an exchange's frames are binary and run to 256 MiB, so each would become more than a thousand base64 text frames.
- It does not pause a fast sender: a destination whose socket holds over 1 MiB is terminated and told to leave (`MAX_RELAY_BUFFERED_BYTES`, `packages/peerjs-broker/src/contrib/messageHandler/handlers/transmission/index.ts`), which is right for signaling and wrong for a 539,000,000-byte PSI round whose receiver is slower than its sender.
- Its liveness and queue bounds are sized for a rendezvous ([SIGNALING_SERVER_BOUNDS.md](../spec/SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds)), and the vendored message routing is upstream's, kept unedited for traceability (`packages/peerjs-broker/README.md`).

What the broker does show is the shape: a WebSocket server that pairs two sockets by a derived identity and forwards opaque frames, behind a TLS front, with its upgrade surface bounded (`packages/peerjs-broker/src/standaloneUpgradeBounds.ts`).
The relay below is that shape with binary frames, pause-and-resume forwarding, per-exchange authentication, and quotas.

### The WebSocket relay, as recommended

**One connection per party, paired by the exchange's relay key.**

- A party opens `wss://<relay name>/<fixed path>` and sends one hello frame: its role (`inviter` or `acceptor`) and a credential.
- The credential is a proof under a key derived from the exchange's relay key under a label of its own, in the [domain-separation label space](../spec/PROTOCOL.md#relay-credential-derivation), with an expiry in the signed message, as the registrar's proof is built ([PROTOCOL.md](../spec/PROTOCOL.md#the-registrar-request-proof)).
  A key of its own, rather than coturn's HMAC-SHA-1 credential reused, so a captured relay hello mints no TURN credential and a captured TURN credential opens no relay socket.
  The derivation and the proof are specified in [PROTOCOL.md](../spec/PROTOCOL.md#the-websocket-relay-proof).
- The relay looks up the one key the hello names by exchange id, and verifies the proof against it -- the same SQLite table coturn reads, written by the same registrar ([infra/relay/README.md](../../infra/relay/README.md#per-exchange-keys)) -- and pairs the two sockets that verified under one key with opposite roles.
  A second socket with a role already held under that key is refused, which is the broker's `ID-TAKEN` for this path.
  The hello, the start and the close codes are specified in [WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md).
- A run with no shared secret cannot mint the proof and refuses the relay before dialing, as it refuses a `turn` entry with no static credential today ([CLI.md](../CLI.md#turn)).

**What crosses it.** Binary WebSocket messages, each one chunk envelope of the framing the CLI already writes and both implementations already read: BinaryPack frames split at the chunk size, with the close sentinel behind the last frame ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#framing)).
Keeping the envelope means the receiver is the bounded reassembler the CLI has, moved to core so the browser transport imports it too, with the same wire-byte, chunk-count and concurrent-reassembly caps and the same shared refusal fixtures.
The relay forwards each message unread, applying a per-message size cap a little above the largest chunk envelope and refusing anything larger, so it buffers one chunk a socket and never a frame.

**Backpressure, not termination.** When the destination socket's send buffer is above a bound, the relay stops reading from the source socket and resumes below a lower bound, the window the CLI's own send path uses (1 MiB and 256 KiB; [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#outbound-pacing)).
`ws` applies that pause end to end: `pause()` on a `ws` socket stops reads on its TCP socket once the read in flight completes, so the sender's own buffer fills and its send window waits ([S3](#the-spikes)).
The few messages already read when the pause lands are still emitted, and the relay forwards them.
A browser at either end takes part the same way, measured on Chromium: a page's send window waited on the relay's pause, and a page that fell behind stopped Chromium reading its socket, so the relay's buffer for it filled and the relay paused the sender ([S3](#the-spikes)).

**Delivery.** The transport is a delivering close in the terms of [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown): a WebSocket send buffers locally, so the close must wait.
Each side sends the sentinel and waits for the peer's close to reach it through the relay, bounded by the close drain budget; the relay forwards a close frame only after every message queued ahead of it, and closes the other socket when one closes.
That is the browser's WebRTC reading of the peer's close applied to a relayed socket, and the CLI's acknowledgement drain has no counterpart here: TCP acknowledges to the relay, not to the peer, so the peer's close is the one signal either side has.
A sender whose process or tab ends the instant its close returns keeps its final frame only if the close waited: a close that returned once the sentinel was queued lost the frame in 8 of 10 runs from a Node process and in 6 and 8 of 10 from a closed Chromium tab, and the wait for the relayed peer close lost it in none of 10 from either ([S5](#the-spikes)).

**Keepalive.** A PSI step can hold a party silent for the parked-receive budget of an hour ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#budgets)), and any TLS front in the path has an idle timeout -- the broker's is 300 s.
A client that can send a WebSocket ping may send one while a receive is parked; the relay answers and forwards nothing.
The CLI's client is Node's own `WebSocket`, which, like a browser's, has no ping method and answers the relay's (measured on Node 26.12.0), so it adds no dependency and relies on the relay's ping below.
A browser's `WebSocket` cannot send a ping but answers one (measured on Chromium 156, [S6](#the-spikes)), so the browser's keepalive is a ping the relay sends its socket on the same interval.

**Quotas.** The relay bounds what one key can use, as coturn's `user-quota`, `total-quota` and `max-bps` do ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#quotas-against-one-exchange)): one pairing a key, a cap on concurrent pairings, a per-pairing byte rate at the same 2,000,000 bytes a second each direction, and an idle bound at the parked-receive budget.
Each is a working value reviewed against the largest exchange, as the relay's are.

**How the parties choose it.**
Two steps, the second designed with the first so the first does not foreclose it:

1. **Explicit.** The inviter's relay locator in the invitation gains the relay's `wss` url beside its TURN and STUN urls ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)); the browser's Relay settings page and the CLI's connection block each gain the same entry for a party's own relay, listed beside the invitation's as `selectRunRelay` lists TURN and STUN (`packages/core/src/relayCredential.ts`).
   No setting names the relay as the only path: by the maintainer's ruling of 2026-10-17, no relay-only mode is assumed, and a party reaches the relay only through the fallback of step 2, where work that shortens the wait before it falls back is in scope.
   The entry names where the relay is; the CLI's is `connection.websocket_relay` ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionwebsocket_relay)).
2. **Automatic fallback.** Each party opens its relay socket as it starts the WebRTC rendezvous and sends its hello; the relay pairs the two sockets and forwards nothing until both have sent a start frame.
   A party sends start when its data channel fails to open within the channel-open budget; a party that receives the partner's start abandons its WebRTC attempt and sends its own.
   A data channel that opens closes both relay sockets.
   The relay then learns of every exchange that names it, whether or not it carries one, which is what a TURN allocation already discloses ([COMMUNICATION.md](../COMMUNICATION.md#stunturn), "What a relay's operator learns"), and a party behind a network that blocks the broker outright still reaches its partner.

Step 1 is the smaller change and gives a party that has no path today a working one.
Step 2 is the better experience -- nothing to set, no second wait -- and about twice the protocol work; it is the recommended end state, and the hello frame carries a start message from the first cut so step 2 adds behaviour rather than a new wire.

**The wrap.** On the relay path both implementations pass `requestEncryption = true` to `authenticateConnection`, and the web side applies `EncryptedMessageConnection` when the negotiated decision is true instead of refusing.
On the WebRTC path both implementations also request and apply the wrap on every exchange.
The handshake frames, the ephemeral public keys and confirmation MACs, cross the relay in the clear as they cross an SFTP server ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)); the PSI frames and the lists of matched records do not.

### What the relay's operator sees, stated for the disclosure documents

- Each party's address and the fact and timing of the pairing, as the broker and the TURN relay see today.
- The volume each direction, as the TURN relay sees.
- The handshake frames, which hold no linkage identifier and no exchange data, and the AEAD envelopes of every later frame, with their sequence numbers and sizes.
- Not the key the proof is derived from: the proof key derives from the relay key under a label, and the relay holds the relay key already.

That is more than TURN and less than an SFTP server, and it is the posture [DESIGN.md](../DESIGN.md#websocket-relay) already states; a party that will not accept it runs the relay itself, as with coturn.
The rows it adds to [PRIVACY.md](../../PRIVACY.md#what-supporting-services-can-observe) and [SHARED_RESPONSIBILITY.md](../SHARED_RESPONSIBILITY.md#third-party-supporting-services), and the row it changes in the wrap table ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it)), are implementation items below.

### Who runs it, and what it costs

- **The project, for the hosted application**, on the relay instance beside coturn and the broker: a Node process the size of the broker, about 50 to 60 MB ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#does-the-coordination-server-leave-the-web-apps-deployment)), on a host with 412 MB and no headroom; the instance size is the first thing the deployment revisits.
  Egress is the same bytes the TURN relay forwards, so the cost class is TURN's.
- **A party**, from a reference deployment in `infra/relay/` beside coturn, under the same registrar, journald retention and verification timer; a partner's governance meets it as it meets a self-hosted TURN relay, with the one added attestation that it forwards AEAD envelopes it cannot open.
- **No managed vendor**: the hello, the pairing and the per-exchange proof are Alcove's, so no commercial relay carries this path.
  That is a difference from TURN, where a vendor is a supported alternative, and it is the cost of the protocol being ours.

**Port 443 is a prerequisite, not a detail.**
The broker and the relay each need 443 for the reason TURN does.
The owner's choice (2026-10-04) is one proxy on 443, and the relay reference builds it as [the 443 front](../../infra/relay/README.md#the-443-front):

- **What it does.** It reads each connection's TLS server name and passes a routed connection, TLS unopened, to its service on loopback, which presents its own certificate.
  Every connection no route claims is TURN: the front terminates its TLS under the relay's certificate and passes plain TURN to coturn on loopback.
- **Where it runs.** It is installed on the project's relay host, routing the broker's name to the broker's front ([DEPLOYMENT.md](../DEPLOYMENT.md#what-the-deployment-logs)).
  TURN allocations and a signaling WebSocket passed through it there; a relayed exchange from a client admitted to 443 only is not yet measured ([webrtc-relay-deployment.md, One listener on 443](webrtc-relay-deployment.md#one-listener-on-443)).
- **What the relay adds.** One more route, its own name to a server of the front that terminates its TLS under the relay's certificate, issued for that name too, and passes the upgrade to the relay on loopback; the relay has no certificate and opens no public listener ([infra/relay/README.md, The WebSocket relay](../../infra/relay/README.md#the-websocket-relay)).
- **What the relay loses.** Behind the front every connection arrives from `127.0.0.1`, so the relay cannot read a client's address, and its quotas key on the exchange alone ([WEBSOCKET_RELAY.md, Quotas](../spec/WEBSOCKET_RELAY.md#quotas)).
  The front bounds sockets for each client address instead ([WEBSOCKET_RELAY.md, The endpoint](../spec/WEBSOCKET_RELAY.md#the-endpoint)): its server for the relay already reads the address from the PROXY header from 443 with `set_real_ip_from`. The relay itself still cannot read it, since an upgrade that opens with a PROXY header draws one `400` (measured 2026-10-19).
  A per-address limit on enrollment without a token ([fork 1](#the-forks-and-their-rulings)) meets the same question at the registrar.

A second public address on the relay instance is the deployment record's fallback should a TURN client fail through the front, at about $3.60 a month ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#one-listener-on-443)); this path does not plan for it.
[S2](#the-spikes) comes before any relay work.

### How the relay fits the existing bounds

| Bound | On WebRTC | On the relay path |
| --- | --- | --- |
| Frame ceiling | `MAX_WEBRTC_FRAME_BYTES`, 268,435,456 bytes, reassembled from chunks | The same constant, the same reassembler; the relay never holds a frame |
| Chunk size | 16,300 bytes, PeerJS's threshold under the SCTP ceiling | The same 16,300 bytes, by the ruling on fork 3; a WebSocket has no 64 KiB ceiling, but a 262,144-byte chunk held the prototype relay above 100 MB resident ([S3](#the-spikes)). The relay's per-message cap follows the chunk |
| Send pacing | 1 MiB and 256 KiB window on the CLI; PeerJS's on the browser | The same window on both clients against the socket's `bufferedAmount`, and the relay's pause and resume between the two |
| Lists in parts, PSI sets in parts | Sized to the partner's data-channel bound | Unchanged: the bound is the same number |
| Budgets | Rendezvous, channel open, parked receive, close drain | Rendezvous bounds the wait for the partner's hello; channel open becomes the wait for pairing after start; parked receive and close drain apply as written |
| Delivery | Peer's close of the data channel (browser); SCTP acknowledgement drain (CLI) | Peer's close, relayed, on both; no acknowledgement signal exists |

## Question 2: one component or two

The relay above and the browser SFTP proxy of the earlier note are both WebSocket servers on 443 that forward bytes.
Everything else about them differs:

| | WebSocket relay | Browser SFTP proxy |
| --- | --- | --- |
| Pairs | Two WebSockets, by a derived per-exchange proof | One WebSocket and one TCP connection to a fixed `host:port` |
| Reads | Nothing of the exchange past the hello | Nothing: SSH runs end to end |
| Authentication | Per-exchange proof, both sides | `Origin` check, and the SSH server's own authentication behind it |
| Operator | The project for the hosted app, or a party | The party whose SFTP server it fronts, at its edge |
| Code | First-party: the pairing and the proof exist nowhere else | First-party, by the ruling of 2026-10-29 ([fork 5](#the-forks-and-their-rulings)); the off-the-shelf raw relay first assumed here, if the spike found one that backpressures and maps closes ([browser-sftp-proxy.md](browser-sftp-proxy.md#framing)), is superseded |

What each sharing choice costs:

- **One service with two modes.**
  Security: the service gains a mode that opens a TCP connection to a configured target, so the fixed-target refusal becomes a rule inside a process the hosted deployment exposes to every browser; a configuration error, or a request-parsing defect, turns the hosted relay into a TCP proxy into the host's own network, the case coturn's `denied-peer-ip` list exists to stop ([infra/relay/turnserver.conf.tmpl](../../infra/relay/turnserver.conf.tmpl)).
  Operations: one unit to run, but the project would then operate an SFTP proxy mode it has no target for, and a party running the SFTP mode would carry the pairing mode it does not use.
  Code: the shared part is the upgrade bounds the broker already exports and a forwarding loop; the modes share little else.
- **Two services, one shared library.**
  Security: the relay has no code path that dials TCP at all, so "the browser cannot choose a target" is true by absence rather than by refusal, and the proxy's fixed target is a property of a configuration file at the operator's edge.
  Operations: each operator runs the one they need.
  Code: both are first-party, the proxy by the maintainer's ruling of 2026-10-29 once S7 qualified no existing tool; the earlier reading, a reference configuration of an existing tool sharing only the upgrade bounds if built first-party, is superseded.
  The two share the broker's pre-upgrade bounds, the relay's forwarding toward a WebSocket within its send window (`sendWithinWindow`), its fault-report latch, and core's redaction of that report, and nothing else: the proxy has no pairing and no proof, and the relay dials no TCP.

**Recommendation: two.**
The relay has no mode that opens an outbound connection, and the SFTP proxy stays an operator-run fixed-target forwarder with no pairing in it.
The pieces written once are the pre-upgrade hardening, which lives in the broker package for the web servers to import, and the forwarding and fault latch the proxy imports from the relay's package.

## Question 3: the browser SFTP forks under the ruling

Fork 1 is ruled: the public web application, not the console.
The rest, each against the earlier note's answer and under the relay design above:

2. **Where the proxy runs: operator-run, unchanged.**
   The party that runs the SFTP server runs the proxy at its edge, with its fixed target, since a project-run proxy cannot have one and a console has no browser SSH client to serve ([browser-sftp-proxy.md](browser-sftp-proxy.md#where-the-proxy-runs)).
   What changes is who the proxy serves: every browser party of every partner, so the reference configuration is part of the SFTP server's onboarding, beside the firewall rule ([DEPLOYMENT.md](../DEPLOYMENT.md#sftp-server)).
3. **What it speaks: raw byte relay, unchanged.**
   SSH end to end; the proxy sees the SSH version strings and algorithm lists and nothing after.
   It is the SFTP channel's wrap that protects the files from the server's administrator, not the proxy, and the web side applies that wrap on `sftp` once the relay work above has taught it to apply the wrap at all.
4. **How the target is chosen: fixed per endpoint, unchanged**, and strengthened by Question 2: no first-party service of the project's can be told a target by a browser.
5. **How the browser authenticates: the `Origin` check, and no token by default.**
   The hosted application's origin is public, so the check stops other pages from using the proxy from a visitor's browser and nothing more; the SSH server's authentication is the real gate, as it is for the SSH port itself.
   A per-exchange proof under the relay key would be the stronger option.
   The earlier reading here, that an off-the-shelf proxy cannot check it and that building a first-party proxy to carry it is the cost Question 2 declined, is superseded by the ruling of 2026-10-29 that builds the proxy first-party ([Question 2](#question-2-one-component-or-two)); the proof stays open for a deployment that wants it.
6. **Where the proxy setting lives: changed.**
   The earlier note put it in a browser-local setting and kept proxies out of invitations.
   Under the ruling the partner who runs the SFTP server also runs the proxy, so the invitation's SFTP endpoint should name it -- host and path, no scheme, the browser taking `wss` from its page -- as the WebRTC endpoint names the signaling host today under the same delimiter rules ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#broker-socket)).
   The browser then dials a `wss` host the partner chose, which is what it does for signaling, and the far end is still authenticated by the pinned host key, so a wrong proxy is a host-key mismatch and not a disclosure.
   The browser-local setting stays as the override for a party whose own organization runs the proxy.
   The bound the earlier note stated is kept in its stronger form: the browser dials the proxy and the proxy dials its fixed target, so nothing in the invitation chooses where a TCP connection opens.
7. **The browser SSH client: none until a spike, unchanged**, and second in the sequence after the relay work rather than first.
   The spike adds one requirement: the client must take an external signer, for fork 8.
   S8 has run, and its result names the clients that passed and what each needed; the maintainer chose one on 2026-10-29 ([browser-sftp-proxy.md](browser-sftp-proxy.md#the-chosen-client-dependency-check-and-sizing)).
8. **Credentials for recurring browser exchanges: changed, to a key the browser never holds in the clear.**
   The earlier note left stored-versus-entered open.
   The better answer for a scheduled run is a key pair generated in the browser as a non-extractable WebCrypto key (ECDSA P-256, which SSH takes as `ecdsa-sha2-nistp256`): the public key goes to the SFTP server's operator at onboarding, the private key never leaves the browser's key store, and the at-rest threat model gains an unexportable signing key rather than a password ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).
   A one-off exchange enters a password or key for the run and stores nothing.
   S8 tested whether a browser SSH client can delegate the signature to WebCrypto: two clients signed with a non-extractable key, under the limits [S8](#the-spikes) records.

## Question 4: the sequence

### What ships first

The WebSocket relay, in step 1 (explicit) and then step 2 (automatic fallback), before any browser SFTP work.
The reasons, from the product and the user:

- A party behind a network that stops TURN has no path today on either application; a party who wants SFTP from a browser has a path, the CLI, and the console to lower its friction.
- The relay's first-party pieces -- the wrap on the web side, the shared framing in core, the relay locator, the Relay settings entry -- are the pieces browser SFTP needs afterwards: the SFTP path applies the same wrap and dials a `wss` host named the same way.
- The relay has no new security-relevant dependency; browser SFTP ships an SSH client to every browser ([browser-sftp-proxy.md](browser-sftp-proxy.md#the-ssh-client-in-the-browser)).

### The spikes

Each is an experiment with a PASS a reviewer can read off the result, run before the code it gates.

- **S1. Does a protocol-enforcing proxy stop TURN and pass a WebSocket?**
  On the AWS harness of the relay measurement, class B with the inspecting proxy configured to enforce HTTP inside TLS (the spike names the tool and the rule it used), a CLI party and a browser party each try TURN over TLS on 443 and then a minimal WebSocket echo relay on 443.
  PASS: the WebSocket connection completes and the TURN allocation is refused, with the proxy's log naming the refusal; the capture of each Client Hello is recorded for the ALPN question.
  If TURN passes every enforcement the tool offers, the result is recorded and the relay's case rests on the maintainer's field reports, stated as such.
  **Result (2026-10-14): the decisive part of the PASS line was met; the PASS line as written was not.**
  Met: a WebSocket upgrade on 443 completed and held open 30 s through a TLS-intercepting Squid while TURN over TLS on the same path was stopped.
  Not met, and still open:
  - A refused TURN allocation named in the proxy's log. TURN stalled with no reply; the log named the stop only after the client gave up.
  - The Client Hello capture, so the ALPN question stays open.
  - A CLI party and a browser party. A raw Allocate and `turnutils_uclient` with a wrong credential stood in for the first; no browser or werift client ran.

  The tool and the rule, each level probed for TURN over TLS and for a WebSocket held open 30 s.
  Squid 6.13 ran as a transparent (intercept) proxy between a client host and the project relay's 443 front, which stood in for the AWS harness; the signaling server's WebSocket stood in for a minimal echo relay.

  | Level | Squid rule | TURN | WebSocket |
  | --- | --- | --- | --- |
  | L1 | `ssl_bump peek step1`, `ssl_bump splice all` | Reached coturn, which answered 401 naming its realm | Held |
  | L2 | `ssl_bump bump all`, `on_unsupported_protocol tunnel all` | Stalled, no reply | Held |
  | L3 | As L2 with `on_unsupported_protocol respond all` | Stalled, no reply | Held |
  | L4 | As L3 without `http_upgrade_request_protocols` | Raw Allocate stalled; `turnutils_uclient` got Squid's HTTP error page | Stopped: the origin answered 404 to an upgrade Squid forwarded without its `Upgrade` header |

  L2 and L3 also set `http_upgrade_request_protocols websocket allow all`. Direct runs before and after (L0, L0b) matched, so the relay did not change mid-run.

  What L2 was: not a non-enforcing level.
  Squid parses the decrypted stream of a bumped connection as HTTP at L2 as at L3, and the log shows the parser at work at L2: a non-HTTP control line was logged `error:invalid-request` and then tunnelled by `tunnel all`, and the stalled TURN connections ended `error:transaction-end-before-headers`.
  L2 and L3 differ only in what follows an unparseable request: tunnelled at L2, answered with an HTTP error at L3.
  So the L3 directive is not why TURN stopped.
  Why the TURN requests stalled instead of being refused or tunnelled is unexplained; a guess that a request with no newline byte waits for more bytes was not tested.

  What it means, for the one proxy and the one client tested: on a network that intercepts TLS and parses HTTP inside it, a WebSocket relay on 443 connected where TURN did not, so the relay path stands there.
  A network that also refuses upgrades stops both.

  For anyone repeating it: Squid 6.13 matches the upgrade protocol name case-sensitively, so `http_upgrade_request_protocols` needed `websocket` in lower case for the upgrade to pass.
- **S2. A relayed exchange through the 443 front.**
  The one 443 front on the relay instance is built and routes the broker's name; the relay's name is one more route on it ([Port 443 is a prerequisite](#who-runs-it-and-what-it-costs)).
  What S2 still measures is the case the deployment record lists as not measured: a relayed exchange through the front from a client admitted to 443 only.
  That run needs a registrar behind the front to enroll the exchange's key, which the project's relay host does not yet run.
  PASS: the registrar-path row repeated with TCP admitted only to 443 of the relay host's names -- a browser with UDP refused completes a relayed exchange with a CLI party.
  A failure of TURN through the front is answered by the deployment record's fallback, a second public address, and not by this path.
- **S3. Relay forwarding under load.**
  A prototype relay with pause-and-resume forwarding; two Node parties, then Chromium against Node, sending frames up to 268,435,456 bytes in chunks, with one receiver throttled.
  PASS: a round of the largest measured exchange's size, 539,000,000 bytes one way, completes; the relay's resident set stays under 100 MB throughout with the slow reader; a sender above the per-pairing rate is paced and not disconnected.
  The chunk size question is answered here by measuring 16,300 against a larger chunk on the same run.
  **Result, Node legs (2026-10-18): PASS at 16,300-byte chunks; a 262,144-byte chunk broke the memory bound.**
  A prototype relay on `ws` 8.22.0 with pause-and-resume forwarding: a destination window of 1 MiB and 256 KiB, and a per-pairing token bucket at 2,000,000 bytes a second each way.
  Two Node parties, each a `MessageConnection` over `ws` with core's chunk encoder, bounded reassembler and `EncryptedMessageConnection`, the CLI's send window, and an acknowledgement after each frame.
  Node 26.12.0 in the development container (Docker Desktop's Linux VM on an Apple silicon Mac, 10 vCPUs, 24 GiB), one pairing on loopback, the relay's resident set read every 100 ms.
  - **The round.** 539,000,000 bytes one way, in frames of 267,532,651, 267,532,651 and 3,934,698 bytes (the largest a sender may frame, wrapped), the receiver reading at 1,500,000 bytes a second: complete in 360 s, every frame's SHA-256 matching.
  - **Memory.** The relay's resident set peaked at 77.0 MB over 3,486 samples, from 60.6 MB idle; two earlier runs of the leg peaked at 76.3 and 77.5 MB.
    The slow reader held the sender back for 215 s of the 351 s the relay had its socket paused.
  - **Pacing.** A sender above the rate, its receiver unthrottled, moved 64 MiB at 1,993,671 bytes a second with its own `bufferedAmount` at its 1 MiB window, and was not disconnected.
    Every leg's close ended on the relayed peer close.
  - **The open question: `ws` applies the pause end to end.** After `pause()` on the relay's `ws` socket, 114,156 more bytes were read (the read in flight) and none in a 3 s hold, while the sender's `bufferedAmount` stayed level; three messages already read were still emitted.
    `pause()` on the underlying socket measured the same.
    The stream wrapper (`createWebSocketStream`) also stops reads, but only once 16 messages wait in its own buffer, by which point it had read 4,552,858 bytes of 262,144-byte messages.
  - **Chunk size.** Each leg ran at both sizes back to back; a cell with two values reads 262,144 bytes / 16,300 bytes:

  | Leg | Relay peak resident set | Relay CPU | Throughput |
  | --- | --- | --- | --- |
  | The round | 112.0 MB, above 100 MB in 82% of samples / 77.0 MB | 5.0 s / 6.6 s | The receiver's 1.5 MB/s either way |
  | Pacing, 64 MiB | 107.1 MB / 77.4 MB | 1.0 s / 1.4 s | The rate either way |
  | No rate cap, 539,000,000 bytes | 154.2 MB / 91.1 MB | 1.2 s / 1.3 s | 177 / 156 MB/s; an earlier pair 160 / 161 |

  At 262,144 bytes the relay held at most 262,191 bytes for the destination while its count of array buffers reached 43 MB, so the growth is buffers released and not yet collected rather than data held.
  The larger chunk saves 10 to 33 percent of the relay's CPU across two pairs of runs, gains no consistent throughput, and breaks the memory bound, which supports [fork 3](#the-forks-and-their-rulings)'s ruling.

  The harness is throwaway and kept outside the repository: `node s3.mjs --repo <checkout> --out <dir> --leg round --chunk 16300 --total 539000000 --rate 2000000 --recv-rate 1500000 --ack`, with `--chunk 262144` for the comparison, `--leg rate --total 67108864` for pacing and `--rate 0` for no cap; the pause probe is `node probe-pause.mjs --repo <checkout>`.

  **Result, Chromium against Node (2026-10-18): PASS in both directions at 16,300-byte chunks.**
  The relay of the Node legs, on the same machine and Node; one party a page in Playwright 1.64.0's headless Chromium, 156.0.8078.4 (`chrome-headless-shell`, linux/arm64), the other a Node party.
  The page runs the same `MessageConnection` as the Node party, with core's chunk encoder, bounded reassembler and `EncryptedMessageConnection`, and the 1 MiB send window polled against the socket's `bufferedAmount`.
  A browser cannot pause its socket, so the Chromium slow reader is a page whose main thread is held busy for most of each second.
  The relay's resident set was read every 100 ms, Chromium's every second as the sum over its processes, which counts shared pages more than once.

  | Direction | The round, 539,000,000 bytes | Relay peak resident set | Slow reader held the sender | Sender's `bufferedAmount` peak | Chromium's peak resident set |
  | --- | --- | --- | --- | --- | --- |
  | Chromium sends; Node reads at 1,500,000 bytes a second | 360 s, every frame's SHA-256 matching | 76.2 MB, median 74.3 MB over 3,564 samples, from 60.6 MB idle | 183 s of the 350 s the relay had its socket paused | 1,063,622 bytes, the page's window | 2.12 GB |
  | Node sends; Chromium's main thread busy 980 ms of every second | 333 s, read at 1,618,376 bytes a second, every frame's SHA-256 matching | 77.5 MB, median 75.2 MB over 3,265 samples | 58 s of 308 s | 1,062,295 bytes | 2.54 GB |

  - **Pacing.** In both directions the sender ran above the 2,000,000-byte rate, the relay paced it, and it was not disconnected; each close ended on the relayed peer close (code 1000).
  - **Chromium stops reading when its page falls behind.** With the main thread busy 800 ms of every second the page kept pace with the rate and the relay's buffer for it never filled, in a 20,000,000-byte run.
    At 995 ms the page read 244,004 bytes a second, and the relay held the Node sender back for 222 s of a 246 s transfer of 60,000,000 bytes, its resident set peaking at 77.3 MB.
    So the relay's pause reaches a browser receiver as it reaches a `ws` one, and a browser sender's window waits on it, as [Backpressure, not termination](#the-websocket-relay-as-recommended) states.

  Harness: `node browser-leg.mjs --repo <checkout> --out <dir> --leg s3 --browser-role send --chunk 16300 --total 539000000 --rate 2000000 --recv-rate 1500000 --ack`, and `--browser-role recv --busy-ms 980 --busy-period-ms 1000` in place of `--browser-role send --recv-rate 1500000` for the other direction.
  Still open: more than one pairing at once, since the resident set rose with the rate forwarded (77 MB at 2 MB/s, 91 MB at 156 MB/s).
- **S4. The wrap in the browser.**
  `EncryptedMessageConnection` over a browser WebSocket transport, the web side requesting the wrap, a CLI partner.
  PASS: the exchange completes with the correct intersection, and a capture at the relay shows only the handshake frames outside the AEAD envelope, every later frame beginning with the envelope's version byte.
- **S5. Close delivery through the relay.**
  The sender's tab or process ended the instant its close resolves, as the WebRTC measurement did ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#the-clean-close)).
  PASS: the peer receives the final frame in every one of ten runs, and the sender's close resolved only on the relayed peer close.
  **Result, Node legs (2026-10-18): PASS.**
  The relay and parties of S3, with the rate cap on, on the same machine.
  In each run the sender sent a 1,024-byte frame and a final frame of 16,777,216 bytes, closed, and called `process.exit` the instant its close resolved; times are read from one monotonic clock across the processes.
  In every run the receiver had the final frame, its SHA-256 matching, and the sender's close resolved on the relayed peer close (code 1000), after the receiver had read the sentinel and sent its close:

  | Run | Final frame | Close wait, ms | Close resolved after the peer's close, ms | Sender's process gone after its close, ms |
  | --- | --- | --- | --- | --- |
  | 1 | Received | 2,361 | 6.1 | 13 |
  | 2 | Received | 2,999 | 16.9 | 11 |
  | 3 | Received | 2,931 | 12.2 | 17 |
  | 4 | Received | 2,301 | 9.1 | 34 |
  | 5 | Received | 2,223 | 36.1 | 17 |
  | 6 | Received | 2,784 | 20.9 | 13 |
  | 7 | Received | 2,296 | 16.7 | 15 |
  | 8 | Received | 2,576 | 15.9 | 16 |
  | 9 | Received | 2,568 | 25.4 | 19 |
  | 10 | Received | 3,275 | 22.3 | 16 |

  Two controls of ten runs each show the window the wait closes:
  - A close that returns once the sentinel is queued, as PeerJS's own close does, lost the final frame in 8 runs (5 in an earlier run of the control).
  - A close that returns once the sentinel is written to the socket delivered the final frame in all 10 on loopback, the sender's kernel sending its buffered bytes after the process had gone, but resolved 1.1 to 3.4 s before the peer had the frame, so it confirmed nothing.

  Harness: `node s5.mjs --repo <checkout> --out <dir> --close wait --runs 10`, with `--close nowait` and `--close flush` for the controls.

  **Result, Chromium sender (2026-10-18): PASS, on the second set of ten runs after a harness repair.**
  The relay and Node receiver of the Node legs; the sender a page in the Chromium of S3.
  In each run the page sent a 1,024-byte frame and a final frame of 16,777,216 bytes and closed.
  - **How the close resolved.** The page sent the close sentinel behind the final frame and waited for its socket's `close` event, bounded by a drain timer; the close resolved when that event came with code 1000, which the relay sends only to forward the receiver's own close.
  - **How the tab ended.** On the line after its close resolved, the page called a Playwright binding whose handler closed the tab at once with `page.close({ runBeforeUnload: false })`.
  - Times are epoch-anchored (`performance.timeOrigin` plus `performance.now()`) in the page, the driver and the Node process, on one machine.

  In every run of the second set the receiver had the final frame, its SHA-256 matching, and the page's close resolved on the relayed peer close (code 1000), after the receiver had read the sentinel and sent its close:

  | Run | Final frame | Close wait, ms | Close resolved after the peer's close, ms | Tab closed after its close resolved, ms |
  | --- | --- | --- | --- | --- |
  | 1 | Received | 3,225 | 17.1 | 24 |
  | 2 | Received | 2,596 | 28.1 | 15 |
  | 3 | Received | 3,276 | 22.9 | 16 |
  | 4 | Received | 2,034 | 19.4 | 22 |
  | 5 | Received | 2,378 | 16.1 | 8 |
  | 6 | Received | 2,257 | 17.9 | 15 |
  | 7 | Received | 2,567 | 15.8 | 6 |
  | 8 | Received | 2,586 | 3.4 | 7 |
  | 9 | Received | 2,730 | 23.8 | 10 |
  | 10 | Received | 2,334 | 29.0 | 20 |

  - **The first set of ten** had the final frame in 9 runs, every close resolving on the relayed peer close.
    In the tenth the receiver lost the 1,024-byte first frame, not the final one, and refused the next frame's sequence number.
    The loss was in the harness's Node party, which added its data handler only after awaiting the relay's `paired` message: `ws` 8.22.0 emits a message read together with `paired` before that await resumes, and a probe lost it in 20 of 20 trials.
    The repaired party keeps such messages for its handler, and kept one in 3 of the 20 runs of the second set and its control.
  - **The control**, a close that returns once the sentinel is queued, with the tab closed as above, lost the final frame in 8 of 10 runs, and in 6 of 10 on the second set.
    In each loss the relay saw the page's socket end with a code other than 1000 and passed 4000 to the receiver.
    Where the frame did arrive, the page's close had returned 2.2 to 2.7 s before the receiver had it.

  Harness: `node browser-leg.mjs --repo <checkout> --out <dir> --leg s5 --close wait --runs 10`, with `--close nowait` for the control.
- **S6. Silence through a front.**
  A relayed exchange whose PSI step is silent for longer than the front's idle timeout, with the clients' pings on.
  PASS: the socket survives the silence and the parked-receive budget is what bounds it.
  **Result (2026-10-18): PASS.**
  The run was on the Mac (Apple M1 Max, Docker Desktop, linux/arm64): the repo's 443 front rendered with the relay's route and a self-signed certificate, the relay at staging 80842d8ad, Node 26.12.0 with `ws` 8.22.0, and Chromium 156.0.8078.4.
  The front's idle bound is 900 s.

  | Arm | Silence | Outcome |
  | --- | --- | --- |
  | Node, pings every 30 s | 960 s | Survived; the second frame arrived and the close was 1000, 960.034 s after pairing |
  | Node, no pings | 960 s | Cut at 900 s; close 1006 at each party, 900.027 s after pairing |
  | Node, pings, parked-receive budget 1,200 s | 1,500 s | The receiver ended at 1,200 s with `no message arrived within 1200000 ms`, the pings keeping the sockets open; the sender saw 4000 |
  | Chromium, relay pings every 30 s | 960 s | Survived; the second frame arrived |
  | Chromium, no pings | 960 s | Cut at 899.945 s; close 1006 at the browser, and the relay passed 4000 to the surviving sender |

  In the Node arms both parties sent the pings, at the harness's `--ping-ms` interval of 30 s, and the no-ping arm ran the parties with that interval set to 0.
  In the Chromium runs the Node sender pinged its own socket at `--node-ping-ms 30000`, and the browser's socket was pinged by the relay at `--relay-ping-ms 30000`, since a browser cannot send one; the no-ping run set `--relay-ping-ms 0`.
  The parked-receive budget arm ran with Node parties only; the Chromium runs tested survival and the cut at the front's idle bound.

  Harness: `node s6.mjs --repo <checkout> --out <dir> --url wss://127.0.0.1:8443/relay --servername wsrelay.test` for the three Node arms, and `node browser-leg.mjs --repo <checkout> --out <dir> --leg s6 --browser-url wss://wsrelay.test:8443/relay --node-url wss://127.0.0.1:8443/relay --servername wsrelay.test --silence-ms 960000 --node-ping-ms 30000 --relay-ping-ms 30000`, with `--relay-ping-ms 0` for the control.

  Measured while preparing its harness (2026-10-18, Chromium 156 in the development container): a browser `WebSocket` has no ping method, and Chromium answered each ping the relay sent its socket; the keepalive in [The WebSocket relay, as recommended](#the-websocket-relay-as-recommended) is amended to match.
- **S7. The raw SFTP relay.**
  From the earlier note: a candidate proxy in front of the SFTP test server, backpressure, close mapping and the `Origin` refusal ([browser-sftp-proxy.md](browser-sftp-proxy.md#framing)), run only after the relay work above.
  **Result (2026-10-29): no relay tried passed every check.**
  websockify refuses by `Origin` and maps closes, but keeps reading from the browser while the SFTP server reads nothing; websocat holds backpressure both ways and maps closes, but has no `Origin` check; the npm port of websockify exits on its first upgrade.

  The run was in the development container (Node 26.11.1, linux/arm64).
  Each relay sat between a Node client on `ws` 8.22.0 and either the SFTP test server's native backend (`startNativeSshdServer` in `apps/cli/test/sftpServer/nativeSshdServer.ts`, baseline profile, OpenSSH 9.2p1) or a loopback TCP target the harness controlled.
  The relays, each installed outside the repository:
  - **websockify 0.13.0**, tag `v0.13.0` of `novnc/websockify` (commit e81894751365), run from its source with Python 3.11.2 and none of its optional packages: `python3 -m websockify --auth-plugin websockify.auth_plugins.ExpectOrigin --auth-source <origin> <listen> <target>`.
  - **websocat 1.14.1**, the release binary `websocat.aarch64-unknown-linux-musl` (SHA-256 `711a69576a2ff473fb01a90ffafb571c2ed019e55479d7ae71b12c2eadeb7011`): `websocat --binary -E ws-l:<listen> tcp:<target>`.
  - **websockify 0.7.1** from npm, the Node port.

  | Check | websockify 0.13.0 | websocat 1.14.1 |
  | --- | --- | --- |
  | SSH and SFTP through the relay | PASS | PASS |
  | `Origin` refusal | PASS | fail: every upgrade accepted |
  | Backpressure, SFTP server to browser | PASS | PASS |
  | Backpressure, browser to SFTP server | fail: 280 MB taken in 20 s, no plateau | PASS |
  | Close mapping | PASS | PASS |

  - **SSH and SFTP.** An `ssh2` 1.17.0 client over `createWebSocketStream`, its host key pinned, wrote 8 MiB over SFTP and read it back unchanged; S8's Chromium page also ran through websockify.
  - **`Origin` refusal.** Six upgrades against a target that counted its connections: the application's origin, another origin, `null`, the application's origin with a suffix (`http://app.test:8080.evil.example`), the application's origin with a path, and no `Origin` header.
    websockify upgraded the first alone and answered each other with 403 `Invalid Origin`, opening no connection to the target; configured for another origin, it refused S8's Chromium page, whose `Origin` the browser set.
    websocat upgraded all six and connected each to the target; its `--help=full` lists `--origin` only as a client option.
  - **Backpressure, SFTP server to browser.** The target wrote 1 MiB chunks as fast as its socket drained while the client held its socket paused (`ws` `pause()`) for 20 s.
    websockify stopped reading: the target's writes stopped at 24 MB and 44 MB in two runs, within the loopback socket buffers (`tcp_rmem` up to 32 MiB here), and the relay's resident set, its per-connection child included, stayed flat at 54 to 74 MB from 20 MB idle.
    websocat stopped the target at 5.2 MB, its resident set flat at 2.4 MB.
    Each delivered every byte on resume.
  - **Backpressure, browser to SFTP server.** The client sent 64 KiB messages whenever its `bufferedAmount` was under 4 MiB while the target held its socket paused for 20 s.
    websockify kept reading: it took 280 MB from the client, its resident set rising steadily from 20 MB to 308 MB, and delivered it all on resume.
    websocat stopped at 5.6 MB taken, its resident set flat at 2.5 MB.
  - **Close mapping.** Four cases: the client's close with code 1000, the client's socket destroyed with no close frame, the target's FIN, and the target's reset.
    Each relay ended the other side within 6 ms in every case.
    The client saw websockify's close as 1000, 1006, 1000 (`Target closed`) and 1006, and websocat's as 1006, 1006, 1005 and 1006, websocat completing no close handshake.
  - **websockify 0.7.1 from npm** exited with `TypeError: protocols.indexOf is not a function` on the first upgrade that named a subprotocol, its `ws` dependency range having installed `ws` 8.22.0; its `--help` lists no `Origin` option, and it was not run further.

  What it leaves for [fork 5](#the-forks-and-their-rulings), whose reading is an `Origin` check on an off-the-shelf relay: websocat behind a front that checks `Origin` (not tested), websockify with the browser-to-server direction bounded, or the first-party relay [Question 2](#question-2-one-component-or-two) kept for the case that no relay qualifies.

  The harness is throwaway and kept outside the repository; it starts the native backend through Node's type stripping of `nativeSshdServer.ts`: `node s7.mjs --relay websockify --leg sftp`, with `--relay websocat` or `--relay node-websockify`, and `--leg origin`, `--leg bp-down --seconds 20`, `--leg bp-up --seconds 20` or `--leg close`.
- **S8. The browser SSH client with an external signer.**
  A candidate client through the raw relay from the browser suite, authenticating with a non-extractable WebCrypto P-256 key.
  PASS: the client authenticates, exposes the host-key blob before authentication, and completes a file write and read; the key never leaves WebCrypto.
  **Result (2026-10-29): PASS for `@microsoft/dev-tunnels-ssh` 3.12.42 with three additions in the spike's code; `ssh2` 1.17.0 bundled for the browser passed only against a server that also offers an ECDSA host key; `@verdigris/libssh2.js` 0.1.9 failed.**

  The page ran in the browser suite's browser, Playwright 1.64.1's headless Chromium 156.0.8078.4 (`chrome-headless-shell`, linux/arm64), driven by a throwaway script rather than the suite's vitest project.
  It was served from `http://127.0.0.1:<port>` and dialed S7's websockify, its `ExpectOrigin` set to the page's origin, in front of the native backend's baseline profile, whose one host key is ed25519.
  A second arm ran the same baseline directives in an sshd the spike started with an ECDSA P-256 host key beside the ed25519 one.
  Each candidate and its additions were installed and bundled in a project outside the repository.
  - **The key.** The page made an ECDSA P-256 pair with `crypto.subtle.generateKey(..., false, ["sign", "verify"])`; its private key's `extractable` was false and `exportKey` threw `InvalidAccessError` in `pkcs8` and in `jwk`.
    The harness appended its `ecdsa-sha2-nistp256` public key to the server's authorized keys.
  - **Host key before authentication.** The client's callback received the host key blob, and the page compared its SHA-256 fingerprint with the pin before any authentication request; with a wrong pin each passing client ended the run with no signature made.
  - **Authentication.** The run's one signature was `crypto.subtle.sign` on the non-extractable key, counted by wrapping it.
  - **Write and read.** 1 MiB or 8 MiB of random bytes written over SFTP and read back; the page's SHA-256 of each matched the other and the file on the server's disk.

  | Candidate | The harness, ed25519 host key only | With an ECDSA host key too |
  | --- | --- | --- |
  | `@microsoft/dev-tunnels-ssh` 3.12.42, unchanged | fail: `Failed PublicKey negotiation: Server (ssh-ed25519) Client (rsa-sha2-512, rsa-sha2-256, ecdsa-sha2-nistp384, ecdsa-sha2-nistp256)` | PASS with additions 2 and 3, one 8 MiB run |
  | `@microsoft/dev-tunnels-ssh` with additions 1 to 3 | PASS in 9 runs, 8 of them of 8 MiB | Not run |
  | `ssh2` 1.17.0, bundled | fail: `Handshake failed: no matching host key format` | PASS in 12 of 13 runs |
  | `@verdigris/libssh2.js` 0.1.9 | fail: no host-key function and no signer | Not run |

  - **`@microsoft/dev-tunnels-ssh`, the additions.**
    1. A verify-only `ssh-ed25519` public-key algorithm on WebCrypto's Ed25519, about 70 lines, added to `SshSessionConfiguration.publicKeyAlgorithms`, whose default list named the four algorithms in the error above.
    2. The page's non-extractable key assigned to the `privateKey` field of the library's WebCrypto ECDSA key pair after `setPublicKeyBytes`, a field its type declarations do not list. The pair's own `generate()` made an extractable key, whose `exportParameters()` returned the private scalar.
    3. An SFTP version 3 client, about 120 lines (init, open, write, read and close), over a session channel's `sftp` subsystem request, since the package exports no SFTP client.

    Its session crypto ran on WebCrypto: ECDH key exchange and AES-GCM, counted by wrapping `crypto.subtle`.
    8 MiB was written in about 1.1 s and read in 0.3 s.
  - **`ssh2`, bundled** with esbuild 0.28.1 and node-stdlib-browser 1.3.1's polyfills, plus: stubs that throw for `net`, `fs`, `dns`, `tls` and `child_process`; native addons resolved to a module that throws; `__dirname` defined; Node's `zlib.constants` and `crypto.getCurves()` added to the polyfills; and Node's per-encoding Buffer methods (`latin1Slice` and the like) added to the `buffer` polyfill.
    The signer is a `BaseAgent` subclass whose `sign` returns the SSH ECDSA signature (`mpint r`, `mpint s`) built from WebCrypto's; the same agent in Node, through websockify to the harness, passed.
    Its session crypto ran in the JavaScript polyfills, not WebCrypto: `ecdh-sha2-nistp256` and `aes128-gcm@openssh.com`; 8 MiB was written in 2.1 s and read in 1.9 s.
    Against the harness it would need an ed25519 host key verifier in its crypto polyfill, which the polyfill lacks; that was not attempted.
    The one failed run, the first, refused a host key matching neither pin; the twelve runs after it passed, and the cause was not found.
  - **`@verdigris/libssh2.js`**, libssh2 compiled to WebAssembly: instantiated in the page, its module exports C functions (`_ssh2_*`) whose authentication entries are `password`, `publickey_fromfile` and `publickey_frommemory` (a private key held in memory), and no host-key or known-hosts function; it was not driven past that.
    It would need a build exporting libssh2's host-key call and its callback form of public-key authentication, with a bridge from libssh2's synchronous callback to WebCrypto's promise, which is unverified.

  Harness: `node run.mjs --candidate devtunnels --ed25519-patch --bytes 8388608`; `--candidate ssh2 --host-keys ed25519+ecdsa`; `--wrong-pin` for the refused host key; `--origin <other origin>` for S7's refusal from the page; and `node node-ssh2-agent.mjs inner` for the Node agent.

### Implementation items implied, not filed

The front on 443 and the broker's route on it are already built. Its open measurements, the registrar behind it and a relayed exchange from a 443-only client ([S2](#the-spikes)), are a prerequisite of this path.

Relay path, in order:

- **Relay proof derivation and spec row** -- the derived key and its label in core, with vectors, beside the registrar proof in PROTOCOL.md.
  Built: `packages/core/src/websocketRelayProof.ts`, specified in [PROTOCOL.md](../spec/PROTOCOL.md#the-websocket-relay-proof).
- **The relay service** -- a workspace beside the broker's: hello, proof check against the shared table, pairing by role, pause-and-resume forwarding, per-message cap, quotas, pings, close ordering, the broker's upgrade bounds.
  Built: `packages/websocket-relay`, specified in [WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md).
- **Relay deployment reference** -- a unit beside coturn in `infra/relay`, its route and certificate on the 443 front, the client's address behind the front should a per-address quota be added, journald retention, a `verify.sh` probe that pairs two sockets and forwards one frame.
  Built, and installed on the project's host on 2026-10-19: [infra/relay/README.md, The WebSocket relay](../../infra/relay/README.md#the-websocket-relay); the client's address is not passed on.
- **Browser WebSocket transport** -- a `MessageConnection` over a browser WebSocket with the shared reassembler and the pacing window.
  Built: `apps/web/src/psi/transport/websocketRelayConnection.ts`, specified in [WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md#the-web-applications-client).
- **CLI WebSocket transport** -- the same over `ws`, with the connection-block entry and the per-party setting.
  Built: `apps/cli/src/connection/webrtc/websocketRelayConnection.ts`, specified in [WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md#the-command-line-client).
- **The wrap on the web side** -- request it on the relay transport, apply the decorator when negotiated, keep the WebRTC refusal.
  Built differently: the web wraps every WebRTC exchange too, and `authenticateExchange` (`apps/web/src/psi/authenticateExchange.ts`) requests and applies the wrap on whichever connection a run opened, a relay connection included ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it)).
- **Relay locator and settings** -- the `wss` url on the invitation locator, the Relay settings page, and the CLI's connection block, selected per kind.
  Built: the locator's `websocket` url ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)), the Relay server page's WebSocket relay field on the hosted build (`apps/web/src/exchange/RelaySettingsScreen.tsx`), a build's default WebSocket relay (`VITE_DEFAULT_RELAY_WEBSOCKET_URL`), and the per-kind listing under the allowed relays (`selectRunRelay` in `packages/core/src/relayCredential.ts`, `webSocketRelaysForRun` in `apps/web/src/psi/transport/ownRelaySetting.ts`).
- **Automatic fallback** -- the start frame, the parked relay socket during the WebRTC rendezvous, and the hand-over.
  Built: the race both applications run (`packages/core/src/connection/relayFallback.ts`) over each client's parked socket and each run's relay list, specified in [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay).
- **Disclosure documents** -- PRIVACY and SHARED_RESPONSIBILITY rows, the SECURITY_DESIGN channel-security paragraph, the wrap table row and its "no such transport exists" sentence in CHANNEL_SECURITY, COMMUNICATION's supporting services, DEPLOYMENT, CLI.md, the planned `connect-src` allowlist ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)).
- **Tests** -- relay unit tests with the shared refusal fixtures, a relayed exchange in the browser suite, a CLI-to-browser relayed run in the interop suite ([TESTING.md](../TESTING.md#cross-runtime-interop-suite)), and a stress-tier run at the largest size.
  Built: the relay's unit tests, which present core's shared refused proofs (`packages/core/src/websocketRelayProofFixtures.ts`) in a hello (`packages/websocket-relay/test/proofFixtures.test.ts`), the browser suite's relayed exchange and unused relay sockets (`apps/web/test/browser/relayFallback.test.ts`), the interop suite's relayed run with WebRTC blocked (`apps/web/test/interop/cliWebRelayFallback.test.ts`), the live WebRTC leg's CLI-to-browser run with WebRTC open, whose relay sockets close unused (`apps/web/test/liveWebrtc/relayUnused.test.ts`), and the stress tier's relay round (`apps/cli/test/stress/websocketRelayRound.stress.test.ts`), measured in [WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md#measured-round-at-the-largest-exchange-size).

Browser SFTP path, after the relay path, re-scoped from the earlier note's list:

- **Raw relay reference configuration**, operator-run, with the `Origin` check, in the DEPLOYMENT section that names the proxy.
  Built first-party, since no relay S7 tried passed every check: `packages/sftp-relay` and its image, specified in [SFTP_RELAY.md](../spec/SFTP_RELAY.md), with the reference configuration in [DEPLOYMENT.md](../DEPLOYMENT.md#websocket-to-tcp-proxy).
- **Browser SSH client** with an external WebCrypto signer, as a new security-relevant dependency under the dependency policy.
- **Browser file transport client** implementing `FileTransportClient` (`packages/core/src/connection/fileSyncConnection.ts`) with browser counterparts of the CLI adapter's liveness, listing and frame-size bounds.
- **Host-key pin and first use** in the browser, with reconciliation as on the CLI.
- **Proxy on the SFTP invitation endpoint**, with the browser-local override and the delimiter refusals.
- **In-browser key pair for scheduled SFTP runs**, with the at-rest threat model extended.
- **Exchange driver for browser SFTP** in `exchangeDriverSelection.ts`, on the hosted profile only.
- **Documentation and tests** as the earlier note lists them, with the `CLAUDE.md` Applications scope of the public application updated for both paths.

## The forks and their rulings

Each with its options, the trade, a recommendation, and the maintainer's ruling; the linked section carries the argument.
Each ruling is quoted as the maintainer gave it on 2026-10-09.
The reading after a ruling is how this note applies the ruling to the fork, not the maintainer's words.

1. **How the hosted relay admits an exchange**: a registered per-exchange key, as the TURN relay today, or possession of a pairing secret with quotas and no registration, as the broker.
   Registration serves saved exchanges and CLI parties and leaves a one-shot browser exchange without a relay; possession serves every exchange and makes the hosted relay a quota-bounded public service, which runs against the standing direction that a relay is never public ([turn-provisioning-governance.md](turn-provisioning-governance.md#what-this-record-assumes)).
   Recommendation: registration, for consistency with the TURN relay, with possession presented to the maintainer as the alternative since the hosted application's one-shot exchanges are where the direction bites ([The WebSocket relay, as recommended](#the-websocket-relay-as-recommended)).
   Ruling (2026-10-09): "Use your recommendation for this item."
   Reading: registration, a proof under the enrolled exchange's relay key checked against the table coturn reads; that a one-shot browser exchange has no relay is a stated limit, and opening the hosted relay to one-shot exchanges is weighed after S3.

   **A later ruling, on the TURN relay (2026-10-14).**
   The maintainer ruled on the project's TURN relay for the production web application, whose exchanges list no relay unless the inviter configured one (`buildIceServers` in `apps/web/src/psi/transport/rendezvous.ts`).
   The rulings below are paraphrased, except for the quoted sentence, which is the maintainer's own words:

   - The project's standing relay (`turns:turn.data-bridge.org:443?transport=tcp`) is a public default, used by the production web application; this reverses the "No public relay" direction ([turn-provisioning-governance.md](turn-provisioning-governance.md#what-this-record-assumes)).
   - The browser enrolls the exchange's relay key ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)) at the registrar without the relay-owner token, bounded by per-address enrollment limits, short key lifetimes and the relay's quotas; enrollment can happen when the invitation is created.
   - The relay is always in the browser's ICE servers, not added on a retry: "I want the production site to work without frictions, so whatever that takes."
   - The relay is monitored for abuse.

   None of it is built.
   What it changes for this fork:

   - **The one-shot gap's cause goes away once that enrollment is built.** A one-shot production exchange will have a row in the table coturn reads, the table this fork's reading checks the relay's proof against, so registration as ruled admits it with no change to the mechanism, since the later ruling reaches this relay (below).
   - **The trade's argument against possession is weaker.** It rested on the direction that a relay is never public, which the later ruling reverses for the TURN relay, and the ruling below for this relay too.

   **A ruling on the WebSocket relay (2026-10-15).**
   Asked whether the later ruling reaches the WebSocket relay, whose operator sees more than TURN's -- the pairing, the handshake frames and every frame's AEAD envelope ([What the relay's operator sees](#what-the-relays-operator-sees-stated-for-the-disclosure-documents)) -- and so whether one-shot admission is still weighed after S3, the maintainer ruled, quoted verbatim:
   "Yes, it's part of the default. We were planning on using a reverse proxy to split traffic, so it could all be the same host."

   What follows from it:

   - **The relay admits any exchange with a registered key, one-shot included.** It checks each party's proof against the key the exchange enrolled ([PROTOCOL.md](../spec/PROTOCOL.md#the-websocket-relay-proof)); one-shot admission is decided by this ruling, not weighed after S3.
   - **It is part of the production default**, as the TURN relay is.
     Superseded 2026-10-22: both are off on production and staging until a party turns them on, and on by default on the demo site alone ([turn-provisioning-governance.md](turn-provisioning-governance.md#what-this-record-assumes)).
   - **The relay-restriction setting covers it.** The operator setting naming the relays a party's data may cross, not yet built, governs this relay as it governs the TURN relays.
   - **It runs behind the 443 front by server name**, one more route on the host that runs coturn and the broker ([Port 443 is a prerequisite](#who-runs-it-and-what-it-costs)).

   What the two rulings leave open, for the maintainer:

   - Whether a key enrolled for a short lifetime outlasts a relayed exchange, since the relay checks the proof at the hello.
   - Settled 2026-10-24: the front bounds sockets for each client address, not the relay, which keeps its quotas on the exchange and reads no address ([Port 443 is a prerequisite](#who-runs-it-and-what-it-costs)).

2. **Explicit relay path first, or automatic fallback first**: the explicit policy is smaller and verifiable alone; the fallback is the experience a party wants.
   Recommendation: explicit first with the start frame in the wire from the first cut, fallback as the next item ([How the parties choose it](#the-websocket-relay-as-recommended)).
   Ruling (2026-10-09): "Use your recommendation for this item."
   Reading: the explicit relay path first, with the start message in the wire from the first cut, and automatic fallback as the next item.
   The maintainer's ruling of 2026-10-17 supersedes it for the transports: no relay-only path is built, and the fallback is the only way onto the relay ([How the parties choose it](#the-websocket-relay-as-recommended)).
3. **Chunk size on the relay path**: PeerJS's 16,300 bytes, or a larger chunk since no SCTP ceiling applies.
   Larger means fewer messages and less relay overhead; the same size means one framing and one set of fixtures.
   Recommendation: the same size until S3 shows the overhead matters ([How the relay fits the existing bounds](#how-the-relay-fits-the-existing-bounds)).
   Ruling (2026-10-09): "Keep 16,300 bytes."
   Reading: the relay path uses 16,300 bytes, and S3 still measures a larger chunk on the same run.
   S3's Node legs measured 262,144 bytes on 2026-10-18; the result supports the ruling ([S3](#the-spikes)).
4. **Where the relay's reference deployment lives**: beside coturn in `infra/relay`, under the one registrar and table, or a directory of its own as the broker has.
   Beside coturn shares the key table by construction; apart keeps each reference small.
   Recommendation: beside coturn, since the table is the authentication ([Who runs it, and what it costs](#who-runs-it-and-what-it-costs)).
   Ruling (2026-10-09): "Beside coturn under infra/relay."
5. **A per-exchange proof for the SFTP proxy**: `Origin` only with an off-the-shelf relay, or a first-party proxy that checks a proof under the relay key.
   Recommendation: `Origin` only, with the proof as a later option for a deployment that asks ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 5).
   Ruling (2026-10-09): "Use your recommendation for this item."
   Reading: an `Origin` check only, with an off-the-shelf relay; a first-party proxy that checks a proof is a later option for a deployment that asks.
   S7 (2026-10-29) found no single off-the-shelf relay, of three tried, that refuses by `Origin` and holds backpressure in both directions ([S7](#the-spikes)).
   Ruling (2026-10-29), on how the reading is met: "No, I'm willing to build it. Maybe I'm off base, but I just wouldn't expect a lot of mature choices to choose from in this space."
   Reading: a small first-party relay with the `Origin` check only, its own package and image (`packages/sftp-relay`, [SFTP_RELAY.md](../spec/SFTP_RELAY.md)); the off-the-shelf relay of the earlier reading is superseded.
6. **The proxy on the invitation**: the SFTP endpoint names the proxy, or the browser-local setting alone.
   Recommendation: the endpoint names it, with the browser-local override ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 6).
   Ruling (2026-10-09): "Use your recommendation for this item."
   Reading: the invitation's SFTP endpoint names the proxy -- host and path, no scheme, under the signaling host's delimiter rules -- and the browser-local setting is kept as the override.
7. **Scheduled SFTP credentials in the browser**: a non-extractable WebCrypto key pair, a stored password or key, or entry at each run.
   Recommendation: the key pair, conditional on S8 ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 8).
   Ruling (2026-10-09): "OK, use WebCrypto then."
   Reading: a non-extractable WebCrypto P-256 key pair, conditional on S8; a one-off exchange enters its credential at each run.
   S8 (2026-10-29) met the condition with `@microsoft/dev-tunnels-ssh` and the spike's additions, and with `ssh2` bundled only against a server that also offers an ECDSA host key; no client is chosen yet ([S8](#the-spikes)).
