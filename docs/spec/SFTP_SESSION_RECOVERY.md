---
title: "SFTP Session Recovery"
---

# SFTP session recovery

This document specifies how the CLI's SFTP adapter recovers when the server drops its session mid-exchange, with the constant values and enforcement points: which losses are re-dialed and which stay terminal, the bounds on recovery and what each protects, what the accounting counts, how a torn operation is re-issued, the operations concurrent with a re-dial or a release, the outstanding-operation hold on an idle boundary, the deferred cleanup-delete record, the session-transition lock, and the connection's terminal close.
It is the implementation-level complement to [Server-enforced session limits](../DEPLOYMENT.md#server-enforced-session-limits) in DEPLOYMENT.md and the `max_reconnect_attempts` and `connection_per_poll` settings in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md), which say when an operator needs them.
It does not cover the heartbeat that keeps a quiet session from being dropped (see [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md#sftp-session-heartbeat-and-tcp-keepalive)), the crash safety on a fatal packet and the host-key verification (see [SFTP_CONNECTION.md](SFTP_CONNECTION.md)), or the file-sync state machine across an idle boundary (see [FILE_SYNC.md](FILE_SYNC.md#session-lifetime-across-an-idle-boundary)).
Intended readers are security auditors and implementors.

Every net-new control specified here is subject to the explicit pre-release security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy).

## SFTP mid-exchange session recovery

The [SFTP session heartbeat](TRANSPORT_LIVENESS.md#sftp-session-heartbeat-and-tcp-keepalive) keeps a *friendly* server from dropping a quiet session, but some servers enforce a **max-session or idle cap the operator cannot change** (observed at ~10 minutes; an observation on one service that was not repeated as of 2026-09-29) and drop the one long-lived session regardless.
Under the persistent-single-session model this adapter runs by default, that drop would otherwise be terminal: the next operation fails and the exchange aborts.
Mid-exchange session recovery is the robustness floor beneath that model: on a **clean session loss** the adapter transparently re-dials and re-issues the operation before failing terminally.
It is adapter-local - core's rendezvous, `fileSyncConnection`, and `send()` are unchanged.
The `connection_per_poll` mode is a separate thing that composes with it, releasing the session at the poll loop's idle boundaries rather than holding one for the whole exchange; when that mode's session exists, and the idle stretches one still spans, are in [FILE_SYNC.md](FILE_SYNC.md#session-lifetime-across-an-idle-boundary).
What is counted, capped, exempt and bounded is this section's, and the tables below hold it: a new bound, trigger or exemption appends a row rather than a clause to a paragraph.

See [sftp-adapter-state-machine.md](../notes/sftp-adapter-state-machine.md) for the state-machine model these rows project from -- what a session, an idle boundary and an operation each are, and the design decisions behind the accounting.

### What is re-dialed, and what stays terminal

**Trigger, by post-state not error text.**
Recovery re-dials only on a clean loss, read off the connection state after an operation rejects: ssh2-sftp-client clears its internal `sftp` session property on a clean close/end (both its per-operation temp listeners and its global `'close'`/`'end'` listener null it), so a cleared property is the reliable "the session dropped" signal.
It unifies the adapter's own `!sftp` throw in `list()`/`createExclusive()` with ssh2-sftp-client's `ERR_NOT_CONNECTED` ("No SFTP connection available") on a high-level `get`/`put`/`delete`/`rename`/`exists` issued against a session already gone, and with the `Unexpected end event` those same per-operation listeners deliver when a drop tears one in flight.
These stay **terminal, never re-dialed**: a fatal SFTP protocol error (the wrapper is destroyed and cannot recover -- the `fatalSftpError` guard); any liveness **stall** (`TransportOperationStalledError`), both over a transport still live and on a cleared session whatever the transport reads, since re-dialing on a timeout would hand a withholding server a free liveness reset.
The one stall that is a trigger is the withheld-close loss below, a session still set over an ended transport.
The memory bounds (`FrameSizeExceededError`, `DirectoryListingBoundsError`) also stay terminal, as does a host-key mismatch on the re-dial itself.

**Where the lifecycle readings in this section are driven.**
The trigger above and the three paragraphs below it rest on how the pinned ssh2 / ssh2-sftp-client deliver a drop, and each reading is driven against the in-process harness server (`apps/cli/test/sftpServer/`) rather than taken from the libraries' source: a clean drop tearing a high-level or a raw-wrapper operation, at a sweep of cut positions, by `apps/cli/test/integration/inflightDropRecovery.test.ts`; a drop with the close withheld by `heldSessionWithheldClose.test.ts`; a drop tearing several operations at once by `concurrentOpDropRecovery.test.ts`; and the socket every re-dial is issued over by `dialDeferral.test.ts`.
Those suites assert the adapter's outcome -- the recovery, the count, the dial -- not the libraries' error text, which is why the trigger reads post-state.
Only the in-process backend can cut a session or withhold its close, so none of these readings is verified against a native `sshd`; the shapes measured and what a version bump re-checks are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client).

**A session still set over an ended transport is a loss, not a live session.**
The session property alone does not determine the reading, because one partner class leaves it set over a session that is gone.
A server that drops the SFTP session and then withholds its connection close leaves the transport half-open -- this side's write half ended, and no `'close'` for ssh2-sftp-client's global listener to clear the property from -- so the operation on the wire cannot complete and rides the per-operation deadline to a terminal stall.
The trigger therefore reads the transport alongside the property: a session still set over a transport either half of which has ended is the loss it is, whatever the operation rejected with.
It is recovered exactly as a clean loss is -- one re-dial, one re-issue, counted in `reconnects` and its mid-exchange sub-count, and warned and charged on the terms its own row in the trigger table below states.
Reaching that re-dial means clearing the dead session first, which the recovery does by forcing the ended transport closed -- the mechanism the `connection_per_poll` release uses, with its own call-site resolution and none of its accounting, so a drop is never reported as an idle release.
Every way that forced close can fail (a relocated call site, a destroy that raises, a session that does not clear, a transport that does not close) warns naming what broke and pointing at the issues tracker to report the library incompatibility, then leaves the operation to fail with the loss it already had -- the outcome it had before recovery reached it at all.
The internals and the measurements are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

**The two operation routes are torn a full event apart, and at the pinned versions both read as the clean loss they are.**
A raw-wrapper operation (`list`, `createExclusive`, which drive the `SFTPWrapper` directly) is failed by ssh2, which fails outstanding channel requests only from the socket's `'close'` handler -- the socket's `'end'` emits and cleans the protocol up but leaves them outstanding.
It does so after its own `emit('close')` has already run, by which point both ssh2-sftp-client listeners that emit reaches (the per-operation temporary `closeListener` and the constructor's global one) have cleared the `sftp` property; such an operation therefore reaches recovery with the whole sequence run.
One of ssh2-sftp-client's own high-level operations (`get`, `put`, `delete`, `rename`, `exists`) does not wait for any of that: its per-operation listeners settle the operation, and clear the same property, from the `Client`'s `'end'`, so it is treated as the clean loss it is a full event earlier, with the transport's `'close'` still owed.
Which side of the `'close'` an operation lands on is a property of the route rather than of the drop, and a route can still settle late -- the chunked `put`'s bounded source is a further hop, which can settle past the `'close'`.
A tear of a counted outstanding operation is the partner's doing or the terminal close's, never a boundary's, and this ordering determines how the loss is treated, never what a dial may safely follow.
The terminal "not a loss" readings -- the adapter's own stall deadline over a session and a transport both still live, and a stall on a cleared session whatever the transport reads -- stay reachable by both routes; what the idle boundary's own precondition closes is the boundary case, which rests on the ordering not at all.

**A cleared session can still leave a transport a re-dial must not be issued over.**
A dial issued while the `'close'` is owed is failed by ssh2-sftp-client's own connect-time listeners -- they fail a dial on any lifecycle event that reaches them mid-handshake -- while the handshake it started keeps running, unowned, at the server, whose later events fail the next dial in turn.
So the re-dial retires the transport whether or not the session property is still set: the same forced close as above, then a wait for the `'close'` to land, and only then the dial.
Nothing on the socket separates the two states -- a torn high-level operation rejects over a socket that already reads destroyed with both halves ended, which is what it reads once the whole sequence has run too -- so the reading comes from the `Client`'s own `'end'`/`'close'` pair, watched by one listener pair attached once per adapter.
Where nothing is owed the retirement drives nothing and returns, so the raw-wrapper class pays no wait for it.
A transport that cannot be retired refuses the dial and leaves the operation the loss it already had, warning for its own cause, on the same terms as the withheld-close paragraph above.
A `Client` that exposes no `on()` to watch leaves no reading to take at all, which the retirement treats as *cannot tell* rather than as *nothing owed* -- the flag's unwritten default is the same value a delivered sequence leaves, so the two are separated by whether the watch attached.
It warns for the lost reading, naming the call site and pointing at the issues tracker to report the library incompatibility, and retires the transport rather than dialing into a window it cannot see: a drop that would have recovered still recovers, at the cost of the forced close's bound on a transport whose `'close'` had already landed.
Where the same relocation took the forced close's own call sites with it there is nothing left to retire, and the dial is refused on the terms above.
The ordering assumption, the measurements behind it and their bound, and what a version bump must re-verify are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

**Re-dial goes through `connect()`, never a bare `client.connect()`.**
The adapter retains the full original connect options (including the pinned host key and stored credentials) and re-invokes its own `connect()`, so the re-dial re-runs the entire post-connect sequence on the fresh wrapper.
It re-attaches the guarded fatal-`'error'` listener (a listener-free wrapper would turn the next malformed packet into a process crash - see the [crash-safety control](SFTP_CONNECTION.md#sftp-fatal-packet-crash-safety)), clears `fatalSftpError`, re-runs the enforcing fail-closed host-key verifier that rides the options, re-verifies the raw `sftp` methods, advances the heartbeat epoch, and re-applies `setNoDelay`/keepalive.
There is **no re-prompt**: the pinned fingerprint and credentials are reused.
A host-key mismatch on the re-dial is terminal for free via `connect()`'s existing "Host denied" retry predicate.
(Residual: a mid-exchange host-key mismatch is reported as a raw transport error rather than the security-kind `ConnectionError` that `fileSyncConnection.open()`'s catch produces via `hostKeyVerifier.refusal()` on the initial connect - the exchange still fails closed, but the error kind is coarser on the re-dial path.)

### What each bound protects

**One recovery round per operation invocation.**
Re-dial once (that one `connect()` internally makes up to `max_reconnect_attempts` dial attempts), re-issue once; if the re-issued operation also hits a clean loss it rejects terminally rather than looping.
The whole operation-plus-re-dial is enclosed by `boundTransport`'s per-operation `inactivityTimeoutMs` budget in core (a `Promise.race`), so no bespoke total-time timer is added here.
Core's three tight teardown budgets - the terminal-frame drain and the connection's own final close, both specified in [FILE_SYNC.md](FILE_SYNC.md#phase-3----cleanup-and-close), plus the abort-marker write (`ABORT_MARKER_WRITE_BUDGET_MS`, ~5 s) - are `Promise.race` bounds of the same kind, so a re-dial during teardown cannot overrun them.
The close is the last of the three to run, and short enough to abandon core's wait on a teardown re-dial still in flight; and `end()` latches a `closing` flag that suppresses any further re-dial once teardown has begun.

Every bound this adapter enforces, the scope each is applied over, and what it protects against.
A new bound appends a row.

| bound | value | scope | protects against |
| --- | --- | --- | --- |
| `max_reconnect_attempts` (dialing loop) | operator, default `DEFAULT_MAX_RECONNECT_ATTEMPTS` | one `connect()` | a server unreachable at dial time |
| `max_reconnect_attempts` (cumulative mid-exchange) | the same number, a separate tally | the exchange | a session-capping server burning handshakes forever |
| `TRANSITION_ACQUIRE_TIMEOUT_MS` | 10 s | one queued session-transition acquire | a transition parked behind another indefinitely |
| `CLIENT_CLOSE_TIMEOUT_MS` | 5 s | the idle release's `end()` wait, and the terminal close's | a partner that accepts the disconnect and withholds the close |
| `FORCED_CLOSE_TIMEOUT_MS` | 1 s | either forced destroy (its timer ref'd) | an ssh2 stack that stops settling on a destroyed socket |
| `SFTP_STALL_DEADLINE_MS` | 60 s | one operation | a server that withholds a reply |
| `DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS` | 5 s | each cleanup-drain re-issue | a server accepting DELETE and withholding its callback at teardown |
| `MAX_DEFERRED_CLEANUP_DELETES` | 64 | the deferred-cleanup record | unbounded record growth (refuse, never evict) |
| `MAX_DEFERRED_CLEANUP_REISSUES` | 3 | one recording in that record | a permanently undeletable temp retried for the whole run |
| `SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS` | derived from the concurrency the adapter can reach | the one shared ssh2 `Client` | a spurious Node listener-leak warning under a wide fan |
| `inactivityTimeoutMs` (core) | operator | one operation including its recovery round | a pathological instant-drop server; the terminal ceiling in `connection_per_poll` mode |
| `SFTP_REDIAL_WARN_INTERVAL` | 10 | every repeating operator line this adapter emits | log flooding. A cadence, not a bound |

### What the accounting counts

**The accounting unit is one lost session, not one interrupted operation.**
A session is a generation: established by a dial, ended by exactly one recorded cause, and never replaced while it is still live.
A drop tears every operation the adapter has on the wire, so a concurrent fan of them -- a `send()` resuming from the protocol continuation alongside the poll cycle's own operations, or the rendezvous sweep in core fanning the rejecting `delete` out -- all enter recovery together over the one session they lost.
The transition queue serializes their re-dial requests: the first to reach the front finds that generation still live and charges it, the rest find it already ended and charge nothing, and the drop costs one handshake whichever of them dialed.
The charge is made by the transition that ends a generation and never by an operation arm that merely observes one gone.
This side's own ends -- the `connection_per_poll` idle release, the connection's terminal close, a fatal SFTP protocol error -- are each charged where they happen, and a generation still live when a recovery re-dial reaches its critical section is one the partner took.
An accounting per arm would spend an operator's configured budget at N times the configured rate and report one survived drop as N; an accounting keyed to a high-water mark over the generations already charged would do the opposite and report two genuine losses of two sessions as one.

**The cumulative budget bounds sessions lost.**
It is read and spent in the same critical section that charges the loss, under the transition lock, so no further drop can land between the read and the charge.
What that means for an operator: a drop whose recovery re-dial fails, and a drop the exhausted budget refuses, each spend their unit exactly as a recovered drop does.
That is what the exhaustion message says, in the unit the budget spends rather than in re-dials it cannot promise were made (`the mid-exchange reconnection budget is exhausted: 4 sessions lost over the whole exchange against a max_reconnect_attempts=3 budget, and every session lost spent one whether its re-dial succeeded, failed, or was refused` at the default budget).
The tally is the ledger's count read at the refusal -- the same counter the end-of-run summary line reports, so the two lines cannot disagree -- and the terminal loss is itself charged before the refusal, which is why the tally can read one past the budget.
A budget of zero has no allowance to describe as spent, so its own clause names the first drop terminal instead.
The count is strictly cumulative and never resets on a successful operation, because a server enforcing a session-lifetime cap makes progress every cycle and a reset-on-progress budget would never bound it.
Once it is spent the next loss raises a terminal `UsageError` naming the exhausted budget and its two remedies instead of re-dialing.
Measured against a partner dropping every session it opens: a fan of 40 concurrent deletes bought no more handshakes than the budget allowed, the arms draining the transition queue behind the one dial (`apps/cli/test/integration/concurrentOpDropRecovery.test.ts`, which holds it at a budget of one, in-process backend only).

**The recovery warning escalates on the last permitted re-dial.**
The recovered-session line is paced by `SFTP_REDIAL_WARN_INTERVAL` above -- the first loss, then every tenth -- so a long exchange against a session-capping server does not flood the log.
The default budget is below that interval, so pacing alone would never state the last re-dial; the line is therefore forced out whenever the charge that just landed leaves no allowance, whatever the cadence would have done.
What differs on that line is one clause, the one reporting the allowance: a re-dial that leaves some states how many further mid-exchange re-dials `max_reconnect_attempts` permits before the exchange fails, and one that leaves none states that it was the last permitted and that the next mid-exchange drop ends the exchange.
Nothing else about it changes -- same level, same sentences around the clause -- and no line reports the terminal state itself, which reaches the operator as the `UsageError` above rather than as a warning.
`connection_per_poll`, exempt from the cap, quotes no budget in its own recovered-session line and never escalates it; what bounds that mode is the per-operation peer-inactivity timeout, which the line names instead.

**A sibling arm that reaches the check on the unit its own loss spent is refused, not given the dial.**
The state is reachable only at the cap boundary, and only once the arm that charged their shared loss has failed to re-establish the session: a sibling arriving over a session that charge's re-dial restored never reaches the check at all, finding the session live and re-issuing on it.
The refusal is what keeps one lost session worth exactly one re-dial round however many operations the drop tore, a dial for the sibling being a second handshake on a unit already charged.
It costs the operator nothing against reaching the same boundary serially, which is measured rather than argued.
With one unit left and its re-dial failing, the fan's charging arm reports the dial's own error and the sibling the terminal one.
Serially the same failure is reported on the operation that charged it and the terminal error on the next operation issued - the same one charged loss, the same dials spent, and no dial past the budget in either.
What a fan changes is which operation hears the refusal.
Both readings are consistent with a cumulative bound on sessions lost; the fail-closed one ships, on a budget whose purpose is to bound a partner that keeps taking sessions, and the pair of adapter unit cases that drive the two shapes at a budget of one is what pins it.

**Below the cap, a sibling behind a failed round is refused too.**
With units left, the budget check passes a sibling arm that arrives after the charging arm's re-dial round failed, so the adapter records which lost session the round was charged for and refuses any later arm over that same loss while no dial has landed since.
The refused arm fails with the loss it already had and dials nothing, so a fan of any width torn by one drop spends one round of dial attempts, and an operation issued after it does too.
A teardown's re-dial is exempt, as it is from the budget.
An adapter unit case drives a fan of four at a budget of three.

**Two exemptions keep that cap from cutting where it should not**, each for a measured reason the table's row cannot hold.
`connection_per_poll` is exempt in every phase because the rendezvous that precedes its loop holds one un-heartbeated session across its wait for the partner, so a server cap cuts it there on a wait long enough to outlive the cap.
The exemption is what lets the rendezvous survive such a drop (measured: the rendezvous re-dials as often as the cap cuts it and the exchange completes, where the held-session default in the same scenario exhausts the budget and fails terminally; `apps/cli/test/integration/ephemeralSessionExchange.test.ts` holds both against the in-process harness server).
A teardown re-dial - the authenticated abort-marker write and the terminal-frame drain, marked by core's `beginTeardown()` signal at `close()` and at the marker write itself - is exempt so the fast-fail marker still lands when the budget is exactly what was just exhausted.

Every trigger that ends a session, drives a re-dial, or concludes an idle boundary, and what each does to the operator-facing accounting.
A new trigger appends a row.
A release that raises records no outcome: the call-site resolution that cannot find the transport internals raises before classifying anything (no generation ends there), and a throw out of the driven close propagates after the entry classification but before the count, the transition's catch restoring the entry reading.
The boundary totals therefore cover every release that ran to its count -- the raise paths are the stated limit.

| trigger | ends a session | counted in `reconnects` | charged to the cumulative cap | warned | boundary recorded |
| --- | --- | --- | --- | --- | --- |
| partner drop tearing an operation, held-session mode | yes | yes | yes | paced | `notReleased` |
| partner drop tearing an operation, `connection_per_poll` | yes | yes | no (mode exemption) | paced | `notReleased` |
| withheld-close drop (session set over an ended transport) | yes | yes | mode-dependent, as above | paced | `notReleased` |
| partner drop absorbed at an idle boundary, nothing torn | yes | yes | no | paced | `releasedOverEndedTransport` |
| peer FIN observed at an idle boundary | yes | yes | no | paced | `notReleased` |
| session already cleared at idle-release entry | yes | yes | no | paced | `notReleased` |
| partner drop absorbed by the next cycle-start dial | yes | yes | no | paced | `notReleased`, on the dial's success |
| deliberate idle release, then the next cycle's dial | yes | no | no | no | `deliberatelyReleased` |
| forced idle release (close withheld past the bound) | yes | as its entry classification above | as its entry classification above | paced | the entry classification, unchanged |
| teardown re-dial (abort marker / terminal drain) | yes | no | no (teardown exemption) | no | `notReleased`, on the dial's success |
| the connection's terminal close | yes | no | no | no | -- |
| a fatal SFTP protocol error | yes | no | no | no | -- |
| connect-time dialing retry past the first | no | yes | its own per-`connect()` loop | no | -- |
| idle release or cycle re-dial that declined its acquire | no | no | no | paced | unchanged |
| idle boundary held for an outstanding operation | no | no | no | no | unchanged |
| idle boundary over a generation already ended and charged | no | no | no | no | unchanged |
| idle release whose `end()` closed nothing (transport still writable after the wait) | no | no | no | unpaced | `notReleased` |
| forced destroy that did not clear the session | no | no | no | no (the release raises) | unchanged, recorded before the raise |

**Which rows a real server drives.**
Against the in-process harness server (`apps/cli/test/sftpServer/`, so none against a native `sshd`), the integration suites under `apps/cli/test/integration/` hold the counting and charging columns of these rows: a partner drop tearing an operation in either mode (`concurrentOpDropRecovery.test.ts`, `inflightDropRecovery.test.ts`), the withheld-close drop (`heldSessionWithheldClose.test.ts`), a partner drop absorbed at an idle boundary and the forced release over it (`ephemeralSessionExchange.test.ts`), the deliberate release and its next dial (`sftpConnection.test.ts`, `ephemeralSessionExchange.test.ts`), the declined acquire (`transitionWaitBound.test.ts`), and the boundary held for an outstanding operation (`concurrentOpDropRecovery.test.ts`).
`inflightDropRecovery.test.ts` also holds `reconnects` and `transportRetries` apart: a transient `RENAME` refusal moves only the retry count, and a recovered drop only the reconnect count.
The other rows -- a peer FIN or an already-cleared session at release entry, a drop absorbed by the cycle-start dial, a boundary over a generation already ended, the teardown re-dial's and terminal close's exemptions, a fatal protocol error, a connect-time dialing retry, and the two degraded release outcomes, which no server can produce from a pinned stack -- are held by the adapter's unit cases over stand-in clients (`apps/cli/test/unit/`), unverified against a real server in-container as of 2026-10-05.

The boundary column answers a question the counting does not: whether the session's absence is a release's doing.
An operation issued after a boundary reads it to decide between re-establishing through the cycle-start dial and being issued at a session that is gone; `deliberatelyReleased` and `releasedOverEndedTransport` both say a release took the session, and only the first says the release also ended it.
No reading that a release took the session may stand over a session that is still live, and a transition that raises leaves the reading it found.
So a release that ended nothing, and a dial that established a session and then failed its own post-connect verification (whose failure the cycle-start reconnect reports as a skipped cycle rather than a raise), both leave the next drop classifiable as the drop it is.
A forced release leaves the entry classification standing, because the forcing says how the boundary concluded rather than who ended the transport beneath it: a boundary forced over a drop the partner had already delivered is counted and warned as that drop, one forced over an ordinary release is counted nowhere, and the forced total spans both.
Which release outcome each reading comes from, and what session each leaves behind, are in [FILE_SYNC.md](FILE_SYNC.md#session-lifetime-across-an-idle-boundary).

### Re-issuing an operation

**Per-operation idempotency, applied only on the re-issue.**
The relaxations below never touch the first attempt, so genuine lock-conflict and absence detection are unchanged.
`list`/`get`/`exists` re-issue verbatim, and so does a `put` to a protocol temp (`temp-<uuid>.tmp` or `temp-hello-<uuid>.tmp`): its `flags:"w"` truncate-overwrite is effect-idempotent, no reader acts on a temp, and its bounded source is rebuilt from the retained Buffer/chunk list; a one-shot stream source is never re-issued.
A `put` to any other name is a direct write, whose re-issue is below.
`delete` maps a source-absent re-issue (`SSH_FX_NO_SUCH_FILE`) to success, since a pre-drop delete that landed reports the source gone.
`rename` treats a re-issue whose source is gone (or a code-4 dest-exists) as success when `exists(dest)` confirms the destination, sound because every rename destination is self-prefixed and so unambiguously this party's own landed attempt.
The converse does not hold and is not relied on: an absent destination is not evidence the rename failed.
In delete mode the partner's consume-delete removes exactly this party's own self-prefixed write, so a rename that landed durably and was consumed inside the recovery window reports the state a rename that never landed reports -- source gone, destination absent, `SSH_FX_NO_SUCH_FILE` -- and no reading the adapter can take separates them (see "A write the transport cannot resolve" below).
`createExclusive` resolves its own normalized `EEXIST` on re-issue as success, reusing the existing code-11 / code-4-via-`exists()` normalization; the narrow rendezvous-phase "two winners" race this admits is documented at the call site and verified benign (roles commit from hello-filename order before the lock, which only gates eager cleanup).

**A write the transport cannot resolve is rejected as undetermined, never as a determined non-delivery.**
One state survives the recovery above unresolved.
A `rename` torn after its filesystem work landed at the server but before its reply was written is a durable write the sender never learned of.
If the partner consumes it inside the sender's recovery window -- in delete mode, the consume-delete of a message is the partner's normal receipt path -- the re-issue then reports `SSH_FX_NO_SUCH_FILE` over an absent destination, which is exactly what a write that never landed reports.
A source still on the server is the one signal that does separate them, and the adapter probes for it: a re-issue whose source survived is a write that never landed, classified determinately.
Once the source is gone the two converge, and measurement found no adapter-observable signal that separates them there.
The torn first attempt's error text and code are identical either way, the re-issue's SFTP status is `SSH_FX_NO_SUCH_FILE` in both, `exists(destination)` is false in both, and the consumption leaves no durable trace in delete mode (after the remove the receiver writes nothing).
Probing earlier within recovery does not help either, since the replacement session's first operation is a full SSH handshake behind the consumption, and the adapter's own knowledge that a drop occurred with a rename in flight identifies the class, not the outcome.
The runs behind that reach the source-absent state by the landed-and-consumed route; a never-landed write whose source some third party then removed is the same state by another route, and is not staged.
Separating them would take a durable artifact created by the write or by the consumption -- a change to the write shape or the protocol, not to this recovery.
So the adapter rejects that state with a distinct error type (`TransportPublishIndeterminateError`) with the re-issue's own error as its `cause`, rather than resolving it (which would report a message that never landed as sent) or propagating the raw `SSH_FX_NO_SUCH_FILE` (which states a non-delivery it cannot know).
Every neighbouring state is unchanged: a confirmed destination resolves, a re-issue failing with the source still on the server propagates its own error, and a non-`SSH_FX_NO_SUCH_FILE` failure -- including the code-4 generic failure, the server's answer that the rename did not take effect -- propagates unchanged.
A server reporting a missing rename source as code 4 rather than `SSH_FX_NO_SUCH_FILE` would therefore be classified determinate; the pinned stack does not (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md)).
The rejection is caller-neutral by design: `rename` is shared machinery, and four writes reach it -- the message loop's `send()`, its ack, the rendezvous `joining` -> `hello` rename, and the abort marker -- which share no recovery.
So its message names the *file* rather than a message, prescribes no next step, and is not marked with `markStatesItsOwnNextStep`; a caller whose recovery is established restates it as its own marked error holding this one as the `cause`.
The consumer-side consequence is in [FILE_SYNC.md](FILE_SYNC.md) (I8): the sequence number such a write spent is not reusable, the next `send()` is refused rather than writing a second message under a sequence number the peer may already have delivered one under, and `send()` is the one caller that does restate this rejection with a remedy.
A party [writing without renaming](FILE_SYNC.md#writing-without-renaming) issues no `rename`, so neither arm above runs for it: each write is a `put` to the final name, and a reply lost to a drop is resolved by probing that destination, never by re-issuing the `put` blind.
A destination present at the source's full byte length is the write landed, and the `put` resolves without a re-issue.
A destination present but shorter is a `put` that stopped short, on which no reader has acted (a message reader waits for the byte count its name declares, the hello reader retries a short read, an ack is zero-length, and the sentinel is matched by name and never read), so the truncate-overwrite `put` is re-issued once.
A destination absent, longer than the source, or that the probe could not read is rejected as `TransportPublishIndeterminateError`: in delete mode the partner may already have consumed it, and nothing the adapter can read separates that from a `put` that never landed.
A message whose `put` rejects spends its sequence number the same way.
A first attempt a server refuses with `SSH_FX_NO_SUCH_FILE`, which is how a server that does not allow renames answers, is not a re-issue: it propagates as itself, and core restates it naming that option.

### Operations concurrent with a re-dial or a release

**Issuance is not serial, and the re-dial does not rest on its being so.**
Within one operation the first attempt's promise has settled before its recovery catch fires the re-dial -- that catch is where it settled.
Other operations are not serialized against it, though: a `send()` resuming from the protocol continuation issues its operations alongside the poll cycle's own, so a second adapter operation can be unsettled while a re-dial runs.
The re-dial neither waits for one nor is made unsound by one, and the measurement says where such an operation goes rather than only that it is harmless.
The retirement that precedes the dial waits out -- and against a withholding partner drives itself -- the transport close that tears it, so it is settled ahead of the dial with a drop-shaped rejection of its own and re-issued through its own recovery round, rather than left to ride the per-operation liveness deadline.
Where a route settles later than that -- the chunked `put`'s bounded source -- it is fenced instead: it was issued against the session being torn down, and the heartbeat epoch that `connect()`'s re-arm advances is what keeps its late settlement off the fresh session's in-flight count.
That is measured against a real partner, driven for a raw-wrapper `list` alongside a high-level `get` in both issue orders, for a forty-way `Promise.allSettled` `delete` fan-out (the rendezvous orphan sweep's shape), for the never-reject `Promise.all` `safeDelete` fan-out beside it, and for a keepalive parked on the wire under both partner classes; `apps/cli/test/integration/concurrentOpDropRecovery.test.ts` holds each of those shapes against the in-process harness server.
Three shapes are stated limits rather than covered ones.
The `safeDelete` fan-out never reaches this window at all, sitting outside the recovery chokepoint by its never-reject contract, and what covers a cleanup delete that did not take effect is the record the adapter keeps for it (below).
A partner that drops the SFTP session while withholding its connection close produces no tear to settle anything, so both operations ride to the first deadline that expires and the forced close that follows settles the rest, which is the withheld-close path above rather than this one.
And core's own `send()`-alongside-`poll()` interleaving, driven across a sweep of cut points, put two operations on the wire at the tear in only some of them and reached this window in none, so what the shapes above measure is the adapter's behavior under such concurrency and not a demonstration that the poll loop produces it at a drop.
The numbers, the cut positions, and the pairs the runs did not reach are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

A second concurrency is core's per-operation `inactivityTimeoutMs` budget (a `Promise.race` in `boundTransport`), which can reject a stalled operation to the caller while the adapter operation keeps running, so an abandoned operation may still be inside its re-dial's `connect()` when the aborting caller reaches `close()` -> `end()`.
Both share the one `Ssh2SftpClient`, and a fresh handshake must never overlap `end()`'s `client.end()`.
Two guards close that.
(1) Both take the adapter's session-transition lock (below), so `end()` runs behind the re-dial rather than under it; the post-re-dial `closing` check then reports the original loss rather than re-issuing into a closing adapter, and teardown's own place in the queue is what ends whatever session that re-dial established, so none outlives the close.
That wait takes whatever bounds the dial itself (`connect()` has its own retry budget and each attempt its `readyTimeout`), and above it `end()` inherits the ceiling of whoever called it, which for a teardown is core's teardown budget.
(2) The re-dial stops the heartbeat before calling `connect()`, so the dropped session's still-armed keepalive timer -- which a clean drop, unlike a fatal error, does not stop -- cannot post a `realPath` on the client mid-handshake; `connect()` re-arms a fresh heartbeat at the end of its sequence.

**The `connection_per_poll` idle boundary is a third such concurrency, and is serialized the same way.**
Its release drives the ssh2 `Client`'s `end()` and awaits the `'close'`, and it is that `'close'` -- not the `end()` -- that clears ssh2-sftp-client's `sftp` property.
Between the two the session can still read live, over a transport that `end()` has already ended, so an operation rejecting in that window rejects against a session that reads live and is not -- the transport reading above resolves that as the loss it is, while the boundary the release recorded is what decides the accounting.
After the window it rejects against a cleared one, which without further information is treated as a server drop.
An operation reaching the transport at a boundary is driven by the protocol continuation, not by the poll cycle, so it can land on either side of it.
The release does not leave the end of that window to the partner: a server that accepts the disconnect and never closes the connection leaves the transport ended with the session still reading live, so past its bound the release destroys the socket itself and the resulting `'close'` clears the session (the internals and the measurements are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md)).
The window spans that forced close, and the release holds the transition lock across it, so an operation arriving inside it is serialized on exactly the terms below rather than being admitted by a session that can no longer answer.

An operation issued once the release is running is held off both readings at the adapter's recovery chokepoint -- the entry point of the recovery-wrapped operations, which is all of them but the never-reject cleanup delete (covered instead by the record below) and a `put` whose source cannot be re-issued.
With a release in flight, or a boundary still standing that says a release took the session, the operation re-establishes the session before its first attempt, queued behind the release so it runs on the far side of the close rather than racing it.
The precondition is adapter-owned rather than spread across the calling sites in core, because the release that opens the window is adapter-owned; a per-call-site precondition would be an invariant held by discipline, which any future operation issued outside the poll cycle would silently break.
The re-establishment is best-effort: a dial failure there resolves rather than rejecting, because the gate is a precondition and not the operation -- the attempt that follows is what decides the outcome, and its own recovery round reports a transient failure with the real error.
A host-key rejection still fails the operation closed one step later through the recovery path's own `connect()`.
Both readings are written from inside the release's own transition -- the in-flight reading when it reaches the front of the queue, the boundary just before it drives the close -- so "running" is the operative moment, not the call to `releaseForIdle()`.
An operation issued while that release is still queued behind another transition reads neither and is issued against the session that is still live.
It is on the wire by the time the release enters, and the outstanding-operation precondition below is what covers it.

**A recovery re-dial and a release are serialized against each other wherever the two meet.**
The re-dial queues behind the release on the transition lock, so neither a teardown nor a handshake overlaps the release's own close.
A handshake started inside that window resets ssh2-sftp-client's event flags and installs its own temporary listeners, so the release's stale `'close'` would land on the fresh handshake and reject it, charging the exchange a re-dial retry (or, at `max_reconnect_attempts=0`, a terminal failure) for a session the adapter closed on purpose.
Where they meet is the boundary held for the arm's own outstanding operation (below), a boundary reached anywhere inside the arm being held rather than closed: the release enters ahead of the arm and closes, and the arm's re-dial then parks on the lock with that release's `'close'` still owed.
The unit case drives exactly that meeting, and measures both halves of it -- the dial not taken while the release holds, and the operation resolving on the session dialed once it lets go.
The release queues behind an in-flight dial for the mirror reason: a dial that lands after the boundary would hold its session across the whole idle gap.

### The outstanding-operation hold on an idle boundary

**An operation the adapter has issued and not settled holds the boundary: no release closes over a counted one.**
No gate at operation entry can cover an operation already on the wire, so the precondition is the release's own.
The adapter counts the server-driven operations issued and not yet settled at the single entry point every one of them passes through, which opens one span per operation from where it is issued to where it finally settles, a recovery arm included.
That span includes the two the recovery chokepoint does not reach, and excludes three round trips issued outside it (the heartbeat's keepalive, the best-effort handle close a listing fires once it has settled, and the cleanup drain's re-issue below).
The release reads it once, inside its own transition, with the queue held and nothing yet driven.
A non-zero reading returns without closing: the session stays up for the operation it was issued against, and the first boundary past that operation's settlement releases as usual.
The count is the adapter's own rather than the SFTP heartbeat's, which the release itself stops as its first statement and which this mode never arms.
It is a hold and not a drain -- the release does not await the operation -- so nothing gains a wait: the release's own bounds stand unchanged, a teardown queued behind it cannot be parked past them, and the drained-boundary path still drives the ssh2 `end()` synchronously with the call.
The precondition applies to the idle release and to no other transition: a teardown closes over whatever is outstanding by design, and a recovery re-dial that waited would park behind the very class of operation that drove it.
A held boundary is ordinary rather than anomalous -- a concurrent `send()` straddling a boundary produces it -- so no occurrence is warned, and it is in particular not a declined release, which reports a transition that did not complete within the release's wait.

**What a held boundary costs, and what the run reports.**
It costs the mode one idle gap per boundary the operation straddles, and the run's total is accounted rather than left silent.
Two adapter counters cover it: `heldBoundaryCount` (every boundary a release holds) and `heldBoundaryStretchCount` (the unbroken stretches those boundaries fall in, a stretch opening at a held boundary with none open and closing when the outstanding count next reaches zero).
Both are reported together as one end-of-run operator line at default verbosity, the stretch sub-count only where it is strictly below the boundary count.
Both stay out of the reconnect total and out of the machine `metrics` event, because nothing was closed and so nothing was lost.
What the stretch measure separates is one unbounded transfer holding twenty boundaries (20 boundaries, 1 stretch) from twenty straddling `send()`s that each settle between boundaries (20 and 20) -- the first says the mode has stopped delivering per-cycle sessions for the rest of the run, the second that it is working.
Its stated limit is that it measures unbroken hold and not operations: operations that overlap continuously, never letting the outstanding count reach zero, read as one stretch however many of them there were.

**The exclusion set is a check rather than a claim.**
Two sibling analyses parse the adapter with the TypeScript compiler API over one shared definition of a request-issuing call site (`scripts/lib/sftpAdapterSites.mjs`, so the two cannot come to cover different sets).
`scripts/sftp-tracked-round-trips.test.mjs` fails on any site the per-attempt bracket does not cover and its three allowances do not name.
`scripts/sftp-operation-spans.test.mjs` fails on any site no outstanding span encloses and its two allowances do not name, so a data-plane entry added later that reaches the client without the entry point above it fails there rather than passing unnoticed.
Their common reach is what they can follow syntactically: a call written as a property access (`receiver.member(...)`)
on the client, on the raw `SFTPWrapper`, or on a local aliasing either, with coverage traced through the adapter's promise plumbing and its spans through the private single-attempt methods a `runOperation` body calls.
Each header states that reach exactly, and with it where its analysis falls short of a proof.
A callee or a receiver written outside the reach is not decided at all, and a best-effort call that merely names a settler is credited with the bracket.
And the span analysis decides lexical enclosure rather than enclosure in time.
That is why the listing's post-settle handle close -- outside the span in time, inside the body that issues it -- is named by the bracket's allowances and not by the span's, and why the converse direction, the per-attempt layer being reachable only through the entry point, is not decided either.

**What the count is, and what bounds the hold.**
Issued-and-unsettled is not the set that is on the wire, and departs from it in both directions.
An adapter bound that expires settles the operation on this side while the library request it raced is still outstanding at the server -- every one of these bounds is a race that abandons rather than a cancellation -- so the count returns to zero and the next boundary closes over that request.
Symmetrically, an operation the server never answers is never settled from this side at all: core's whole-exchange budget is the same kind of race, so the operation the adapter counted stays counted.
The hold therefore lasts exactly as long as the operation is unsettled, and the bound on that is the operation's own: the per-operation deadline where it has one, and nothing where it does not.
Two shapes have none -- a `put` from a string or stream source, which has no per-operation bound at all, and a progress-reset window (the chunked `put`'s idle window, the capped `get`'s sink) that a server trickling acknowledgement re-arms rather than trips -- and a session held for one of those stays held for the rest of the exchange.
Both directions are pinned by adapter unit tests, so a change to either fails a check rather than silently contradicting this paragraph.
A third departure is the recovery arm, which the same span covers rather than a second one nested inside it.
The span opens where the operation is issued and closes when it finally settles, so the first attempt, the re-dial, the re-issue and (for `rename()`) the destination probe that confirms a landed pre-drop rename all fall within one span, while the per-attempt heartbeat brackets open and close inside it.
There is therefore no point in an operation's life at which the count reads it settled while it is not.
Each of the two boundaries that would cost a landed write is covered by construction rather than by placement: between the re-issued attempt's rejection and the probe it drives, where a boundary would tear the probe and an unanswered probe confirms nothing, so a rename that did land would be reported as the undetermined outcome above.
And between the re-dial and the re-issue, where a boundary would close the very session the re-dial established and the re-issue would reject with a dead-session error that no per-operation resolver reads at all.
Both are pinned by adapter unit tests that sweep a boundary across the whole arm rather than placing it at one named point, since with one span there is no reading of the count that names either boundary.

**The heartbeat's activity accounting stays at the per-attempt bracket rather than moving to the span.**
It answers a different question -- whether a round trip is on the wire, which across a recovery arm none of this operation's is -- and widening it to the span would leave the re-issue unmarked.
The arm's own re-dial re-arms the heartbeat from scratch and zeroes whatever in-flight count preceded it, so a keepalive could then be posted alongside the very round trip the bracket exists to keep one away from.
`connection_per_poll` arms no heartbeat at all, so the question does not arise in the mode the outstanding count serves.

### The deferred cleanup-delete record

**A cleanup delete of this party's own in-flight temp file, issued into the idle gap, is recorded and re-issued.**
The never-reject cleanup delete is the one operation that reaches no gate at all: its contract puts it outside the recovery chokepoint, so a delete issued with a release in flight, or with a boundary standing that says a release took the session, reaches no session and removes nothing.
It resolves all the same, so its caller in core cannot tell that from a delete that landed.
Only the adapter can, which is why the record lives there, on exactly the terms the recovery chokepoint's precondition states: a per-call-site check in core would be an invariant held by discipline.
What it costs otherwise is a file no later mechanism in the run sweeps -- the in-flight `temp-<uuid>.tmp` a failed `send()` removes from its own catch, which is tracked in no responsible-file set and so never reaches `cleanup()` (see [FILE_SYNC.md](FILE_SYNC.md)).
The path is recorded on two readings, either sufficient on its own: the release readings the gate above takes, read before the delete is issued, and the delete's own rejection, which additionally covers a cleanup that failed for a reason of its own.
It is re-issued at the tail of each re-establishment (`ensureConnected`), with the session-transition lock released -- the one call site that covers both the cycle-start re-dial and the re-establishment `close()` drives ahead of the terminal-frame drain.
A re-issue that fails is offered back to the record -- so a server briefly unreachable at one boundary is swept at the next -- against a bounded per-recording budget rather than for the life of the run, and on the same cap the first record ran.
It is not retain-gated and must not become so: a `temp-*.tmp` is a failed in-flight write and never transcript, so a retain-mode run leaves none behind either.

**Only the protocol's own in-flight temp shapes -- `temp-<uuidv4()>.tmp` and the hello write's `temp-hello-<uuidv4()>.tmp` -- are admitted to the record, and that is what makes deferral sound.**
`safeDelete` is a general transport method: core calls it with the shared rendezvous lock path, and with names read back from a listing of the directory the peer writes into.
A record is keyed on a path and re-issued at an arbitrary later point, so admitting one of those would let a transiently-failed delete remove whatever has since come to occupy that name -- a fresh authenticated abort marker the peer wrote in the interim, say, turning a fast `PeerAbortError` into a wait to the peer-inactivity ceiling.
Both temp shapes have a per-file v4 UUID, so the path a re-issue reaches is the file it was issued for or nothing at all.
The recognizer is core's own (`isProtocolTempName`, which spans both shapes), not a copy in the transport, so the two cannot drift; the basename is what decides.
(The entry sweep applies a narrower predicate -- it excludes the hello shape, which may belong to a concurrently starting peer; see [FILE_SYNC.md](FILE_SYNC.md).
So the only hello temp that ever reaches this record is one this party wrote itself, from the write's own failure path, never a name read back from a listing.)
Every other path `safeDelete` is handed keeps the plain best-effort behavior -- issued once, never recorded -- which is also what bounds what an adversary can do to the record: the only names that consume it are protocol temps.

**Each re-issue has a teardown-scale deadline, and that is what bounds the whole drain.**
The re-issues go out concurrently, and each is held to **5 s** in place of the 60 s per-operation deadline every other round trip has, so the drain costs one such wait rather than one per record and needs no ceiling of its own above them.
The value is teardown-scale because of where the drain's wait lands: core forwards `ensureConnected` unwrapped and `close()` awaits it with no budget above, and the recovery gate's first attempt after an idle gap waits behind it too.
Without it a server that accepts delete requests and withholds their callbacks would add a whole per-operation deadline (60 s) to every close -- an order of magnitude above the teardown bounds beneath it.
Cutting a re-issue short there loses nothing real: against such a server the delete was not going to take effect, and the expiry is a rejection like any other, so the path is offered back to the record on the terms below.
The drain resolves rather than rejecting, and its result is fenced out of `ensureConnected`'s: core's poll loop treats an `ensureConnected` rejection as a terminal dial error, so a best-effort cleanup sweep must not be able to end an exchange.
The dial's rejection is not fenced -- a host-key verification failure still fails the exchange closed through this same method.

**The re-issue is the one unsettled round trip an idle release may tear, and is left uncounted.**
Of the round trips this mode leaves the adapter waiting on, every one but the drain's re-issue passes through the outstanding-operation bracket whose count is the idle release's precondition -- the heartbeat's keepalive is unbracketed as well, and this mode arms no heartbeat -- and that exclusion is what preserves the mode's own guarantee.
The third unbracketed round trip is not this case: the best-effort handle close a listing fires once the listing has already settled, which a boundary falling there tears too, at the cost a withheld close callback has anyway -- a handle leaked until session teardown, which under `connection_per_poll` is that boundary.
Already-settled work needs nothing from the release's guarantee; the re-issue is the round trip for which that guarantee had to be reasoned about at all.
Counted, a re-issue against a server that accepts DELETE and withholds its callback would hold every idle boundary for its whole bound -- and a boundary that closes nothing leaves the session live, so the next re-establishment finds one, re-runs the drain and regenerates the operation, `connection_per_poll` silently reverting to a held session for the rest of the run.
That needs no failed write to reach: the entry sweep hands every listed `temp-<uuidv4()>.tmp` from a server-supplied listing to the cleanup delete.
Two properties make the tear sound.
The record survives it -- the torn delete rejects, which offers the path back to the record -- so the release defers the work rather than losing it, which is the very thing the record exists to do.
And a torn DELETE of this party's own temp leaves no state its re-issue can misread: the server either performed the unlink or did not, and the re-issue reads the first as the success it is (`notFoundOK`).
The bracket's other duty does not reach it either -- the record and the drain exist only in `connection_per_poll`, which arms no heartbeat.

**What bounds the record: a cap on entries, and a re-issue budget per recording.**
The record is capped at `MAX_DEFERRED_CLEANUP_DELETES` (**64**), and overflow refuses the new record rather than evicting an older one: refusing degrades the overflowing cleanup to exactly the behavior it had before the record existed, while evicting would turn a cleanup this adapter had already promised to re-issue into a silent loss.
Each recorded path additionally has a budget of `MAX_DEFERRED_CLEANUP_REISSUES` (**3**) re-issues: a re-issue that fails records the path again with one fewer, and a spent budget gives up on that recording.
Without it the only thing that ever clears a record is a delete this side saw succeed, so a delete that can NEVER succeed -- a peer-owned temp under a sticky-bit directory, which the entry sweep still attempts -- is retried at every re-establishment for the life of the exchange.
With the record full that is a whole record's worth of extra DELETE round trips per poll cycle against the partner's server.
A spent budget degrades that cleanup to the pre-record behavior exactly as overflow does, and is logged at debug for the same reason.
Re-recording a failed re-issue runs through the same capped, shape-narrowed path a first record does, so a re-record made while the record is full is refused like any other.
What the drain guarantees is that a path it could not perform is offered back, not that it is always kept -- refuse-not-evict applies to a re-issue's own path as much as to a newcomer's.

**What the budget is a bound on, and the amplification that leaves.**
It is per recording and not per path per connection: giving up ends that recording and remembers nothing about the path, so a path that reaches the cleanup delete again is recorded afresh with the whole budget, by either route into the record.
A path re-recorded while its own re-issue is still in flight likewise keeps the budget the re-record wrote, the record leaving an entry that already stands untouched rather than applying the failing re-issue's decrement to it.
What that costs a run turns on which call site offers the path, and for the case above -- a temp this party can never delete -- only one does.
Core sweeps orphaned temps in the rendezvous entry scan, which runs once per exchange rather than once per poll cycle, and the poll loop tolerates a protocol temp without ever sweeping one.
Such a temp is therefore recorded once and costs that sweep's own attempt plus `MAX_DEFERRED_CLEANUP_REISSUES` re-issues spread over the re-establishments that follow -- a few round trips for the whole run (`apps/cli/test/integration/ephemeralSessionExchange.test.ts` holds that count against a server whose own `unlink` refuses, over seven poll cycles).
The per-cycle reading is what a caller re-offering the same path every cycle would pay, each re-offer being a fresh recording; no call site does that today, and this is the assumption to re-check before one is added.
The amplification is bounded either way: a drain issues one re-issue per recording, and the cap above bounds how many recordings stand at once, so what a re-establishment can cost is one bounded sweep of the record.
Remembering a given-up path -- a tombstone that would make the budget per path per connection -- is not done, because it would consume a cap slot, which is how a peer would crowd the send path's own cleanups out of the record.
What the budget does not cover is the mode's per-cycle session: what keeps an idle release from being pinned off is the re-issue's exclusion from the outstanding-operation bracket, and the budget does not stand in for that exclusion.
Counted, a re-issue holds the boundary of every cycle its budget reaches, measured against a server that accepts DELETE and withholds its callback as four handshakes over seven poll cycles where the uncounted re-issue delivers seven.
The same suite holds the seven, and no held boundary, against that server; the four is the reading of a re-issue counted in the bracket, which no shipped build does, so it stays unverified in-container as of 2026-10-05.

**The five states that drain nothing, and two stated limits.**
The refusals above are logged at debug rather than warned -- they fire only where a drain has repeatedly failed to reach the server, which the operations that needed that server already report.
The drain does nothing in five states, each for its own reason:

- the default held-session mode, which keeps no record and issues no drain at all;
- a fatal SFTP protocol error, where a request posted to the destroyed wrapper never calls back -- the very thing the cleanup delete's own short-circuit refuses to do -- so a cleanup recorded before that error is not reintroduced at teardown after it;
- a latched teardown, where `end()` is already closing the client;
- no live session, the record keeping for the next re-establishment;
- an empty record, the mode's healthy path, which costs no round trip.

Two limits are stated rather than closed.
The first is the run: a record left when no further re-establishment happens is never re-issued, so the guarantee is that a cleanup deferred across an idle boundary is performed later in the same run, not that the adapter eventually reconciles the directory.
The second is the cap, whose bite the re-issue budget bounds rather than leaving to stand for the run.
A directory holding many protocol temps this party cannot delete -- peer-owned files under a sticky-bit directory, which the entry sweep still attempts and whose number is therefore peer-influenced -- can fill the record before the send path needs it, and a send-path cleanup offered while the record stands full is refused.
Such a fill clears itself, because the drain clears the record before issuing, each failed re-issue re-records at one below the budget it ran with, and a spent budget is given up on rather than recorded again.
A fill made entirely of undeletable temps survives the `MAX_DEFERRED_CLEANUP_REISSUES - 1` re-establishments that follow it, standing full again at the end of each, and is gone by the end of the `MAX_DEFERRED_CLEANUP_REISSUES`th, which admits the send path again.
Measured at the cap against a server whose own `unlink` refuses for real: the record stands full and refuses a send-path cleanup after each of the first two drains, and is empty and admits one after the third and after every drain past it (`apps/cli/test/integration/ephemeralSessionExchange.test.ts`, at `MAX_DEFERRED_CLEANUP_DELETES` temps under a directory the served user may not write).
What a refusal inside that window costs is exactly the pre-record behavior -- that cleanup is issued once, never re-issued, and its temp survives the run, which the first limit already excludes from the guarantee -- and it is that degradation, rather than any claim about how hard a peer-influenced fill is to produce, that the cap is accepted on.

### The session-transition lock

**Every session transition runs under one FIFO lock the adapter owns, teardown included.**
The five -- the first dial, the cycle-start reconnect, the recovery re-dial, the idle-boundary release, and `end()` -- acquire it through one helper, taking their queue slot synchronously at the call, so they run in the order they were requested in and a microtask inserted anywhere on a transition path cannot reorder them.
The helper is where the teardown latch gates a queued transition, once per transition; the adapter reads the latch at a few other places too (before a re-dial, a retry, a peer-identification diagnosis, or a deferred cleanup), and each such read only stops that work once teardown has begun.
`end()` sets it synchronously before enqueuing, so a transition queued behind teardown does not run its body (it returns its caller's stated "nothing to do" value, or refuses a re-open) while one already running is waited out by teardown's own position in the queue.
`end()` therefore has no privileged entry and pre-empts nothing.
Without that ordering a handshake would run alongside `end()`'s `client.end()` and, because ssh2-sftp-client's `end()` short-circuits on a cleared session, that `end()` would resolve without ending the ssh2 `Client` at all -- `close()` returning over a ref'd socket.
The mechanisms driven past the public API -- ssh2-sftp-client's `connect()` and `end()`, the ssh2 `Client`'s own `end()`, and the forced socket destroys -- each present the transition they run inside and check its identity against the one holding the client.
So the chokepoint is a check rather than a reading of the call graph, and it cannot be satisfied by a transition that merely happens to be running.
Its single exemption is named and narrow, and is the subject of the paragraph below.
The lock also covers the release boundary above: the helper is its only writer, it restores what it found when a transition raises, and it takes any reading that a release took the session back from a transition that leaves a session still live.

The lock is not mode-gated, and two orderings in the default held-session mode follow from that.
A teardown concurrent with the first dial never runs ssh2-sftp-client's `end()` under that handshake -- the overlap this whole control exists to stop, and the one that motivated it.
It waits the handshake out only as far as the acquire bound below, past which it destroys the transport and cuts the handshake short (measured against a real ssh2 server that stalls its handshake: `end()` returned about 10.0 s after the teardown was requested and the parked first dial rejected `ERR_GENERIC_CLIENT` 3 ms later when first measured, and 11-12 ms later on 2026-10-05; `apps/cli/test/integration/transitionWaitBound.test.ts` holds the wait inside 5-25 s, the code, and the rejection within a second of `end()` returning).
A `connect()` issued while a teardown is in flight parks for that teardown's own bounds before refusing the re-open rather than refusing at once; the refusal and its wording are the same either way.
Short-circuiting it on a pre-acquire reading of the teardown latch would restore the second, out-of-lock reading that the single in-lock read exists to replace, buying a faster failure on a path no caller in this repository takes (core's `open()` and `close()` are not concurrent).
A `connect()` after a teardown has settled does not park at all: the queue is drained, so its transition enters its critical section in the same tick and the refusal is immediate.
What core layers above is not uniform: it wraps a data-plane operation in a fresh `inactivityTimeoutMs` budget and `end()` in the much shorter teardown budget below, but forwards `releaseForIdle` and `ensureConnected` unwrapped, neither being a peer round trip -- and a bound there would abandon core's wait alone in any case, since it cannot close anything the transport owns.
What bounds each transition's own wait is the adapter's, next.

**The wait for the transition ahead is bounded by one fixed adapter-owned ceiling, and an expired wait never proceeds.**
`TRANSITION_ACQUIRE_TIMEOUT_MS` (10 s) bounds every queued acquire, so no transition can park behind another indefinitely.
The two unattended failures that motivates are a teardown parked behind an abandoned operation's recovery re-dial, which leaves a finished run alive on a ref'd socket, and an idle release parked behind a concurrent `send()`'s re-dial, which stops the poll loop until the hour-scale parked-receive ceiling misattributes it to peer silence.
It bounds the wait and not the transition being waited on.
A ceiling on the dial would make a teardown's wait the dial's whole budget -- `(max_reconnect_attempts + 1)` attempts at `server_connect_timeout_ms` plus the inter-attempt delays, about two minutes at the defaults and unbounded above as the operator raises that timeout.
It would also rest on an assumption about when ssh2 arms its connect deadline rather than on a number the adapter owns.
The value sits above the 6 s a legitimate release can spend (`CLIENT_CLOSE_TIMEOUT_MS` then `FORCED_CLOSE_TIMEOUT_MS`), so a teardown queued behind a normal release does not give up on it -- a relationship between three constants, held by a unit test that drives a release's whole close budget with a teardown queued behind it rather than by the arithmetic.
It owes nothing to the budget `end()`'s caller holds, which can sit on either side of it: core's own `min(CONNECTION_CLOSE_TIMEOUT_MS, inactivityTimeoutMs)` is under this bound exactly where `inactivity_timeout_ms` is below 10 s and above it at `inactivity_timeout_ms = 10_500` (`CONNECTION_CLOSE_TIMEOUT_MS` being 30 s), and `inactivity_timeout_ms` accepts any positive integer up to its ceiling, which leaves both sides of that crossover reachable.
Abandoning core's wait closes nothing in any case: the destroy is what closes the transport, and it runs off the abandon's own timer whether or not anything is still waiting on `end()`, so a caller that gave up is still left an exited process rather than a half-open socket.
That timer is left ref'd as the safe default and pinned as such by a unit case, so the ref cannot be dropped silently; unlike the forced close's ref, though, no process-exit difference behind it is measured, the transition being waited on being itself parked on a ref'd socket handle in every state driven.

No waiter proceeds into its own session action when the wait expires -- not the dial, not the ssh2 client's `end()`, not the socket destroy -- because the transition it gave up on still holds the client.
Each abandons its own transition through the transient-failure path it already owns, and a new transition kind appends a row:

| transition | what its expired acquire reports |
| --- | --- |
| cycle-start dial | a cycle to skip |
| idle release | that it released nothing, under a warning paced like the forced release's |
| recovery re-dial | that no session is live for the re-issue |
| the first dial | a rejection, there being no value that could mean "no session was established" |
| teardown | nothing: it is the one kind whose expiry still closes something, below |

A waiter also gives up its turn without resolving its own queue slot, which stays chained to the transition actually holding the client: resolving it would admit that waiter's successor alongside a holder that has not settled, which is the overlap the lock exists to prevent.
Teardown is the one exception and only in the narrow form: it may give up ssh2-sftp-client's `end()` -- which a live handshake beneath it resolves having closed nothing -- and destroy the transport itself, which needs nothing from the peer and settles the very dial being waited on.
That destroy is the one mechanism driven from outside the transition holding the client, exempt from the identity check above, and what makes it safe is the teardown latch rather than the destroy's own harmlessness.
Every transition behind the teardown skips its body, so the holder ahead of it is the only one that can be running, and the exemption checks that latch rather than asserting it.
Because destroying the socket cuts an in-flight handshake short, `connect()`'s retry loop reads the teardown latch between attempts as well: without that it re-dials on a fresh socket and keeps a torn-down connection, and a process that exits by drain, alive for the remainder of the dial budget.
Both halves are measured against a real ssh2 server (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md)).
Cutting that handshake short also settles it with the exact error a genuine peer close produces, so nothing riding the settled dial may report this side's close as the partner's.
The cycle-start re-dial reads the teardown latch before warning (a closing run has no next tick to retry on either), and an operation whose recovery re-dial was the dial destroyed reports the session loss it was recovering from rather than that rejection.
Both read adapter state -- the latch, and whether an abandoned teardown closed the transport itself -- and neither matches on the error text, which cannot tell the two apart.

### The connection's terminal close

**The connection's terminal close is bounded on the same terms, in both session modes.**
ssh2-sftp-client's `end()` settles only from the ssh2 `Client`'s `'close'`, so a partner that accepts the disconnect and then goes quiet leaves it pending indefinitely -- a hang after a fully successful exchange, in the default held-session mode as much as under `connection_per_poll`, since nothing on that path is mode-gated.
`end()` therefore races that one call against `CLIENT_CLOSE_TIMEOUT_MS` and, past it, drives a destroy of the socket beneath it, which settles the pending call rather than abandoning it; a second, ref'd `FORCED_CLOSE_TIMEOUT_MS` bound covers the destroy, and the socket's own `destroyed` flag is read back where it is driven.
Resolving is the only outcome that means the partner closed the connection: a rejecting call closed nothing (ssh2-sftp-client raises it from a temporary `'error'` listener whose end/close listeners are gated off), so it takes the same forced-close path, and the rejection is re-raised only behind it.
Destroying rather than merely bounding the wait is the point of the control: the half-open socket is a ref'd handle and the CLI's success path exits by event-loop drain, so a bound that abandoned the client would return the caller over a process that never exits.
The forced path requires only the one member it drives, `_sock.destroy`, not the wider set the idle release resolves, so a bump relocating a member this path never calls cannot silently disable it.

**Both of that close's operator-facing guarantees are conditional on the destroy landing.**
The informational line, and the property that no caller -- including one sharing the memoized close -- sees a rejecting `end()` over a socket still alive, hold on the fully successful path alone.
Three degraded branches stand in their place, each warning and returning:

- the one member this path drives is not available after `connect()`, so nothing is destroyed at all;
- the bounded destroy raises;
- the socket does not report itself `destroyed` afterwards.

Each warning names what broke and ends with where to report the library incompatibility (the issues tracker and the `alcove --version` output to include; the upgrade checklist in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) is cited from code comments, not from the warning text), and each names the same operator consequence: the connection is left to the operating system, may stay half-open, and a half-open connection can keep this process from exiting.
None of the three emits the informational line, which reports the close in the past tense and follows the close for exactly that reason.
A rejecting `end()` is re-raised behind every one of them too, so on the member-unavailable branch it is re-raised over a socket this side never closed.
Nothing on the forced path throws: core treats `end()` as best-effort and logs that rejection at debug, and the exit code is untouched either way.
The one informational line at default verbosity is the successful outcome's alone, and the close is not counted as a lost session and not folded into the idle release's forced-release total, which measures that mode's per-cycle boundary instead.
Core keeps a safety check of its own: `end()` is the one transport call wrapped by the short teardown budget [FILE_SYNC.md](FILE_SYNC.md#phase-3----cleanup-and-close) specifies, rather than a fresh peer-inactivity budget.
That safety check bounds core's wait for a transport it does not own; it cannot close anything, which is why the adapter-side destroy is what the guarantee rests on.
