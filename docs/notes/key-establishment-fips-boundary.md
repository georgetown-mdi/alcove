---
title: "Key Establishment and the FIPS 140-3 Boundary"
---

# Key establishment and the FIPS 140-3 boundary: migrate the curve, keep the schedule

*Status: decided and implemented. This note records the choice to move the key
exchange's shared-secret computation to P-256 ECDH through `crypto.subtle` while
retaining the Noise NNpsk0 key schedule and the explicit key-confirmation round,
the alternative weighed against it and rejected, and what a scoped FIPS claim may
and may not say about key establishment as a result. It extends the
key-agreement decision in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) rather than
replacing it. The normative construction is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange); the
provider measurements and certificate readings underneath the reasoning are in
[fips-provider-surface.md](fips-provider-surface.md). See
[docs/notes/README.md](README.md). The Ephemeral Unified Model build of
2026-10-31 ([The build](#the-build-2026-10-31)) is agent-written and not yet
ratified.*

With FIPS 140-3 as the target standard, no provider choice puts an X25519 key
exchange inside a module's approved mode. Certificate 5438, the module the FIPS
variant image embeds, names X25519 in no table at all, approved or
non-approved, and states its non-approved-but-allowed category empty, so there
is no status the curve could hold there -- and the certified module the image
pins, `3.2.2-799901ad7ab41d45`, has no such primitive to begin with
([reading](../spec/CONTAINER_IMAGES.md#the-fips-images-measured-reading),
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests),
[fips-variant-image.md](fips-variant-image.md)). Certificate 4985, the OpenSSL
Project module read beside it, places X25519 in its Non-Approved, Not Allowed
table. That leaves a fork. Disclose the boundary -- cheap and accurate, and
costing nothing in module terms, because an algorithm the module never performs
cannot take the module out of approved mode -- or migrate to a curve a
certificate approves, which is the only thing that buys key establishment a
place *inside* the boundary.

The decision is to migrate. Most of the reasoning below is about how far the
migration should go, because the curve was never the interesting question.

## The decision

- **Migrate the shared-secret computation to P-256 ECDH through
  `crypto.subtle`**, replacing the X25519 Diffie-Hellman and ephemeral key
  generation that ran in `@noble/curves`.
- **Retain the Noise NNpsk0 key schedule and the explicit, role-asymmetric
  key-confirmation round** exactly as specified today. The mixing order, the
  domain-separation labels, the transcript binding, and the two confirmation
  tags are unchanged.
- **Collapse the Noise chaining HKDF into a single `crypto.subtle` HKDF
  `deriveBits` call**, so the extract-then-expand step is one operation the
  platform -- and any module beneath it -- serves as a unit, rather than a chain
  of HMAC calls assembled in JavaScript.

**Rejected: restructuring the schedule into a NIST-shaped derivation.** The
alternative was to additionally recast the handshake as an SP 800-56A Rev 3
shared-secret computation followed by an SP 800-56C Rev 2 two-step
extract-then-expand derivation, using the pre-shared secret as the auxiliary
shared secret `T` of a hybrid shared secret `Z || T`, with the handshake
transcript as FixedInfo. Its appeal was narrative: the derivation would read as
a named NIST key-derivation method rather than as a Noise schedule.

This record is the decision and the reasoning behind it; the construction it
produced is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange).

## What this extends, and what it supersedes

The key-agreement decision record is
[SECURITY_DESIGN.md, Key-agreement design](../SECURITY_DESIGN.md#key-agreement-design),
which recorded adopting an ephemeral key exchange keyed with the pre-shared
secret and retiring the customized SPAKE2. Everything critical in it
survives:

- The reason for retiring SPAKE2. The shared secret is a 256-bit token, not a
  human password, so a PAKE's one distinctive property is unused, while forward
  secrecy and mutual authentication are preserved by an ephemeral exchange plus
  a secret-keyed confirmation.
- The construction: Noise NNpsk0 with an added explicit, role-asymmetric key
  confirmation, with the full Noise framework not implemented, by design.
- The library-selection rule -- a well-respected, ideally audited, dual-platform
  primitive with only minimal hand-written glue. Moving the Diffie-Hellman to
  `crypto.subtle` satisfies that rule more strongly than a third-party library
  does, and removes a dependency from the key-establishment path rather than
  adding one.
- The pre-shared secret as the baseline authentication anchor, and the version
  discriminant that keeps an authority-backed mode open.
- The limit: a leaked secret permits active impersonation until it is rotated
  out, and forward secrecy buys only that a recorded transcript stays
  confidential if the secret later leaks.

Two things in that record are superseded:

- **The curve and the provenance of the Diffie-Hellman.** X25519 in
  `@noble/curves` becomes P-256 in `crypto.subtle`.
- **The compliance reading of the switch.** That record's closing sentence
  treats Ed25519's and the curves' standard approval (FIPS 186-5, SP 800-186) as
  material for a FIPS-validated build. The standard approval is real; the
  implication that it buys anything on a module certificate is not. Neither
  X25519 nor Ed25519 appears on the approved-algorithm list of any OpenSSL
  Project certificate -- under certificate 4985 both are Non-Approved and Not
  Allowed -- and neither string occurs anywhere in the security policy of
  certificate 5438, the module the variant image embeds.

Nothing here is normative. The wire format, the mixing order, the labels, and
the protocol-version tag are specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), which is
the authority for every value this note describes in prose.

## Why the schedule stays

In the order the reasons matter.

**1. WebCrypto exposes no SP 800-56C two-step KDA service.** `crypto.subtle`
offers ECDH, HKDF (RFC 5869), HMAC, SHA-2, and AES-GCM. There is no API by
which Alcove could invoke a module's `KDA TwoStep` service, so the rejected
option's two-step derivation would be hand-composed in JavaScript from HMAC
calls regardless -- while naming a module service that never runs. This is the
decisive point: the rejected option's central advantage does not survive
contact with the platform's call surface.

**2. The certified `KDA TwoStep` service is feedback mode only.** Its
properties on certificate 4985 read `KDF Mode - feedback`, while RFC 5869 HKDF
-- and WebCrypto, and every derivation in this tree -- is counter mode. Building
a two-step derivation faithful to the certified service therefore means
authoring a novel feedback-mode KDF with no anchor anywhere in the repository.
That is strictly more hand-rolled crypto than the status quo, not less.

On certificate 5438 -- the module the variant image actually embeds -- that
mode tag does not reach the HKDF row at all. Its Security Function
Implementations table (Table 9, p. 18) gives the HKDF function a type of
`KAS-56CKDF` and the algorithm `KDA HKDF Sp800-56Cr1` at CAVP certificate
`A7440`, with the properties column empty: no mode, and no MAC list, as it is
for every other row of that table. Its Table 6 row for `KDA HKDF Sp800-56Cr1`
states no `KDF Mode` property either, where the `KDA TwoStep SP800-56Cr2` row
beside it reads `KDF Mode - feedback`, so the policy says nothing in either
direction about the mode of the HKDF the module performs
-- and what would determine it is driving the module, as with the open questions
below. The reasoning above does not move on it, turning as it does on
`KDA TwoStep` and on the platform's call surface. What the silence bounds is
claim text: a sentence naming this certificate's HKDF row may not assert a mode
with it.

**3. A certificate attests components, not compositions.** Both certificates are
silent on hybrid or concatenated shared secrets, and both were read for that
silence. "concatenat" and "pre-shared" occur nowhere in either security policy,
and every occurrence of "hybrid" is the FIPS 140-3 module-type sense (software,
firmware, hybrid). On certificate 5438 the search additionally covered
"composite", "combin", "augment", `Z'` and every occurrence of "shared secret",
and no statement anywhere composes the shared secret with other secret material;
the three sections that come nearest -- 2.7.4 (SP 800-56Ar3 assurances), 2.10
(Key Establishment) and 2.11 (Industry Protocols) -- describe public-key
validation, a pointer to the Security Function Implementations table, and
per-protocol use contexts, and nothing else. The conclusion does not turn on
that silence either way: this policy states nothing about the schedule's
surroundings at all -- no use-context restriction on its HKDF, and no
attestation of any composition -- which leaves the composition as unattested as
a restriction reaching only the head of the chain would
([fips-variant-image.md](fips-variant-image.md)). So the schedule assembled
above the shared secret is an operator-built composition under either option.
The rejected option would have exchanged one unattested composition for
another while presenting it under a NIST label -- the same conflation of
algorithm-standard approval with module-certificate approval that
[fips-provider-surface.md](fips-provider-surface.md) already catches in the
SC-13 row.

**4. Collapsing the chaining HKDF captures most of the rejected option's appeal
at near-zero risk.** The Noise chaining HKDF is already exactly RFC 5869
HKDF-Extract with the chaining key as salt followed by Expand with an empty
info string -- the spec says so, and the test suite already anchors it against
RFC 5869 test case 3. One `deriveBits` call reproduces it bit for bit, checkable
against the existing known-answer vectors, and it lands the extract-then-expand
on an approved HKDF key-derivation row instead of on a chain of individually
approved HMAC calls -- `KDA HKDF Sp800-56Cr1` (CAVP certificate A7440) on
certificate 5438, the module the variant image embeds, and
`KDA HKDF SP800-56Cr2` on 4985.

**5. The web application runs the same code and has no FIPS provider at all.**
Its key exchange runs in the browser, outside any module boundary, whatever the
curve. The construction therefore has to be expressible in plain WebCrypto on
both platforms. P-256 ECDH is; a module-specific KDA service is not.

**6. The scope of impact argues for containment.** The session key keys the
application AEAD, the rotated shared secret persisted to the key file, the
signed-receipt binder, and the per-direction receipt MACs. Retaining the
schedule touches the Diffie-Hellman call sites and the protocol-version tag;
the rejected option rewrites the schedule, redefines transcript binding, and
abandons a pattern with published analysis for a bespoke equivalent with none.

## What a scoped FIPS claim may and may not say about key establishment

**May say**, where a validated module is actually present in the environment:
every cryptographic operation in key establishment is performed by the module,
using algorithms on the approved list of certificate 5438, the module the FIPS
variant image embeds -- the shared-secret computation as
`KAS-ECC-SSC Sp800-56Ar3` over P-256, and the extract-then-expand as
`KDA HKDF Sp800-56Cr1` (CAVP certificate A7440). The rows and their tested
parameter ranges are in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests).

**May not say:**

- That the shared-secret computation meets the condition certificate 5438
  states outside its approved-algorithm table: that certificate conditions the
  SP 800-56Ar3 section 5.6.2 assurances on using the module "together with an
  application that implements the TLS protocol", which this handshake is not.
  Its HKDF carries no use-context condition, which is an absence rather than an
  attestation -- the schedule composed above the shared secret is unattested for
  the reasons above, whatever the policy states about context. The security
  functions themselves carry no such condition, which is why the may-say
  sentence names them and stops. The condition is quoted whole in
  [fips-variant-image.md](fips-variant-image.md).
- That key establishment used a FIPS-approved algorithm while it ran on X25519.
  It did not, on any certificate; that is what the migration was for.
- That the key exchange, the key schedule, or the protocol is validated or
  approved as a scheme.
- That the certificate attests the composition. The schedule above the shared
  secret is an application composition of approved operations, and that
  distinction must not be collapsed.
- That the key-confirmation round conforms to SP 800-56A Rev 3. Its
  construction is modelled on that document's bilateral key confirmation, but
  section 5.9.2 offers the feature for "any key-agreement scheme in which each
  party is required to own a static key-establishment key pair", and this
  handshake has no static keys -- its authentication anchor is the pre-shared
  secret. Read directly from the publication. Section 6.2.1.5 does not reach
  it either: it is key confirmation for a C(1e, 2s) scheme, further still from
  this handshake's shape.

**The composition disclosure is required on either path**, and it outlives the
migration: a protocol composed in JavaScript above primitive calls yields
validated primitives, never a validated protocol. CMVP validates modules, not
protocols; there is no certificate under which Alcove's handshake is the
validated artifact. Migrating the curve is what lets each operation sit inside a
boundary; it does not put the composition inside one, and no wording makes it do
so.

**No sentence may call the shipped image validated, or place it in a validated
module's operational environment.** No certificate covers the default image's
base, and the variant image, which embeds certificate 5438's module, runs in
none of the seven environments that certificate names: the four tested are bare
metal, the three vendor-affirmed are Snowball and Snowcone appliances, and none
is a container or a virtual machine. The line the policy prints beneath the
vendor-affirmed table -- that CMVP makes no statement about a module ported to
an environment the certificate does not list -- closes that route as well
([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests)).
The flat denial 4985's policy states is that document's sentence and not
5438's, so it is not available to quote here. What the variant image may say
instead, and how that turns on the host it runs on, is reasoned about in
[fips-variant-image.md](fips-variant-image.md); the environment question is
independent of everything decided here.

## What the primary sources actually say

Read from the documents themselves: NIST SP 800-56C Rev 2, the OpenSSL FIPS
Provider FIPS 140-3 non-proprietary security policy for certificate 4985, and
the Amazon Linux 2023 OpenSSL FIPS Provider policy for certificate 5438, the
module the variant image embeds. Two modules, so every row below names the
certificate it was read from; 5438's rows are recorded in full in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests).

**SP 800-56C Rev 2, Section 2 (Scope and Purpose, normative)** permits a hybrid
shared secret of the form `Z || T`, described as "a concatenation consisting of
a standard shared secret Z that was generated during the execution of a
key-establishment scheme (as currently specified in [SP 800-56A] or [SP
800-56B]) followed by an auxiliary shared secret T that has been generated using
some other method." The only stated condition on `T` is that "the content,
format, length, and method used to generate T must be known and agreed upon by
all parties that will rely upon the derived keying material". No restriction on
how `T` is generated, and no minimum length or entropy. The revision history in
Appendix A.3 (informative) confirms the permission reaches the two-step method:
extraction of a key-derivation key from a shared secret of the form `Z || T` is
"a bona fide extension of the previously specified technique".

**Certificate 4985, Table 5 (Approved Algorithms)** lists `KAS-ECC-SSC
Sp800-56Ar3` with P-256 among its domain parameters, `Scheme -
ephemeralUnified`, `KAS Role - initiator, responder`; and, on the derivation
side, `KDA HKDF SP800-56Cr2`, `KDA OneStep SP800-56Cr2`, and `KDA TwoStep
SP800-56Cr2` (`KDF Mode - feedback`, `Shared Secret Length: 224-8192 Increment
8`).

**Certificate 5438 differs on the derivation row, which is why the citations
above name Cr1.** The module the variant image embeds names its row
`KDA HKDF Sp800-56Cr1` at CAVP certificate `A7440`, with `Shared Secret Length:
224-2048 Increment 8` -- a narrower window than 4985's 224-8192, and one this
handshake's 256-bit shared secret and 256-bit derived output sit well inside.
The split is in the row names rather than in prose: `KDA OneStep SP800-56Cr2`
and `KDA TwoStep SP800-56Cr2` sit beside it in the same table, and section 2.10
of that policy (p. 22) states no attribution at all. Its
`KAS-ECC-SSC Sp800-56Ar3` row is the same shape as 4985's. The full rows are
in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests).

**Certificate 4985's Table 8 (Non-Approved, Not Allowed Algorithms)** contains
X25519 and X448 as its only key-agreement entries -- the counterpart table on
5438 is its Table 8, which names neither string -- corroborating what
[fips-provider-surface.md](fips-provider-surface.md) already records. `KDA HKDF`
and `KDA OneStep` are dual-listed there, non-approved only for key lengths below
112 bits and for SHAKE PRFs respectively; `KDA TwoStep` appears in no
non-approved table.

So the rejected option was *permitted* by the documents. It was rejected because
the platform cannot reach the service, the certified mode does not match, and
the certificate attests no composition -- not because the standard forbids it.
Any later account of this decision that says "we could not have done it" is
false.

## The risk this decision accepts

Every panelist across both panels raised the same one, and it is the actual cost
of the choice: if an assessor requires the derivation to read as SP 800-56C *by
construction*, or requires the validated KDA service to be invoked by name with
its tested parameter set, the retained schedule does not deliver that narrative.
Meeting such an assessor means writing the 56A/56C mapping out in prose after
the fact rather than pointing at a service invocation. That cost was accepted
against the reasons above, of which the first is the one that would have to
change for the balance to shift.

## Post-quantum horizon

None of the three public-key uses in Alcove's own protocol is post-quantum: the key agreement
(P-256 ECDH), the certificate and receipt signatures (ECDSA over P-256), and
the private set intersection's group (P-256). This section records what the
publications date, a position for each use, and what stays open.

### What the publications state

- **NIST IR 8547**, final, October 2026
  ([doi:10.6028/NIST.IR.8547](https://doi.org/10.6028/NIST.IR.8547)), lists
  ECDSA in Table 2 (section 4.1.1, p. 15) and Elliptic Curve DH and MQV in
  Table 4 (section 4.1.2, pp. 16-17) as quantum-vulnerable. Each row is at 112
  bits of classical security strength or more, deprecated after 2030 and
  disallowed after 2035.
- **Executive Order 14412** of June 22, 2026, section 4(b) (91 FR 38483, at
  38484), directs the Director of OMB to issue guidance requiring each agency
  to transition all high value assets and high impact systems to post-quantum
  cryptography for key establishment by December 31, 2030, and for digital
  signatures by December 31, 2031. Section 4(b)(i) excludes National Security
  Systems.
- **OMB M-26-15** of June 24, 2026 states neither date as a requirement. It
  requires a migration "with the objective of mitigating as much quantum risk
  as feasible by December 31, 2030" (section 3.A, p. 2). Its phases "should"
  migrate key establishment in 2028-2030 and signatures in 2031, and complete
  the migration by 2035 (section 3.D, pp. 4-5). It requires TLS 1.3 support
  no later than January 2, 2030 (Appendix A, section 4), and does not apply to
  national security systems (section 1).
- **IR 8547 attributes the two deadlines to the order and the memo jointly**
  (section 4, p. 13), and reads the memo as requiring the 2030
  key-establishment date of "other systems with highly sensitive data"
  (section 4.1.2, p. 17). Its own window
  "does not alter the earlier deadlines that apply to high value assets, high
  impact systems, and other high-sensitivity federal systems under EO 14412 and
  OMB M-26-15" (section 4, p. 13).

On IR 8547's reading the deadlines bind federal systems in those categories,
though the order only directs guidance and the memo does not itself state the
dates as requirements. Whether a system running Alcove is one is the agency's
classification, not Alcove's.

### Key agreement: NNpsk0 over P-256 ECDH

The handshake's Diffie-Hellman is an elliptic-curve DH, a Table 4 row. IR 8547
adds that, against harvest-now-decrypt-later attacks on network
communications, application-specific guidance "may require or recommend
migration to quantum-resistant key-establishment schemes before the classical
schemes are generally disallowed" (section 4.1.2, p. 17).

What the retained schedule does buy is a bound on harvest-now-decrypt-later.
The pre-shared secret is mixed into the chaining key alongside the ECDH output,
so a recorded transcript stays confidential against an adversary who solves the
Diffie-Hellman but never held the secret. That is the converse of the limit
recorded above, where forward secrecy covers a secret that leaks later. The
bound has two limits, both read from the spec:

- **A recorder who holds one secret.** A rotated secret's confidentiality
  against a party holding the secret it replaces "rests on the ephemeral
  exchange alone"
  ([PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation)). A recorder
  holding one secret who solves that handshake's Diffie-Hellman derives its
  session key and the next secret, and, solving each later handshake in turn,
  every later one.
- **A secret bootstrapped on a quick exchange.** A secret both parties save
  with `--save` is sent under the transport alone, because a quick exchange
  has no session key
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#bootstrapping-a-shared-secret)).
  A recurring exchange begun that way starts from a secret that is only as
  protected as that quick exchange's transport, below. One begun from
  `alcove invite` does not send the secret through the exchange server, but
  the invitation carries the setup secret over an out-of-band channel
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)),
  so that secret is only as protected as that channel.

ML-KEM is the only approved post-quantum key-establishment scheme based on
public-key cryptography, with ML-KEM-768 the recommended default parameter set
(IR 8547 section 4.1.2, p. 17). IR 8547 defines a hybrid key-establishment
mode as a combination of two or more key-establishment schemes, and a shared
secret key generated as specified in FIPS 203 "may be used as the value Z in the generic composite
mode" (section 3.2.1, p. 11). Taking a hybrid ECDH and ML-KEM exchange is a
wire-format change: the protocol-version tag changes, and peers on different
tags fail closed rather than negotiate, as peers on the earlier `kex-v1` and
`kex-v2` tags do
([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange)). Two
developments bear on the open decision below: an agency requirement for
post-quantum or hybrid key establishment, and hybrid support maturing in both
platforms' `crypto.subtle`, since reasons 1 and 5 above bind whatever primitive
replaces this one.

### Signatures: certificate and receipt, ECDSA over P-256

Both signing operations, the certificate self-signature and the receipt
signature, are ECDSA over P-256 with SHA-256 through `crypto.subtle`
([receipt-signing-fips-boundary.md](receipt-signing-fips-boundary.md)). ECDSA
is a Table 2 row, and the order's December 31, 2031 date is the signature
deadline for systems in its categories.

- **Candidates.** ML-DSA (FIPS 204) and SLH-DSA (FIPS 205) are the stateless
  post-quantum signature families IR 8547 lists in Table 3 (section 4.1.1,
  p. 16), beside the stateful LMS, HSS, XMSS, and XMSS^MT of SP 800-208.
- **What a change touches.** The certificate's format version and the signing
  identity's discriminant "move together with the signature scheme"
  ([PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning)),
  and a new key is a new fingerprint, which invalidates every pin a partner
  has recorded for the old one.
- **Measured.** ML-DSA-65 through `crypto.subtle` passes in Node and
  Chromium and fails in the `-fips` image's validated module, Firefox, and
  Safari ([measurement](#ml-kem-and-ml-dsa-through-web-crypto-measured-2026-10-28)).
  SLH-DSA has not been measured.

The signature plan is part of the open decision below.

### The private set intersection's group: P-256

The masking is an elliptic-curve construction over P-256 that no NIST
publication specifies
([COMPLIANCE.md, SC-13](../COMPLIANCE.md#nist-sp-800-53)), so no row of Table 2
or Table 4 names it.

**Replacement.** No source in this project's documentation or its reference
material describes a quantum-safe private
set intersection construction. Whether one exists that could replace the P-256
group is an open question, not a claim either way.

**What the spec establishes about the elements.** Each party's key is a random
scalar in the P-256 group, held only in memory for the exchange, and the wire
contains each party's values under its own key and one party's values under both
keys ([PROTOCOL.md](../spec/PROTOCOL.md#psi-base-function)). A value enters as
a hashed PSI set element
([PROTOCOL.md](../spec/PROTOCOL.md#linkage-participation-the-role-axis)), and
an encrypted element is a compressed P-256 point
([PROTOCOL.md](../spec/PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)).
The privacy of a non-matching value rests on neither side being able to strip
the other's key, and a linkage key built from too little PII is open to brute
force
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#private-set-intersection)).

**What stays unestablished.** The spec does not state the cipher's algebra: it
does not say that an element is the hashed value's curve point multiplied by
the party's scalar. The algorithm inventory in
[COMPLIANCE.md](../COMPLIANCE.md#cryptographic-algorithm-inventory) describes
that construction, and its note 1 states that the hash to the curve is read
from the engine's C++ source, not measured on the shipped binary: a reading
of source, not a statement of the spec. So the spec does not establish that
solving the discrete log on P-256 recovers a party's scalar from the elements
a transcript contains. If it
does, removing the scalars leaves the hashed values, which a dictionary search
over candidate identifiers matches: the brute force a weak linkage key is
already open to, extended to every linkage key. That chain is a stated limit,
not a finding.

**Per exchange type**, what a recorder who can solve the discrete log reaches:

- **A recurring exchange (SFTP or filedrop) and every WebRTC exchange.** The
  PSI frames travel inside AES-256-GCM under keys derived from the session
  key, and every channel requests that wrap
  ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it)).
  The session key derives from a chaining key that includes the pre-shared
  secret ([PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange)), so
  under the bound above the recorder does not reach the PSI elements; the two
  limits of that bound apply.
- **A quick exchange over SFTP.** It has no session key and no application-layer
  wrap ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#what-it-protects-and-from-whom)),
  so the PSI frames are protected by SSH alone, and the server's administrator
  reads them as the parties wrote them. A recorder who solves the SSH session's key exchange
  reaches what that administrator does, and the unestablished chain above
  decides whether that exposes the identifiers.
- **A quick exchange over filedrop.** Alcove applies no transport encryption;
  the share's protection is whatever the operator configures for it
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication)).
  A reader of the share or of an unencrypted path reaches the PSI elements
  without solving anything, and what the share's own protocol resists is
  outside this project.

On every type the partner receives the elements the base function sends it,
so against a partner who can solve the discrete log the wrap and the transport
do nothing, and the same unestablished chain applies.

### Transport key exchange

The open decision includes whether a plan also covers the transport layers'
key exchange.

- **SSH for SFTP.** The key-exchange list in
  [FIPS_SFTP_PROFILE.md](../FIPS_SFTP_PROFILE.md) contains only elliptic-curve
  and finite-field Diffie-Hellman methods, the two DH families Table 4 lists.
  The default offer measured on the wire inside the FIPS image lists only those
  two families
  ([FIPS_SFTP_PROFILE.md](../FIPS_SFTP_PROFILE.md#the-default-offer-measured-inside-the-image)),
  and an ordinary runtime's default adds only `curve25519-sha256` and its
  `@libssh.org` spelling, so neither default offers a post-quantum method. A
  quick exchange over SFTP relies on SSH alone.
- **DTLS for WebRTC.** A quick exchange never runs on WebRTC: the CLI refuses a
  secret-less `webrtc` run
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication)).
  DTLS therefore sits beneath the application-layer wrap on every WebRTC
  exchange and is never the only protection.

### ML-KEM and ML-DSA through Web Crypto, measured 2026-10-28

Reasons 1 and 5 above bind any replacement primitive to `crypto.subtle` in
both applications. So a hybrid key exchange and dual signing need ML-KEM-768
and ML-DSA-65 through Web Crypto in every runtime Alcove runs on, and, in the
`-fips` image, served by the validated module.

Each runtime was driven through the same calls:

- ML-KEM-768: `generateKey`, `encapsulateBits`, `decapsulateBits`, and a check
  that both sides' shared secrets are equal.
- ML-DSA-65: `generateKey`, `sign`, `verify`, and a check that `verify`
  rejects a changed message.

A runtime passes an algorithm only if every call for it passes. Results:

| Runtime | Version | ML-KEM-768 | ML-DSA-65 |
|---------|---------|------------|-----------|
| Node | v26.12.1 | Pass | Pass |
| Chromium | 156 | Pass | Pass |
| `-fips` image, its own fips-only configuration | Node v26.12.1 with OpenSSL 3.5.9; Amazon Linux 2023 FIPS provider 3.2.2, package `openssl-fips-provider-certified-so-3.2.2-1.amzn2023`; linux/amd64 and linux/arm64 | Fail: `generateKey` throws `NotSupportedError: Unrecognized algorithm name` | Fail: the same |
| `-fips` image, default provider in place of the module | The same image | Pass | Pass |
| Firefox | 159.0 | Fail: `generateKey` throws `NotSupportedError: Operation is not supported` | Fail: the same |
| Safari | 26.6.2, on macOS 26.6.2 | Fail: `generateKey` throws `TypeError: Type error` | Fail: `generateKey` throws `NotSupportedError: The operation is not supported.` |

What each row rests on:

- **Node and Chromium** were measured in the development container on
  2026-10-27 and 2026-10-28.
- **The `-fips` image** was built from staging at commit 71c09caab, for both
  architectures, which gave the same result. Under the image's own
  configuration the module was engaged: MD5 and a 1024-bit RSA key were
  refused, and the module's library was loaded. The module's algorithm
  listing names no ML-KEM or ML-DSA. With the default provider configured
  instead, every call passed. The image's Node can perform both algorithms;
  the validated module cannot.
- **Firefox 159.0** was the latest release Mozilla listed on 2026-10-28. It
  ran on macOS with a fresh profile and default preferences.
- **Safari 26.6.2** is not the newest Safari: Software Update offered Safari
  27.2, which was not installed and so was not measured.

### The dated wait

As of 2026-10-28, the hybrid key exchange and dual signing wait on three
runtimes. Each wait ends on its own trigger:

- **The `-fips` image's validated module.** The trigger is a FIPS provider the
  image can ship whose validation covers ML-KEM-768 and ML-DSA-65. Whether the
  wait also holds where the image's Node can make the calls outside the
  validated module is not decided.
- **Firefox.** The trigger is a Firefox release whose Web Crypto supports
  ML-KEM-768 and ML-DSA-65.
- **Safari.** The trigger is a Safari release whose Web Crypto supports
  ML-KEM-768 and ML-DSA-65. Safari 27.2 was offered and not measured, so the
  next check starts there.

When a trigger fires, that runtime is measured again with the calls above.
The hybrid key exchange and dual signing are reconsidered once every runtime
passes.

The signal to watch, as of 2026-10-29, is the
[WebKit blog feed](https://webkit.org/feed/). Its "WebKit Features for Safari"
post for each release would name ML-KEM or ML-DSA in Web Crypto. Safari is the
runtime furthest behind: no WebKit Bugzilla bug for either algorithm existed on
2026-10-29. When a post names them, the re-evaluation starts.

The other sources are read during that re-evaluation and on the periodic check,
not followed:

- **The `-fips` image's validated module.** CMVP sends no notification, so two
  pages are re-read by hand: the
  [certificate 5438 page](https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5438)
  for a change to its approved algorithms, and the
  [Modules In Process list](https://csrc.nist.gov/projects/cryptographic-module-validation-program/modules-in-process/modules-in-process-list)
  for a newer Amazon Linux 2023 OpenSSL FIPS Provider entering review. On
  2026-10-29 that list had no such entry. The
  [openssl-announce list](https://groups.google.com/a/openssl.org/g/openssl-announce/)
  carries the OpenSSL project's own announcements, which concern a different
  module from certificate 5438's, and the
  [Amazon Linux 2023 repository](https://github.com/amazonlinux/amazon-linux-2023)
  is the one channel from the image's base that was found.
- **Firefox.** Bugzilla bug 2084912, ML-DSA support
  (<https://bugzilla.mozilla.org/show_bug.cgi?id=2084912>), carries the
  milestone flags that show the release, and bug 1981476, the meta bug for
  modern algorithms in Web Crypto
  (<https://bugzilla.mozilla.org/show_bug.cgi?id=1981476>), tracks the rest.
- **The shared specification tracker.** Issues and pull requests in the
  [WICG `webcrypto-modern-algos` repository](https://github.com/WICG/webcrypto-modern-algos),
  which holds the specification every browser implements, move all the browser
  triggers.

These sources are re-checked quarterly, the maintainer's choice of 2026-10-29.
That check is a backstop to the WebKit feed and matters chiefly for the
validated module, which publishes no notifications.

### The open decision

The measurement does not choose a plan. The maintainer's direction for each use,
before the measurement, was:

- **Key agreement.** Measure first, then decide on a hybrid P-256 and
  ML-KEM-768 exchange. The measurement is above, and the decision has not
  been taken.
- **Signatures.** Dual-sign with ECDSA and ML-DSA before release if ML-DSA
  works everywhere; otherwise a dated plan after the hybrid, before 2031.
  ML-DSA does not work everywhere, so the second branch applies. This note
  records that branch as the standing direction, not as a new decision; the
  plan and its date are not written yet.

## Rotation moves to an independent secret

The specified rotation derives the next pre-shared secret from the session key
([PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation)), so its value
depends on the current secret's, which SP 800-57 Part 1 Rev. 5 section 8.2.3.2
calls key update and forbids to federal applications. The rotation-hardening
design derives the next secret from the handshake's key-agreement output and a
random value from each party, each sent AES-KW wrapped under a key derived from
the session key, so no input depends on the current secret's value. It claims
that value independence and not conformance to section 8.2.3.1's re-keying,
whose key-establishment method rests on the scheme this note leaves
unclaimed; the SC-12 sentence the build writes states the gaps. The
harvest-now-decrypt-later bound above is kept, because the wrapping keys still
mix the pre-shared secret with the ECDH output, so a recorder who solves the
Diffie-Hellman alone cannot unwrap either value. The design is built, as
specified in [PROTOCOL.md](../spec/PROTOCOL.md#shared-secret-rotation); its
record is in [rotation-hardening.md](rotation-hardening.md#the-next-secret-independent-of-the-current-one),
with the row's wording in its open questions.

## An approved key-agreement scheme, researched 2026-10-29

When this section was researched, the SC-12 row
([COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53)) claimed no SP 800-56A
Rev. 3 scheme and listed the gaps that follow; [The
build](#the-build-2026-10-31) records what was built. This section weighs
each scheme in that publication that could fit Alcove's two-party exchange
against the handshake in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange). Every
section and page cited from SP 800-56A Rev. 3, SP 800-56C Rev. 2, SP 800-57
Part 1 Rev. 5 and the FIPS 140-3 implementation guidance was read from the
publication; anything else is labeled unverified.

### The gaps a scheme could close

From the SC-12 row:

- **G1, the scheme.** Key establishment conforms to no approved scheme, while
  SP 800-57 Part 1 Rev. 5 section 8.1.5.2.3 states "Only approved
  key-agreement schemes shall be used" (p. 101). Section 8.2.3.1 re-keying
  rests on it: the replacement "shall be accomplished using one of the
  key-establishment methods discussed in Section 8.1.5" (p. 108).
- **G2, the hybrid form.** The next secret's derivation takes SP 800-56C
  Rev. 2's `Z || T` form without the scheme that form presumes.
- **G3, key confirmation.** The confirmation round is modelled on SP 800-56A
  section 5.9.2 and does not conform to it.
- **G4, the random source.** Which generator the rotation's two values come
  from is unmeasured.

No scheme closes G4, and none changes the composition disclosure: the schedule
stays application code above `crypto.subtle` calls
([above](#what-a-scoped-fips-claim-may-and-may-not-say-about-key-establishment)).

### What bounds every candidate

- **Primitives.** The `crypto.subtle` services
  [reason 1](#why-the-schedule-stays) lists include ECDH and no finite-field
  Diffie-Hellman or MQV, so of the
  fourteen schemes in Table 8 (section 6, pp. 65-66) only the five ECC CDH
  schemes can be built. The FFC schemes, Full MQV and One-Pass MQV are out.
- **The pre-shared secret can stay in the derivation.** Section 5.8.2 lists
  "pre-shared secrets" among the context FixedInfo may include (p. 54; also
  SuppPrivInfo, p. 56), and section 7 states FixedInfo "may include pre-shared
  secrets" while leaving them out of its security analysis (p. 112). SP 800-56C
  Rev. 2 allows the extraction salt to be "secret or non-secret", for example
  "a value already shared by the protocol participants" (section 5.1, p. 18).
  With the secret in the derivation, a recorder who solves the Diffie-Hellman
  without holding it derives no key, under every scheme below; without it, no
  scheme below keeps that protection.
- **The derivation.** Section 5.8 requires an approved key-derivation method,
  and Z "shall be used only by an approved key-derivation method ... and shall
  not be used for any other purpose", treated as a critical security parameter
  and destroyed immediately after use (p. 53). The Diffie-Hellman is a
  `deriveBits` call, which returns Z to application memory. Unverified: whether
  a `deriveKey` from ECDH to a non-extractable HKDF key keeps Z inside the
  platform on every runtime. SP 800-56C Rev. 2 states that RFC 5869 "specifies a version of" its
  extract-then-expand procedure (section 5.1, p. 20), and certificate 5438
  approves `KDA HKDF Sp800-56Cr1`
  ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests)).
  Unverified: whether an HKDF call with a secret salt is within that row's
  tested parameters. SP 800-108, which governs the expansion step, was not
  read.
- **The certificates test one scheme.** Certificate 5438's `KAS-ECC-SSC
  Sp800-56Ar3` row lists `Scheme - ephemeralUnified` alone
  ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5438-attests)),
  as 4985's does ([above](#what-the-primary-sources-actually-say)). FIPS 140-3
  IG D.F, Scenario 2, path (1), annotates a shared-secret computation "in one
  or more of the key agreement schemes in Section 6" (p. 172). Unverified:
  whether CMVP treats an `ephemeralUnified` row as covering a static-key
  scheme's computation.
- **A static key is its own key.** A digital-signature key pair "is not to be
  used for key establishment or vice versa" (section 5.6.3.2, item 5, p. 47),
  so the ECDSA signing identity cannot serve, and a static-key scheme adds an
  ECDH key pair per party.
- **The browser.** It makes the same calls with no module beneath them
  ([reason 5](#why-the-schedule-stays)). Under every scheme it can conform to
  the publication and nothing it runs is validated, as today.

### (Cofactor) Ephemeral Unified Model, C(2e, 0s, ECC CDH)

Section 6.1.2.2 (pp. 80-81). The handshake's Diffie-Hellman is already this
scheme's shared-secret computation.

- **Keys.** An ephemeral P-256 pair per party per run, and the pre-shared
  secret, as today.
- **Handshake and key file.** The schedule becomes one approved key derivation
  over Z, with the pre-shared secret as salt or in FixedInfo and the transcript
  in FixedInfo, yielding the session key, the confirmation key and the
  rotation's input at once. The rotation stops taking `ka`, since section 5.8
  confines Z to that derivation. The protocol-version tag changes; the key file
  does not.
- **Recorded traffic.** The protection survives, with the secret in the
  derivation.
- **Browser.** No change from today.
- **SC-12.** Closes G1 and G2. Whether the rotation then meets section 8.2.3.1
  turns on reading its derivation as part of that key establishment, which
  this section does not decide. G3 stays: section 6.1.2.3 does not incorporate
  key confirmation into this category, because "Without a trusted association
  with an identifier of either party, key confirmation cannot achieve the
  expected purposes" (p. 81). The round stays a protocol step, about whose
  adequacy section 6 "makes no statement" (p. 64). The scheme alone assures
  neither party of the other's identity (section 7.2, p. 114; Table 23,
  p. 121), which SP 800-57 section 8.1.5.2.3 lets the protocol supply (p. 101):
  here, the pre-shared secret.

Open: whether the existing `MixKey(dh)` step, an HKDF extract of Z under a
salt derived from the pre-shared secret, can already be treated as this
scheme's key derivation. The rotation's use of `ka` departs from section 5.8
either way.

### (Cofactor) Full Unified Model, C(2e, 2s, ECC CDH)

Section 6.1.1.2 (pp. 70-71): Z is the ephemeral and static computations
concatenated.

- **Keys.** Each party adds a static P-256 ECDH pair and holds the partner's
  static public key, received "in a trusted manner" (section 6.1.1, assumption
  5, p. 68), beside the ephemerals and the pre-shared secret.
- **Handshake and key file.** Two ECDH calls per party and the one derivation
  above. The key file, or a file beside it, holds the party's own static
  private key, which does not rotate, and the partner's pinned public key. The
  invitation can hold the inviter's public key, and the acceptor's can reach
  the inviter at first contact under the setup secret, as a signing pin does.
  Each party also needs assurance that the partner holds the static private key
  (assumption 6; section 5.6.2.2.3, p. 40). Obtained directly from the
  partner, conformance requires a One-Pass Unified Model or One-Pass
  Diffie-Hellman transaction with key confirmation, the recipient as party U
  (section 5.6.2.2.3.2, p. 41). C(2e, 2s) is not on that list, so each party
  runs one such transaction per partner key, or relies on a trusted third
  party, which the pinned self-signed model does not have.
- **Recorded traffic.** Survives only with the pre-shared secret kept in the
  derivation.
- **Browser.** It must keep a static private key across runs in browser
  storage, a long-lived secret the web application does not hold today: its
  exchanges pass no signing identity to the receipt step
  ([PROTOCOL.md](../spec/PROTOCOL.md#the-signed-receipt-step)), and its at-rest
  posture is the weaker one
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#why-the-browser-at-rest-secret-is-weaker-than-the-cli-on-disk-key)).
  A one-shot exchange has nowhere to keep it.
- **SC-12.** Closes G1, G2 and G3, since section 5.9.2 key confirmation
  applies (p. 61), with the certificates' tested-scheme question above open.

### The one-pass and static schemes

Each needs the Full Unified Model's static-key provisioning and browser
storage, and keeps the recorded-traffic protection only with the pre-shared
secret in the derivation. Each gives up forward secrecy against a static key's
compromise (Table 23, p. 121), which the key-agreement design keeps
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design)).

- **One-Pass Unified Model, C(1e, 2s, ECC CDH)** (section 6.2.1.2, pp. 85-88).
  - Keys: party U static and ephemeral, party V static only.
  - Handshake: V sends no ephemeral, and needs a nonce in the derivation to
    receive key confirmation (section 6.2.1.5, p. 92).
  - Recorded traffic: compromising V's static key may expose its past and
    future shared secrets (section 7.3, p. 116).
  - SC-12: closes G1, G2 and G3.
  - Its place in Alcove would be the possession-assurance transaction above,
    not the run's key agreement.
- **One-Pass Diffie-Hellman, C(1e, 1s, ECC CDH)** (section 6.2.2, pp. 96-97).
  - Keys: party U ephemeral only, party V static only.
  - Handshake: V sends no ephemeral, and V has no assurance of U's identifier
    (section 7.4, p. 117).
  - Recorded traffic: as the one-pass unified model, for V's key (p. 117).
  - SC-12: closes G1 and G2; key confirmation runs from V to U only
    (section 5.9.1, p. 61), so G3 stays open in one direction.
- **Static Unified Model, C(0e, 2s, ECC CDH)** (section 6.3, pp. 102-104).
  - Keys: both parties static only; U sends a nonce for the derivation
    (section 6.3, p. 102).
  - Handshake: no ephemeral keys at all.
  - Recorded traffic: Z is the same in every transaction between the two
    parties (section 7.5, p. 118), so a compromised static key exposes them
    all, past and future (p. 119).
  - SC-12: closes G1, G2 and G3.

### SP 800-56B

Not read: it is not in the reference library. Whether one of its RSA schemes
fits the exchange, and what the browser could do with one, is unverified.

### How this relates to the rejected recast

[The decision](#the-decision) rejected a recast that fed the handshake's
shared secret to SP 800-56C's two-step derivation with the pre-shared secret as
`T` in `Z || T`. Reasons 1 and 2 turn on the `KDA TwoStep` service; a
derivation over the HKDF row the schedule already lands on (reason 4) does not
call it. Reasons 3, 5 and 6 stand for the Ephemeral Unified Model as for that
recast: the composition stays unattested, the browser has no module, and the
schedule and transcript binding are rewritten. This section adds that the
derivation is not the only gap: the rotation's use of `ka` departs from
section 5.8 under either form.

### Recommendation

Do not adopt a static-key scheme. The Full Unified Model also closes G3, but
it adds a non-rotating private key per party in both applications, a
possession-assurance transaction per partner key or a trusted third party, a
long-lived key in browser storage, and a computation outside the certificates'
tested scheme, while the pre-shared secret still has to stay. The one-pass and
static schemes give up forward secrecy.

The Ephemeral Unified Model is the scheme the exchange fits. Claiming it
closes G1 and G2 with no new key material, on the scheme the certificates
test, and leaves G3 and G4. It is a build -- the derivation, the rotation's
input, a new protocol-version tag and its vectors -- so taking it is a
decision for the maintainer. Three questions above bear on its size: whether
`MixKey(dh)` can already be treated as the scheme's key derivation, which
would leave the rotation's input and FixedInfo; whether Z can stay inside the
platform; and whether an HKDF call with a secret salt is within the
certificate's tested parameters.

### The build, 2026-10-31

The maintainer ruled on 2026-10-29 to build the Ephemeral Unified Model with
`Z` passed through one approved HKDF call that takes no pre-shared secret, its
output split between the Noise `ee` input and the rotation, the schedule and
the confirmation round unchanged. The construction is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange) (The
key-agreement derivation); this records how the three questions above were
answered and what the build chose.

- **`MixKey(dh)` as the derivation.** Moot under the ruling: the derivation is
  a call of its own, and `MixKey` takes its first block.
- **Keeping `Z` in the platform.** `deriveKey` from ECDH to a non-extractable
  HKDF key was measured on 2026-10-30 on Node v26.11.1, Chromium 156,
  Firefox 157, WebKit 27.2 and the `-fips` image's Node v26.13.0 under its
  provider. Every runtime derives the key, refuses `exportKey('raw')`, agrees
  with the `deriveBits` path and with the peer, and refuses `deriveBits` on a
  private key whose only usage is `deriveKey`; Firefox alone accepts
  `extractable: true` on the derived key, which the build never requests.
  Scans of `/proc/self/mem` on Node and in the `-fips` image found `Z` in the
  process heap while the key was alive, under `deriveKey` and `deriveBits`
  alike, and gone after release and garbage collection. So `deriveKey` keeps
  `Z` out of every value application code can read, which the build enforces
  through the key usage and tests, not out of process memory. `Z` also crosses
  the module boundary between the ECDH and HKDF services, which certificate
  5438's security policy lists as API parameters (Table 20, p. 44). One path
  runs everywhere, with no fallback.
- **The certificate's tested parameters.** The CAVP record for A7440 lists, for
  `KDA HKDF Sp800-56Cr1`, the fixed-info pattern `uPartyInfo||vPartyInfo` with
  concatenation encoding, a derived-key length of 2048 bits, a shared-secret
  length of 224-2048 bits and SHA2-256, and no salting method. The planned
  `Label || Context || [L]2` layout and a 768-bit output were outside it, so
  the build carries the label and protocol name in each party's identifier,
  requests 2048 bits and uses the front 768. HKDF's expansion makes the blocks
  independent of the requested length, so the reshaping changes no value
  beyond the FixedInfo bytes. The default all-zero salt stays, and whether it
  was tested is not established by the record.
- **What else was chosen.** A third block keys the rotation history, which
  also consumed `Z`. The
  protocol-version tag stays, since pre-release formats take no bump. The
  all-zero safety check moves to the derived blocks, compared against the
  same derivation over a zero `Z`.
- **The pre-shared secret stays out of the derivation.** Each candidate secret
  would otherwise need its own call over `Z`, and the history proof, which
  must verify between sides holding different secrets, could not be keyed
  from it. A recorder who solves the Diffie-Hellman still derives no session
  key, because `MixKeyAndHash(psk)` precedes the `ee` step.
- **Forward constraint.** `deriveKey` takes `Z` alone, so a later ML-KEM
  hybrid that derives over `Z || T` in one call would need `Z` in application
  memory, or a second derivation chained after this one. The post-quantum
  decision ([The open decision](#the-open-decision)) takes that up.

## Open questions

Two questions the documents could not decide. Both are recorded as open rather
than glossed, because a confident answer to either would be a guess:

- **Whether the module accepts a caller-supplied byte string as the
  shared-secret input to its approved `KDA TwoStep` service.** The approved
  services table shows the key-derivation service with write access to the
  key-agreement shared secret, which implies import; the SSP table shows that
  same shared secret with an empty input cell and its related SSPs marked
  "Established using" the module's own key agreement, which implies it is only
  ever established internally. A positive answer is the one finding that would
  reopen the rejected option, and it is determined by driving the real module
  (`support/fips-probe/` and its four-leg attribution), never by reading more
  policy text.
- **How CMVP treats an operator-built composition of separately-approved
  components** under the FIPS 140-3 implementation guidance. The security policy
  does not address it, and the claim language above is written to be true
  whichever way it falls.

## How this was decided

The direction was decided by two independent expert panels, three panelists
each, one wave per panel, neutral framing, on a clean checkout. The first ran
with the SP 800-56C and certificate assumptions unverified and returned 3-0
for the retained schedule -- with every panelist conditioning that answer on
the assumptions being unread. The primary documents were then read directly
and the reading was re-verified by an independent agent working from the
same PDFs. The second panel ran with the verified findings supplied and
returned 3-0 for the same answer, on stronger grounds. Every quotation and
table row in *What the primary sources actually say* was produced by two
independent extractions from the source documents, and re-checked a third
time when this record was written.

The `deriveBits` collapse came out of the panels rather than the original
framing, and is part of the decision rather than an aside: it is where most of
the rejected option's value turned out to be reachable.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) -- the
  key-agreement decision this record extends.
- [PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange) -- the
  normative construction: wire format, mixing order, labels, and the
  protocol-version tag.
- [fips-provider-surface.md](fips-provider-surface.md) -- what a FIPS provider
  holds and reaches in the shipped image, and what the certificates approve.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
