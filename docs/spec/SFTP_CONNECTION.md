---
title: "SFTP Connection"
---

# SFTP connection

This document specifies the controls on how Alcove reaches an SFTP server and keeps its connection safe, with their constant values and enforcement points: the server-provisioning endpoint call that starts or creates the server before the first connection, the SFTP adapter's crash safety on a fatal packet, and the verification of the server's host key.
It is the implementation-level complement to the host-key pinning in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication) and the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), which cover what each control protects against and why the design is sufficient, and to the [On-demand server provisioning](../EXCHANGE_REFERENCE.md#on-demand-server-provisioning) overview of the endpoint's fields.
It does not cover the recovery of a session the server drops mid-exchange (see [SFTP_SESSION_RECOVERY.md](SFTP_SESSION_RECOVERY.md)) or the memory and liveness bounds on the transport operations (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md)).
Intended readers are security auditors and implementors.

Every net-new control specified here is subject to the explicit pre-release security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy); the per-section notes below repeat this only where a control has an extra scope nuance (an internet-facing surface, a new security-relevant dependency, or a modification layered on an existing control).

## Server-provisioning endpoint call

`connection.server.provision` names an HTTP endpoint that, in `start` mode, wakes a primary server kept down between exchanges and, in `create` mode, makes a new server and answers with its address; see the [On-demand server provisioning](../EXCHANGE_REFERENCE.md#on-demand-server-provisioning) overview for the field table and which command calls it.
This section specifies the wire contract `callProvisionEndpoint` (start) and `requestProvisionedServerAddress` (create) implement (`packages/core/src/config/serverProvision.ts`).

**The request.**
One `POST` with an empty body to `https://host:port/path` (`DEFAULT_PROVISION_PORT` = 443 when `port` is unset), sending `Accept: application/json` and, when `auth` is set, an `Authorization` header -- `Bearer <token>` for a `bearer` credential, `Basic <base64(username:password)>` for a `username`/`password` pair.
The request sets `redirect: "manual"`, so a 3xx answer (or the `fetch` implementation's own `opaqueredirect` result type) is not followed and the credential in `Authorization` never reaches a second host.
A start-mode response body is never read: once the status is in hand it is cancelled unread, since it is network content the operator cannot inspect.
A create-mode body is read only after a `2xx` status, as the next paragraph but one specifies; a non-2xx body is cancelled unread in both modes.
Before any request, `host` is refused when it holds a character outside a host name (letters, digits, hyphens, dots) or an IPv6 address (hex digits, colons, dots, optional brackets) -- the URL parser drops a tab, CR or LF anywhere in its input, so `a.com<LF>evil.com` would otherwise reach `a.comevil.com` -- and when the parsed URL's host differs from it as written (lowercased, an IPv6 address bracketed), as a numeric form such as `0x7f.1` does.
The refusal names the field, not the value.

**Timeout.**
`PROVISION_REQUEST_TIMEOUT_MS` = 120,000 (120 s) bounds the call via `AbortSignal.timeout`, independent of every other connection or liveness bound.
It is an arbitrary working value: long enough for a serverless instance's cold start, short enough that an unattended run does not hang.
In create mode it bounds the body read too: the read is raced against the same signal and its reader cancelled when the signal fires, so a body the timeout cuts off part-way is the same transport failure whether or not the fetch errors its own stream on the abort.

**Create-mode answer.**
The body of a `2xx` answer is read through `readBoundedJsonBody` (`packages/core/src/utils/boundedJsonBody.ts`), streamed under `MAX_PROVISION_RESPONSE_BYTES` = 32,768 bytes with `Content-Length` never trusted, and parsed through `parseBoundedJson`.
The cap is derived from the schema below: its widest document, every host, path, and fingerprint code unit a six-byte `\uXXXX` escape, is (256 + 4096 + 50) x 6 + 60 = 26,472 bytes, and 32 KiB is the next power of two, leaving room for whitespace between tokens.
The parsed value must be an object with exactly these keys, any other key refused:

| Key | Type | Required | Bound |
|-----|------|----------|-------|
| `host` | string | yes | 1 to `MAX_ENDPOINT_HOST_LENGTH` (256) UTF-16 code units; a host name (letters, digits, `-`, `.`) or an IP address, the check `server.provision.host` itself gets |
| `port` | integer | no | 1-65535 |
| `path` | string | no | 1 to `MAX_ENDPOINT_PATH_LENGTH` (4096) UTF-16 code units |
| `host_key_fingerprint` | string | no | One fingerprint matching `HOST_KEY_FINGERPRINT_REGEX`: `SHA256:` followed by 43 unpadded standard base64 characters, the canonical form `server.host_key_fingerprint` takes |

The `host`, `port`, and `path` bounds are the invitation endpoint's own, so an accepted address always fits the invitation.
The address then replaces `server.host`, or fills it where a create-mode configuration left it out, and `port` and `path` when present, and the result must still pass the connection schema (an sftp `path` beside an `inbound_path` does not).
A returned `host_key_fingerprint` replaces whatever `server.host_key_fingerprint` the sftp connection states, a list included, so every later connection to the created server requires that key; an answer without one leaves the configured pin, or its absence, unchanged.
A returned `host_key_fingerprint` for a webrtc connection is refused with exit 64 (`UsageError`), since that connection has no SSH host key to pin.
The fingerprint is not sent in the invitation, so the accepting party still confirms the created server's key on first use.
A refusal of the body names the endpoint by host and port and names the schema field at fault, never a key or value the body chose.
A refusal by the connection schema, once the body has passed the schema above, also names the returned `host` -- the one lead to a server the endpoint made and no configuration records -- composed raw into the error and escaped where it is displayed, and never the returned `path`.

**Status-to-exit-code classification.**
Only the response status is read, except for the create-mode body above:

| Answer | Exit | Reasoning |
|--------|------|-----------|
| No answer -- a network, DNS, or TLS failure, or the timeout above -- or `408`, `429`, or `5xx` | 69 (`ConnectionError`, kind `transport`) | A retry can succeed |
| `401` or `403` | 64 (`UsageError`) | The endpoint refused the credential in `auth` |
| A redirect (3xx, or `opaqueredirect`), or any other non-2xx status | 64 (`UsageError`) | Fix `host`, `port`, or `path` |
| `2xx` | none | The server now accepts connections (start), or its body is read (create) |
| Create mode, a `2xx` body over the cap, not JSON, or failing the schema above | 64 (`UsageError`) | Fix the endpoint or `provision`; the same answer fails again |

Every failure message names the endpoint by host and port alone (`provisionEndpointLabel`) -- never the path, which may hold a token, and never the credential -- apart from the created server's host in the connection-schema refusal above.

**When the call runs.**
`alcove exchange` sends a start-mode call once (`wakeProvisionedServer`), after every refusal decided from local inputs alone and before the first-use host-key probe.
Ahead of it run the `--event-stream` fd-3 preflight, the configuration and key-file load, the dataset preparation and its linkage-terms checks, the signing-identity load, the non-interactive refusal of an unpinned SFTP host (`assertHostKeyTrustCanBeEstablished`), and `runProtocol`'s own local checks through `preflightRun`: the shared secret's format and expiry, the key-file path, the first round's size against one message on the channel, and the WebRTC rendezvous resolution.
After it run the checks that need the network -- the first-use host-key probe and the operator's confirmation, then the protocol run, whose connect verifies a pinned host key and whose key exchange and terms agreement involve the partner.
`runProtocol` repeats its local checks before it connects, so an input that changes after the call, such as a shared secret expiring in the interval, is refused after it.
A create-mode block sends nothing at exchange time: the run connects to the static fields the invite wrote.
A create-mode `server` stating no `host` has had no invite write one, and the connection schema refuses it wherever a configuration is read to connect (`UNALLOCATED_SERVER_HOST_MESSAGE`, `packages/core/src/config/connection.ts`), so `alcove exchange` and `alcove accept` stop at the configuration load; only the invite's own read of the connection block (`safeParseConnectionConfigAwaitingAddress`) admits it.

An online `alcove invite` or `alcove accept`, and a zero-setup run, send the same start-mode call (`wakeServerThrough`) from the block `--server-provision` states, its auth `@path` references read at argument parsing, before an invitation is printed or any file written.
The online paths run `preflightRun` and `assertHostKeyTrustCanBeEstablished` inside `runOnlineBootstrap` ahead of it; the zero-setup run has no shared secret or key file, so its local checks are the dataset preparation, the first round's size, and the host-key refusal.

An offline `alcove invite` from a configuration sends a create-mode call once (`createProvisionedServer`), after the configuration, key-file conflict, input, and linkage-terms checks and before the invitation is minted, so a failed call leaves no invitation printed and no key file written.
The returned address is written into the configuration with the key file, before the invitation is printed.

**Two calls per exchange (start mode).**
Each party's run sends its own call independently, in either order and possibly at the same time, so the endpoint must answer `2xx` to a wake call that lands while another already has the server coming up, and to one that lands after the server is already live.

## SFTP fatal-packet crash safety

The size and liveness bounds in [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md) turn a hostile server's behavior into a bounded failure, but they leave one behavior unbounded: a process crash, which is neither a memory nor a time exhaustion.
The SFTP adapter drives the raw ssh2 `SFTPWrapper` directly (for `list()`, `createExclusive()`, and the streamed `get()`), and after the session connects that wrapper has no `'error'` listener of its own - ssh2's `Client.sftp()` attaches a setup-time listener but strips it before handing the wrapper back, and `ssh2-sftp-client` attaches `'error'` handlers only to the SSH `Client` object and to per-operation read/write streams, never to the wrapper.
So a server that returns a malformed SFTP reply packet, or faults the framing layer itself with an over-long packet, reaches ssh2's fatal-error path, which emits `'error'` on a listener-free `EventEmitter`.
Node escalates that to an uncaught exception, crashing the CLI outright, before the lock-file and temp-file cleanup and the typed exit-code mapping that an orderly failure runs.
The malformed reply packets are a malformed NAME, HANDLE, DATA, ATTRS, or EXTENDED_REPLY packet, an unknown packet type, and a duplicate VERSION packet after the session is already ready; a malformed *first* VERSION instead rejects `connect()`, whose setup-time listener is still attached then, so it never reaches this listener-free state.
An over-long or zero-length packet trips the length-prefix check before any request id is consumed.
The adapter closes this by attaching a single guarded `'error'` listener to the wrapper at connect time (once per wrapper instance, so a reconnect's fresh wrapper is re-guarded and a repeated connect does not duplicate the listener), so a fatal protocol error is handled rather than fatal.

A handled fatal error leaves the session dead but the process alive.
ssh2's `doFatalSFTPError` emits the `'error'`, destroys the wrapper, then calls `cleanupRequests`, which fails the callback of every request still registered.
What bounds an *in-flight* `list()` or `get()` depends on which request received the fatal packet, and the realistic case is not `cleanupRequests`: when the malformed packet is the reply to the in-flight request itself, ssh2 has already deleted that request from its pending table by the time `doFatalSFTPError` runs.
The `NAME` and `DATA` handlers delete it up front (on a defined request id), *before* the parse/check that triggers `doFatalSFTPError`; the `HANDLE` handler deletes it inside its own malformed branch (on a defined request id), immediately before triggering it.
The placement differs but the net effect is the same: `cleanupRequests` finds nothing left to fail for that request and the in-flight callback never fires - the operation is bounded by the adapter's 60-second wall-clock deadline (`list()`'s deadline or `get()`'s idle window), not by `cleanupRequests`.
`cleanupRequests` does fail an in-flight callback promptly only in the other cases: a fatal error that arrives on a *different* request id, or a connection-level fault (such as an over-long packet, which faults the framing/length-prefix layer before any request id is consumed), leaves the in-flight request registered for it to fail.
Either way the in-flight operation is bounded - the 60-second deadline is the bound that covers the realistic in-flight case, so it is required and must not be removed on the assumption that `cleanupRequests` covers in-flight operations.
The listener also captures the cause, which bounds the *next* operation: every server-driven method consults this captured error at entry and short-circuits before issuing a request the dead channel can never answer.
`list`, `get`, `createExclusive`, `put`, `delete`, `rename`, and `exists` reject promptly with the same terminal `TransportOperationStalledError`; `safeDelete`, whose contract forbids rejecting (callers run it in `catch` blocks), instead resolves promptly as a best-effort no-op.
This entry guard matters beyond saving a deadline wait.
After a fatal error ssh2 destroys the SFTP channel but the underlying TCP/SSH socket stays up, because a hostile server keeps it alive.
So an unguarded write, stat, or delete would buffer its request on the closing channel and hang until its own per-operation bound fires (60 s) rather than failing at once - a teardown that stalls for the full bound, since `FileSyncConnection.close()` drives `safeDelete`/`delete` during cleanup.
The guard converts that stall into a prompt, orderly failure.

This bounds the malformed/fatal-packet crash and, once a fatal error is known, every server-driven operation: the entry guard short-circuits the next read or write rather than buffering a request the dead channel can never answer.
The one behavior the guard cannot catch is a hostile server that withholds a write, stat, or delete callback *without* any protocol error, so no fatal `'error'` fires and `put`/`delete`/`rename`/`exists` never short-circuit at entry.
It is not left unbounded: each of those operations has its own per-operation bound (the 60-second deadline for `rename`/`delete`/`exists`, the 60-second progress idle window for `put`) that fails the withheld callback terminally, with the whole-exchange budget beneath it as a fallback.
The best-effort `safeDelete` has the same 60-second deadline so a teardown delete cannot be the soft target left on the coarse budget while every other write op fast-fails, but - because its contract forbids rejecting - it swallows the deadline's stall error and resolves rather than reporting it, bounding the wait without breaking the never-reject guarantee its `catch`-block callers rely on.
The entry guard's role is to spare the 60-second wait once a fatal error is already known, not to be the sole thing standing between the call and an indefinite hang.

The bounds above reach past the public `ssh2-sftp-client` API and drive ssh2 internals directly, so they rest on assumptions about ssh2's internal behavior that an upgrade can silently break.
Before raising either `ssh2` or `ssh2-sftp-client`, follow the upgrade checklist in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client), which names the internal assumptions, the source files to re-read, and the contract-assertion test that fails red on a lifecycle change.

## SFTP host-key verification

The controls in [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md), [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md), and the crash-safety control above, defend against a hostile administrator of the server a party has correctly reached; a distinct control defends against reaching the wrong server.
On the SFTP channel an operator may pin the server's host key by setting `connection.server.host_key_fingerprint` to its OpenSSH SHA256 fingerprint -- or to a non-empty list of them (see *Multiple pinned fingerprints* below) -- and every connection then verifies the presented host key against the pinned fingerprint(s) before authentication, aborting unless it matches one.
This is the SFTP analogue of the certificate pinning the signing identity uses (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#receipt-signing-identities)): trust comes from a fingerprint rather than a certificate authority.
And it replaces SSH's *silent* trust-on-first-use with an explicit, enforced pin -- supplied out-of-band, or established by a confirmed first-use prompt (below) and then verified on every subsequent run -- so a man-in-the-middle or a substituted server presenting its own host key is detected rather than silently trusted.

The fingerprint is `SHA256:` followed by the unpadded *standard* base64 (alphabet `[A-Za-z0-9+/]`, not base64url) of the SHA-256 digest of the raw SSH host-key wire blob -- byte-identical to what `ssh-keygen -lf` and OpenSSH clients display, so an operator pins exactly the value those tools print.
It is validated at config-parse time by `HOST_KEY_FINGERPRINT_REGEX` (`/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/`): the final character's class is restricted because the last 6-bit base64 symbol of a 32-byte (256-bit) value has two low bits that are zero in the canonical encoding, so only those sixteen symbols are valid there.
A bare 43-character base64url value -- the shape of a signing `partner_fingerprint` -- is detected separately and rejected with a message naming that confusion, since the two fingerprints use different alphabets and one is easily pasted for the other.

Verification runs in ssh2's `hostVerifier` callback, which the SSH handshake invokes with the raw host-key blob before authentication.
Alcove always installs a callback (in one of three forms below) and installs it *after* applying `provider_options`, so a provider option can neither override nor disable it; the `provider_options` allowlist is in any case default-deny and drops `host_verifier`/`hostVerifier` and `host_hash`/`hostHash`.
`hostHash` is never set: setting it would make ssh2 pre-hash the key before the callback, destroying the raw bytes the fingerprint is computed over.
The three forms: with a pin set, an *enforcing* verifier computes `SHA256:` + base64(SHA-256(blob)) once and compares it against each pinned fingerprint with a constant-time byte comparison over the decoded digests, accepting on the first match.
Nothing secret is compared -- a host key and its fingerprint are both public -- so the constant-time comparison is house-style hygiene for digest comparisons, not a timing-oracle defense, and the short-circuit on the first match is likewise not a timing concern.
With no pin, a *fail-closed* verifier computes the presented fingerprint into the error and refuses (see the no-pin default below).
And on the deliberate first-use probe, a *capture* verifier records the presented fingerprint and refuses, so the probe learns the key without authenticating (see first-use trust below).

**Multiple pinned fingerprints.**
`host_key_fingerprint` accepts either a single fingerprint or a non-empty list, validated entry by entry at config parse (each against `HOST_KEY_FINGERPRINT_REGEX`, with the signing-`partner_fingerprint` confusion detected per entry; an empty list is rejected, since it would pin no key while reading as "pinned").
The enforcing verifier accepts a presented key matching *any* listed fingerprint, which gives zero-downtime host-key rotation: an operator stages the incoming key alongside the current one for the rekey window so either is accepted with no failed exchange in between, then drops the old entry after the cutover.
The single-fingerprint form is the one-element case and behaves identically.
The verifier records the *matched* pin as the observed host key (`FileSyncConnection.observedHostKey`) -- the one fingerprint the server actually presented, not the whole set -- so the cross-party reconciliation below still compares one observed key per party even when each party pins several.
The set membership lives in one tested primitive (`matchHostKeyFingerprint`, `packages/core/src/utils/sshHostKey.ts`), so there is a single decode-and-compare implementation.
On a mismatch the error's own message names the presented fingerprint and how many pins were compared against; the set itself rides a labelled cause link of its own, so a many-pin config spends its own link's budget rather than the re-pin instruction's (see [Message display budgets](DISPLAY_REDACTION.md#message-display-budgets)).

The control is fail-closed on every path.
A mismatch, a malformed or empty blob, or any error inside the callback results in `verify(false)`, which ssh2 raises as a fatal handshake error whose message contains `Host denied (verification failed)` -- before authentication, so no credential is presented to an unverified server.
The CLI adapter treats that rejection as terminal and does not retry it: retrying would only re-run the key exchange against the same untrusted host.
The `Host denied` message fragment is an ssh2 internal assumption recorded in the [SFTP-stack upgrade checklist](DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client); even if a future version renamed it, core re-wraps the same rejection into an `SFTP host-key verification failed:` message and the outcome is unchanged, only slower.
The mismatch message names the presented fingerprint and key type so an operator can distinguish a legitimate key rotation from an attack.
The key type is the server's choice within the bound below, so it rides a labelled cause link of its own (see [Message display budgets](DISPLAY_REDACTION.md#message-display-budgets)) and is escaped at the display boundary before it reaches the operator's terminal or log.
A changed key is never auto-accepted -- there is no standing always-accept flag (which would be permanent trust-on-first-use disguised as protection).
The recovery for a legitimate rotation is a deliberate re-pin, modeled on ssh's `known_hosts` flow: verify the new fingerprint out-of-band, then add it to `connection.server.host_key_fingerprint` (alongside the current pin for a staged rotation, or in place of it) or remove that field and re-run interactively to re-establish trust on first use (which overwrites the stored pin).

**The presented key type is bounded before it is shown.**
Every surface that names the server's key type -- both refusals above, the first-use trust prompt, and `probe-host-key`'s human and `--json` output -- takes it from `keyTypeFromBlob`, which reads the blob's leading length-prefixed string and returns it verbatim only when it is **at most 64 bytes** and every byte is in **`[A-Za-z0-9._@-]`**.
That charset is the SSH algorithm-name charset plus the `.`
and `@` a certificate type uses.
Every type in real-world use conforms with room to spare -- the longest names are the certificate forms, around 40 bytes (`ecdsa-sha2-nistp521-cert-v01@openssh.com`) -- and the length matches the bound a partner's advertised key type is parsed under (see *Cross-party fingerprint reconciliation* below), so an accepted type is always one this party can advertise.
A type outside either bound is *replaced* by `(unknown:<hex>)` -- the lowercase hex of its first 24 bytes, at most 58 characters; a blob naming no type at all (a bad, zero, or past-the-end length prefix) is `(unknown)`.

Three properties of that replacement are critical.
It encodes the offending bytes rather than discarding them, so two rejected types that differ within those first 24 bytes do not collapse into one value that the reconciliation below would read as *the same* key type on both sides.
Its parentheses fall outside the accepted charset, so a server cannot name its key type a string that passes for this first-party framing.
And it fits the partner's 64-character bound, so advertising it does not read as a malformed advertisement and drop the reconciliation.
Replacing rather than refusing the connection is deliberate: of the sites that read the type, all but one already refuse, and the exception is the pin-matched success path -- where trust rests on the fingerprint the operator verified out-of-band, not on the type.
So refusing there would cost availability on the one path that works while the bound already contains the bytes.
The bound sits under the display-boundary escaping rather than replacing it: the type is still escaped where it is rendered.

The replacement has three limits.
Past the 24 bytes it encodes, the distinction above stops: two rejected types sharing a 24-byte prefix and differing only after it collapse to one placeholder, which the reconciliation below treats as *the same* key type on both sides.
So a divergence between the two parties is described with the narrower rekey-or-interception wording instead of the wording that also offers the benign multiple-host-key explanation.
The warning still fires either way -- it is triggered by fingerprint inequality alone, never by the key type -- and an adversary who wants the two observed types to compare equal needs no prefix collision at all, since naming the presented key `ssh-ed25519` does it.
The collapse is therefore a limit to state rather than a defect to close.
The other two limits are unchanged by this bound.
The console never sees the replacement: `probe-host-key --json` emits the placeholder, but the console re-validates that field against the same length and charset at its own trust boundary (see *`probe-host-key` and console probe-to-fill* below), and the placeholder's framing is itself outside that charset.
So a non-conforming type is reported there as a generic probe error rather than as the replacement text -- exactly as it did before the bound, since such types failed that boundary already.
And the composition-site redaction still passes a charset-conforming lookalike: a type such as `-----BEGIN-OPENSSH-PRIVATE-KEY-----` is inside the accepted charset, so it is returned verbatim and rendered on a refusal, and on the log and prompt lines that name a key type.
What that costs is operator confusion, not disclosure -- the bytes are the server's own choice, capped at 64 characters, on a cause link of their own, and no operator secret can reach this field.

Each pinned fingerprint may be supplied as an `@`-file reference (`@/path/to/fingerprint`) for operators who keep it in a read-only secrets mount; in a list, entries may freely mix literals and `@`-file references.
Because `@`-file resolution runs after parsing, a literal `@path` -- which cannot match the `SHA256:` format -- is exempt from the parse-time format check, and each resolved file's contents are re-validated against `HOST_KEY_FINGERPRINT_REGEX` at resolution: a malformed or empty secrets file fails as a `UsageError` (exit 64) naming the offending reference, rather than as a confusing host-key mismatch at connect time.

Verification applies to the CLI `sftp` channel only.
A file-drop makes no SSH connection, so it runs no ssh2 `hostVerifier`.
An attacker cannot induce the unpinned state to inject their own key, because the pin is configured out-of-band (or established on first use, below) and the invitation endpoint schema rejects a `host_key_fingerprint` field outright (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication)).

**No-pin default: fail-closed.**
When no fingerprint is pinned, `FileSyncConnection.open` installs the fail-closed verifier, which refuses the connection before authentication (so no credential reaches an unverified server) with an error naming the presented fingerprint to pin.
An unpinned connection is never warn-and-proceed: a key nothing has verified is never trusted, and the recovery from the refusal is the first-use flow below, which is what makes a pin obtainable for an operator who has none.

**First-use trust (ssh-style).**
An operator who cannot obtain the fingerprint out-of-band can still reach the verified-on-every-subsequent-run state by establishing the pin on a deliberate first connection.
Every CLI command that opens an `sftp` connection -- `exchange`, the online `invite`/`accept`, and a zero-setup exchange -- runs this flow before the real, enforcing connection (a shared `establishHostKeyTrust` step):

- On a TTY (interactive), it *probes* the server: a throwaway connection whose capture verifier records the presented host key and immediately refuses, so the key is learned without presenting a credential and without waiting on a user prompt inside the handshake (which would race ssh2's `readyTimeout`).
  The probe dials once whatever `max_reconnect_attempts` holds, so `serverConnectTimeoutMs` bounds the wait before the prompt; a probe that reads no key ends the run with a refusal stating that it was not re-dialed and naming the connect-timeout setting, its rejection kept as the cause and its exit status unchanged.
  It then shows the fingerprint and key type, prompts for confirmation, and on a yes pins the fingerprint into `connection.server.host_key_fingerprint` in memory and proceeds with a real, now-enforcing connection.
  Because that real connection re-verifies the just-pinned key, a key swapped between the probe and the connect is still caught (the same brief TOCTOU window as `ssh-keyscan`-then-`ssh`).
- Non-interactively (no TTY -- an automated run, or one piping its CSV through stdin), it does not prompt and does not auto-accept: it fails closed with an actionable error naming the recovery (run once interactively to pin, or set `host_key_fingerprint` out-of-band).
  That recovery reaches the operator because the refusal is partitioned by chooser -- the configured host and the config path each ride a labelled cause link of their own, so neither can spend the recovery's display budget (see [Message display budgets](DISPLAY_REDACTION.md#message-display-budgets)).
  This is the same fail-closed posture as the no-pin default, reported earlier and with CLI-specific guidance.

How the confirmed pin reaches disk depends on the command: `exchange` reads an existing `alcove.yaml` and does not re-write it, so the pin is written there in place (preserving comments).
The online `invite`/`accept` and a zero-setup run with `--save` include the in-memory pin in the configuration they write after the handshake; an online `invite`/`accept` that reuses an existing configuration, which the post-handshake step does not re-write, writes the pin there in place when it is confirmed.
A zero-setup run without `--save` trusts the key for that one exchange and persists nothing.
The probe reuses the exact connect options (algorithms included) the real connection uses, so both negotiate the same host-key type and the pinned key is the one later runs verify.

**`probe-host-key` and console probe-to-fill.**
The same capture verifier is exposed as a standalone CLI command, `alcove probe-host-key <sftp-url> [--json] [--connect-timeout <dur>]`: it builds a minimal `{channel: "sftp", server: {host, port?, username}}` connection from the URL -- no credential, and no operator- or URL-supplied username.
ssh2 requires a username string to `connect()`, so a fixed placeholder is set, and because the capture verifier calls `verify(false)` at host-key verification (before the SSH userauth phase), that placeholder is never sent to the server.
It runs `probeHostKeyFingerprint`, validates the result against `HOST_KEY_FINGERPRINT_REGEX`, and prints it.
`--json` emits exactly one stdout line `{"fingerprint":"SHA256:...","key_type":"..."}` (snake_case, the machine form); the human form escapes the server-controlled key type through `sanitizeForDisplay` as `sftpSession.ts` does.
On the exit-69 path `--json` emits instead a one-line diagnosis of a peer that never identified itself, discriminated on a `diagnosis` key the success line does not have (see [CLI.md](../CLI.md#when-something-other-than-an-ssh-server-answers-the-port)); its `excerpt` field is bytes the peer chose, encoded as a JSON string value and re-validated, capped, and escaped at the console's own trust boundary exactly as `key_type` is.
Exit codes mirror `exchange`: a transport failure (unreachable, refused, timeout) is `69`, a usage error (a non-sftp scheme, a malformed URL) is `64`.
The command establishes no trust and pins nothing: it only reads a key over the same untrusted network the exchange will use.

**The machine lines are emitted as printable ASCII.**
`--json` exists so a script reads it, and what a script does with a line it cannot classify is print it -- to a terminal, or into a log a human later reads.
Bare `JSON.stringify` does not make a line printable: it escapes `U+0000`-`U+001F`, the quote and the backslash, which keeps a line one line, but passes DEL, the whole C1 range, and `U+2028`/`U+2029` through unescaped, and the peer's excerpt is a latin1 decode of adversary-chosen bytes, so each of those is reachable.
Both lines therefore go through one encoder (`asciiSafeJsonLine`, `apps/cli/src/util/jsonLine.ts`), which rewrites every UTF-16 code unit outside `U+0020`-`U+007E` in the encoded text to the `\uHHHH` escape JSON already defines for it.
Matching by code unit rather than code point is what makes an astral character escape as the surrogate pair `JSON.parse` recombines rather than as a code point JSON has no escape for.
That encoder handles every machine-readable line Alcove prints -- each line of the opt-in fd-3 NDJSON event stream too, through its `asciiSafeJsonText` half, since two of that stream's fields hold text no escape has touched ([CLI_EVENTS.md](CLI_EVENTS.md#sanitization)) -- the `doctor --json` verdict included, whose checks interpolate the operator's own `SMB_*` values, validated against the C0 controls and DEL alone.
So the same bytes are reachable there, alongside an `smbclient` NT_STATUS token that is ASCII by construction (see [CLI_DOCTOR.md](CLI_DOCTOR.md#the-line-is-printable-ascii)).

Three properties follow, and they are what the encoder is for.
The keys and value types are unchanged, so the machine contract is the one specified above.
The document the text parses to is exactly the document `JSON.stringify` alone would have produced, so **this is not a second escaping altitude**.
A consumer that renders a parsed field to a human -- the console, at `parseProbeDiagnosis` -- receives the peer's bytes as it always did and escapes them once, at its own display sink (see [Display sanitization escape format](DISPLAY_ESCAPE.md#display-sanitization-escape-format) and CONTRIBUTING.md, Operator-facing escaping).
And it is an encoding rather than a redaction, so material that must not be shown at all is still stripped where the excerpt is produced: `classifyPeerAnswer` takes `redactPrivateKeyMaterial` over the whole retained read and clips the excerpt out of what that leaves, so both routes hold the same already-stripped bytes, and neither route strips again where it interpolates.
The human route's per-link render pass remains behind it as a no-op safety check.
The order is the one the strip is written for, and the same one the `doctor` detail excerpt takes (see [CLI_DOCTOR.md](CLI_DOCTOR.md#what-the-verdict-withholds)): a clip taken first can cut a `BEGIN ...
PRIVATE KEY` marker in half, leaving a fragment neither the block rule nor the fail-closed dangling rule matches, and a consumer redacting the clipped excerpt then strips nothing.
The pair is driven end to end -- a listener writing DEL, a C1 control and a `BEGIN ...
PRIVATE KEY` marker on a real socket, asserted on the emitted line's bytes, in `apps/cli/test/integration/backendAgnostic/hostKeyProbePeerIdentification.test.ts` -- and the console boundary's single pass is held by driving a spawned child with the same answer in both encodings in `apps/web/test/unit/jobs/jobSftpProbe.unit.test.ts`.

**Diagnosing a peer that never identifies itself.**
An SSH server sends its identification string before anything else, so a dial that never reaches host-key verification saw something that is not one.
The pinned stack reports a proxy answering with an HTML page, a TLS service, and a firewall closing the connection in front of the server all as the same `Connection lost before handshake`, with the peer's own bytes discarded (recorded as a measured assumption in the [SFTP-stack upgrade checklist](DEPENDENCY_PINS.md)).
Every dial therefore reaches one diagnosis step (`apps/cli/src/connection/sftpPeerIdentification.ts`), which on that rejection, or on an `ECONNRESET` anywhere in the cause chain, opens **one** further connect attempt -- a single `net.connect` call to the same endpoint, which for a dual-stack hostname may race address families within that one call, exactly as the dial it follows does -- and reports what the peer sends.
It runs at exactly one layer, the transport adapter's dial sequence -- the one path to `ssh2`'s connect, so the connect loop, the connection-per-poll cycle-start re-dial, the mid-exchange recovery re-dial, the teardown's, and the credential-free host-key probe (which dials the same adapter as its raw client) all pass through it.
Both probe entry points therefore add no diagnosis of their own.
One classifier over one read: a caller that wrapped its own would diagnose a rejection already diagnosed -- the gate walks the cause chain, so the rejection kept under the probe's host-key message still matches -- and read the peer a second time.
Six constraints hold it:

- It is **credential-free by construction**: the socket only reads.
  Nothing is written on it -- no credential, no identification string, no SSH traffic -- which is the same assumption the probe itself rests on, held here by a socket that has no write path rather than by a verifier that refuses in time.
- It is **time-bounded** by one deadline over connect and read together, at most 2 s and clamped to the dial's own `serverConnectTimeoutMs`, so it cannot outlast the budget the operator already granted the connect.
  It runs once, after the dial's retries are spent, not per attempt.
- It is **spent once per connection**, and one diagnosed failure opens exactly one further connection whatever the entry point -- driven, and counted at the endpoint, in `apps/cli/test/integration/dialPeerIdentification.test.ts`.
  The connection-per-poll mode dials at every cycle start, so an unbounded diagnosis would re-dial a peer that is already answering wrongly once per tick for as long as the condition stands; the first dial failure that reaches the read spends the connection's whole budget for it, and every later one keeps the rejection the stack raised.
  A dial issued once the connection's teardown has begun is not diagnosed at all: an abandoning teardown destroys the transport beneath a dial in flight and that dial rejects with the very wording the gate rests on, so diagnosing it would read a peer about a close of Alcove's own making.
- It is **byte-bounded**: at most 512 bytes are retained -- each delivery truncated to that bound before it is held -- and at most 128 of them are included into the diagnostic, so a peer answering with megabytes neither holds memory here nor spends the operator's output.
  The bound is on what is retained, not on what transits: the socket is never paused, so a single delivery of up to the stream's high-water mark (64 KiB, measured) reaches the read callback before the stop rule fires, and 512 bytes of it survive that callback.
- Its **verdict comes from the read**, never from the rejection's text, which decides only whether to look.
  A peer that turns out to be an SSH server, and a connection that cannot be made at all, are reported as nothing: the operator keeps the rejection they already had.
  So a stack that reworded its rejection degrades to the undiagnosed failure, never to a wrong diagnosis.
- It **changes no dial's classification**.
  A rejection the adapter already treats as terminal -- a host-key refusal, a key exchange this process cannot perform -- is left with the message that classification reads, checked before the diagnosis rather than assumed disjoint from it.
  A peer-identification failure is itself no verdict: it stays the transient dial failure it was, retried on the connect loop and skipped-and-retried on the cycle-start path, because it is derived from bytes the peer chose and no party that answers the port may end an unattended exchange by answering it wrongly.

What the operator is told partitions by chooser, as the refusals above do: the diagnosis sentence and its recovery step are first-party links, the configured endpoint is a link of its own (unbounded in the config schema and, on the acceptor route, copied from the partner's invitation).
**The peer's excerpt is a link of its own** -- adversary-chosen bytes, which the display boundary escapes and caps within that link alone (see [Message display budgets](DISPLAY_REDACTION.md#message-display-budgets)).
The stack's own rejection stays the last link, so the wording that distinguishes a clean close from a reset survives.
Two shapes are named in the copy, an HTTP status line and a TLS alert record; anything else is described as non-SSH data and shown.
The copy **claims only what the read establishes**: it states what the peer's first bytes held and names the middlebox cause as a likelihood, rather than asserting that the peer is not an SSH server.
RFC 4253 lets an SSH server send lines ahead of its identification string, so a real one whose preamble runs past the retained bound -- or whose identification string arrives after the deadline -- is classified non-SSH here; the recovery step names that bound so an operator whose server has a long banner recognizes their own case.
Both sides of the bound are driven in `apps/cli/test/unit/connection/sftpPeerIdentification.test.ts`, and every dial path -- the connect loop, the cycle-start re-dial, and both probe entry points -- in `apps/cli/test/integration/dialPeerIdentification.test.ts`, against listeners that are not SSH servers with the real test server as the control.
A peer that accepts and then closes having sent **nothing** takes its own message naming the likely cause -- a firewall or IP allowlist ahead of the server -- and has no excerpt, there being none; a peer that accepts and merely stalls is not given that message, since a slow server is indistinguishable from it here.

The console repurposes it as *probe-to-fill*, the browser analogue of first-use for an SFTP connection authored in-app.
The console's Node server cannot probe SSH in-process -- core has no SSH implementation and the `ssh2` stack is exact-pinned to `apps/cli` only, which the web app must not import.
So it spawns this command (the image already spawns the CLI for every SFTP op) and re-validates every field at the trust boundary: the fingerprint against the same regex, the `key_type` against a length (<= 64) and charset bound (server-controlled bytes, encoded as a JSON string).
It discards the child's stderr entirely (it can hold server-controlled bytes) and drives a watchdog (SIGTERM at ~15 s, SIGKILL after a grace) so the endpoint's latency is bounded above the child's 10 s `readyTimeout`.
The reconciled outcome is a typed result -- `ok` / `unreachable` (exit 69) / `timeout` (watchdog kill) / `error` -- reported over `POST /api/jobs/sftp/probe` (the SSRF-bounded, single-flight, stateless endpoint specified in [SERVER_JOB_API.md](SERVER_JOB_API.md#probing-the-server-host-key)).
An `unreachable` result with a diagnosis reaches the operator as the console's own account of it, and that result partitions by chooser as the CLI's cause chain does -- by structure rather than by cause links.
The announcing channel is a single stable polite `role="status"` region, mounted in every phase and first in the probe result's DOM order, whose text is a fixed console sentence interpolating nothing.
The peer's excerpt renders outside it, as a sibling, in a read-only monospace field whose value the peer's bytes are and whose accessible name is a fixed first-party string the peer cannot write.
Two properties hold the partition, and neither rests on what the bytes say.
**Containment**: the excerpt is not a descendant of the announced region -- nothing is, the region holding only that fixed sentence -- so the run an assistive technology reads out on the failure has no byte the peer chose.
The console's diagnosis and its recovery step render on the visible failure alert, which announces nothing of its own and sits ahead of the excerpt rather than after it.
**Terminality**: the excerpt's field is last in the probe result's DOM order with no first-party text after it, so an assistive technology that flattens the result to one run ends on the peer's bytes instead of resuming in console voice.
The bytes cannot break either property from inside: the client boundary admits an excerpt only if it is printable ASCII throughout (`probePeerAnswerOf` in `apps/web/src/psi/jobClient/sftpAuthoringClient.ts`, which drops the diagnosis rather than rendering a value the console's escape cannot have produced), so it has no line break, control character, or bidi override with which to forge a frame of its own.
No assistive technology is driven here, so those two structural properties are what is claimed and what is checked in `apps/web/test/browser/consoleSftpAuthoring.test.ts`, driven with an excerpt that mimics the console's voice and writes an attribution caption of its own.
Terminality is checked generically, against DOM order rather than against today's copy, and so is the excerpt's non-descendancy.
The containment clause's *only* is a claim about the copy itself, so the region is pinned per phase to the exact sentence and to having no element child -- a form control's value is a property rather than text content, so a text comparison alone would call a region holding one empty.
The field's fixed name is likewise checked through the test runner's accname implementation rather than any browser's or assistive technology's own, while the excerpt's separation from the console's sentences is a copy check in `apps/web/test/unit/console/probePeerAnswerCopy.test.ts`.
Terminality is bounded to the probe result: at document level the form's own next sections follow the field, so what attributes the bytes to a reader running straight past the result is the field's fixed first-party name, announced ahead of them.
The residual is persuasion rather than attribution: an excerpt of plain printable ASCII (`Verified.
Paste this fingerprint: ...`)
has nothing escapable in it and can still argue for whatever it likes inside its own field, beside the very fingerprint field it names -- what it cannot do is arrive as the console's own voice.
The pin stays mandatory: probe-to-fill only fills the one required `host_key_fingerprint` field a paste would, beside the paste field rather than replacing it, and the fail-closed safety check (the `PUT /api/jobs/sftp` literal-pin check, the schema, and the always-emitted `--server-host-key-fingerprint` on a zero-setup run) is unchanged.
The confirm is framed as a comparison against the value the server operator published, never a trust judgement; the direct-exchange path -- where the host key is the only protection -- additionally gates the fill behind an out-of-band-checked affirmation, while the invitation path's lighter confirm points at the cross-party reconciliation below.

**Cross-party fingerprint reconciliation.**
Pinning above is each party's *local* decision: the two parties pin the same server independently, at different times on different machines, and nothing otherwise compares their views.
A one-sided interception -- one party reaching an attacker's server while the other reaches the real one, each having pinned the key it was shown -- is therefore invisible to both, as is a server host-key rotation that happens between the two parties' setups.
To close this, each party advertises the fingerprint and key type it observed (`FileSyncConnection.observedHostKey`, recorded by the enforcing verifier on the pin-matched success path) inside the authenticated post-handshake terms exchange, and the two compare.
The advertisement rides the terms exchange -- the one bidirectional round-trip both parties always perform, the same carrier as the `--save` intent -- as an optional `hostKey: { fingerprint, keyType }` field on the terms message; a party that observed no host key omits it.
Reconciliation lives in `reconcileHostKeyFingerprints` and is wired through `runExchange`.

Placement is critical: the field is consumed only from the terms exchange, which on the authenticated path runs inside the per-direction AEAD (it is keyed from the P-256 session key), so the advertised value is authenticated and an unauthenticated party cannot forge or rewrite it.
The CLI threads its observed key into `runExchange` only when that AEAD wrap is in force (`secure` set); a zero-setup (unauthenticated) exchange advertises nothing, because over an unauthenticated channel an active man-in-the-middle could simply rewrite the advertised value to match and suppress the divergence.
This is the post-authentication, in-band complement to the endpoint decision in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality): the invitation endpoint still has no server-identity material, and reconciliation adds its check strictly after the authenticated handshake instead.

The comparison is a verbatim string equality on the fingerprint (a host key and its fingerprint are both public, and the result drives only a warning, not a trust decision, so no constant-time compare).
It reports a divergence -- never an abort, in keeping with the honest-but-curious model -- as a warning naming *both* observed fingerprints, with wording that distinguishes the two cases the difference can represent: when the key *types* match, the difference is narrowed to a server rekey between the two setups or a one-sided interception.
When the key types differ, the message additionally reports the benign multiple-host-key case, because a server that presents more than one host key may legitimately show each party a different one, so a type difference alone is not evidence of an attack.
A party that observed no host key (a file-drop mount or the browser/proxy SFTP path) advertises nothing, and a one-sided absence reconciles to no divergence rather than a false positive.
The advertised field is fail-soft: a malformed or over-bound `hostKey` (reachable only from a non-conforming or future-versioned peer, since the field rides the AEAD) is read as absent rather than aborting the linkage, so this advisory check can never turn a valid exchange into a hard failure.
That drop is silent toward the protocol, but `exchangeTerms` still distinguishes a present-but-malformed advertisement (a `hostKey` on the wire that fails validation) from a genuine absence and reports it out as `partnerHostKeyMalformed`.
The CLI logs the malformed case at debug, so an operator can tell a non-conforming peer from one that simply observed no host key (a file-drop or proxy path), while the benign no-host-key path stays quiet and the level stays low enough that a version-skew does not warn on every exchange.
The dropped bytes are not logged -- they are unusable and partner-controlled, so echoing them would widen disclosure and risk log injection.
Both parties' key types are the server's choice, and each of the four values the warning names is redacted and fitted to the per-value display budget before it enters the warning, which is composed raw and escaped once at each sink that shows it (see [Display sanitization escape format](DISPLAY_ESCAPE.md#display-sanitization-escape-format)): the locally observed key type has passed the charset and length bound above, while the partner's advertised one is bounded in length alone.
As net-new security behavior layered on the host-key control, this reconciliation is in scope for the explicit security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy) before release.
