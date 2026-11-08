---
title: "Liveness Through a Partner's PSI Step: Plan"
---

# Liveness through a partner's PSI step: plan

*Status: plan only, nothing built.
The interval and the silence bound are working values until the browser figures below are measured.
Each answer under "Answers proposed" is a proposal for the maintainer's ratification.
See [docs/notes/README.md](README.md).*

A party waiting through its partner's PSI step waits in silence for a time derived from the two parties' counts ([WEBRTC_TRANSPORT.md, The wait through a partner's PSI step](../spec/WEBRTC_TRANSPORT.md#the-wait-through-a-partners-psi-step)).
At the browser's receive ceiling that wait is 8,439.4 s, and a partner that has stopped looks the same as one still computing until it ends.
This plan replaces it: the computing party sends a small message at a fixed interval, and the waiting party ends the run only when those messages stop.

## What exists, checked at staging 9232a4c74

- **PSI already runs off the thread that owns the connection.**
  The browser runs it in Web Workers (`apps/web/src/psi/workers/psiCryptoController.ts`, `psiWorkerPool.ts`), the CLI in a worker thread (`apps/cli/src/psiWorkerHost.ts`, core `psi/psiWorkerEngine.ts`).
  No thread move is needed.
- **Progress already reaches core on that thread.**
  Each worker posts a processed-count report between chunks, and `PSIParticipant` hands it to `onPsiProgress` in core (`packages/core/src/psi/participant.ts`).
  The sender below can therefore live in core alone, in the PSI phase (`packages/core/src/exchange/psiPhase.ts`).
- **The stale comment.**
  `DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS` in `apps/web/src/psi/transport/peerMessageConnection.ts` says the peer's compute is single-threaded and sends no keepalive; the first half is wrong in both apps.
- **Sends must not overlap.**
  `EncryptedMessageConnection` supports one `send()` at a time, since two would race its per-direction sequence counter, which is the AES-GCM nonce.
  A timer-driven send needs a queue in front of it.
- **The local stall check covers split operations only.**
  `BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS` (33 min) fails a pool worker that stops reporting.
  The one-worker browser path and the CLI have no such check.

## Measurements

Run 2026-11-08 in the development container (aarch64 Linux, 10 CPUs, Node v26.13.0) with a local script, not kept in the tree.
It drives core's `InProcessPsiEngine` through `observeProcessedElements` for each of the four identifier-revealing operations and records the gap between consecutive progress reports.
Commands: `node measure.mjs native 200000`, `node measure.mjs native 2000000`, `node measure.mjs wasm 100000`.
The one-minute load average was 1.2 to 11 during the runs.

| Backend | Set | Reports per operation | Longest gap | Per element in that gap |
| --- | --- | --- | --- | --- |
| Native addon (the CLI's) | 200,000 | 4 (5 chunks) | 0.52 s over 40,000 | 0.0131 ms |
| Native addon | 2,000,000 | 4 | 5.8 s over 400,000 | 0.0146 ms |
| WebAssembly under Node | 100,000 | 4 | 12.1 s over 20,000 | 0.606 ms |

The browser figure is the spec's: 0.58 ms an element in the longest gap, measured in Chrome for Testing in this container ([PROTOCOL.md](../spec/PROTOCOL.md), "The progress timeout").
No browser is installed in this container, so it was not re-measured.

What the figures decide:

- **Progress reports are too sparse to be the signal.**
  An operation reports at each fifth of its set (`PSI_CHUNK_TARGET_COUNT`).
  At the browser's ceiling one worker masks 1,677,722 elements a chunk: about 973 s between reports at 0.58 ms, and 1,017 s at the WebAssembly figure above.
  A silence bound set from that cadence would be close to an hour, no better than the transport default.
  The message is therefore sent on a timer, and the progress count is not forwarded.
- **The transports already detect a lost link.**
  The CLI's peer reports a vanished partner in about 30 s by consent freshness (measured, [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-behavioural-assumptions)).
  The WebSocket relay pings every 30 s (`RELAY_PING_INTERVAL_MS`) and drops a socket 90 to 120 s after its last answer ([WEBSOCKET_RELAY.md, Keepalive](../spec/WEBSOCKET_RELAY.md#keepalive)).
  How long Chromium takes to report a lost partner mid-exchange is not measured.
  What none of them sees is a partner whose link is up and whose run has stopped: a frozen tab, or a page whose main thread no longer runs.
- **Holds on the sending thread.**
  The CLI's longest measured main-thread hold on an open channel is about 12 s ([WEBRTC_TRANSPORT.md, The main thread on an open channel](../spec/WEBRTC_TRANSPORT.md#the-main-thread-on-an-open-channel)).
  The browser main thread's longest hold is not measured.
- **A frame in transit has no message beside it.**
  The largest frame is 268,435,456 bytes; at werift's measured send rate of 1.42 MiB/s ([cli-webrtc-stack.md](cli-webrtc-stack.md)) it takes about 180 s, and at the relay's 2 MB/s cap about 134 s.
  A slower link takes longer, with no floor measured.

## The design

- **The message.**
  A still-working frame: the JSON object `{"working":true}`, exactly that, sent inside the encrypted stream like every frame after the key exchange.
  It states nothing but its presence.
- **Who sends it, and when.**
  Each party sends one when its PSI phase starts, then one whenever 30 s have passed since it last sent any frame, until it sends its last frame of the phase.
  It stops the timer, and waits for a still-working send in flight, before sending that last frame, so none arrives after it.
  A queue in front of `send()` keeps a still-working send and a data send from overlapping.
- **The waiting side.**
  A connection wrapper in the PSI phase, following `afterFirstFrameNotAbort` in `packages/core/src/partnerAbortFrame.ts`, drops each still-working frame and receives again.
  The partner's first still-working frame arms the silence bound, 120 s, on the transport's parked receive; the partner's last PSI-phase frame disarms it.
  Before it arms, the transport's default budget (1 h) applies, which covers a partner still at a human step after the terms exchange.
- **Bytes of a frame count as activity.**
  Each accepted chunk of a frame being reassembled restarts the 120 s bound, so a 256 MiB frame on a slow link is not cut off.
  The whole-frame budget (1 h by default) still runs beside it, so a relay that trickles bytes cannot hold a run open past it.
  The hook goes into core's reassembler (`packages/core/src/connection/webrtcInboundBounds.ts`, used by the CLI's peer and both relay clients) and the web's PeerJS wrapper (`apps/web/src/psi/transport/boundedReassembly.ts`).
- **Where it is refused.**
  A still-working frame is dropped from the end of the terms exchange until the partner's last PSI-phase frame, and is a `protocol` error anywhere else, as is any other object with a `working` key.
- **The failure.**
  Reaching the 120 s bound ends the run with a new cause in core's catalog (`packages/core/src/failureCause.ts`, [failure-cause-catalog.md](failure-cause-catalog.md)): the partner stopped responding during matching, and to ask the partner to check their run and start again.
  It maps to the same exit code as the peer-inactivity failure.
- **What retires.**
  `partnerStepWaitMs` (`packages/core/src/connection/partnerStepWait.ts`), its raise in the PSI phase, and `raiseInactivityTimeout`, unless the implementer finds a send's hand-off that waits through a partner step; then that hand-off takes the same armed bound.
  An operator's `inactivity_timeout_ms` keeps setting the whole-frame budget and does not change the 120 s bound.

### The interval and the bound

- **Interval, 30 s.**
  The cadence at which the transports already check a link: the relay's ping, and the CLI's consent-freshness detection.
  The inbound queue sets a floor: a party computing its longest step does not receive, so frames queue, and the queue admits 1,024 (`DEFAULT_CAPACITY`, `messageConnection.ts`).
  The longest step the derived wait admits is 16,878.8 s, so the interval must exceed 16.5 s; at 30 s at most 563 queue.
- **Silence bound, 120 s.**
  It must exceed the interval plus the longest delay on the sending thread: 30 s, plus the 12 s CLI hold, plus up to 60 s if Chrome delays a hidden tab's timers to once a minute, a throttling not verified here and not measured in this container.
  That is 102 s; 120 s is four intervals, the tolerance the relay applies to its own pings.
- **Both are working values.**
  Neither rests on a measurement of the message's delivery.
  The figures still needed, each in a real browser on the x86-64 host: the gap between still-working frames sent from a hidden tab through a step of an hour or more, the browser main thread's longest hold at the ceiling, and whether Chrome freezes a tab with an open data channel.
  If the hidden-tab gap exceeds 90 s, the timer moves into a worker, whose timers the page's throttling does not reach.

## Answers proposed

### Interval and silence bound: from what measurement

A proposal for ratification: 30 s and 120 s, from the measurements above.
The user waiting on a large browser run learns of a stopped partner within two minutes instead of up to 2 h 21 min, and can start again the same session.
The interval is tied to the transports' own checks, not to the sizes, because the question answered is whether the partner is still there, not how long its step takes.

### File-sync

A proposal for ratification: this stays WebRTC and the WebSocket relay only.

- **The user has a remedy.**
  A file-sync party is a CLI operator, who can set `inactivity_timeout_ms`; a browser user has no setting, which is why the browser case needs the message.
- **The steps are short on the CLI's own backend.**
  At the native rate above, an operation over 2^24 elements runs about 245 s, far inside the 1 h default.
  Only the WebAssembly fallback, on a platform with no native prebuild, runs a step past the hour at that size.
- **Each message is a file.**
  Every 30 s it would be a write, a listing, a read, and a delete on a server or a synced folder the parties may not run, and a synced folder's propagation delay would push the bound to minutes anyway.

### Mixed builds before 1.0

A proposal for ratification: neither a refusal nor a fallback; nothing, as for every wire change before `1.0.0` ([Wire-format deltas](../spec/PROTOCOL.md#wire-format-deltas-existing-frames-only-and-no-version-bump), [RELEASES.md, Compatibility policy](../RELEASES.md#compatibility-policy)).
How each pair behaves:

| Sender | Receiver | Outcome |
| --- | --- | --- |
| This build | This build | As designed |
| This build | Earlier | The earlier build reads the first still-working frame as the frame it awaits and fails with a `protocol` error at the start of the PSI phase |
| Earlier | This build | No still-working frame arrives, so the bound never arms; a partner step past the 1 h default ends on the peer-inactivity refusal, as before the derived wait |

The argument from the user:

- **The pair is short-lived.**
  The hosted web app offers its waiting update and applies it, so a mixed pair is a tab left open on an old build or a CLI image not yet pulled.
- **A fallback buys little.**
  It would keep the derived wait in code for the one direction it can help, while the other direction still fails.
- **A refusal needs a new field.**
  It needs a capability on the wire and its negotiation, for a window that closes at the next upgrade.
  From `1.0.0` the version bump gives the hello's refusal before any round.

### The standing relay's idle limit

A proposal for ratification: set `RELAY_IDLE_TIMEOUT_MS` (`packages/websocket-relay/src/protocol.ts`) to the clients' default parked-receive budget plus the close drain, 3,900 s, instead of the derived wait at the ceiling plus the drain (8,739.4 s).

- A still-working frame is a message to the relay, which counts messages and not pings ([WEBSOCKET_RELAY.md, Quotas](../spec/WEBSOCKET_RELAY.md#quotas)), so the PSI phase is never idle for 120 s.
- It cannot fall to 120 s: outside the PSI phase the longest silence is a human step bounded by the 1 h default.
- It removes the stated limit that a pair past 16,777,216 value slots can be closed by the relay first.
- Deploy it only after the hosted web app runs this build, with the relay's redeploy; until then an earlier client's step past 3,900 s would be closed.

## Size and stages

About 600 to 700 added or changed non-test lines, under the ~1,200 line split threshold (`.claude/pm/ruleset.md`, Task template):

| Part | Non-test lines |
| --- | --- |
| Core: the frame, the sender and its send queue, the receive wrapper and window, arming the bound | 250 to 300 |
| Core and web: chunk activity in the two reassemblers and the queue | 80 to 120 |
| Core, CLI, web: the failure cause, its remedy line, its web copy | 50 to 70 |
| The stale comment and the retired wait's call sites | 20 |
| Spec: the WebRTC section rewritten, the message in PROTOCOL.md, the sentence list | 150 to 200 |

Two stages, split for the deploy order rather than for size:

1. **The message and the bound.**
   Everything above but the relay, with the unit tests the acceptance criteria name, plus: a still-working send never overlaps a data send; none arrives after the phase's last frame; a frame before the terms exchange ends is refused; chunk activity restarts the bound and the whole-frame budget still ends a trickle.
2. **The relay's idle limit.**
   The constant, its test (`packages/websocket-relay/test/quotas.test.ts`), and WEBSOCKET_RELAY.md, merged with the relay's redeploy after stage 1 is deployed.

## The security-reviewer round

A new protocol message takes the full review pipeline and a security-reviewer round.
Its claims to verify:

- **A forged, replayed, reordered, or dropped still-working frame ends the run and never lengthens a wait.**
  It is authenticated and sequenced like every frame after the key exchange; check that no channel admits it unencrypted.
- **No overlapping sends.**
  The send queue keeps the sequence counter, and so the GCM nonce, from being reused or skipped.
- **The relay cannot hold a run open.**
  Chunk activity restarts only the 120 s bound; the whole-frame budget still ends a run whose relay trickles bytes or injects frames that fail authentication.
- **Nothing partner-written reaches a display or a log.**
  The frame has one fixed shape, any other is refused, and no field of it is shown.
- **The frame discloses nothing new.**
  It has a fixed size and no count; a relay sees a small frame every 30 s, which shows the PSI phase's bounds that the frame sizes already show ([PROTOCOL.md](../spec/PROTOCOL.md), "What a relay sees").
- **The resource bounds hold.**
  The frames queued through the longest step stay under the queue's 1,024, and the partner cannot choose the interval or the bound.
- **The relay change tightens a bound and loosens none,** and respects the services' compatibility rule ([RELEASES.md](../RELEASES.md#compatibility-policy), "Project-run services").

## Not in this plan

Each is a separate proposal for the maintainer to scope or defer:

- A progress figure on the still-working frame, so the waiting user sees how far the partner's step is.
- The local stall check (`BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS`) on the one-worker browser path and the CLI, which would end a run whose worker hangs without an error while its page keeps sending.
