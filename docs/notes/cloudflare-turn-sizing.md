---
title: "Cloudflare TURN Sizing"
---

# Cloudflare TURN: what two relayed runs measured, and what a self-hosted relay answers

_Status: measured on 2026-10-27 and 2026-11-04; nothing here is decided or
built. It records two relayed CLI exchanges through Cloudflare's TURN service,
the cost per GB the second measured, the credential lifetimes Cloudflare's
minting endpoint accepts and what its relay enforced of them, and, per agency
security-review concern, whether a self-hosted coturn answers it where
Cloudflare does not. Nothing here is
normative: the transport's ICE rules are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#ice) and the confidentiality
argument in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it).
It builds on [webrtc-relay-deployment.md](webrtc-relay-deployment.md), which
holds the self-hosted coturn measurements, and
[turn-provisioning-governance.md](turn-provisioning-governance.md), which holds
the vendor and governance survey. See [docs/notes/README.md](README.md)._

## What was measured

Two host runs, each from a staging build of the CLI in its container image, on
an arm64 Mac. Both were agent-conducted and their records are agent-written,
each a proposal until the owner ratifies it. Each minted under a TURN key made
for the run and deleted after it. Every measured claim below names the run that
measured it.

The 2026-10-27 run, 09:31 to 09:42 US Eastern, relayed a small exchange. The
2026-11-04 run, 13:07 to 14:20 US Eastern, relayed a large one, read
Cloudflare's usage dashboard against the parties' own byte counts, and probed
the lifetime edges and what the relay enforced
([The 2026-11-04 run](#the-2026-11-04-run)).

### Credential lifetimes the minting endpoint accepts

The 2026-10-27 run sent each request as a `POST` to Cloudflare's
`generate-ice-servers` endpoint with a JSON body `{"ttl": N}`, or `{}` for none.

| ttl (seconds) | answer |
| --- | --- |
| none | 201, ICE servers |
| 0, 1, 30 | 400, `invalid argument` |
| 60, 61, 3600, 86400, 86401, 172800 | 201, ICE servers |
| 604800, 2592000, 2592001, 31536000 | 400, `invalid argument` |

- **Accepted (2026-10-27, at the values tried):** 60 through 172800 (48
  hours), and a request with no ttl.
- **Accepted (2026-11-04, the exact bounds):** a `ttl` of 60 through 172800
  seconds, inclusive. The run bisected each edge: 60 was accepted and 59 was
  refused, 172800 was accepted and 172801 was refused, and every refused value
  answered 400. These are the edges the 2026-10-27 values already bracketed.
- **Still open:** how long a credential minted with no ttl lasts. The
  2026-11-04 run found one still allocating at 60 minutes and did not look
  further ([What the relay enforced](#what-the-relay-enforced-of-a-credentials-lifetime)).
- **The answer states no lifetime.** It has `iceServers`, `urls`, `username`
  and `credential`, and no expiry or ttl field, so whoever mints has to track
  the lifetime it asked for. On 2026-11-04 the username of a credential
  minted with no ttl, a ttl of 60 and a ttl of 3600 was in each case 64
  characters with no leading 10-digit number, so it does not state an expiry
  either.
- **The URL list includes 443.** It lists `turns:turn.cloudflare.com:443?transport=tcp`
  and `turns:...:5349`, unlike the `credentials/generate` endpoint behind the
  relay record, which answered on 443 without listing it. Both are Cloudflare
  Realtime TURN, so the difference is between two endpoints of one vendor, and
  a deployment that calls `credentials/generate` still gets no 443 entry
  ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-3-self-hosted-or-managed)).

### A relayed exchange over TURN on 443 (2026-10-27)

- **Network.** Each party ran in a container whose firewall dropped all
  outbound UDP except DNS and admitted outbound TCP only to port 443. The run's
  counters show 17 UDP datagrams refused on each side.
- **Configuration.** Each party's `connection.turn` named
  `turns:turn.cloudflare.com:443?transport=tcp` with a credential minted for
  it. `alcove doctor relay` passed over TLS before the run.
- **Outcome.** Both parties logged "the data channel opened over candidate
  pair local relay, remote relay", exited 0, and matched 10 records.
- **Time to channel.** 20.1 s (A) and 19.0 s (B) from each party's first log
  line to the open channel; 19.7 s on A from "connecting through the
  coordination server". That window includes waiting for the partner, which
  started about 1 s later, and ICE; the log does not separate the two. The
  exchange then finished in 13.9 s.
- **Volume.** About 100 KB out and 105 to 110 KB in for each party over TCP 443,
  the coordination server's share included, for inputs of about 1.6 KB each.

### What the relay's certificate shows

The 2026-10-27 run read, on both 443 and 5349, TLS 1.3, issued by Google Trust
Services (`WE1`), subject `CN=turn.cloudflare.com`, SAN `turn.cloudflare.com`
and `*.turn.cloudflare.com`, the host name matched.

That makes one thing verifiable: the host answering on that name holds a key a
public authority certified for that name. The subject has a CN and no
organization, so the certificate says nothing about who legally operates the
relay. That comes from the contract with the vendor, not from the connection.

### What one allocation exposes

- **To Cloudflare:** each party's source address, since each allocation is a
  TLS connection from it; the timing of each allocation; its volume; and the
  credential used. This is inferred from the protocol; `alcove doctor relay`
  states the first of these to the operator before it connects.
- **Not to Cloudflare:** exchange content. The data channel is DTLS between the
  two parties, which the relay forwards without terminating, and every WebRTC
  exchange is also wrapped in the application-layer encryption keyed by the
  authenticated key exchange
  ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it);
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)). Neither run
  intercepted the relay path; the self-hosted runs did, and read only the
  STUN and TURN envelope
  ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-3-self-hosted-or-managed)).

### The 2026-11-04 run

- **What ran.** A staging build, commit `04b44a0d3a0a`, as a `linux/arm64`
  image on an arm64 Mac, 13:07 to 14:20 US Eastern. Two party containers each
  held 500,000 rows (a 17.8 MB input file each), with the firewall of the
  2026-10-27 run: outbound UDP dropped except DNS, outbound TCP admitted only
  to port 443.
- **Configuration.** Both parties' `connection.turn` named
  `turns:turn.cloudflare.com:443?transport=tcp` with a credential of `ttl`
  7200 minted for the run. `alcove doctor relay` passed over TLS first.
- **Outcome.** Both parties logged "the data channel opened over candidate
  pair local relay, remote relay" and exited 0, and both logged 333,830
  records matched. The run expected 250,000 from the shares it built and did
  not investigate the difference; the exchange runs 7 linking keys over
  synthetic values that repeat, which would add matches.
- **Time.** About 8 min 30 s on each side from the open channel to the result
  files.
- **Key.** The TURN key was made for the run and deleted after it.

### Cost per GB as measured on 2026-11-04

The two parties' firewall counters on TCP 443 gave the bytes in and out of
each; the sums were 263,790,237 B received from Cloudflare and 261,034,460 B
sent to it. The counters include the coordination server's few kilobytes.
The owner read Cloudflare's dashboard 33 minutes after the exchange ended: a
total of 250.17 MB egress and 250.4 MB ingress, "TURN Server App Egress &
Ingress", for the last 24 hours.

| dashboard "MB" taken as | egress / bytes the parties received | ingress / bytes the parties sent |
| --- | --- | --- |
| 10^6 bytes | 0.95 | 0.96 |
| 2^20 bytes | 0.99 | 1.01 |

- **A relayed byte is billed once.** Both ratios are near 1 and neither is
  near 2, so with both parties relayed through Cloudflare the dashboard counts
  each byte once as egress and once as ingress, with no second count for the
  relay-to-relay hop.
- **Cost per GB, past the free tier.** At the published $0.05 per GB of egress,
  a GB the parties receive from Cloudflare costs $0.047 (MB as 10^6 bytes) to
  $0.050 (MB as 2^20 bytes). The run was far inside the free 1,000 GB, so
  nothing was charged.
- **Caveats.** The dashboard's unit is "MB" with no stated base, so the ratios
  carry about 5% of uncertainty. The figures are for the whole TURN app, with no
  per-key figure; the owner had no other TURN servers, so they are the run's,
  plus the 2026-10-27 run's few hundred bytes and the runs' `doctor` allocations,
  immaterial at this volume. Egress was not under half the received bytes, so
  the dashboard had caught up at 30 minutes.

The 2026-10-27 dashboard read, about a minute after a run of about 200 KB per
party, showed 76 B egress and 244 B ingress. It could not be compared with the
counters, so no rate was computed from it.

Published, not measured (Cloudflare's TURN overview, FAQ and Realtime pricing
pages, read 2026-10-27): $0.05 per GB of egress from Cloudflare, with the first
1,000 GB each month free, shared with the SFU; traffic into Cloudflare is free.

### What the relay enforced of a credential's lifetime

All three were measured on 2026-11-04 with `alcove doctor relay`, which
allocates on the relay with a given credential.

- **A 60-second credential was not refused at 156 s.** A fresh credential of
  `ttl` 60 allocated at 3 s after minting and again at 156 s, 2.6 times its
  lifetime.
- **A credential minted with no `ttl` still allocated at 60 minutes**
  (3,625 s after minting). The run did not look past that, so its lifetime has
  no measured upper bound.
- **A credential under a deleted key still allocated.** Deleting the key took
  up to about 2 minutes to reach the minting endpoint: a mint at the moment
  the owner reported the deletion still answered 201, and a mint about 90 s
  later answered 404 `cannot find specified key`. A credential minted before
  the deletion allocated at 3,662 s after minting, as the first of those
  mints answered 201, and again at 3,767 s, after the 404: about 2 minutes
  past the owner's report of the deletion.

So a short `ttl` is not an allocation bound the run could see: a credential past
its stated lifetime, and one whose key was gone, still opened an allocation. The
run did not measure how long after expiry or deletion one stops working.

**Does a spec sentence rely on a short `ttl` bounding a Cloudflare allocation?**
No spec sentence relies on it. The spec's credential sentences concern the
credential the project mints for its own coturn relay, and none names
Cloudflare. Those sentences state that the expiry bounds when an allocation can
be opened, "not how long it lasts"; that the relay, "not Alcove, decides which
expiries it honors"; and that removing the key "does not end one already open"
([RELAY_CREDENTIALS.md](../spec/RELAY_CREDENTIALS.md#relay-credential-derivation), measured
against coturn on 2026-11-10). Files read for `ttl`, lifetime, expiry,
per-exchange and credential:
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md) (its one-hour and 600 s
figures are the project credential's and a TURN allocation's own granted
lifetime), [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) (no sentence on
credential lifetime), [PROTOCOL.md](../spec/PROTOCOL.md) and
[CLI_DOCTOR.md](../spec/CLI_DOCTOR.md). The Cloudflare run differs from the
coturn sentence in one respect: coturn refused an Allocate presenting a
credential past its expiry, and Cloudflare did not refuse one 96 s past a
60-second credential's.

### Browser access to the minting endpoint

On 2026-11-04 the minting endpoint answered both its preflight (204) and a
`POST` (201) with `access-control-allow-origin: *`, and the preflight allowed
the `authorization` header. A page on `https://psi.data-bridge.org` could
therefore call it by these headers alone.

## The open lifetime questions change no design choice

Every design in these records mints per exchange at exchange time and sets the
lifetime on every call, in minutes within a one-hour ceiling
([turn-provisioning-governance.md](turn-provisioning-governance.md#credential-service);
[No relay of its own](turn-provisioning-governance.md#no-relay-of-its-own)).
That lies inside the measured 60 to 172800 s, so a design never asks for a
value near either edge, and sets a `ttl` on every call, so the no-ttl default is
never relied on. The measured cap matches the "caller-set, up to 48 hours" the
governance survey read from Cloudflare's documentation: 172800 s is 48 hours
([turn-provisioning-governance.md](turn-provisioning-governance.md#relaying-through-a-third-party-managed-service)).

What the 2026-11-04 run leaves open is what bounds a Cloudflare allocation, since
a short `ttl` did not. No spec sentence relies on one for Cloudflare
([What the relay enforced](#what-the-relay-enforced-of-a-credentials-lifetime)).

## Does a self-hosted coturn answer an agency concern Cloudflare does not

Per concern. "Self-hosted" means the reference relay in
[`infra/relay/`](../../infra/relay/README.md), run by one party to the exchange.

| concern | Cloudflare | self-hosted coturn | does self-hosting answer it |
| --- | --- | --- | --- |
| Who operates the relay and sees connection metadata | Cloudflare, a vendor of the party that minted, sees both parties' addresses, timing and volume; the other party meets it only through the data sharing agreement | The party running it sees the same. Run on a cloud host, as the project's relay is, the host's provider can also observe its network metadata ([PRIVACY.md](../../PRIVACY.md#hosted-web-application)) | Yes, where the concern is a relay vendor outside the agreement: no third party runs the TURN sessions. Not where the concern is any cloud provider on the path |
| What the relay can read of the exchange | Nothing: DTLS plus the application-layer wrap | Nothing, the same way | No: the protection is in the exchange, not the relay, so the choice of relay does not change it |
| Metadata retention, and what is published about it | No retention period stated: none found on 2026-09-21 ([turn-provisioning-governance.md](turn-provisioning-governance.md#relaying-through-a-third-party-managed-service)), and none on the four pages read 2026-10-27 | Stated and checkable: at the reference's settings coturn writes no line for a successful allocation, and the journal deletes entries about 90 days after the newest in their file ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-the-relay-host-keeps)) | Yes: a reviewer asking how long relay metadata is kept and who reads it gets an answer only from the self-hosted relay |
| Compliance scope | Cloudflare's HIPAA page does not list TURN as in scope (inferred from absence, read 2026-09-21); its FAQ has a HIPAA/GDPR/FedRAMP question whose answer the 2026-10-27 read did not capture; it states FIPS 140-3 support for TURN over TLS (published, not measured) | No vendor to bring into scope; the relay is a new internet-facing system in the operator's own estate, under its own approval ([turn-provisioning-governance.md](turn-provisioning-governance.md#runbook-relay)) | Yes, for an agency that needs a BAA or an in-scope listing for every vendor on the path; whether the relay is a HIPAA conduit stays the agency's determination either way ([COMPLIANCE.md](../COMPLIANCE.md#hipaa-considerations)) |
| Operating cost | $0.05/GB past 1,000 GB a month (published); measured on 2026-11-04 at $0.047 to $0.050 per GB the parties receive, a relay-to-relay byte billed once. The largest exchange the relay record sizes moves about 3.2 GB, about $0.16 at the published rate (computed), and nothing while the month's total stays within the free 1,000 GB | About $9.80 a month held continuously at the smallest instance (computed from published rates, [webrtc-relay-deployment.md](webrtc-relay-deployment.md#provisioning-phase-by-phase)), plus redeploying for coturn advisories, holding the static secret, and keeping logs ([turn-provisioning-governance.md](turn-provisioning-governance.md#runbook-relay)) | Not a security concern; it is the price of the three answers above |

**In short:** self-hosting answers the relay-vendor and retention concerns, and
the compliance-scope concern where an agency requires every vendor on the path
to be in scope. It does not change what the relay can read, and the
certificate identifies neither operator.

## What remains open

| question | what would settle it |
| --- | --- |
| The dashboard's "MB" base, and whether a charged invoice matches its figures | Cloudflare's statement of the unit, or a billed month past the free 1,000 GB; the 2026-11-04 range of $0.047 to $0.050 per GB carries the unit's uncertainty |
| Cloudflare's retention of relay metadata | Cloudflare's answer; none of its pages read states a period |
| Cloudflare's answer to its own HIPAA/GDPR/FedRAMP question | A read of that FAQ answer in full |
| Whether the concerns above are the ones an agency reviewer raises | Asking one agency IT reviewer, with this note's measurements in hand |
| A no-ttl credential's lifetime, and what bounds a Cloudflare allocation after its credential expires or its key is deleted | Probing later: past 60 minutes for a no-ttl credential, past 156 s for a 60-second one, and past 2 minutes after a key's deletion; no design choice waits on them |
