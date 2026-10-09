---
title: "The Web Application's WebSocket Transport Path"
---

# The web application's WebSocket transport path: a relay for networks that stop TURN, and the browser SFTP proxy

_Status: design only; nothing here is decided or built.
The public web application is the consumer of both paths and the console ships neither, by the maintainer's ruling.
The note recommends a WebSocket relay for networks whose inspection stops TURN as the first thing to build, answers whether that relay and the browser SFTP proxy are one component, re-answers the browser SFTP note's open choices under the ruling, and ends with the sequence, the spikes and the choices still open.
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
- **The framing and its bounds are already transport-independent on the CLI side.**
  `apps/cli/src/connection/webrtc/peerjsWire.ts` (the BinaryPack frame, the chunk envelope, the close sentinel) and `inboundBounds.ts` (the bounded reassembler) import only `@alcove/core` and `peerjs-js-binarypack`, with no Node module, so they run in a browser bundle.
  The constants they apply -- `MAX_WEBRTC_FRAME_BYTES` of 268,435,456 bytes, the chunk-count and concurrent-reassembly caps -- live in core (`packages/core/src/connection/binaryPackBounds.ts`; [TRANSPORT_BOUNDS.md](../spec/TRANSPORT_BOUNDS.md#webrtc-data-channel-inbound-bound)).
  The browser applies the same constants by wrapping PeerJS internals (`apps/web/src/psi/transport/boundedReassembly.ts`), which a transport that does not run PeerJS cannot reuse.
- **The wrap is a decorator over any `MessageConnection`.**
  `EncryptedMessageConnection` (`packages/core/src/connection/encryptedMessageConnection.ts`) runs on WebCrypto, and the request bit is the fourth argument of `authenticateConnection` (`packages/core/src/auth.ts`).
  The web side passes `false` and refuses a partner that requests it (`apps/web/src/psi/authenticateExchange.ts`); the WebRTC channel states `request_encryption: false` on both sides ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#application-layer-encryption)).
  That no browser exchange has run the wrap is a stated limit of the earlier note, and this one inherits it ([browser-sftp-proxy.md](browser-sftp-proxy.md#channel-security)).
- **Every web WebRTC exchange has a shared secret.**
  No secret-less rendezvous is offered on the web ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)), so a session key exists for the wrap on every browser exchange this note concerns.
- **A per-exchange relay key exists.**
  `relay_key = HKDF(secret, "alcove-relay-key-v2")`, registered at the relay's table per exchange, from which each party mints a time-limited TURN credential without contacting the relay ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation); `packages/core/src/relayCredential.ts`).
  The registrar's proof shows the pattern for a second use of the key under its own label ([PROTOCOL.md](../spec/PROTOCOL.md#the-registrar-request-proof)).
  Enrolling an exchange needs the relay-owner token: the CLI's `alcove enroll-relay`, or a saved exchange's page in the browser ([MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#when-your-relay-runs-a-registrar)); a one-shot browser exchange enrolls nothing ([PRIVACY.md](../../PRIVACY.md#what-supporting-services-can-observe), the registrar row).
- **The invitation carries the inviter's relay locator**, TURN and STUN urls and no credential, and the acceptor relays through it ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)).
  The browser keeps its own relay setting in `localStorage` (`apps/web/src/psi/transport/ownRelaySetting.ts`).
- **What the project operates for the hosted application:** the broker behind an nginx TLS front on port **8443**, beside coturn, which holds 443 on the same host; a network admitting outbound TCP to 443 alone cannot reach the broker ([infra/broker/README.md](../../infra/broker/README.md#port-8443-and-the-limit-it-sets)).
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
  The measured class-B proxy terminated TLS and did not enforce, so it passed TURN; a proxy that enforces "HTTP inside TLS" is the case the maintainer describes.
  This note takes that case as the one to design for, since it is the only one of the four a transport choice can answer.

### The candidates

| Candidate | What the middlebox sees | What the operator of the relay sees | Who runs it | Fits the transport |
| --- | --- | --- | --- | --- |
| **TURN over TLS on 443, public certificate** (built, measured) | TLS to a name; under inspection, STUN and TURN messages where an HTTP request is expected | Addresses, timing, volume; DTLS ciphertext it does not terminate ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-the-relay-sees)) | A party, the project for the hosted app, or a managed vendor | Yes: the data channel is unchanged |
| **TURN over TCP on 443, no TLS** | STUN and TURN in the clear | As above | As above | Yes; strictly worse under any inspection, and `turn:` with `transport=tcp` is already expressible ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn)) |
| **TURN through an explicit proxy** (`CONNECT`) | An HTTP `CONNECT` to the relay's name, then TLS; an enforcing proxy inside the tunnel sees TURN as above | As above | As above | Browsers: only under `disable_non_proxied_udp`, where Chrome moves WebRTC onto the proxy ([turn-provisioning-governance.md](turn-provisioning-governance.md#outbound-tls-on-443-to-a-partners-relay-against-outbound-sftp)); the CLI's TURN client through a proxy is unmeasured |
| **The exchange's frames through the signaling broker** | A WebSocket on 443 (today 8443): HTTP upgrade, then text frames | Every frame's bytes, in JSON text | The project (hosted app) or a party | No: see below |
| **A WebSocket relay of its own on 443** | A WebSocket: a TLS session carrying an HTTP `GET` with `Upgrade: websocket`, then binary frames; an enforcing proxy reads a valid HTTP request and WebSocket frames, which is what the network exists to carry; an explicit proxy tunnels it as browsers do for every WebSocket | Addresses, timing, volume, the pairing of two parties, the handshake frames in the clear, and every later frame as the wrap's AEAD envelope | The project for the hosted app; a party from a reference deployment; no managed vendor offers it | Yes, with the framing and bounds the two implementations already share, and with the wrap |
| **Not candidates** | WebTransport and anything over QUIC are UDP, which the measured classes block outright; ICE-TCP host candidates need a reachable address on one side, which a party behind the inspecting network does not have | | | |

Unverified, and what would verify it: that an enforcing proxy passes a WebSocket and refuses TURN over TLS is reasoning from what each protocol puts after the TLS handshake, not a measurement.
The spike that settles it is [S1](#the-spikes), on the AWS harness the relay measurement built, with a proxy configured to enforce HTTP inside TLS; the harness's class-B proxy did not enforce.
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
- The relay verifies the proof against the per-exchange keys it holds -- the same SQLite table coturn reads, written by the same registrar ([infra/relay/README.md](../../infra/relay/README.md#per-exchange-keys)) -- and pairs the two sockets that verified under one key with opposite roles.
  A second socket with a role already held under that key is refused, which is the broker's `ID-TAKEN` for this path.
- A run with no shared secret cannot mint the proof and refuses the relay before dialing, as it refuses a `turn` entry with no static credential today ([CLI.md](../CLI.md#turn)).

**What crosses it.** Binary WebSocket messages, each one chunk envelope of the framing the CLI already writes and both implementations already read: BinaryPack frames split at the chunk size, with the close sentinel behind the last frame ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#framing)).
Keeping the envelope means the receiver is the bounded reassembler the CLI has, moved to core so the browser transport imports it too, with the same wire-byte, chunk-count and concurrent-reassembly caps and the same shared refusal fixtures.
The relay forwards each message unread, applying a per-message size cap a little above the largest chunk envelope and refusing anything larger, so it buffers one chunk a socket and never a frame.

**Backpressure, not termination.** When the destination socket's send buffer is above a bound, the relay stops reading from the source socket and resumes below a lower bound, the window the CLI's own send path uses (1 MiB and 256 KiB; [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#outbound-pacing)).
Whether `ws` applies that pause end to end -- its stream wrapper, or `pause()` on the underlying socket -- is unverified here and is the first thing [S3](#the-spikes) measures.

**Delivery.** The transport is a delivering close in the terms of [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown): a WebSocket send buffers locally, so the close must wait.
Each side sends the sentinel and waits for the peer's close to reach it through the relay, bounded by the close drain budget; the relay forwards a close frame only after every message queued ahead of it, and closes the other socket when one closes.
That is the browser's WebRTC reading of the peer's close applied to a relayed socket, and the CLI's acknowledgement drain has no counterpart here: TCP acknowledges to the relay, not to the peer, so the peer's close is the one signal either side has.
A sender whose process or tab ends the instant its close returns can still lose the final frame in flight to the relay, as it can on WebRTC; [S5](#the-spikes) measures the window.

**Keepalive.** A PSI step can hold a party silent for the parked-receive budget of an hour ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#budgets)), and any TLS front in the path has an idle timeout -- the broker's is 300 s.
Both clients send a WebSocket ping on a short interval while a receive is parked; the relay answers and forwards nothing.

**Quotas.** The relay bounds what one key and one address can use, as coturn's `user-quota`, `total-quota` and `max-bps` do ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#quotas-against-one-exchange)): one pairing a key, a cap on concurrent pairings, a per-pairing byte rate at the same 2,000,000 bytes a second each direction, and an idle bound at the parked-receive budget.
Each is a working value reviewed against the largest exchange, as the relay's are.

**How the parties choose it.**
Two steps, the second designed with the first so the first does not foreclose it:

1. **Explicit.** The inviter's relay locator in the invitation gains the relay's `wss` url beside its TURN and STUN urls ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)); the browser's Relay settings page and the CLI's connection block each gain the same entry for a party's own relay, selected per kind as `selectRunRelay` selects TURN and STUN (`packages/core/src/relayCredential.ts`).
   A per-party transport policy, the shape of `ice_transport_policy` ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionice_transport_policy)), names the relay as the only path: a party whose network is known to stop TURN sets it once, and the invitation tells the partner where the relay is.
   Both parties must take the relay path for the pairing to form; a mismatch fails at the rendezvous budget with a message naming the policy, as a relay-only ICE run that gathers nothing does ([CLI.md](../CLI.md#when-a-webrtc-exchange-does-not-connect)).
2. **Automatic fallback.** Each party opens its relay socket as it starts the WebRTC rendezvous and sends its hello; the relay pairs the two sockets and forwards nothing until both have sent a start frame.
   A party sends start when its data channel fails to open within the channel-open budget, or at once under the relay-only policy; a party that receives the partner's start abandons its WebRTC attempt and sends its own.
   A data channel that opens closes both relay sockets.
   The relay then learns of every exchange that names it, whether or not it carries one, which is what a TURN allocation already discloses ([COMMUNICATION.md](../COMMUNICATION.md#stunturn), "What a relay's operator learns"), and a party behind a network that blocks the broker outright still reaches its partner.

Step 1 is the smaller change and gives a party that has no path today a working one.
Step 2 is the better experience -- nothing to set, no second wait -- and about twice the protocol work; it is the recommended end state, and the hello frame carries a start message from the first cut so step 2 adds behaviour rather than a new wire.

**The wrap.** On the relay path both implementations pass `requestEncryption = true` to `authenticateConnection`, and the web side applies `EncryptedMessageConnection` when the negotiated decision is true instead of refusing.
The WebRTC path is unchanged: the web still passes `false` there and still refuses a partner that requests it, so the refusal in `authenticateExchange.ts` becomes a property of the connection shape rather than of the application.
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
The broker is on 8443 because coturn holds 443, and the relay needs 443 for the same reason the broker does.
The cleanest fix is a second public address on the relay instance: coturn already binds one address (`listening-ip` in `infra/relay/turnserver.conf.tmpl`), so the nginx front serves the broker and the relay on 443 at the second address under their own names.
At the rate the relay measurement computed, a public address is about $0.005 an hour, about $3.60 a month, with no rate here confirmed against a bill ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-2-what-exchange-provisioned-means)).
Routing both names on one address by SNI without terminating coturn's TLS is possible in principle and unverified; it would put a proxy between coturn and the client's address, which TURN reports back to the client, so the second address is recommended and SNI routing is not.
The fix serves the WebRTC path too: today a 443-only network cannot reach signaling at all ([infra/broker/README.md](../../infra/broker/README.md#port-8443-and-the-limit-it-sets)), so [S2](#the-spikes) comes before any relay work.

### How the relay fits the existing bounds

| Bound | On WebRTC | On the relay path |
| --- | --- | --- |
| Frame ceiling | `MAX_WEBRTC_FRAME_BYTES`, 268,435,456 bytes, reassembled from chunks | The same constant, the same reassembler; the relay never holds a frame |
| Chunk size | 16,300 bytes, PeerJS's threshold under the SCTP ceiling | Reused as is in the first cut; a WebSocket has no 64 KiB ceiling, so a larger chunk on this path alone is a tuning left to [S3](#the-spikes), and the relay's per-message cap follows it |
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
| Code | First-party: the pairing and the proof exist nowhere else | An off-the-shelf raw relay with a reference configuration, if the spike finds one that backpressures and maps closes ([browser-sftp-proxy.md](browser-sftp-proxy.md#framing)) |

What each sharing choice costs:

- **One service with two modes.**
  Security: the service gains a mode that opens a TCP connection to a configured target, so the fixed-target refusal becomes a rule inside a process the hosted deployment exposes to every browser; a configuration error, or a request-parsing defect, turns the hosted relay into a TCP proxy into the host's own network, the case coturn's `denied-peer-ip` list exists to stop ([infra/relay/turnserver.conf.tmpl](../../infra/relay/turnserver.conf.tmpl)).
  Operations: one unit to run, but the project would then operate an SFTP proxy mode it has no target for, and a party running the SFTP mode would carry the pairing mode it does not use.
  Code: the shared part is the upgrade bounds the broker already exports and a forwarding loop; the modes share little else.
- **Two services, one shared library.**
  Security: the relay has no code path that dials TCP at all, so "the browser cannot choose a target" is true by absence rather than by refusal, and the proxy's fixed target is a property of a configuration file at the operator's edge.
  Operations: each operator runs the one they need.
  Code: the relay is first-party; the proxy is a reference configuration of an existing tool, if the spike qualifies one, and first-party only if none qualifies -- in which case it shares the upgrade bounds and nothing more.

**Recommendation: two.**
The relay has no mode that opens an outbound connection, and the SFTP proxy stays an operator-run fixed-target forwarder with no pairing in it.
The one piece written once is the pre-upgrade hardening, which already lives in the broker package for the web servers to import.

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
   A per-exchange proof under the relay key would be the stronger option, but an off-the-shelf proxy cannot check it, and building a first-party proxy to carry it is the cost Question 2 declined; it stays open for a deployment that wants it.
6. **Where the proxy setting lives: changed.**
   The earlier note put it in a browser-local setting and kept proxies out of invitations.
   Under the ruling the partner who runs the SFTP server also runs the proxy, so the invitation's SFTP endpoint should name it -- host and path, no scheme, the browser taking `wss` from its page -- as the WebRTC endpoint names the signaling host today under the same delimiter rules ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#broker-socket)).
   The browser then dials a `wss` host the partner chose, which is what it does for signaling, and the far end is still authenticated by the pinned host key, so a wrong proxy is a host-key mismatch and not a disclosure.
   The browser-local setting stays as the override for a party whose own organization runs the proxy.
   The bound the earlier note stated is kept in its stronger form: the browser dials the proxy and the proxy dials its fixed target, so nothing in the invitation chooses where a TCP connection opens.
7. **The browser SSH client: none until a spike, unchanged**, and second in the sequence after the relay work rather than first.
   The spike adds one requirement: the client must take an external signer, for fork 8.
8. **Credentials for recurring browser exchanges: changed, to a key the browser never holds in the clear.**
   The earlier note left stored-versus-entered open.
   The better answer for a scheduled run is a key pair generated in the browser as a non-extractable WebCrypto key (ECDSA P-256, which SSH takes as `ecdsa-sha2-nistp256`): the public key goes to the SFTP server's operator at onboarding, the private key never leaves the browser's key store, and the at-rest threat model gains an unexportable signing key rather than a password ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).
   A one-off exchange enters a password or key for the run and stores nothing.
   Whether a browser SSH client can delegate the signature to WebCrypto is unverified, and is what the client spike tests.

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
- **S2. Signaling and relay names on 443.**
  A second public address on the relay instance, the broker front moved to 443 on it, coturn unchanged.
  PASS: the registrar-path row repeated with TCP admitted only to 443 of the broker and relay names -- a browser with UDP refused completes a relayed exchange with a CLI party -- and the broker README's limit is deleted.
- **S3. Relay forwarding under load.**
  A prototype relay with pause-and-resume forwarding; two Node parties, then Chromium against Node, sending frames up to 268,435,456 bytes in chunks, with one receiver throttled.
  PASS: a round of the largest measured exchange's size, 539,000,000 bytes one way, completes; the relay's resident set stays under 100 MB throughout with the slow reader; a sender above the per-pairing rate is paced and not disconnected.
  The chunk size question is answered here by measuring 16,300 against a larger chunk on the same run.
- **S4. The wrap in the browser.**
  `EncryptedMessageConnection` over a browser WebSocket transport, the web side requesting the wrap, a CLI partner.
  PASS: the exchange completes with the correct intersection, and a capture at the relay shows only the handshake frames outside the AEAD envelope, every later frame beginning with the envelope's version byte.
- **S5. Close delivery through the relay.**
  The sender's tab or process ended the instant its close resolves, as the WebRTC measurement did ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#the-clean-close)).
  PASS: the peer receives the final frame in every one of ten runs, and the sender's close resolved only on the relayed peer close.
- **S6. Silence through a front.**
  A relayed exchange whose PSI step is silent for longer than the front's idle timeout, with the clients' pings on.
  PASS: the socket survives the silence and the parked-receive budget is what bounds it.
- **S7. The raw SFTP relay.**
  From the earlier note: a candidate proxy in front of the SFTP test server, backpressure, close mapping and the `Origin` refusal ([browser-sftp-proxy.md](browser-sftp-proxy.md#framing)), run only after the relay work above.
- **S8. The browser SSH client with an external signer.**
  A candidate client through the raw relay from the browser suite, authenticating with a non-extractable WebCrypto P-256 key.
  PASS: the client authenticates, exposes the host-key blob before authentication, and completes a file write and read; the key never leaves WebCrypto.

### Implementation items implied, not filed

Relay path, in order:

- **Second address and 443 for the broker front** -- `infra/broker` and `infra/relay/aws`, and the limit in the broker README.
- **Move the CLI's framing and bounded reassembler to core** -- `peerjsWire.ts` and `inboundBounds.ts` become core modules both WebSocket transports import; the CLI's WebRTC transport imports them from there.
- **Relay proof derivation and spec row** -- the derived key and its label in core, with vectors, beside the registrar proof in PROTOCOL.md.
- **The relay service** -- a workspace beside the broker's: hello, proof check against the shared table, pairing by role, pause-and-resume forwarding, per-message cap, quotas, pings, close ordering, the broker's upgrade bounds.
- **Relay deployment reference** -- a unit beside coturn in `infra/relay`, nginx front on 443, journald retention, a `verify.sh` probe that pairs two sockets and forwards one frame.
- **Browser WebSocket transport** -- a `MessageConnection` over a browser WebSocket with the shared reassembler and the pacing window.
- **CLI WebSocket transport** -- the same over `ws`, with the connection-block entry and the transport policy.
- **The wrap on the web side** -- request it on the relay transport, apply the decorator when negotiated, keep the WebRTC refusal.
- **Relay locator and settings** -- the `wss` url on the invitation locator, the Relay settings page, and the CLI's connection block, selected per kind.
- **Automatic fallback** -- the start frame, the parked relay socket during the WebRTC rendezvous, and the hand-over.
- **Disclosure documents** -- PRIVACY and SHARED_RESPONSIBILITY rows, the SECURITY_DESIGN channel-security paragraph, the wrap table row and its "no such transport exists" sentence in CHANNEL_SECURITY, COMMUNICATION's supporting services, DEPLOYMENT, CLI.md, the planned `connect-src` allowlist ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)).
- **Tests** -- relay unit tests with the shared refusal fixtures, a relayed exchange in the browser suite, a CLI-to-browser relayed run in the interop suite ([TESTING.md](../TESTING.md#cross-runtime-interop-suite)), and a stress-tier run at the largest size.

Browser SFTP path, after the relay path, re-scoped from the earlier note's list:

- **Raw relay reference configuration**, operator-run, with the `Origin` check, in the DEPLOYMENT section that names the proxy.
- **Browser SSH client** with an external WebCrypto signer, as a new security-relevant dependency under the dependency policy.
- **Browser file transport client** implementing `FileTransportClient` (`packages/core/src/connection/fileSyncConnection.ts`) with browser counterparts of the CLI adapter's liveness, listing and frame-size bounds.
- **Host-key pin and first use** in the browser, with reconciliation as on the CLI.
- **Proxy on the SFTP invitation endpoint**, with the browser-local override and the delimiter refusals.
- **In-browser key pair for scheduled SFTP runs**, with the at-rest threat model extended.
- **Exchange driver for browser SFTP** in `exchangeDriverSelection.ts`, on the hosted profile only.
- **Documentation and tests** as the earlier note lists them, with the `CLAUDE.md` Applications scope of the public application updated for both paths.

## Forks left open

Each with its options, the trade, and a recommendation; the linked section carries the argument.

1. **How the hosted relay admits an exchange**: a registered per-exchange key, as the TURN relay today, or possession of a pairing secret with quotas and no registration, as the broker.
   Registration serves saved exchanges and CLI parties and leaves a one-shot browser exchange without a relay; possession serves every exchange and makes the hosted relay a quota-bounded public service, which runs against the standing direction that a relay is never public ([turn-provisioning-governance.md](turn-provisioning-governance.md#what-this-record-assumes)).
   Recommendation: registration, for consistency with the TURN relay, with possession presented to the maintainer as the alternative since the hosted application's one-shot exchanges are where the direction bites ([The WebSocket relay, as recommended](#the-websocket-relay-as-recommended)).
2. **Explicit relay path first, or automatic fallback first**: the explicit policy is smaller and verifiable alone; the fallback is the experience a party wants.
   Recommendation: explicit first with the start frame in the wire from the first cut, fallback as the next item ([How the parties choose it](#the-websocket-relay-as-recommended)).
3. **Chunk size on the relay path**: PeerJS's 16,300 bytes, or a larger chunk since no SCTP ceiling applies.
   Larger means fewer messages and less relay overhead; the same size means one framing and one set of fixtures.
   Recommendation: the same size until S3 shows the overhead matters ([How the relay fits the existing bounds](#how-the-relay-fits-the-existing-bounds)).
4. **Where the relay's reference deployment lives**: beside coturn in `infra/relay`, under the one registrar and table, or a directory of its own as the broker has.
   Beside coturn shares the key table by construction; apart keeps each reference small.
   Recommendation: beside coturn, since the table is the authentication ([Who runs it, and what it costs](#who-runs-it-and-what-it-costs)).
5. **A per-exchange proof for the SFTP proxy**: `Origin` only with an off-the-shelf relay, or a first-party proxy that checks a proof under the relay key.
   Recommendation: `Origin` only, with the proof as a later option for a deployment that asks ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 5).
6. **The proxy on the invitation**: the SFTP endpoint names the proxy, or the browser-local setting alone.
   Recommendation: the endpoint names it, with the browser-local override ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 6).
7. **Scheduled SFTP credentials in the browser**: a non-extractable WebCrypto key pair, a stored password or key, or entry at each run.
   Recommendation: the key pair, conditional on S8 ([Question 3](#question-3-the-browser-sftp-forks-under-the-ruling), fork 8).
