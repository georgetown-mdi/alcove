---
title: "Transport Liveness Bounds"
---

# Transport liveness bounds

This document specifies the liveness bounds on Alcove's file-sync transport operations, with their constant values and enforcement points: the per-operation deadlines, the whole-exchange budget, the send-window guard, the connect-probe bound, the rule a consumer applies to a bound's refusal, and the slow-operation warning, together with the SFTP session heartbeat and TCP keepalive that keep a quiet session from being dropped.
It is the implementation-level complement to the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), which covers what each control protects against and why the design is sufficient.
It does not cover the memory bounds on what a transport reads (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md)), or the authenticated abort marker and SFTP session recovery (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)).
Intended readers are security auditors and implementors.

## Per-operation liveness bounds

A third transport control, after the [frame-size and directory-listing bounds](TRANSPORT_BOUNDS.md), bounds the transport operations for liveness rather than memory.
It is the **per-operation fast-fail layer** - covering both the reads and the always-executed write/stat/delete operations - beneath the whole-exchange budget described next (which is the universal safety check over every transport await).
Those size bounds stop a hostile directory or file from exhausting memory, but they do not stop a hostile server admin from hanging the operation itself.
Every SFTP read awaits a callback the server drives, so the server can make one never terminate.
A `list()` can return valid but empty (`count = 0`) non-EOF READDIR responses forever (advancing neither size bound, since no entry accumulates and the end-of-directory status never comes, so the batch loop recurses without end), or simply never invoke a readdir/close callback.
A `get()` can hold the read stream open and withhold data, or trickle under-cap bytes without ever ending it, so the transfer never completes.
A `createExclusive()` can withhold its open or close callback.
Because `list()` and `get()` run on the poll loop - which awaits them with no per-call timeout - and `createExclusive()` drives the rendezvous lock path, any of these is a liveness / non-termination denial of service: the exchange stalls forever (and a directory or file handle opened before the stall is leaked) instead of failing.
Each read is bounded by the mechanism its shape allows and reports a single terminal, typed `TransportOperationStalledError` - a `UsageError` subclass, exit 64, the liveness sibling of the memory-bound `DirectoryListingBoundsError` and `FrameSizeExceededError`.
The consumers that await these reads, the poll loop and the rendezvous control-file gate (`readControlFileWithGate`, which reads the peer hello over `get()`) alike, therefore treat it as terminal and fail the exchange rather than retrying into the same hang.
The gate keys this on the typed `UsageError` rather than a single error class, so a stalled hello read is terminal there exactly as an over-cap `FrameSizeExceededError` is - without it, a server that stalls the hello `get()` would be retried at the polling cadence until the one-hour peer budget instead of failing in a minute.
The streamed `list()` has a **16,384 readdir round-trip** cap for the empty-batch flood plus a **60-second wall-clock deadline** for the withheld-callback case, and closes the open directory handle on the bounded-failure path.
The capped `get()` bounds the **60-second idle gap between chunks** (reset on each chunk), not the total transfer, so a legitimately large but slow-and-progressing read is never failed while a withheld or stalled one is.
`createExclusive()`, which has no progress loop, has the **60-second whole-operation deadline**.
Every `get()` is capped: `maxBytes` is required on the transport interface, so no read is uncapped.
The always-executed write/stat/delete operations are bounded by this same layer, each in the mode its shape allows.
The metadata ops `rename()`, `delete()`, and `exists()` - each a single server round-trip with no payload - have the same **60-second whole-operation deadline** as `createExclusive()`, with the same negligible false-fail profile, since a metadata round-trip completes in well under a second on any honest server.
`put()` instead has a **60-second progress idle window**, reset on each uploaded chunk.
A tight flat deadline is wrong for `put` specifically, because a legitimately large ciphertext upload over a slow link can exceed it while still progressing, so - exactly as the capped `get()` bounds its idle gap rather than its total transfer - `put` bounds the gap between upload-progress chunks.
The payload is streamed in bounded chunks so a withheld write acknowledgement stalls the source and trips the window while a slow-but-progressing one keeps resetting it; this uses ssh2-sftp-client's stream interface rather than driving the raw `SFTPWrapper`, so it adds no new internal-API coupling.
The bounded source accepts either a single `Buffer` or the message send path's `[header, payload]` chunk list (streamed part-by-part, never concatenated in memory -- see [FILE_SYNC.md](FILE_SYNC.md)), so the same window and retry cover the largest, hottest binary frame; a chunk list is re-iterable, so the source is rebuilt per retry attempt exactly as it is from a `Buffer`.
The retry re-issues only an attempt the server refused with the generic `SSH_FX_FAILURE` (status 4), the one status that can name a condition that clears; a missing directory (2) or a refused permission (3) is reported at once, and a session lost mid-upload goes to the session recovery rather than to a retry on the dead session (the statuses are driven in `apps/cli/test/integration/sftpStackPremises.test.ts`).

The bounds are derived, not round numbers, and all comfortably exceed any legitimate operation.
The **16,384 round-trip** cap is twice the 8,192-entry size cap, so the two move together.
A compliant server sends at least one name per non-EOF READDIR response (an empty non-EOF response is not protocol-conformant - a server out of names sends end-of-directory instead), so a legitimate listing makes at most 8,192 batches before the entry-count bound would already refuse it, and only in the pathological-but-legal case of one entry per batch.
An honest server packs many entries per packet and finishes a normal rendezvous directory in a single batch, so the cap only ever fails a progress-free flood.
The **60-second** budget is a single coarse "the server has gone silent" threshold, applied as a whole-operation deadline for `list()`, `createExclusive()`, and the metadata write/stat/delete ops `rename()`/`delete()`/`exists()`, and as a progress-reset idle window for the capped streaming `get()` and for `put()`.
It sits well above any legitimate operation - a normal listing, a lock-file create, and each chunk of a healthy transfer all complete in well under a second.
It runs at roughly twice this project's 30-second per-attempt connect bound (`serverConnectTimeoutMs`, applied as ssh2's `readyTimeout` even when the operator leaves it unset; ssh2's own default `readyTimeout` is 20 seconds, unverified against the pinned ssh2 as of 2026-09-29), so a transiently slow but live server is not cut off.
Yet it sits more than an order of magnitude below the one-hour (3,600-second) peer-inactivity budget, so a withheld response fails the exchange in a minute rather than after an hour.
Applied as an idle window it never rejects a slow-but-progressing large transfer, only one that stops sending.
All bounds are fixed constants, not configurable, for the same reason as the other bounds: a configurable budget risks an operator raising it high enough to reintroduce the denial of service.
These per-operation bounds are on the SFTP adapter, whose every call crosses the network to the in-scope server admin; they cover its reads and its write/stat/delete operations alike.
They do not cover the local-filesystem adapter, whose reads face a local kernel (`fs.opendir`/`fs.stat`) that exhibits none of these failure modes - an assumption a stalled NFS/CIFS hard mount breaks.
That remaining gap is closed not here but by the whole-exchange budget described next.

## Whole-exchange budget

A fourth liveness control is the **whole-exchange budget**: the universal safety check beneath the per-operation bounds above, and the *only* per-operation-free liveness bound for the local-filesystem adapter.
The per-operation bounds fast-fail a stalled SFTP read or write in 60 seconds; the budget is the layer they were added *beneath*, not in place of.
The always-executed critical-path write/stat/delete operations - `put` (every message and every hello/sentinel write), `rename` (every durable publish), `delete` (message consumption and rendezvous cleanup), and `exists` (the lock-path race check) - each have their own 60-second per-operation bound (above).
This budget is what stands beneath them against a hostile or dead server that withholds any of their callbacks and hangs the exchange for an hour.
Absent it that hang is silent: `synchronize()` and `send()` await the call directly so it never returns, and the poll loop's reschedule sits in a `finally` a hung await never reaches, so the poller stops with no error, while the peer-inactivity budget (`inactivityTimeoutMs`, default one hour) is a between-iterations check that never sees an in-flight await at all.
The connection therefore races **every** transport await - reads, writes, stat, delete, and the local-filesystem path alike - against that budget at the single consumer call site they all flow through, reporting the same terminal, typed `TransportOperationStalledError` on expiry.
Because it wraps the transport interface rather than any one operation, it is op-agnostic (it covers operations not individually enumerated and any added later) and adapter-agnostic (it bounds the SFTP adapter and the local-filesystem `LocalFSClient` identically, closing the stalled-mount gap).
It bounds a stalled await against a *fresh* budget per await (silence from the peer), not the total exchange duration, so it never caps a healthy long-running exchange.
The budget is the same single coarse setting an operator already tunes, and it stays coarse as the safety check: the tight, false-fail-safe per-operation bound a slow `put` needs is the progress idle window above, not a flat budget timeout, which is exactly why the budget itself can remain one coarse setting rather than being split per operation.
The capped `get()` slow-drip (under-cap bytes trickled forever, which resets the per-chunk idle window and so never trips the 60-second read bound) is caught here too, since total elapsed eventually crosses the budget - as is the symmetric `put` slow-drip, whose progress idle window the budget likewise covers.

## Send-window liveness guard

A fifth liveness control makes the four bounds above effective in a window none of them covered on its own.
Every liveness timer among them - the per-operation SFTP deadlines and the whole-exchange budget (and the connect-probe bounds below) - is `.unref()`'d, by design, so a completed or cancelled exchange exits promptly rather than lingering until a safety timer expires.
The consequence is a subtlety the fourth control's "races **every** transport await" glosses: an `.unref()`'d timer can only *fire* while some **other, ref'd** handle is holding the Node event loop open.
A parked `receive()` supplies one - `QueuedMessageConnection` (`@alcove/core`) arms a **ref'd** inactivity timer (the same `inactivityTimeoutMs` budget) while a receive waits on an empty queue - so a peer that goes silent mid-read is caught and the unref'd whole-exchange budget behind it gets to fire.
The sender's encrypt-then-send window parks no `receive()`: it builds and encrypts the next frame, then awaits the outbound `send()` (a `put` then a `rename`).
A connection dropped in exactly that window - the motivating incident was an SFTP server dropping the link in reaction to an over-aggressive poll cadence, but an idle timeout or a network blip is identical - leaves the in-flight write's callback unfired.
Every timer that would reject it is `.unref()`'d, and with no ref'd handle left the event loop drains and the process exits **0**, mid-log, indistinguishable from a crash: the awaited `send()` never returns, so no `catch`, `finally`, or teardown line runs.

The guard is one **ref'd** timer, armed in `QueuedMessageConnection.send()` across the in-flight transport hand-off (`sendWithLiveness`) and cleared the instant it settles.
Being ref'd it holds the loop open, which lets a lower, faster `.unref()`'d per-operation deadline (the 60-second SFTP `put` idle window) or the whole-exchange budget fire first and reject the write.
That rejection - a `TransportOperationStalledError` naming the server's withheld acknowledgement - is re-tagged by `send()` as a `transport` `ConnectionError` (its message and cause preserved) so the operator sees the real cause.
Absent any per-operation bound (a transport that has none), the guard is itself the transport-agnostic safety check: on expiry (the connection's `inactivityTimeoutMs`) it rejects the send with a `transport` `ConnectionError` that names the lost connection, so the awaited call returns instead of orphaning.
Either way a mid-exchange drop in the send window terminates **non-zero** (a `transport` `ConnectionError` maps to exit 69 / `EX_UNAVAILABLE`) rather than a silent exit 0.
It lives in core, not the SFTP adapter, so it covers every transport (`sftp`, `filedrop`, and the web WebRTC channel) at the one `send()` call site they share.
Every terminal path (`fail`/`finish`/`close`) *rejects* an outstanding send -- not merely cancels its timer -- as well as clearing it on the hand-off's own settlement.
This is critical, since a terminal transition (an inbound-overflow `fail`, a peer half-close via `finish`, or a signal-driven `close`) can race an in-flight hand-off, and a hand-off orphaned in exactly that window would, if the guard were only cancelled, leave the awaited `send()` hanging forever -- the same silent stall, relocated.
Rejecting it there (as the terminal error, or a cancelled `closed` on a deliberate close, the send-side twin of the parked-receive rejection) makes the "terminates rather than orphans" guarantee hold in the racing case too, and keeps the same "never hold a healthy process open at teardown" property the `.unref()`'d timers have.
That guarantee is reached here by settling every guard rather than by `unref`, because this one timer must, uniquely, hold the loop open just long enough to reject the orphaned write, then release it.
Its message has no `inactivityHint`: that receive-side guidance ("the peer... has sent nothing since") misdescribes a stalled outbound write.

## Connect-probe bound

A sixth liveness control bounds the connect probe itself, the one transport call outside the whole-exchange budget's reach.
`connect()` runs before the exchange begins and is wrapped by neither the per-operation bounds nor the whole-exchange budget - it passes through `boundTransport` unwrapped - so each adapter bounds its own connect attempt instead.
The SFTP adapter bounds it by ssh2's `readyTimeout`, which tears down the socket on expiry and strands nothing.
An unresponsive SFTP connect is retried, so its total caller-visible latency stacks to roughly `maxReconnectAttempts + 1` such per-attempt windows - bounded wait, not accumulating resource, since each expiry strands nothing - unlike the local-filesystem timeout below, which is terminal at one window.
The two host-key probes are the exception -- the `probe-host-key` dial and the first-use trust probe (see [SFTP host-key verification](CHANNEL_SECURITY.md#sftp-host-key-verification)): each sets that count to 0, so one window is its whole latency (the reasoning, and what comparable tools' connect timeouts bound: [connect-timeout-prior-art.md](../notes/connect-timeout-prior-art.md)).
The local-filesystem adapter bounds it by a per-attempt `withTimeout` deadline around its `fs.access` reachability probe and the `fs.stat` folder check that follows it.
On the local-filesystem adapter a stalled NFS/CIFS hard mount turns that probe into the same liveness hazard the post-connect bounds address, with a sharper resource cost.
`fs.access` blocks a libuv thread-pool worker (not the event loop), and nothing in-process can cancel an already-dispatched blocking syscall - `fs.access` does not honor an `AbortSignal`, and libuv's `uv_cancel` only removes still-queued work, never work a pool thread is already executing - so the worker stays pinned until the OS releases the syscall, minutes on a hard mount.
The per-attempt timeout fires on the event loop and fails the attempt, but retrying it would launch a fresh probe each time.
So under the default `maxReconnectAttempts` of 3, up to four such probes could stack, exhausting the default four-thread pool and starving every other `fs`/DNS/crypto operation in the process - a process-wide denial of service induced by a single unreachable mount.
The connect therefore treats a per-attempt timeout as terminal: it fails fast after one timeout window, reporting a `TimeoutError` (which extends `Error`, not `UsageError`, so it classifies exit 69 / `EX_UNAVAILABLE` like any transport-unavailable failure), rather than dispatching further probes.
A fast-returning transient error - `EACCES` while a share's permissions are still settling - still retries under `max_reconnect_attempts`.
A path with nothing at it (`ENOENT`) or naming something other than a folder (`ENOTDIR`) is refused on the first attempt instead, exiting 66 and 64 respectively ([CLI.md](../CLI.md#exit-69-on-a-shared-folder-path)).
For the local-filesystem adapter that budget governs only this initial connect: `filedrop` holds no persistent session, so it has no mid-exchange reconnection.
The SFTP adapter is the exception - it holds one long-lived session that a server can drop mid-exchange - so the same budget also bounds each of its mid-exchange re-dial bursts (see [SFTP mid-exchange session recovery](CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery)).
This bounds concurrent stalled workers to one and the caller-visible latency to roughly one `serverConnectTimeoutMs` window.
It does not bound the lifetime of that one worker, which only the OS reclaims, because no in-process mechanism can free a thread wedged in a single blocking syscall - only a killable worker thread or child process could, which is disproportionate for a connect pre-check.

On the SFTP channel that per-attempt window covers only part of an attempt. ssh2 clears `readyTimeout` the moment authentication succeeds, and the `subsystem sftp` request that follows has no deadline of its own, so a server that authenticates the operator and then never answers it leaves the dial with nothing to end it.
The adapter arms its own deadline over that second phase - at ssh2's `'ready'` event, for the same `serverConnectTimeoutMs` window the first phase ran under, so one operator-facing setting governs both.
Its expiry destroys the socket beneath the abandoned dial and waits the ssh2 `Client`'s `'close'` for it out before reporting, because that socket is still writable, the one state a later `Client.connect()` defers behind forever, and a dial issued while that `'close'` is owed is failed by the library instead of reaching the server (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client)); it reports a `TimeoutError` naming the phase.
It is terminal at one window rather than retried: the request went unanswered on a connection the server had already authenticated, so re-issuing it puts the same request to the same server for the rest of the reconnect budget.
A stalled SFTP attempt therefore ends within roughly two `serverConnectTimeoutMs` windows plus a forced-close wait of at most one second, rather than one.
Both halves of the assumption behind the bound - where the phase begins, and that nothing in the pinned stack ends it - are driven against a real server in `apps/cli/test/integration/sftpStackPremises.test.ts`, and the bound itself in `apps/cli/test/integration/subsystemOpenBound.test.ts`.

The per-attempt windows above bound each connect attempt; the *count* of attempts has a ceiling of its own, because a `max_reconnect_attempts` validated only as a non-negative integer (up to `Number.MAX_SAFE_INTEGER`) bounds nothing.
Against an endpoint that refuses fast - `ECONNREFUSED` on `sftp`, `EACCES` on `filedrop`, exactly the fast transients the retry budget exists to ride out - the retry loop spaces attempts with a fixed one-second inter-attempt delay, and the fast-fail attempts themselves are near-instant.
The wall clock is therefore essentially the delay total (the `maxReconnectAttempts` delays across the `maxReconnectAttempts + 1` attempts above) - about that many seconds, a linear self-inflicted hang.
The count is therefore capped at `MAX_RECONNECT_ATTEMPTS = 604800` (defined in `packages/core/src/config/connection.ts`), derived as the seven-day timeout-flag ceiling `MAX_TIMEOUT_SECONDS` (defined in the same file) divided by the one-second delay (`604800 s / 1 s = 604800`): the largest count whose fast-fail delay total stays within the same seven days the duration flags already cap.
A value past it is rejected with a flag-named `UsageError` (exit 64) at both validation boundaries that already agree on this field - the connection schema's `.max()` and the CLI's `nonNegativeIntFlag` parse guard, which imports the constant - so an over-ceiling value is refused whether it arrives from `alcove.yaml` or `--max-reconnect-attempts`.
This bounds a proxy: the count equals wall clock only at the one-second floor (the fast-fail case), so it does not tightly bound a slow-but-answering endpoint, whose attempts each run up to `serverConnectTimeoutMs` and are already bounded per attempt by it.
A direct wall-clock deadline on the whole connect phase is the stronger control left for if that case ever proves to matter.
This is a usability/self-DoS sanity bound, not a cross-party control - the operator only hangs their own command - in the same class as the `MAX_TIMEOUT_SECONDS` duration-flag cap.

## Consumer-side terminal-error rule

These transport bounds share one consumer-side rule.
Every one is reported as a `UsageError` subclass - the memory bounds as `FrameSizeExceededError` and `DirectoryListingBoundsError`, the liveness bounds as `TransportOperationStalledError` - and any consumer that awaits a transport call must treat a `UsageError` as terminal: it propagates the rejection and never retries it, swallows it, or proceeds as if the call had succeeded.
This binds the read consumers (a `list()`/`get()`/`createExclusive()` in the poll loop or the rendezvous gate) and the write consumers too - the `put`/`rename` publish in `send()`, the rendezvous lock-path `createExclusive`/`exists`, the consume-`delete` that signals a message consumed, and the retain-mode ack-write (`writeAck`'s `put`/`rename`) that signals it on a transport that never deletes.
Retrying loops straight back into the hang or the over-allocation the bound exists to prevent, and swallowing-then-proceeding turns a stalled consume into a re-emitted duplicate - a swallowed bound is no bound.
So the only effective response is to fail the exchange, which is why the poll loop stops on a `UsageError` (including from the consume-`delete`, which rethrows it rather than swallowing it as it does a transient delete failure), the rendezvous control-file gate (`readControlFileWithGate`) rethrows it, and the `send()`/joiner write paths propagate it.
The terminal behavior keys off the `UsageError` base class rather than each subclass, so a future bound added to the family inherits it.
This consumer rule is what makes the transport-layer bounds effective end to end.
The consumers are pinned by behavioral tests in `packages/core/test/connection/fileSyncConnection.test.ts` that drive each with a `UsageError` from a transport call - a stalled read in the poll loop and the gate, a stalled consume-`delete` in the poll loop, and a stalled retain-mode ack-write in the poll loop.
Each assertion checks that it is reported once and propagated (the exchange fails), never retried at the poll/gate cadence and never swallowed into a duplicate delivery.
A new transport-call consumer must uphold the same rule; it is not enforced automatically, so adding one is a change to review against this rule.

## Slow-operation warning

Distinct from both controls is a non-fatal **slow-operation warning**, which is observability, not a security control.
At a fixed, generous elapsed-time threshold (30 seconds, below the 60-second read fast-fail) the SFTP adapter logs one warning naming the operation, the elapsed time, and - where a cheap progress signal already exists - the observed progress (bytes-so-far and rate for a `get`, entries-so-far for a `list`, the payload size for a `put`; elapsed-only for the atomic operations).
It then lets the operation continue unchanged.
It needs no duration estimate: a slow-but-honest transfer and an intentionally slow or withholding server are observationally identical (intent is not on the wire), so a false warning is cheap and the line reports observed signal for a human to judge.
It does nothing on a headless run with no human watching - the whole-exchange budget defends that run - and it stays entirely outside the terminal-error paths, so it can never affect correctness or the liveness gate.
It introduces no new required configuration.

## SFTP session heartbeat and TCP keepalive

Distinct again, and opposite in direction to the bounds above: those cap how long a **hostile** server can make an operation hang; this keeps a **friendly** server from dropping a session that has gone legitimately quiet.
An SFTP server enforcing a strict idle timeout closes the control connection when no SFTP command has arrived within its window - Azure Blob SFTP's window is a **fixed two minutes**, not operator-adjustable (that figure comes from Azure's documentation and was unverified as of 2026-09-29, when a documentation audit could not reach Azure).
A single-pass PSI round spends long stretches with no file traffic on the side that is computing rather than polling (the receiver polls for the reply, so its session stays warm; the sender computes the reply and issues no SFTP command meanwhile).
On weak hardware (old agency laptops) that masking can run for minutes even on the native backend (see [PROTOCOL.md](PROTOCOL.md)).
The masking runs in a worker thread rather than on the event-loop-owning thread, so the loop stays free across such a round and this heartbeat can fire during it; run on the event-loop-owning thread, a multi-minute round would block every timer outright and no heartbeat could fill the gap.

The heartbeat is a self-rescheduling timer on the SFTP adapter that issues a real no-op SFTP command - `realPath(".")`, the cheapest single REALPATH round-trip (a path the server always resolves) - once the session has been idle for the interval.
It must be a real **SFTP** command, not an SSH-transport or TCP keepalive: a server keys idleness on the last SFTP protocol **request**, so transport-level traffic does not reset its timer.
The interval is **60,000 ms (60 s)**, half of the tightest idle timeout it must survive (Azure's fixed two minutes), so a beat always lands with a full interval of margin even if one is delayed.
The idle window is measured from the last observed activity, so a beat never fires more than one interval after the session actually went quiet.
It is a **fixed constant, not operator-configurable**, for the same reason as the liveness bounds above - a setting set too high silently stops defeating the timeout, with no upside a fixed sub-timeout value lacks.

A beat is suppressed while any adapter operation is in flight (real traffic is already keeping the session alive) and while a previous beat has not settled, and only fires after a full interval of genuine idleness.
Overlap itself is not the hazard that suppression covers: two operations in flight on one client at once is unsafe only in the narrow respect below.
Measured against a real server, overlap on a **healthy** session is safe: over the operation pairs driven, the beat's own among them, each member returned its own correct result with no cross-talk and no mis-routed error, and a non-fatal failure of one member left the other undisturbed.
What overlapping operations do cross is the **session-loss rejection**, which the library hands to the operation issued last while suppressing the earlier one's - so issuance order decides which of two concurrent operations takes which path out of a loss, and the two paths do not have the same outcome.
That crossing is not the beat's to close.
The adapter issues concurrent operations of its own with no suppression of any kind - a `send()` resuming from the protocol continuation runs its `put`/`rename`/`safeDelete` alongside the poll cycle's `list`/`get`/`delete`, and core's connection cleanup and rendezvous orphan sweeps fan `safeDelete` out with `Promise.all`.
So the suppression covers the beat and nothing else, and is not a control over concurrent operations generally.
Leaving them unsuppressed is the posture rather than a gap for the beat's suppression to grow into, and what gets them through a session loss is the recovery re-dial's transport retirement.
An operation outstanding when a concurrent operation's recovery runs is settled by the transport close that retirement waits out -- and, against a partner that withholds it, drives itself -- rather than being left for its own per-operation liveness deadline.
A drop that tears several operations at once therefore costs the exchange one tear, not one deadline per operation, and every torn operation inside the recovery chokepoint is re-issued with its own correct result.
What it is still worth is narrower: it keeps the beat off a session that already has an operation on it, so the beat - whose own outcome is swallowed - never takes a session-loss rejection away from a real operation in flight beside it.
The one residual overlap - a real operation that begins in the same event-loop turn a just-issued beat is still on the wire - is covered by the healthy-session measurement, and at a loss the rejection reaches that operation rather than the beat, which was issued first.
(The library mechanism, the measured numbers, and the pairs and states the runs did not cover are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md), re-verified there on any ssh2 / ssh2-sftp-client upgrade.)
The `realPath` itself is bounded by the same 60-second per-operation deadline as the metadata ops, so a dead or hostile session cannot leave a beat hanging; a beat's outcome is swallowed (logged at trace), never reported to the exchange, so a failing keepalive can never itself fail a round.
The heartbeat timer is cleared on **every** terminal path - session `end()` and the fatal-'error' guard (a dead channel needs no keepalive) - and is `.unref()`'d, holding to the unref'd SFTP-liveness-timer teardown contract so it never holds a winding-down process open.

Beneath the heartbeat, the adapter enables kernel **TCP keepalive** on the underlying socket (`net.Socket.setKeepAlive(true, 30_000)`, reached through the ssh2 Client's `_sock` since ssh2 exposes `setNoDelay` but not `setKeepAlive`, the same access-past-the-public-API assumption the fatal-'error' guard rests on).
This is a transport-layer safety check, **not** a substitute for the heartbeat: it keeps NAT/firewall flow state warm and lets the kernel detect a silently dead peer, but because it rides below the SFTP protocol it does not reset the server's SFTP-command idle timer.
The **30,000 ms (30 s)** initial delay (Node sets only `TCP_KEEPIDLE`; the probe interval and count keep their OS defaults) sits below common NAT idle windows and below the application heartbeat interval, so probes keep the flow alive between beats.
Both settings are re-applied on every reconnect (a fresh socket per attempt) and both are guarded and non-fatal, exactly like the existing `setNoDelay`: an upstream that relocates the socket degrades to no-keepalive, never to a failed connect.
