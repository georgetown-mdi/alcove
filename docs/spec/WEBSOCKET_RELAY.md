---
title: "WebSocket Relay"
---

# WebSocket relay

This document specifies the wire of the WebSocket relay (`packages/websocket-relay`): its endpoint, the frames a party and the relay exchange, how the relay pairs, forwards and closes, its close codes, its bounds, and the web application's and the command-line application's clients.
It is the implementation-level complement to [WebSocket relay](../DESIGN.md#websocket-relay) in DESIGN.md, which says what the relay is for and what its operator is in a position to see.
It does not cover the proof a hello presents (see [The WebSocket relay proof](PROTOCOL.md#the-websocket-relay-proof)) or the framing of the messages it forwards (see [WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#framing)).
The design and the rulings behind it are in [web-websocket-transport.md](../notes/web-websocket-transport.md).
Intended readers are implementors of a relay client, whoever deploys the relay, and security auditors.

Every constant below is in `packages/websocket-relay/src/protocol.ts` unless another file is named.
Each is a working value, raised or lowered on request.

## The endpoint

- **The path.** A party opens a WebSocket at `/relay` (`RELAY_PATH`); a query string is ignored. An upgrade on any other path is answered `404` and closed, and so is a plain HTTP request.
- **No extension.** The relay negotiates no per-message compression.
- **Before the upgrade.** The relay applies the signaling broker's pre-upgrade bounds: a 10-second header timeout, a 15-second request timeout, and a 10-second idle bound on a socket that has not completed its request ([SIGNALING_SERVER_BOUNDS.md](SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds); `packages/peerjs-broker/src/standaloneUpgradeBounds.ts`).
- **Sockets awaiting a hello.** The relay holds at most 48 sockets whose hello has not verified (`RELAY_MAX_UNVERIFIED_SOCKETS`), each counted from its upgrade until its hello verifies or its socket closes. An upgrade above that is answered `503` and closed before the WebSocket opens. The value is four times the 12 concurrent pairings ([Quotas](#quotas)): two hellos a pairing, twice over.
- **No quota for each address.** The relay counts nothing by client address, since behind the reference deployment's front every connection arrives from `127.0.0.1`. That front bounds the relay's sockets from each client address instead ([infra/relay/README.md](../../infra/relay/README.md#the-websocket-relay), Quotas): it closes a socket past the bound before answering it, so that party sees a closed connection, not a `503`. Behind a front with no such bound, one client can hold every socket the cap above allows and keep other parties out for as long as it keeps opening sockets, each of which the relay refuses after the 10-second hello window and closes at most 10 seconds later.
- **No TLS.** The relay terminates none, so a deployment reachable off its host puts it behind a front that does.
- **No outbound connection.** The relay opens no connection of its own, and no frame names a target. A check holds the relay's source to the modules and names that accept a socket and never dial one (`packages/websocket-relay/test/noOutboundConnection.test.ts`); it reads what the source spells, so it is a safety check, not a proof.

## Frames

A control frame is a WebSocket text message holding one JSON object, read through the bounded JSON parse of [PARSED_INPUT_BOUNDS.md](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds).
It holds exactly the keys shown, in any order.
The exchange's own messages are binary messages.

| Frame | Sent by | Text |
| --- | --- | --- |
| hello | a party, as its first message | `{"type":"hello","exchangeId":<id>,"role":<role>,"proof":<message>,"tag":<hex>}` |
| start | a party, once, after its hello | `{"type":"start"}` |
| paired | the relay, to both parties, once both hellos have verified | `{"type":"paired"}` |
| start | the relay, to a party whose partner has sent its start | `{"type":"start"}` |

## The hello

- **`exchangeId`.** The id the exchange's relay key is enrolled under, 1 to 128 of `[A-Za-z0-9._-]`, not starting with `-`: the key lookup of [The WebSocket relay proof](PROTOCOL.md#the-websocket-relay-proof).
- **`role`.** The role the party claims, `inviter` or `acceptor`.
- **`proof`.** The proof's signed message as a string: its three fields joined by LF, which JSON writes as `\n`.
- **`tag`.** The proof's 32-byte tag as 64 lowercase hex characters.

A party sends its hello as its first message, within 10 seconds of the upgrade (`RELAY_HELLO_TIMEOUT_MS`).
It may send its start directly behind the hello; a second message before the relay has checked the hello is refused (4002).

The relay checks a hello in this order, refusing at the first check it fails with the code in brackets:

1. **Its form.** Any other first message, a hello with another key or a value outside the forms above, and a hello whose proof does not parse ([What a check refuses](PROTOCOL.md#the-websocket-relay-proof)) are refused as malformed (4001).
2. **The key.** The relay reads the relay key enrolled under `exchangeId` ([The key table](#the-key-table)). No key is refused as not enrolled (4003). A hello the relay could not check is refused with 1011: its key table could not be read, the enrolled key is not 64 lowercase hex characters, or the check failed in some other way.
3. **The proof.** The relay checks the proof under the proof key derived from that relay key, for the claimed role, against its own clock. A proof for the other role, or whose tag is not the proof key's, does not verify (4004). A proof whose expiry has passed is expired (4005), and the close reason is the relay's current Unix second in decimal, so a party whose clock has drifted can make another.
4. **The role.** A socket already holding the claimed role under that relay key refuses this one as role taken (4006), the broker's `ID-TAKEN` for this path.
5. **The cap.** A hello under a relay key that holds no pairing yet, while the relay holds as many pairings as its cap ([Quotas](#quotas)), is refused as full (4008).

**Replay.** The hello does not bind the proof to its connection, since the proof's message holds only the role and the expiry.
A captured hello replayed before its expiry, at most 300 seconds after it was made, can take the role under the key first, and the party it was captured from is then refused as role taken.
It exposes no data: the key exchange inside the relayed channel still needs the shared secret.

## The key table

- **Where.** The relay reads the per-exchange keys from the SQLite file coturn reads its secrets from ([infra/relay/README.md](../../infra/relay/README.md#per-exchange-keys)): the runner's `--key-table`, else `ALCOVE_RELAY_TURNDB`, else `/var/lib/alcove-relay/turndb`.
- **Which key.** The key the `alcove_exchange` table maps the exchange id to, while coturn's `turn_secret` table still holds that key, so the relay admits the keys coturn admits. A file with no `alcove_exchange` table enrolls no exchange.
- **How.** The relay reads the file through one read-only handle, opened at the first hello and kept, and writes nothing. It opens the file again after a read that failed, and when the file at the path is no longer the one the handle holds, as when another file replaces it.
- **What a hello costs.** Each hello the relay checks costs a `stat` of the file and two reads through the handle, and an open when one is due. They run synchronously, so a hello that meets a writer holding the table's lock holds up forwarding for every pairing for at most 100 milliseconds (`KEY_TABLE_BUSY_TIMEOUT_MS` in `packages/websocket-relay/src/keyTable.ts`), and is then refused with 1011.
- **A lapsed or revoked key.** A lapsed row is admitted until the sweep removes it, as coturn admits it. Removing a key refuses each later hello under it and ends no pairing already formed, as coturn ends no open allocation.
- **A table it cannot read.** Every hello is refused with 1011. The relay reports it on its diagnostic stream when reads start failing, and again only after one has succeeded.
- **A malformed key, or another failure.** A hello under a key that is not 64 lowercase hex characters is refused with 1011, and the relay reports it at most once a minute for each exchange id (`RELAY_FAULT_REPORT_WINDOW_MS`), the signaling broker's diagnostics window. Any other failure to check a hello is refused with 1011 and reported at most once a minute for the whole relay, since the sender chooses the exchange id.

## Pairing and the start

- **Pairing.** The relay pairs the two sockets whose hellos verified under one relay key with opposite roles, and sends each `paired`.
- **The start.** Each party sends `start` once. The relay sends a party its partner's start as it arrives, or directly behind `paired` when the partner sent it first.
- **Nothing before both starts.** The relay forwards nothing until both parties have sent their start. A binary message before then, a second start, a second hello, and any other text frame are refused (4002).
- **The first binary message.** A party sends it only once it has sent its own start and received its partner's.
- **The end of a pairing.** A pairing ends at the first close of either socket, and the key may then pair again.

## Forwarding

- **Unread.** Once both parties have started, the relay forwards each binary message to the partner as one binary message, unread. A text message is then refused (4002).
- **The per-message cap.** 16,384 bytes (`RELAY_MAX_MESSAGE_BYTES`): the 16,300-byte chunk the framing splits a frame at and the 58 bytes its widest chunk envelope adds, rounded up to 16 KiB. A message above it, a hello included, is refused with 1009 before its payload is read, so the relay holds one chunk a socket and never a frame.
- **The per-message fragment limit.** A message in more than one WebSocket frame (`RELAY_MAX_MESSAGE_FRAGMENTS`, 1) is refused: `ws` closes its sender with 1008, and the relay closes the partner with 4000 and forwards nothing. The clients send each message as one frame ([Measured fragments](#measured-fragments)).
- **Backpressure.** While the messages queued toward the partner count above 1 MiB (`RELAY_SEND_BUFFER_HIGH_BYTES`) the relay reads nothing from the source, and it reads again once they count at or below 256 KiB (`RELAY_SEND_BUFFER_LOW_BYTES`): the window the CLI's own send path uses ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#outbound-pacing)). The messages already read when reading stops are forwarded. A source held this way waits on its own TCP window and is not disconnected.
- **What a queued message counts.** Each message queued toward a party counts its payload, its frame header, and 1,024 bytes for the memory its queue entry holds (`QUEUED_MESSAGE_OVERHEAD_BYTES` in `packages/websocket-relay/src/forwarding.ts`), measured with Node v26.13 and the pinned `ws` and rounded up. A ping answer queued toward a party counts the same way ([Keepalive](#keepalive)). The relay queues each message, and its frame header, in memory of its own size, so a queued message holds neither the read it arrived in nor a shared pool block.
- **What a read-ahead counts.** A paused socket reads on until its buffer reaches its read high-water mark, in chunks held beyond their own bytes: each chunk counts 256 bytes (`READ_CHUNK_OVERHEAD_BYTES` in `packages/websocket-relay/src/forwarding.ts`), measured on Node v26.13 at about 219 bytes for one- and two-byte chunks and rounded up. The relay's HTTP server sets that mark to 1 byte for each socket it accepts (`RELAY_READ_HIGH_WATER_MARK_BYTES`, the `highWaterMark` option of Node's `http.createServer`), so a paused source stops reading at its first read. Its read-ahead is then at most one 64 KiB read in two chunks, 66,049 bytes (`RELAY_PAUSED_READ_AHEAD_BYTES`), where Node's default 64 KiB mark allows 16,908,544 bytes (`PAUSED_READ_AHEAD_BYTES`).
- **The queue limit.** Once the messages queued toward a party count above 1,310,720 bytes (`RELAY_QUEUE_LIMIT_BYTES`, 1.25 MiB), the relay ends the pairing. It closes the party that sent them with 4010, and the party they are queued for with 4000 behind every message already queued for it, and forwards nothing more. The limit is 256 KiB over the high mark, set from the counted queues of honest rounds ([Measured counted queues](#measured-counted-queues)). Since each message counts its 1,024 bytes of overhead, a run of small messages passes the limit on a few kilobytes of payload, so the relay keeps no separate limit on the number of messages. For the same reason a burst of small messages in one read can pass the limit and end the pairing even toward a party that reads at once: 1,277 one-byte messages, each counted 1,027 bytes, pass it, and one 64 KiB read holds thousands of them. The clients send no such burst, as the honest rounds show ([Measured counted queues](#measured-counted-queues)).
- **The queued-message bound.** The relay holds at most 1,738,245 bytes (`RELAY_QUEUED_BOUND_BYTES`) for one party's queue and its source. That is the queue up to the limit, the one message whose queueing passes it, counted as above, the read the relay is parsing, a message still arriving, and the paused source's read-ahead. A message still arriving counts four 64 KiB reads, 262,144 bytes, and its later pieces, up to the 16,384-byte cap ([Measured fragments](#measured-fragments)). When a held source closes, the relay forwards its read-ahead too, but only until the queue passes the limit.
- **The restated bounds.** A pairing's two parties together are at most 3,476,490 bytes, and the 12 pairings the relay holds at once ([Quotas](#quotas)) at most 41,717,880 bytes. The relay counts nothing by client address ([The endpoint](#the-endpoint)); behind the reference deployment's front, which holds at most 8 sockets from one address, that address's sockets reach at most 8 such bounds, 13,905,960 bytes. These bounds hold for the server `createWebSocketRelayServer` makes, which the standalone runner uses; a relay attached to another server reads ahead under that server's own mark.
- **How long a queue outlives its source.** A source held at the high mark reads nothing, its own close included, so the relay notices the close only when a ping to it fails, at or after its next ping (30 seconds, `RELAY_PING_INTERVAL_MS`). The queue toward the stalled reader is then held for the close wait (300 seconds, `RELAY_CLOSE_WAIT_MS`) before the reader is dropped. Measured at about 357 seconds from the source's close to the reader's drop at those two values.

## Quotas

The relay bounds what one exchange can use, as coturn's `user-quota`, `total-quota` and `max-bps` bound its allocations ([webrtc-relay-deployment.md](../notes/webrtc-relay-deployment.md#quotas-against-one-exchange)).
The quotas key on the exchange's relay key, not on a client's address: behind the reference deployment's front every connection arrives from `127.0.0.1`.

| Quota | Value | What it bounds |
| --- | --- | --- |
| Pairings a key | 1 | Each of a key's two roles holds one socket, so a further socket under a held role is refused (4006) |
| Concurrent pairings | 12 (`RELAY_MAX_PAIRINGS`) | The pairings the relay holds at once, each counted from its first verified hello until every socket it admitted has closed, the close wait included. A hello that would start one more is refused (4008); one joining a pairing already held is not. A new pairing under a key ends at once the sockets the key's earlier pairing still holds, so a key holds at most one pairing's sockets; a socket ended this way loses any message still queued to it and closes abnormally (1006) |
| Byte rate | 2,000,000 bytes a second from each party of a pairing (`RELAY_PAIRING_BYTES_PER_SECOND`), after a burst of 2,000,000 bytes (`RELAY_PAIRING_BURST_BYTES`) | A party that sends faster is not read again until the rate has paid back the excess, as backpressure holds a source, so it is paced and not disconnected. coturn's `max-bps` |
| Idle bound | 65 minutes (`RELAY_IDLE_TIMEOUT_MS`) | A pairing no message has crossed either way for that long, a party still waiting for its partner included, is closed with 4009 on each socket. A ping or a pong is not a message here. The bound is checked at each ping, so it closes a pairing up to 30 seconds late. The one-hour parked-receive budget plus the five-minute close drain budget ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#budgets)), so a party's own budget expires first |

**A stated limit: every rendezvous holds a pairing.** A party parks its socket on each relay its run lists as its rendezvous starts ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)), so every rendezvous that names the relay counts toward the concurrent pairings from its first verified hello until its sockets close, a rendezvous that WebRTC carries included. One past the cap is refused (4008) and has no fallback through this relay, while its WebRTC path still runs. The cap has not been measured against that use.

## Keepalive

- **A party's ping.** The relay answers it with a pong and forwards nothing, counting the answer toward the ping sender's queue like a message and answering only when the answer fits under the high mark ([Forwarding](#forwarding)); the library's own automatic answer is off.
- **The relay's ping.** The relay pings every socket it holds every 30 seconds (`RELAY_PING_INTERVAL_MS`), a tenth of the 300-second idle timeout of the reference deployment's front, since a browser's `WebSocket` cannot send a ping but answers one.

## Close

- **Order.** One party's close closes its partner behind every message already queued for the partner.
- **The code.** A close with code 1000, or with no code, closes the partner with 1000. Any other end of a party's socket, a refusal included, closes the partner with 4000. A party closes with 1000 only on a clean close, so its partner never takes a failure for delivery.
- **The wait.** A partner closed this way has 300 seconds, the close drain budget ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#budgets)), to read what is queued for it and answer the close, and is then dropped (`RELAY_CLOSE_WAIT_MS`). A socket the relay refuses has 10 seconds (`RELAY_REFUSAL_CLOSE_WAIT_MS`).
- **Delivery.** TCP acknowledges a message to the relay, not to the partner, so a party knows its last message reached the partner only when the partner's close reaches it through the relay ([COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)). When both parties close at once, the party whose close the relay reads first receives the relay's own close in answer. Its confirmation states that the relay received its frames and forwarded them in order, not that the partner read them; the other party's confirmation is the partner's close, as stated.

## Close codes

Every close reason is empty except 4005's.

| Code | Sent to | Meaning |
| --- | --- | --- |
| 1000 | the partner | The other party closed normally |
| 1001 | every socket | The relay is shutting down |
| 1008 | the sender | A message in more than one frame, closed by `ws`; the partner is closed with 4000 |
| 1009 | the sender | A message above the per-message cap |
| 1011 | the sender of a hello | The relay could not check the hello: its key table could not be read, the enrolled key is malformed, or the check failed |
| 4000 | the partner | The other party's socket ended without a normal close, or the relay refused it |
| 4001 | the sender | The first message was not a well-formed hello |
| 4002 | the sender | A message the relay does not take at that point |
| 4003 | the sender | No relay key is enrolled under the hello's exchange id |
| 4004 | the sender | The proof does not verify under the exchange's relay key for the claimed role |
| 4005 | the sender | The proof has expired; the reason is the relay's current Unix second |
| 4006 | the sender | Another socket holds the claimed role under the exchange's relay key |
| 4007 | the sender | No hello within 10 seconds of the upgrade |
| 4008 | the sender of a hello | The relay holds as many pairings as its cap |
| 4009 | both parties | No message crossed the pairing within the idle bound |
| 4010 | the sender | The messages it sent that its partner has not read counted above the queue limit; the partner is closed with 4000 |

## Measured round at the largest exchange size

Measured 2026-10-26 in the development container (10 cores, 23 GB; aarch64 Linux, Node v26.12.1), with other workloads running beside it, load average 5.88 at the start.
One round of 539,000,000 bytes, the largest measured exchange's size, went one way through the relay's standalone process between two of the command-line client's relay connections, in three frames, in 274.3 s, and the relay's resident set peaked at 97.5 MB, from 83.1 MB idle.
`apps/cli/test/stress/websocketRelayRound.stress.test.ts` drives the round in the CLI's opt-in stress tier (`npm run test:stress -w apps/cli`), and needs no built CLI.

## Measured counted queues

Measured 2026-11-01 in the development container (10 cores, 23 GB; aarch64 Linux, Node v26.13.0), with other workloads running beside it.
Each round went one way through the relay's standalone process between two of the command-line client's relay connections, as the round above, with the receiving party in a process of its own, which was suspended for a while in some rounds.
The relay's process read the counted queue, as [Forwarding](#forwarding) counts it, after each message it queued, through a probe outside the repository.

| Round | Receiving party | Largest counted queue |
| --- | --- | --- |
| 10,000,000 bytes | read throughout | 5,120 bytes |
| 50,000,000 bytes | suspended for 10 s | 1,076,506 bytes |
| 539,000,000 bytes, twice, once with the queue limit | read throughout | 5,120 bytes |
| 539,000,000 bytes | suspended for 30 s | 1,059,143 bytes |
| 539,000,000 bytes, with the queue limit | suspended for 45 s | 1,093,869 bytes |

Every round arrived intact, and neither round run with the queue limit ended its pairing.
A party that reads keeps its queue near empty.
A suspended party's queue passed the 1 MiB high mark by at most 45,293 bytes, the messages already read when the relay held their source.
The queue limit is 216,851 bytes above the largest of these.

### Measured fragments

Measured 2026-11-01 through probes outside the repository: Node's `ws` client (`ws` 8.22.0, Node v26.13.0) and Chromium 156 in the development container, and Firefox 159.0 and Safari 26.6.2 on a macOS host.

- **Frames a message.** Every client measured, Node's `ws` client, Chromium, Firefox and Safari, sent each relay-sized message, up to 16,384 bytes, as one frame. Chromium first splits a message above 65,536 bytes, four times the cap; Firefox and Safari split none up to 4,194,304 bytes.
- **What `ws` keeps of a message still arriving.** `ws` keeps each piece of an incomplete message as the read it arrived in, so a piece keeps its whole read alive, up to 65,536 bytes, until the message completes. With the limit at one frame, measured through the relay's own code with the partner never reading and the read that ends a piece full (64 KiB), the ArrayBuffers retained were:
  - one 1-byte fragment (not final) whose frame ends a read: 65,514 bytes;
  - one 16,384-byte frame whose first piece ends a read and whose rest arrives in four smaller reads, the last byte withheld: 81,805 bytes, 65,514 for the read and 16,291 for the later pieces;
  - the same fragment, then a continuation frame of 16,383 bytes whose first piece ends the next read and whose rest arrives in four smaller reads, the last byte withheld: 147,340 bytes, 131,050 for the two reads and 16,290 for the later pieces;
  - the same layout driven through the relay's own code in `packages/websocket-relay/test/retainedMemory.test.ts`, the memory retained beyond the 65,513 bytes queued toward the partner: about 136 KB to 236 KB over seven runs, with an extra read alive in alternate runs.

  The queued-message bound counts four reads and the 16,384-byte cap, 278,528 bytes, for a message still arriving, to cover that range. A frame that fits one read, as every client's does, completes within it and keeps nothing once the relay has copied it.
- **The limit.** With the limit at one frame, a message in two fragments closed its sender with 1008 and the partner with 4000, and forwarded nothing; a message in one frame was forwarded intact (`packages/websocket-relay/test/relay.test.ts`).

## The web application's client

The web application's relay transport (`apps/web/src/psi/transport/websocketRelayConnection.ts`) is one party's side of this wire.
Its values are working values, as the relay's are.

- **The hello.** It opens the relay's `wss` url and, on open, sends its hello. It refuses a url that has a fragment, which a WebSocket url cannot have, before opening a socket. Each socket it opens sends a hello with a new proof, which expires 300 seconds after it is made, the longest lifetime [The WebSocket relay proof](PROTOCOL.md#the-websocket-relay-proof) allows.
- **The start, held.** It holds its start until the run sends it (`parkWebSocketRelayConnection`), on a socket the relay has paired or not, and sends it behind the hello on each socket that opens after that. Opened with the start already sent (`openWebSocketRelayConnection`), it sends its hello and then its start, with no wait between them.
- **The partner's start first.** A start the relay sends while this side's own is held is kept, and this side's start then begins the exchange at once. Until the exchange begins, it refuses a binary message, a start before `paired`, a second `paired` or start, and any other text message, closing its socket with 4000. Once the exchange has begun, it refuses any text message.
- **Dialing again.** Until the exchange begins and while the rendezvous budget below lasts, it opens a new socket 5 seconds after its socket closes with one of these codes (`RELAY_REDIAL_INTERVAL_MS`, an arbitrary working value):
  - 4003, since the partner may enroll the exchange's key later;
  - 4006, since an earlier socket of this side may still hold the role;
  - 1000 or 4000, the partner leaving the pairing;
  - 4009, the relay's idle bound;
  - any code the [Close codes](#close-codes) table does not list, as when the connection drops, and a socket that does not open within 30 seconds (`DEFAULT_RELAY_OPEN_TIMEOUT_MS`, an arbitrary working value).

  Every other close ends the attempt, and so does any close once the rendezvous budget has ended.
- **An expired proof.** On a 4005 whose reason is a decimal second a JavaScript `Date` can hold, it opens a new socket at once with a proof made at that second, the relay's clock, and makes every later proof on that clock. A second 4005 ends the attempt, as does a 4005 whose reason is not such a second. A second so near the end of that range that a later proof time falls past it ends the attempt with the error for a proof this side could not build, which points at the invitation rather than the relay.
- **The waits.** It waits 10 minutes for `paired`, the WebRTC rendezvous budget, counted from the park across every socket it opens. Once paired with its own start sent, it waits 30 seconds for the partner's start, the channel-open budget ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#budgets)). A pairing whose start it holds has no wait of its own. When the rendezvous budget ends with a socket waiting for `paired`, it reports that the partner did not arrive, and otherwise the last close it dialed again on, or, with none, that it could not connect.
- **An unused socket.** Closed before the exchange begins, it closes its socket with 1000 while its start has not been sent on it, and with 4000 once it has, since a partner that has read the start may hold a started connection that must not take the close for delivery.
- **The framing.** Each binary message is one datagram of the WebRTC framing, written by core's encoder and read through core's bounded reassembler with its caps ([TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md#webrtc-data-channel-inbound-bound)).
- **Pacing.** It stops handing a frame's datagrams to the socket while the socket's `bufferedAmount` is at or above 1 MiB, and resumes once it is at or below 256 KiB, the CLI's window ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#outbound-pacing)). A browser `WebSocket` raises no event as its buffer drains, so a waiting send reads `bufferedAmount` every 50 milliseconds.
- **The clean close.** It sends the close sentinel behind its last frame and waits up to 5 minutes, the close drain budget, for the partner's close to reach it through the relay or for the partner's own sentinel. On reading the partner's sentinel it closes its socket with 1000, the signal the partner's own close waits for. Any other end of its socket, an error or a wait that ran out, closes with 4000.
- **Keepalive.** It sends no ping, since a browser `WebSocket` cannot; the relay's pings keep its socket open through a parked receive ([Keepalive](#keepalive)).

## The command-line client

The command-line application's relay transport (`apps/cli/src/connection/webrtc/websocketRelayConnection.ts`) is one party's side of this wire, on Node's own `WebSocket` client.
Its values are working values, as the relay's are.

- **The hello.** On open, it sends its hello. Each socket it opens sends a hello with a new proof, which expires 300 seconds after it is made, the longest lifetime [The WebSocket relay proof](PROTOCOL.md#the-websocket-relay-proof) allows.
- **The start, held.** It holds its start until the run sends it (`parkWebSocketRelay`), on a socket the relay has paired or not, and sends it behind the hello on each socket that opens after that. Opened with the start already sent (`openWebSocketRelayMessageConnection`), it sends its hello and then its start, with no wait between them.
- **The partner's start first.** A start the relay sends while this side's own is held is kept, and this side's start then begins the exchange at once. Until the exchange begins, it refuses a binary message, a start before `paired`, a second `paired` or start, and any other text message, closing its socket with 4000.
- **Dialing again.** Until the exchange begins and while the rendezvous budget below lasts, it opens a new socket 5 seconds after its socket closes with one of these codes (`RELAY_REDIAL_INTERVAL_MS`, an arbitrary working value):
  - 4003, since the partner may enroll the exchange's key later;
  - 4006, since an earlier socket of this side may still hold the role;
  - 1000 or 4000, the partner leaving the pairing;
  - 4009, the relay's idle bound;
  - any code the [Close codes](#close-codes) table does not list, as when the connection drops, and a socket that does not open within 30 seconds.

  Every other close ends the attempt, and so does any close once the rendezvous budget has ended.
- **An expired proof.** On a 4005 whose reason is a decimal second a JavaScript `Date` can hold, it opens a new socket at once with a proof made at that second, the relay's clock, and makes every later proof on that clock. A second 4005 ends the attempt, as does a 4005 whose reason is not such a second.
- **The waits.** It waits 10 minutes for `paired`, the WebRTC rendezvous budget, counted from its first socket across every socket it opens. Once paired with its own start sent, it waits 30 seconds for the partner's start, the channel-open budget ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#budgets)). A pairing whose start it holds has no wait of its own. When the rendezvous budget ends with a socket waiting for `paired`, it reports that the partner did not arrive, and otherwise the last close it dialed again on, or, with none, that the relay did not answer.
- **An unused socket.** Closed before the exchange begins, it closes its socket with 1000 while its start has not been sent on it, and with 4000 once it has, since a partner that has read the start may hold a started connection that must not take the close for delivery.
- **The exchange's messages.** It frames and paces them as the web application's client does, through the same core encoder and reassembler and the same window, a waiting send reading `bufferedAmount` every 10 milliseconds. Node's `WebSocket` answers the relay's pings and sends none.
