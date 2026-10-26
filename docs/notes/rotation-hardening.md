---
title: "Rotation Hardening Design"
---

# Rotation hardening: recognizing a stale copy, and healing a one-sided rotation

_Status: design only, not built, and proposed for the maintainer's ratification; two choices are left open ([Open questions](#open-questions)).
Nothing here is normative.
The rotation and the key exchange are specified in [PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation), the browser record in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-secret-is-a-linear-resource), the key file in [EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-key-file-schema), and the threat model this changes in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).
The spec changes the design implies are listed in [Proposed spec and documentation changes](#proposed-spec-and-documentation-changes), to be made with the stage that builds each.
See [docs/notes/README.md](README.md)._

## The two problems

A recurring exchange authenticates on a shared secret that both parties replace after every completed key exchange.
Two failures leave the parties on different secrets, and both are designed here as one change because both change the key exchange and the same threat model.

- **A stale copy.**
  A restored backup, an export, a browser-profile or VM snapshot, or a duplicated key file brings back the secret it captured.
  If the partnership has rotated past that secret, the copy's next run fails.
  Today nothing records which secrets came before, so neither party can tell a superseded copy from a stranger ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).
- **A one-sided rotation.**
  Both parties derive the next secret at the end of the key exchange, and each stores it before it sends anything else.
  When one side's store fails, or the process stops between the handshake and the store, that side keeps the old secret and the other has the new one ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering); `authenticateRun` in `apps/cli/src/protocol.ts`).
  A secret that expires during the key exchange has the same effect: that side refuses the rotated secret and the other stores it ([CLI.md](../CLI.md#out-of-sync-tokens)).
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
4. **A frame from the peer after the handshake proves the peer stored its rotated secret.**
   The CLI writes the rotated key file, fsync-durable, before it wraps the connection and sends any data frame (`authenticateRun` in `apps/cli/src/protocol.ts`), and the browser awaits its rotation write before it begins the data exchange ([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering)).
   Every channel requests the application-layer encryption, and the negotiated decision is the OR of both requests ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Request-encryption flag), so every frame after the handshake is one the AEAD layer opens, and only a holder of the session key can make one.
   A one-shot web party stores nothing, but it either saves the rotated secret when the operator keeps the exchange or has no secret at all ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)), so its frame proves the same for any later run.
   The proof is good only within the durability limits each store states: a committed browser write survives a renderer crash but not necessarily an OS crash ([managed-exchange-design.md](managed-exchange-design.md#the-durability-limit)).

## Part 1: healing a one-sided rotation

### Keeping the previous secret until the partner confirms

The rotation write keeps the secret the handshake used as the **previous secret**, beside the rotated one.
The run drops the previous secret as soon as the AEAD layer opens the partner's first frame after the handshake, in a write made before the run ends.
By fact 4 that frame proves the partner stored the rotated secret, so the previous secret is no longer needed.

The previous secret therefore stays at rest only after a run that ended between its handshake and the partner's first frame.
That window is the partner's own rotation write plus one transit, and it is exactly the window a one-sided rotation comes from.
In every completed run, and every run that failed after the partner's first frame, the previous secret is gone before the run ends.
The cost is one more durable write per run: an atomic key-file write on the command line, and in the browser a strict-durability record write, which a completed run can make together with its success stamp.

Rules that bound it:

- **Its life is one run.**
  The next run that completes a handshake, under either secret, replaces it with the secret that run used, which that run's own confirmation then drops.
  Only a run cut the same way keeps a previous secret past its end.
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

The rotation-in-flight marker stays as it is.
It says this side may be behind; a previous secret says this side may be ahead.

### Which secret a handshake uses

A party holds one or two candidate secrets: the current one, and a previous one while a rotation is unconfirmed.
The key exchange picks the newest secret both parties hold, with no message added:

- **Message 2 has a second confirmation tag**, computed under the responder's previous secret, or under a random value when it holds none.
  The responder always computes both key schedules, so its work and the message's shape do not depend on whether it holds a previous secret.
  The tags are in a fixed order, current first.
- **The initiator trial-verifies** its current secret, then its previous one, against both tags, in constant time, and completes under the first that verifies.
  It always computes both schedules, for the same reason.
- **Message 3 states whether the initiator used its previous secret**, bound under the initiator's confirmation tag so a changed flag fails the handshake.
  The responder verifies message 3 against both of its schedules and learns which of its own secrets matched.

Each side so learns whether either side used a previous secret: the initiator from which of the responder's tags verified, the responder from message 3's flag and from which of its own schedules matched.
A tag under a secret the other side does not hold verifies nothing, so a party with neither secret learns nothing it could not learn today.

The run that completes under a previous secret rotates as any run does: both sides store the rotated secret, and each keeps the secret it used as its previous one until the partner confirms.
The ahead side's unshared current secret is discarded, and its history gets no new verifier from this rotation: the secret it used is already in the list from the run that was cut, and the secret it discards was never shared.
The behind side appends the verifier of the secret it retires, the same one, so both lists hold the same verifiers in the same order.

### Meeting on WebRTC

On `webrtc` the ahead side must also be found at the peer ids of its previous secret, because the behind side knows no others (fact 1).
While a party holds a previous secret, each connection attempt covers both:

- **The inviter**, which listens, registers under the inviter peer id of both secrets.
- **The acceptor**, which dials, offers to the inviter peer id of its current secret, and to that of its previous secret when the broker reports the first unavailable.
  An inviter holding a previous secret has registered both ids, so the acceptor opens one connection, never two.

Covering both in every attempt, rather than alternating between them, means two parties that both hold a previous secret cannot keep missing each other in step.
The cost is a second broker registration or a second offer per attempt, in the unconfirmed state only.
The coordination server can see that the two ids belong to one party, which links the two rotations of that partnership to it ([PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) states what it can read today).

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
Whether ICE forms a path from one side's relayed candidate alone is the relay's and the browser's behavior, not measured here; Stage 2 measures it against the reference relay before this limit is stated as a fact.
Where it does not form, the run reports a no-show and re-invite recovers, as today.

### What the operator is told

A heal is always reported, on both sides, so that it cannot hide a copy running elsewhere.
Drafts, for the UX review of the stages that show them:

- **The ahead side:** "The last run stopped before your partner saved the new secret, so this run used the one before it, and both sides now have a new secret. If neither of you had a run stop partway, ask your partner whether they ran this exchange from another copy."
- **The behind side:** "Your partner still had the secret from before your last run stopped, so this run used it, and both sides now have a new secret. If no run of yours stopped partway, check whether this exchange also runs from another copy."

On the command line the run exits 0 with that warning on the terminal and the event stream.
In the browser it is a note on the run.

### What does not heal

- A behind side whose secret expired, including during the key exchange: it refuses before connecting ([PROTOCOL.md](../spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory)).
- An ahead side that no longer has the previous secret: its browser store was evicted, the exchange was moved by export, or it dropped the secret on the partner's frame and the partner's rotation write was then lost to an OS crash or power loss.
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

When no secret matches, the two sides exchange **history proofs**: a MAC under the verifier of the sender's own current secret, over both ephemeral shares of this handshake.
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
The current side can still tell it, authenticated, because it holds the verifier of the stale side's secret: on a match it sends a **behind notice**, the count *k* under a MAC by that verifier over both shares, which the stale side checks with the verifier of its own current secret.
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
| `webrtc`, browser | Not detected across the wire. The restored copy's import marker beside its no-shows is reported as a possibly stale restore; the current side sees no-shows. A copy exactly one rotation behind a side still holding its previous secret heals instead. | Heals at the next run: the ahead side registers or offers under both secrets' ids; both sides are told. Subject to the relay limit. |
| `webrtc`, command line | Not detected across the wire. Both sides see no-shows; the CLI has no import marker, so its no-show message names a restored or copied key file among the causes. | As for the browser. |

## The problems, answered

- **A counter cannot fire on WebRTC.** Correct; the design keeps no counter. On `webrtc` a stale copy is reported locally (the import marker in the browser, the no-show message on the command line) and not across the wire, a stated limit unless the maintainer chooses otherwise ([question 1](#open-questions)). The one-sided rotation does heal there, through the two-id rendezvous.
- **A counter compared before authentication is advisory.** Replaced by the history proof, which only a holder of the retired secret or of a later copy can make, and by the behind notice, which only a holder of that secret's verifier can make. The proof bounds how old the peer's copy is and the notice shows that the sender's copy is newer; only the notice's count is the sender's statement, and the stale side's message does not show it.
- **The previous secret lengthens a captured copy's live window.** Bounded to one run, and only after a run cut between its handshake and the partner's first frame. Where the partner is behind, the previous secret is the partner's current one and live anyway; where it is not, a captured copy of it stays live until the next run instead of the last. An attacker who can cut a run can extend a captured secret by that one run, not indefinitely, since the next completed handshake retires it.
- **The previous secret can hide a stale restore or a self-fork.** A copy restored from before a completed run is not healed: the previous secret was dropped when that run's partner frame arrived, and the history proof reports the copy instead. The remaining case, a copy exactly one rotation behind a run that was itself cut, is indistinguishable from the failure the window heals, and the heal is reported on both sides with the question that exposes a second copy.
- **The registrar has replaced the previous relay key.** The relay credential is decoupled from the handshake secret, and a registration the cut run left pending is retried under the previous secret's key, so each side's own relay works; the behind side's allocation on the ahead side's relay is the stated limit.
- **A wire change pre-release.** Every change is to the key exchange's existing three messages and its abort. The protocol-version tag is reserved for a suite change, and the strict message schemas fail a mismatched build closed at parse ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Protocol-version tag), so before the first release the change takes no version decision; after it, the same change would strand every deployed peer with a parse failure.

## What changes in the threat model

- **A secret can authenticate a second handshake.** Today each secret authenticates one completed handshake and is retired ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#token-format-and-entropy) states it is never reused). With the previous secret, a secret whose run was cut before the partner's first frame authenticates one more, the heal, and one more again for each heal cut the same way. An organization whose rotation policy forbids that is the subject of [question 2](#open-questions).
- **A superseded secret is at rest** on the device that ran a cut run, for up to one run, under the same custody as the current secret.
- **Frames before authentication say more.** Message 2 always has a second tag and a history proof; an abort can have a proof and a notice. None verifies for a party with no copy. Message 2's additions are sent on every handshake and the abort's proof on every failed one, so neither tells an outcome; the notice goes only to a proven holder of an old copy.
- **A later holder of a secret can pick out the handshakes that used it.** The history proof is a MAC under a key derived from the secret alone, over the two public shares, and so is a notice under a retired secret's verifier. Anyone who later obtains a secret, or any later copy of the record, key file or export, which holds its verifier, can check recorded handshake frames and tell which ones used that secret, tying them to this partnership and ordering them. On `sftp` and `filedrop` the shared folder's operator can record those frames. The confirmation tags allow no such check, since their key derives from the chaining key, which includes the ECDH output ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), Key schedule). The proof cannot be keyed from the chaining key instead: the pre-shared secret enters it at the first step, before the ECDH output, so two parties on different secrets share no chaining-key value.
- **The coordination server can link two rotations** of a partnership in the unconfirmed state, from one party's two registrations or offers.

## Proposed spec and documentation changes

Each change lands with the stage that builds it, so the spec keeps describing the code.

- **[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange)**, P-256 authenticated key exchange: the second tag and the history proof in message 2, the flag under message 3's tag, the abort's proof and notice, the trial verification and the constant work on both sides, the history-verifier label family in the label space, and regenerated vectors. Shared-secret rotation: the previous secret, its confirmation, and the history append. WebRTC rendezvous peer-id derivation: both secrets' ids while a previous secret is held. Relay credential derivation, Registering the rotated relay key, and Enrolling at a default relay: the relay rules in [The relay](#the-relay).
- **[EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#the-key-file-schema)**, the key file: the previous secret and its `expires`, the history, the rotation-in-flight marker's "no previous secret is kept", and the key the pending relay registration's retry is signed under.
- **[MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-secret-is-a-linear-resource)**: the linear-resource rule that neither party keeps the old secret, the single-owner invariant's "there is no grace window", the persist-before-success steps (the previous secret stored, the confirmation write), the rotation-in-flight marker, the key the pending relay registration's retry is signed under, the exception to derived-never-stored, the export artifact (history in, previous secret out) and its no-anti-rollback caveat, the import marker read beside a no-show, and the replace question stating an order.
- **[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-exchange-authentication)**: the one-sided write paragraph, the never-reused sentence, the compromise response's "valid until the next successful exchange", the primary controls, and the rollback section, each per [What changes in the threat model](#what-changes-in-the-threat-model).
- **[CLI.md](../CLI.md#out-of-sync-tokens)**, Out-of-sync tokens, and [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#desync-detection-and-recovery): the heal, its message, and when re-invite is still the recovery.
- **[managed-exchange-design.md](managed-exchange-design.md#the-grace-window)**: the grace window and single-device ownership sections point here.

## The build split and its reviews

Three items, the first ahead of the other two, which are independent of each other.

1. **Core: the key exchange and the history.**
   The message changes, the trial verification, the history verifier and its proofs and notice, the label and its label-space check, the regenerated key-exchange vectors, the key-file schema fields, and the relay-credential rule.
   `authenticateConnection` takes the previous secret and the history and returns which secret each side used and what the peer proved.
   Both apps adapt their call sites only, passing no previous secret and an empty history, so behavior is unchanged while the wire shape is new.
   **Security review: required.** It changes the handshake and adds frames read before authentication; it is the one protocol review, and covers both mechanisms.
2. **Command line.**
   The key file's previous secret, its rotation and confirmation writes, the history append and pruning, both ids in the WebRTC attempt cycle, the relay registration and enrollment rules, the measurement of one-sided relay allocation against the reference relay, and the messages and exit codes.
   It tests the pending registration's retry under the previous secret's relay key against a registrar still holding that key and against one already holding the current key.
   **Security review: required**, scoped to the superseded secret at rest and the second rendezvous registration, not the protocol.
3. **Web application.**
   The record's previous secret and history, under the run+rotate lock with strict-durability writes; exports omitting the previous secret and including the history; both ids in the browser rendezvous and the default-relay enrollment; the heal notes; the import marker beside a no-show; the import's order.
   It tests the managed run's pending-registration retry under the previous secret's relay key as item 2 does.
   **Security review: required**, scoped as for item 2, plus a UX review for the notes and the replace question.

Each item lands its own spec changes, with its wording-change list, and the `SECURITY_DESIGN.md` changes it makes true.

## Open questions

These are the maintainer's to decide; each gives a recommendation.

1. **Recognizing a stale copy on WebRTC.**
   The design reports it only locally there.
   - (a) Keep that as a stated limit. Recommended: the browser's restored copies are covered by the import marker beside a no-show, and the uncovered case, a command-line key file restored on WebRTC, still recovers by re-invite.
   - (b) Derive the rendezvous from a value fixed at setup rather than from the current secret, so a stale copy reaches the handshake and the history proof fires. The coordination server could then link every run of a partnership by its ids, and any holder of any old copy could take the inviter's id first and keep the partner out until a re-invite.
   - (c) Have the current side also register under the ids of its last few retired secrets. Each adds a registration per attempt and links those rotations at the server.
2. **Whether the previous secret is always accepted.**
   - (a) Always, with no setting. Recommended: it is held only after a cut run and for one run, and every heal is reported.
   - (b) On by default, with a per-exchange setting to refuse it, for an organization whose rotation policy forbids a second use of a credential.
   - (c) Off by default, with a setting to turn it on.
