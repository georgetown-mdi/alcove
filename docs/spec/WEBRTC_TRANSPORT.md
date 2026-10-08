---
title: "WebRTC Transport"
---

# WebRTC transport

The `webrtc` channel's wire: how the two parties find each other through the
PeerJS broker, the signaling envelopes they exchange, the framing on the data
channel, and what a clean close has to do before it tears the channel down.

Two implementations speak this wire and must agree on every line of it: the web
app, which runs the PeerJS client in the browser (`apps/web/src/psi/`), and the
CLI, which drives werift's `RTCPeerConnection` directly and hand-writes both the
broker client and the framing (`apps/cli/src/connection/webrtc/`). None of it is
Alcove's own protocol to define -- it is PeerJS 1.5.5's, measured on the wire
and recorded here because a second implementation has to match it exactly. The
library choice and the alternatives weighed are in
[cli-webrtc-stack.md](../notes/cli-webrtc-stack.md); the internal assumptions that
pin the libraries are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

It does not cover the rendezvous peer-id derivation (see
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation), which is
normative for it), the inbound reassembly bound and the AEAD envelope (see
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)), the delivery contract every channel
owes (see [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)),
or the operator-facing configuration (see
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionserver) and
[CLI.md](../CLI.md#webrtc-exchanges)).

## Roles

The two parties take fixed, asymmetric roles, named by `connection.role`:

| `role` | Rendezvous | Handshake role |
| ------ | ---------- | -------------- |
| `acceptor` | Dials: creates the data channel, sends the `OFFER`, and offers again on an `EXPIRE` until answered | `initiator` |
| `inviter` | Listens: waits for an `OFFER`, answers it, and takes the channel the remote created | `responder` |

Each party registers with the broker under the id its own role derives and
addresses the id the other's derives, so neither has to be told the other's
address. Both parties must therefore hold different roles; two parties holding
the same one collide at the broker (below).

The handshake role is fixed by the rendezvous role rather than negotiated
separately: the parties already had to disagree about which end they are in
order to meet at all.

Both implementations resolve this table identically or a CLI party and a browser
party cannot complete a handshake with each other, so the pairing -- together
with the request-encryption flag each side sends, `false` on both (see
[Application-layer encryption](#application-layer-encryption)) -- is pinned by
the cross-application conformance vectors at
[`packages/core/test/vectors/webrtc-interop-vectors.json`](../../packages/core/test/vectors/webrtc-interop-vectors.json),
which each application's own suite asserts its own side against. See
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) for what the
file records.

## Broker socket

The client opens

```
<ws|wss>://<host>:<port><path>/peerjs?key=<key>&id=<id>&token=<token>&version=1.5.5
```

`version` is the PeerJS client version the broker validates against (1.5.5).
`token` is a fresh per-registration random value; it is what distinguishes a
genuine id collision (two parties, two tokens, answered with `ID-TAKEN`) from a
reconnect of the same client (same id and token, which the broker adopts
silently and answers with no `OPEN`).

The CLI resolves the omitted parts of `connection.server` to the same defaults a
PeerJS client applies, except `secure`, which a browser client takes from the
page it was served over and the CLI has no page for:

| Field | Default |
| ----- | ------- |
| `port` | 443 when `secure`, 80 otherwise |
| `path` | `/` |
| `key` | `peerjs` |
| `secure` | `true` |

Those defaults are one implementation's, not the wire's: a browser peer resolves
an absent `path` to the broker mount the web app dials by default (`/api/`)
rather than to `/`.
An invitation endpoint therefore holds the mount point resolved -- `alcove
invite` records the path it will itself dial, `/` included, even where the
`ws:`/`wss:` URL wrote none -- so a locator crossing between the two
applications leaves no field for the consumer to fill in the mount point from a
default the producer does not share.

The port, and with it the scheme, is not resolved the same way: the endpoint
includes `port` only when the connection names one, and an omitted port stays
omitted on the wire rather than being filled from the producer's own default.
The consumer resolves it from its own side instead -- a browser acceptor fills
an absent port from the page's own protocol, and PeerJS infers `secure` from
that same resolved scheme -- so an http-served page (local dev) resolves a
different socket than the CLI's own `wss://` default for a bare-host endpoint,
while a production `https` deployment agrees with it. This is a remaining
consumer-side default, not a gap this endpoint closes. Both mint directions are
pinned by the cross-application conformance vectors (see
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)).

The address is built through the URL API, with `path` assigned as a pathname
rather than concatenated, so the scheme's default port is left implicit in it.
`host` and `path` are refused for shape before anything is dialed, because both
are partner-supplied when the connection came from an invitation endpoint and
each can otherwise contain the delimiters that move a URL's authority:

| Field | Refused |
| ----- | ------- |
| `host` | any of `@ / ? # \` or whitespace, and any value that does not parse as a bare authority (one contributing userinfo, a port, or a path of its own) |
| `path` | a value not beginning with `/`, or containing any of `@ ? # \` or whitespace |

`key` takes no equivalent rule: an invitation endpoint is a strict
`host`/`port`/`path` allowlist and has none, and the value is encoded as a
query parameter rather than interpolated. The finished address is checked
against the configured host once more before the socket is constructed, so an
address naming another authority opens nothing.

The browser acceptor applies the same two delimiter rules -- one
implementation, shared from `@alcove/core` -- to the `host` and `path` of the
invitation endpoint it dials, and refuses before it constructs a peer. It needs
them for a different reason than the CLI: the PeerJS client assembles its
address by concatenating scheme, `host`, `:`, `port`, `path` and `peerjs?key=`,
so a delimiter in either field is read as part of the address rather than as a
value inside it. What each shape does to the assembled address is measured
against the real client in real Chromium
(`apps/web/test/browser/webrtcEndpointAuthority.test.ts`):

| Endpoint field | What the delimiter does to the dialed address |
| -------------- | --------------------------------------------- |
| `host` with `@` | the named host becomes userinfo, and the dial reaches the name after the `@` |
| `host` with whitespace | a tab or newline is deleted and a space percent-encoded, so the dial reaches a third name that is neither |
| `host` with `/ ? # \` | the dial keeps the named host, dropping the endpoint's own port and mount point |
| `path` with `@ ? # \` or whitespace | the dial keeps the named host; the rest of the address is reshaped |
| `path` without a leading `/` | the client inserts one, so the mount point is whatever follows |

Not one of those shapes fails closed on its own: every one assembles an address
the browser accepts, so the refusal is the whole of what stands between a
partner's delimiter and the socket. The browser has no equivalent of the CLI's
second check on the finished address either, since the client builds that
address and opens it internally with no point in between for the app to read it
back. What the acceptor relies on instead is that its dial path resolves the
endpoint through that refusal, which the same file measures by driving the dial
path with each shape and requiring that no peer is ever constructed.

Both rules are a denylist of delimiters rather than an allowlist of host
spellings, and a mapped separator passes: a `host` holding U+3002, U+FF61, or
U+FF0E -- the alternative label separators the URL parser folds onto `.` --
contains none of the refused characters, so the browser dials the mapped name.
That name is one the endpoint itself spells, since the partner chooses the
endpoint host outright, and the CLI's bare-authority check accepts the same
mapped host, so the two consumers agree on the server a locator names.

The server stamps `src` itself from the connecting client's id, so an outbound
frame contains only `type`, `payload`, and `dst`. Heartbeats (`HEARTBEAT`, no
payload) go up every 5 s.

The vendored broker holds frames addressed to a peer that has not registered.
It delivers every held frame at once if the peer registers within about 5 s of
the first being queued. Otherwise it drops them and sends each sender one
`EXPIRE` whose `src` is the absent peer, 5 to 6 s after that first frame. A
frame past one of its hold bounds -- among them eight absent destinations per
sender -- is not held and is answered with `EXPIRE` at once
([CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#web-signaling-surface-bounds), "Relay queue bounds").
It reports nothing about a frame it has handed to the peer's socket, so an
offer delivered to a partner whose socket then drops before it answers is lost
with no `EXPIRE`.

- The CLI acceptor sends its `OFFER` once, and sends it again, with the
  candidates already sent, when an `EXPIRE` arrives before it is answered, or
  once the unreported-offer re-send budget (table below) passes with neither
  an `EXPIRE` nor an answer, for an offer lost unreported. An `EXPIRE` sends
  the offer again no sooner than the minimum offer re-send interval (table
  below) after the last send: every `EXPIRE` arriving inside that interval is
  answered by one send, with its candidates, when the interval ends. It never
  repeats an offer the broker may still hold: PeerJS 1.5.5, given a second `OFFER` for a
  `connectionId` it already holds, closes that connection -- emitting no
  `close` while it is not yet open -- and builds a new one. A browser
  inviter's app has already taken the first, so the data channel would open on
  a connection the app never reads.
- An `EXPIRE` after the acceptor's offer is answered is ignored; the
  channel-open budget bounds a partner that left after answering.
- A CLI inviter takes no action on an `EXPIRE`. It sends only in reply to an
  `OFFER`, so an `EXPIRE` means the acceptor it answered has left the broker.
  When that acceptor returns it offers under a new `connectionId`, which the
  inviter meets in a new connection attempt (below).
- A browser acceptor dials again, after a delay, when PeerJS reports the
  `EXPIRE` as `peer-unavailable`, under a new `connectionId` each time.

Message types acted on: `OPEN`, `OFFER`, `ANSWER`, `CANDIDATE`, `LEAVE`,
`EXPIRE` (by the acceptor, as above), `ERROR`, `ID-TAKEN`, `INVALID-KEY`. Two
of them hold operator meaning: `ID-TAKEN` is the symmetric-role
misconfiguration (both parties set the same `role`), and an `ERROR` whose
payload names an invalid key is the wrong `server.key`.

### The browser party's own signaling address

A browser party resolves one address for the signaling server its own
deployment uses, and every place that needs it reads that one value: where an
inviter registers, on a fresh invitation and on a saved exchange's later
runs, and the endpoint its invitation names. It comes from the deployment's
build setting `VITE_SIGNALING_SERVER_URL`, never from an invitation:

| Setting | Address |
| ------- | ------- |
| unset or blank | the page's own host and port, path `/api/`, `wss` when the page is `https` |
| a `ws:` or `wss:` URL | that URL's host, port and path, the path ending in `/`, `wss` for `wss:` |

The setting is refused when the app loads if it is not a `ws:` or `wss:` URL,
or names a user name, password, query or fragment, or a host or path the
delimiter rules above refuse. It is also refused when the app loads if its
scheme does not match the page's: `wss:` under an `https` page, `ws:` under an
`http` page. `localhost` is resolved to `127.0.0.1` in either case.

An accepting party never dials its own deployment's address. A fresh accept
dials the endpoint its invitation names, from any deployment, and a saved
exchange's later runs dial the endpoint the acceptor's record stored from that
invitation, so two parties on different deployments keep reaching each other
on every run. Both dials put the endpoint through the same validation before
anything is dialled: the invitation endpoint schema, the host and path
delimiter rules above, a missing port taken as 443 under an `https` page and
80 otherwise, and a missing path taken as `/api/`; the scheme is the page's.
A stored endpoint that fails it refuses the run before any connection
([MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md#role-a-local-side-field-not-the-document)).

The endpoint an invitation names holds the address's `host` and `path`, and
names no scheme: an acceptor resolves the scheme from its own page, and an
omitted port from that scheme's default. With the setting unset, the endpoint
names the `port` only when the page's is not the scheme's default. With the
setting set, the endpoint always names the `port`, the scheme's default
included, so the port an acceptor dials never depends on its own page.

The console build (`VITE_DEPLOYMENT_PROFILE=console`) resolves no signaling
address, whatever the setting holds: its server serves no signaling and its
origin is loopback. It mints no webrtc invitation; a webrtc mint there is
refused before any token is built, and its SFTP and shared-folder invitations
name no signaling address.

### Connection attempts

A CLI party waits for its partner in connection attempts. Each is a fresh
broker registration under the party's derived id and a fresh peer connection,
built, when the run presents a TURN credential it mints, with a credential
minted as the attempt starts. The connection attempt budget (table below)
bounds each. An attempt that ends with no partner is torn down -- its socket
and its peer connection closed -- and the next begins at once, until the
partner arrives or the rendezvous budget ends. Everything above holds within
one attempt, and nothing carries from one attempt to the next. The
measurements behind the budgets here are in
[docs/notes/cli-webrtc-attempt-cycle.md](../notes/cli-webrtc-attempt-cycle.md).

- **How the wait is divided.** Every attempt but the last runs the attempt budget. The last runs to the end of the rendezvous budget, taking a remainder of up to half an attempt budget rather than leaving it to an attempt of its own, so a wait at the default rendezvous budget is one attempt. The rendezvous budget is checked only as an attempt starts, so a last registration begun just before it ends can complete up to the broker registration budget after it, and an `OFFER` delivered with that `OPEN` engages the partner, who then gets the channel-open budget: the wait can meet a partner whose offer arrives up to the broker registration budget past the rendezvous budget.
- **Where an attempt ends.** The attempt budget runs from the registration. Reached while the partner has not sent its session description, it ends the attempt, or on the last one fails the wait with the rendezvous budget's expiry. A partner that has sent its description is not cut off: the attempt continues for the channel-open budget from that point, and a channel still unopened then ends the attempt the same way, the last one failing with a message naming the description that arrived. The channel-open budget runs from the description's arrival whether or not the attempt budget has been reached, and on an attempt that another follows its expiry logs the ICE diagnosis below as a warning and starts the next attempt, so a long wait does not end on one negotiation that found no path.
- **The acceptor's quiet period.** In the last part of an attempt that another follows (the attempt offer quiet period, table below) the acceptor sends no `OFFER`, neither on an `EXPIRE` nor on the unreported-offer re-send. A browser inviter's app takes the first offer handed to it, so an offer delivered as the attempt ends would be answered after this side had torn that connection down. The browser would then fail at its own channel-open bound, and the browser's client would answer the next attempt's offer on a connection its app never reads, so this party would report connected and then fail. The quiet period is above the broker's hold of an offer for an absent peer plus the partner's answer, so an offer a partner can take is answered inside the attempt that made it. The last attempt of a wait offers to its end. The quiet period is the acceptor's alone: an inviter answers an `OFFER` that arrives in the same part of its attempt, and a partner that has sent its description by the bound gets the channel-open budget, as above, rather than being torn down.
- **Connection ids.** Each attempt's acceptor offers under a new `connectionId`, and each side drops an `ANSWER` or `CANDIDATE` naming a `connectionId` other than the one it holds. One naming none, or reaching an inviter that has not answered yet, is taken as current.
- **A partner that starts over.** An inviter that has answered and receives an `OFFER` naming a new `connectionId` ends its attempt, since the acceptor has abandoned the connection it answered, and the next attempt answers that offer. The broker delivered it, so it sends no `EXPIRE` and holds nothing for the new registration, and a browser acceptor never sends an offer again: its dial fails at its own 30 s open timeout and is not retried, since it retries only on `peer-unavailable`. An `OFFER` repeating the current `connectionId` is re-answered. No floor applies: a partner re-offering under new connection ids sets the attempt cadence, and each restart costs one credential mint, one broker registration and, when relayed, one relay allocation held until it expires. The parties' agreement, not a minimum interval, bounds it.
- **A broker socket that drops.** The registered socket closing or failing before the partner has sent its session description ends the attempt as reaching its budget does, logging a warning, and the next begins at once; on the last attempt the next runs to the end of the rendezvous budget, so the wait still fails only there, with the rendezvous budget's expiry. The next registration may meet the broker still holding the dropped socket's id, which the ID-taken retry below waits out. A drop once the partner has sent its description, a refusal or `ERROR` from the broker, and a frame that breaches a bound fail the wait. No floor applies here either: a broker that drops every socket once registered sets the attempt cadence until the rendezvous budget ends.
- **Re-registering the same id.** The broker frees an id within milliseconds of a clean close. It holds the id of a socket that vanished without closing until its 90 s liveness timeout ([CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#web-signaling-surface-bounds)), so an attempt after one whose network dropped can be refused. A registration after the first that is answered `ID-TAKEN` is therefore tried again, after a wait of 0.5 s that doubles to at most 10 s, for the ID-taken retry window (table below); still refused at its end, the wait fails, naming another run of the same role as the likely holder. A first registration answered `ID-TAKEN` fails at once, as above.
- **A registration that fails.** A registration after the first whose socket fails, closes, or is not confirmed within the broker registration budget or the time left in the rendezvous budget, whichever is shorter, with no refusal from the broker, is tried again on the same schedule until the rendezvous budget ends. The first failure logs a warning, and later ones in the same wait log at debug level. Still failing then, the wait fails with that registration's own failure, not the rendezvous budget's expiry, since the signaling server is what kept the partner out. A first registration that fails this way fails at once: it has not yet shown the configured server reachable. A registration whose socket failed on a certificate that did not verify on this host is the exception: first or later, it fails the wait at once as an authentication failure (exit 77 in the CLI), naming the certificate problem and the trust-store remedy, since every later dial meets the same certificate until the host's trust changes. A failure on a run configured for an environment proxy, where no certificate check is made, is retried like any other.
- **What the operator sees.** The no-ICE-servers warning is given once per run. An attempt that starts with a new relay credential logs why it starts and the new credential's expiry. The reason is the one the attempt before it ended on: its budget reached with the partner absent, stated with the wait so far in whole minutes, or in whole seconds and at least one under a minute; the partner's new connection; the broker socket dropping; or the channel-open budget passing. Any other attempt logs its start, with the same reason, at debug level only.

## Negotiation envelope

- **`OFFER`** payload: the SDP under `sdp`, a `type` of `data`, a
  `connectionId`, and the DataConnection's `metadata`, `label`, `reliable`, and
  `serialization`. `serialization` is critical rather than a preference: the
  receiving PeerJS peer selects its DataConnection subclass from it, so a
  mismatch is a protocol break. It is `binary` (BinaryPack).
- **`ANSWER`** payload: `sdp`, `type`, and `connectionId` only -- no `label`,
  `reliable`, or `serialization`.
- **`CANDIDATE`** payload: the candidate object under `candidate`, plus `type`
  and `connectionId`.

The `connectionId` is PeerJS's `dc_<random>` DataConnection id. A party echoes
the id it adopted from an offer on every frame it sends afterwards, so an
adopted id is bounded: at most 64 characters from `[A-Za-z0-9_-]`. An offered id
outside that shape is not a PeerJS peer's and is ignored, the receiver keeping
the id it generated.

Candidates must be queued until this side's own description has been put on the
broker. Both stacks fire candidates during `setLocalDescription`, before the
description can have reached the broker, and a PeerJS peer discards a candidate
it cannot yet apply -- silently, from the sender's side.

## Framing

PeerJS's chunking is a convention inside BinaryPack messages, not a protocol of
its own. Each datagram is a BinaryPack-packed object; a truthy `__peerData`
marks it as either a chunk envelope or the close sentinel.

- A chunk envelope holds the message id (`__peerData`, starting at 1 and
  incremented for each message sent in chunks; a message sent whole takes no
  id), the chunk index, the chunk bytes, and the total chunk count. Chunks
  accumulate by id until the count matches the total.
- The chunking threshold is 16300 bytes, well under the SCTP ceiling.
- The browser delivers an assembled chunked frame as a `Uint8Array` and an
  unchunked one as an `ArrayBuffer`; a consumer must normalize both.

The inbound path is bounded before anything is reassembled. Both parties refuse
an envelope whose message id is not an integer, whose count is not a positive
integer, whose index is outside that count, or whose chunk bytes are not binary.
`MAX_WEBRTC_FRAME_BYTES`, the chunk-count cap, and the structural scan that goes
with them are specified in
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound).

### Outbound encoding

Both parties encode an outbound frame with Alcove's own BinaryPack encoder
(`encodeBinaryPackValue`, `packages/core/src/connection/binaryPackEncode.ts`)
rather than with `peerjs-js-binarypack`'s `pack`. It walks a frame's arrays and
objects with an explicit stack, so a frame's element count is bounded by memory;
the library's own packer descends one call frame per element and overflows the
sender's stack at roughly 7,800 matched records, well below what the inbound
bounds admit. The CLI calls it from its wire module; the browser installs it over
the PeerJS data connection's own encode step, leaving PeerJS's chunking and
buffering in place
(`apps/web/src/psi/transport/iterativePacking.ts`).

The wire is unchanged. The encoder emits the bytes the pinned packer emits,
marker for marker, for every value kind Alcove sends:

- null and undefined (`0xc0`), booleans (`0xc2`/`0xc3`).
- Integers on the packer's own ladder -- fixint, then the first unsigned or
  signed marker whose range holds the value -- and non-integral numbers as the
  packer's `double` (`0xcb`), whose exponent and fraction come from a logarithm
  and a truncating multiply rather than from the IEEE-754 bits.
- Strings as UTF-8 under `0xb0 + n` / `0xd8` / `0xd9`, byte arrays
  (`Uint8Array`, `ArrayBuffer`, any typed-array view) under `0xa0 + n` / `0xda`
  / `0xdb`.
- Arrays under `0x90 + n` / `0xdc` / `0xdd` and plain objects as maps under
  `0x80 + n` / `0xde` / `0xdf`, keys packed as strings in `Object.keys` order.

Above the count a 16-bit header can declare, the wider `array32` and `map32`
headers appear; the inbound scan and `unpack` already read both, so a frame
larger than the previous ceiling needs no negotiation. Any other value kind --
a `Date`, a `Map`, a class instance, a number outside the integer range -- is
refused with a `usage`-kind `ConnectionError` rather than guessed at, since a
guess that misses is a silently corrupt frame. Two more frame shapes are refused
so that no frame is written the packer would not have written whole: a value
that holds itself, which the packer meets as a stack overflow and the encoder as
a container already on the walk from the root, and an object with an own
`constructor` or `hasOwnProperty` key, each of which shadows a check the packer
makes -- it reads `value.constructor` to pick the kind and calls
`value.hasOwnProperty(key)` for each key of a map. The encoder refuses that
shadow outright, which is wider than the packer: the packer throws on all but
one of these shapes, and on the one it survives -- an own `hasOwnProperty` that
answers false for every key -- it writes a map header it fills with nothing.

### Lists of matched records

The lists naming matched records that a cascade sends after its last round --
each party's mapped-element list, the list it returns with the partner's rows,
and its payload rows -- go in parts on WebRTC as on file-sync, each part's
frame sized to the partner's data-channel bound
([PROTOCOL.md, A list of matched records is sent in parts](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts)).
No list is bounded by one frame. A part of either mapped-element list is
refused past the byte bound PROTOCOL.md derives from the agreed terms, before
its body is parsed; the data channel has reassembled the part by then, up to
`MAX_WEBRTC_FRAME_BYTES`, since no receive on this transport reads a frame
under a tighter bound.

A cascade round's association table and original-index list are one frame
each, sent as BinaryPack with no AEAD wrap. Their index lists fit one frame at
the per-set maximum, as they fit one message file on file-sync: two index
lists of 2^24 positions each, encoded by `encodeBinaryPackValue`, measured
167,509,259 bytes (4.99 bytes per value), which `webrtcFrameReceiveCharge`
charges as 168,074,494 bytes (5.01 bytes per value) against the 268,435,456
bytes of `MAX_WEBRTC_FRAME_BYTES`. What can still pass the bound is the
deduplicating side's owner-list grouping beside them
([PROTOCOL.md, The lists the parts do not cover](PROTOCOL.md#a-list-of-matched-records-is-sent-in-parts)).

### Outbound pacing

The CLI hands a frame to the data channel a window at a time rather than all at
once:

- It stops handing over datagrams while the channel's `bufferedAmount` is at or
  above **1 MiB**, and resumes when the channel's `bufferedamountlow` event
  reports it at **256 KiB**.
- A send waiting on the window also re-reads the channel every **250 ms**, so
  it does not depend on that event firing.
- A frame larger than the window goes out over as many windows as it needs.
  Frames go out whole and in the order they were sent, one after another.

All three values are arbitrary working values, raised or lowered on request.
Why werift needs the window, the measurements behind it, and the re-check on a
werift bump are in
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-cli-webrtc-peer-werift).

A send waiting on the window ends when the data channel leaves `open`, when the
peer connection leaves `connected`, or when the connection closes, and the send
then fails with a transport error; nothing more of its frame is handed over.
Otherwise a send whose frame has not all been handed over fails once the
parked-receive budget below has elapsed from the send's start (1 h, or
`inactivity_timeout_ms`): core bounds every send's hand-off by that value, and
the failure tears the connection down without sending the close sentinel. The
browser peer leaves pacing to PeerJS.

### The main thread on an open channel

The CLI's peer runs on the process's main thread, and it answers its partner's
ICE consent checks from that thread's event loop. Work that holds the thread
therefore counts against the thirty seconds or so in which an unanswered
partner calls the connection lost, and the two parties' holds add up
([DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#the-behavioural-assumptions)).

- The PSI masking runs in a worker thread, off that event loop.
- A cascade or count-only round builds its set, and a cascade round resolves
  its matches, in paced stretches. The pacer reads the clock every **1,024**
  records and yields to the event loop at the first record boundary after
  **50 ms** of work (`packages/core/src/utils/eventLoop.ts`), so a stretch is
  bounded by 50 ms plus one stretch of records. The work between paced passes,
  such as the sorts, is not paced. Both values are arbitrary working values.
- What still holds the thread on an open channel is bounded by one frame or
  one index list rather than paced: encoding and decoding a frame, and
  checking and sorting a round's matched positions. At 7,700,000 records a
  side the longest such hold measured was about 10 s on one host and about
  12 s between two ([A round between two hosts](#a-round-between-two-hosts)),
  encoding and decoding the lists of matched records the parties exchange
  after the last round.
- The PSI sender's round start, from its `linking key N / M` line to its
  setup's encryption, is the paced set build followed by two unpaced steps:
  finishing the set, and copying its values to the PSI worker. Measured on one
  host over loopback (10 CPUs, 23 GiB, Linux arm64, Node v26.10.0), as the
  longest hold the sender's lag probe recorded from `linking key 1 / 4` to the
  end of that key's encryption, against the longest on the open channel for
  either party:

  | Records a side | Round start | Open channel, inviter and acceptor | Wall |
  | --- | --- | --- | --- |
  | 1,000,000 | under 1,000 ms | 1,355 ms and 1,168 ms | 229 s |
  | 2,000,000, first run | 425 ms | 3,251 ms and 3,005 ms | 401 s |
  | 2,000,000, second run | 533 ms | 2,437 ms and 2,484 ms | 379 s |
  | 4,000,000 | 347 ms | 7,011 ms and 8,328 ms | 888 s |

  The 1,000,000 run's probe recorded holds over 1 s only; the others recorded
  holds over 200 ms. At every size the longest hold on the open channel came
  after the last round, not at a round start.

### A round between two hosts

On 2026-10-03 two `alcove exchange` parties, one on each of two hosts on one
LAN, ran a cascade over `channel: webrtc` at 7,700,000 records a side through
the repository's broker, on commit 85704c19c. Both exited 0 with the expected
result. Each first-round set was past one frame, so it went in
[parts](PROTOCOL.md#a-psi-set-is-sent-in-parts); the logs do not state how
many. The same round with both parties on one host is in
[PROTOCOL.md](PROTOCOL.md#the-receive-ceiling).

- **Hosts.** The inviter, PSI sender, on a Linux container (Intel i3-14100,
  6 CPUs, 29 GiB); the acceptor, PSI receiver, on macOS (Apple M1 Max,
  10 CPUs, 32 GiB, on Wi-Fi). Node v26.8.2 on both.
- **Path.** Each party logged its data channel as opened over a host
  candidate pair, local host to remote host, across the LAN. No STUN or TURN
  path was exercised.
- **Round-trip time**, sender to receiver over 20 pings: 37 ms on average,
  211 ms at most.
- **Rounds.** The first round took 9 min 32 s and each later one about
  4 min 20 s; the fourth key's start to the connection's close took about
  6 min.

| Party | Wall time | Peak RSS | Longest main-thread hold on the open channel |
| --- | --- | --- | --- |
| Inviter, PSI sender, Linux | 1,488,196 ms | 15,325,048,832 bytes | 12,131 ms |
| Acceptor, PSI receiver, macOS | 1,486,794 ms | 17,052,188,672 bytes | 10,278 ms |

Peak RSS includes the party's PSI worker. Both longest holds came in the last
70 s of the run, after the fourth key's sets, and both are under the stress
test's 15,000 ms bound (`MAX_CONNECTED_LOOP_LAG_MS`), the sender's by under
3 s.

Both peaks are at or under the figures the stress test admits a host on at
this size, 15,353,800,000 bytes for the sender and 17,202,600,000 for the
receiver ([A party's memory](#a-partys-memory)), and are among the points
those figures are fitted to.

`apps/cli/test/stress/webrtcCompletion.stress.test.ts` drives the run in its
one-party-per-host mode, each host running its own party against the other.

### A party's memory

Measured 2026-10-08 on commit aa35fa977, on a Linux container rather than the
development container named elsewhere in this document (Intel Core i3-14100,
6 CPUs, 29 GiB, no swap, Ubuntu 24.04, Node v26.8.2): both parties on that
host over loopback, one run at a time, three runs at each size, driven by
`apps/cli/test/stress/webrtcCompletion.stress.test.ts` with
`ALCOVE_STRESS_COMPLETION_LOG_DIR` set, so that each party's memory was
sampled every 200 ms (`apps/cli/test/stress/peakMemoryReport.mjs`). A sample
states the process's resident set, the main thread's `process.memoryUsage()`
and each PSI worker's V8 heap in use. What no V8 heap counts is the rest: the
native PSI engine's allocations, the worker's external memory, memory the
allocator keeps after it is freed, and the process's code. In every run the
inviter was the PSI sender, and both parties exited 0 with the expected
result. The one-minute load average was 1.5 to 4.0 at the start of these nine
runs and 3.6 to 5.6 at their end; with the three runs on 1a0504a44 below, the
start range is 1.32 to 4.0.

Peak RSS is the process's high-water mark (`process.resourceUsage().maxRSS`),
PSI worker included. The components, in GB, are those of the sample with the
highest resident set in the run with the highest peak, which was within
0.17 GB of that peak: the main thread's V8 heap, the main thread's
ArrayBuffers, the PSI worker's V8 heap, and the rest. The sampler took 62% to
71% of the samples a 200 ms period gives, fewest at the largest size, so a
short rise can fall between samples; the peak RSS cannot. Where the peak fell
is read off the party's log lines around that sample, each logged when its
step ends.

| Records a side | Role | Peak RSS, highest of three | Lowest of three | Where | Main heap | Main ArrayBuffers | Worker | Rest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 500,000 | sender | 1,278,431,232 | 1,181,716,480 | fourth key, end of its set's encryption | 0.48 | 0.04 | 0.03 | 0.72 |
| 500,000 | receiver | 1,628,418,048 | 1,570,697,216 | first key, the match | 0.36 | 0.08 | 0.41 | 0.73 |
| 1,000,000 | sender | 2,234,875,904 | 2,211,237,888 | first key, just after its encryption of the partner's set | 0.73 | 0.31 | 0.01 | 1.10 |
| 1,000,000 | receiver | 2,850,832,384 | 2,577,211,392 | first key, the match | 0.66 | 0.18 | 1.16 | 0.80 |
| 2,000,000 | sender | 4,104,716,288 | 4,072,054,784 | first key, end of its encryption of the partner's set | 1.33 | 0.30 | 1.58 | 0.73 |
| 2,000,000 | receiver | 4,781,133,824 | 4,507,717,632 | first key, the match | 1.30 | 0.37 | 1.21 | 1.90 |

Where the memory goes:

- **The first key holds the peak** in 17 of the 18 runs: the sender's at the
  end of its encryption of the receiver's set, the receiver's during the
  match. The one exception, a 500,000-record sender, peaked at the end of its
  own set's encryption in the fourth key, at 1,278,431,232 bytes against
  1,181,716,480 and 1,232,269,312 in the first key for the other two.
- **The main thread's heap** at the peak was 0.35 to 0.48 GB at 500,000
  records, 0.66 to 0.73 GB at 1,000,000 and 1.30 to 1.44 GB at 2,000,000.
  The history of what moved the peak is in
  [webrtc-memory-measurements.md](../notes/webrtc-memory-measurements.md).
- **The receiver's peak varies most.** Its three 1,000,000-record runs span
  273,620,992 bytes, the sender's 23,638,016. The worker's heap at the
  receiver's peak was 0.59 to 1.16 GB at 1,000,000 records, depending on
  how far into the match the peak fell.
- **The transport's buffers are small beside it.** The main thread's
  ArrayBuffers were at most 0.61 GB at a peak. They were highest just after
  the sender's encryption of the receiver's set left the worker for the
  channel: 295 to 315 bytes a record, where an encoded element is 35 bytes
  ([PROTOCOL.md](PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)).
  They hold the PSI sets the main thread passes between the worker and the
  channel, both directions' framing copies, and werift's datagrams. Of
  those, the send window stops handing datagrams to werift at 1 MiB buffered
  ([Outbound pacing](#outbound-pacing)); encoding a frame into its chunk
  datagrams holds one more copy of the frame, and reassembling one holds the
  chunks' slices beside the joined frame until it completes, two copies
  (measured on a 35 MB frame).
- **The PSI round**, the worker and the rest together, was at most 3.11 GB
  at a peak, the 2,000,000 receiver's during the first key's match.

**The figure.** The stress test weighs a party at a fixed part plus a cost a
record, per PSI role (`WEBRTC_PARTY_MEMORY`,
`apps/cli/test/stress/webrtcCompletion.stress.test.ts`), and a run of both
parties on one host at the sum of the two:

| Role | Fixed part | Bytes a record |
| --- | --- | --- |
| Sender | 308,000,000 | 1,954 |
| Receiver | 740,000,000 | 2,138 |

The cost a record is the least-squares slope of peak RSS against the records
a side over thirteen peaks a role, rounded to a byte: the nine runs above,
the three 1,000,000-record runs on 1a0504a44, and the round between two hosts
at 7,700,000 ([A round between two hosts](#a-round-between-two-hosts)). The
fixed part is the least that puts all thirteen peaks at or under the line,
rounded up to a megabyte. A 1,000,000-record run on 1a0504a44 sets it for
both roles, so the receiver's figure there is 27,520 bytes over its highest
peak.

The two-host round was measured on 2026-10-03 on commit 85704c19c, before
80452d2c3 moved the peak, and has not been measured since. It stays among
the fitted points: fitted to the twelve 2026-10-08 runs alone, the figures
at 7,700,000 records fall 2.4% (sender) and 3.8% (receiver) under its peaks,
and the receiver's peak at 1,000,000 records did not fall with that commit.

Against the highest of all thirteen fitted peaks a role at each size, which
at 1,000,000 records includes the three runs on 1a0504a44 on 2026-10-08, so
those two rows are not the highest-of-three peaks in the first table:

| Records a side | Sender figure | Over the peak | Receiver figure | Over the peak |
| --- | --- | --- | --- | --- |
| 500,000 | 1,285,000,000 | 0.5% | 1,809,000,000 | 11% |
| 1,000,000 | 2,262,000,000 | 0.04% | 2,878,000,000 | 0.001% |
| 2,000,000 | 4,216,000,000 | 2.7% | 5,016,000,000 | 4.9% |
| 7,700,000, two hosts, 2026-10-03 | 15,353,800,000 | 0.19% | 17,202,600,000 | 0.88% |

The round at 7,700,000 with both parties on one macOS host
([PROTOCOL.md](PROTOCOL.md#the-receive-ceiling)) peaked at 12,180,897,792
bytes (sender) and 13,268,779,008 (receiver), under both figures and not
among the fitted points. The file-sync party's figure
(`cliPartyNeedBytes`, `apps/cli/test/stress/completionRun.ts`: the CLI's round
budget plus 754 bytes a record) is 8% to 24% under every fitted receiver
peak, and from 4.6% over to 3.3% under the fitted sender peaks.

The role is decided at the terms exchange, after the gate: with equal record
counts the inviter resolves as the PSI sender. Each run checks the role each
party logs against the one it was weighed at.

**The CLI's own check.** The pre-contact check and the partner's-round check
([FILE_SYNC.md, Memory a PSI round needs](FILE_SYNC.md#memory-a-psi-round-needs))
weigh the PSI round alone, `271,000,000 + 1,176 * n` bytes, which is 50% to
73% of every fitted WebRTC peak. It is a lower bound by its own statement, and
it leaves out the main thread on every channel, so a WebRTC party it admits
can still run out of memory on a host with less than the figures above. It
stays a round-only figure: it also sizes the PSI worker's heap ceiling, and a
file-sync party's main thread is outside it too.

### A connection that ends during a round

The exchange reads the connection's terminal state
(`MessageConnection.terminated`). A half-close counts as ended even while
frames the partner sent before it remain to be read, because nothing can be
sent after it.

- A paced pass stops at its next yield with the error that ended the
  connection, so a party whose partner is lost while it builds or resolves a
  round fails within one stretch.
- A crypto step does not start once the connection has ended: the party fails
  at once with the error that ended it.
- A crypto step already handed to the PSI worker stops at its next chunk
  or match call boundary, so the party logs a warning naming the loss when
  it happens and fails with the connection's error within one masking chunk
  during encryption, or at the end of the current match call during the
  match -- for a match that runs as one call, such as a count-only match
  without setup slices, the whole match. The worker is not terminated inside
  a native call, which aborts the process
  ([DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#the-vendored-openminedpsijs-addon)
  states the stop mechanism). A browser party without `SharedArrayBuffer`
  runs the step to its end before failing.

Measured at 4,000,000 records a side on the host above, with the acceptor
killed 2 s after the inviter's `linking key 1 / 4`, during its set build: the
inviter exited 69 1.7 s later.

## The clean close

The close sentinel is a `__peerData` close object sent through the same
reliable, ordered channel, which necessarily places it behind every frame
already handed to `send`. The *peer* closes on receipt.

Queuing the sentinel is not delivering the frames in front of it. PeerJS's own
clean close returns the moment the sentinel is queued, with the final frame
still in the sender's outbound buffer -- measured in Chromium at 8.4 MB of a 16
MiB frame still buffered when the close returned, and the peer reading that
frame 1.3 s later. A close that returns there has reported delivery for bytes
that have not left. Both implementations therefore wait, each on the strongest
signal its stack exposes, and the wait is the delivery guarantee rather than
hygiene.

**The web app** waits for the peer to close the data channel. The peer does that
on reading the sentinel, and the ordered channel places the sentinel behind
every frame already handed to `send`, so the local channel's `close` event is
the peer's receipt of the final frame. That event is the peer's and not this
side's: PeerJS leaves the local channel open on a flushing close (measured:
still `open` after an eight-second window against a peer patched not to close,
with `bufferedAmount` having reached zero early in it). Nothing is torn down
afterwards -- a browser peer has no reason to, and no SCTP-level drain to do
better with.

**The CLI** cannot leave the connection standing, so it drains to
acknowledgement and then tears down:

1. Wait until the peer has acknowledged every byte already handed to the
   channel, then
2. send the sentinel, wait until it has been transmitted (not acknowledged -- a
   peer closes on reading it and stops acknowledging at exactly that point),
   then
3. close the data channel, wait for that close to complete, and only then tear
   down.

Step 2 sends the sentinel only while the channel is still open and the link
still connected: a send on a channel that has left `open` is queued and never
delivered.

A step 1 that ends without the acknowledgement -- on the close drain budget, or
on the link going -- still runs steps 2 and 3 and tears down, and the close then
rejects with a `transport` error naming which of the two it was, rather than
reporting a clean close. A run whose exchange completed shows it to the operator
as a warning that the partner may not have the last message; its exit status
is unchanged.

Step 3 is what the partner's own wait ends on, and it runs on both halves of a
clean close -- the one this side asks for and the one it answers on reading the
peer's sentinel. The channel's close is the whole of the delivery signal a
browser partner gets: PeerJS takes a receipt off its channel closing, never off
anything sent back to it. A peer connection torn down under a still-open channel
reaches that partner as no close at all -- and as no sentinel either, since
handing the sentinel to the wire is not the peer having it -- leaving it to wait
out ICE. Waiting for the channel's close to complete is the confirmation that
everything ahead of it arrived. The wait is bounded, and it ends early when the
peer connection is already no longer up -- which covers a partner detected as
gone before the close began. It is not the usual reading of a partner that
vanishes: werift leaves the `connected` state about thirty seconds after a peer
disappears, so a partner lost during the teardown itself costs the whole
ceiling. werift's only post-open departure from `connected` is `failed`, which
the partner's packets arriving again do not undo, so the CLI treats any
departure as the partner lost; `apps/cli/test/unit/connection/webrtcPostOpenLoss.test.ts`
drives that on a loopback pair.

The condition in step 1 is the SCTP association's send and unacknowledged queues
both being empty. It is not the channel's `bufferedAmount`: that
counter reaches zero while chunks are still unacknowledged, and a close gated on
it loses them -- measured at roughly one frame in three over a loopback channel
with no packet loss at all. This is the acknowledgement the flushing-close half
of the delivery contract requires; "flush the local buffer" is not sufficient on
this transport (see
[COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)).

Every wait above also ends when there is nothing live left to deliver over, so a
partner that crashed produces a teardown rather than a wait as long as the
ceiling. For the web that is the peer connection reaching `failed` (ICE gave up
on the peer) or `closed` (this side tore its own link down); a transient
`disconnected` is not terminal, because the frame is still in flight while ICE
recovers.

A teardown on this side reaches the wait as the channel closing, not as a state
change -- closing a peer connection fires no state event, measured on Chromium,
the one engine the browser suite drives -- and the channel closing is otherwise
the peer's receipt. The web wait therefore reads the link at that event rather
than taking the close at face value.

A dead link is not the whole reading, because the peer's close ends this side's
link too: PeerJS closes this side's peer connection as its handling of the
peer's in-band close sentinel, in the same call, before the channel's `closing`
fires. Both parties closing a healthy exchange therefore each reach `closing` on
a link of their own closing, which is the signature of a teardown on the one
ending that lost nothing -- measured on a real pair in Chromium. What separates
the two is whether the end was PeerJS's own doing. PeerJS clears `open` whenever
it itself ends the connection -- reading the peer's close sentinel, this side's
own close call, or its own cleanup on a signaling leave naming this peer, an
inbound OFFER echoing the live connection, ICE reaching failed or closed, or a
send error. So a cleared flag at `closing` means a PeerJS-mediated end and
is treated as the peer's close. Only an end that bypasses PeerJS -- this side's
raw peer-connection teardown -- reports the loss. A partner who ends the link
through signaling (a relayed leave) mid-drain is therefore also treated as the
receipt; the close remains no proof of delivery. So the no-live-peer exit is
taken for a channel that starts closing on a link already gone with no peer
close in hand; a link the peer's own close ended is the peer's receipt.

A CLI partner reaches the same reading by the other route. It closes the data
channel rather than ending the link through signaling, so the channel starts
closing on a link that is still up and that PeerJS has not ended -- a live link
with no teardown of this side's behind it, which the reading takes as the peer's
close. Both routes are measured: the browser pair in
`apps/web/test/browser/webrtcCloseDelivery.test.ts`, and the CLI-to-browser pair
by the live leg.

A partner that closes FIRST leaves no wait to take at all: PeerJS ends the
connection on reading the sentinel, so this side's own close finds it already
ended and starts no drain. That is silence rather than an exit -- the operator
is told nothing, which is what the peer's close means here too.

A completed `close` arriving with no `closing` before it is still read as the
peer's, because a link state read after a close has completed no longer says
whether the link died before the close or in answer to it, and a doubt invented
about a healthy exchange is the worse error. The reading is therefore inert on a
stack that never fires `closing`: every close is treated as the peer's there,
the pre-reading behavior -- the stated limit of this discrimination. The
healthy-exchange reading also assumes the engine dispatches the channel's
`closing` as a queued task after the synchronous close call, as spec-conforming
engines do and as Chromium, the one engine the browser suite drives, measures;
an engine dispatching it synchronously inside the peer connection's close would
report a spurious loss on every healthy exchange there.

The web wait also ends when the run itself is cancelled. Up to the ceiling the
wait's length is the peer's to choose -- it holds the wait simply by keeping ICE
alive and never reading the sentinel -- so an operator who cancels does not spend
it. Nor does the drain gate what the run already has: the web app reports its
result and its downloads first and drains afterwards, so a peer that never reads
the sentinel delays neither.

Exactly one exit of the web wait gives a delivery signal: the peer's own close.
Every other exit leaves the partner's copy in doubt on a run whose result this
side has already reported, so the web app raises a non-fatal warning on each of
them. The run's result stands either way; what the operator is told is that the
partner may not have taken the final frame, and to check that their exchange
finished.

The wording follows the exit, because the exits do not mean the same thing:

| Exit | What the operator is told |
| ---- | ------------------------- |
| The peer closed the channel | Nothing -- that close is the delivery signal |
| The ceiling ran out | The partner never confirmed taking the final message within the wait, so their exchange may have ended without it |
| Nothing live is left to deliver over -- the peer connection failed, this side tore it down, or the channel was already out of `open` | The connection closed before the partner could confirm, so they may or may not have received it |
| The run was cancelled while the wait stood | The same wording as a connection that closed: the cancel cuts the wait rather than letting it run out, and what the partner got is as unknowable either way. A cancelled run's notice is withheld anyway (below), so this is what the exit means rather than what an operator reads |

The notice is best-effort in two ways. It reaches the operator only when the
drain ends while the run is still on screen, so an operator who leaves as the
results render is told nothing. And it speaks for a run that succeeded here, so a
run that already failed or was cancelled drains the same close silently -- it has
told the operator something stronger already.

A close signal is not proof the partner's application read what was behind it: a
peer that closes without draining its inbound queue is indistinguishable from one
that read everything. The partner's peer connection torn down by their page
rather than by reading the sentinel resets its stream gracefully -- measured in
Chromium, and pinned in `apps/web/test/browser/webrtcCloseDelivery.test.ts` -- so
that teardown arrives here as the same close. The state of the link, read
together with whether the peer's own close accounts for it, is what tells a
close apart from a teardown, and only this side's link is visible here: it
separates a teardown of this side's that the peer had no part in (above) and can
say nothing about the partner's. That is also why the cancellation is an exit of
its own rather than whatever the teardown behind it does to the channel: a cancel
folded into an exit of the link's would report the link's story for a wait the
operator cut.

What no close can cover is a sender whose stack goes away before its bytes do:
tearing the peer connection down as the close returns delivered nothing at all
-- measured at zero frames of two received, four rounds out of four. A browser
tab closed the instant the results appear does the same thing to a frame still
buffered. Waiting narrows that window to the delivery itself rather than
leaving it open for the length of the transfer, and a teardown that lands inside
it while this page keeps running is reported as the loss it is rather than as a
delivery.

### What each side's wait costs, measured

The two waits above are specified against what each stack exposes, not against a
duration. What they cost when a CLI party and a browser party close the same
healthy exchange is measured by the live leg
([docs/TESTING.md](../TESTING.md#live-webrtc-leg)), which prints both numbers on
every run. The leg gates on the browser party's exit, read against which party
closed first, rather than on either duration, and holds that party's wait under a ceiling set between the two
outcomes it separates: a wait the partner's close ends costs milliseconds, and
one left to end on ICE giving up costs 15 s or more. The durations stay a
tracked limit -- read across runs, with any tighter bound a later decision taken
against the spread rather than against one measurement.

| Side | What it waits for | Measured |
| ---- | ----------------- | -------- |
| The CLI party | The data channel's own close completing, once the peer has the frames ahead of it | under 100 ms |
| The browser party | The peer to close the data channel | under 50 ms, ending on the peer's close |

Conditions, over ten runs: two parties on one machine over a loopback host
candidate, six records between them, Chromium against the shipped CLI
transport, in the development container. The browser party usually reaches its
close first here, so the CLI party's number is usually the half that answers a
sentinel; the half that sends one adds the drain to acknowledgement and the
sentinel ahead of the same channel close, and moves with the data still
unacknowledged on a wide-area link and a real dataset. Neither moves the browser
party's number, which is not a function of the data. Both are round-trip waits
between two processes on one machine, so both rise with load on it -- a
contended container has put either several times higher.

So a completed CLI-to-browser exchange leaves the browser operator no notice
about a partner who may not have taken the final frame: the CLI party's close
either ends the wait or precedes it, and neither is a doubt.

## ICE

A configured `iceServers` list replaces the built-in STUN default rather than
adding to it, which is what makes a configured server list the list
actually used. An empty or absent list means "use the default"; it does not mean
"no STUN". The consequences for an operator -- the default that applies when
nothing is configured, what it discloses, and the unreachable-entry idiom for
gathering host candidates only -- are in [CLI.md](../CLI.md#webrtc-exchanges).

`connection.ice_transport_policy` selects the candidate types this side may
gather: `all`, which is what an absent value leaves in force, or `relay`. Under
`relay` no host or server-reflexive candidate is gathered, so this side's
whole offer is relay candidates and every pair it can form runs through a
configured TURN server. The value is per party and never a term of the exchange:
it is not representable in an invitation endpoint, and it constrains nothing the
partner gathers. A `relay` policy with no `turn` entry and no `ice_provision` is
rejected by the connection schema, since it could gather nothing to pair.

The policy holds for a `turn` entry the transport keeps, and the connection
schema accepts no url the transport would drop, and refuses a few it would
keep (a repeated `transport` parameter, whose first occurrence the transport
reads) rather than rest on which occurrence is read. The transport reads a
turn url's `transport` parameter itself and refuses the whole entry over
a value it does not support, continuing without it, which under `relay`
leaves the run gathering the host candidates the policy exists to keep
off the wire. So the schema accepts a url that leaves `transport` unset or
sets it to lowercase `tcp`, and `udp` on a `turn:` url; every other value --
another protocol, an uppercase spelling, an empty one, or `udp` on a `turns:`
url -- is refused at parse. A url setting the parameter more than once is held
to the same rule at every occurrence, rather than resting on the transport
reading the first. Which values the transport keeps is measured per form in
`apps/cli/test/integration/webrtc/webrtcIceTransportPolicy.test.ts`, which
the grammar in `packages/core/src/config/connection.ts` is drawn from.

The connection schema's webrtc member is a strict object: a key it does not
define is refused at parse, naming the key in the snake_case the document
writes, rather than stripped. A dropped `ice_transport_policy` would leave a
run that asked for relay-only candidates gathering under the default, with
nothing stating that it had -- the reason `authentication` is strict as well
(`packages/core/src/config/connection.ts`).

Every run states the policy it applied as it opens the rendezvous: the
configured value, or the transport's own default where the connection sets
none.

A CLI rendezvous that fails with both parties present -- the peer connection
reporting `failed`, or the channel-open budget running out -- reports the
candidate types this side gathered, the types the partner sent, and how many
candidate pairs were tried, each on a labelled cause link of its own, so a
relay that was never gathered is distinguishable from one that was and still
found no path. A rendezvous that ends on the rendezvous budget, on the
partner's `LEAVE`, or on the data channel closing before it opened reports no
candidate detail. Where the policy is `relay` and no relay candidate was
gathered, the first link names the policy: that run had no direct path to fall
back on, so the policy is part of the diagnosis rather than context the
operator supplies. What an operator
does with that answer is in [CLI.md](../CLI.md#webrtc-exchanges).

`connection.provider_options` is inert on this channel: no transport on either
side reads it, so no key in it reaches the PeerJS client, the peer connection,
or the ICE configuration above, and the only honored form of the map is the SFTP
channel's, filtered through a default-deny allowlist
([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionprovider_options)).
`npm run check:webrtc-provider-options-unread` holds that claim: it scans the
CLI's and web app's WebRTC sources for a read of the option and fails the moment
one appears. That allowlist rather than a verbatim passthrough is what a
consumer here would be held to, since an opaque map reaching the broker or peer
options could otherwise move where this side connects.

## Application-layer encryption

The `webrtc` channel states `request_encryption: false`: a data channel is
end-to-end confidential under DTLS against the signaling server and any relay,
so the application-layer AEAD wraps nothing the transport has not already
protected, and the web peer refuses a partner that requests it. The rationale
and the one case that would change it are in
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md).

## Budgets

Every value below is a ceiling, not a wait: each returns as soon as its
condition holds.

| Budget | Default | What it bounds |
| ------ | ------- | -------------- |
| Broker registration | 30 s | Opening the signaling socket and receiving `OPEN` |
| Rendezvous | 10 min | Both parties finding each other; human-timescale, because one operator may start well before the other. A CLI party waits it out in connection attempts |
| Connection attempt | 10 min | One CLI connection attempt's wait for the partner's session description, from its registration; the last attempt of a wait runs up to half as long again. At most a quarter of a minted relay credential's one-hour lifetime; a partner met at the end of the longest attempt has about 42 minutes of the credential left, three quarters of the lifetime less the ID-taken retry window, the broker registration and the channel-open budgets |
| Attempt offer quiet period | 30 s | The end of a CLI connection attempt that another follows, in which the acceptor sends no offer; above the broker's 5 to 6 s hold of an offer plus the time a partner takes to answer it |
| ID-taken retry window | 2 min | How long a CLI registration after the first that is answered `ID-TAKEN` is tried again; above the broker's 90 s liveness timeout for a socket that vanished without closing |
| Minimum offer re-send interval | 10 s | The least time between two sends of the CLI acceptor's offer on an `EXPIRE`; above the broker's 5 to 6 s hold, so a copy sent on an `EXPIRE` is never held beside the one before it |
| Unreported offer re-send | 30 s | How long the CLI acceptor waits after sending its offer for an answer or an `EXPIRE` before sending it again; far above the broker's 5 to 6 s report of an undelivered frame, so the copy it replaces is no longer held |
| Channel open | 30 s | The data channel opening once both descriptions are exchanged; reaching it means the peer is present but no candidate pair worked |
| Parked receive | 1 h | Peer silence on an open channel; it bounds the peer's single-threaded PSI compute, which sends no keepalive while it runs |
| Close drain | 5 min | The clean close's wait above -- the CLI's acknowledgement drain, the web's wait for the peer's close -- sized from the largest admissible frame and the measured send rate |
| Sentinel hand-off | 2 s | Getting the close sentinel itself onto the wire |
| Channel close | 2 s | The data channel's own close completing on a clean close -- the peer answering the stream reset. A partner that goes during the teardown spends it whole, ICE being slower than this to call the link dead; reaching it closes the session anyway |
| ICE statistics | 2 s | Collecting the candidate report a failure or an open channel is described by; expiring costs the description, not the outcome |
| Transport teardown | 6 min | The whole close of this transport at the run's own teardown point, above the sum of the close drain, sentinel hand-off, channel close and ICE statistics budgets in this table |
| Signaling certificate check | 5 s | The handshake that answers whether a `wss://` socket that failed before registering failed on its certificate; a socket that drops after registering is not asked about, having completed that handshake already, and neither is one on a run configured for an environment proxy, whose dial the handshake does not follow |

The teardown ceiling is the run's, not this transport's: it is applied at the channel-independent point where a run closes what it opened, and every channel declares a value there above its own teardown budgets (the file-based channels' is in [FILE_SYNC.md](FILE_SYNC.md)). The close runs after the run's terminal event, so reaching the ceiling stops the wait and states the elapsed time and the resource kinds still holding the process on the operator log at error level, never on the event stream, which ends at that terminal event ([CLI_EVENTS.md](CLI_EVENTS.md#terminal-event-guarantees)); it changes no exit code. Nothing local is inside it: the result, the exchange record and the receipt are written and awaited before cleanup begins, each with no budget of its own where it goes to a path. The one local wait that is bounded is a result streamed to stdout, whose drain and its outcome are in [CLI_EVENTS.md](CLI_EVENTS.md#error-categories).

Once the run's own work and its teardown are finished, the process returns within **3 s**. A clean event loop exits at once and says nothing -- measured from the command settling to natural exit, a completed two-party `filedrop` exchange drained in 0-1 ms across ten party-runs -- and a loop still held at the budget names the resource kinds still armed on stderr and exits with the status the run already resolved. The handle that held it is not released or swept: a run that reports what held it is how the next one is found.

`connection.options.peer_timeout_ms`, when set, replaces the rendezvous budget,
and `connection.options.inactivity_timeout_ms` the parked-receive budget: the
first bounds the partner's arrival, the second a present partner's silence. No
setting reaches the channel-open budget. Once both descriptions are exchanged
the partner is present, so a channel that still does not open is a network path
failure rather than a late partner, and it is held to the fixed ceiling above
whatever the two settings around it are.

An interrupt (SIGINT or SIGTERM) does not wait any of them out. The run passes
the transport an abort signal, and the rendezvous fails and tears down the
broker socket and the peer connection on it, so a party that interrupts while
waiting for its partner exits at once rather than at the end of the rendezvous
budget.

A configured relay leaves one timer armed that this transport cannot release.
werift keeps a TURN allocation alive by re-sending refresh on a timer armed from
the lifetime the relay granted, and tearing the peer connection down leaves a
timer that is already waiting armed; a waiting timer holds the event loop, for
five sixths of the granted lifetime -- about 500 s where a relay grants the
usual 600 s. Everything the exchange owes is complete before that wait begins:
the result, the exchange record and the receipt are written, the channel and
the broker socket are closed, and nothing crosses the wire during it. So what
the timer holds is the loop rather than the run, and the return budget above is
what ends the process, naming the kinds of handle still armed as it goes.
Nothing werift exposes releases the timer, so it is a stated limit rather than
a budget this transport sets; the measurement, and the release paths that were
driven against it, are in
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#the-behavioural-assumptions).

A CLI wait of several connection attempts leaves one such timer for each
attempt that allocated against a relay. A timer that fires is not armed again,
so the timers armed at once are bounded by the attempt count within about
500 s, not by the wait's length: one while attempts run the 10-minute attempt
budget, more when a partner restarting under new connection ids starts them
sooner. The relay likewise holds each attempt's allocation until the lifetime
it granted ends, about 600 s, since no teardown releases it: one or two at a
time while attempts run their budget, and otherwise one for each attempt
started within that lifetime.

Three CLI bounds are memory rather than time, all on inbound signaling: a
signaling frame is refused above 256 KiB of UTF-8 before it is parsed; at
most 128 remote candidates are held per connection while that connection's
remote description is not yet applied; and at most 128 remote candidates are
applied per connection attempt, the held ones included. A candidate past
either candidate cap is dropped silently. A candidate counts against the
applied cap from the moment it is handed to the ICE agent until the agent
settles it, so a burst of candidates the agent will reject, arriving in
one tick, can hold the budget until they settle.

The browser peer holds its own signaling intake to the first two bounds: a
frame over 256 KiB of UTF-8 is refused unparsed, the peer reporting a
`server-error` naming the limit and leaving the signaling server; and at most
128 messages held for a connection not yet set up are kept, surplus dropped
silently, counted across every pending connection id together where the
CLI's held-candidate cap above is per connection. The two apps define both
values separately.

The browser peer has no counterpart to the CLI's cap on applied candidates:
PeerJS hands every `CANDIDATE` it reads to the peer connection's
`addIceCandidate` as it arrives, and capping that means wrapping a PeerJS
internal, so it is a stated limit rather than a bound. Each candidate is held
to the signaling frame bound; how many are applied is left to the browser's
own ICE agent.

## See also

- [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) - the
  normative rendezvous peer-id derivation both implementations reproduce.
- [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound) -
  the inbound reassembly bound and the AEAD envelope.
- [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown) - the
  delivery contract every channel owes.
- [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) - why `peerjs` and `werift` are
  exact-pinned, the behavioural assumptions they rest on, and how to re-verify them.
- [cli-webrtc-stack.md](../notes/cli-webrtc-stack.md) - the library decision and
  the alternatives weighed.
