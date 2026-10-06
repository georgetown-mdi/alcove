---
title: "A Retryable or Final Class in the Abort Marker"
---

# A retryable or final class in the file-sync abort marker

_Status: design only; nothing is built. Building waits on an observed base rate of partner-side stalls reaching the marker (below). The classless default is ruled: a fault with no class is final. The marker itself is specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#authenticated-abort-marker), and its file-sync row, lifetime and exit code in [FILE_SYNC.md](../spec/FILE_SYNC.md#sender-side-peer-silence-attribution); this note does not restate them. See [docs/notes/README.md](README.md)._

## The problem

A file-sync party writes the authenticated abort marker on every terminal post-handshake fault with its directory still writable (the catch gate in `apps/cli/src/protocol.ts`). The waiting party reads one as a `PeerAbortError`, which `apps/cli/src/util/exit.ts` maps to 76 with the fixed "contact your partner" step. That is right for a partner refusal and wrong for the partner's own transport stall or drop: the writer's own run exits 69, or for a stall states "check the endpoint and the peer, then retry", while the reader is told not to retry. On a schedule, the reader's supervisor stops and alerts on a fault the next scheduled run on both sides would clear.

## The design: the class is bound into the token's derivation label

The envelope stays `{ version: 1, token }`, the same size, with no new field. The class is which HKDF label derived the token:

- **Final**: `alcove-abort-token-v2:<role>`, the label in use today, unchanged.
- **Retryable**: `alcove-abort-token-retryable-v1:<role>`, one new label, exact-distinct and prefix-free from the final label, the AEAD `alcove-aead-v2:<context>` labels and `alcove-shared-secret-rotation-v2`.

The existing label means final because the classless default below is final.

Writer: `arm()` precomputes both envelope bodies from the two self tokens, and `writeMarker(class)` writes the body for the class of the fault the CLI's catch is handling. The write stays memoized, so a writer never leaves two markers.

Reader: `arm()` derives both peer tokens, and `verifyPeerMarker` compares a present marker's decoded token against each in constant time, returning which one verified. The cost is two more HKDF derivations per session and a second comparison per poll cycle while a marker is present, on a file already read.

What a storage-side edit can and cannot do:

- It cannot read the class. Both tokens are one-way HKDF outputs of the session key, so the admin sees 32 opaque bytes either way. There is still no plaintext cause on disk.
- It cannot change the class. An altered token, or a marker taken from another session or the other role, fails both comparisons.
- It can still suppress the marker by deleting, withholding or corrupting it, which falls back to the peer-silence timeout and its hedge, as it does today.

## The reader's mapping

| Verified label | Reader's error | Exit | Next step shown |
| -------------- | -------------- | ---- | --------------- |
| final | `PeerAbortError`, as today | 76 | `PARTNER_REFUSED_NEXT_STEP` |
| retryable | `PeerAbortError` holding `retryable: true` | 69 | the partner's run failed on a fault a retry may clear; retry on schedule, and contact the partner if it repeats |

The retryable form is outside the `partner-refused` class of `classifyFailure`, so it reaches the 69 rung and gets no refusal step. The `error` event keeps `category: "exchange"` for both, and the exit code tells them apart, as it does for 70 and 76 today. The WebRTC partner-abort frame (`packages/core/src/psi/psiBinaryFrame.ts`) is not a marker and stays 76.

## Which writer faults are retryable

The catch gate lets through every post-arm fault on an incomplete exchange with no signal. The rule: **retryable when the writer's own run tells its supervisor a retry may succeed** -- its own exit 69, plus the two 64s whose own next step is a retry.

Retryable:

- A `transport`-kind failure: the peer-silence timeout, an SFTP session lost past `max_reconnect_attempts` or a failed re-dial, a server rejecting an operation (69).
- `TransportOperationStalledError`: exits 64, but its own step is to retry once the server recovers.
- `TransportPublishIndeterminateError` (69), and the spent-slot `UsageError` the next `send()` raises after it (64). Both prescribe a fresh exchange, which a retry into the same directory is, since the next entry scan sweeps the marker.
- A frame failing the AEAD integrity or ordering check: `security`-kind but not an `AuthenticationError`, 69 on the writer. A retry runs under a fresh session key, so a transient corruption clears; a repeated tamper fails the writer's retries as well, and a supervisor's retry cap bounds both.

Final:

- A partner or terms refusal: `ProtocolRefusalError`, a `protocol`-kind `ConnectionError`, `ReceiptVerificationError` (76).
- `InternalConsistencyError` (70).
- Every other post-arm `UsageError`, such as `FrameSizeExceededError`, `DirectoryListingBoundsError`, a duplicate or malformed message, or unexpected files in the directory (64).
- A post-arm `AuthenticationError` (77).
- A fault the classifier does not recognize (the classless default).

The classifier is a pure function of the caught error, placed beside `exitCodeForError`, so a test can hold each raise site to one class.

## The classless default: final

A fault the writer has not classified writes a final marker, which the reader maps to exit 76.

- **Writer.** It emits the retryable label only for a fault it has positively classified as transient (the retryable list above), and the final label for every other fault, one its classifier does not recognize included.
- **Reader.** The class is bound into the HKDF label, so a marker derived under neither label -- an unlabelled token included -- fails both comparisons and falls back to the peer-silence timeout, as any marker that does not verify does. No third reader state exists: a verified marker is final or retryable.
- **Why final.** An unrecognized fault stops the reader's schedule instead of retrying into a partner that may have refused, re-sending this party's records each time.
- **Cost.** A transient fault nobody classified still stops the reader's schedule as a refusal, until its raise site joins the retryable list.

## The spec text it would change (proposed, not applied)

CHANNEL_SECURITY.md, Authenticated abort marker, first paragraph: replace the token clause and its exit code with

> it writes a best-effort `<id>-abort.json` holding a 32-byte token `HKDF(sessionKey, "<label>:<role>")`, where the label is `alcove-abort-token-v2` for a final fault and `alcove-abort-token-retryable-v1` for a fault a retry may clear; a waiting peer derives both peer tokens, compares a `<peerId>-abort.json` against each, and fails fast with a `PeerAbortError` stating which verified -- exit 76 for final, 69 for retryable.

and name both labels in the domain-separation sentence. Second paragraph: replace "The marker is best-effort and has no cause, both deliberate." and the no-cause reasoning after it with

> The marker is best-effort and has no plaintext cause. The one bit it states, whether a retry may clear the writer's fault, is bound into the token's derivation label, so a storage admin can neither read it nor change it: an edited or substituted marker fails verification under both labels and falls back to the peer-silence timeout.

FILE_SYNC.md, the abort row's envelope cell:

> yes (envelope: `version`, authenticated `token` whose derivation label states the final-or-retryable class, camelCase on disk; ...)

FILE_SYNC.md, Abort-marker lifetime, the Written bullet: append "under the label for its fault's class; one marker per failing party whatever the class." Sender-side peer-silence attribution: replace the sentences from "The marker states only that the partner ended the exchange" to "which is why it exits 76 and not 69." with

> The marker states that the partner ended the exchange and whether a retry may clear the partner's fault, and nothing else. A final marker exits 76: retrying alone does not help until the partner acts. A retryable marker -- the partner's own transport stall or drop -- exits 69, the code the partner's run reports for the same fault. The partner writes a retryable marker only for a fault it has classified as transient, and a final marker for every other fault.

The exit-code rows for 69 and 76 in docs/CLI.md and the partner-refusal code in CLI_EVENTS.md would change in the same work.

## Build precondition: an observed base rate

Build this only once partner-side stalls are seen reaching the marker in real deployments. One observation is a reader run that exited 76 on a verified marker, paired with the writer's record of the same run showing a retryable fault. Alcove sends no telemetry, so observations come from what operators hold:

- The writer's event stream: the terminal `error` event, whose `message` names the stall or transport fault, the exit code, `metrics.reconnects`, and the `stage` events placing the fault after the handshake. It does not state that a marker was written -- that is a debug-level log line -- so pairing needs the writer's debug log or matching run times.
- The reader's event stream: the `error` event with the `PeerAbortError` message and exit 76. Alone it cannot show the class, which is the problem.
- Partner reports: an operator asking why a scheduled run stopped on 76, and the partner's log showing a transport fault. This is the likeliest source, since the two logs sit with different organizations.
- The project's own two-party runs against real SFTP servers, where both streams are at hand.

**Recommendation:** record observations on the tracking item as they arrive, and build once two separate deployments have each shown one, or one recurring deployment has shown it more than once. A field on the writer's `error` event stating that a marker was written would make pairing exact; it is proposed here for the maintainer to take or defer, and nothing above requires it.
