---
title: "CLI WebRTC Partner Wait in Connection Attempts"
---

# The CLI's WebRTC partner wait, in fresh bounded attempts

*Status: decided on the maintainer's ruling (2026-09-27) and built, after a
real-broker measurement (2026-09-29). This note records why the CLI's long
wait for its WebRTC partner became a series of fresh connection attempts, the
measurement the design rests on, and the values chosen from it. Nothing here
is normative: the behavior and every budget are specified in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#connection-attempts) and its
[Budgets](../spec/WEBRTC_TRANSPORT.md#budgets) table. See
[docs/notes/README.md](README.md).*

## What it replaced

A CLI party's `peer_timeout_ms` can run to seven days. The wait used to hold
one broker registration for all of it, and a run presenting a minted relay
credential rebuilt its peer connection in place every 30 minutes, re-offering
under a new connection id while the replaced offer stayed answerable for a
15 s overlap, and an inviter followed a partner's new offer by rebuilding its
own connection.

That design had a documented failure: a browser inviter takes the first offer
it is handed, so one whose answer to the replaced offer arrived after the
overlap was refused. The browser's client still answered the new offer
automatically, the CLI's data channel opened on a connection the web app never
reads, and the CLI reported connected and then failed.

The replacement is the shape the web app's scheduled runs already use
([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#occupying-a-due-window)):
bounded attempts, each a fresh registration and peer connection with a fresh
credential. The design panel before the ruling split 3-1; the dissent held
that a CLI process does not share the browser's fragility and that cycling
adds broker churn. The measurement below is what answers the churn point.

## The measurement

Run on the host against the repository's vendored broker, in Docker on one
bridge network, plus one pass against the deployed staging broker behind its
CDN and nginx, and one against a local coturn. The results file and raw logs
are host-local and not in the repository.

| Question | Finding |
| -------- | ------- |
| Is the same derived id free again after a clean close? | Within milliseconds. `ID-TAKEN` only on a re-registration with no delay at all (13 of 200, each cleared by one retry 5 ms later); 0 of 50 at each of 10, 50 and 250 ms. Through the staging front, 0 of 30. |
| After an unclean teardown? | A paused process or a cut network holds the id about 88 s on the local broker (six runs), the broker's 90 s liveness timeout counted from the last heartbeat; about 59 s through the staging front, consistent with nginx's 60 s default read timeout (inferred, not verified). A killed process frees it at once. |
| The unregistered gap between attempts | Socket close to the next `OPEN`: median 2 ms, largest 39 ms, over 2120 prototype attempts with 0 `ID-TAKEN`. |
| Do two cycling parties converge? | 119 of 119 trials, none failing after connecting; 115 met in 2.7 to 7.1 s. The four slow ones (about 33 s) were inviter-first trials whose acceptor offered in the last 100 to 400 ms of the inviter's attempt. |
| Broker load | A scaled proxy (1000 three-second attempts per party, two parties): about 1.36 ms of broker CPU per registration, so about 1.4 s per party over seven days of ten-minute attempts; no RSS, descriptor or socket growth. |
| Relay attempts | Each relayed attempt left one werift refresh `Timeout` armed and one coturn allocation live; over 130 five-second attempts the timer count rose by one per attempt and held at 100 from about 500 s. Allocations expired on their 600 s lifetime. |

The proxy does not reproduce the real cadence, a NAT or lossy path, the front
proxy's per-connection cost, or the offer traffic of a ten-minute attempt.

## Decisions taken

**Attempt length: 10 minutes.** The binding constraint is the relay
credential's one-hour lifetime: a partner arriving at the end of an attempt
must leave the connection time to form and the exchange time to run before the
credential expires. Ten minutes leaves at least 50 (45 for a stretched last
attempt, below). It also equals the default rendezvous budget and the
browser's own wait, so a run at the default makes exactly one attempt and
behaves as before, and it is the cadence the load figure above was scaled to.
At that length the refresh timers and relay allocations a wait holds stay at
one or two. Shorter attempts would multiply both, and the boundary cost below,
for no gain the measurement showed.

**The last attempt stretches by up to half.** A remainder under half an
attempt is joined to the last one rather than given a registration of its own.
The longest attempt is then 15 minutes, still a quarter of the credential's
lifetime; a unit check holds that bound.

**The same derived id every attempt.** The measurement shows a clean close
frees it at once, and a per-attempt id would need a protocol change both
applications share.

**`ID-TAKEN` on a re-registration is retried, not reported.** After an
unclean teardown the id stays taken for up to the broker's 90 s, so a refusal
there is expected. The retry window is 2 minutes -- that timeout with margin
-- with waits starting at 0.5 s and doubling to 10 s, about fifteen tries at
most. A refusal that outlasts the window means something else holds the id,
most likely another run in the same role, and the wait fails saying so. A
first registration's `ID-TAKEN` keeps its meaning, the symmetric-role mistake,
and still fails at once.

**The acceptor stops offering 30 s before an attempt another follows.** The
four slow convergence trials are the mechanism: an offer taken in an
attempt's last moments is answered after that attempt is gone. Between two
CLI parties that costs one 30 s timer. With a browser inviter it is the
connected-then-failed case above, since the browser takes that offer and never
another. 30 s is above the broker's 5 to 6 s hold of an offer plus the time a
partner takes to answer, and costs a partner who arrives in it at most that
long before the next attempt offers.

**A partner already negotiating is not cut off.** The measured boundary cost
also included an inviter that had answered and was torn down anyway, the
failure then naming a partner who "did not offer". An attempt that reaches its
bound with the partner's description in hand gets the channel-open budget
instead.

**An inviter offered a new connection id after answering starts a new
attempt.** A new id means the acceptor abandoned the connection answered; the
fresh attempt meets the acceptor's next offer. This takes the place of
offer-following without rebuilding anything in place.

## What stays open

- A broker socket that drops mid-attempt still ends the whole wait, as before;
  the attempt cycle could start the next attempt instead, which was not in
  this change's scope.
- An offer delivered to an attempt in its last milliseconds is lost without an
  `EXPIRE`, since the id is registered again within about 40 ms; the
  acceptor's unreported-offer re-send (30 s) recovers it.
- Every relayed attempt leaves its allocation on the relay for its granted
  lifetime and one werift timer armed until it fires. A fired timer is not
  armed again (held by `webrtcTurnRefreshTimer.test.ts`), which is what keeps
  them from accumulating; retiring them needs a werift release that disarms
  the timer ([DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-behavioural-assumptions)).
