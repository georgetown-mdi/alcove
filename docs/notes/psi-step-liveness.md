---
title: "Liveness Through a Partner's PSI Step"
---

# Liveness through a partner's PSI step

*Status: decided on the maintainer's rulings and built; not yet measured in a real browser.
The interval and the silence bound are working values until the browser figures below are measured.
See [docs/notes/README.md](README.md).*

A party waiting through its partner's PSI step used to wait in silence for a time derived from the two parties' counts, 8,439.4 s at the browser's receive ceiling, and a partner that had stopped looked the same as one still computing until that wait ended.
That wait is replaced: the computing party sends a small message at a fixed interval, and the waiting party ends the run when those messages stop.
The normative rows are in [WEBRTC_TRANSPORT.md, The wait through a partner's PSI step](../spec/WEBRTC_TRANSPORT.md#the-wait-through-a-partners-psi-step) and [PROTOCOL.md, The still-working frame](../spec/PROTOCOL.md#the-still-working-frame).

## What existed, checked at staging 9232a4c74

- **PSI already runs off the thread that owns the connection.**
  The browser runs it in Web Workers (`apps/web/src/psi/workers/psiCryptoController.ts`, `psiWorkerPool.ts`), the CLI in a worker thread (`apps/cli/src/psiWorkerHost.ts`, core `psi/psiWorkerEngine.ts`).
  No thread move is needed, and the sender lives in core alone.
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
  The message is therefore sent on a timer, and the progress count is not forwarded.
- **The transports already detect a lost link.**
  The CLI's peer reports a vanished partner in about 30 s by consent freshness (measured, [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-behavioural-assumptions)).
  The WebSocket relay pings every 30 s (`RELAY_PING_INTERVAL_MS`) and drops a socket 90 to 120 s after its last answer ([WEBSOCKET_RELAY.md, Keepalive](../spec/WEBSOCKET_RELAY.md#keepalive)).
  What none of them sees is a partner whose link is up and whose run has stopped: a frozen tab, or a page whose main thread no longer runs.
- **Holds on the sending thread.**
  The CLI's longest measured main-thread hold on an open channel is about 12 s ([WEBRTC_TRANSPORT.md, The main thread on an open channel](../spec/WEBRTC_TRANSPORT.md#the-main-thread-on-an-open-channel)).
  The browser main thread's longest hold is not measured.
- **A frame in transit has no message beside it.**
  The largest frame is 268,435,456 bytes; at werift's measured send rate of 1.42 MiB/s ([cli-webrtc-stack.md](cli-webrtc-stack.md)) it takes about 180 s, and at the relay's 2 MB/s cap about 134 s.
  So each part of a frame that arrives counts as activity.

## The design as built

- **The message.**
  A still-working frame: the JSON object `{"working":true}`, exactly that, sent inside the encrypted stream like every frame after the key exchange.
- **Which connections send it.**
  An optional connection member, `exchangesStillWorkingFrames`, which the CLI and web data-channel and WebSocket relay connections state and the encryption layer forwards.
  A file-sync connection states none, so no still-working frame is sent there, and one that arrives fails the awaited frame's parse as a `protocol` error.
- **The sending side** (`packages/core/src/exchange/stillWorking.ts`).
  A layer over the connection, built just before the PSI phase.
  It sends one frame when the phase starts, before the PSI engine is built, then one whenever 30 s pass with nothing sent.
  Every send goes through one queue, so no two overlap.
  Sending stops, after a send in flight settles, at the end of the phase (its `finally`, on success, failure or cancellation) or when this party sends an abort through the layer.
- **The waiting side.**
  The same layer drops each still-working frame and receives again.
  The partner's first one arms a 120 s silence bound on the transport's parked receive, which each part of a frame that arrives restarts; the end of this party's own phase clears it.
  The whole-frame budget (1 h by default, or `inactivity_timeout_ms`) still runs beside it, so a relay that trickles bytes cannot hold a run open past it.
  Before the bound arms, and after this party's phase ends, the whole-frame budget alone applies; a still-working frame still arriving then restarts it.
- **A still-working message replaces any unread one.**
  A party running its own operation does not receive, so the partner's frames would otherwise queue.
  On each interval, the layer reads and drops still-working frames already queued, picking them out by their wire length before reading.
  A queued frame of that length that is not one is held and handed to the next read, in order.
  So the inbound queue's count and byte bounds are unchanged, and no operation length reaches them.
- **Where it is refused.**
  A still-working frame is dropped from the layer's start until this party reads the partner's first other frame after its own phase ended.
  Outside that window, or with any other shape that has a `working` key, it is a `protocol` error.
- **The failure.**
  Reaching the 120 s bound ends the run with a new cause in core's catalog, `partner-stopped-responding` ([failure-cause-catalog.md](failure-cause-catalog.md)), with the remedy to ask the partner to check their run and start again.
- **What retired.**
  `partnerStepWaitMs`, its raise in the PSI phase, and `raiseInactivityTimeout`.
  No send's hand-off waits through a partner step: only file-sync holds off reading, so the hand-off keeps the whole-frame budget.

### The interval and the bound

- **Interval, 30 s.**
  The cadence at which the transports already check a link: the relay's ping, and the CLI's consent-freshness detection.
- **Silence bound, 120 s.**
  It must exceed the longest gap the receiver can see between two frames.
  On the sending side: the 30 s interval, the 12 s CLI hold, and up to 60 s if Chrome delays a hidden tab's timers to once a minute, a throttling not verified here.
  On the receiving side: its own hold, 12 s on the CLI.
  That is 114 s; 120 s is four intervals, the tolerance the relay applies to its own pings.
- **What bounds a step.**
  Nothing on the waiting side bounds a step's length: it ends when it completes, after 120 s of silence, on the computing party's own stall check (split operations only), or on an interrupt.
- **Both are working values.**
  The figures still needed, each in a real browser on the x86-64 host: the gap between still-working frames sent from a hidden tab through a step of an hour or more, the browser main thread's longest hold at the ceiling, and whether Chrome freezes a tab with an open data channel.
  If the hidden-tab gap exceeds 90 s, the timer moves into a worker, whose timers the page's throttling does not reach.

## Decisions

### File-sync

Stays WebRTC and the WebSocket relay only.

- **The user has a remedy.**
  A file-sync party is a CLI operator, who can set `inactivity_timeout_ms`; a browser user has no setting, which is why the browser case needs the message.
- **The steps are short on the CLI's own backend.**
  At the native rate above, an operation over 2^24 elements runs about 245 s, far inside the 1 h default.
- **Each message is a file.**
  Every 30 s it would be a write, a listing, a read, and a delete on a server or a synced folder the parties may not run.

### Mixed builds

No wire field and no fallback.
The first partner frame a party reads in its PSI phase must be a still-working frame, since a partner on this build sends one before anything else in that phase.

An earlier build sends none.
It either sends its first PSI frame, or reads this build's first still-working frame as the frame it awaits, fails with a `protocol` error, and sends its local-fault abort.
This build refuses either first frame with "Matching could not start, most likely because your partner runs an older version of Alcove. Ask them to update Alcove, then run again.", marked as the partner on the older version, which the web app shows as its different-versions copy.
Any other abort reaches the phase unchanged.
A stated limit: a newer partner whose run faults before its first still-working frame is reported the same way.

### The standing relay's idle limit

`RELAY_IDLE_TIMEOUT_MS` stays 8,739.4 s, documented as an arbitrary working value raised on request rather than as a derived wait.
A still-working frame is a message to the relay, which counts messages and not pings ([WEBSOCKET_RELAY.md, Quotas](../spec/WEBSOCKET_RELAY.md#quotas)), so the PSI phase is never idle there for more than an interval.

## The security-reviewer round

A new protocol message takes the full review pipeline and a security-reviewer round.
Its claims to verify:

- **A forged, replayed, reordered, or dropped still-working frame ends the run and never lengthens a wait.**
  It is authenticated and sequenced like every frame after the key exchange; check that no channel admits it unencrypted.
- **No overlapping sends.**
  The send queue keeps the sequence counter, and so the GCM nonce, from being reused or skipped.
  On every exit the timer stops and an in-flight still-working send settles first, and none is sent after.
- **The relay cannot hold a run open.**
  Chunk activity restarts only the 120 s bound; the whole-frame budget still ends a run whose relay trickles bytes.
- **Nothing partner-written reaches a display or a log.**
  The frame has one fixed shape, any other is refused, and no field of it is shown.
- **The frame discloses nothing new.**
  It has a fixed size and no count; a relay sees a small frame every 30 s, which shows the PSI phase's bounds that the frame sizes already show ([PROTOCOL.md](../spec/PROTOCOL.md), "What a relay sees").
- **The resource bounds hold.**
  Queued still-working frames are drained each interval, every existing receive bound stands, and the partner cannot choose the interval or the bound.

## Not in this plan

Each is a separate proposal for the maintainer to scope or defer:

- A progress figure on the still-working frame, so the waiting user sees how far the partner's step is.
- The local stall check (`BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS`) on the one-worker browser path and the CLI, which would end a run whose worker hangs without an error while its page keeps sending.
