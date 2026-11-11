---
title: "Alcove Communication"
---

# Alcove communication

This document covers the communication channels available for Alcove exchanges, how parties synchronize protocol steps, how the web invitation and acceptance flows disclose terms and gate consent, how errors are handled, and what supporting services are required. Authentication and channel security are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), the PSI protocol in [PROTOCOL.md](spec/PROTOCOL.md), and CLI configuration in [CLI.md](CLI.md). Intended readers are IT staff and developers.

## Channels

Three communication channels are supported:

* Peer-to-peer using WebRTC - a protocol primarily used by browsers to communicate with each other, for example in video calls. Behind corporate firewalls and Network Address Translation (NAT), a connection usually needs a supporting server to help establish it or to relay its traffic (see [STUN/TURN](#stunturn)).
* SFTP - an SFTP server one partner already runs is used as a message-passing channel, through polling and a synchronization protocol, with a short delay for each message. The number of messages does not depend on the size of the datasets, so the delay is a fixed cost.
* Shared-folder - a directory both parties can access, for example an NFS or SMB network share provisioned by IT, or a folder backed by an SFTP server and mounted locally. The same file-based polling and synchronization protocol used for SFTP is applied directly to the mounted path. No supporting service is required beyond read/write access to the shared folder. One party can use a shared folder synchronized to a directory served by an SFTP server to which the other party connects.

The configuration block each channel takes, one runnable example apiece, is in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connection-blocks-by-channel).

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle rare race conditions.

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either inviter or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The inviter and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](EXCHANGE_REFERENCE.md#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private coordination server, directory listings can be used.

## Web invitation

On the web, the inviting party composes an invitation from its own data file. The browser reads the file locally and derives the invitation's linkage terms from the file's columns: the default terms, narrowed to the keys those columns can satisfy. The acceptor reviews and consents to those derived terms, and the inviter's own half of the exchange runs on the same terms and the same parsed rows.

### Quick path

The inviter chooses a CSV and enters its name, then follows a short required sequence -- choose the file, confirm what it discloses, review and create -- with the default terms filled in from the file.

- Composing fails closed before any setup secret is created: a file that cannot be read, or that cannot satisfy every linkage key the terms would declare, produces no invitation. This is the rule the run itself enforces.
- Once the invitation is created, the share step shows the invitation as a link to send out of band, its expiry, and the proposed terms summary, and waits for the acceptor to connect. The bare code is offered as well only when the partner will accept through the command-line tool, whose accept takes the code alone; a browser partner pastes the whole link into the accept form.
- The interface previews only the leading and trailing characters of a copy-only value; the full value goes to the clipboard and is shown behind an explicit reveal. On connect the share block gives way to the run status.

Once a file is chosen, the sequence also shows which columns will be sent to the partner for matched rows, adjustable before creating. This informs and does not gate: the displayed set is derived from the same predicate the exchange transmits on, and when no column would be sent it says so. Those columns are also declared in the invitation's payload data dictionary, so the partner's consent screen lists them as columns it will receive.

The names shown are the inviter's own file's headers. Each is shown inside a bidi isolate rather than escaped, as on the acceptor's [Confirm your columns](spec/WEB_ACCEPTANCE.md#confirm-your-columns) step. Text-direction control characters are removed from headers when the file is read, and a notice beside the file names the column positions that changed (see [CSV header sanitation](spec/PARSED_INPUT_BOUNDS.md#csv-header-sanitation-at-ingestion)). A name that reaches a screen through the invitation summary, such as the consent preview of the send this invitation declares, is escaped, as everything from that summary is.

### Customizing the terms

Every part of the default terms is adjustable in place; there is no separate advanced screen. Customization starts from the file's derived values, so it needs the CSV first, and previews the terms with the same component the acceptor's consent screen uses. Validation runs through the linkage-terms schema the exchange enforces; creating is blocked until the terms are valid, every enabled key is satisfiable by the inviter's columns, and no key declares cleaning that drops every record. The inviter can set:

- its name, on the file step, and the invitation duration, on the review-and-create step;
- what the exchange produces -- the matching method, then who receives the matched results: both parties, only the inviter, or only the partner ("neither receives" is not offered) -- at the top of the confirm-disclosure step, grouped as the consent review groups them, ahead of the column choices both constrain;
- a column metadata grid mapping each column to a semantic type and one disclosure choice (used to match, unique record identifier, sent to your partner, or ignored), on the confirm-disclosure step;
- which linkage keys are active and in what order, with a per-key indicator of whether the inviter's columns satisfy it, plus the linkage strategy, in the Matching keys tab. Choosing `single-pass` over the default `cascade` shows its disclosure tradeoff (fewer round trips over a high-latency channel in exchange for disclosing more) and writes terms stating that choice, which both parties must agree on or the exchange aborts. The disclosure mechanics are in [PROTOCOL.md](spec/PROTOCOL.md);
- an optional legal agreement -- a reference, with a purpose and an expiration date where the agreement states them -- shown to the partner before they accept, in an Agreement tab.

Per-field data cleaning is set in a Cleaning tab: the inviter authors each field's cleaning steps, raw regular-expression steps included (each marked "advanced"), and chooses which column feeds it. A whole-file coverage warning is shown, and a malformed step blocks creation, as in the acceptor's cleaning editor (see [Confirm your columns](spec/WEB_ACCEPTANCE.md#confirm-your-columns)).

The matching algorithm is selectable, `psi` or count-only `psi-c`; a count-only draft that deduplicates, sends columns, or splits a value in the inviter's own cleaning blocks generation and names what to change, and the count-only choice carries a caveat stating that the party computing the count can learn more than the count. A count-only draft with a key matching several values per record adds a line stating what that key lets the party computing the count learn. Deduplication is selectable and declares the inviting party's own side alone; generation is blocked only under the linkage strategy that cannot match it. Fuzzy comparison is chosen per element in an expert key (below).

### Expert authoring and import/export

Expert mode adds building linkage keys element by element (each element's field chosen from the declared columns, with a typed-parameter transform pipeline and a two-of-N "match in either order" swap), adding a second field of one semantic type bound to a different column (for example a maiden and a current name), and a JSON/YAML import/export of the whole terms document, validated the same way.

Import refuses a document whose keys use a custom per-field constraint. The rest of an imported declaration is re-emitted as declared, including field order, unreferenced fields, and an empty constraints object. An imported key that references a field the inviter's columns cannot supply loads disabled but visible, so the remaining keys still generate.

### Per-party disclosure

Column disclosure and cleaning are per-party and local: they are threaded into the inviter's own half of the exchange, never embedded in the invitation, so they change only what the inviter discloses and its own match rate, not the agreed terms the acceptor consents to. See [SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality) for how the derived terms disclose column shape (never row values) to the recipient.

## Web acceptance and consent

The acceptor opens the invitation link, or pastes the link or the invitation text into the start page, and reviews the proposed terms before anything is set up. The token is in the URL fragment, which never reaches the server, and an expired or invalid token is refused with no way to consent. No connection, key exchange or PSI step starts before consent.

- **Review.** The terms open on an always-visible summary of what the acceptor discloses, what the exchange produces, what it receives, and how records are matched, followed by any legal agreement. Detail sits behind two collapsed disclosures, and text the partner chose is escaped.
- **Consent.** A checkbox and the acceptor's name are required before its file is read. The inviter's name is marked unverified, because it is free text.
- **Columns.** The acceptor sets what each column of its own file is used for with the same grid the inviter uses. The exchange is refused unless the file satisfies every agreed linkage key, no column starts out sent, and a difference from what the inviting party asked to receive is shown as a notice.
- **Running.** The exchange runs the inviter's terms with the acceptor's identity and output direction mirrored. Each party chooses its own deduplication, and a party that is to receive no result is sent neither the matched table nor the partner's columns. A long matching step shows its name, how many values it covers and how long it has been running.

The screens, their order, and each rule above are specified in [WEB_ACCEPTANCE.md](spec/WEB_ACCEPTANCE.md).

## Message delivery and teardown

Each channel passes messages through a common transport contract. A completed send does not mean the peer has received the message; there is no end-to-end delivery acknowledgement at this layer. Every channel must guarantee that the final frame of an exchange survives a clean connection close, in one of two ways.

**A durable send with a draining close.** The file-based channels, SFTP and shared folder, work this way. A send writes the message as a file in the shared folder and does not resolve until that write and its atomic rename into place are durable. Because the sender's close also deletes the files it is responsible for, the close first waits for the peer to consume the last sent file, then cleans up. The drain and its bound are specified in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-3----cleanup-and-close).

**A delivering close.** WebRTC works this way. A send hands the message to the data channel and returns before it is on the wire, so the final frame is protected by the close: a clean close must not tear the connection down until what was handed to the channel has reached the peer. A close caused by an error discards buffered outbound writes. The ordered channel delivers everything already sent ahead of the in-band close signal, but the signal can be queued while the final frame is still in the sender's outbound buffer. Both WebRTC implementations therefore wait for evidence the peer has the frame before the close resolves:

- the browser waits for the peer's own close of the data channel, which the peer performs on reading the close signal behind every frame;
- a CLI process waits for the peer to acknowledge the data, then closes the data channel and waits for that close to complete before tearing down;
- neither waits on the channel's buffered-byte counter reaching zero, which is not a delivery signal ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-clean-close)).

On a [WebSocket relay](#websocket-relay) that evidence is the partner's close as the relay passes it on, and the relay can send one itself. There a close that reports the final frame delivered is the relay's word, not the partner's: a partner that did not get the frame fails at its own inactivity bound ([WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md#close)).

A clean WebRTC close must not be replaced by an abrupt teardown that bypasses it, and a file-based close must not skip the drain.

Any new channel added to the project must provide one of these two: a durable send with a draining close, or a clean close that delivers. A transport that does neither silently drops the final frame of an exchange. The same rule is recorded for implementors in the `Connection` and `TransportHooks` interface documentation in the core library.

Inbound, a frame that has already arrived and been buffered is handed to a waiting `receive()` before any terminal error is reported, whether the connection ended in a clean half-close or an abnormal drop. An errored close discards pending outbound writes, never a received frame in the inbound queue. This is behavior of the shared message queue above every channel, recorded in the `TransportControls` interface documentation.

Each transport wires its own terminal events to the queue's controls. WebRTC is the only close-capable channel, in both implementations (`apps/web/src/psi/transport/peerMessageConnection.ts` and `apps/cli/src/connection/webrtc/webrtcMessageConnection.ts`): it maps the peer's clean close to `finish()` (the clean half-close, which drains a queued final frame before the close is reported) and an error to `fail()` (the abnormal drop). The file-based channels report only `fail()`. Teardown stays driven through the queue's `finish()`/`fail()` controls, not a shared `Connection.close` event: a broadcast event reaches only a listener already attached, so a close with no listener would drop a frame.

## Error handling

In the case of communication channel errors, messages that fail to transmit are retried. The initial connection is retried on a transient failure up to a user-specified limit; a connection attempt that times out is terminal and is not retried. On the SFTP channel a session drop mid-exchange is re-dialed and the interrupted operation re-issued, including a drop by a server that leaves the connection half-open, so the exchange survives a server that drops the held session. The reconnect budget, its cumulative application over the exchange, and the mode exempt from it are in [`max_reconnect_attempts`](EXCHANGE_REFERENCE.md#connectionoptions). An unrecoverable drop still ends the exchange with a terminal error. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

Terminal failures are tagged with a `ConnectionErrorKind` (the kinds and their meanings are documented on that type in the core library) so a consumer can branch on the cause. An intentional local close is reported as `"closed"` (nothing went wrong on this side), while a clean remote close, a dropped link, and a peer timeout are all reported as `"transport"` (the link ended; a retry is reasonable). A partner that deviates from the protocol is reported as `"protocol"` -- a message that fails to validate, a value outside the range the agreed terms fix, or a payload disclosure other than the one consented to -- which is terminal. The rationale for that taxonomy is in [the `ConnectionErrorKind` taxonomy note](notes/connection-error-kind-taxonomy.md).

## Supporting services

The communication channels described above each depend on supporting infrastructure. Each such service is operated by a party, by a third party the parties choose, or -- for peer coordination, the relays, and the relay registrar, run for the hosted web application -- by the project. There is no project-run instance of any other supporting service, so a service a party does not operate is one it selected and answers for ([SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md#third-party-supporting-services)). Deployment guidance is in [DEPLOYMENT.md](DEPLOYMENT.md).

A service reached at a static address needs nothing beyond the address in each party's connection block. For a service brought up per exchange instead, the configuration schema has two provisioning shapes:

- **`server.provision`** brings the primary server up ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#on-demand-server-provisioning)). In `start` mode the server has a fixed address and is started on demand: `alcove exchange` calls the endpoint once before its first connection to the server and stops the run if the call fails, and a run started from a URL or an invitation states it with `--server-provision` and calls it the same way. In `create` mode a fresh server is allocated per invitation: an offline `alcove invite` calls the endpoint once, and the invitation names the server it returns.
- **`ice_provision`** is called by no connect path: a config with one connects straight to its static fields, so that service has to be running before the exchange starts.

Which application ignores which key, and which refuses it outright, is stated per field in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#where-each-setting-is-edited); provision an ICE service out-of-band.

### STUN/TURN

For parties behind NAT or corporate firewalls, the Interactive Connectivity Establishment (ICE) protocol establishes the peer-to-peer WebRTC connection. STUN servers help each party discover its public address; TURN servers relay traffic when no direct path can be found.

The two applications differ in where each takes its servers from:

- **The CLI** builds its peer connection from the connection block's `stun` and `turn` entries, followed by the relay an accepted invitation names, at whose registrar it enrolls when the invitation names one. A configured `stun` list replaces the CLI's default STUN server rather than adding to it ([CLI.md](CLI.md#stun-and-what-it-discloses)); what is verified for a relayed exchange is in [CLI.md](CLI.md#turn), and the url grammar and credentials in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionturn). The console runs the CLI, so the relay set beside its coordination server reaches the run of each invitation it creates as `turn` entries, and its WebSocket relay as `websocket_relay` ([CONSOLE.md](CONSOLE.md#running-a-webrtc-exchange)).
- **The browser client** of the hosted application ignores those entries. It uses the servers in the exchange's own Connection settings, those the accepted invitation names, and a build's default relay ([WEB_APP.md](WEB_APP.md#connection-settings); [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#connection-settings); [DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)). Each run derives its TURN credential from the exchange's shared secret, valid for one hour ([RELAY_CREDENTIALS.md](spec/RELAY_CREDENTIALS.md#relay-credential-derivation)), so no relay password is stored in the browser. A saved exchange enrolled at the relay's registrar registers the key of each rotated secret there itself ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#when-your-relay-runs-a-registrar)); one that is not enrolled needs its key registered with the relay again after each run that completes its handshake, including a run that then fails. A browser that reaches none of the STUN servers it lists learns no public address of its own, which Google's server might have given it.
- **Which relays a run may use** is set by the CLI's `allowed_relays` and the browser's Allowed relays ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionallowed_relays); [WEB_APP.md](WEB_APP.md#allowed-relays)). Each is the party's own setting: the partner may still connect through a relay it leaves out.
- **The `ice_provision` shape** is called by neither application: the browser ignores it and the CLI refuses a connection that sets it.

What a STUN server's or relay's operator can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

### WebSocket relay

A [WebSocket relay](DESIGN.md#websocket-relay) carries a WebRTC exchange for two parties whose network stops TURN but passes a WebSocket on 443: each party opens one `wss://` connection to it, and it pairs the two connections of one exchange and forwards their messages. Its wire is in [WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md), and the reference deployment beside the TURN relay in [infra/relay/README.md](../infra/relay/README.md#the-websocket-relay).

- **Where a run takes it from.** The CLI takes it from `connection.websocket_relay` and from the invitation it accepted ([A WebSocket relay of your own](CLI.md#a-websocket-relay-of-your-own)); the browser from the exchange's Connection settings, the invitation it accepted, and a build's default relay ([DEPLOYMENT.md](DEPLOYMENT.md#the-default-relay)). An invitation names the one its inviter uses, and Allowed relays leave out any one they do not name.
- **When a run uses it.** A run connects to each WebSocket relay it lists as it starts waiting for its partner, and moves the exchange onto one only when no WebRTC path opens or the relay reports that the partner has already moved there ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)). Nothing checks that report, so a relay can move an exchange onto itself ([WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md#pairing-and-the-start)).
- **What admits a party.** A proof made from the exchange's shared secret, checked against the relay key the relay's registrar or its owner enrolled for the exchange, as for the TURN relay ([RELAY_CREDENTIALS.md](spec/RELAY_CREDENTIALS.md#the-websocket-relay-proof)).

The relay forwards the exchange's messages and stores none of them. All of them cross under the application-layer encryption both applications apply, except the key-exchange messages that set it up, which hold no exchange data. What its operator can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

### WebSocket-to-TCP proxy

The SFTP relay (`packages/sftp-relay`) is a WebSocket-to-TCP proxy an SFTP server's operator runs in front of that server ([DEPLOYMENT.md](DEPLOYMENT.md#websocket-to-tcp-proxy)). No client uses it yet, and no connection setting names one: the browser conducts WebRTC exchanges only, and a CLI party, including one the console runs, opens its SFTP socket itself.

### Coordination server

Establishing a WebRTC connection requires a signaling step in which both parties exchange session descriptions and ICE candidates. Alcove uses the PeerJS protocol for it: each party registers with a PeerJS-compatible server under a token-derived peer ID and then locates its partner under the complementary ID. The same protocol also frames the chunked data transfer over the established connection, so signaling and data transport are not independently separable.

Two implementations speak it, and either can be on either end of an exchange. The web application runs the PeerJS client library in the browser. The CLI drives a Node WebRTC stack directly and speaks the same signaling and framing itself; the wire both must match is specified in [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md).

The coordination server sees the signaling it relays and no exchange content: both applications apply the application-layer encryption on every WebRTC exchange, keyed by the parties' authenticated key exchange, which the server cannot complete ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). Which server an exchange uses, and running one, are in [DEPLOYMENT.md](DEPLOYMENT.md#coordination-server).

### SFTP

An SFTP server can be operated as a drop zone for exchanges between parties who prefer file-based communication to WebRTC. Its address is fixed and it can be stopped between exchanges, and directory-level access controls on a shared server can isolate exchanges without dedicated instances. Server requirements are in [DEPLOYMENT.md](DEPLOYMENT.md#sftp-server).

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model and security properties of the channels described here
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - `connection` block reference for configuring the channels described here
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services described here
- [CLI.md](CLI.md) - CLI commands for configuring and running exchanges over these channels
