---
title: "Rotation Hardening Design"
---

# Rotation hardening: recognizing a stale copy, and healing a one-sided rotation

_Status: proposed for the maintainer's ratification; core stages 2 and 3 and the command-line item are built, and so is the web item's first part, the history and the two stale-copy readings; the web item's heal is not ([The build split and its reviews](#the-build-split-and-its-reviews)).
Decided by the maintainer's rulings: always accept the previous secret, keep the WebRTC stale-copy limit, send a random value from the responder after key confirmation inside terms message 2, store the next secret initiator first, and state the SC-12 row as it is, keeping that value's own wrap (questions 1 to 4, 7 and 8).
Proposed, with recommendations for the maintainer to ratify: how the two values are drawn and whether the security review runs per stage (questions 5 and 6), and two choices no ruling covers ([Open questions](#open-questions)).
Nothing here is normative.
The rotation and the key exchange are specified in [PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation), the browser record in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-secret-is-a-linear-resource), the key file in [EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-key-file-schema), and the threat model this changes in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).
The spec changes the design implies are listed in [Proposed spec and documentation changes](#proposed-spec-and-documentation-changes), to be made with the stage that builds each.
See [docs/notes/README.md](README.md)._

## The two problems

A recurring exchange authenticates on a shared secret that both parties replace after every completed key exchange.
Two failures leave the parties on different secrets, and both are designed here as one change because both change the key exchange and the same threat model.
The same change makes the next secret independent of the current one, which SP 800-57 asks of a key replacement ([The next secret](#the-next-secret-independent-of-the-current-one)).

- **A stale copy.**
  A restored backup, an export, a browser-profile or VM snapshot, or a duplicated key file brings back the secret it captured.
  If the partnership has rotated past that secret, the copy's next run fails.
  Today nothing records which secrets came before, so neither party can tell a superseded copy from a stranger ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).
- **A one-sided rotation.**
  Both parties end the key exchange holding the next secret, and each stores it before it sends anything else.
  When one side's store fails, or the process stops between the handshake and the store, that side keeps the old secret and the other has the new one; so does a lost third key-exchange message, which leaves the initiator with the next secret and the responder on the old one, and which a party on the path of the shared folder can cause on purpose ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering); `authenticateRun` in `apps/cli/src/protocol.ts`).
  A secret that expires during the key exchange has the same effect: that side refuses the next secret and the other stores it ([CLI.md](../CLI.md#out-of-sync-tokens)).
  Today the only recovery is a re-invite, and each side keeps exactly one secret ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-rotation-in-flight-marker)).

What the operator sees today:

- On `sftp` and `filedrop`, both copies meet in the shared folder and the key exchange fails closed with the one generic authentication failure, which the partner cannot tell from an attack ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Failure handling).
- On `webrtc`, the two never meet, because both rendezvous peer ids derive from the secret ([PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)), so each side records a no-show.
- A side that stopped mid-rotation finds its rotation-in-flight marker and warns ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-rotation-in-flight-marker); [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-rotation-in-flight-marker)).
- A browser copy restored by an import is read as the `"imported"` tier, but only beside a failed-closed handshake (`recordedFailureTier` in `apps/web/src/psi/managed/managedFailureTiers.ts`).
  The browser runs a managed exchange over WebRTC only, holding an sftp connection for the command line to run ([managed-exchange-design.md](managed-exchange-design.md#bringing-a-command-line-configuration-back)), and over WebRTC a stale copy never reaches the handshake, so a restored stale browser copy is reported as a partner who did not arrive.

## The facts the design depends on

Four properties of the code fix what a mechanism can do.

1. **On `webrtc`, two different secrets never meet.**
   The peer ids, the relay key and the token-less exchange id all derive from the current secret ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)).
   Anything compared in the handshake is compared only between parties that already share a secret.
2. **On `sftp` and `filedrop`, they do meet.**
   The rendezvous is the configured folder, and each party names its files under a fresh random id (`uuidv4()` in `FileSyncConnection`, `packages/core/src/connection/fileSyncConnection.ts`), so two parties on different secrets reach the key exchange and fail there.
3. **The first key-exchange message does not depend on the secret.**
   Message 1 is the initiator's ephemeral share and its encryption flag; the secret first shapes a message in the responder's confirmation tag in message 2 ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Message flow).
   So the initiator does not commit to a secret before the responder has answered.
4. **A frame from the peer after the handshake proves the peer stored the next secret.**
   The CLI writes the rotated key file, fsync-durable, before it wraps the connection and sends any data frame (`authenticateRun` in `apps/cli/src/protocol.ts`), and the browser awaits its rotation write before it begins the data exchange ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering)).
   Every channel requests the application-layer encryption, and the negotiated decision is the OR of both requests ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Request-encryption flag), so every frame after the handshake is one the AEAD layer opens, and only a holder of the session key can make one.
   A one-shot web party stores nothing, but it either saves the next secret when the operator keeps the exchange or has no secret at all ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)), so its frame proves the same for any later run.
   The proof is good only within the durability limits each store states: a committed browser write survives a renderer crash but not necessarily an OS crash ([managed-exchange-design.md](managed-exchange-design.md#the-durability-limit)).
   Under the independent next secret below, both stores move into the terms exchange that follows the handshake, and the proof is a different frame for each side ([What it does to the one-sided rotation](#what-it-does-to-the-one-sided-rotation)).
   The initiator stores before it sends terms message 3 `proceed`, so that frame proves the initiator stored; the responder stores on reading it, before its first frame after the terms exchange, so that frame proves the responder stored when it is not an abort.
   An abort proves nothing, since a side can send one before or after its store.
   The two sides store the same secret: the initiator's tag, whose MAC input holds the wrapped `N_I`, makes that value the initiator's, the AEAD layer that opens terms message 2 makes `N_R` the responder's, and the key-agreement output is the same on both ends of one handshake.

## The next secret: independent of the current one

Today both parties derive the next secret from the session key, `HKDF(session_key, ...)` ([PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation)), and the session key mixes in the current secret, so the next secret's value depends on the current one's.
NIST SP 800-57 Part 1 Rev. 5 names that a key update and forbids it:

- **Section 8.2.3.2:** "If the 'value' of the new key is dependent on the value of the old key, the process is known as key update", and "Federal applications shall not use key update".
- **Section 8.2.3.1:** "If the new key is generated in a manner that is entirely independent of the 'value' of the old key, the process is known as re-keying. Replacement shall be accomplished using one of the key-establishment methods discussed in Section 8.1.5."
- IRS Publication 1075's SC-12 requires SP 800-57 for key management.

A reading under which the derivation is re-keying by key agreement exists, but the project claims no approved key-agreement scheme ([COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53), SC-12), so an assessor reading the text literally is likely to refuse it.
The design makes the next secret's value independent of the current one's instead, so rotation is not key update, and makes the change in the handshake Part 1 already changes, so the handshake changes once.
Whether it is also section 8.2.3.1's re-keying turns on that section's second sentence, the key-establishment method, which the design does not meet ([question 3](#open-questions)).

### The construction

- **Each party draws a random value of 32 bytes:** the initiator `N_I`, the responder `N_R`.
  How they are drawn is [question 5](#open-questions); the FIPS probe's draw leg gates its verdict but does not measure which generator draws them, so no document says either comes from the FIPS module ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-aes-kw-row-behind-the-rotations-wrap)).
- **`N_I` is sent in message 3.** Message 3 gains one field, the wrapped `N_I`, beside the previous-secret flag Part 1 adds ([Which secret a handshake uses](#which-secret-a-handshake-uses)).
  The abort form has no such field.
  The initiator is the first party to hold key confirmation: it has verified the responder's tag in message 2 before it sends message 3.
  SP 800-57 section 8.1.5.2.3 says keying material from a key agreement "shall not be used to protect and send information" until its assurances, key confirmation among them, have been obtained, and the responder, sending message 2, has not yet confirmed the initiator.
- **`N_R` is sent after key confirmation, in terms message 2.**
  The responder holds key confirmation once message 3's tag verifies, so that is the first point at which it may send keying material under the session key.
  It draws `N_R` only once it has read terms message 1 and agreed on the terms, and sends it wrapped, as one field of terms message 2, its reply in the terms exchange every run makes after the handshake (`exchangeTerms` in `packages/core/src/protocolSetup.ts`; [PROTOCOL.md](../spec/PROTOCOL.md#a-terms-change-at-the-terms-exchange)).
  The initiator already waits for that message before it sends terms message 3, so the design adds no message and no round trip.
  Terms message 2 is a frame the AEAD layer opens, under the responder-to-initiator key and its sequence number, so a frame replayed from another run, reflected, or reordered fails there ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#associated-data-is-not-bound)).
- **The field's rules.** On an authenticated run the field is required on a `proceed`: a `proceed` without a readable `N_R` ends the run on the initiator, as an omitted record count does.
  An abort carries none, and the initiator stores nothing from an abort, whatever it carries.
  A quick exchange runs no key exchange and has no session key, so it refuses a terms message 2 holding the field rather than reading past it.
  The terms schema is a plain `z.object`, which drops an unknown key without error ([What was measured](#what-was-measured)), so each rule is a check the build writes, not one the parse gives.
- **A responder whose checks on message 3 fail sends the abort**, which today it does not.
  By then the initiator has wrapped the connection, sent terms message 1, and waits for terms message 2 under the connection's inactivity budget, an hour by default on `sftp` and `filedrop`, not the handshake's per-message bound.
  The abort is a cleartext key-exchange frame, which the AEAD layer refuses as not its envelope, a `security` failure ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#application-layer-aead)), so the initiator fails fast.
  The classification fits: a message 3 that fails after a verified message 2 is tampering or a bug.
- **The flag and the wrapped value are bound as the MAC input of the initiator's tag:** `initiator_confirm = HMAC(confirm_key, "alcove-kex-v2:initiator-confirm" || h || flag || wrapped)`, so a changed byte fails the tag.
  `h`, `ck`, `session_key` and `confirm_key` are unchanged, and the responder's tag gains only a byte naming the message 2 field it is sent in ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Key schedule).
  Neither value is mixed into `h`: the wrapping key derives from the session key, which derives from `h`, so a ciphertext in `h` would be an input to the key it was made under.
  The responder computes the expected initiator tag once it has read message 3, not before it sends message 2 as today.
- **The wraps are AES-KW, under two keys.** Each key-wrapping key is `HKDF(session_key, label, 32)` by the application HKDF, under `alcove-shared-secret-wrap-v2` for `N_I` and `alcove-shared-secret-wrap-responder-v2` for `N_R`.
  Each is derived by `deriveKey` straight to a non-extractable `AES-KW` key, with usages `["wrapKey"]` on the sender and `["unwrapKey"]` on the receiver, so its bytes never exist in JavaScript, as for the ephemeral private key.
  Each key wraps one value and is then discarded, so it is used only for key wrapping.
  Each wrapped value is 40 bytes, 54 base64url characters.
- **The responder** verifies message 3's tag, then unwraps `N_I` under the key it derives the same way.
  An unwrap that fails its integrity check fails the handshake with the generic authentication failure, as a tag mismatch does.
  It is a consistency check, not a second defense: the tag already covers the wrapped bytes, and the tag and the wrapping key derive from one session key, so only a peer that holds the pre-shared secret and wrapped under the wrong key reaches it.
- **The initiator** opens terms message 2 at the AEAD layer, then unwraps `N_R` under the key it derives with the responder's label.
  The unwrap is a consistency check, as the responder's is: the AEAD layer already binds the frame to this run and direction under a key from the same session key, so only a peer that holds the pre-shared secret and wrapped under the wrong key reaches it.
  The wrap is kept for the SC-12 row, which states each value transported under AES-KW, while the AEAD's AES-GCM with a caller-supplied IV is a non-approved service on the FIPS variant's certificate ([question 8](#open-questions)).
  A `proceed` whose value is missing, malformed, or fails to unwrap ends the run on the initiator with an abort and nothing stored on either side ([What it does to the one-sided rotation](#what-it-does-to-the-one-sided-rotation)).
- **The stored next secret mixes both values with the handshake's key-agreement output:** `next_secret = HKDF(ka || N_I || N_R, "alcove-shared-secret-next-v2", 32)` by the application HKDF (HKDF-SHA-256, 32-byte zero salt, the label as `info`).
  `ka` is the 32-byte second block of the key-agreement derivation, the one SP 800-56C call over the ECDH shared secret ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), The key-agreement derivation), and nothing derived from the pre-shared secret, so the input is 96 bytes.
  A later hybrid key agreement that adds a second shared secret, ML-KEM beside ECDH, reaches the rotation only through that derivation or a second one chained after it ([key-establishment-fips-boundary.md](key-establishment-fips-boundary.md#the-build-2026-10-31)).
  Each side derives it once it holds both values: the responder once it has unwrapped `N_I` and drawn `N_R`, the initiator once it has unwrapped `N_R` from terms message 2.
  Neither value is stored.
- **Three labels take the place of `alcove-shared-secret-rotation-v2`** in the [label space](../spec/PROTOCOL.md#p-256-authenticated-key-exchange): `alcove-shared-secret-wrap-v2`, `alcove-shared-secret-wrap-responder-v2` and `alcove-shared-secret-next-v2`.
  They are single fixed labels that share `alcove-shared-secret-` and diverge after it, the two wrap labels after `alcove-shared-secret-wrap-`, so each is prefix-free against the others and the rest, which the label-space test checks.
- **The rotation is a step of the terms exchange.** `authenticateConnection` derives no next secret; `exchangeTerms` takes the session key, `ka`, `N_I` and each app's store, and awaits the store at that side's point in the store order, because the initiator's write must land before it sends `proceed`.
  The initiator's drop of the previous secret is a step on the first frame it receives after the terms exchange that is not an abort, outside `exchangeTerms` (`receiveAfterTerms` in `packages/core/src/partnerAbortFrame.ts` already tells an abort apart).
  Both apps' call sites change to pass the store and the drop.

Why the stored secret mixes in `ka` rather than being derived from the two values alone:

- **It keeps a man in the middle visible.** An active adversary holding the current secret runs one handshake with each party, and each leg has its own `ka`.
  It can unwrap both values on one leg and wrap the same values on the other, but the two parties still store different secrets, so it must stay in the middle for every later run or the mismatch shows, as with the derivation it replaces.
  Derived from the two values alone, the relayed pair would leave both parties on one secret the adversary knows, with no trace.
- **It keeps the secret independent of the current one.** `ka` comes from the two ephemeral keys alone, and `N_I` and `N_R` from the parties' random sources, so no input depends on the current secret's value.
  Nothing derived from the current secret enters: not the session key, and not the handshake hash `h`, which the `psk` token feeds.
- **It keeps the harvest-now-decrypt-later bound.** Both values travel only under session-key-derived wraps, so a recorder who later solves the Diffie-Hellman but never held a secret has `ka` and neither value.

What the responder value adds is the property the shipped derivation has against an outsider who can predict one party's randomness:

- **One party's predictable randomness exposes nothing.** An adversary who can predict the initiator's randomness knows its ephemeral scalar and `N_I`, and so computes the ECDH shared secret and its derived blocks from the responder's public share, but `N_R` travels under a key derived from the session key, which mixes the pre-shared secret.
  The same holds the other way for the responder, so either party's sound random source keeps the next secret from an outsider.
  That holds whichever party initiates: on `webrtc` the acceptor always does ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#roles)), and on `sftp` and `filedrop` the role follows arrival order (`packages/core/src/connection/fileSyncRendezvous.ts`).
- **Both parties' predictable randomness exposes the next secret.** An adversary who can predict both computes `ka`, `N_I` and `N_R` from the recorded handshake, and so the next secret, without ever holding a secret; from then on it holds the current secret.
  The shipped derivation mixes the pre-shared secret into the rotated secret, so that adversary computes nothing today.
  Every next secret independent of the current one has this exposure: its inputs are the key agreement and fresh randomness, and that adversary knows all of them.

Why AES-KW rather than the existing AES-GCM AEAD under a derived key:

- **It is the method SP 800-57 names.** Section 8.1.5.2.2.2, on automated key transport: "Approved key-wrapping methods that provide both confidentiality and integrity protection are provided in SP 800-38F."
  AES-GCM is SP 800-38D's authenticated-encryption mode, which that section does not name.
- **The FIPS variant's module approves it.** Certificate 5438's security policy, the document [CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests) names as the authority for that certificate's rows, lists `AES-KW` under SP 800-38F in section 2.5, in the row on page 10 of Table 6: Approved Algorithms, while its AES-GCM with a caller-supplied IV, the only form `crypto.subtle` offers, is a non-approved service ([COMPLIANCE.md](../COMPLIANCE.md#fips-140)).
- **It takes no IV.** KW is deterministic, so a single-use key needs no nonce rule.

The derivation's input has the form SP 800-56C Rev. 2 admits.
Its section 2 "permits the use of a 'hybrid' shared secret", "a concatenation consisting of a 'standard' shared secret Z that was generated during the execution of a key-establishment scheme (as currently specified in [SP 800-56A] or [SP 800-56B]) followed by an auxiliary shared secret T that has been generated using some other method", and says its key-derivation methods "will process a hybrid Z in the same way they process a standard Z".
`ka || N_I || N_R` is that order, with `ka` as `Z` and `N_I || N_R` as `T`.
`ka` is the key-agreement derivation's output, never the shared secret itself, so the rotation uses the shared secret only through the scheme's key-derivation method, as SP 800-56A section 5.8 requires ([COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53), SC-12); [question 3](#open-questions) records what the row said of it before the key-agreement derivation was built.
The quotation was read from the publication's PDF by a text extraction that drops the formula's symbols; the words quoted came through whole, and core stage 2 checks them against the publication before the spec cites it.

### What was measured

Driven in Node 26's `crypto.subtle`, with OpenSSL beneath it, and the repository's zod:

- **The algorithm.** Wrapping 32 bytes under a 256-bit key with `AES-KW` reproduces RFC 3394 section 4.6's test vector, and so does OpenSSL's `id-aes256-wrap` through `node:crypto`, so the independent vector generator can compute the wrap without WebCrypto.
- **Each value is wrapped as a `CryptoKey`.** Imported as an extractable HMAC or AES-GCM key, a value wraps to the same bytes either way; `wrapKey` refuses a non-extractable key (`InvalidAccessError`), and an HKDF key cannot be imported extractable.
  `unwrapKey` to an extractable key, then `exportKey("raw")`, returns the 32 bytes.
  `generateKey` for an extractable HMAC key with `length: 256` exports 32 bytes and wraps to 40.
- **Integrity.** A flipped bit at the start, middle or end of the wrapped bytes fails the unwrap (`OperationError`).
- **The key.** HKDF `deriveKey` straight to a non-extractable `AES-KW` key with usages `["wrapKey"]` wraps to the same bytes as `deriveBits` followed by `importKey`, and one derived the same way with `["unwrapKey"]` unwraps them to the original 32 bytes.
  The derived key refuses `exportKey`, the `wrapKey`-only key refuses `unwrapKey`, and the `unwrapKey`-only key refuses `wrapKey` (each `InvalidAccessError`); `AES-KW` offers no `encrypt` (`NotSupportedError`).
- **The two keys.** Keys derived from one session key under the two wrap labels keep the two values apart: a value wrapped under either label's key fails to unwrap under the other's, in both directions, and a value wrapped under the responder label's key fails to unwrap under the key the same label derives from another session key (each `OperationError`).
  OpenSSL's `id-aes256-wrap`, keyed with the bytes HKDF `deriveBits` gives for each label, reproduces both wrapped values.
- **The next secret.** ECDH `deriveBits` over two fresh P-256 key pairs gives the same 32-byte `dh` on both sides, and HKDF `deriveBits` over `dh || N_I || N_R` (a 96-byte key imported as `HKDF`, zero salt, `alcove-shared-secret-next-v2` as `info`) gives the same 32 bytes on both; `node:crypto`'s `createECDH("prime256v1").computeSecret` and `hkdfSync` reproduce both, so the vector generator can compute the next secret without WebCrypto.
  Swapping `N_I` and `N_R` changes the result.
  An `HKDF` key cannot be imported extractable (`SyntaxError`), so the rotation takes `ka`, a block the key-agreement derivation outputs, rather than the shared secret, which stays in a non-extractable key.
- **The relay case.** With a third party's key pair on each leg and both values passed unchanged from one leg to the other, the two honest sides derive different secrets, and the third party derives both.
- **`N_R` in terms message 2.** A value drawn by `generateKey` and wrapped under a key HKDF derives straight to `AES-KW` with the responder's label is 40 bytes, the same bytes on a second wrap, and 54 base64url characters as a field.
- **The terms schema.** A plain `z.object`, the form of the terms message 2 schema, parses a frame holding an unknown key without error and drops the key from the result; the same object with `.strict()` refuses it (`unrecognized_keys`).

Not measured here: Chromium's `AES-KW` and HKDF over the 96-byte input, which core stage 2's browser vector run measures, and the FIPS module performing the calls, which the probe's AES-KW leg measures and gates its verdict on ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-aes-kw-row-behind-the-rotations-wrap)).
The probe's draw leg gates the verdict on the draw completing, and does not measure whether the call that draws the two values ([question 5](#open-questions)) reaches the module's DRBG.
That WebCrypto's `AES-KW`, the RFC 3394 algorithm, is SP 800-38F's KW rests on the certificate's labeling of that row: SP 800-38F itself was not read, and the spec's citation of it is checked against the publication first.

### What it does to the one-sided rotation

The responder value decides when each side can store the next secret: the initiator cannot derive it before terms message 2 arrives.
The store order, for a run under a secret `X`, is the maintainer's ruling ([question 7](#open-questions)):

1. The initiator verifies the responder's tag and sends message 3, then terms message 1.
2. The responder verifies message 3, unwraps `N_I`, and settles the terms.
   On any refusal it sends an abort, which carries no `N_R`.
   On agreement it checks `X`'s `expires`, draws `N_R`, derives the next secret, holds it in memory, and sends terms message 2.
3. The initiator opens terms message 2, unwraps `N_R`, derives the next secret, and settles the terms.
   On any refusal it sends an abort and stores nothing.
   On agreement it checks `X`'s `expires`, stores the next secret keeping `X` as its previous secret ([Part 1](#keeping-the-previous-secret-until-the-partner-confirms)), and only then sends terms message 3 `proceed`.
4. The responder, on reading `proceed`, stores the next secret with no previous secret; on an abort it stores nothing.
5. The initiator drops `X` on the responder's first frame after terms message 3 that is not an abort.

Why this order:

- **No refused run rotates.** Every refusal, on either side, comes before the first store, so a run that ends before both parties said `proceed` changes nothing, and a terms message 2 that is lost, malformed, or holds no readable `N_R` leaves nothing stored on either side.
- **`proceed` proves the initiator stored**, so the responder's store keeps no previous secret: when it stores, the partner already holds the same next secret.
- **Only a frame that is not an abort proves the responder stored.** A responder can send an abort after `proceed` whether or not its store landed, so on an abort or on silence the initiator keeps `X`.
- **Each side checks `expires` at its last point before a store that would leave the partner behind**, the responder before it sends terms message 2 and the initiator just before its store, so an expired secret leaves nothing stored on either side.
  Once it has read `proceed`, the responder stores whatever its clock reads, since the initiator already holds the next secret.
  So the post-handshake check, whose window the handshake's per-message bound limits, moves into the terms exchange: the responder's window, from its check to the initiator's store, is terms message 2's transit, bounded only by the connection's inactivity budget, and the initiator's is none.
  A responder that refuses for expiry names it as its abort's fixed reason, so the initiator is told the partner's secret expired, where today it meets a silent peer or a key-exchange failure ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#shared-secret-rotation-and-inactivity-limit)); that tells the partner only that a limit was set.

The cut points.
"Unchanged" means what that side held before the run, a previous secret included; every store is one atomic write.

| Where the run stops | The initiator holds | The responder holds | The next run |
| ------------------- | ------------------- | ------------------- | ------------ |
| Before terms message 2 is sent: a key-exchange message lost or failing, terms message 1 lost, the responder refusing the terms, the version or the parse, its `expires` refusal, or the responder stopping | unchanged | unchanged | Runs under `X` like any run. |
| Terms message 2 lost, failing the AEAD layer, malformed, or with `N_R` missing or failing to unwrap; the initiator refusing the terms or for `expires`; its store failing, or the initiator stopping before its store completes | unchanged | unchanged | Runs under `X` like any run: nothing was stored on either side. |
| After the initiator's store: `proceed` lost, the responder's store failing, or the responder stopping before its store completes | the next secret, and `X` as its previous secret | unchanged | Heals: the handshake finds `X`, the initiator's previous secret, and both sides report it. |
| After the responder's store: its first frame lost, the initiator stopping before it opens that frame, or the initiator's drop write failing | the next secret, and `X` as its previous secret | the next secret | Runs under the next secret, the current secret on both sides; the initiator's `X` goes at its next store. |
| After the initiator drops `X` | the next secret | the next secret | Like any run. |

Every row leaves each side either rotated or holding `X`, which the next run accepts.
Only the third row leaves the two sides on different current secrets, and any cut between the initiator's store and the responder's store reaches it, not only a lost `proceed`.
It is the one-sided shape a lost message 3 leaves today, with the initiator ahead.

A heal run is a run under `X` like any other, so the same rows apply to it, with one difference: a side that was ahead keeps its unshared secret beside `X` until its own store in that run, whichever role it takes.
If the heal run stops in the third row with the formerly ahead side as responder, that side has made no store in it and still holds its unshared secret and `X` from the cut run, where it initiated, and the initiator holds a new next secret and `X`, so the run after it again finds `X`.
A side drops `X` only once the partner is shown to hold the next secret: the responder at its store, after `proceed`, and the initiator when the responder's first frame that is not an abort arrives.
So no sequence of cut runs leaves the two sides without a common secret, within the durability limits fact 4 states; [What does not heal](#what-does-not-heal) lists the rest.

Which side holds a previous secret follows from this order.
A side keeps one only when it stored as the initiator of the run that rotated, and it keeps the secret that run's handshake used; a store made as responder keeps none, and drops any previous or unshared secret the side held.
In a cut run the side left ahead is that run's initiator and the side left behind its responder.
The ahead side may take either role in the next run: on `sftp` and `filedrop` the role follows arrival order (`packages/core/src/connection/fileSyncRendezvous.ts`), so it swaps from run to run, and a heal run can have the ahead side as responder, as above.
On `webrtc` the roles are fixed, the acceptor always the initiator ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#roles)), so there only the acceptor ever holds a previous secret.

- **A heal run** completes under the previous secret and draws fresh `N_I` and `N_R` like any run, from which both sides derive a next secret with that run's `ka`.
  The ahead side's unshared current secret, which the cut run derived and only the ahead side stored, is discarded.
- **The previous-secret rules hold unchanged:** a store replaces it, it keeps its own `expires`, a re-invite drops it, an export omits it, and every heal is reported.
  It is always accepted ([question 2](#open-questions)).
  SP 800-57 section 8.2.3.2 does not reach it: the previous secret enters no later secret, so keeping it for one heal run is a question of how long a secret is used, not of how its replacement is made.

### What it does to the values derived from the secret

- **The rendezvous peer ids, the relay key and the token-less exchange id** derive from the current secret ([PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation), [Relay credential derivation](../spec/PROTOCOL.md#relay-credential-derivation)) and move at each rotation, to values independent of the previous ones.
  Each is a key derivation from the secret that does not replace it, not a key update.
  Each derives from the stored secret whichever way that secret was made, so the rules in [Meeting on WebRTC](#meeting-on-webrtc) and [The relay](#the-relay) apply to them as written.
- **The relay key's registration** sends the new key to the registrar under a proof made under the old relay key, as today; the relay key authorizes use of the relay and nothing else.
- **The history verifier** of Part 2 is derived from a secret the record retires and replaces nothing, so the proofs and the behind notice do not change.

## Part 1: healing a one-sided rotation

### Keeping the previous secret until the partner confirms

The initiator's rotation write keeps the secret the handshake used as the **previous secret**, beside the next one ([the store order](#what-it-does-to-the-one-sided-rotation)).
The initiator drops the previous secret as soon as the AEAD layer opens the responder's first frame after terms message 3 that is not an abort, in a write made before the run ends.
By fact 4 that frame proves the responder stored the next secret, so the previous secret is no longer needed.
The responder's store keeps none: it is made only after `proceed` has shown that the initiator stored.
So a side holds a previous secret only after a run in which it stored as the initiator, and it may take either role in the next run ([the store order](#what-it-does-to-the-one-sided-rotation)).

The previous secret therefore stays at rest only on the initiator of a run that ended between the initiator's store and the responder's first frame after terms message 3.
That window is `proceed`'s transit, the responder's rotation write, and one frame back, and it is exactly the window a one-sided rotation comes from.
In every run that failed after that frame, and every completed run as long as each sends such a frame, the previous secret is gone before the run ends; core stage 3 tests that a completed run in each exchange mode sends one.
The cost is one more durable write per run on the initiator: an atomic key-file write on the command line, and in the browser a strict-durability record write, which a completed run can make together with its success stamp.

Rules that bound it:

- **Until a store replaces it.**
  The next run in which that side stores a next secret drops it: as initiator it keeps the secret that run used instead, until that run's confirmation, and as responder it keeps none.
  Only a run cut before that side's store keeps a previous secret past its end.
  No time window is involved, so there is no width to choose.
- **It keeps its own `expires`.**
  The previous secret takes the `expires` it had as the current secret, so under `token_max_age_days` it never outlives the policy ([PROTOCOL.md](../spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory)).
  An expired previous secret is dropped, not offered.
- **A re-invite drops it.**
  The write that stores a fresh invitation secret removes the previous secret, so the compromise response ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#compromise-response)) ends both.
- **An export omits it.**
  The backup, the command-line export and the key file the web app writes hold only the current secret.
  The previous secret exists to heal the run that was cut on the device that ran it; keeping it out of files keeps it on that device.
  The cost: a copy moved right after a cut run cannot heal it, and recovers by re-invite as today.

The rotation-in-flight marker says this side may be behind; a previous secret says this side may be ahead.
Under the store order the side that may be ahead was the initiator of the cut run, and only its responder can be behind: before the initiator's store the responder cannot have stored, and after it the initiator holds the newer secret.
So a side writes the marker only when it is the responder of the run, a role known when the marker is written, after the transport opens and before the key exchange.
A marker left standing on the responder means the initiator may have stored, as a lost message 3 leaves it today ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-rotation-in-flight-marker)).
A marker already present from an earlier run stays until a recorded outcome supersedes it, whichever role this run takes.

### Which secret a handshake uses

A party holds one or two candidate secrets: the current one, and a previous one while a rotation is unconfirmed.
The key exchange picks the newest secret both parties hold, with no message added:

- **Message 2 has a second confirmation tag**, computed under the responder's previous secret, or under a random value when it holds none.
  The responder always computes both key schedules, so its work and the message's shape do not depend on whether it holds a previous secret.
  The tags are in a fixed order, current first, and each binds the field it is sent in, so a pair swapped in transit verifies in neither ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Key schedule).
  Before message 2 each schedule runs to its confirmation key and responder tag; the expected initiator tag takes message 3's flag and wrapped value ([The construction](#the-construction)), so the responder computes it under both schedules once message 3 is read, and its work stays the same whichever secret it holds.
- **The initiator trial-verifies** its current secret, then its previous one, against both tags, in constant time, and completes under the first that verifies.
  It always computes both schedules, for the same reason, and makes its own tag under the one it completes under, once it has wrapped `N_I`.
- **Message 3 states whether the initiator used its previous secret**, bound under the initiator's confirmation tag so a changed flag fails the handshake.
  The responder verifies message 3 against both of its schedules and learns which of its own secrets matched.
  The wrapped value in message 3 is under the session key of the schedule that completed, and the responder unwraps it under the key derived from that schedule's session key.
- **The responder wraps `N_R` under that same schedule's session key.**
  The schedule is fixed before terms message 2 is sent, so one wrapped value serves.

Each side so learns whether either side used a previous secret: the initiator from which of the responder's tags verified, the responder from message 3's flag and from which of its own schedules matched.
A tag under a secret the other side does not hold verifies nothing, so a party with neither secret learns nothing it could not learn today.

The run that completes under a previous secret rotates as any run does: both sides draw fresh values and store the next secret in the store order, and the initiator keeps the secret it used as its previous one until the responder's frame confirms.
The ahead side's unshared current secret is discarded, and its history gets no new verifier from this rotation: the secret it used is already in the list from the run that was cut, and the secret it discards was never shared.
The behind side appends the verifier of the secret it retires, the same one, so both lists hold the same verifiers in the same order.

### Meeting on WebRTC

On `webrtc` the ahead side must also be found at the peer ids of its previous secret, because the behind side knows no others (fact 1).
A side keeps a previous secret only when it stored as the initiator of the run that rotated, and on `webrtc` the initiator is always the acceptor ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#roles)), so the ahead side there is always the acceptor:

- **The inviter**, which listens, never holds a previous secret on `webrtc`, and registers under the inviter peer id of its current secret as today.
  Whether the inviter is behind or has rotated, it listens at the id of a secret the acceptor holds.
- **The acceptor**, which dials, offers to the inviter peer id of both of its secrets while it holds a previous secret: to both at once where its client holds two outgoing offers, and otherwise to one, then to the other once the broker answers the first with `EXPIRE`, 5 to 6 s after an offer to an absent id ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#broker-socket)).

The cost is a second offer per attempt, or the broker's 5 to 6 s hold of the first, in the unconfirmed state only; whether each app's client holds two outgoing offers at once is measured by the command-line and web items.
The coordination server can see that one party offers to both ids, which links the two rotations of that partnership to it ([PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) states what it can read today).

### The relay

The registrar replaces the relay key at each rotation the relay's party registers ([PROTOCOL.md](../spec/PROTOCOL.md#registering-the-rotated-relay-key)), so a relay credential derived from the previous secret is refused by that party's relay.
The credential only authorizes use of the relay; the exchange's authentication rests on the key exchange ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)).
So the relay key and the handshake secret are decoupled:

- **A party's credential for its own relay** is minted from the key its registrar holds: the key of its stored current secret, whichever secret the handshake uses, once any pending registration has landed (next bullet).
  The ahead side holds that key, so its own allocation works in a heal run.
- **A registration the cut run did not confirm.** Where the cut run stopped before its registrar confirmed the rotated key, the key file or record holds `relayRegistrationPendingSince`, and the registrar may still hold the key of the previous secret.
  Today the retry before the next run dials signs under the current secret's key ([PROTOCOL.md](../spec/PROTOCOL.md#registering-the-rotated-relay-key), The retry before the next run dials), which that registrar refuses, so the heal run would end with exit 77 before any contact.
  While a previous secret is held, the retry is signed under the previous secret's relay key instead, the request the cut run would have sent.
  A registrar still holding that key verifies the proof and takes the rotation; one already holding the current key, because the rotation landed and only its answer was lost, takes the request as a renewal, which it accepts under a proof made under the key it replaced ([PROTOCOL.md](../spec/PROTOCOL.md#the-registrar-request-proof), Verification).
  Neither the wire nor the registrar changes.
  A party holding no previous secret retries as today.
  That includes a side whose last store it made as responder, since that store keeps no previous secret ([the store order](#what-it-does-to-the-one-sided-rotation)): a side stopped between such a store and its registrar's answer ends its next run with the re-enrollment step, as any party stopped there does today.
- **Its registration after a heal run** is signed under the key its registrar holds, the key of the current secret at the run's start, and not under the key of the secret the handshake used.
  Both apps already sign with the secret held at the run's start: the command line with the secret it loaded (`registerRotatedRelayKey` in `apps/cli/src/relayKeyRotation.ts`), the browser with its copy of the record read inside the run+rotate lock ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator), The run credential).
  The build keeps that true when the handshake used the previous secret.
- **The behind side's own relay** holds the key of the secret the behind side stored, since a side registers only a rotation it stored (`registerRotatedRelayKey` returns without registering when the key file still holds the run's starting secret), so its own allocation works too.
- **A token-less default relay** ([PROTOCOL.md](../spec/PROTOCOL.md#enrolling-at-a-default-relay)) enrolls a row per derived exchange id.
  A party holding a previous secret enrolls the key and id of both secrets, two of the ten rows the registrar allows each client address, in the unconfirmed state only.
  The behind side's enrollment repeats the ahead side's row for the previous secret, which the registrar answers 200.
- **The WebSocket relay** follows the same rules: a party's own relay under the key its registrar holds, a derived exchange id under both secrets.

Stated limit: the behind side cannot allocate on the ahead side's own relay, which holds the key of a secret the behind side never stored.
A heal run then depends on the ahead side's relayed candidate, or on the behind side's own relays.
Whether ICE forms a path from one side's relayed candidate alone is the relay's and the browser's behavior, not measured here; the command-line item measures it against the reference relay before this limit is stated as a fact.
Where it does not form, the run reports a no-show and re-invite recovers, as today.
The command-line item measured the WebSocket relay: a relay holding one side's key pairs nothing, and the second dial under the previous secret's derived id pairs ([WEBSOCKET_RELAY.md](../spec/WEBSOCKET_RELAY.md#a-one-sided-allocation)).
TURN stays unmeasured, since the development container holds no TURN server.

### What the operator is told

A heal is always reported, on both sides, so that it cannot hide a copy running elsewhere.
Drafts, for the UX review of the stages that show them:

- **The ahead side:** "The last run stopped before your partner saved the new secret, so this run used the one before it, and both sides now have a new secret. If neither of you had a run stop partway, ask your partner whether they ran this exchange from another copy."
- **The behind side:** "Your partner still had the secret from before your last run stopped, so this run used it, and both sides now have a new secret. If no run of yours stopped partway, check whether this exchange also runs from another copy."

On the command line the run exits 0 with that warning on the terminal and the event stream.
In the browser it is a note on the run.

A run that ends on the next secret's own failures says which one: a wrapped value that did not unwrap, a responder value that was missing or malformed, or a secret that expired before this side committed.
A missing or unopenable responder value leaves nothing stored on either side, so the next run is an ordinary one; an expired secret is recovered by re-invite, as today, and a responder's expiry refusal reaches the initiator as its abort's reason.

- **A store that fails.** The side whose store fails sends an abort with a fixed reason of its own, which the partner reads as a known kind rather than waiting out the inactivity budget.
  The command line's save-failure message, which says the partner may already hold the rotated secret, is chosen by role: the initiator's failure leaves nothing stored anywhere, and the responder's leaves the initiator ahead, which the next run heals.
  The browser's storage failure keeps its meaning at its new point in the run.
- **The online `alcove invite` and `alcove accept`.** They write the configuration from a hook that runs after the rotated key file is saved and before the data exchange (`apps/cli/src/onlineBootstrap.ts`), and that save first creates the key file.
  With the save inside the terms exchange, the hook runs after the terms exchange, or the configuration, which holds no secret, is written before the handshake ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-secrets-path)).
  A refused run then leaves no key file on either side, so the same invitation runs again once the terms are agreed on, and the command-line item re-derives the refused-terms step [PROTOCOL.md](../spec/PROTOCOL.md#a-terms-change-at-the-terms-exchange) gives a party whose configuration write failed after its key file was saved.
- **The rotation-in-flight marker after a refusal.** A run refused before either store rotated nothing, so the refusal is a recorded outcome that supersedes the marker ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-rotation-in-flight-marker)); otherwise the next run would warn that the partner may hold a newer secret after a plain terms disagreement.
  In the browser the `"terms-change"` failure kind joins the outcomes that remove the marker ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-rotation-in-flight-marker)).

Their wording is drafted with the stage that shows them.

### What does not heal

- A side whose secret expired before the next run, the behind side's current secret or the ahead side's previous one: the first refuses before connecting ([PROTOCOL.md](../spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory)), and the second is dropped rather than offered.
- An ahead side that no longer has the previous secret: its browser store was evicted, or the exchange was moved by export.
- A committed rotation write lost to an OS crash or power loss after the partner relied on it: the initiator's, after `proceed` was sent, leaves the responder on a secret the initiator no longer has, with no previous secret; the responder's, after its first frame was opened, leaves the initiator without the previous secret it dropped.
- A stale copy two or more rotations behind, which Part 2 reports instead.
- A relayed heal on `webrtc` that the limit above stops.

Each of these keeps today's recovery: the rotation-in-flight reading where it applies, and re-invite.

## Part 2: recognizing a stale copy

### Why a rotation counter does not do it

The deferred hardening named a monotonic rotation epoch stored in the record and checked in the handshake.
A counter cannot do what it was meant to:

- **On `webrtc` it is never compared.**
  Two copies on different secrets never meet (fact 1), so neither handshake starts.
- **Before authentication it is advisory.**
  Two parties on different secrets share no key, so a counter either sends is a number the sender chose: a stranger can state any value, and a "your partner's copy is three rotations behind" message built on it would offer the benign reading to whoever wants the operator to reach it ([managed-exchange-design.md](managed-exchange-design.md#telling-a-desync-from-an-attack)).
- **After authentication it is redundant.**
  Two parties that complete a handshake hold the same secret, and so the same count.

A statement worth showing has to be proven by the stale side.
The stale side holds one thing the current side once had: the superseded secret itself.

### The rotation history

At each rotation write, and at each re-invite, a record appends a **history verifier** for the secret it is retiring: a key derived from that secret under a label of its own, in the [domain-separation label space](../spec/PROTOCOL.md#p-256-authenticated-key-exchange).
The record keeps verifiers, never the retired secrets.

- **What a verifier grants.** A proof under it shows that the peer holds the secret it was derived from or a later copy of the record, since every copy keeps the verifiers of all the secrets it retired.
  So a proof bounds how old the peer's copy is and proves nothing more: no handshake, peer id, relay key or AEAD key derives from a verifier.
  Anyone who reads the record already has the current secret, so the list lets no one authenticate who could not already; what it lets a reader learn from recorded handshakes is in [What changes in the threat model](#what-changes-in-the-threat-model).
- **Its order is the count.** The newest verifier is one rotation old, the next two, and so on, so the list replaces the counter and states nothing either side chose.
- **The derived-never-stored rule.** That rule exists so no stored value has to be kept consistent with the secret ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#derived-never-stored)).
  A verifier is derived from a secret the record no longer has, so it cannot be re-derived and nothing has to match it; the spec rule gains this one exception.

### The proof in the key exchange

When no secret matches, the two sides exchange **history proofs**: a MAC over both ephemeral shares of this handshake, under `HKDF(verifier || k_his)`, a key derived under a proof label of the history-verifier family, which names the sender's role, from the verifier of the sender's own current secret and this handshake's `k_his`.
`k_his` is the third block of the key-agreement derivation over the ECDH shared secret ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), The key-agreement derivation), the same value on both sides whatever secrets they hold.
The responder has it before it sends message 2, whose confirmation tag already depends on it, and the initiator once it reads message 2, before it sends its abort.
The chaining key cannot stand in for it: the pre-shared secret enters the chaining key at the first step, so two parties on different secrets share no chaining-key value.
The shares are fresh in every handshake, so a proof cannot be replayed into another one.

- **The responder's proof is in message 2**, always, so the message's shape does not depend on the outcome.
- **The initiator's proof is in its abort**, which it sends when neither tag verifies.
- **Each side checks the peer's proof against its own history.**
  A match at position *k* shows that the peer's copy is no older than the secret this party retired *k* rotations ago: a copy that old makes exactly that proof, and a newer copy, which holds that verifier too, can make it as well.
  No match leaves the generic failure exactly as today.

A match is a fact, not an explanation: someone holding a copy of this partnership's secrets no more than *k* rotations behind is on the other end.
That is the partner's restored backup or second copy in the case the product guards first, and a stolen old copy otherwise, so the message keeps the confirm-with-your-partner step:

- **The current side, drafted:** "The other side connected with an older copy of this exchange, no more than 3 rotations behind yours, such as an older copy of your partner's key file or saved exchange. Ask your partner to run from their newest copy; if they did not restore or copy one, treat this as a compromise and re-invite."
- The command line exits 77, the authentication failure code, as any failed key exchange does ([CLI.md](../CLI.md#out-of-sync-tokens)).

### Telling the stale side

The stale side cannot check the current side's proof: the current secret is newer than anything in its history.
The current side can still tell it, authenticated, because it holds the verifier of the stale side's secret: on a match it sends a **behind notice**, a MAC over the count *k* and both shares, keyed by `HKDF(verifier || dh)` from that verifier under a notice label of the history-verifier family, which names the sender's role and differs from the proof label, and which the stale side checks under the key it derives the same way from the verifier of its own current secret. The distinct labels and the count inside the MAC input keep a proof, made under that same verifier, from verifying as a notice when a peer reflects it, as the role-distinct confirmation labels keep a reflected confirmation from verifying ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Message flow).
A notice that verifies shows only that the sender holds a copy newer than the stale side's, one that retired its secret.
The count is the sender's statement: every newer copy holds that verifier and can put any count under it, so the stale side's message does not repeat it.

- Where the current side is the initiator, the notice goes in its abort.
- Where the current side is the responder, it answers the initiator's abort with an abort that contains the notice.
  A responder answers every abort that contains a proof, with or without a notice, so the reply's arrival tells nothing to a peer with no copy.
  The initiator waits for that reply only when its own check found no match, within the per-message handshake bound ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Failure handling), and a peer that sends none leaves the generic failure.
- **The stale side, drafted:** "This copy of the exchange is older than the one on the other side. Run from your newest copy of this exchange, or ask your partner for a new invitation."

A notice from the current side states to a holder of an old copy how many rotations the partnership has made since.
That holder is the partner's own operator in the case the product guards first, and the count is no more than the run cadence the shared folder's operator or the coordination server can already observe ([PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)), so the notice is sent.

### How long the history is kept

A verifier is useful only while the copy holding its secret could still connect.

- **With an `expires`.** A verifier is dropped once the retired secret's own `expires` passes, since a copy holding it then refuses before connecting ([PROTOCOL.md](../spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory)).
- **With or without one.** The list also keeps at most the 64 newest verifiers, an arbitrary working value, raised on request, so a short run cadence under a long `token_max_age_days` cannot grow it.
  At 32 bytes each, base64url-encoded, that is under 4 KB of key file or record.

A copy older than the list, or from before the history was built, gets the generic failure.

### Web: a restored copy's no-show, and which copy is newer

Two browser readings use what the record already has or gains here, and need nothing on the wire:

- **An import marker beside a no-show.**
  The `"imported"` tier is read only beside a failed-closed handshake (`recordedFailureTier`), which a restored copy over WebRTC never reaches.
  The marker is read beside the no-shows a stale restore produces, as the rotation-in-flight marker already is (`readManagedFailure`): an import since the last success, then only no-shows, is reported as a possibly stale restored copy, recovered by the newest copy or a re-invite.
  As for the rotation-in-flight reading, it never displaces a standing condition, and a successful run consumes it.
- **Which copy is newer.**
  An import of a copy of a stored exchange can order the two where the histories decide it: the stored record's history holding the verifier of the import's secret means the import is older, and the import's history holding the stored one's means it is newer.
  The replace question stays and states the order it found; where neither history decides, it asks as today ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#replacing-a-saved-copy)).
  The operator chooses; the app says what it knows.

The export artifact and the command-line export include the history, so a moved copy can still recognize an older one and be ordered on import.

## Per channel: where each case is detected, and what the operator is told

| Channel | A stale copy | A one-sided rotation |
| ------- | ------------ | -------------------- |
| `sftp` | Detected in the key exchange when the copy is within the partner's history. The current side is told how far behind the copy is at most, and to confirm with the partner; the stale side receives the behind notice. Older copies: the generic failure. | Heals at the next run in the key exchange, whichever side initiates; both sides are told. |
| `filedrop` | As for `sftp`: the rendezvous is the shared folder. | As for `sftp`. |
| `webrtc`, browser | Not detected across the wire. The restored copy's import marker beside its no-shows is reported as a possibly stale restore; the current side sees no-shows. A copy exactly one rotation behind a side still holding its previous secret heals instead. | Heals at the next run: the acceptor, the only side that can be ahead there, offers to the inviter id of both secrets; both sides are told. Subject to the relay limit. |
| `webrtc`, command line | Not detected across the wire. Both sides see no-shows; the CLI has no import marker, so its no-show message names a restored or copied key file among the causes. | As for the browser. |

## The problems, answered

- **A counter cannot fire on WebRTC.** Correct; the design keeps no counter. On `webrtc` a stale copy is reported locally (the import marker in the browser, the no-show message on the command line) and not across the wire, a stated limit the maintainer chose ([question 1](#open-questions)). The one-sided rotation does heal there, through the two-id rendezvous.
- **A counter compared before authentication is advisory.** Replaced by the history proof, which only a holder of the retired secret or of a later copy can make, and by the behind notice, which only a holder of that secret's verifier can make. The proof bounds how old the peer's copy is and the notice shows that the sender's copy is newer; only the notice's count is the sender's statement, and the stale side's message does not show it.
- **The previous secret lengthens a captured copy's live window.** Bounded to one run per cut, and only after a run cut between the initiator's store and the responder's first frame after terms message 3. Where the partner is behind, the previous secret is the partner's current one and live anyway; where it is not, a captured copy of it stays live until the next run instead of the last. An attacker who can cut a run can extend a captured secret by that one run. An attacker who drops terms message 3 on every run keeps it live on both sides for as long as the dropping continues, because the responder never stores a next secret and the initiator keeps the secret both still share as its previous one; one who drops message 3 or terms message 2 on every run keeps the current secret live the same way, with no previous secret involved. Terms messages are frames the AEAD layer seals, so a party on the path can drop them but not read them. Every heal is reported on both sides, so terms message 3 dropped every time shows as a heal at every run, the signal to re-invite ([What the operator is told](#what-the-operator-is-told)). [Question 2](#open-questions) is where that is weighed.
- **The previous secret can hide a stale restore or a self-fork.** A copy restored from before a completed run is not healed: the previous secret was dropped when that run's partner frame arrived, and the history proof reports the copy instead. The remaining case, a copy exactly one rotation behind a run that was itself cut, is indistinguishable from the failure the window heals, and the heal is reported on both sides with the question that exposes a second copy.
- **The registrar has replaced the previous relay key.** The relay credential is decoupled from the handshake secret, and a registration the cut run left pending is retried under the previous secret's key, so each side's own relay works; the behind side's allocation on the ahead side's relay is the stated limit.
- **A wire change pre-release.** Every change is to the key exchange's existing three messages and its abort, plus one field of terms message 2. The protocol-version tag is reserved for a suite change, and the strict message schemas fail a mismatched build closed at parse ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Protocol-version tag), so before the first release the change takes no version decision; after it, the same change would strand every deployed peer with a parse failure.

## What changes in the threat model

- **A secret can authenticate a second handshake.** Today each secret authenticates one completed handshake and is retired ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#token-format-and-entropy) states it is never reused). With the previous secret, a secret whose run was cut between the initiator's store and the responder's first frame after terms message 3 authenticates one more, the heal, and one more again for each heal cut the same way. An organization whose rotation policy forbids that is the subject of [question 2](#open-questions).
- **A superseded secret is at rest** on the initiator of a cut run, for up to one run, under the same custody as the current secret.
- **Frames before authentication say more.** Message 2 always has a second tag and a history proof; an abort can have a proof and a notice. None verifies for a party with no copy. Message 2's additions are sent on every handshake and the abort's proof on every failed one, so neither tells an outcome; the notice is addressed only to a proven holder of an old copy, though on `sftp` and `filedrop` the transport operator can read it, as it can message 3's flag ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), What a transport operator reads).
- **A recorded handshake cannot be checked against a secret without one of its ephemeral private keys.** The history proof and the behind notice are keyed from a verifier and that handshake's `k_his`, which only a holder of the initiator's or the responder's ephemeral private key can compute. So someone who later obtains a secret, or a later copy of the record, key file or export, cannot tell from recorded frames, such as those the shared folder's operator can record on `sftp` and `filedrop`, which handshakes used it. A party to the handshake can check it, since it held one of the two keys; that is the check the design makes.
- **The coordination server can link two rotations** of a partnership in the unconfirmed state, from the acceptor's offers to two ids.
- **The next secret is independent of the current one.** Rotation is not key update (SP 800-57 section 8.2.3.2): no secret computes a later one.
  The design claims that value independence, not conformance to section 8.2.3.1's re-keying ([question 3](#open-questions)).
  The next secret is derived from `ka`, `N_I` and `N_R`, so computing it takes all three: the two values, which only the wrapping keys open, and `ka`, which only a holder of one of the handshake's ephemeral private keys computes.
  Its strength is the one [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#token-format-and-entropy) states for a rotated secret: the full 32-byte value against an outsider, and about 128 bits, the P-256 level [PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation) states, against a holder of the superseded secret who only records, since `dh` alone gives that holder the session key and so both values.
  Against an outsider it rests on the current secret and the ephemeral exchange together while either party's randomness is unpredictable (the last bullet).
- **The harvest-now-decrypt-later bound is kept.** The wrapping keys derive from the session key, which mixes the current secret with the ECDH output, so a recorder who later solves the Diffie-Hellman but never held a secret has `dh` but cannot unwrap either value, cannot compute the next secret, and every later secret stays closed to them ([key-establishment-fips-boundary.md](key-establishment-fips-boundary.md#post-quantum-horizon)).
  Deriving the next secret from the ECDH output alone would also be independent of the current secret, but would give that recorder every secret after the first run.
  Once `ka` includes an ML-KEM shared secret, solving the Diffie-Hellman alone no longer gives that recorder `ka` either.
- **An active adversary holding the current secret stays visible.** It can complete a handshake with each party under that secret, and so learns or chooses both values on each leg and computes each leg's `ka`, so it holds both secrets the parties store, as it does under the derivation this replaces.
  Those two secrets differ, because each leg has its own `ka` and the adversary cannot make the two equal, even when it passes both values unchanged from one leg to the other.
  So it must stay in the middle for every later run until an out-of-band re-invite ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design)); a run it misses fails, or on `webrtc` the parties do not meet, which leaves the trace the derivation this replaces leaves.
  Deriving the next secret from the two values alone would remove that trace: both parties would hold one secret the adversary knows, and it could step away ([The construction](#the-construction)).
  An impersonator who runs the handshake with one party only, choosing that leg's values, leaves that party on a secret the other party never saw, the same desync as today.
  SP 800-57 section 8.2.3.1 conditions re-keying on "the re-keying scheme itself" not being compromised.
- **Against an outsider, the next secret rests on either party's randomness.** An adversary who can predict one party's randomness computes the ECDH shared secret, its derived blocks and that party's value, but not the other value, which travels under a key derived from the session key; it computes the next secret only when it can predict both parties' randomness ([The construction](#the-construction)).
  The shipped derivation mixes the pre-shared secret into the rotated secret, so an adversary who predicts both gets nothing today: the design keeps the one-party case and loses the both-parties case, which every next secret independent of the current one loses.

## Proposed spec and documentation changes

Each change lands with the stage that builds it, so the spec keeps describing the code.
The stages are those of [The build split and its reviews](#the-build-split-and-its-reviews): core stage 2 (the independent next secret), core stage 3 (the previous secret and the history), the command-line item, and the web item.

- **[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange)**, P-256 authenticated key exchange.
  - Core stage 2: the wrapped `N_I` in message 3 bound as the MAC input of the initiator's tag, with `h`, `ck`, the session key, the confirmation key and the responder's tag unchanged and the wrapped value not mixed into `h`; the responder's abort on a failure of message 3, and how the initiator, which has wrapped the connection by then, reads it; `alcove-shared-secret-wrap-v2`, `alcove-shared-secret-wrap-responder-v2` and `alcove-shared-secret-next-v2` in the label space in place of `alcove-shared-secret-rotation-v2`; and regenerated vectors that fix both values and record both wrapped values and the next secret derived from them and the vector's `dh`, which the independent generator computes with OpenSSL's `id-aes256-wrap` and `node:crypto`'s HKDF.
  - Core stage 3: the second tag and the history proof in message 2, each responder tag binding the byte of the field it is sent in, the flag in message 3 beside the wrapped value under the initiator's tag, `HMAC(confirm_key, "alcove-kex-v2:initiator-confirm" || h || flag || wrapped)`, the expected initiator tag computed once message 3 is read, the abort's proof and notice, the trial verification and the constant work on both sides, and the history-verifier label family in the label space, with distinct proof and notice labels per role and the count inside the notice's MAC input.
- **[PROTOCOL.md](../spec/PROTOCOL.md#a-terms-change-at-the-terms-exchange)**, the terms exchange.
  - Core stage 2: the wrapped `N_R` on the terms-exchange envelope beside the record count ([Role resolution and work minimization](../spec/PROTOCOL.md#role-resolution-and-work-minimization)), required on an authenticated terms message 2 that proceeds, absent from an abort, and refused on a quick exchange; the fixed abort reasons for a failed store and an expired secret; and the store points of the store order.
  - Core stage 3: the initiator's drop of its previous secret on the responder's first frame after terms message 3 that is not an abort.
  - The command-line item: the refused-terms step for an online `alcove invite` or `alcove accept` whose configuration write failed after its key file was saved, re-derived for the save's place in the terms exchange.
- **[PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation)**, Shared-secret rotation, rewritten.
  - Core stage 2: each party draws a 32-byte value, the initiator's sent in message 3 and the responder's in terms message 2, each under AES-KW (SP 800-38F) with its own key derived from the session key; `ka` defined as the handshake's whole key-agreement output, `dh` for the P-256 handshake; both store `HKDF(ka || N_I || N_R, "alcove-shared-secret-next-v2", 32)`, and why `ka` is mixed in; the rotation as a step of the terms exchange, and the store order; the strength statement, kept as it reads; and the "recompute it independently" paragraph.
    `expires` enforcement's post-handshake check moves into the terms exchange, to each side's last point before a store that would leave the partner behind: the responder's before terms message 2, the initiator's just before its store, with the responder's window stated as terms message 2's transit.
  - Core stage 3: the initiator's previous secret, its drop, and the history append.
- **[PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)**, WebRTC rendezvous peer-id derivation, with the command-line and web items: the acceptor's offer to the inviter id of both secrets while it holds a previous secret.
  Relay credential derivation, Registering the rotated relay key, and Enrolling at a default relay: the relay rules in [The relay](#the-relay), the credential rule with core stage 3 and the registration and enrollment rules with the app items.
- **[EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-key-file-schema)**, the key file.
  With core stage 2, for the command line: the rotation-in-flight marker's Write order, where a run writes the marker only as the responder and a marker already present stays until a recorded outcome supersedes it, and its What it means, since only a responder's marker records that the partner may have saved a secret this file does not hold ([Keeping the previous secret until the partner confirms](#keeping-the-previous-secret-until-the-partner-confirms)).
  With core stage 3: the previous secret and its `expires`, the history, the rotation-in-flight marker's "no previous secret is kept", and the key the pending relay registration's retry is signed under.
  With the command-line item: the marker's supersession by a refusal before either store, and the online provisioning paths, per [What the operator is told](#what-the-operator-is-told).
- **[MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-secret-is-a-linear-resource)**.
  Core stage 2: the persist-before-success steps, where the initiator's rotation write lands before it sends `proceed` and the responder's on reading it; and the rotation-in-flight marker's Written rule, where a run writes the marker only as the responder and a marker already present stays until a recorded outcome supersedes it.
  The web item: the linear-resource rule that neither party keeps the old secret, the single-owner invariant's "there is no grace window", the persist-before-success steps for the previous secret (stored by the initiator, then the confirmation write), the rotation-in-flight marker and the `"terms-change"` failure kind among the outcomes that remove it, the key the pending relay registration's retry is signed under, the exception to derived-never-stored, the export artifact (history in, previous secret out) and its no-anti-rollback caveat, the import marker read beside a no-show, and the replace question stating an order.
- **[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-exchange-authentication)**.
  Core stage 2, for the independent next secret: the "both parties independently derive the same replacement token" sentence; in Token format and entropy, the sentence that rotation derives the replacement deterministically from the session key with no extra round-trip, while the rotated secret's strength sentence stays as it reads; the one-shot web exchange's "derives the rotated replacement secret"; and Key-agreement design's statement of the active adversary.
  Core stage 3 and the app items: the one-sided write paragraph, the never-reused sentence, the compromise response's "valid until the next successful exchange", the primary controls, and the rollback section, each per [What changes in the threat model](#what-changes-in-the-threat-model).
- **[COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53)**, the SC-12 row, with core stage 2, a sentence the build makes true ([question 3](#open-questions)): rotation makes the next shared secret's value independent of the current one's, so it is not the key update SP 800-57 Part 1 Rev. 5 section 8.2.3.2 forbids; the next secret is derived from the handshake's key-agreement output and a random value from each party, each value transported under AES-KW (SP 800-38F) with a key derived from the session key, the initiator's in key-exchange message 3 and the responder's in terms message 2.
  The gaps are stated with it: the wrapping keys and the next secret rest on the key establishment the row already disclaims, so the approved key-agreement scheme SP 800-57 section 8.1.5.2.3 asks for is not met; the derivation takes the hybrid shared-secret form of SP 800-56C Rev. 2 section 2 without the scheme that form presumes; and where the random values come from is unmeasured.
  The probe's draw and AES-KW legs gate its verdict, and an engaged transcript shows the module performing the AES-KW calls ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-aes-kw-row-behind-the-rotations-wrap)).
  The row makes no claim of conformance to section 8.2.3.1.
  The row's statement that every operation is a `crypto.subtle` call changes or stays as [question 5](#open-questions) decides.
- **[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#authenticated-abort-marker)**, with core stage 2: the abort marker's paragraph, which names `alcove-shared-secret-rotation-v2` among the labels its own is distinct from.
  The decision to bind no associated data stands: terms message 2 is a frame of the one stream its direction already carries.
- **[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-approved-algorithm-rows-behind-the-measured-call-shapes)**, with core stage 2: an `AES-KW` row for the call shape the probe leg measures.
- **[CLI.md](../CLI.md#out-of-sync-tokens)**, Out-of-sync tokens, and [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#desync-detection-and-recovery), with the command-line and web items: the heal, its message, and when re-invite is still the recovery.
  CLI.md's two statements that the token is replaced after each successful authentication handshake, before the data exchange, with the command-line item: the replacement lands in the terms exchange.
- **[managed-exchange-design.md](managed-exchange-design.md#the-grace-window)**, with the web item: the grace window and single-device ownership sections point here.

## The build split and its reviews

Three items, the first ahead of the other two, which are independent of each other.

1. **Core: the key exchange and the history**, in three stages, each its own pull request: stage 1 is this note's amendment, and stages 2 and 3 build.
   - **Stage 2, the independent next secret.**
     The drawing of both values, `N_I`'s AES-KW wrap in message 3 under the tag, `N_R`'s field and wrap in terms message 2 with the field's rules, both unwraps and their failure paths, the rotation as a step of `exchangeTerms` awaiting each app's rotation write in the store order, the abort reasons for a failed store and an expired secret, the `expires` checks at each side's commit point, the derivation over `ka || N_I || N_R`, the three labels in place of the rotation label, the vectors' fixed values, wrapped bytes and next secret, the browser vector run that measures Chromium's `AES-KW` and HKDF over the 96-byte input, and a check of the SP 800-56C Rev. 2 section 2 wording quoted in [The construction](#the-construction) against the publication before the spec cites it.
     A probe leg in `support/fips-probe/` for the `AES-KW` call and for whether the call that draws the two values in the FIPS image draws from the module's DRBG; until it shows that, no document says either value comes from the module.
     The `COMPLIANCE.md` SC-12 sentence the construction makes true.
     Both apps pass their rotation write; an app step tied to the write's place, such as the online flows' configuration hook, moves with it, and the command-line and web items give each its final form.
     Both apps write the rotation-in-flight marker only as the run's responder.
     Until stage 3 and the app items give the initiator a previous secret, a cut between the initiator's store and the responder's store (a lost `proceed` included) is not healed and needs a re-invite, as a lost message 3 does today.
     Until the command-line and web items land, a run refused at the terms exchange leaves the marker standing, so the warning it raises at the next run is a false one.
     **Security review: required.** It changes the handshake and the terms exchange, and replaces how the next secret is made: the two wraps, their keys' derivation, the responder value and the next secret's derivation; its scope names the terms exchange.
   - **Stage 3, the previous secret and the history.**
     The message changes, the trial verification, the history verifier and its proofs and notice, the labels and their label-space check, the regenerated key-exchange vectors, the key-file schema fields, the initiator's drop after the terms exchange with its test per exchange mode, and the relay-credential rule.
     `authenticateConnection` takes the previous secret and the history and returns which secret each side used and what the peer proved.
     Both apps adapt their call sites only, passing no previous secret and an empty history, so their behavior is unchanged while the wire shape is new.
     **Security review: required.** It adds frames read before authentication, and its review reads the combined handshake ([question 6](#open-questions)).
2. **Command line.**
   The key file's previous secret, its rotation and confirmation writes, the history append and pruning, the acceptor's offers to both inviter ids in the WebRTC attempt cycle, the relay registration and enrollment rules, the measurement of one-sided relay allocation against the reference relay, and the messages and exit codes.
   With them, the online flows' configuration hook after the terms exchange, the marker's supersession by a refusal before either store, and the save-failure message chosen by role ([What the operator is told](#what-the-operator-is-told)).
   It tests the pending registration's retry under the previous secret's relay key against a registrar still holding that key and against one already holding the current key.
   **Security review: required**, scoped to the superseded secret at rest and the second rendezvous offer, not the protocol.
3. **Web application.**
   The record's previous secret and history, under the run+rotate lock with strict-durability writes; exports omitting the previous secret and including the history; the acceptor's offers to both inviter ids in the browser rendezvous, and both ids in the default-relay enrollment; the `"terms-change"` outcome removing the marker, and the storage failure at its new point; the heal notes; the import marker beside a no-show; the import's order.
   It tests the managed run's pending-registration retry under the previous secret's relay key as item 2 does.
   It lands as two pull requests: first the history, its exports, the import marker beside a no-show and the import's order; then the heal, whole, since without the two-id rendezvous a browser heal never meets.
   **Security review: required**, scoped as for item 2, plus a UX review for the notes and the replace question.
   Choices the heal pull request made, each a proposal for that review:
   - The record keeps `previousSharedSecret` and `previousExpires` as optional fields and its `schemaVersion` stays: a build that predates them drops them at its next write, which loses one heal and misstates nothing.
   - A heal is recorded as `healedCutRotation` on the run's `"succeeded"` entry, and the run history picks the ahead or behind note by the record's side, since over WebRTC only the acceptor keeps a previous secret.
   - Both dials take the TURN credential minted from the current secret, as the command line's do, so the default relay's TURN url is listed only once the current secret's enrollment confirms; its WebSocket relay url is listed under each secret whose enrollment confirmed.
   - A drop of the previous secret that fails ends the run, as core's `partnerStored` rule states, and is recorded as the run's failure; the previous secret stays for the next run.
   - The partner-storage copy says the next run can still reach the partner only while the record holds a previous secret the run would offer, read at render, and keeps the re-invite as the step offered for runs that keep failing; with none it names the re-invite alone.
     Its standing condition still waits for the operator's acknowledgement, which a successful run never gives for any standing condition; the page and the list say once a run since then succeeded.
     Clearing it on a heal run's success is a behavior change left to the maintainer.
   - The live heal note is stated once both sides saved the next secret: the responder at its own save, the initiator once the partner's first frame shows it saved.
   - A browser inviter whose save fails names the next run as the step only where its acceptor completed the key exchange under its previous secret, as the command line's responder does; the record keeps no account of that, so the next visit names the re-invite.
   - No import, a backup restore or a command-line pair, carries a previous secret onto the record, as no export writes one.

Each item lands its own spec changes, with its wording-change list, and the `SECURITY_DESIGN.md` changes it makes true.

## Open questions

Questions 1 to 4, 7 and 8 are decided; questions 5 and 6 each carry a recommendation for the maintainer to ratify, and the list ends with the two choices no ruling covers.

1. **Recognizing a stale copy on WebRTC.**
   The design reports it only locally there.
   Decided: (a). The maintainer's ruling to keep the rendezvous ids derived from the current secret, "Keep the derivation and state the limit.", settles it.
   - (a) Keep that as a stated limit: the browser's restored copies are covered by the import marker beside a no-show, and the uncovered case, a command-line key file restored on WebRTC, still recovers by re-invite.
   - (b) Derive the rendezvous from a value fixed at setup rather than from the current secret, so a stale copy reaches the handshake and the history proof fires. The coordination server could then link every run of a partnership by its ids, and any holder of any old copy could take the inviter's id first and keep the partner out until a re-invite.
   - (c) Have the current side also register under the ids of its last few retired secrets. Each adds a registration per attempt and links those rotations at the server.
2. **Whether the previous secret is always accepted.**
   Decided: (a), with (b) to be built if it becomes necessary.
   - (a) Always, with no setting: it is held only after a cut run and for one run, and every heal is reported.
   - (b) On by default, with a per-exchange setting to refuse it, for an organization whose rotation policy forbids a second use of a credential.
   - (c) Off by default, with a setting to turn it on.

   A reading of SP 800-63B-4 against the previous secret found the secret outside that publication's scope, which is the authenticators of a natural-person subscriber, and found no text there that asks for (b).
3. **What the SC-12 row says about the wrapping key and the next secret's derivation.**
   SP 800-57 section 8.1.5.2.2.2 asks that "a key-wrapping key shall be generated and distributed in accordance with Sections 8.1.5.2.1 and 8.1.5.2.2 or established using a key-establishment scheme as defined in Section 8.1.5.2.3".
   The wrapping keys are not generated and distributed but derived from the session key the handshake establishes, so the second alternative is the one that reaches them, and Section 8.1.5.2.3 asks for approved key-agreement schemes; the SC-12 row claims no SP 800-56A scheme for the session key the wrapping keys derive from.
   The next secret's derivation takes the key-agreement output, in the hybrid form SP 800-56C Rev. 2 admits but without the scheme that form presumes.
   Decided: (a), widened to state every gap, on the maintainer's ruling: "For the decision, I'd say we state it as it is for now but try to find out how to use an approved scheme."
   The row states rotation as value independence, not key update, with each value under AES-KW, the initiator's in key-exchange message 3 and the responder's in terms message 2, which holds only with `N_R`'s own wrap kept ([question 8](#open-questions)).
   It states the gaps: the wrapping keys and the next secret rest on the key establishment it disclaims, so section 8.1.5.2.3 is not met; the SP 800-56C hybrid form is used without its scheme; and the random values' source is unmeasured, while the probe's AES-KW leg shows the module performing the AES-KW calls ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-aes-kw-row-behind-the-rotations-wrap)).
   It makes no claim of conformance to section 8.2.3.1; the sentence is in [Proposed spec and documentation changes](#proposed-spec-and-documentation-changes).
   How the project could use an approved key-agreement scheme, which would close those gaps, is research the maintainer asked for, outside this design.
   - (a) State it beside the rotation sentence: the wrapping keys come from the same session key, and the next secret from the same key-agreement output, whose scheme the row already disclaims.
   - (b) Say nothing about SP 800-57 section 8.2.3 in the row, leaving the build to meet a requirement no reader is shown.
   - (c) Recast key establishment as an approved scheme, which [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md#the-decision) weighed and set aside, and the research above looks at again.
4. **Whether a predictable initiator may expose the next secret.**
   With the next secret derived from the key-agreement output and the initiator's value alone, an outsider who can predict the initiator's randomness computes every next secret, which the shipped derivation does not allow.
   Decided: (c), on the maintainer's ruling, "OK, do option 3 then.", with `N_R` placed in terms message 2 rather than a frame of its own by a later ruling of the maintainer; built in core stage 2, and [The construction](#the-construction) and [What it does to the one-sided rotation](#what-it-does-to-the-one-sided-rotation) are written for it.
   - (a) Accept it and state it.
   - (b) A responder value `N_R` in key-exchange message 2, wrapped under the session key, with the next secret derived over both values, the Noise pattern. A one-sided randomness failure then stays harmless, but the responder sends keying material under a key it has not yet confirmed, against the literal reading of SP 800-57 section 8.1.5.2.3 the construction relies on.
   - (c) `N_R` sent after key confirmation, in terms message 2, with the next secret derived over both parties' values. This is both compliant and robust, and changes when each side stores the next secret, so the one-sided heal is re-derived for it.
5. **How the two random values are drawn.**
   The SC-12 row says every cryptographic operation the key schedule makes is a `crypto.subtle` call, and `crypto.getRandomValues` is not one.
   The work is the same either way, and the user never meets the choice.
   - (a) Draw each value with `crypto.subtle.generateKey` as an extractable 256-bit HMAC key, which `wrapKey` takes as it is, and export its raw bytes for the derivation. Recommended, for the maintainer to ratify: the row's sentence stays true, and the value has to be a `CryptoKey` for the wrap anyway ([What was measured](#what-was-measured)).
   - (b) Draw each value with `crypto.getRandomValues`, as an invitation token is drawn, import it as a key to wrap it, and have the row name that call as the one source outside `crypto.subtle`.

   Either way the probe leg asks whether the call reaches the module's DRBG, and no document says the values come from the module until it shows that.
6. **Whether the security review runs per stage or once.**
   - (a) Per stage: core stages 2 and 3 each have a required review, stage 2's naming the terms exchange in its scope, since part of its change is there, and stage 3's reading the combined handshake. Recommended, for the maintainer to ratify: each stage changes the handshake and is a pull request of its own, so each review reads a diff of reviewable size, and stage 3's keeps the whole handshake in view.
   - (b) Once, over the two stages stacked, as one protocol review of the wraps, the responder value, the next secret, the second tag, the proofs and the notice.
7. **When each side stores the next secret, with `N_R` in terms message 2.**
   Decided: (b), on the maintainer's ruling once the trade-offs below were set out: "OK, all of those seem fine to me. Let's proceed using it."
   - (a) Responder first: the responder stores, keeping `X`, before it sends terms message 2, and the initiator stores on reading it. A run the initiator refuses at terms message 2 still rotates the responder, a lost terms message 2 leaves the responder ahead, and on `webrtc` the inviter registers under two ids per attempt.
   - (b) Initiator first, as [What it does to the one-sided rotation](#what-it-does-to-the-one-sided-rotation) sets out: no refused run rotates either side, so a missing or malformed responder value ends the run with no next secret stored on either side; a lost `proceed` leaves the initiator ahead, the shape a lost message 3 leaves today; on `webrtc` the acceptor offers to two ids; and the initiator's drop of `X` is a step outside `exchangeTerms`.
8. **Whether `N_R` keeps its own AES-KW wrap inside terms message 2.**
   Decided: kept, on the ruling of question 3: the row's sentence that each value travels under AES-KW holds only with the wrap, since the AEAD's AES-GCM with a caller-supplied IV is a non-approved service on certificate 5438 ([COMPLIANCE.md](../COMPLIANCE.md#fips-140)).
   Against a network attacker the wrap adds nothing the AEAD layer does not give ([The construction](#the-construction)); it costs one key derivation and one wrap per run, and 54 characters in the frame.

Two choices in the design rest on no ruling and are proposed with it: the next secret's derivation over the handshake's whole key-agreement output `ka`, rather than `dh` alone, came from a review panel's side recommendation and is unratified; and the responder's abort on a failure of message 3 ([The construction](#the-construction)) is an agent's choice.
