---
title: "Shared-Secret Rotation"
---

# Shared-secret rotation

This document specifies how the pre-shared secret that authenticates a recurring exchange is minted and replaced: the rotation at the terms exchange, the previous secret that heals a cut run, the rotation history that recognizes a stale copy, and `expires` enforcement.
It does not cover the P-256 authenticated key exchange whose outputs the rotation uses (see [PROTOCOL.md](PROTOCOL.md#p-256-authenticated-key-exchange)), the operator-facing rotation policy (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-exchange-authentication)), or how each application stores the secret (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#the-previous-secret-and-the-rotation-history) and [MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)).
Intended readers are security auditors, external implementors, and developers.

The secret is a 32-byte value encoded as unpadded base64url (43 characters). Two mechanisms mint one, differing only in how the 32 bytes are produced:

- **Invitation tokens** are generated directly from a CSPRNG (`crypto.getRandomValues`), giving 256 bits of entropy.
- **Rotation tokens** are derived with the application HKDF (`hkdfDerive`: HKDF-SHA-256, 32-byte zero salt) from the handshake's key-agreement output and a 32-byte random value from each party, each value sent under AES-KW with a key derived from the 32-byte session key ([P-256 authenticated key exchange](PROTOCOL.md#p-256-authenticated-key-exchange)). The session key mixes the pre-shared secret with the ephemeral P-256 Diffie-Hellman, so a rotated secret is a full 32-byte value that stays secret against any party that does not hold both inputs; against a party that holds the superseded secret, its confidentiality rests on the ephemeral exchange alone, the ~128-bit P-256 forward-secrecy level:

```
wrap_key_I  = HKDF(session_key, "alcove-shared-secret-wrap-v2", 32)
wrap_key_R  = HKDF(session_key, "alcove-shared-secret-wrap-responder-v2", 32)
wrapped_N_I = AES-KW(wrap_key_I, N_I)
wrapped_N_R = AES-KW(wrap_key_R, N_R)
next_secret = HKDF(ka || N_I || N_R, "alcove-shared-secret-next-v2", 32)
```

**The two values.** The initiator draws `N_I` and the responder `N_R`, each 32 bytes, with `crypto.subtle.generateKey` as an extractable 256-bit HMAC key, the form `wrapKey` takes, and exports its raw bytes for the derivation. Neither value is stored. `N_I` is sent in key-exchange message 3 under the initiator's tag, once the initiator holds key confirmation ([Message flow](PROTOCOL.md#p-256-authenticated-key-exchange)). `N_R` is sent in terms message 2, once the responder holds key confirmation ([The rotation at the terms exchange](#the-rotation-at-the-terms-exchange)).

**The wraps.** AES-KW is the [RFC 3394](https://www.rfc-editor.org/rfc/rfc3394) key wrap with its default initial value, the algorithm certificate 5438's security policy lists as `AES-KW` under SP 800-38F ([CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-aes-kw-row-behind-the-rotations-wrap)); each wrapped value is 40 bytes. Each wrapping key is derived by `deriveKey` straight to a non-extractable AES-KW key, with the one usage `wrapKey` on the sender and `unwrapKey` on the receiver, wraps one value, and is discarded.

**The key-agreement output.** `ka` is the second 32-byte block of the key-agreement derivation ([P-256 authenticated key exchange](PROTOCOL.md#p-256-authenticated-key-exchange)), keying material derived from the shared secret and nothing derived from the pre-shared secret, so the next secret's input is 96 bytes. The shared secret itself never enters the rotation: SP 800-56A Rev. 3 section 5.8 lets it be used only by the scheme's key-derivation method, and the rotation takes that method's output ([COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53), SC-12).

**What `ka` adds.** Each handshake has its own `ka`, so an active adversary holding the current secret who relays both values between two handshakes leaves the two parties on different secrets, and must stay in the middle for every later run. No input depends on the current secret's value, so the next secret is independent of it. A recorder who later solves the Diffie-Hellman but never held a secret has `ka` and neither value. The design record: [rotation-hardening.md](../notes/rotation-hardening.md#the-construction).

Both parties recompute the next secret independently from the same `ka`, `N_I` and `N_R`, and each persists it as the secret for the next exchange. The rotation adds no message or round-trip. The three info strings are single fixed labels, not per-party or per-context families, and sit in the disjoint [domain-separation label space](PROTOCOL.md#p-256-authenticated-key-exchange), so a next secret or a wrapping key can never collide with a session, AEAD, abort-marker, peer-id, certificate, or signed-receipt derivation.

## The rotation at the terms exchange

The next secret is stored at the terms exchange every authenticated run makes after the handshake (`exchangeTerms` in `packages/core/src/protocolSetup.ts`), which awaits each side's store at its point in this order, for a run under a secret `X`:

1. The responder reads terms message 1 and settles the terms. On agreement it checks `X`'s `expires`, draws `N_R`, derives the next secret, holds it in memory, and sends terms message 2 with the field `responderValue`: `wrapped_N_R`, base64url, 54 characters.
2. The initiator opens terms message 2 at the AEAD layer, unwraps `N_R`, derives the next secret, and settles the terms. On agreement it checks `X`'s `expires`, stores the next secret, and only then sends terms message 3 `proceed`.
3. The responder, on reading `proceed`, stores the next secret, whatever its clock reads, since the initiator already holds it.

Every refusal, on either side, sends an abort before the first store, so a run refused at the terms exchange stores nothing on either side. `responderValue`'s rules, each a check `exchangeTerms` makes, since the terms message 2 schema drops an unknown key without error:

- **On a proceeding terms message 2 of an authenticated run it is required.** One missing, not 40 bytes of base64url, or failing its AES-KW integrity check ends the run on the initiator with an abort. A failed unwrap is a `security` failure, and a consistency check rather than a second defense: the AEAD layer already binds the frame to this run and direction under a key from the same session key.
- **An abort holds none.** The initiator stores nothing from an abort, whatever it holds.
- **An exchange that ran no key exchange has no session key.** Its initiator refuses a terms message 2 holding the field rather than reading past it.

Two abort reasons are fixed:

- A side whose store fails sends `"the partner could not save the next shared secret"`: the initiator as terms message 3, the responder as its first frame after it, which the initiator reads past the terms exchange as the partner's abort.
- A side whose `expires` has passed at its check sends `"the partner's shared secret expired before the next one was saved"`.

A run cut between the initiator's store and the responder's -- `proceed` lost, the responder's store failing, or the responder stopping -- leaves the initiator on the next secret and the responder on `X`. An initiator that kept `X` as its previous secret heals that at the next run, whichever side initiates it ([The previous secret](#the-previous-secret)); the command line and a saved browser exchange keep one, and the one-off browser exchange keeps no secret past the run.

An initiator that stored and then reads the responder's store-failure reason keeps it as its own constant (`isPartnerNextSecretStoreFailure` in `packages/core/src/failureClass.ts`), and each application reports that the partner could not save the new secret. Any other reason, or this one on a side that stored nothing, reads as any partner abort. Each adds the step for what it kept:

- **The CLI, outside an online `invite` or `accept` run,** adds that this side kept the secret the run used, so the next run, once the partner has fixed its save, can use it, with a fresh invitation as the step if that run fails authentication or never meets the partner.
- **The CLI, in an online `invite` or `accept` run,** whose responder keeps no key file after a failed save, reports that the two now hold different secrets and that a fresh invitation is needed.
- **A saved browser exchange** adds that this side kept the secret the partner still holds, so the next run can still reach the partner, with a fresh invitation as the step if runs keep missing the partner or stopping.
- **The one-off browser exchange,** which keeps no secret past a failed run, says that nothing changed on this side and that a fresh invitation is needed.

**The caller's step after the terms exchange.** `runExchange` awaits the caller's `onTermsExchanged` once on a side whose terms exchange completed, after that side's store and the checks that follow the terms exchange up to the payload disclosure (the invitation's `deduplicate`, the payload-fill confirmation, the receipt bindings and partner certificate, and the cardinality, count-only, and payload-disclosure resolutions), and before the receive list the run fills is recorded and any linkage key or payload row moves (`packages/core/test/termsExchangedHook.test.ts`). The first round's capacity checks run after it and can still refuse the run. A throw from it ends the run after that side sends its partner an abort stating `"a party could not complete its step after the terms exchange"`, so the partner reports that its partner ended the run. The online `invite` and `accept` write their configuration there, so a run cut between its store and that step, or refused by one of those checks, leaves its key file saved and its configuration unwritten, and the CLI states the step for that state ([CLI.md](../CLI.md#online-invitation)).

**The zero-setup bootstrap frame.** A third path establishes a secret of this same format, and it is the one that puts one on the wire. When both parties declared `--save` on a zero-setup exchange, the initiator generates 32 CSPRNG bytes exactly as an invitation token does and sends them to the responder on a dedicated `{ sharedSecret }` frame; both return the value for their caller to persist. The frame is sent immediately after message 3 of the terms exchange and before the linkage rounds begin. Both parties learn from that terms exchange whether it is sent, so it is never negotiated further and neither side blocks awaiting a frame the other will not send. A zero-setup exchange runs no key exchange, so there is no session key and no application-layer AEAD above the transport, and the secret is protected by the transport alone for that one frame; the trust model that rests on, and the `--retain-files` at-rest consequence, are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#bootstrapping-a-shared-secret).

## The previous secret

`authenticateConnection` (`packages/core/src/auth.ts`) takes, beside the current secret, a `RotationState`: the previous secret with its own `expires`, when the side holds one, and the rotation history ([The rotation history](#the-rotation-history)). It offers the previous secret to the handshake as **Which secret a handshake uses** ([P-256 authenticated key exchange](PROTOCOL.md#p-256-authenticated-key-exchange)) states, and the `expires` it hands the terms exchange's checks is that of the secret the handshake used.

- **Which store keeps it.** The initiator's store keeps the secret its handshake used as the previous secret, beside the next one; the responder's store keeps none, since it is made only after `proceed` has shown that the initiator stored. So a side holds a previous secret only after a run in which it stored as the initiator, and it may take either role in the next run.
- **The drop.** The initiator drops its previous secret when the responder's first frame after terms message 3 that is not an abort arrives: `runExchange` awaits the caller's `TermsRotation.partnerStored` once, before that frame is read, on the initiator only. The responder stores before it sends any frame after `proceed`, so that frame shows the responder stored the next secret; it shows that only where the AEAD layer opened it. A responder whose store failed sends an abort, which is not such a frame, so the initiator keeps its previous secret. A drop that throws ends the run, after the initiator sends the responder an abort stating `"the partner could not remove its previous shared secret"`, so the responder reports that its partner ended the run. A completed run in each exchange mode -- cascade, single-pass and count-only -- sends such a frame, which `packages/core/test/initiatorDropsPreviousSecret.test.ts` checks in both PSI roles.
- **Until a store replaces it.** The next run in which that side stores replaces it: as initiator it keeps the secret that run used instead, and as responder it keeps none. A run that stores nothing leaves it in place, and the command line's key file can still hold it after a drop that fails ([EXCHANGE_FILE.md](EXCHANGE_FILE.md#the-previous-secret-and-the-rotation-history)). A previous secret whose `expires` has passed is not offered, and one equal to the current secret is not offered either.

The heal run rotates as any run does. The initiator of the cut run is the side that may be ahead, and only its responder can be behind: before the initiator's store the responder cannot have stored, and after it the initiator holds the newer secret.

How each application keeps the previous secret and history:

- **The command line** (`apps/cli/src/protocol.ts`) keeps both in the key file ([EXCHANGE_FILE.md](EXCHANGE_FILE.md#the-previous-secret-and-the-rotation-history)), so a cut run heals on the next run and a stale copy gets `LocalCopyBehindError` or `PartnerCopyBehindError`. Over WebRTC the side that may be ahead is the acceptor, which meets a partner left behind at the rendezvous ids of its previous secret ([WebRTC rendezvous peer-id derivation](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)). Each side whose handshake used a previous secret, its own or its peer's, reports that the run is healing a cut one.
- **A managed browser exchange** keeps both in its record ([MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md#persisted-across-runs), `previousSharedSecret` and `rotationHistory`), reading them inside the run+rotate lock (`authenticateExchange` in `apps/web/src/psi/authenticateExchange.ts`) and making each write a strict-durability write under that lock (`runManagedExchange` in `apps/web/src/psi/managed/managedExchangeRun.ts`).
- **The one-off browser exchange** keeps no previous secret, offers none, and passes an empty history.

## The rotation history

The history is a list of **history verifiers**, one per secret a side retired, newest first, each with that secret's own `expires`. A verifier is derived with the application HKDF from the 32-byte secret:

```
verifier       = HKDF(secret, "alcove-rotation-history-v2:verifier", 32)
proof_<role>   = HMAC(HKDF(verifier || k_his, "alcove-rotation-history-v2:proof-<role>", 32), e_I || e_R)
notice_<role>  = HMAC(HKDF(verifier || k_his, "alcove-rotation-history-v2:notice-<role>", 32), u32be(k) || e_I || e_R)
```

`<role>` is the sender's handshake role, `initiator` or `responder`; `k_his` is the key-agreement derivation's third block, the same on both sides whatever secrets they hold; `e_I` and `e_R` are the two ephemeral shares as sent; and `u32be(k)` is the notice's count as a 4-byte big-endian unsigned integer.

- **The proof.** A side makes its proof under the verifier of its own current secret: the responder in every message 2, the initiator in its abort when no tag verifies. The shares are fresh in every handshake, so a proof cannot be replayed into another one.
- **The check.** A side checks a peer's proof against the 64 newest entries of its history, every entry whatever matches. An entry whose `expires` has passed is not checked but keeps its place, so position `k`, counted from 1 at the newest, is always `k` rotations back. A match at `k` shows that the peer's copy is no older than the secret this side retired `k` rotations ago.
- **The notice.** On a match at `k` a side sends a notice stating `k`, under the matched verifier, which is the verifier of the peer's current secret; the peer checks it under its own. The distinct labels and the count inside the MAC input keep a proof, made under the same verifier, from verifying as a notice when a peer reflects it. A notice that verifies shows only that the sender holds a copy newer than the receiver's; the count is the sender's statement, and `LocalCopyBehindError` does not show it. The schema bounds the count to 1 through `2^32 - 1`.
- **What a verifier grants.** No handshake, peer id, relay key or AEAD key derives from a verifier, so a holder of the history can authenticate nothing it could not already. A proof or notice is keyed from a verifier and `k_his`, which only a holder of one of the handshake's ephemeral private keys computes, so a recorded handshake cannot be checked against a secret, or against a later copy of the history, after the fact.

The key file's `rotationHistory` field holds the list ([EXCHANGE_FILE.md](EXCHANGE_FILE.md#the-previous-secret-and-the-rotation-history)), and `deriveHistoryVerifier` in `@alcove/core` derives the entry for a secret being retired.

## `expires` enforcement and the 'expiring soon' advisory

A `.alcove.key` token may hold an `expires` instant written by either of two mechanisms: an invitation setup lifetime or the `token_max_age_days` policy. Enforcement reads only the stored `expires`, never its origin, and the same recovery (re-invite) applies to both, so no consumer branches on origin and no provenance marker is stored ([shared-secret-expiry.md](../notes/shared-secret-expiry.md)). The operator-facing policy is in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#shared-secret-rotation-and-inactivity-limit).

**Enforcement sites.** Four checks read `expires`. Three are kind-agnostic and abort on any `expires` at or before the current time, directing both parties to re-invite: the load-time check before an exchange, the pre-handshake check, and the terms-exchange check (which catches a token that lapses after the pre-handshake check, at each side's last point before a store that would leave the partner behind). The fourth, the accept-time invitation check, is the only single-kind site, since the encoded invitation it validates holds only an invitation lifetime. An invitation whose expiry cannot be compared -- the `expires` string does not parse, or the local clock does not -- is treated as expired there rather than accepted.

**What each of the three kind-agnostic checks covers.** The load-time and pre-handshake checks read only local state, so they run before any rendezvous I/O and an expired or malformed token costs no connection. The terms-exchange check is the one the store order places on each side ([The rotation at the terms exchange](#the-rotation-at-the-terms-exchange)). The responder's window, from its check to the initiator's store, is terms message 2's transit, bounded only by the connection's inactivity budget, and the initiator's is none. A token that lapses before either check is refused before either store, so both parties re-invite rather than persist a secret rotated from an expired one.

**'Expiring soon' threshold.** The advisory fires when the loaded `expires` is within `token_max_age_days / 3` days of the current time (a 90-day age warns with 30 days remaining) and is silent unless a policy is configured. It is shown only when the exchange that reports it fails, since a successful one rotates the token to a farther-out `expires`.

**Invitation token flagged 'expiring soon'.** Because the advisory does not consult origin, a freshly minted invitation token can be flagged. This is reachable only on the offline re-invitation path (the inviter's key file is the only one that persists an invitation `expires`; the acceptor's offline key file holds none, and the online flow persists only the rotated token), before the first exchange rotates the token, and it survives only past a *failed* first exchange. Its guidance is correct for either kind, so it is not suppressed.

**When to revisit.** The single reading of `expires` would need revisiting only if an expired max-age token were ever made recoverable without re-invitation, so that the expired-side action diverged by origin.
