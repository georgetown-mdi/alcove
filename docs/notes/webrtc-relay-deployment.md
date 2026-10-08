---
title: "WebRTC Relay and Deployment Shape"
---

# The WebRTC relay, and the shape that deploys it

_Status: measured, with a recommendation and a proposed epic, and the
recommendation is now deployed and verified -- a relayed exchange has been driven
against the standing relay it recommended. This note stays the measurement
record. It records what TURN over TLS on 443 carried on two restrictive network
classes, what a per-exchange provisioned deployment costs and leaves behind, how
a self-hosted relay compares with a managed one, which shape the evidence
favours, and what the standing deployment of that shape then carried. Nothing
here is normative: the transport's ICE rules are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#ice), the confidentiality
argument in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
and the posture in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security). See
[docs/notes/README.md](README.md)._

## What was measured, and on what

Two substrates, because the first host to hold the measurement had no cloud
credentials.

- **A local Docker substitute**, for the first question only. coturn serving
  TURNS on 443/tcp, an nginx TLS front over this repository's own web-app image
  with the broker at `/api`, a TLS-terminating inspecting proxy for the second
  class, and both parties in this repository's own container image. Network
  classes were applied with `iptables` inside the restricted party's container,
  where a cloud network ACL would sit.
- **AWS**, for the second and third questions, and for a re-measurement of the
  first over a real internet path: two instances (the owner's ceiling), a
  restricted subnet whose network ACL denies UDP outright, a services subnet
  holding coturn, the web app with its broker, and the inspecting proxy, a
  publicly resolvable name per service, and a real certificate from a public
  authority.

**What the substitute cannot show, said plainly.** No field round-trip times, no
real NAT, no public certificate authority, no cost, and no address a party
outside the host can reach. The last of those turned out to matter: the
substitute's negative result for a CLI-to-browser exchange did not survive the
move to a real network, and the revision is recorded below rather than smoothed
over.

## Question 1: does TURN over TLS on 443 carry a restrictive network

Relay is forced by network shape in every row, because at the time these runs
were made no configuration could force it. The relay-only setting the runs
called for is
[`connection.ice_transport_policy`](../EXCHANGE_REFERENCE.md#connectionice_transport_policy),
which reaches the same path without arranging a network that blocks the direct
one.

Two classes, as scoped: **class A**, UDP blocked outright; **class B**, TCP/443
only, through an inspecting proxy.

### On the local substitute

| class | pair | completed | selected pair |
| --- | --- | --- | --- |
| A | CLI to CLI | yes, 3 of 3 | local `relay` over TURNS (TLS 1.3), remote `host` |
| A | CLI to browser | no; ICE never completes, the CLI exits at its 30 s channel budget | none |
| A | CLI to browser, CLI unrestricted (control) | yes | `host` to `host` and `srflx` |
| B, proxy CA untrusted on the CLI host | CLI to CLI | no; the run dies at the intercepted signaling WebSocket in 0.3 s | none gathered |
| B, proxy CA trusted on the CLI host | CLI to CLI | yes | local `relay` allocated through the proxy, remote `host` |

Three independent witnesses agree the class-A exchange was relayed: coturn's
per-session relayed byte counts, the restricted party's own socket table (only
the TURN host and the broker, both on 443), and a throwaway `getStats()`
instrument whose nominated pair is `relay` to `host` with all three
host-involving pairs failed. Both parties resolved the correct intersection.

Two consequences the substitute determined on its own merits. **werift verifies
the TURN server's certificate**: with the interception CA untrusted it gathers no
relay candidate at all, so TURNS through an inspecting proxy requires that CA on
the CLI host. And **an interception point at the relay reads the STUN and TURN
envelope only**, about 13 KB up and 11.5 KB down, while the linkage still
resolves correctly.

### Re-measured over a real internet path

The same exchange, restricted CLI on one instance and partner on another host,
through coturn on a public address with a public certificate.

| class | relay | completed exchanges | interrupted on purpose | rendezvous to data channel |
| --- | --- | --- | --- | --- |
| A | self-hosted coturn | 7 | 0 | 8.49 to 8.69 s |
| B | self-hosted coturn | 3 | 2 | 8.24 to 8.84 s |
| A | managed vendor | 1 | 0 | 15.27 s |
| B | managed vendor | 1 | 0 | 14.33 s |

Class A is a network ACL denying UDP in both directions and admitting TCP/443 to
the service addresses. Class B is the same ACL plus a route sending the services
subnet through the proxy's interface; the interception is confirmed per class
switch by reading the issuer of the certificate the restricted box is served,
which is the public authority under class A and the proxy's own CA under class
B. On class B the proxy read 13.2 KB up and 11.7 KB down of relay traffic in the
clear and the linkage still came out correct, which reproduces the substitute's
result on a real path.

### The consequence

**TURNS on 443 carried a real exchange for a CLI party on both classes**,
including through TLS interception once the proxy's CA was trusted on the CLI
host. On that evidence a DTLS-terminating WebSocket relay is not needed for the
CLI half: no network measured here forced one. Whether such a relay is built
anyway, and the application-layer wrap it would require, is a direction this
measurement does not decide; it removes the forcing case, not the option.

### The browser qualification, revised

The substitute measured a CLI-to-browser exchange failing on both classes, and
attributed it to the browser's offer: an mDNS-obscured host candidate that
werift does not resolve, plus a server-reflexive UDP address unreachable from a
UDP-blocked party, with no third option because the web client configures a
fixed STUN pair and no TURN entry. Three controls excluded the harness.

**On AWS the same attempt completed.** A restricted CLI on class A accepted a
browser party's invitation and the browser reported the exchange complete with
two matched records. The browser's selected pair was its own server-reflexive
UDP candidate to the CLI's relay candidate on the public coturn, nominated and
carrying about 11.8 KB each way; coturn logged the allocation over TLS 1.3 on
443 and a channel binding to the browser's reflexive address.

So the substitute's failure was a property of the substitute: its relay's
address was not reachable from the browser. The finding that survives is
narrower and still real.

- A browser with no TURN entry **can** reach a CLI party whose relay address is
  publicly reachable, because the browser sends UDP to the relayed transport
  address and the CLI never needs a candidate of the browser's.
- That path costs the browser outbound UDP to an arbitrary high port. A browser
  on a network of either class measured here has no candidate the CLI can use
  and no relay of its own, so **a browser-side TURN entry is still required
  before any restrictive-network claim about CLI-to-web is complete**. What is
  not yet measured is the case with the restriction on the browser's side.

That remains the open scope call: the web client's ICE list is a deliberate
choice with its own disclosure consequences, and adding a relay to it is work
this record proposes rather than performs.

## Question 2: what "exchange-provisioned" means

Two shapes, both stood up on the account. Six ephemeral cycles, then one shared
box carrying seven exchanges.

| shape | provisioned | to first frame | cost per exchange | cycles | orphans after the last cycle | the interrupted cycle |
| --- | --- | --- | --- | --- | --- | --- |
| ephemeral, per exchange | one t4g.micro, two elastic addresses, a second network interface, one security group, one TURN secret, one certificate, two DNS records | 94 s, over a 94 to 129 s range | about $0.002 per cycle | 6 | zero of every type | left nothing: zero of every type after its teardown |
| shared, per-exchange credentials | the same box, stood up once; per exchange only a freshly minted time-limited TURN credential | 8.6 s, plus 12 s of amortised bring-up | about $0.0001 | 7 exchanges on one box | no services instance and no addresses after teardown | one exchange interrupted mid-channel; the box carried the next one unchanged |

**Cost is computed, not measured.** Cost Explorer returned $0 with no
per-service grouping for the run's day and marked the figure estimated, which is
its published lag rather than the run's spend, and the account's month-to-date
read $0 in the closing inventory. Every figure above is arithmetic over
published on-demand rates this credential could not confirm through the pricing
API. Behind them: a t4g.micro services box at $0.0084/hour, a t4g.nano
restricted box at $0.0042/hour, a public address at $0.005/hour whether attached
or not, and a gp3 volume at $0.08/GiB-month. The ephemeral figure assumes the
measured cycle length of about five and a half minutes end to end, first API
call to post-teardown sweep, and counts the services instance, its two elastic
addresses, and its root volume; the shared figure assumes the box's 87 s
bring-up divided across the seven exchanges it carried plus each exchange's own
8.6 s.

The per-exchange arithmetic flatters the shared shape: a shared box is paid for
while it idles. At the same rates a t4g.micro holding one elastic address
continuously is about $9.80 a month whether it carries one exchange or a
thousand, and that, not the per-exchange cent, is the figure a deployment
decision turns on.

### Provisioning, phase by phase

Seconds. The last column is the CLI's own rendezvous-to-data-channel window,
read from the two log lines that bracket it.

| cycle | API create to running | running to SSH | SSH to TLS on both addresses | of which engine install | of which image load | rendezvous to data channel |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 19 | 23 | 46 | 13 | 11 | 8.559 |
| 2 | 19 | 21 | 46 | 13 | 11 | 8.587 |
| 3 | 19 | 22 | 79 | 51 | 11 | 8.521 |
| 4 | 20 | 22 | 46 | 14 | 12 | 8.697 |
| 5 | 22 | 26 | 51 | 13 | 12 | 8.493 |
| 6 | 19 | 21 | 46 | 14 | 12 | 8.240 |
| shared | 19 | 20 | 48 | 14 | 11 | 8.592 |

**Image delivery is what fills the dominant phase.** Bringing the services up
takes about twice as long as launching the instance, and installing the
container engine plus loading the image from an attached volume is 24 to 26 s of
that 46 s, roughly 30 percent of a whole 86 s bring-up, and 62 s of the one
120 s outlier where the package install ran long. That phase is an artifact of
the measurement's constraints, not of the shape: the credential could neither
bake a machine image nor pull from a registry. **A real deployment replaces it
with a baked image or a registry pull and pays neither the volume nor the
load**, which would take the ephemeral bring-up from about 90 s toward about
60 s. It does not remove the instance-launch and SSH-readiness phases, which are
40 s together and are the floor a per-exchange instance cannot go below.

### Three findings about the ephemeral shape

1. **A per-exchange DNS name runs against the partner's negative cache.** The
   zone used here answers with a 1800 s negative-cache TTL, so a name minted for
   one exchange can be shadowed by a stale non-existence answer at a partner's
   resolver for half an hour after it is created. The run did not have to
   observe this, because it reused one fixed name per service, re-pointed each
   cycle at a 60 s record TTL, and pinned the partner to the addresses the cycle
   had allocated. That mitigation is exactly what a real deployment cannot do:
   it has no channel to hand a partner an address out of band. A per-exchange
   name is therefore not a free naming choice, and a stable name with a
   rewritten address is the shape that works.
2. **A certificate cannot be minted per exchange from a public authority.** The
   run issued one certificate covering both service names and reused it across
   every cycle, because the authority used caps duplicate certificates at five a
   week and a sixth cycle would have failed. The ephemeral shape therefore
   already had to cache a long-lived credential across exchanges, which is a
   finding about the shape rather than an implementation detail. A per-exchange
   certificate needs a private authority whose root the partner already trusts,
   or a wildcard, or a name that does not change.
3. **Teardown of the per-exchange resources was clean; teardown of the
   surrounding fixture was not.** All seven cycles left zero instances, volumes,
   addresses, network interfaces, security groups, DNS records, and local
   certificates, including the cycle interrupted by killing the restricted party
   while its data channel was open. The one-time network fixture underneath them
   is where teardown needed a retry: a subnet, a route table, and the VPC did not
   delete on the first sweep, were reported loudly with their ids retained, and
   deleted on a second run. None of the three bills. The account's final
   inventory is byte-identical to the pre-run baseline.

## Question 3: self-hosted or managed

| option | class A | class B | setup | cost | credential and expiry |
| --- | --- | --- | --- | --- | --- |
| coturn on EC2 | carried | carried | one instance, one config file, one certificate, colocated with the broker | about $0.002 per ephemeral cycle, or about $9.80 a month held continuously, plus each address while unattached | REST-style: username is a Unix expiry joined to a fixed name, password is the base64 HMAC-SHA1 of that username under a static secret, minted per exchange with a one-hour expiry; the static secret itself minted per cycle |
| coturn on Fargate | not measured | not measured | not measured | not measured | not measured |
| a managed vendor's TURN service | carried | carried, with the limit below | a zone, a key, and one API call per exchange; no server to run | not on this account's bill; the vendor's own charge was not measured | one POST per exchange with a requested lifetime, returning a username and password valid for 600 s |

Fargate was never reachable: the credential the run used is denied the container
service outright, so the row is unmeasured rather than negative.

**Two operational catches, both predicted and both confirmed.**

The first is the credential path. The configuration schema has a shape for
exactly this, an ICE-provisioning endpoint returning time-limited STUN and TURN
credentials, and the CLI refuses a connection that sets it rather than ignoring
it ([CLI.md](../CLI.md#webrtc-exchanges),
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn)). So the
managed credential had to be minted out of band, per exchange, and written into
a static `turn` entry before the exchange started. That is the whole
awkwardness, and it is what prices wiring the provisioning call: without it,
using a managed relay means a script that mints a credential and rewrites a
config file between every exchange.

The second is the port. The vendor's credential response advertises STUN and
TURN on 3478 and TURNS on 5349, and **does not list 443 at all**. Both classes
here were carried on `turns:...:443?transport=tcp`, which the vendor answers
even though it does not advertise it. A deployment that took the vendor's URL
list at face value would configure 5349 and be blocked by exactly the networks
the relay exists for. The port that works has to be chosen and re-checked,
because nothing in the vendor's own response asserts it.

**The posture.** A TURN relay forwards DTLS without terminating it, so a managed
relay sees addresses, timing, and volume, and never exchange data. That is the
statement in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), and
this run measured it rather than assuming it: an interception point sitting on
the relay path read only the STUN and TURN envelope while the linkage resolved
correctly on both sides. The consequence for the deployment is that a managed
relay is an acceptable option and must not become the only one: **the shape must
let an operator point at a self-hosted relay instead**, which is what the
existing `turn` entry already allows and what the recommendation below keeps.

## The recommendation

**A shared, long-lived relay and coordination deployment with per-exchange
credentials, self-hosted coturn as the default and a managed vendor as a
supported alternative.**

The ephemeral shape works, and its failure mode is not the one that was
expected. Teardown is not the problem: seven cycles, two of them interrupted
mid-exchange, left nothing behind. The problem is that a per-exchange service
needs a per-exchange identity, and identity is the part that does not provision
in a minute. A name minted per exchange meets a half-hour negative cache at the
partner's resolver, and a certificate minted per exchange meets a public
authority's duplicate limit within a week of ordinary use. Both were worked
around here only by giving the partner its addresses out of band, which a real
deployment cannot do. Against that, the shape costs 90 to 130 seconds before the
first frame, against 9 seconds on a box that is already up, and buys an
isolation the DTLS layer already provides: the relay cannot read the exchange
whether it was created for this exchange or has been running for a year. The
shared shape's real cost is idle time, roughly ten dollars a month at the
smallest instance size, which is a price worth paying for two minutes of latency
and a solved naming problem.

Per-exchange credentials carry the isolation that matters. A TURN credential
minted per exchange with a short expiry, over a per-deployment static secret,
was measured on both classes; it bounds what a leaked credential is worth to the
length of one exchange rather than to the life of the deployment.

Ephemeral provisioning stays worth revisiting for one case this run did not
need: a deployment that must hold no address between exchanges. If it is
revisited, the first thing to fix is image delivery, and the naming and
certificate findings above are its design constraints, not details.

### What the standing deployment carried

The recommended shape is built, and the standing relay
([standing-relay-delivery.md](standing-relay-delivery.md)) carries a relayed
exchange. A CLI party with all outbound and inbound UDP dropped -- only loopback
allowed, so its only possible transport is TURN over TLS on 443 -- completed a
mutually-authenticated exchange over ten matched records against it, under a
per-exchange HMAC-SHA1 credential on a one-hour expiry. Host conntrack witnessed
that party's entire data-channel traffic crossing the relay, about 29 KB up and
36 KB down on 443.

Two operational findings came out of the bring-up.

- **The relay's own logs did not witness the bytes.** No per-session
  relayed-byte summary appeared in coturn's container logs, only a connection
  reset on teardown, which is why the figures above come from host conntrack
  accounting. At the reference's log settings coturn writes no line for a
  successful allocation at all
  ([What the relay host keeps](#what-the-relay-host-keeps)).
- **One credential username across back-to-back exchanges exhausts the
  allocation quota.** coturn's per-username quota interacts with the roughly
  eight-minute allocation linger a relayed run leaves behind, so reusing a
  username across rapid consecutive exchanges gets new allocations rejected
  mid-stream. Minting a fresh per-exchange credential name, which
  `mint-credential.sh` already does, avoids it.

### Does the coordination server leave the web app's deployment

**Yes, under this recommendation, in principle and not yet as scheduled work.**
A shared relay deployment is a service that has to exist and be addressed
independently of the web app; once that service exists, the peer-coordination
broker belongs beside it rather than mounted inside the app the browser loads
its code from. The broker is already a workspace of its own with a standalone
entry point, so nothing has to be extracted for that to be possible.

The bring-up stood the broker up by deploying the web app's own image and using
its mounted signaling path. A later measurement exercised the standalone entry
point. On 2026-10-03 the broker workspace's standalone entry point ran on the
standing relay instance beside coturn under systemd, behind an nginx TLS front
at its own name on port 8443, because coturn listens on 443. A browser inviter
built with `VITE_SIGNALING_SERVER_URL`, a CLI-to-CLI exchange and an
invite/accept pair each completed one exchange through it, and that deployment
was removed.

**The standalone broker is deployed as a standing service.** On 2026-10-05/06
the same shape went back onto the relay instance to stay, and its URL, at the
standing name on 8443, is the one the web app's build names. Its units, the
front's configuration and the certificate renewal are tracked in
[infra/broker/](../../infra/broker/README.md). What that deployment measured:

- **Reach.** From an outside machine with certificate verification on,
  `/api/health` through the front answered `200`, a signaling WebSocket opened,
  and `/` answered `404`.
- **An exchange.** A CLI invite/accept pair completed one exchange through it.
  Both parties ran on one machine with the built-in STUN default, so the run
  says nothing about the relay path.
- **Renewal.** One forced renewal through the installed script changed the
  served certificate and restarted the front; a run through the renewal unit
  outside the window left the certificate and the front as they were.
- **Memory.** The deployment cost the instance about 50 MB of available memory
  and about 105 MB more swap in use. coturn did not restart and no process was
  OOM-killed. A few minutes after start the broker used 54 to 62 MB and the
  front 8 to 13 MB.
- **Unit exposure.** `systemd-analyze security` scores the broker's unit 8.6,
  EXPOSED.
- **Logging.** The front's access log records the request path without its
  query string from 2026-10-07 on
  ([PRIVACY.md](../../PRIVACY.md#hosted-web-application)), and a test over the
  tracked configuration fails if it would log the query string again.

The deployment did not measure a renewal fired by the timer that changes the
certificate, a reboot, repeated crashes, sustained memory pressure, a
connection idle for ten minutes, a browser acceptor, a network admitting TCP to
443 only, or a scheduled liveness probe.

Two operational facts came with the 2026-10-03 run. The relay instance is a
t4g.nano with 412 MB, which carried coturn, the broker and nginx with no
headroom. A full-workspace `npm ci` on it OOM-killed coturn (restarted by systemd in about
8 s), so any install there must be scoped to the broker workspace or built
elsewhere.

The web app runs no broker and no other runtime service: the hosted app is a
static site with no server framework
([web-server-runtime-role.md](web-server-runtime-role.md)).

## The proposed epic

**A proposal for the owner to ratify.** Nothing in this section is filed,
scoped, or scheduled by this record.

`Done is: an alcove exchange reaches its peer-coordination and relay endpoints at a deployment separate from the web app's, with credentials minted per exchange, and a CLI party on a UDP-blocked network completes an exchange with a browser party through it.`

Candidate members, by title:

- **Encrypt the web PeerJS path once web has an authenticated handshake.** The
  measurement removes the forcing case rather than the item: no class measured
  here forced a DTLS-terminating relay for a CLI party, so the wrap is not on
  the critical path, and it stays scoped to whenever such a relay exists.
- **Evaluate replacing the vendored peerjs-server with a first-party two-peer
  rendezvous broker.** What the broker must be depends on where it is deployed,
  and this record answers that half: beside the relay, addressed independently
  of the web app.
- **Provision an ephemeral peer-coordination server per exchange.** Measured
  here rather than resolved on paper. The evidence recommends against it as the
  default and records the three findings any later attempt has to design around.
- **Drive a real TURN relay through the CLI WebRTC transport.** Discharged: the
  standing relay now carries a byte-witnessed relayed exchange for a UDP-blocked
  CLI party
  ([What the standing deployment carried](#what-the-standing-deployment-carried)),
  the "configured but unproven" limit that shipped in
  [CLI.md](../CLI.md#webrtc-exchanges) and
  [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn) is corrected
  to match, and the relay-only setting this record found missing is
  [`connection.ice_transport_policy`](../EXCHANGE_REFERENCE.md#connectionice_transport_policy).
  What remains is the field: a real-NAT path and a browser party against the
  standing instance.
- **New, and the one this record most motivates: give the web client a TURN
  entry.** Until the browser can offer a relay candidate of its own, no
  restrictive-network claim about a CLI-to-web exchange is complete, and the
  case with the restriction on the browser's side is unmeasured. The web
  client's ICE list is a disclosure decision as well as a connectivity one, so
  the item is a scope call before it is an implementation.
- **New, conditional on the coordination server leaving: remove the web app's
  server framework.** Done once the broker was deployed elsewhere; see
  [web-server-runtime-role.md](web-server-runtime-role.md).

## Logging and data handling

_Status: the logging settings, the registrar's line and the journal's age
limit are in the reference, and what coturn writes at those settings and under
`verbose` was measured on 2026-10-05 against the pinned image (4.18.0, arm64,
UDP client transport). The counters and the egress alarm below are proposed.
Per-session logging stays off; abuse is detected from first-party and aggregate
signals instead._

### What the relay sees

- The client's and the peer's IP addresses and ports, for every allocation,
  permission and channel binding.
- Timing: when an allocation opens, refreshes and closes.
- Byte and packet counts on each allocation.
- The credential's username, `<unix-expiry>:<name>`, which names a time and a
  fixed label, not a party ([README.md, Per-exchange keys](../../infra/relay/README.md#per-exchange-keys)).
- No exchange content: the channel is DTLS end to end and the relay forwards it
  without terminating it ([Question 3](#question-3-self-hosted-or-managed)).

### What the relay host keeps

**coturn.** At the template's settings (`log-file=stdout`, `simple-log`, no
`verbose`), coturn 4.18.0 writes no line for a successful allocation: not at
allocation, during the relay, or at expiry. No line it writes carries a client
IP address, a client port, a byte count or a packet count. What it does write:

- its start-up lines, and one process-level line on the first client request
  since start, holding no client data;
- an authentication failure, one `ERROR` line for each failed request, naming
  the credential's username and nothing else about the client
  (`ERROR credentials of user <1791212081:alcove> are wrong (message integrity
  does not match any auth secret)`). A client that retries for 15 s writes 31
  such lines, so a client sending bad credentials in a loop fills the journal
  and shows the usernames it tried, which is the disk-fill and the
  username-harvest vector; the journal's age limit below does not bound its
  size;
- a refused peer, one `ERROR` line naming the peer address a client asked to
  reach inside a denied range, without a port, the range, and the relay thread
  and session id (`ERROR A peer IP 10.1.2.3 denied in the range:
  10.0.0.0-10.255.255.255 in server 7 (session 007000000000000001)`). That is
  a party's private host candidate, so this line does name an address about a
  party, and the denial cannot be kept without it being logged at these
  settings. It names no client address and no username.

A quota refusal (error 486, allocation quota reached) writes no line. With
`log-file=stdout` coturn writes no log file: `/var/tmp` held only the pid file.
The lines go to the journal through the unit's `journald` log driver.
`log-min-level` (debug, info, warning or error) exists and the template does not
set it. `scripts/relay-logging-posture.test.mjs` holds the template to these
settings; it cannot see a coturn release change what they write, so a
base-image bump repeats the measurement.

**With `verbose`.** coturn adds, for each session, the username and realm on
nearly every line, the allocation lifetime, each permitted peer's IP address and
port, and `usage:` and `peer usage:` lines at close carrying packet and byte
counts for the client side and the peer side. The client's IP address and port
are written once, in the `closed (2nd stage)` line at close, so an allocation
still open has not yet had its client address written; every failed
authentication also writes that line, so each failed attempt's client address is
kept. `--Verbose` adds function traces and the size of each packet, about 22
lines a second when no client is connected, and no further identifying field.

**Prometheus.** The image has the endpoint built in, off by default; the
template does not enable it. Enabled on loopback, the default `/metrics` body
holds no IP address, no port and no username; its only label values are the
realm, the allocation `type` and the failure `cause`.
`turn_auth_credential_failures{cause}` equals the count of authentication-failure
`ERROR` lines. `turn_total_allocations` is a gauge of the allocations open now,
not a count of those made. The traffic series (`turn_traffic_*` and
`turn_total_traffic_*`) appear only after a session finishes. No series counts
distinct clients. `--prometheus-username-labels` adds the full username as a
`user` label on the eight `turn_traffic_*` series.

**The registrar.** One line a request (method, path, status), the path only in
its `/exchanges/<exchange-id>` form, and one line a write. A registration --
an enrollment, a rotation, a renewal, or a re-registration by the relay-owner
token -- is the issuance event: it is what makes the relay accept the
credentials both parties mint for that exchange. Its line is:

```
credential issuance: exchange=<exchange-id> time=<YYYY-MM-DDTHH:MM:SSZ> outcome=<registered|replaced|renewed|unchanged|revoked> authority=<relay-owner-token|proof>
```

`time` is the registrar's clock in UTC when it processed the request; `outcome` is what the
write did, `unchanged` for an enrollment repeating the key the exchange holds;
`authority` is the credential that authorized it. A revocation writes the same
line with `outcome=revoked`. No registrar line names the
caller's address, the key, the token, or the proof.
`scripts/relay-exchange-keys.test.mjs` holds the format, the outcomes, and the
absence of any address, key, token or proof in the whole journal across
registrations, revocations, refusals and a connection error.

### Retention and who reads it

- **Retention.** An entry is deleted within 91 days. `install.sh` installs a
  journald drop-in,
  [`journald-alcove-relay.conf`](../../infra/relay/journald-alcove-relay.conf),
  the one place the period is set: it keeps the journal on disk
  (`Storage=persistent`, under `/var/log/journal`), deletes archived journal
  files holding entries older than 90 days (`MaxRetentionSec`), and archives the active file
  after one day (`MaxFileSec`), since the age limit applies to archived files
  only. It applies to the host's whole journal, coturn's and the registrar's
  lines alike, so the reference deployment runs the relay on a host of its own.
  journald still rotates by size, so a flood of lines can drop entries sooner.
  `journalctl --disk-usage` shows what the journal holds.
- **Who reads it.** Whoever can read the relay host's journal: root and the
  accounts the host grants journal access, which on the reference deployment is
  the relay operator alone. Nothing in the reference ships a log off the host.

### Quotas against one exchange

The values `render-config.sh` substitutes by default, reviewed against the
largest exchange the specification sizes. `max-bps` is bytes a second for one
session, each direction separately (coturn's help text, below).

**What one exchange moves.** A PSI round moves `35 * (2*D_recv + D_send)` bytes,
at 35 bytes an encrypted element: the receiver's set once each way and the
sender's once
([PROTOCOL.md](../spec/PROTOCOL.md#role-resolution-and-work-minimization)). At
the largest measured exchange, 7,700,000 records a side over four linking keys
([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#a-round-between-two-hosts)),
with one distinct value a record:

- a round's larger direction, sender to receiver: `35 * 2 * 7,700,000` =
  539,000,000 bytes;
- a round, both directions: `35 * 3 * 7,700,000` = 808,500,000 bytes;
- four rounds: about 3,234,000,000 bytes, before the lists of matched records.

The largest single frame either party sends is `MAX_WEBRTC_FRAME_BYTES`,
268,435,456 bytes, and the clean close waits 5 min for the last frames to
drain ([WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#budgets)). The small
exchanges the relay has carried move tens of kilobytes.

| setting | value | what one exchange needs | outcome |
| --- | --- | --- | --- |
| `user-quota` | 6 | one allocation a party; each party mints its own username, and two parties on one relay at most two | kept |
| `total-quota` | 40 | two allocations an exchange at most, so 20 concurrent relayed exchanges, each lingering up to `max-allocate-lifetime` after its run; held under the 49-port relay range in `relay.env.example` | kept |
| `max-bps` | 2,000,000 | bytes a second a session, each direction: the largest frame takes 268,435,456 / 2,000,000 = 134 s, inside the 300 s close drain, and a round's larger direction 539,000,000 / 2,000,000 = 270 s | kept |
| `max-allocate-lifetime` | 600 s | a lifetime between refreshes, not a bound on the exchange: the 7,700,000-record exchange ran 25 minutes on a LAN, so relayed it needs its client to refresh, which RFC 8656 provides for; that werift and the browser do so past 600 s is unmeasured | kept |

**The `max-bps` unit.** coturn's help text defines it as the default maximum
bytes-per-second a TURN session may handle, input and output streams treated
separately, so 2,000,000 limits each direction of one session to 2 MB/s. The
unit is from the help text; no throughput was measured against the limit.
`relay.env.example` states the same unit.

### Aggregate counters and the egress alarm (proposed)

**Counters, proposed: coturn's Prometheus endpoint, on loopback, with
per-username labels off**, read on the host by a timer that records the
aggregate values -- allocations an interval, bytes relayed, authentication
failures -- and nothing per session. Against a host-side counter (packet
counters on 443 and the relay port range): those give bytes but not
allocations or authentication failures, and a distinct-client count from the
host would mean keeping addresses. coturn's documentation is not vendored in
this repository or reachable from the development container; the choice rests
on the endpoint coturn's help text describes (port 9641, path `/metrics`, an
option for username labels). Of its series (above), none carries an address
or, with labels off, a username, and none counts distinct clients, so that
counter is dropped rather than taken from addresses. Bytes relayed appear only once a
session finishes, so a long-lived session is not counted until it closes.

**Egress alarm, proposed: a CloudWatch alarm on the instance's `NetworkOut`
sum over one hour above 5 GB, notifying the relay owner through an SNS topic.**
The threshold is about one and a half of the largest exchange above (3.2 GB),
so one exchange does not trip it and two concurrent ones may. At `total-quota`
40 and 2,000,000 bytes a second an allocation, the most the
relay forwards is 80 MB a second, about 288 GB an hour, which trips it within
the first period.
The metric is the instance's own, aggregate, with no per-session content.

### Verbose logging for incident response

If a customer's incident-response requirement asks for session records, the
setting is coturn's `verbose`, turned on for that deployment only. The fields it
adds are listed under What the relay host keeps. It writes the client address
and byte counts for each session, so the journal's retention (within 91 days)
then bounds how long those are held, and a shorter period is a deployment's own
change to the drop-in.

## What remains unmeasured

| question | the one thing that would determine it |
| --- | --- |
| Real partner and agency networks | a run from a machine on one, which the owner scoped as a follow-on rather than a blocker |
| A restrictive-network browser's registrar path (the browser itself is measured) | on 2026-10-03 a staging web-app browser with outbound UDP refused, TCP admitted only to 443 of the relay and the app, accepted a CLI invitation naming the standing relay and completed over a relayed pair (local relay, relayProtocol tls), with the CLI unrestricted and with the CLI blocked the same way, relay-to-relay. The blocked CLI exited 73 because the registrar on 8443 was unreachable; what remains is the registrar on 443, which is the follow-on item for the standing broker service |
| The standing relay across real NAT | a relayed exchange between two parties on separate networks, rather than the two on the relay host the bring-up ran |
| A browser party against the standing relay | the same relayed exchange with a browser on one side of it |
| coturn on Fargate | a credential granted the container service; the one used here is denied it outright |
| Whether the account's real cost matches the computed figure | reading Cost Explorer a day later, once its lag has passed |
| The managed vendor's own charge | the vendor's bill, which never appears on this account |
| The standing broker on 443, and across a reboot, repeated crashes and memory pressure | the broker on 443 once coturn and the front share that port, and an instance reboot, a repeatedly killed broker and an exchange under memory pressure, each observed on the standing deployment ([Does the coordination server leave the web app's deployment](#does-the-coordination-server-leave-the-web-apps-deployment)) |
| A relayed exchange longer than `max-allocate-lifetime` | a relayed run past 600 s, which shows whether werift and the browser refresh their allocations; every relayed run measured here took seconds |
| Whether coturn reports usage or metrics mid-session for a long or high-volume allocation | one relayed session longer than `max-allocate-lifetime`, with its usage and `/metrics` read while it is open; the host run's sessions were short |
| Published rates | a credential with pricing-API access; no rate behind any figure here was confirmed from AWS's own API |

## Stated limits

- **The services box is colocated.** The relay, the web app with its broker, and
  the class-B inspecting proxy shared one instance, because the owner's ceiling
  is two instances and the restricted party held the other. An instance-level
  failure would take relay, signaling, and interception together, and a real
  deployment separates them. Nothing measured here depends on their separation.
- **Class B did not cover the managed relay's path.** The interception is a
  route sending the services subnet through the proxy, and the vendor's relay
  address is not in that subnet: the network ACL admitted it on 443 directly,
  out through the internet gateway. The managed relay's class-B row is therefore
  measured as UDP-blocked and TCP/443-only, **without** an inspecting proxy on
  the relay path. Only the signaling path was intercepted in that row. The
  self-hosted rows carry the full class, relay included.
- **The network ACL pinned one vendor address.** The vendor's name resolved to a
  single address, which the ACL then named; a real restrictive network cannot
  pin a managed relay that way, and a vendor whose address set rotates would
  need a broader rule.
- **Question 1's substitute.** Its CLI-to-CLI results are corroborated by the
  AWS runs. Its CLI-to-browser negative result is superseded by them, as above.
- **Two rows in the raw results are harness defects, not network results.** The
  first cycle's first two attempts failed because the CLI was invoked with the
  wrong argument shape and exited before opening a socket. They appear in the
  per-exchange record as failures and are not class-A failures.
- **The CLI reports no candidate pair.** It calls the statistics API nowhere, so
  every candidate-pair fact here comes from the relay's own logs, the restricted
  party's socket table, or a throwaway instrument. The remote party's selected
  candidate was never read on any row.
- **A relayed exchange does not exit when it finishes.** On both substrates the
  process wrote its result and then held for minutes; on AWS the harness stopped
  it after a 90 s grace on eleven runs, so every completed row records a killed
  process rather than a clean exit. The exchanges themselves completed and both
  sides resolved the correct intersection. This is a CLI behaviour the
  measurement exposed and is filed separately, not a property of any shape here.
- **Every cost figure is computed from published rates**, not read from a bill.
- **The exchange measured is small.** Two matched records over a dozen linkage
  keys, tens of kilobytes on the wire. Nothing here bounds a relay's behaviour
  under a large exchange.

## Addendum, 2026-09-22: where the credential derivation landed

The per-exchange credential this record recommends has a specified derivation:
each party derives a relay key from the exchange's shared secret and mints its
time-limited relay credentials from that key
([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)). The
invitation may name the inviter's relay, addresses only, and the accepting
party relays through it; each party's own relay is the fallback where the
invitation names none
([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)). The relay's
per-exchange key table, with registering and revoking a key, follows it.

The next step is the browser's own TURN entry, which
[The browser qualification, revised](#the-browser-qualification-revised) found
still required before any restrictive-network claim about a CLI-to-web
exchange is complete.
