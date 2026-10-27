---
title: "Cloudflare TURN Sizing"
---

# Cloudflare TURN: what one relayed run measured, and what a self-hosted relay answers

_Status: measured on 2026-10-27, with the cost per GB left unmeasured; nothing
here is decided or built. It records one relayed CLI exchange through
Cloudflare's TURN service, the credential lifetimes Cloudflare's minting
endpoint accepts, and, per agency security-review concern, whether a
self-hosted coturn answers it where Cloudflare does not. Nothing here is
normative: the transport's ICE rules are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#ice) and the confidentiality
argument in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it).
It builds on [webrtc-relay-deployment.md](webrtc-relay-deployment.md), which
holds the self-hosted coturn measurements, and
[turn-provisioning-governance.md](turn-provisioning-governance.md), which holds
the vendor and governance survey. See [docs/notes/README.md](README.md)._

## What was measured

One host run on 2026-10-27, 09:31 to 09:42 US Eastern, from a staging build of
the CLI in its container image, on an arm64 Mac. The run was agent-conducted
and its record is agent-written. The TURN key it minted under was made for the
run and deleted after it.

### Credential lifetimes the minting endpoint accepts

Each request was a `POST` to Cloudflare's `generate-ice-servers` endpoint with a
JSON body `{"ttl": N}`, or `{}` for none.

| ttl (seconds) | answer |
| --- | --- |
| none | 201, ICE servers |
| 0, 1, 30 | 400, `invalid argument` |
| 60, 61, 3600, 86400, 86401, 172800 | 201, ICE servers |
| 604800, 2592000, 2592001, 31536000 | 400, `invalid argument` |

- **Accepted:** 60 through 172800 (48 hours), at the values tried, and a
  request with no ttl.
- **Not settled:** the exact minimum (somewhere in 31 to 60), the exact maximum
  (somewhere in 172800 to 604799), and how long a credential minted with no ttl
  lasts.
- **The answer states no lifetime.** It has `iceServers`, `urls`, `username`
  and `credential`, and no expiry or ttl field, so whoever mints has to track
  the lifetime it asked for.
- **The URL list includes 443.** It lists `turns:turn.cloudflare.com:443?transport=tcp`
  and `turns:...:5349`, unlike the managed vendor in the relay record, which
  answered on 443 without listing it
  ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-3-self-hosted-or-managed)).

### A relayed exchange over TURN on 443

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

On both 443 and 5349: TLS 1.3, issued by Google Trust Services (`WE1`), subject
`CN=turn.cloudflare.com`, SAN `turn.cloudflare.com` and `*.turn.cloudflare.com`,
the host name matched.

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
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)). The run did
  not intercept the relay path; the self-hosted runs did, and read only the
  STUN and TURN envelope
  ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-3-self-hosted-or-managed)).

### Cost per GB: not measured

Cloudflare's dashboard, read about a minute after the run, showed 76 B egress
and 244 B ingress, against about 200 KB out across the two parties on the host
counters. The two cannot be compared, so no rate was computed. Either the
dashboard had not caught up, or it counts something other than these streams.

Published, not measured (Cloudflare's TURN overview, FAQ and Realtime pricing
pages, read 2026-10-27): $0.05 per GB of egress from Cloudflare, with the first
1,000 GB each month free, shared with the SFU; traffic into Cloudflare is free.

## The open lifetime edges change no design choice

Every design in these records mints per exchange at exchange time and sets the
lifetime on every call, in minutes within a one-hour ceiling
([turn-provisioning-governance.md](turn-provisioning-governance.md#credential-service);
[No relay of its own](turn-provisioning-governance.md#no-relay-of-its-own)).
That lies inside the measured 60 to 172800 s, so the exact minimum, the exact
maximum and the no-ttl default are all outside anything a design asks for. The
measured maximum also confirms the "caller-set, up to 48 hours" the governance
survey read from Cloudflare's documentation
([turn-provisioning-governance.md](turn-provisioning-governance.md#relaying-through-a-third-party-managed-service)).

## Does a self-hosted coturn answer an agency concern Cloudflare does not

Per concern. "Self-hosted" means the reference relay in
[`infra/relay/`](../../infra/relay/README.md), run by one party to the exchange.

| concern | Cloudflare | self-hosted coturn | does self-hosting answer it |
| --- | --- | --- | --- |
| Who operates the relay and sees connection metadata | Cloudflare, a vendor of the party that minted, sees both parties' addresses, timing and volume; the other party meets it only through the data sharing agreement | The party running it sees the same. Run on a cloud host, as the project's relay is, the host's provider can also observe its network metadata ([PRIVACY.md](../../PRIVACY.md#hosted-web-application)) | Yes, where the concern is a relay vendor outside the agreement: no third party runs the TURN sessions. Not where the concern is any cloud provider on the path |
| What the relay can read of the exchange | Nothing: DTLS plus the application-layer wrap | Nothing, the same way | No: the protection is in the exchange, not the relay, so the choice of relay does not change it |
| Metadata retention, and what is published about it | No retention period stated: none found on 2026-09-21 ([turn-provisioning-governance.md](turn-provisioning-governance.md#relaying-through-a-third-party-managed-service)), and none on the four pages read 2026-10-27 | Stated and checkable: at the reference's settings coturn writes no line for a successful allocation, and the journal deletes entries about 90 days after the newest in their file ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-the-relay-host-keeps)) | Yes: a reviewer asking how long relay metadata is kept and who reads it gets an answer only from the self-hosted relay |
| Compliance scope | Cloudflare's HIPAA page does not list TURN as in scope (inferred from absence, read 2026-09-21); its FAQ has a HIPAA/GDPR/FedRAMP question whose answer the 2026-10-27 read did not capture; it states FIPS 140-3 support for TURN over TLS (published, not measured) | No vendor to bring into scope; the relay is a new internet-facing system in the operator's own estate, under its own approval ([turn-provisioning-governance.md](turn-provisioning-governance.md#runbook-relay)) | Yes, for an agency that needs a BAA or an in-scope listing for every vendor on the path; whether the relay is a HIPAA conduit stays the agency's determination either way ([COMPLIANCE.md](../COMPLIANCE.md#hipaa-considerations)) |
| Operating cost | $0.05/GB past 1,000 GB a month (published). The largest exchange the relay record sizes moves about 3.2 GB, about $0.16 at that rate (computed); whether a relay-to-relay exchange is billed once or twice is not known | About $9.80 a month held continuously at the smallest instance (computed from published rates, [webrtc-relay-deployment.md](webrtc-relay-deployment.md#provisioning-phase-by-phase)), plus redeploying for coturn advisories, holding the static secret, and keeping logs ([turn-provisioning-governance.md](turn-provisioning-governance.md#runbook-relay)) | Not a security concern; it is the price of the two answers above |

**In short:** self-hosting answers the relay-vendor and retention concerns, and
the compliance-scope concern where an agency requires every vendor on the path
to be in scope. It does not change what the relay can read, and the
certificate identifies neither operator.

## What remains open

| question | what would settle it |
| --- | --- |
| Cloudflare's cost per GB, and how a relay-to-relay exchange is billed | Re-reading the dashboard's TURN usage once it has caught up, or a larger exchange whose volume dwarfs any lag |
| Cloudflare's retention of relay metadata | Cloudflare's answer; none of its pages read states a period |
| Cloudflare's answer to its own HIPAA/GDPR/FedRAMP question | A read of that FAQ answer in full |
| Whether the concerns above are the ones an agency reviewer raises | Asking one agency IT reviewer, with this note's measurements in hand |
| The exact lifetime bounds and the no-ttl default | Probes in 31 to 59 and 172801 to 604799, and reading a no-ttl credential's lifetime; no design choice waits on them |
