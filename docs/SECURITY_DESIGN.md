---
title: "Alcove Security Design"
review_owner: "Alcove maintainers"
last_reviewed: "2026-11-01"
---

# Alcove security

<!-- Adding to this doc? Keep it conceptual and operational. Constant values, byte/wire
layouts, algorithm steps, and their rationale belong in the spec tier: see
docs/spec/README.md, "Where does my content go?". -->

This is the security overview for security teams and compliance officers. It covers the threat model, the authentication design, and the channel-security controls at the level of what each protects against. It does not specify how they are built.

## Start here

This section covers what Alcove does, what it protects and from whom, and what stays with the deploying agency. The regulatory framings -- the NIST SP 800-53 control mapping, the FIPS 140 position, and the sector-specific readings -- are in [COMPLIANCE.md](COMPLIANCE.md), which also answers a reviewer's usual questions in [one table](COMPLIANCE.md#where-a-reviewers-usual-questions-are-answered).

### What Alcove does

Two agencies operating under a signed data sharing agreement each hold a file of records about people. Alcove tells each agency which of those people appear in both files, and hands over -- for the matched people only -- the columns each agency designated in advance for disclosure. Neither agency sends the other its file, and neither learns anything about the records that did not match.

Each agency runs the software itself, in a container on its own machine or in its own browser. There is no service in the middle holding the data: what the two parties meet over is an SFTP server, a shared folder, or a direct browser-to-browser connection, and the exchange is designed so that whoever operates that meeting point cannot read it ([SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md)).

### What it protects, and from whom

| Who | What they would otherwise see | What prevents it |
|-----|------------------------------|------------------|
| The partner agency | Your whole file, including the records that did not match | Records are matched in encrypted form, so the identifiers you match on are never sent. The partner receives the overlap and the payload columns you designated ([Private set intersection](#private-set-intersection), [Data handling](#data-handling)) |
| The SFTP server operator or shared-folder administrator | Every file the exchange writes into the shared folder | A recurring exchange wraps its frames in application-layer AES-256-GCM keyed from the key exchange, so the administrator sees ciphertext; the key-exchange handshake frames that establish that key are among the stated exceptions ([Channel security](#channel-security)). A quick exchange has no session key and rests on that administrator's access controls instead |
| Anyone on the network path | Traffic in transit | The channel's own encryption beneath that wrap: SSH for SFTP, DTLS for a WebRTC connection, and for a network-mounted share whatever the operator configures for it ([Channel security](#channel-security)) |
| The coordination server a WebRTC exchange uses | The exchange it introduces the two parties for | It relays the signaling that sets up the connection. Every WebRTC exchange is wrapped in application-layer AES-256-GCM keyed by the authenticated key exchange, which the server cannot complete, so it sees only ciphertext envelopes ([Channel security](#channel-security)) |
| Someone posing as your partner | An exchange conducted with them instead | A recurring exchange proves both parties hold a secret established out of band, before any data moves, and rotates it afterwards. Authentication is a hard gate: if it fails, nothing is exchanged ([Authentication](#authentication)) |
| Whoever can read your disks and backups | The key file, the signing identity, the exchange records, and the result | Nothing in this software beyond owner-only file permissions. At-rest confidentiality is the agency's storage or full-disk encryption ([Key file security](#key-file-security)) |

**What it does not protect against:**

- **The partner learns the intersection, and each party's dataset size.** The guarantee is about the records that did not match, and it is only as strong as the linkage keys the parties agree on: a key built from too little PII is open to a differencing or brute-force attack, so both parties review the keys before agreeing to them ([Threat model](#threat-model)).
- **A quick exchange has no shared secret**, so it has no application-layer encryption and no key-exchange authentication. Trust rests on the transport and on whoever administers the server or shared folder ([Transport-layer authentication](#transport-layer-authentication)).
- **Code running where the exchange runs.** An attacker who can run code on the operator's machine, or inside the web application's browser origin, reads what the operator reads ([Hosted at-rest threat model for managed exchanges](#hosted-at-rest-threat-model-for-managed-exchanges), [Egress hardening and its limits](#egress-hardening-and-its-limits)).
- **The host that serves the hosted web application.** Cloudflare Pages delivers the code each browser runs, so it is in the trust path. Each release publishes a signed manifest of the files it deploys, to compare against what the site serves while it serves that release; a push to `main` between releases deploys a build no manifest lists ([RELEASES.md](RELEASES.md#hosted-web-application)). A party who cannot trust the host to deliver that code runs the container instead ([DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment)).

### What the deploying agency is responsible for

Everything around the exchange: at-rest confidentiality, the environment it runs in, the credentials sent to the partner, retention and disposition, and the decision to disclose. [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md) states the split area by area, separately for the container deployment and the hosted web application.

### How to read the rest of this document

[Overview](#overview) and [Private set intersection](#private-set-intersection) give the four layers and the primitive. [Threat model](#threat-model) covers who is assumed to do what and the trust boundaries. [Authentication](#authentication) and [Key file security](#key-file-security) cover the secret's lifecycle. [Channel security](#channel-security) covers the application-layer encryption. The browser's at-rest model, receipt signing, canonical encoding, and data handling follow.

Elsewhere: the PSI algorithms and wire-level key exchange in [PROTOCOL.md](spec/PROTOCOL.md); every cryptographic primitive in one table, with its library, FIPS position, quantum exposure, and pinning check, in [COMPLIANCE.md](COMPLIANCE.md#cryptographic-algorithm-inventory); the channel-security constructions in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#contents); the display escape and redaction in [DISPLAY_ESCAPE.md](spec/DISPLAY_ESCAPE.md) and [DISPLAY_REDACTION.md](spec/DISPLAY_REDACTION.md); the parsed-input and transform bounds in [PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md), [TRANSFORM_REGEX_DIALECT.md](spec/TRANSFORM_REGEX_DIALECT.md), and [TRANSFORM_PARAMETER_BOUNDS.md](spec/TRANSFORM_PARAMETER_BOUNDS.md); the network channels in [COMMUNICATION.md](COMMUNICATION.md); CLI authentication configuration in [CLI.md](CLI.md).

## Overview

Alcove protects an exchange with four layers.

1. **The PSI protocol protects the data itself.** Records are matched in encrypted form: each party encrypts its own linkage keys under an ephemeral key it never shares, and the protocol combines the two parties' keys so that neither side can recover the other's underlying values. Both learn only which records they hold in common. This holds regardless of which channel the traffic runs over. See [Private set intersection](#private-set-intersection).

2. **Key-exchange authentication proves you are talking to the right partner.** For recurring exchanges the two parties hold a shared secret, established once out of band, and prove to each other that they hold it without sending it over the wire. The secret rotates after every successful exchange, so it is never reused. Authentication is a hard gate: if it fails, no data is exchanged. See [Authentication](#authentication).

3. **Transport encryption protects the data in transit.** An SSH/SFTP connection or a WebRTC (DTLS) link encrypts traffic on the network; a network-mounted share is protected by whatever transport and access controls the operator configures for it. For quick exchanges, which have no shared secret, this transport layer is the only protection, so trust rests on whoever administers the server or share. See [Channel security](#channel-security).

4. **Application-layer encryption protects from server snooping.** An additional layer, keyed from the key-exchange session, wraps the connection in authenticated encryption with associated data (AEAD), so every PSI frame is encrypted end to end and even the operator of an SFTP server or shared drive sees ciphertext rather than the exchange's contents. The key-exchange handshake frames that establish that key precede the wrap and are among the stated exceptions. When it applies is stated under [Channel security](#channel-security).

Every control in this document that is net-new security behavior is subject to the explicit security review required by [CONTRIBUTING](../CONTRIBUTING.md#dependency-policy) before release.

## Private set intersection

Private set intersection (PSI) lets two parties compute the records they have in common while revealing nothing about the records they do not.

It uses a layered, order-independent ("commutative") encryption. Each party holds an ephemeral key, generated for the exchange and never shared. Each side encrypts its own linkage keys under its own key, and the protocol applies the other party's key as a second layer. Two values that started equal stay equal once both keys are applied, so the parties recognize shared records by comparing encrypted forms alone. Neither side can strip the other's key to recover a plaintext value, and records outside the intersection are never revealed.

Alcove uses a lightly modified build of OpenMined's [PSI](https://github.com/OpenMined/PSI), which layers over Google's Private Join and Compute. Its curve arithmetic and the randomness behind the ephemeral keys come from BoringSSL, linked statically into both the WebAssembly module the browser runs and the native addon the CLI prefers, so no OpenSSL provider a deployment configures serves it ([FIPS 140](COMPLIANCE.md#fips-140)). A cardinality-only variant, PSI-C, reports the size of the overlap and no identifier ([Count-only exchanges and the pre-agreement assumption](#count-only-exchanges-and-the-pre-agreement-assumption)).

Two properties of the primitive are not hidden:

- **Set sizes are revealed.** The protocol exchanges each party's dataset size as envelope metadata.
- **The result is only as private as the linkage keys.** Because each party learns the linkage key for every shared member, a weak key (for example one built from a single identifier) can leak membership through a differencing or brute-force attack. Combining several PII elements into each key is what keeps "you learn only the overlap" a meaningful guarantee.

The algorithm is specified in [PROTOCOL.md](spec/PROTOCOL.md#psi-base-function).

## Threat model

Alcove is designed for partner agencies with signed data-sharing agreements. The primary goal is to prevent either party from learning anything about the other's data beyond the mapping between shared members. The model is honest-but-curious: it assumes partners are not actively tampering with inputs, but that minimizing what is disclosed is still worthwhile.

Each use of the base PSI function reveals information to each party. For PSI, this is the linkage key of each shared member; for PSI-C, the cardinality of the overlap. Linkage keys can therefore be chosen to reveal sensitive information through a differencing attack, so both parties must review the linkage keys before agreeing to use them.

Within the input-choice threat, a party can attempt a membership attack using crafted inputs. A linkage key built only from Social Security numbers, for example, would be easy to brute-force. Keys should combine several elements of personally identifiable information (PII). Even then a membership attack is possible, but only against a target whose PII is already known.

The protocol also reveals each party's dataset size.

When both parties expect output, the sender/receiver assignment is a function of the record counts the parties exchange (see [PROTOCOL.md](spec/PROTOCOL.md#role-resolution-and-work-minimization)), and a reported count is not bound to a party's actual dataset. Under the single-pass strategy the sender discloses more than the receiver: its full per-key duplicate structure. A party that under-reports its count can therefore steer itself into the receiver role and its partner into the sender role. This goes a step beyond honest-but-curious, and it is accepted rather than prevented. Its effect is bounded: single-pass is a strategy both parties agree to before any data is exchanged, so the manipulation only shifts which consenting party bears the sender-side disclosure, never whether it happens. A both-output cascade has no such asymmetry, and a one-sided-output exchange is unaffected because the receiver is fixed by entitlement. The partner cannot cheaply detect it.

When public services facilitate scheduled exchanges, some metadata is leaked, such as who is conducting the exchange and when ([PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe)). Parties can stand up their own services.

### Count-only exchanges and the pre-agreement assumption

The count-only algorithm (PSI-C) reports the size of the overlap across every agreed key and no identifier, with three qualifications. PSI-C is intended only for research.

**The party computing the count learns more than the count.** Its software, not its operator, learns how many records matched on each key and how many matched on each combination of keys. From which keys its own records have values for, a match narrows to the few of its own records that could have made it, and sometimes to one, which tells it that its partner holds that record. This needs no change to the software or the input, and it is accepted. [PROTOCOL.md](spec/PROTOCOL.md#what-each-party-learns-and-on-what-basis) states each part and its basis.

**The property holds only under the honest-but-curious model.** A party that receives the count also chooses what goes into its own side of the exchange. A set built as one live candidate padded with values the partner cannot hold turns the count into a yes-or-no answer about that candidate, and two runs whose sets differ in one value do the same by subtraction. Cheaper still, the party computing the count can leave a different set of fields blank on each of its records and read, from one run, which of its matched records the partner holds. Nothing on the wire distinguishes a crafted set from a genuine one. Like the record-count manipulation above, all three are accepted rather than prevented. The mechanism, and what each party may and may not claim as a result, are specified in [PROTOCOL.md](spec/PROTOCOL.md#threat-model-scope-of-the-count-only-claim).

**PSI-C runs before the agreement this model assumes.** It is the algorithm used to establish the business case for a data-sharing agreement. Weigh a count-only exchange as a disclosure in its own right, against the partner's incentives at that point.

### Configuration-file trust boundary

An `alcove.yaml` written with `@path` references to credentials rather than the credentials themselves holds no secrets and is safe to commit or send to a partner; a command that saves a credential typed as a literal value warns, naming the field to move into a file, and writes the file owner-only. That protects the file's author, not whoever later runs it. Loading a configuration you did not author is equivalent to running its referenced files as your own credentials: when an exchange runs, each `@path` reference is read from local disk with your privileges, and the resolved credential (in the CLI today, the SFTP password) is sent to the host the configuration names. A substituted configuration can therefore turn such a reference into a read of an arbitrary local file, a private key for instance, delivered to a host the author chose. Reaching this requires loading a wholesale attacker-authored configuration and running an exchange against it; it cannot arrive through an invitation, which holds no credential (see [Invitation contents and confidentiality](#invitation-contents-and-confidentiality)). The reference syntax is in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#file-references), and how to treat a configuration from an untrusted source is in [CLI.md](CLI.md#configuration).

### Single-party console trust boundary

The console is a container that drives the party's own `alcove` exchange behind a server-side job API, so an operator runs a single exchange (config, secret, input, and results in one mounted working folder) without invoking the CLI by hand. It serves one party, inside that party's trust boundary, and is never a shared rendezvous between the two parties, who still meet only over the exchange channel itself. The invariant is single-operator:

- **Dark unless turned on.** The job API does nothing unless the deployment is a console build with a data root configured; the hosted `apps/web` deployment serves every job route disabled (`404`). Outbound SFTP exists only when the operator authors an SFTP connection for the single exchange.
- **One operator, no tenants.** The API has no per-request authentication and no per-tenant isolation. Its reach is bounded by the deployment -- container isolation, the publish binding, and the host and agency firewall -- not by an app-level check.
- **One app-level check: a browser-CSRF defense.** The shared route gate refuses (`403`) a request a browser marks as cross-origin, by metadata a page cannot forge, so a page the operator merely visits cannot drive the loopback API from their browser. It also requires a loopback `Host`, which closes browser-delivered DNS rebinding. A non-browser client on loopback is unaffected. The mechanism is in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#browser-csrf-gate).
- **The server composes every CLI input.** The operator submits a typed, schema-validated intent, and the server builds every connection path, directory, and credential file from it. Only schema-validated values from the run intent and the authored connection, in fixed flag positions (such as `--peer-id=`, `--server-username=`, and `--outbound-path=`), reach the CLI as arguments, so a run can only reach the one server the operator authored.
- **State is memory-only.** Job state lives in server memory and is never persisted; a restart forgets it, cancelling any in-flight run. The completed job's working directory survives and still holds that job's key file and config -- a finished SFTP job's directory pairs the current shared secret with a partner-reachable rendezvous locator, so delete it promptly after retrieving the result.
- **Mounted directories are trusted local data.** The only untrusted input is the remote partner's material arriving over the rendezvous channel, which the exchange protocol protects (see [Channel security](#channel-security)).

**What violates the invariant** is any deployment that lets a second party reach the API. Publishing the port beyond host loopback, or fronting it with a reverse proxy that routes a second party to it, does exactly that, and because the API is unauthenticated any such exposure re-exposes it unauthenticated. The publish binding is in [CONSOLE.md](CONSOLE.md#reachable-only-where-you-publish-it) and the mount guidance in [CONSOLE.md](CONSOLE.md#turning-the-job-api-on); the wire contract and validation rules are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

Two properties bound the console's SFTP connection:

- **The server's identity is pinned before any credential is presented.** The operator-authored connection holds the host key, so redirected egress or DNS tampering yields a refused connection rather than a disclosed credential. A probe can read the presented fingerprint for comparison, but it never replaces the operator's check ([CONSOLE.md](CONSOLE.md#authoring-the-sftp-connection)). The probe reads the key over the same network the exchange will use, so it cannot vouch for it. On a quick exchange, where the host key is the only protection, the console also requires the operator to confirm that they checked the fingerprint against a source other than this connection.
- **The stored connection holds only `@path` references**, resolved by the CLI subprocess: an inline value in a stored credential field is rejected outright. The paste fallback is the one credential that crosses the console's own loopback API; the server writes it to an owner-only file at a container-internal location wiped at every startup -- never to a job directory, the partner-synced rendezvous, or the composed config, which hold only the reference. This is accidental-exposure hygiene, not privilege separation: the subprocess runs as the same user, and a compromised server could read the mounted files directly. Referencing a credential file inside the mounted data root warns rather than refuses.

## Authentication

Before connecting, parties must confirm they are talking to the right partner. Recurring exchanges (see [User journey](DESIGN.md#user-journey)) use a pre-shared secret and an authenticated key exchange. Quick exchanges rely instead on transport-layer authentication.

### Recurring exchange authentication

To share a secret, one party generates a random 32-byte token and sends it to their partner over a trusted existing channel such as secure email. At the start of the exchange, both parties run an authenticated key exchange: an ephemeral P-256 Diffie-Hellman keyed together with the shared secret and an explicit mutual confirmation (see [Key-agreement design](#key-agreement-design)).

The shared secret rotates at the terms exchange that follows each successful handshake, before the data exchange begins. Both parties derive the same replacement token from the handshake's key agreement and a random value from each party, each value sent wrapped under a key from the session key, and each persists it before its next message (the CLI writes it to the key file): the initiator before it agrees to proceed, the responder once it reads that agreement. If that write fails on one side, the two parties can end up holding different tokens; the CLI initiator keeps the token the run used until the responder confirms its save, so the next run can use it ([Out-of-sync tokens](CLI.md#out-of-sync-tokens)). A failed data exchange still leaves both parties holding the rotated token, and they can retry without re-inviting. If a secret is lost after rotation, a new invitation regenerated from the existing configuration re-establishes one (see [Recovery](CLI.md#recovery)).

Invitation tokens have a bounded lifetime. The default is 1 hour if the inviter sets none; `--expires-in` overrides it up to a hard maximum of one year. Because the token rotates on first use, it is a one-time setup credential valid only between generation and acceptance (on the web as well: a one-shot exchange saved as a recurring one keeps the rotated secret, never the invitation's), and the inviter can withdraw it early (see [Online invitation](CLI.md#online-invitation) and [Abandoning a pending offline invitation](CLI.md#abandoning-a-pending-offline-invitation)). Withdrawing removes only the pending invitation's key material, not a configuration or a persistent recurring-exchange key; a leaked token needs the [Compromise response](#compromise-response). Replacement tokens from rotation have no expiration by default; [`token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) sets an inactivity limit (see [Shared secret rotation and inactivity limit](#shared-secret-rotation-and-inactivity-limit)).

In `alcove.yaml`, this is configured in a top-level `authentication` block, a sibling of the `signing` block rather than nested inside `connection` (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#authentication)). The shared secret and the pinned signing certificate (see [Receipt signing identities](#receipt-signing-identities)) live in separate files on separate schedules.

#### Token format and entropy

The shared secret is a 32-byte value. An invitation's secret is drawn from a CSPRNG and holds 256 bits of entropy. A rotated secret is derived from the key exchange: it holds the full 32-byte value against an outsider, and about 128 bits (the P-256 level) against a holder of the superseded secret, as the [Rotation tokens](spec/PROTOCOL.md#shared-secret-rotation) bullet states. Rotation derives the replacement from the key agreement and a fresh random value from each party, sent in messages the key exchange and the terms exchange already make, so it needs no extra round-trip, its value is independent of the secret it replaces, and the secret is never reused. The on-disk encoding and the rotation-derivation construction are in [PROTOCOL.md](spec/PROTOCOL.md#shared-secret-rotation).

#### Invitation contents and confidentiality

An invitation holds the linkage terms, the short-lived setup secret, and optionally a connection endpoint: a locator (a PeerJS signaling URL, an SFTP host and port, or a shared folder) telling the acceptor where to rendezvous. The invitation is confidential, so it may hold what both parties need to meet. A locator names a meeting point, not a way to authenticate at it. The token's encoding, its fields, and the checks a receiving party applies to it are specified in [INVITATION_TOKEN.md](spec/INVITATION_TOKEN.md).

A connection credential may be included only where its lifetime fits the invitation's acceptance window: the credential must stay valid for as long as the invitation can be accepted, which may be up to a year. What the current release accepts is narrower than that rule:

- **The endpoint is a locator only.** The schema rejects any other field -- a password, private key, key file, PeerJS API key, TURN username or credential, or server-identity material such as an SSH host-key fingerprint -- and an invitation with any such field is rejected when decoded. Each party configures its own connection credentials.
- **A WebRTC endpoint may name the inviter's relay, never its credential.** The locator may include the inviting party's TURN and STUN addresses and the address of a registrar that enrolls the exchange's relay key without a token. The accepting party lists the named relay beside any relay its own side controls, unless its own allowed relays leave it out, enrolls the relay key at the named registrar before it connects when it uses that relay ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)), and derives the relay credential from the shared secret on each run, as the inviter does. That key is the exchange's one relay key, so until it rotates, a registrar the invitation names holds a key the accepting party's own relay, where it has one, also accepts, and could rotate or revoke the party's own registrar entry for that exchange, given its exchange id. The accepting party sees the named relay and registrar before consenting.

On the web, the inviter derives the linkage terms from its own data file (see [COMMUNICATION.md](COMMUNICATION.md#web-invitation)). The terms reflect the inviter's column _shape_ (which default field types the file has) but never a row _value_. The file is read in the browser, and nothing from it leaves except in the exchange's encrypted messages to the partner ([Channel security](#channel-security)). Where the inviter discloses payload columns, the terms also embed those columns' _names_ as a data dictionary the recipient consents to; still no row value is included.

The decoder bounds the size and complexity of every attacker-influenceable invitation field, and each bound fails closed: per-field size caps (the 4-byte checksum detects transcription errors only), a linear-time regex dialect for partner-supplied transform patterns so a catastrophic-backtracking (ReDoS) pattern cannot hang the acceptor, caps on transform parameters, and a ceiling on each derived value, which bounds per-row work. The field, pattern, and parameter bounds apply before any row is processed, the derived-value ceiling at the first row that crosses it, and the exchange is refused rather than the value shortened. The bounds are in [PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds), [TRANSFORM_REGEX_DIALECT.md](spec/TRANSFORM_REGEX_DIALECT.md#transform-regex-linear-time-dialect), [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect), and [TRANSFORM_PARAMETER_BOUNDS.md](spec/TRANSFORM_PARAMETER_BOUNDS.md#unbounded-transform-parameter-rejection).

The invitation is confidential because it holds the setup secret an attacker needs to authenticate as you. In the web rendezvous flow both parties derive the coordination-server rendezvous id from that secret, so an attacker who obtains the invitation learns both, and could reach the meeting point first to attempt a man-in-the-middle before the intended partner arrives. The inviter's browser holds the secret in page memory for the tab's lifetime, the same in-origin exposure as the encoded invitation the page displays for copying; the secret is never sent to a backend.

The hosted inviter keeps the encoded invitation in the tab's session storage while the invitation can still be waited on, so a reload does not strand the partner:

- **What is kept.** The encoded invitation, with its secret, and this party's own settings for the run: its name, the file's name, column names and row count, and its cleaning and disclosure choices. Nothing the partner sent, and no row of the file.
- **When it is removed.** When the run completes or fails in a way the same invitation cannot retry, when the operator discards it or starts over, and when the invitation expires while the inviter screen is open. An invitation that expires after the operator has left that screen is removed the next time the app loads or the inviter screen opens. An expired invitation is never offered.
- **Exposure.** Session storage is scoped to the origin and the tab. Two browser behaviors may extend it, neither verified against a real browser: a browser that restores closed tabs or sessions may write session storage to disk, and a duplicated tab may receive a copy of it.

A hosted inviter that creates an invitation from the sample data also notes, in the browser's local storage, a SHA-256 digest of the encoded invitation and its expiry, so the accept screen in another tab offers the sample partner file for that invitation alone. The note holds neither the invitation nor its secret, and is dropped after that expiry, the next time this browser records a sample invitation or looks one up on the hosted build.

The acceptor's page takes the invitation out of the address as soon as it reads it:

- **The address.** The page reads the invitation from the URL fragment, which never reaches the server, then rewrites the current history entry without it. A second invitation opened in the same tab is read and cleared the same way, and replaces the first one's terms on screen along with everything chosen under them.
- **What is kept.** The encoded invitation, in the tab's session storage, so a reload of the screen opens the same invitation.
- **When it is removed.** When the operator leaves the acceptor screen, when the invitation is refused, when the exchange completes, and when it fails in a way no later run on the same invitation can follow (no retry, no return to the columns step, an invitation past its expiry, or an invitation with no expiry). The exposure is the in-origin, tab-scoped one stated for the inviter.

Holding the secret also grants relay access: a party's relay credential is derived from it, so while that exchange's relay key is registered with a relay, anyone holding the secret can use that relay ([PROTOCOL.md](spec/PROTOCOL.md#relay-credential-derivation)). On the hosted web application, a run that uses the project's relay enrolls that key at the project's registrar before it connects, and for the key's lifetime the project holds a key the party's own relay and registrar also accept ([PROTOCOL.md](spec/PROTOCOL.md#enrolling-at-a-default-relay)). When a run uses the project's relay is in [PRIVACY.md](../PRIVACY.md#hosted-web-application).

Forward invitations only over a trusted channel such as secure email, and treat a leaked invitation as a compromise by generating a fresh one (see [Recovery](CLI.md#recovery)) rather than reusing it.

#### Recurring web exchanges: single-use vs managed

The web application supports the same rotating shared secret the CLI does, and its two flows persist it differently.

A **one-shot** web exchange is single-use. It runs the authenticated key exchange and the terms exchange that rotates the secret exactly as the CLI does, holding the replacement in memory, then discards it unless the operator saves the completed exchange as a recurring one, which hands that rotated secret to a managed record.

A **managed** web exchange persists the rotated secret (with the standing terms and the credential-free rendezvous locator) in browser storage, so the same partnership can run again on a schedule (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md)). A record saved from a completed one-shot exchange starts at the next secret that exchange's terms exchange derived, never the invitation's setup secret. The managed lifecycle is security-review-gated, and its persistence has three properties: the secret is written durably before this party begins the data exchange (persist-before-success); the secret is a linear resource owned by a single device; and the browser at-rest posture is weaker than the CLI's on-disk key (see [Hosted at-rest threat model for managed exchanges](#hosted-at-rest-threat-model-for-managed-exchanges)). The record's shape is in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md).

Neither flow sends the secret, the terms, or the input data to a server. For the app's own code this holds by design and review; the limits against an injected script are under [Egress hardening and its limits](#egress-hardening-and-its-limits).

### Key-agreement design

Recurring exchanges derive their session key from an ephemeral P-256 key exchange, keyed together with the pre-shared secret and an explicit mutual confirmation. It provides forward secrecy and mutual authentication. A leaked secret permits active impersonation until it is rotated out, and forward secrecy means a recorded transcript stays confidential if the secret later leaks. An active adversary holding the current secret can run one handshake with each party and learn the next secret each stores, but each is derived over that leg's own key agreement, so the two parties store different secrets and the adversary must stay in the middle for every later run until a re-invite; a run it misses fails, or on WebRTC the parties do not meet. A password-authenticated key exchange (PAKE) is not used; the comparison is in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md).

The construction follows the Noise NNpsk0 pattern over P-256 -- a curve the Noise Protocol Framework does not itself specify, so what is followed is the pattern rather than a conformant instantiation -- with an added explicit, role-asymmetric key confirmation modelled on NIST SP 800-56A Rev. 3 without being conformant to it. Every cryptographic operation is a platform `crypto.subtle` call. The wire-level specification is in [PROTOCOL.md](spec/PROTOCOL.md#p-256-authenticated-key-exchange), and the decision record, with the alternatives weighed, is [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md). The CLI and the web application run the same handshake, and two peers on different version discriminants fail closed rather than negotiating.

The handshake accepts a previous secret, kept by the side that stored first in a run cut before its partner stored, so the next run can complete under it; and where no secret matches, each side sends a proof under its current secret that the other checks against its retired secrets, so a copy of this partnership that is a few rotations old is reported as such rather than as a generic failure ([PROTOCOL.md](spec/PROTOCOL.md#the-previous-secret)). So the frames sent before authentication carry more than the key-exchange shares; their contents are in [PROTOCOL.md](spec/PROTOCOL.md#the-rotation-history). None of them verifies for a party holding no copy of this partnership's secrets, and message 2's fields are sent on every handshake and the initiator's abort holds a proof only where no responder tag verified, when any abort already ends the run, so neither tells the outcome; a notice is addressed only to a party that proved it holds an old copy. A transport operator on SFTP or a synced folder can still read the notice and the previous-secret flag ([PROTOCOL.md](spec/PROTOCOL.md#p-256-authenticated-key-exchange), What a transport operator reads). The CLI keeps both in the key file. The previous secret is the one the initiator's run used, held until the responder's first frame after the terms exchange shows it saved the new secret, so on disk it outlives its run only when that run stopped before the frame arrived or its removal failed, and the next run that stores replaces or removes it ([EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md#the-previous-secret-and-the-rotation-history)). The history holds verifiers only, from which no secret or key is derived. The web application keeps neither, so a browser run offers the current secret alone and an older copy gets the generic failure.

The pre-shared secret is the baseline authentication anchor. A certificate-chain, authority-backed mode is left open by that same version discriminant (see [Pinned self-signed trust model](#pinned-self-signed-trust-model)). On approval:

- Approval at the algorithm-standard level is not module-certificate approval: for key establishment the standards are [SP 800-56A Rev. 3](https://doi.org/10.6028/NIST.SP.800-56Ar3) (the shared-secret computation and the Ephemeral Unified Model scheme), [SP 800-56C Rev. 2](https://doi.org/10.6028/NIST.SP.800-56Cr2) (the key derivation over the shared secret) and [SP 800-186](https://doi.org/10.6028/NIST.SP.800-186) (the curve), and for receipt signing [FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5) (ECDSA), which itself refers its curves to SP 800-186.
- Key establishment: P-256 ECDH and HKDF are on the approved-algorithm list of the FIPS 140-3 certificate this project targets, so where a validated module is configured it performs every cryptographic operation in the handshake. The schedule composed above those operations is attested by no certificate ([key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md)).
- Receipt signing: ECDSA over P-256 with SHA-256 is on that certificate's approved list and runs through `crypto.subtle`, while the certificate document, the domain separation, the per-signer binding, and the pin-before-signature check remain a composition no certificate attests ([receipt-signing-fips-boundary.md](notes/receipt-signing-fips-boundary.md)).

### Transport-layer authentication

Transport-layer authentication is the defined path for quick exchanges. It is not an option for recurring exchanges: the `exchange` command requires a key file (`.alcove.key`) and aborts if one is absent.

Quick exchanges rely on the transport: SSH for SFTP, and commonly SMB or krb5p for shared folders. WebRTC is not among them -- both parties derive the signaling ids they meet at from a shared secret, so the CLI refuses a secret-less webrtc run (exit 64) naming that cause. For an SFTP connection or a network-mounted shared folder, user and path management on the server limit who can listen in, which offloads trust to the server's administrator to keep the directory specific to the exchange. Parties who want a persistent shared secret can bootstrap one (see [Bootstrapping a shared secret](#bootstrapping-a-shared-secret)).

On the CLI `sftp` channel the server's identity is pinned by `connection.server.host_key_fingerprint`, verified before authentication on every connection, with a mismatch aborting. The no-pin default is fail-closed: an unattended run with no pin fails, and a rotated key is never auto-accepted. The fingerprint is non-secret and pinned out of band; the invitation endpoint cannot hold it, so an attacker who seeds a configuration cannot pin their own key. How a pin is set, confirmed at a terminal, and rotated is in [CLI.md](CLI.md#sftp-host-key-trust); the construction is in [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#sftp-host-key-verification). A shared folder makes no SSH connection, and the web path does not run the host-key check.

Pinning is each party's local decision, so on its own it cannot catch a one-sided interception (one party pins an attacker's key, the other pins the real key, and the two views are never compared) or a server rekey between the two setups. For recurring exchanges the parties therefore reconcile: each advertises the host-key fingerprint it observed inside the authenticated post-handshake exchange, and a divergence raises a warning naming both values for the operators to disambiguate out of band. The check rides the authenticated channel, so the advertised fingerprint cannot be forged by an unauthenticated party; a party that observed no host key (a shared-folder or proxy path) reconciles to no divergence rather than a false alarm.

### Bootstrapping a shared secret

Parties who want to move from a quick exchange to a recurring one can save the parameters from the quick exchange invocation (see [Quick exchange](CLI.md#quick-exchange)). Because this affects key generation, each party advertises the intent to the other at the start of the exchange.

| Party A | Party B | Outcome                                                                                                                                                              |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _save_  | _save_  | The initiator generates a fresh shared secret and sends it to the responder; both save it as the basis for future recurring exchanges, along with their configurations. |
| _save_  | _none_  | No secret is generated. A's configuration is saved, and A is told the partner did not choose to save and is directed to invite B to establish a recurring exchange. |
| _none_  | _none_  | Standard quick exchange; nothing is saved.                                                                                                                     |

The save intent rides the linkage-terms exchange, the one round-trip both parties always perform, so each side learns the other's intent even when it advertised none, and a one-sided save never stalls. When both save, the initiator generates a fresh 32-byte secret (the same format and entropy as a rotation token) and sends it to the responder on a dedicated in-band message.

That secret is protected only by the transport layer (SSH, or operator access controls for a shared folder), because a quick exchange has no key-exchange session key and so no application-layer AEAD to wrap it. A party unwilling to trust the transport with the secret should use `alcove invite` instead, which never sends the secret through the exchange server. After this first exchange the secret rotates on every subsequent exchange and is never reused.

In `--retain-files` mode the receiver does not delete exchange files after consuming them, so the message holding the secret persists as a cleartext file in the shared folder until removed by hand. A party bootstrapping with `--save` should avoid `--retain-files` for that exchange, or clear the shared folder once the secret is saved on both ends.

## Key file security

`.alcove.key` holds the shared secret that authenticates recurring exchanges. Treat it as a credential, with the same care as a private key or password.

### Required permissions

The CLI writes `.alcove.key` owner-only (`0600` on Unix, an owner-only ACL on Windows) through an atomic, symlink-hardened, durably-flushed write path, so a crash cannot leave a half-written or world-readable key. On Windows, if the owner-only ACL cannot be applied (for example in a restricted container), no key material is written and an error is raised. The CLI warns on load if an existing key file is over-permissive: on Unix if any group or world permission bit is set, on Windows if a non-owner principal can read it. On Windows it also warns when it could not check the access list at all, naming the file and the `icacls` command that shows the list. The warning is at warn level, so a run configured at `--log-level error` or `silent` does not show it, as it shows no warn-level notice, including the data-cleaning fan-out warning on privacy degradation. Correct it before running further exchanges:

```sh
chmod 0600 .alcove.key
```

On Windows, correct an over-permissive ACL with:

```cmd
icacls .alcove.key /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%":(M)
```

On macOS a file can additionally inherit an extended (NFSv4) ACL that a `0600` mode does not remove, so the CLI clears the extended ACL, as part of the write and before any content reaches the file, on every artifact its write construction produces -- the owner-only set and the exported public certificate alike, including the temporary credentials file `alcove doctor probe` hands its SMB password to `smbclient` in -- and on the two owner-only artifacts written outside that construction, the result CSV and the `--log-file` a run appends its diagnostics to when that is a regular file ([exemptions](spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip)). If the ACL cannot be cleared, no content is written and an error is raised, as on Windows: no line reaches the log file and no password reaches the credentials file, and the command stops. Inspect any file's extended ACL with `ls -le`, and clear an unexpected entry on a file Alcove did not write with `chmod -N <file>`. Before a recurring exchange the CLI verifies the key file can be written, because a write of the rotated secret that fails at the terms exchange can desynchronize the two parties' tokens. The byte-level write construction and the platform caveats are in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md).

**Result CSV output.** The matched-records CSV that `alcove exchange` writes to an output path is created owner-only on the same principle as the key file, before any rows are written. Writing the result to stdout applies no permission handling: a shell `>` redirect leaves the file at the shell umask. The CLI detects a redirected-regular-file stdout and prints a notice naming the exposure and the output-path alternative (a TTY, a pipe, or `/dev/null` does not trigger it). That check sees only this process's own stdout, so a redirect applied outside it is not detected. Pass an output path to get the owner-only treatment. The CSV write construction is in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md#result-csv-output).

### What not to do

- Never commit `.alcove.key` to version control. Add it to `.gitignore`:
  ```
  /.alcove.key
  ```
- Never transmit the token over an unencrypted channel. If it must be copied between machines, use an encrypted transfer (for example `scp`, SFTP, or a secrets manager API).
- Never log or display the token in plaintext. Keep `--key-file` content out of bug reports and support tickets.
- Never store the token in environment variables visible to child processes or process listings.

### Backup

Tokens may be backed up to a secrets manager or encrypted store (for example HashiCorp Vault, AWS Secrets Manager, or an encrypted filesystem). Any backup must have the same access restrictions as the original: owner-read-only or the equivalent ACL. If no backup exists and a token is lost, re-invitation is the correct recovery (see [Recovery](CLI.md#recovery)).

### Compromise response

If a token is believed compromised (observed in a log, a process listing, a shared filesystem, or in transit on an unencrypted channel), treat it as invalid immediately:

1. Notify the partner out of band before any further exchanges; their copy may also be exposed.
2. Both parties delete their key files (`.alcove.key`).
3. Re-invite over a channel known to be uncompromised. An observed token stays valid until the next successful exchange rotates it out, so close the window between observation and deletion as quickly as possible.

### Shared secret rotation and inactivity limit

Tokens rotate automatically on every successful exchange. By default the shared secret does not expire: an organization with its own rotation policy can treat each exchange as the rotation event.

The optional `token_max_age_days` field (in the [`authentication`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) block) makes the shared secret expire after that many days of inactivity (no successful run). When set, each successful exchange stamps an `expires` that many days onto the rotated token, and the next `alcove exchange` enforces it: an expired token aborts the run before any connection, with an error that names the expiry and directs both parties to re-invite; a token near expiry produces an "expiring soon" warning, shown only when no successful exchange has refreshed it. The same `expires` field also carries an invitation's bounded setup lifetime (default 1 hour), with one meaning to every consumer -- the instant after which the token must not be used -- so an invitation token loaded while an inactivity limit is in force can be flagged "expiring soon". The enforcement sites and thresholds are in [PROTOCOL.md](spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory).

Both sides set the policy independently; it is not negotiated. If one party sets an inactivity limit and the other does not, the party that set it refuses to exchange once its shared secret expires, exiting with the re-invite error; to the other party this can look like a silent peer or a key-exchange failure, and the same recovery (re-invite) applies. A misspelled key is rejected at config-parse time, so a typo cannot silently disable the control (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#authentication)).

## Channel security

Server administrators can see exchanges conducted over SFTP and shared folders, so the baseline protection on those channels is the transport itself (SSH for SFTP; the operator's access controls for a shared folder). For authenticated, recurring exchanges an application layer of encryption closes that visibility. Whether it applies is negotiated in the key exchange: each party declares a request-encryption flag, and both wrap the connection when the negotiated decision (`own request OR peer request`, transcript-bound) is set and a session key was derived. What each party requests is fixed by its channel and application:

- **File-sync transports (SFTP, shared folder)** request it unconditionally. The CLI requests it on every file-sync exchange, so the SFTP or shared-folder admin sees ciphertext rather than the exchange's contents, the files outside the wrap excepted (below).
- **WebRTC**: the CLI and the web application both request it on every exchange, so every WebRTC exchange is wrapped, one a WebSocket relay carries included (below).
- **Quick exchanges** have no session key and run under transport encryption alone.

The AEAD construction is in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#application-layer-aead).

The wrap begins once the key exchange has produced the session key. Three kinds of artifact sit outside it, and none holds exchange data or linkage identifiers:

- **The key-exchange handshake frames** -- the ephemeral public keys and the confirmation MACs. In a shared folder they are ordinary files; on SFTP the SSH session protects them. The handshake is authenticated, so tampering with them fails the exchange.
- **The rendezvous hello and joining files**, written before the key exchange, which hold the two bilateral mode flags.
- **The abort marker** a failing party leaves for its partner, which holds a version marker and one token derived from the session key.

[COMPLIANCE.md's SC-8 row](COMPLIANCE.md#nist-sp-800-53) states the exceptions in the form an assessor asks for.

The file-sync channels are also hardened against a hostile server admin. Each bound is specified with its constant values in [TRANSPORT_BOUNDS.md](spec/TRANSPORT_BOUNDS.md), [TRANSPORT_LIVENESS.md](spec/TRANSPORT_LIVENESS.md), [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md#sftp-fatal-packet-crash-safety), and [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md).

- **Application-layer integrity, replay, and gap detection.** The AEAD decorator validates and decrypts each inbound frame, rejecting any integrity, replay, reordering, or mid-stream-gap failure as a `security` error at the protocol layer. Truncated-tail detection is deferred, resting on the matching loop's self-driven lockstep.
- **Inbound frame-size bound.** The transport refuses an oversized inbound frame before reading it, so a hostile server cannot exhaust memory with an arbitrarily large file.
- **Directory-listing bound.** Caps on entry count and name length, enforced as the listing streams in, bound the same memory exhaustion reached by directory enumeration.
- **Liveness bounds.** Per-operation deadlines and idle windows fast-fail each read and write; a whole-exchange budget bounds every transport await; and a connect-probe bound covers the one call outside that budget. All surface as a `UsageError` subclass that every transport consumer treats as terminal.
- **SFTP fatal-packet crash safety.** A guarded error listener turns a malformed SFTP reply packet into a handled failure rather than a crash before cleanup.
- **Authenticated abort marker.** A party that fails terminally writes an authenticated abort marker so a parked peer fails fast instead of waiting out the full inactivity budget. The token is keyed from the session key, so a hostile admin cannot forge an abort against a live peer. The marker's filename and token construction are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#authenticated-abort-marker) and [FILE_SYNC.md](spec/FILE_SYNC.md).

Every WebRTC exchange, CLI and web, applies the application AEAD, over DTLS on the data channel and over TLS on the WebSocket relay's connection below. A coordination server controls the signaling it relays and could otherwise place itself between the two parties, so the application wrap, keyed by the authenticated key exchange that server cannot complete, keeps exchange content from it. Every WebRTC exchange runs the P-256 authenticated key exchange immediately after its connection opens, so a wrong or expired secret fails closed before any PSI frame, and no secret-less (quick exchange) WebRTC rendezvous is offered. An envelope altered in transit fails closed as a `security` error.

A WebSocket relay carries an exchange whose WebRTC path does not open, over one `wss://` connection from each party ([WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#falling-back-to-the-websocket-relay)). Each application applies the same wrap on that connection. Where the relay carries the exchange, its operator sees the key-exchange handshake frames, which hold no linkage identifier and no exchange data, the AEAD envelope of every later frame with its sequence number and size, and the framing's chunk headers and close sentinel, which hold no exchange data. The reference deployment's front terminates the relay's TLS, and the relay forwards each message unread and opens no connection of its own ([WEBSOCKET_RELAY.md](spec/WEBSOCKET_RELAY.md#forwarding); [infra/relay/README.md](../infra/relay/README.md#the-websocket-relay)). What the coordination server, each relay, and every other supporting service can observe is stated once in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

The coordination server is untrusted: under the application wrap it reads no exchange content, and rendezvous ids derive from the out-of-band invitation secret, so an unauthenticated connection can neither target nor read an exchange. The residual concern on its WebSocket surface is resource exhaustion. It runs as a service of its own, the standalone server in `packages/peerjs-broker`, and hardens its upgrade surface itself; origin restriction and per-address rate limiting are the reverse proxy's. Both halves are in [DEPLOYMENT.md](DEPLOYMENT.md#hardening-the-coordination-server), and their constant values in [SIGNALING_SERVER_BOUNDS.md](spec/SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds).

The web app sets defense-in-depth HTTP headers, stated once in `apps/web/src/utils/securityHeaders.ts`. The console server applies them to every response it returns, and the hosted static build writes them into the static host's `_headers` file under `/*`; a unit test holds the file to the same value, and an integration test reads them off the served static site ([hosted-static-build.md](notes/hosted-static-build.md#the-host-configuration-file)). What each header does is in [DEPLOYMENT.md](DEPLOYMENT.md#headers-caching-and-the-fallback-document).

### Console and log hygiene

The web client keeps its derived rendezvous ids out of the production browser console: PeerJS runs at errors-only, and the ids are logged only at a `debug` level production does not enable. A per-session diagnostic toggle raises verbosity for one browser through a log function that redacts the ids first, and the app strips ids from the `Error` objects PeerJS emits on a connection failure. This is best-effort hygiene, not a primary control: an attacker who holds the invitation already holds the secret the id derives from. Raised verbosity also shows SDP/ICE detail containing local private IPs ([DEPLOYMENT.md](DEPLOYMENT.md#diagnosing-web-connection-failures)).

Alcove escapes untrusted partner- and server-controlled strings at every operator-facing display boundary (CLI log and error output, and the web console and alerts) through shared display-sanitization helpers. The strings covered are those a hostile or misconfigured partner or server controls -- filenames, a rendezvous host and path, a self-asserted identity, abort reasons, and spans some libraries quote inside an error -- which rendered raw would allow terminal control-sequence injection, homoglyph spoofing, and forged log lines.

- **Escape at display, compare raw.** Only the displayed copy is escaped; every value used for a path, equality, or hash comparison is kept byte-exact.
- **Escape once, at the sink.** Text destined for an error message is composed raw and escaped where the error is rendered, so what an operator is shown still names the bytes it refers to.
- **A private-key fallback uses the same mechanism.** A narrow pass strips PEM/OpenSSH private-key blocks at three renderings -- a rendered error, a diagnostic log line at either CLI sink or the browser console, and the machine-readable event stream -- so a code path that interpolated key material from the operator's secret-bearing files (config, key file, signing identity, and imported terms documents) is contained. It is defense in depth; the primary control is the secret-bearing parse chokepoint.
- **The private-key fallback's reach is bounded.** The pass runs over one rendered unit at a time and over strings only, and an operator-facing sink that writes the console directly instead of through the diagnostic logger runs no pass at all ([DISPLAY_REDACTION.md](spec/DISPLAY_REDACTION.md#private-key-redaction)).

The display boundary does not cover partner cell values written to the result CSV: those are data, not display. They are written with RFC 4180 quoting only, with no spreadsheet formula neutralization, so a partner value that begins with a formula character reaches a spreadsheet as the partner sent it.

First-party web console sinks that can expose raw partner bytes are gated behind the per-session diagnostic flag, so a production console has none. The byte-level escape format is in [DISPLAY_ESCAPE.md](spec/DISPLAY_ESCAPE.md#display-sanitization-escape-format).

## Hosted at-rest threat model for managed exchanges

A managed web exchange persists a rotating shared secret in the browser (see [Recurring web exchanges: single-use vs managed](#recurring-web-exchanges-single-use-vs-managed)). This section is the at-rest threat model for that persisted secret. The browser at-rest secret is weaker than the CLI's on-disk key file. The record shape is in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md); the operational lifecycle is in [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md).

### Why the browser at-rest secret is weaker than the CLI on-disk key

The CLI's `.alcove.key` is protected by the operating system's owner-only file permissions (see [Key file security](#key-file-security)). The browser's persisted secret lives in IndexedDB, readable by any script that runs in the origin, including an injected script (an XSS): there is no owner-only mode. An unattended run has no human to supply a passphrase, so at-rest encryption keyed by material the app holds protects only against a reader of the raw store bytes (a disk-image or backup thief), not an in-origin script. It is secondary hygiene, not a primary control.

### The primary controls

The primary controls bound and recover from exposure rather than prevent a read:

- **Rotation bounds the exposure window, for an exchange that runs.** The secret rotates after every successful run and is never reused, so a secret read from the store is only the current one and is invalidated by the next successful exchange. It happens only when the exchange runs, so for an idle exchange rotation bounds nothing.
- **Fast re-invite is the recovery.** A suspected compromise or a desync is recovered by re-inviting, which the managed exchange makes cheap by retaining everything a re-invite needs except the secret: the terms, while the fresh invitation names the inviting browser's coordination server (see [Desync detection and recovery](MANAGED_EXCHANGE.md#desync-detection-and-recovery)). This is the same recovery the CLI uses for a lost token.
- **An inactivity limit caps stale-secret risk, and is the only cap for a dormant exchange.** The browser analog of `token_max_age_days` stamps an `expires` onto the rotated secret. Like the CLI's, it is operator-set and off by default, so a dormant shared secret has no automatic exposure bound unless the operator opts in.

The export artifact is a plaintext credential file under operator custody, the CLI key file's trust model (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact)). A scheduled run whose exchange holds a working-folder grant it can use with nobody present writes that same file into the folder after each rotation: the folder then holds the current secret in plaintext, within reach of whoever can read the folder and, while the grant stands, of an in-origin script. Each run's backup replaces the one the previous run wrote; a backup the app did not write, or one left from before a run that wrote no backup there, stays in the folder holding a secret the partnership has rotated past until the operator deletes it (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-backup-a-scheduled-run-writes)).

### Rollback: at-rest copies can silently resurrect

The managed record keeps no rotation epoch. Its rotation history orders two copies at an import, but over WebRTC two copies on different secrets never meet in a handshake, so the partner cannot recognize a superseded copy there (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact), No anti-rollback). Anything that snapshots the record (the export artifact, a browser-profile backup, a VM snapshot, a duplicated file) can therefore silently re-arm the secret it captured. If that secret is still current, the copy is a live credential: treat a captured export exactly as a captured token under [Compromise response](#compromise-response). If the partnership has already rotated past it, a restored copy produces a desync at the next run, indistinguishable to the partner from an attack (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#desync-detection-and-recovery)). Recognizing a superseded copy in the handshake, and healing a rotation only one side saved, are proposed in [rotation-hardening.md](notes/rotation-hardening.md) and not built.

### Metadata at rest: presence and shape

A managed record also holds the partnership's existence, the operator's label, the agreed terms' column shape and disclosed payload column names, the rendezvous locator, the run schedule, and the run outcomes. To any reader of the store (an in-origin script, or whoever holds a disk image or backup) this reveals that these two organizations link data, on what schedule, and over which categories of fields, never a row value. None of the secret-centric controls reduce it; it lasts until the managed exchange is removed (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#removing-a-managed-exchange)).

A granted working folder broadens the reach. Where the browser offers it, the operator grants each exchange one folder: every run reads its input from that folder and writes its results into it. The record then holds a `FileSystemDirectoryHandle` in `readwrite` mode.

- **What an in-origin script can reach.** While the grant stands, a script running in the origin can read **and write every file in that folder**, and the folder's own name is disclosed to any reader of the store. **Grant a folder used for nothing else.**
- **What the app itself reads there.** The app reads exactly one name from the folder -- the input file, `input.csv`, looked up afresh at each run -- and writes only the results files it names and the backup file a scheduled run writes after its rotation, which never replaces a file already there. It lists no entries, opens no subfolder, and reads no file but the input. Checks in `apps/web/test/unit/psi/unattendedRuntimeBoundaries.test.ts` hold this as far as they reach. A recorder drives the input read, the results write, and the backup write (`acquireManagedInput`, `readInputFileModifiedAt`, `writeResultsToWorkingDirectory`, `writeBackupToWorkingFolder`) against a folder that reports any access other than `getFileHandle`, `removeEntry`, and `name`. A source scan over `apps/web/src` refuses any `getFileHandle`, `getDirectoryHandle`, or `removeEntry` call beyond the known ones, and any `for await` loop or `.values(`, `.keys(`, or `.entries(` call whose iterated expression names a handle, a directory, or a folder. An iteration elsewhere, reached through a name that says none of those, passes both checks.

Moving the input out of the folder after a run leaves nothing for the grant to read (see [The input file each run](MANAGED_EXCHANGE.md#the-input-file-each-run)); the app neither enforces nor automates that. Removing the exchange drops the grant with the record, and the grant can be dropped on its own from the exchange's page. Granting no folder leaves each run attended.

The operator label is length-capped, and the run and schedule bookkeeping is structured enums, timestamps, and durations rather than free text. The app caps the length of the operator's free text where the schema sets a cap, and does not check what the text discloses.

- **The label reaches beyond the store.** It is written into result and backup file names, in the granted working folder and in a downloaded parked copy or backup. Where the operator has opted in to between-visit notifications, the label, the next window's local time, and the count of consecutive missed windows appear in a notification, which the device may show on a locked screen or mirror to other devices. The label field states this.
- **The persisted exchange-file document holds other free text too.** A metadata column's description, a standardization step's parameters, and a retention note are always this party's own. The agreed terms' description, legal-agreement purpose, and payload column descriptions are this party's own only on the inviting side of an exchange whose terms never changed; otherwise they come from the partner's terms. A terms change a run refused is kept beside the record, with the partner's whole terms, until the operator applies or declines it. The retention note field states where the note is saved: with the exchange records, backup files, and configurations.

The field names and bounds are in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md).

The exchange's [accounting of disclosures](MANAGED_EXCHANGE.md#the-accounting-of-disclosures) adds to this and grows. Each run that discloses files that run's self-attested exchange record beside the managed record, whether or not it finished, so a reader of the store also learns how many times the partnership has run, when, and -- per run -- the partner's identity, the governing agreement and the purpose of the disclosure under it, the categories disclosed each way, this party's exposed-record count, and the result size where the record format recorded one ([EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md#privacy-properties)): never a row value or a matched identifier.

- The entries hold partner-authored free text, which no length cap governs; every such value is escaped at its display sink and never rendered raw.
- Nothing prunes the accounting, because a dropped entry would falsify it.

It goes when the managed exchange is removed, in the same step; the alternative is exporting it and removing the exchange.

The origin's ambient runtime surfaces are out of scope here: the IndexedDB database name is a fixed constant, and the Web Locks name a run holds includes the record's local UUID, so it reveals that a run is in flight, but both are visible only to a script that can read the whole record outright.

### Results of a scheduled run at rest

A scheduled run's parked results are the one exception to "never a row value": **content at rest, not presence and shape**.

A run with nobody present writes its results file into the working folder it read its input from, and keeps nothing of it in browser storage; whenever the grant or the write does not hold, the app keeps the file in browser storage for the operator's next visit (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-parked-results-of-a-scheduled-run)). What is then at rest is the linkage result itself: the identifiers that matched and the payload values the partner disclosed, one file per unattended run, unencrypted.

- **Who can read it.** Any script running in the origin, and anyone who can read the disk -- a disk image, a profile backup, a second local account with access to the browser profile.
- **No at-rest protection is claimed.** Encryption keyed by material the app itself holds would not change the in-origin reading ([Why the browser at-rest secret is weaker than the CLI on-disk key](#why-the-browser-at-rest-secret-is-weaker-than-the-cli-on-disk-key)).
- **What bounds it.** Four things bound a value this build can read. A retention of 30 days from the run, applied the next time the app reads or writes the store rather than by a sweep, so an exchange nobody revisits and that never runs again keeps the bytes past that mark. A size above which nothing is kept at all, the app's own CSV intake cap: a result past it is neither kept nor trimmed, and the operator meets a recorded state naming the size and the folder grant as its remedy. A clear control that removes everything kept for the exchange at once, without removing the exchange. And removing the managed exchange. A value this build cannot read is bounded by the last two alone (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-parked-results-of-a-scheduled-run), "Reader-rejects-unknown, with no recovery arm"). Downloading a result does not remove the parked copy.
- **What the operator is told, and when.** The statement is made where the exchange is put on a schedule and again where the results are collected, in both cases after the folder grant, which is offered first. Keeping the results one way or the other is on by default. Where a further run on the terms the last one declared projects a result above the size this browser keeps, both places say so before that run happens.
- **The folder route moves the rows, it does not copy them.** Results written into the granted folder are not also kept in browser storage. What stays in the browser is a note of where they went: the run instant, the file name, the folder's own name, how many records matched, and the two record counts the parties declared for that run. A grant the platform will not honour with nobody present, a revoked grant, and a failed write each keep the results in the browser instead, and the next visit says which happened.
- **What is not parked.** The results file alone. The run's self-attested exchange record is in the accounting of disclosures.
- **The clear is the operator's own control over what is at rest.** It removes the rows, the notes of results written to a granted folder, and the states recorded where results were not kept -- everything this exchange's runs left, in one step, and the key itself, so no envelope stays behind. What is in the operator's own folder is theirs to remove there.

An operator who does not want linkage results at rest in a browser has two options: keep the working folder writable, where the rows land in their own filesystem, or run the exchange attended, where the results go to the download the operator takes -- and into the working folder too, where one is granted -- and nothing of them is kept in the browser. The second holds on every browser; the first depends on a File System Access API the browser may not offer.

### Egress hardening and its limits

The web app's posture is that a managed exchange's secret, terms, and input data never reach a server.

For the app's own code, the property holds by design and review. No first-party path uploads the secret, the terms, or the input file: the input CSV is read in the browser and never sent, and every managed-exchange write lands in origin-isolated browser storage, except the results file a run places in the operator-granted working folder ([Results of a scheduled run at rest](#results-of-a-scheduled-run-at-rest)) and the backup file a scheduled run places there after its rotation. This is a reviewed property of the codebase, upheld by the security review that gates the managed lifecycle, not a browser-enforced one.

Against an injected in-origin script the property is not mechanically enforceable. A planned Content-Security-Policy `connect-src` allowlist (the app origin, the signaling endpoints, the default relay's registrar and WebSocket relay a build names, the WebSocket relays the browser's relay settings and an accepted invitation name, and the origin of any relay registrar the operator enrolls a saved exchange at) would govern programmatic non-WebRTC egress (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, beacons). Its limits:

- Its signaling and WebSocket relay entries cannot be fixed when the app is built, because an accepting browser dials the servers its invitation names and an inviting browser those its relay settings name ([WEB_APP.md](WEB_APP.md#relay-settings)); a build-time policy either admits every `wss:` host or refuses those exchanges.
- No shipped CSP directive can allowlist STUN/TURN hosts or peers, so an in-origin script could open its own peer connection and exfiltrate over a data channel regardless of `connect-src`.
- Downloads, clipboard writes, and navigations are outside it.

The allowlist narrows the injected-script exfiltration surface; it is not a complete barrier, and no first-party runtime guard can be one. The primary control against in-origin script remains preventing injection.

The vendored PSI WASM browser glue (`@openmined/psi.js`'s `psi_wasm_web.js` and `psi_wasm_worker.js`) uses one direct `eval` and two `new Function` sites, Emscripten-generated. Any future `script-src` directive must be verified against the PSI path before shipping: a policy without `'unsafe-eval'` breaks it, as measured on the current artifacts.

The no-egress claims [PRIVACY.md](../PRIVACY.md) publishes have one mechanical check against first-party drift, `npm run check:egress-claims`, whose scope is stated in [PRIVACY.md](../PRIVACY.md#the-projects-role). Each allowlist entry records why the literal it admits does not contradict that document: either that it names no host anything contacts (an XML namespace identifier, a documentation link the operator clicks, a dummy base handed to a parser), or that the host is one the supporting-services table already discloses, as the two default public STUN servers are. A JavaScript or TypeScript file is read from the string, template, and JSX-text nodes of a real parse, and an authority names a host when `new URL()` resolves one from it. Every other text format, and any file of that family whose parse fails, is scanned raw, which over-reports rather than reporting a file clean.

It does not see:

- a scheme outside `http`, `https`, `stun`, `stuns`, `turn`, and `turns`, so a `wss://` beacon or a protocol-relative `//host` reference is not matched;
- a host assembled at runtime from configuration or an operator-supplied value, which is what the SFTP server and the signaling endpoint legitimately are;
- egress introduced by build configuration, which sits at a workspace root outside the scanned trees even though what it emits ships;
- a URL literal in a file the repository ignores, which the scan's listing excludes along with build output; none of the ignored trees an install and a core build leave behind (`node_modules` and the workspace `dist` trees) sits under a scanned tree;
- egress originating inside a dependency, which is the dependency review's ground;
- a URL an author split across fragments, encoded past the scheme, or wrote into a regular-expression literal; an escape the language itself removes is not one of these, since a literal is read as the value it evaluates to.

The full list is in [the check's design note](notes/repo-check-scripts.md#url-literal-egress-guard).

#### The containerized roles

In the headless CLI and the console, what bounds dependency-originated egress is the host's firewall rather than any browser directive. The recipe that restricts the container's outbound access, and its tested verification, are in [DEPLOYMENT.md](DEPLOYMENT.md#restricting-the-containers-outbound-network-access). It is hardening the operator chooses to apply; a deployment that has not applied it has none of it. It works only on Linux with Docker Engine's iptables integration, bounds one container's reach and not the machine's, and is not a substitute for the protocol's protection against the partner's material (see [Channel security](#channel-security)).

## Receipt signing identities

A certificate-backed receipt is third-party-verifiable proof that a specific data set flowed between the two parties (see [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning)). That verifiability rests on a long-lived signing identity per party: a P-256 keypair and a self-signed certificate stating the party's `identity`. This is separate from the shared secret, which rotates every exchange; the signing key is stable for its whole life, because a partner pins its certificate fingerprint once and every later receipt must verify against the same key. The two are kept in separate files with separate lifecycles.

A receipt evidences only that a specific data set flowed between these two parties, third-party-verifiably in the certificate-backed mode. It does not prove where either party's data came from, that the data is accurate, or that either party met a legal or contractual duty.

### Custody and persistence

The signing identity is persisted in its own file, separate from the per-directory `.alcove.key` and `alcove.yaml`, because one identity is reused across every exchange and partner. The file holds the private key and is protected exactly as the key file is: owner-only via the same atomic write path, with the same over-permissive-permissions warning on load (see [Required permissions](#required-permissions) and [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)). It is a longer-lived, higher-value secret than the rotating shared secret: do not commit, transmit in cleartext, or log it.

**Resolved only from a path the operator named.** `signing.identity_file` in the configuration, or `--identity-file` on the command line, is the whole resolution: Alcove chooses no location, probes none, and reads no environment fallback. Keep it in a mounted directory of its own, separate from the read-write mount the rotating key file needs, so this one can be read-only. Do not keep it in an ephemeral container home directory, where each run would create a fresh key and invalidate every partner's pin, or in a shared-folder exchange's working directory, which the partner writes into. See [CLI.md](CLI.md#where-the-signing-identity-lives) for the operator-facing instructions.

**Written once, read thereafter.** `alcove fingerprint --identity-file` is the only command that writes the identity; an exchange and `alcove verify-receipt` read the file and write neither it, its directory, nor anything beside it, so a read-only mount of its own serves every run but the one that provisions the key. Creation is announced, never silent, and regenerating is a separate, explicit action (`--force`) that warns it invalidates any fingerprint a partner has already pinned.

A certificate-mode exchange configured with no `identity_file` is refused before any credential, terms, or data are sent, alongside the other pre-flight configuration refusals (exit 64). `alcove verify-receipt` refuses nothing on the same input: it leaves this party's own certificate unanchored and grades the verdict short of verified.

### Pinned self-signed trust model

Trust in a partner's signing key is established by pinning its certificate fingerprint, not by validating a certificate-authority chain. A self-signed certificate vouches only for possession of its own key, so the pinned fingerprint is the trust anchor: a partner certificate is trusted only if its self-signature verifies and its fingerprint matches the pinned `signing.partner_fingerprint`, and a receipt is accepted only if its asserted identity exactly matches the one the certificate binds. The fingerprint is a hash of a public certificate, so it is not secret; the channel it arrives over must be authentic but need not be confidential. This is the SSH-host-key / certificate-pinning model.

**What the pin is anchored to depends on how it was obtained.** Both parties present their certificate to each other in band, during the authenticated setup step that opens every exchange, and a party holding no pin adopts the fingerprint presented there. On such a partnership the pin is authenticated by the channel the invitation and its shared secret travelled, and by nothing else: whoever could have substituted the invitation could have substituted the certificate that first contact pins, and every later exchange then verifies receipts against the substituted identity. The exchange tells the operator the fingerprint it pinned and asks them to compare it with the partner out of band, but nothing enforces that comparison.

Pinning the partner's fingerprint before the first run -- the partner prints it with `alcove fingerprint`, reads it to the operator over a channel they trust, and the operator writes it into `signing.partner_fingerprint` -- restores the out-of-band anchor. The first run then holds the presented certificate to that value and refuses a partnership that does not match it. Take this posture where the receipt's non-repudiation matters to a third party. In both cases a later exchange whose partner certificate differs from the pin is a hard refusal, before any data crosses, and the pin on file is never overwritten by a run.

The certificate is a small canonical-JSON document signed over its RFC 8785 bytes, not X.509, and no certificate authority is used. An authority-backed mode (an agency using its own CA) is not built; the certificate's `version` format discriminant and `algorithm` field leave room for it.

## Canonical encoding

The self-attested record's commitments, the agreed-terms hash both parties compute, a signing certificate's fingerprint, and the signed exchange receipt are each hashed or signed over a byte string. For any of these to verify, every party that produces or checks one, including an independent third party re-deriving it later from a different implementation, must derive exactly the same bytes from the same logical object, which ordinary JSON does not guarantee.

Alcove uses a single canonical encoding for every hashed or signed artifact, so that "these hash equal" reliably means "these are the same object". The normative byte definition, the standard it follows, the value domain, the encoding rules, and the cross-implementation test vectors are in [CANONICAL_ENCODING.md](spec/CANONICAL_ENCODING.md).

## Data handling

Alcove uses the identifying fields only to compute the intersection: it does not send them to the partner, write PII to logs, or retain PII outside the configured output file. After matching, each party transmits the payload columns it designated for disclosure (see **Output** below).

**Protocol messages.** During matching, the data crossing the wire is cryptographic protocol messages (elliptic-curve points) plus non-identifying match bookkeeping (encrypted-set indices and association tables); raw identifier values never cross. On every recurring (authenticated) exchange, which includes every WebRTC exchange, these are wrapped in AEAD ciphertext by the application-layer encryption (see [Channel security](#channel-security)); on quick exchanges they cross under transport encryption only. The PSI guarantee ensures each party learns only the existence of shared members, with records outside the intersection never revealed. After matching, a payload-exchange phase transmits the raw values of the payload columns each party designated, for matched rows only; by default the identifying columns used for matching are linkage-only and are not among them.

**Third parties.** No PII is transmitted to any third party. The coordination server and relays see connection metadata and, of the exchange itself, only application-layer ciphertext; the page host sees connection metadata and none of the exchange. The SFTP or shared-folder infrastructure sees ciphertext on a recurring exchange; on a quick exchange its administrator can read the files, including the payload values for matched rows. What each can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

**Logging.** Alcove does not write PII to log output. Operational logging is limited to non-sensitive metadata: the runtime resource ceilings logged once per exchange (Node version, host memory, the V8 heap limits, and any container memory limit) and the memory this party's record count needs, exchange timing, transport errors, and protocol state transitions. Review log output before forwarding it to a third-party logging service.

**Output.** The output each party writes pairs its own row identifier (a database identifier from its input, or the row index when it has none) with the matched partner records and the payload columns the partner disclosed. The identifying fields used for linkage are not part of it, unless the operator sets [`include_own_columns: all`](EXCHANGE_REFERENCE.md#include_own_columns), which writes every column of the party's own input, linkage fields included. Each party joins its identifier column back against its dataset to recover the matched rows, and handles the written output under its applicable data governance policies.

## Regulatory compliance

The [NIST SP 800-53 Rev. 5](https://doi.org/10.6028/NIST.SP.800-53r5) control mapping and Section 508 accessibility status are documented in [COMPLIANCE.md](COMPLIANCE.md).

## See also

The spec-tier counterparts that specify how these controls are built:

- [PROTOCOL.md](spec/PROTOCOL.md) - the PSI/PSI-C algorithms and the P-256 key-exchange wire format
- [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md) - the AEAD construction
- [DISPLAY_ESCAPE.md](spec/DISPLAY_ESCAPE.md) and [DISPLAY_REDACTION.md](spec/DISPLAY_REDACTION.md) - the display-sanitization format, the private-key redaction, and the display budgets
- [PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md) - the parsed-input bounds
- [TRANSFORM_REGEX_DIALECT.md](spec/TRANSFORM_REGEX_DIALECT.md) and [TRANSFORM_PARAMETER_BOUNDS.md](spec/TRANSFORM_PARAMETER_BOUNDS.md) - the bounds on partner-authored transform patterns and parameters
- [TRANSPORT_BOUNDS.md](spec/TRANSPORT_BOUNDS.md) - the transport memory bounds, file-sync and WebRTC
- [TRANSPORT_LIVENESS.md](spec/TRANSPORT_LIVENESS.md) - the file-sync transport liveness bounds and the SFTP heartbeat
- [SFTP_CONNECTION.md](spec/SFTP_CONNECTION.md) - the server-provisioning endpoint call, SFTP fatal-packet crash safety, and host-key verification
- [SFTP_SESSION_RECOVERY.md](spec/SFTP_SESSION_RECOVERY.md) - the SFTP adapter's recovery of a session the server drops mid-exchange
- [SIGNALING_SERVER_BOUNDS.md](spec/SIGNALING_SERVER_BOUNDS.md) - the coordination server's signaling-surface bounds
- [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md) - the owner-only on-disk write path for the key file, signing identity, and result CSV
- [CANONICAL_ENCODING.md](spec/CANONICAL_ENCODING.md) - the RFC 8785 byte encoding receipts and commitments are computed over
- [SERVER_JOB_API.md](spec/SERVER_JOB_API.md) - the console's server-side job API
- [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md) and [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the managed exchange lifecycle and its persisted record
- [COMPLIANCE.md](COMPLIANCE.md) - the NIST SP 800-53 control mapping and Section 508 status
