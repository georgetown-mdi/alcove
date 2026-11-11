---
title: "Managed Exchange Schedule"
---

# Managed exchange schedule

This document specifies the **schedule** of a managed exchange record: the `schedule` object's fields and bounds, what schedule entry writes, how the runner counts and catches up on elapsed windows, how it occupies a due window and what it does about a waiting app version and the operator's compromise response, how the window width absorbs clock skew, and the scheduled lines the command-line export writes.
It does not cover the rest of the record or how the browser persists it (see [MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md)), the guide to running a recurring exchange (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)), or the design rationale (see [managed-exchange-design.md](../notes/managed-exchange-design.md)).
Intended readers are security auditors and implementors.

## The schedule object

The optional `schedule` object holds the partnership-agreed run cadence, the
run window the two runners meet in, and the miss bookkeeping the retry policy
reads. It is present only when the operator saved the exchange as recurring;
an attended-only exchange omits it. Under the no-free-text rule in [Record
shape](MANAGED_EXCHANGE_RECORD.md#record-shape) it discloses no more than the [metadata-at-rest
analysis](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape) covers.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `anchor` | string (ISO 8601, UTC `Z`) | The instant of the first agreed window's open, the phase the recurrence counts from. Both parties persist the **same** `anchor`, agreed on out-of-band with the rest of the schedule, so both runners compute the same window opens. Stored UTC; a local-time cadence ("09:00 Tuesdays") is resolved to UTC at save and re-resolved only when the operator edits the schedule, so a daylight-saving shift does not silently move an unattended window. |
| `intervalDays` | integer, **1 through 366** | The recurrence period in whole days: the run window opens every `intervalDays` after `anchor`. A whole-day integer covers the daily, weekly, and monthly-approximated (for example 28- or 30-day) cadences the persona runs; sub-day cadences are out of scope for a partnership coordinated out-of-band, and calendar-month recurrence (the drifting "1st of the month") is not modeled -- an integer period keeps both runners' window computation identical without a shared calendar library. The ceiling is an annual cadence, the longest a partnership recurrence means anything at; it is also what keeps every window a surface renders on a calendar that exists (see [Every admitted schedule renders](#every-admitted-schedule-renders)). |
| `windowSeconds` | integer, **1 through 43200** | The run window's width: window *n* is open from `anchor + n * intervalDays` for `windowSeconds`. The width is chosen to dwarf realistic clock skew between the two machines (see [Clock skew](#clock-skew-and-the-window-width)); a several-hour width is the intended range, not a several-minute one. The structural floor is one second, but schedule entry enforces a UX-level minimum of **one hour**: width is the only skew mitigation the design has, so a seconds-wide window would guarantee perpetual self-inflicted misses. The ceiling is twelve hours, which sits below the shortest period the `intervalDays` floor admits, so no schedule this schema accepts can place two windows over one instant. |
| `nextWindow` | string (ISO 8601, UTC `Z`) | The open instant of the next window the runner plans to attempt. Derived from `anchor`, `intervalDays`, and the run bookkeeping (advanced past a completed or missed window), it is persisted rather than recomputed so a reader -- the runtime waking, or a next-visit surface -- sees the planned attempt without replaying history. After a miss it is the **next** window, never a sooner off-schedule retry: retry-at-next-window is the whole retry policy (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)). A runtime that wakes to find it in the past applies the catch-up rule below before anything else (see [Catch-up on wake](#catch-up-on-wake)). |
| `consecutiveMisses` | integer, at least 0 | The count of consecutive agreed windows that passed without a completed handshake, **regardless of which side was absent**: a window this runner sat out waiting for a peer that never arrived counts exactly as one this runner itself slept through (the latter recorded retroactively; see [Catch-up on wake](#catch-up-on-wake)). A `"succeeded"` outcome resets it to 0; a `"missed"` outcome increments it; **any other outcome leaves it unchanged**, because only a no-show signals the two runners are not meeting. A handshake that ran and failed (`"failed"`/`"desynced"`) means the partnership *did* meet, so it is a desync/attack question, not a coordination-drift one; a benign pre-peer failure (an `"input"` or `"terms-shortfall"` refusal) is likewise not a partner no-show. It drives only the reporting of a repeated-miss coordination problem, whose escalated state fires at **two** consecutive misses (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)); it never pauses the schedule and never changes `nextWindow`'s cadence. |

The object holds no operator-facing recurrence label, no timezone name, and no
window-outcome history: `anchor` plus `intervalDays` plus `windowSeconds` fully
determine every past and future window, `lastRun` already holds the most recent
outcome, and `recentRuns` the ones before it for display. `consecutiveMisses` is the only cross-window state the retry
policy needs.

Window *n* is the half-open interval from `anchor + n * intervalDays` to
`windowSeconds` later: an instant exactly at the close belongs to no window, so
a window is elapsed the moment it closes. Two consecutive windows never both
contain the same instant, which the two fields' own ceilings and floors settle
rather than a cross-field rule: the widest admitted `windowSeconds` is twelve
hours and the shortest admitted period is one day, so a width can never reach
the next open. Every open is computed by fixed-millisecond arithmetic
from the stored UTC `anchor`, never by a local-calendar date add -- a calendar
add moves the instant by the offset change on the week a party's zone shifts,
which is exactly when two runners can least afford to stop overlapping. The host
zone is read once, at entry, to resolve a local wall-clock cadence into `anchor`
(see the `anchor` row); no later computation reads it. Every stored instant
has the UTC designator, and one that does not -- from a hand edit or a
tampered artifact -- is refused rather than read against the host zone, which
would otherwise place the same record's windows differently on every machine.

The schedule is a **local-only** field, not part of the persisted
`exchangeFile` document: a reschedule is neither a terms change nor a credential,
so it must not force the re-invite a document change requires (see [Record
shape](MANAGED_EXCHANGE_RECORD.md#record-shape)), and the CLI would hold it inertly. Each party enters it
locally at save-as-recurring, agreed on out-of-band exactly as the terms and the
setup secret are (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
Normatively: neither the invitation wire format nor the exchange-file document
holds the schedule, and no schedule field is ever sent to a server or to the
partner over the wire. Two parties who enter mismatched values never share an
overlapping window and record mutual misses until they reconcile out-of-band --
a benign coordination failure, never a desync or an attack. The operational
framing is in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#where-the-schedule-is-agreed-on-and-where-it-lives).

Entry is implemented in `apps/web/src/recurring/scheduleEntryModel.ts` (the
validation, the resolution, and the cross-field condition) over the arithmetic in
`apps/web/src/psi/managed/managedSchedule.ts`; the form itself is the local-fields editor
in `apps/web/src/recurring/ManagedExchangeDetail.tsx`, which writes the schedule
through the store's one local-fields edit alongside the label and the max-age
policy.

### What entry writes

Entry composes the whole object from four values the operator types -- the first
agreed window's local date and time of day, the period in days, and the width in
hours -- plus three rules that are entry's alone:

- **The anchor is resolved once.** The host zone is read here and nowhere else,
  turning the wall-clock cadence into the stored UTC `anchor` (see the `anchor`
  row). Re-opening the form reads the anchor back on the operator's own clock,
  and a save that left every cadence field as it was **writes no schedule at
  all** rather than resolving again. A wall clock a zone skips or repeats does
  not round-trip, so re-resolving on an unrelated save (a label edit, a max-age
  change) could walk the agreed instant away from the partner's. Omitting the
  field, rather than writing back the object the form opened on, is what keeps
  such a save off the runner's bookkeeping too: `nextWindow` and
  `consecutiveMisses` live in this same object and advance under a page left
  open, so a mount-time snapshot written back would rewind them to a window
  already accounted for. The reuse is **per field**, not all-or-nothing:
  a save that edited one cadence field takes the anchor and the width from the
  stored object verbatim while the fields displaying them are untouched, and
  writes the rebuilt schedule because the operator moved something. The fields
  hold the cadence to the minute and the width to the hour, coarser than the
  record stores either, so re-deriving them from what they display would rewrite
  a stored value at a resolution the operator never saw -- an edit to the period
  alone silently moving an agreed anchor or width.
- **`nextWindow` is the first window not yet closed at the save**, not the
  anchor's own window. A cadence anchored to a date already past would otherwise
  hand [catch-up](#catch-up-on-wake) every window that elapsed before the
  partnership agreed on the cadence, and count each one a miss it never had.
  Entering a cadence while one of its windows is already open plans **that**
  window, so the run in progress can meet it.
- **`consecutiveMisses` starts at 0** on an edited cadence. The stored count
  speaks for windows on the lattice the edit replaced.

Entry also enforces the field bounds in the table above as its own validation, so
an out-of-range value is refused at the field rather than at the store write, and
the width floor of one hour that the schema's structural floor does not state.
Those bounds hold what the operator **enters**. A width the record already
states is shown back as the exact value it is rather than rounded, and stands:
one merely finer than the field's unit, 5400 seconds for an hour and a half, or
one below the floor from an import or a hand-edited record. The save holds its
seconds through untouched, with neither the unit nor the floor applied.
Rewriting it would change what the partnership agreed on without saying so, and
refusing it would block the form's other edits -- a label, a max-age policy -- on
a value the operator never typed. Only a width the operator changes takes entry's
bounds and the whole-hour rule the field asks for.

One cross-field condition is **reported rather than refused**. When
[`tokenMaxAgeDays`](MANAGED_EXCHANGE_RECORD.md#persisted-across-runs) is set and `intervalDays` is at or
past it, the stored secret lapses before the window that would have refreshed
it -- the partnership stops on a lapsed credential and recovery is a re-invite.
Entry states that in the bound's own terms ("must run or be renewed within N
days") and leaves the save available, since an operator who renews by hand is
entitled to the cadence. The policy remains opt-in and off by default, so the
condition is unreachable for an exchange that set no bound.

### Every admitted schedule renders

Every surface that shows a window formats the instant directly and has no
fallback for one no calendar has. What makes that total is the pair of ceilings
on `intervalDays` and `windowSeconds`: the window containing an instant, and the
first window after it, both then land within one period plus one width of that
instant, which is inside the representable range for any clock reading a machine
can hold. A period or width past the ceilings is refused by the schema, so it
never reaches a surface as a record at all. The attended list read parses
strictly and rejects wholesale on it, so the whole read fails and the
saved-exchanges list routes to its read-failed recovery surface. That surface's
separate per-entry diagnostic read is where the offending record is identified
and discarded. The display derivation also refuses a reading instant within one
period plus one width of the end of the representable range, which is the other
half of the pair.

**The unattended read is per-entry, not strict.** A wake reads the store one
entry at a time. An entry this build cannot parse is **skipped**, reported as
its own skip in the wake's diagnostic line, and every other due record still
runs. Such an entry holds an out-of-bounds period or width from an artifact
imported or hand-edited before these ceilings existed, or is any other record
this build cannot read, a failed migration among them. Such an
entry stays unparseable until an operator discards it, so a wholesale rejection
here would be standing rather than transient: no exchange in the store would run
unattended for as long as the entry sat there, with nobody present to meet the
recovery surface. The attended read stays strict precisely so the operator
does meet that surface, which is where a skipped entry is resolved.

The wake reads each record's [local sibling
state](MANAGED_EXCHANGE_RECORD.md#the-backup-and-import-markers-local-siblings-never-in-the-artifact)
the same way. A record whose sibling entry this build cannot parse -- a member
its shape does not name, a corrupted value, or a handed-off state an earlier
version wrote, which no current shape names -- is skipped as unreadable, and
every other record still runs. A sibling entry at a format version this build
does not read is not unreadable: it is read as absent and its record runs
([The local-state entry's format
version](MANAGED_EXCHANGE_RECORD.md#the-local-state-entrys-format-version)).

### Catch-up on wake

A runner does not tick while its machine sleeps, so a runtime can wake -- a
laptop reopened after a week on a daily cadence, the app relaunched after a
reboot -- with `nextWindow` in the past and one or more windows fully elapsed.
On wake, before attempting anything, the runner applies one catch-up rule:

- Every fully-elapsed, unattempted window counts as **one miss each**:
  `consecutiveMisses` is incremented by the count, and `lastRun` records the
  most recent elapsed window as `"missed"`. A window that opened at or after the
  operator's [compromise response](MANAGED_EXCHANGE_RECORD.md#the-operators-response-to-it) is the one
  exception: it is skipped rather than missed, on the rule [a due window under
  that response](#a-due-window-under-the-operators-compromise-response) takes.
- `nextWindow` advances past every fully-elapsed window to the first window not
  yet closed: if the current instant falls inside that window, the runner
  attempts it immediately; otherwise `nextWindow` is the first window opening
  after the current instant.

A window is **unattempted** when no run bookkeeping falls inside it. A
`"succeeded"` entry stamped after a window closed and before the next one opens
is that window's: the stamp is the run's completion, so a run met inside the
window can finish past its close, and a success in the gap follows that
window's verdict in time anyway. Any other entry in the gap speaks for no
window. A window that does have a `lastRun` was met, so it takes that entry's verdict from the
`consecutiveMisses` row above rather than counting as a miss, and its own
bookkeeping stands rather than being overwritten by the catch-up's `"missed"`
entry. The same reading determines the window still open at the wake: a
`"succeeded"` run inside it satisfies it, so `nextWindow` advances past without
an attempt -- which is how an attended run inside an agreed window discharges
that window -- while a run that failed inside it does not, leaving the rest of
the window attemptable. Bookkeeping the wake cannot stand behind determines
nothing: a `lastRun` whose `at` is stamped ahead of the wake instant -- a
forward-skewed clock, or a hand-edited record -- discharges no window, whether
the window it names has opened or not, so the schedule keeps planning that
window and attempts it while it is open. Deferring the verdict to a later wake
is the conservative direction: no agreed window is skipped on a stamp from the
future, and none is counted as missed before its close.

Catch-up applies these verdicts **window by window, oldest first**, never as a
net over the span: a `"succeeded"` window resets `consecutiveMisses` to 0 and
only the windows after it rebuild the count, wherever in the run that window
sits -- including the window still open at the wake, whose recorded success
resets the count the elapsed windows before it raised.

One window the walk does not visit is read the same way before it starts: the
window immediately preceding `nextWindow`, whose recorded `"succeeded"` run
resets the count. That window is where a run the schedule advanced past as
`"unattempted"` lands its outcome -- the advance can come while the other
context's run is still in flight -- so without this reading a completed exchange
inside an agreed window could fail to discharge the miss run, and the escalation
threshold could be crossed a window early. The reach is exactly one window: a
success further back sits behind windows the walk has already counted on their
own evidence, and leaves them counted.

Crossing the two-miss escalation
threshold during catch-up fires the repeated-miss surface at the wake -- which
is how a persistently absent party learns of a miss pattern late rather than
never (see
[managed-exchange-design.md](../notes/managed-exchange-design.md#retry-and-repeated-misses)).

The wake's bookkeeping write is **conditioned on the plan it read**: it lands
only while the stored `anchor`, `intervalDays`, `windowSeconds`, `nextWindow`,
and `consecutiveMisses` are still the ones the catch-up computed against, and is
dropped whole otherwise. Nothing serializes one wake's write against another's,
or against an operator's edit, so an unconditioned write could rewind
`nextWindow` and lower `consecutiveMisses` behind newer bookkeeping -- deferring
the two-miss escalation by exactly the misses it erased -- overwrite a re-plan
the operator had just made, or restore a count they had just cleared on the plan
the wake was running. A dropped write costs nothing: the next wake recomputes
the same rule against the stored plan.

The `lastRun` and standing condition a window's write holds are also
conditioned on the secret: each lands only while the stored record holds the
secret it is about, the one the record held at the runner's last read before
an attempt, or at the wake where no attempt was made. A
[re-invite](MANAGED_EXCHANGE_RECORD.md#the-operators-response-to-it) can land while a window is
occupied, between its attempts or after one it stopped, dropping `lastRun`
and clearing the standing condition.
The window's write then advances the plan alone, since the window was used,
and the record keeps what the re-invite wrote.

The import path is the rule's second consumer: an imported backup holds the
snapshot's `nextWindow`, typically in the past by the time the artifact is
restored, and the first wake after an import applies the same catch-up --
elapsed windows counted, `nextWindow` advanced to a live window -- before any
attempt.

### Occupying a due window

A window catch-up lands on and finds open is **occupied**, not waited out in one
call. The runner makes bounded re-attempts across it: each attempt waits for the
partner's runner up to the human-timescale budget both one-shot roles share,
clamped to what is left of the window -- as is each seat's registration with the
signaling server, bounded by the smaller of its own
[budget](WEBRTC_TRANSPORT.md#budgets) and that remainder -- and the next
attempt begins no sooner than a fixed pacing interval after the last one
started, up to a cap on attempts per window. One window-long wait would put the whole window on a single broker
registration surviving that long, and the pacing and the cap keep an attempt
that fails immediately from spending the window in a loop. The close bounds the
pacing interval and ends the occupancy in any case.

**A limit of the occupancy.** The lock is held per attempt, not per window. An
attempt that spends its full peer wait outlasts the pacing interval, so the next
attempt takes the [single-writer lock](MANAGED_EXCHANGE_RECORD.md#the-secret-is-a-linear-resource) back at
once. But an attempt that fails fast leaves the lock free for the rest of its
pacing gap, and a window whose attempt cap runs out before the close leaves it
free for the tail (see
[managed-exchange-design.md](../notes/managed-exchange-design.md#cross-tab-single-writer-locking-web-locks)).
An operator's own Run can take the lock in any such free interval and rotate
the shared secret. The occupancy does not attempt again after it: the attempt
after the Run finds its success stamped inside the window on the record it
reads (below) and ends the occupancy as `"succeeded"`, as catch-up would
discharge the same window. An attempt already under way when the Run's success
landed cannot write over it either: the write rule in [Recording a run
outcome](MANAGED_EXCHANGE_RECORD.md#recording-a-run-outcome) holds a failing run's entry off a success
stamped after that run began. An attempt that
instead meets that Run still in flight -- the lock spans its payload exchange --
is refused rather than queued, since the scheduled path takes the lock
fail-fast. A refused attempt neither uses up nor ends the window: the next
attempt is paced from its start like any other and reads the record again, the
rotated one included, and the pacing interval and the close bound the
refusals. A refusal does not count toward the attempt cap, and the window's
disposition is left to the attempts that took the lock; the window is
`"unattempted"` only where it closes with no such attempt. The pacing and the
cap are each app window's own: a second app window with the exchange open
occupies the same window with its own attempts, which can land in the first
one's free pacing gaps, so a window can see up to twice the attempt cap and two
attempts inside one pacing interval. A designed
inter-attempt yield -- one that makes the free interval wide enough for an
attended Run to take rather than leaving it to how an attempt happened to
fail -- is deferred rather than designed away.

An occupancy belongs to one record. Each wake dispatches every due record that is
not already occupying its window, so an exchange holding its own window open for
hours neither blocks nor delays a second exchange whose window opens during it.

Two boundaries the occupancy holds:

- **The window's close is reached as a no-show, never as an abort.** The last
  attempt's wait is clamped to the close, so a window nobody arrived in ends as
  the partner absence it is. Signalling the close through the run's abort instead
  would record the operator's own cancellation (see the `lastRun` `failureKind`
  row in [Persisted across
  runs](MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)), which is a different
  fact.
- **Nothing is re-attempted once the data exchange began.** Past that phase
  boundary this run's payload could already have reached the partner, so a
  re-attempt would disclose a second time. The boundary gates the retry rather
  than the failure's kind.

Within those, an attempt is re-made only for a partner who never arrived, for
a failure with no determinate local cause, and for a refusal of the
single-writer lock (above). A lapsed `expires`, a stored copy the
run cannot use, an unusable input, a shortfall against the standing terms, a refused disclosure, a failed rotation
persist on either side, and a handshake that failed closed each reproduce identically on the
next attempt, so each ends the window's occupancy where it happened.

The record itself is read on that same per-attempt cadence, and each attempt
runs the record that read returns -- its secret, input handle, document, and
max-age policy -- never the copy the window was claimed on, so an edit, a
re-pointed input, or an attended rotation reaches the attempts after it. The
same read ends the occupancy:

- A record deleted while its window is being occupied stops the attempts after
  the delete, and that window is accounted for nowhere, there being no record
  left to write its bookkeeping onto.
- A record whose schedule was dropped, or whose `anchor`, `intervalDays`,
  `windowSeconds`, `nextWindow`, or `consecutiveMisses` no longer match the plan
  the window was claimed on, stops the same way with no disposition: the
  window's conditioned write would be dropped, and the stored plan is the
  operator's.
- A record that lost its input handle, or holds no shared secret, stops with no
  disposition, as the passed-over records below do.
- A record whose `lastRun` is a `"succeeded"` entry stamped inside the window
  ends it as `"succeeded"`: another context met the partner in it.

The window's disposition folds every attempt it took, written once for the window
rather than once per attempt. A further disposition, `"skipped"`, is decided by
the record rather than by an attempt and so never reaches this fold (see [A due
window under the operator's compromise
response](#a-due-window-under-the-operators-compromise-response)):

| Disposition | The window | `consecutiveMisses` | Advance has a `lastRun` |
| ----------- | ---------- | ------------------- | --------------------------- |
| `"succeeded"` | an attempt completed the exchange, or another context recorded a success inside the window | reset to 0 | no -- the run recorded its own |
| `"missed"` | none did, at least one found the partner absent, and none failed in a way that proves the partner was met | incremented | no -- the run recorded its own |
| `"failed"` | its attempts failed, none of them on an absent partner -- or one of them proved the partner was met | unchanged | no -- the run recorded its own |
| `"unattempted"` | it closed with every attempt refused the single-writer lock, held by another context | unchanged | no -- the window has no bookkeeping |

The `"missed"` row folds rather than reading the last attempt because an attempt
that spent its whole peer wait has already answered the question the miss count
asks -- whether the two runners met in this window -- and pacing starts the next
attempt at once after a wait that long. Reading the last verdict alone would
therefore let one trailing transient failure record a window of no-show waits as
`"failed"`, which leaves the count untouched and loses the miss entirely.

A failure that **proves the partner was met** decides the same question the
other way, and outranks any absence the window found earlier. A handshake that
failed closed ran against a partner on the far end of an open channel, a
rotation persist fails only after that handshake succeeded and the terms
exchange derived the next secret, the partner's abort stating that it could
not save that secret is read after this side stored it, and any failure past the data-exchange
boundary postdates the handshake. Per the
[`consecutiveMisses`](#the-schedule-object) row, a partnership that met is a
desync/attack question rather than a coordination-drift one, so such a window
records `"failed"` and counts nothing. A failure with no determinate cause
proves nothing either way and leaves the fold to the absence above.

`"unattempted"` is the one disposition that is not an outcome the record can
hold. Another context was running this very record across the window, so the
window is that context's to account for rather than this runner's, and the
schedule advances past it recording neither an attempt nor a miss. A refusal
among attempts that took the lock leaves the fold to them, so one between two
no-show waits does not stop the window from folding to `"missed"`. The advance
can come while that run is still in flight, and its bookkeeping then lands in a
window already advanced past; a
`"succeeded"` one is credited at the next wake (see
[Catch-up on wake](#catch-up-on-wake)), while any other outcome it records leaves
the window uncounted. Every other disposition's `lastRun` is written by the run
itself, so the schedule advance has none and cannot contend with it.

Two records are passed over rather than attempted, each leaving its window
with no disposition at all -- the wake that finds the window elapsed counts it
exactly as one this runtime slept through:

- One with no persisted `workingDirectoryHandle`, which has no unattended read
  of the input at all.
- One whose runtime stopped while the window was still open.

The rules above are implemented in `apps/web/src/psi/managed/managedScheduleRunner.ts`;
the browser host that wakes them, and the installed-runtime gate that decides
whether it runs at all, are `apps/web/src/psi/managed/managedScheduleRuntime.ts` and
`apps/web/src/components/ScheduledExchangeRunner.tsx`.

### Applying a waiting app version between windows

The hosted app is deployed continuously, and a new deployment's service worker
waits behind a running page rather than taking it over (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#how-a-new-version-reaches-an-installed-app)).
An installed app left open to run its schedule may see no navigation for
weeks, so the runner applies a waiting version itself:

- **When.** Just before the first attempt at a due window, never between
  two attempts at one, so a window that has made an attempt runs its retries
  to its normal end and a version found meanwhile is applied before the first
  attempt of a later window.
- **What counts as waiting.** A worker other than the one controlling the
  page is waiting in the registration, read when the runner asks, or a
  takeover this page asked for has landed while the page still runs the
  code it loaded before it. A page loaded under the newest worker has
  nothing to apply.
- **How.** The runner tells the waiting worker to take over, waits for the
  page's controller to change, and then reloads the runner's own window, so
  the reloaded page loads under the new worker. The attempt is not made, the
  window is left with no disposition and no bookkeeping, and the reloaded
  page's first wake occupies the still-open window on the new code. Once the
  takeover has landed, the holds below are read again before the reload,
  since a run or a view may have started during the wait; one that has
  started defers the reload to a later window.
- **How long it waits.** The outgoing worker holds a takeover back until it
  finishes the work it has in flight, such as the route warm a page asks for
  when it loads. The runner waits 10 seconds
  (`APP_UPDATE_TAKEOVER_WAIT_MS`). Measured in Chromium against the built app
  on a loopback origin, a takeover landed 7 to 33 ms after it was asked with
  nothing in flight, and 27 to 322 ms when asked straight after a first load,
  while the outgoing worker was still warming the routes (about 9.7 MB of
  assets over the load and the warm; 10 trials each). The wait is about
  thirty times the slowest of these, which leaves room for the same warm over
  a real connection. A takeover that has not landed by then reloads nothing:
  the window makes its attempt on the current version, and the takeover lands
  when the outgoing worker lets it, to be applied before the first attempt of
  a later window.
- **The one exception to the holds.** A takeover the runner stopped waiting
  for cannot be withdrawn: the new worker takes over whenever the outgoing
  worker finishes its work in flight, which can be during a later run in any
  window, past every hold below. It is harmless with the worker as it is: the
  takeover claims each open window, which keeps running the code it loaded,
  and `CACHE_VERSION` is the same across deployments, so the takeover purges
  no cache from under that code. Only the reload is held back, and it waits
  for a later window's first attempt.
- **What a page warms.** A page that finds a worker waiting when it loads
  does not ask the outgoing worker to warm the routes, since the new worker
  warms them once it controls the page.
- **What holds it back.** Nothing is applied while any same-origin window
  holds or has queued for a record's single-writer lock (a run, a re-invite,
  relay enrollment, an import replace), or has its leave-page prompt armed (a
  live exchange, or an invite or accept form with a file loaded and not yet
  sent). Nothing is applied either while a view in the runner's own window
  shows what that page holds only in memory: a finished run's downloads or
  failure, a minted re-invitation, an unsaved edit to a saved exchange's
  settings, an import waiting on the operator's answer, a one-off exchange from
  its file onward, or a receipt check with anything loaded. A view in another
  window does not hold it back, since only the runner's window is reloaded. A
  hold lasts as long as its run or view does, and a lock state the runner
  cannot read holds it back too.
- **Which holder each hold is.** Each hold is one of four holders, by what
  releases it (`AppUpdateHolder`, `apps/web/src/utils/appUpdateHolder.ts`):
  - `"run"`: a record's single-writer lock, or a leave-page prompt armed by a
    live exchange.
  - `"file"`: a leave-page prompt armed by an invite or accept form with a
    file not yet sent, or a view holding an invitation, a loaded file, or an
    import waiting on the operator's answer.
  - `"results"`: a view showing a finished run's downloads or failure, or a
    minted re-invitation.
  - `"edits"`: a view holding an unsaved edit.
- **What the app states.** The update notice names each holder it finds,
  across windows and in its own, with how to release it, and states while the
  runner waits for a takeover that the page is about to reload. Leaving the
  notice unanswered declines nothing: the runner applies the update before the
  first window nothing holds it back from. A page the runner reloaded onto a
  new version states that once, from a session-storage note the runner leaves
  before the reload. A window that makes an attempt records on the record
  whether a hold kept a waiting update back, and which holders
  (`heldAppUpdate`), and the exchange's page states it.
- **How a new version is found.** Chromium looks for a redeployed worker at
  a navigation and when asked, and not for an open page that makes requests
  but no navigation (`apps/web/test/integration/serviceWorkerUpdateCheck.test.ts`,
  which does not wait out the browser's longer timers). The runner
  asks once an hour while it runs, starting an hour after its launch, whose
  own navigation is the first look.

An installed app running its schedule therefore trails a deployment by up to
an hour to find it, then its install, then until the first window after that
whose first attempt finds nothing holding the apply back, and one window more
when the takeover lands only after the runner has stopped waiting for it. A
page running no schedule -- an ordinary tab, or an installed app whose runner
is not running -- is never asked to look: it finds a deployment at its next
navigation, and trails it for as long as it stays open without one. Its
update notice applies a version it has found.

The apply is implemented in `apps/web/src/psi/managed/managedAppUpdate.ts`,
and what holds it back in `apps/web/src/utils/appShellUpdateHold.ts`.

### A due window under the operator's compromise response

A window that falls due while the record's standing condition holds the
operator's [response](MANAGED_EXCHANGE_RECORD.md#the-operators-response-to-it) is **skipped**, decided
before each attempt connects and read off the stored record rather than
re-derived from a failure. The reasoning is in
[managed-exchange-design.md](../notes/managed-exchange-design.md#telling-a-desync-from-an-attack).

A skipped window rotates nothing, and connects to nobody from the answer
forward: an answer standing when the window falls due leaves it unattempted
altogether, and one written while it is being occupied ends the occupancy where
it lands. Its bookkeeping is the same single conditioned write every other window
takes:

- `nextWindow` advances past it, so the runner meets the next agreed window and
  nothing re-decides this one.
- `consecutiveMisses` is left where it stood: the window ended on this device's
  own withhold rather than on a partner's absence, so it is no evidence about
  whether the two runners are still meeting, and it must not carry the
  coordination prompt a pattern of absences earns (see
  [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)).
- The advance carries a `lastRun` of `{"outcome": "skipped"}`, stamped at the
  instant the window was skipped. It is what the exchange's page and the
  between-visit notification read the skip from.
- No standing condition is raised or altered. The condition the answer rides on
  is the one an earlier failure raised, which the window's write leaves as it
  found it.

A window that opened under the response and was already elapsed when the runner
woke folds the same way in [catch-up](#catch-up-on-wake): it counts no miss, and
the `lastRun` the catch-up write carries for the most recent such window states
`"skipped"` at that window's close. A window that opened before the operator
answered is still a miss -- nothing held it back at the time.

It is not one of the three passed-over records above: those leave their window
with no disposition, to be counted as missed at the wake that finds it elapsed,
while this one is accounted for where it happened.

Scheduling resumes at the next due window as soon as the response is cleared,
which is the three acts that clear the condition holding it and nothing else
(see [The standing condition](MANAGED_EXCHANGE_RECORD.md#the-standing-condition)). The attended run is not
withheld: only the unattended path decides without the operator, and only the
unattended path is held.

## Clock skew and the window width

The two runners never exchange a clock reading; each opens and closes its window
by its own machine clock against the shared `anchor` and `intervalDays`, so an
overlapping window depends on both clocks agreeing closely enough. The mitigation
is width, not synchronization: `windowSeconds` is chosen to dwarf realistic skew
(a several-hour window against the seconds-to-minutes skew of a machine with any
working time source), so two reasonably-set clocks overlap comfortably and only a
grossly wrong clock on one side turns a scheduled run into a benign miss. The
design adds no time-sync protocol; a persistently miss-producing clock is a
local operational problem the miss reporting (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)) points
the operator at, resolved by fixing the machine's time source, not by the app.

## The command-line export's scheduled lines

The command-line export's cron and Task Scheduler lines state the record's
`schedule` (`scheduleTemplates.ts`, `scheduledRunCommand.ts`):

- **Time of day.** The hour and minute of `anchor` in UTC; its seconds are
  dropped, since both schedulers start a job on a whole minute. The panel
  tells the operator to convert the hour on a machine not set to UTC.
- **`intervalDays` of 1 or 7.** A daily line, or a weekly line on `anchor`'s
  UTC weekday, in both cron and Task Scheduler.
- **The Task Scheduler line.** A PowerShell `Register-ScheduledTask` command
  whose action runs the command under `cmd.exe`. A daily or weekly line
  starts at `anchor`'s UTC time on the day it is registered
  (`[datetime]::Today` plus the hour and minute), since its start date does
  not change which days it runs. Any other interval starts at `anchor`'s UTC
  date and time, built from their parts by `[datetime]::new`, since the
  interval counts from that date. The start time is stored with the machine's
  UTC offset at registration, so the task keeps that UTC time when a daylight
  saving change moves the machine's offset. It is not a `schtasks` command, since
  `schtasks` reads a `/SD` start date in the machine's own date format and
  turns each single quote in `/TR` into a double quote, which breaks the task
  for a folder whose name holds one.
- **Any other interval.** Task Scheduler states it directly
  (`New-ScheduledTaskTrigger -Daily -DaysInterval <intervalDays>`). cron
  cannot, so its line runs daily behind a shell test that lets the command
  through only when the whole days since `anchor`'s UTC date are a multiple
  of `intervalDays`. The days are counted from twelve hours before the time
  of day, so a run moved by less than twelve hours -- an hour converted to the
  machine's time zone, or a daylight saving change -- counts on its own
  window's day.
- **The window.** The command waits for the partner as long as
  `windowSeconds`, as `--peer-timeout` in the largest unit that states it
  exactly.
- **No schedule.** Both lines run daily at 02:00 and the command has no
  `--peer-timeout`.

A path the configuration names outside the folder is mounted at its own path
only when it holds no control character (U+0000-U+001F, U+007F) and no
bidirectional override or isolate character (U+202A-U+202E,
U+2066-U+2069). For such a path no docker command, cron line or Task
Scheduler line is composed and the panel tells the operator to move the
folder; the installed-alcove cron line is still shown, since that line names
no path. The characters it does not refuse are the direction marks U+200E,
U+200F and U+061C, the C1 controls U+0080-U+009F, and U+2028 and U+2029.
None of them is a line break to cron, so none can split a crontab entry; the
limit is that such a character can still appear in the mount text the
operator copies.

The one-off Windows command is a PowerShell command
(`powerShellJoinCommand`), where the Task Scheduler line's action is quoted
for `cmd.exe`. A token is left bare only when it starts with a letter, `_`,
`/` or a `.` followed by a letter, `_` or `/`, and holds only letters, digits, `_`, `.`, `/`, `:`, `=`, `@` and
`-`, or is an option of only letters, digits and hyphens after its dashes.
Every other token, and every token holding a placeholder, is a PowerShell
double-quoted string with a backtick before each `$`, backtick and
typographic double quote and each `"` doubled, so a `;`, `$` or backtick
in it reaches `docker` as text. The Windows CI suite
(`DockerLines.Tests.ps1`) runs generated lines holding each of those under
Windows PowerShell 5.1 against a `docker` stand-in.

The note on a path or name pasted between double quotes
(`PASTED_TEXT_ESCAPING_NOTE`) covers a Linux or macOS shell and PowerShell.
It has each exclamation mark written as `"\!"`, outside the double quotes,
since inside them bash keeps the backslash before one and zsh drops it. It
says a folder pasted into a `--mount` source cannot hold a `,` or a `"`, since
`--mount` reads its value as CSV, the reason `unmountableBindPaths` refuses
such a path. Its limit is a
`"` in a name pasted into a PowerShell line: Windows PowerShell 5.1 does not
pass one inside an argument to `docker` intact, so the note says it cannot be
pasted there rather than how to escape it.
The note does not cover a `%` in a folder pasted into the Task Scheduler
line, whose action runs through `cmd /c`.

