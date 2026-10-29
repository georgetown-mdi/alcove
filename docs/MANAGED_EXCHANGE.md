---
title: "Recurring Web Exchanges"
---

# Running a recurring exchange in the web app

This guide is for the person who keeps a partnership running from the web app:
an analyst or program staff member who has run one exchange with a partner (see
[WEB_APP.md](WEB_APP.md)) and wants to run it again on an agreed schedule, in
the browser, without a new invitation each time. It covers saving the exchange,
installing the app so runs happen with nobody present, the schedule, what each
run does, moving the exchange to another device or to the command line, what to
do when a run fails, the accounting of disclosures, backups, and removing the
exchange.

If your organization has IT staff who can run installed software, run the
exchange from the command line under your system's scheduler instead: see
[Scheduling the run](CLI.md#scheduling-the-run). The stored record is specified
in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), the threat
model for what the browser keeps is in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges),
and the design decisions are in
[managed-exchange-design.md](notes/managed-exchange-design.md).

## Saving an exchange as recurring

Choose **Save as a recurring exchange** on the exchange screen once an exchange
completes (see [Running it again](WEB_APP.md#running-it-again)). The saved
exchange keeps, in this browser only:

- the agreed terms and where the two of you connect;
- the shared secret, which changes after every run;
- the schedule you enter, the run history, and the [accounting of
  disclosures](#the-accounting-of-disclosures);
- a pointer to its working folder, never a copy of your input file;
- the results of a scheduled run that could not be written to that folder (see
  [Where a scheduled run's results go](#where-a-scheduled-runs-results-go)).

Nothing is kept on a server. [Removing the
exchange](#removing-a-managed-exchange) erases all of it.

### When a column name stops the save

The stored record bounds the length of every column name the exchange declares,
including one it never sends, refuses a name holding an invisible control or
text-direction character, and refuses a name a second column already uses
([PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds)).
The save names the column's position in the file, shows the name, and states the
rule it broke: fix the header row. The one-off exchange that just completed is
unaffected.

### The relays a saved exchange may use

A saved exchange keeps its own **Allowed relays**, under Local settings on its
page. Its runs connect through and enroll at only the relays an entry names, and
a re-invite names only those relays. With no list set, its runs use every relay
they list. The entry form and the matching are those of
[`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays),
and the controls those of [Allowed relays](WEB_APP.md#allowed-relays).

The list starts from the Allowed relays set on the review of the invitation you
accepted or created. A backup holds it, the command-line export writes it as
`connection.allowed_relays`, and an imported configuration keeps it as written.
An empty list allows no relay server, so the runs connect without one, and the
page says so. **Remove**, then saving, deletes the list, so the runs use every
relay they list.

## How a scheduled run happens

A run with nobody present needs the app installed and running on Chromium (see
[Installing the app](#installing-the-app)). At each agreed window the app reads
`input.csv` from the exchange's working folder and runs the exchange. Where that
is not available, a run needs you:

- **In an ordinary Chromium tab**, you start each run, with one action that
  reads from the working folder.
- **In Safari or Firefox**, which cannot hold a folder, you start each run and
  choose the input file for it.

The exchange's page says which of these applies. In the installed app, a
schedule says the app meets its windows itself. In an ordinary tab, the same
schedule says the tab never runs it on its own and names installing as the way
to get that. An exchange with no working folder in this browser says so in
either, since nothing can read the input with nobody present.

**An unattended run takes two parties.** Both parties' apps must be awake in the
same window, so you agree on the schedule with your partner, the way you agreed on the
terms (see [The schedule and its run
windows](#the-schedule-and-its-run-windows)). A partner who does not arrive in a
window is retried at the next one (see [A missed window is neither desync nor
attack](#a-missed-window-is-neither-desync-nor-attack)).

### Incognito and Guest windows on Chrome 153 through 155

**Do not create or open a recurring exchange in an Incognito or Guest window on
Chrome 153 through 155.** Use an ordinary window. On those versions, opening a
saved exchange in one of those windows stops the browser, closing every window
open in it, other sites' windows included ([crbug
562119515](https://issues.chromium.org/issues/562119515)). The application
cannot detect it or warn you first.

- **Measured crashing**: 153.0.8010.52, 154.0.8037.9, and 155.0.8059.2.
- **Measured fixed**: 155.0.8059.12 and 156.0.8064.0. No Chrome 154 build later
  than 154.0.8037.9 has been measured.
- **Ordinary windows and the installed app are unaffected** on every version
  measured.

## Installing the app

The hosted application is installable: it ships a complete web manifest and an
app-shell service worker, so a supporting browser offers to install it as an app
of its own. An unattended run needs the installed app for three things:

- **A window that keeps running.** The exchange runs in the app's own window,
  not in the service worker (WebRTC is unavailable there).
- **Launch at sign-in**, where the browser offers it, so the app is running
  without anyone opening it.
- **A lasting folder permission.** The browser keeps an installed app's
  permission to the working folder across restarts rather than asking again.

### Enabling launch at sign-in

Chromium-based desktop browsers have a per-app "start at sign-in" setting for an
installed app, offered from the installed app's own menu; it is the browser's
setting, not the application's, so Alcove cannot turn it on and does not ask to.
A browser that does not offer it cannot be made to: there, you open the app
before each window or start each run yourself (see [How a scheduled run
happens](#how-a-scheduled-run-happens)).

### Setting it up from an exchange's page

A scheduled exchange's page has a **Keep it running** section:

- **Install.** Where the browser has offered to install the app, the section
  shows an **Install Alcove** button that opens the browser's own install
  prompt. Only Chromium-based browsers make that offer to a page; elsewhere the
  section says to install from the browser's menu. On every other page the
  browser's own install offer (on a phone, a banner) shows as the browser
  decides. The button appears only when the offer arrives while the scheduled
  exchange's page is open; otherwise, or if the browser refuses the prompt,
  the section points at the browser's menu.
- **The checklist** of what a run with nobody present needs: the installed app
  with this exchange in it, start at sign-in or the app opened before each
  window, the computer awake and online during the window, the same browser
  profile in an ordinary window, and the exchange's folder holding `input.csv`.
  The section marks the items the page can see (installed, folder chosen).
- **Check readiness for the next window** reports whether this page is the
  installed app, whether the folder can be read without a prompt and holds
  `input.csv`, and whether this browser can connect to the coordination server
  the exchange saved, the one its runs use. Where a run would refuse that
  address, it says so and contacts no server.
  It starts no run, does not contact the partner or test the relay, and changes
  nothing the next window depends on.

### What works with no network

The service worker caches the app shell and the build's static assets, so with
no connection the app still opens, lists the recurring exchanges, and shows each
one's page. Running or starting an exchange does not work offline, and each
control that would open a live run says so. The quick path's entries stay open,
since reading an invitation and writing an exchange file for the command line
reach no partner.

Every screen is cached each time the app loads with a connection, so all of them
open offline afterwards. A screen whose code is still missing says so: open it
once online.

The worker caches the app document and its build assets only. No exchange
traffic passes through it, and no exchange work happens in it.

### How a new version reaches an installed app

- Whenever the network is reachable, the app document comes from the network, so
  an online launch runs the version currently deployed.
- A new version installs in the background and takes over at the next launch.
  When one is ready while the app is open, the app offers a reload. During a run
  the browser asks you to confirm the reload, and declining keeps the run and
  leaves the offer standing.
- A scheduled run never applies a waiting version.
- An update replaces the app's cached code, not the browser's storage: the
  recurring exchanges, their secrets, and the accounting stay. An upgrade can
  still leave a stored record the new version cannot load; its recovery is [a
  fast re-invite](#recovery-fast-re-invite).

## The schedule and its run windows

Both parties' apps must be awake at the same time, and neither can reach a
server to learn when the other is ready. The schedule is a recurrence and a
window width both parties agree on once, out of band; each app then runs against
its own clock.

### Where the schedule is agreed on, and where it lives

The two operators agree on a cadence and a window over their trusted channel,
as they agreed on the terms, and each enters it under **Local settings** on the
exchange's page: the date and time of the first window on their own clock, how
often a window opens, and how long it stays open. Scheduling is off until
someone enters one, and turning it off returns the exchange to attended runs
only. The schedule stays in this browser: it is not part of the invitation or
the exchange file, nothing about it is sent to a server or to your partner, and
changing it is not a change of terms.

A cadence or window mistyped on one side produces windows that never overlap,
which shows as missed windows on both sides. To avoid that, the Run schedule
section offers the schedule as plain text to send your partner. It holds no
secret and states the next window in UTC, so the two copies can be compared line
by line. A partner using this app pastes it into the schedule fields under Local
settings, which fills the date and time on their own clock, the repeat, and the
window length; text that is not a schedule is refused.

### When a window opens and closes

The recurrence is an anchor instant plus a whole-day interval, and each window
stays open for the agreed width. Both parties store the same anchor and
interval, so both compute the same window opens ([the schedule
object](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object)).

At its window open, each installed app derives the rendezvous id from the
current secret and waits for the partner across the window, in repeated bounded
waits. If the handshake completes, the run continues (see [The second
run](#the-second-run-end-to-end)). If the window passes with no completed
handshake, the window is recorded as **missed** and the app moves on to the next
window.

Set a window of hours, not minutes. The two machines never exchange a clock
reading, so the width is what absorbs clock skew and a machine that woke or
launched late ([the
bound](spec/MANAGED_EXCHANGE_RECORD.md#clock-skew-and-the-window-width)). A
missed window has no security meaning (see [A missed window is neither desync
nor attack](#a-missed-window-is-neither-desync-nor-attack)).

### Retry and repeated misses

A missed window is retried at the next agreed window, and nothing sooner: there
is no off-schedule retry, backoff, or immediate re-attempt. Whichever party was
present records the miss, and both meet again at the next window.

A single miss needs no action. A pattern of misses means the partnership is no
longer meeting: the partner stopped running the exchange, the two schedules
differ, or a machine's clock is wrong. The record counts consecutive misses
since the last success ([the schedule
object](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object)). Once the count
reaches the escalation threshold, the exchange's page and the between-visit
notification show a coordination prompt. It names the likely cause first, a
schedule entered differently on the two sides, often from converting the window
between time zones by hand; says how to compare the two (the next window in UTC,
the repeat, and the window length); and names this machine's clock as the second
check. Each miss before that gets its own notification (see [The between-visit
notification](#the-between-visit-notification)).

Repeated misses do not pause the schedule. Two things stop the attempts:
removing the exchange (see [Removing a managed
exchange](#removing-a-managed-exchange)), and answering "something does not add
up" at a failure check, which skips every window after it until you clear it
(see [Telling a desync from an attack](#telling-a-desync-from-an-attack)).
Skipped windows are not recorded as missed.

### Where a scheduled run's results go

A scheduled run writes the same results file an attended run produces, with
nobody there to download it, to one of two places:

- **The exchange's working folder**, beside the input. The run tries this first.
- **This browser**, whenever the folder cannot be written. The exchange's page
  offers the file at your next visit.

**The folder is granted while you are there**, on the exchange's page. At run
time the app only checks that the grant still stands; it never asks. A grant the
browser will not honour with nobody present, a revoked grant, or a failed write
lands the results in the browser instead, and the next visit says which
happened.

**Use a folder for nothing else.** While the grant stands, the site can read and
write everything in that folder (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).
The app reads only `input.csv` there and lists nothing (see [The input file each
run](#the-input-file-each-run)). Removing the exchange drops the grant.

Results kept in the browser, as the page states where you schedule the exchange
and where you collect them:

- **Are stored unencrypted.** The file holds the matched identifiers and the
  payload values the partner disclosed, readable by any script running on the
  site and by anyone who can read the machine's disk
  ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#results-of-a-scheduled-run-at-rest)).
- **Stay at least 30 days from the run**, and are removed the next time the app
  reads or writes the store: opening the exchange's page, or a later run that
  keeps results. There is no timer, so an exchange nobody opens and that never
  runs again keeps them past 30 days.
- **Are removed at once** by removing the exchange, or by the page's clear
  control, which removes the kept results and the notes about where results went
  without removing the exchange, results already in a folder, or the accounting
  of disclosures. Downloading them does not remove them.
- **Are at most 200 MB**, the same cap as the input file. A larger result is not
  kept at all, and the next visit states its size and what to do about the
  working folder, which takes a result of any size: choose one, grant it again,
  or check that it exists and has room.

A run whose results were not kept still stands: it rotated the secret and filed
its disclosure, and the next visit shows the state beside the run's date.

Once an exchange has run, the app projects the largest result a further run on
the same terms could produce, the two parties' declared record counts
multiplied, and warns where you enter the schedule and in the run history when
that is above what this browser keeps. The remedy is the folder grant ([the
arithmetic](spec/MANAGED_EXCHANGE_RECORD.md#the-parked-results-of-a-scheduled-run)).

Each run writes its own file, named by the exchange's label and the run's date
and time, so a later run never overwrites an earlier one. A count-only run, or
one whose terms give this party no output, writes no file.

An attended re-run also writes its results into the working folder, beside the
download its completion screen offers. Where the browser asks again for folder
access, the re-run asks for edit access before it reads its input, and declining
stops the run before it connects. Where the folder does not take the file, the
completion screen says so, and nothing is kept in the browser.

### The between-visit notification

Between visits, the installed app reports through the operating system's own
notifications, shown from the same app that runs the exchanges. A notification
reports the same state the exchange's page shows at your next visit, only
sooner. One fires for each of these:

- **A run completed and the backup is now stale.** Not sent where the run wrote
  the backup into the working folder (see [The backup a scheduled run
  writes](#the-backup-a-scheduled-run-writes)).
- **A window was missed.** Sent once at its window, naming the next window; no
  action is needed. An app that wakes after several windows have passed reports
  them once ([catch-up on
  wake](spec/MANAGED_EXCHANGE_RECORD.md#catch-up-on-wake)). Once consecutive
  misses reach the escalation threshold, it becomes the coordination prompt, and
  further misses are not notified while that state stands.
- **A window was missed, probably from a desync.** After a key exchange that
  never saved its rotated secret, it names the probable partial rotation and the
  re-invite, once (see [A missed window is neither desync nor
  attack](#a-missed-window-is-neither-desync-nor-attack)).
- **A window was skipped.** While a compromise response stands, it names the
  answer that stopped the runs, the date it was given, and where to clear it,
  once.
- **The input file is missing or was rejected** (see [The input file each
  run](#the-input-file-each-run)).
- **Your partner's terms changed**, and a scheduled run cannot ask you about it
  (see [When your partner's terms
  change](#when-your-partners-terms-change)).
- **Your partner's run refused your linkage terms**, which differ from theirs,
  for example because your input file now sends a different set of columns (see
  [What the setup consent covers across
  runs](#what-the-setup-consent-covers-across-runs)).
- **A file is too large to send** (see [An input too large to
  send](#an-input-too-large-to-send)).
- **The partner's set is too large for this browser** (see [A partner's set too
  large for this browser](#a-partners-set-too-large-for-this-browser)).
- **The partner's run refused to send its set** (see [A partner's run that
  refuses to send its set](#a-partners-run-that-refuses-to-send-its-set)).
- **Your partner could not save the new secret** that this device saved, so the
  exchange needs a fresh invitation (see [A missed window is neither desync nor
  attack](#a-missed-window-is-neither-desync-nor-attack)).
- **The partner's data did not follow the exchange protocol** (see [Partner data
  that does not follow the
  protocol](#partner-data-that-does-not-follow-the-protocol)).
- **A run failed with no benign explanation**, which needs your out-of-band
  confirmation (see [Telling a desync from an
  attack](#telling-a-desync-from-an-attack)).

The seven conditions from your partner's terms change to the protocol failure recur
at every window until you act, or, for your partner's failed save, leave every
window unable to reach your partner, so none is offered as retryable. A missing or
rejected input file is offered as retryable: put the file in place, or replace
a rejected one with a file whose columns satisfy the terms, then try again.

Each notification fires once, when its state begins, and a condition already
reported is not repeated at later wakes. The app remembers what it last reported
for each exchange, so an app relaunched while a state stands can report it once
more. Without notifications, you lose only the earlier report: every state is
shown at your next visit.

#### Turning notifications on

The app never asks for notification permission on its own: the prompt follows a
press of **Notify me between visits**, shown with the recurring exchanges and
only in the installed app. Each notification names the exchange by its label. A
denied permission, a dismissed prompt, a browser with no notification support,
and never turning it on all mean nothing is shown between visits, and every
state is reported at the next visit; a denial is reported where the control was,
naming the browser settings that undo it. Turning it off is the same control.
The choice is a device preference kept in this browser, not part of an exchange
or its export.

## The second run, end to end

On the installed app, a run after the first one is **scheduled**, and nobody is
present:

1. **The window arrives.** The installed app begins the run, and no other run of
   the exchange can start until it ends (see [When a run is already in
   progress](#when-a-run-is-already-in-progress)).
2. **The input file is re-read** from the working folder by its name, with no
   prompt, and rejected if its columns cannot satisfy the standing terms (see
   [The input file each run](#the-input-file-each-run)).
3. **Rendezvous and handshake** with the partner's app, awake in the same
   window; a partner who does not arrive is a recorded miss, retried at the next
   window.
4. **The run saves the rotated secret, then exchanges data.** The changed secret
   is stored before any data is sent, as in an attended run
   ([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).
5. **The outcome is recorded**, the disclosure is filed to the exchange's
   accounting, and the results are written into the working folder, or kept in
   the browser where the folder cannot take them (see [Where a scheduled run's
   results go](#where-a-scheduled-runs-results-go)). The next visit shows the
   results, the backup prompt, or the failure, and a notification reports it
   sooner (see [The between-visit
   notification](#the-between-visit-notification)).

The **attended re-run**, available on any platform, is the same run with you
present: open the app, pick the exchange, run it, and confirm the input file
(one action reading from the working folder, or choosing the file where the
browser cannot grant a folder). The results are written into the working folder
where one is granted, and the completion screen offers them and **download
updated backup**, since the secret just rotated. Take it, and the exchange shows
no warnings.

A re-run whose connection closed before the partner confirmed the final message
says so beside the results, in the words a one-shot run uses: your results are
complete, and the partner's copy is in doubt ([the clean
close](spec/WEBRTC_TRANSPORT.md#the-clean-close)). The run history does not
record it.

An attended re-run can also end with no partner: the wait runs out, no handshake
is attempted, and nothing leaves this device. The screen reports it as the
partner's absence, not a fault here, unless this device already holds a reason
its secret may no longer be the partnership's, which it reports instead (see [A
missed window is neither desync nor
attack](#a-missed-window-is-neither-desync-nor-attack)).

### The input file each run

Where the File System Access API exists (Chromium), you grant each recurring
exchange **one folder**, and every run reads its input from the file in it named
**`input.csv`** and writes its results beside it. The command-line export works
in the same layout, so an exchange taken to the command line keeps the folder
(see [Exporting to the command line](#exporting-to-the-command-line)).

- **The grant.** You choose the folder on the exchange's page, with persistent
  permission where the browser grants it (the installed app). The record stores
  a pointer to the folder, never a copy of its contents
  ([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).
- **What the app reads.** Each run looks up `input.csv` and reads it. The app
  never lists the folder or reads another file, and writes only the files it
  names.
- **No folder yet.** An exchange with no folder (a fresh save, an import, or one
  whose folder was dropped) asks for one on its page, and no unattended run
  happens until one is chosen.
- **Browsers without the API** (Safari, Firefox): you choose the input file for
  each attended run, and no unattended run happens.

**Refreshing the input.** Each run reads whatever file stands under the name at
run start, so putting the current period's extract in the folder as `input.csv`
is the refresh. Overwriting the file in place, writing a temporary file and
renaming it over the name, deleting and re-creating it, and moving the old file
to an archive name before writing the new one all work. A run that starts
between a delete and the new file's arrival fails as a missing file; overwriting
or renaming over the name leaves no such gap.

The record also holds the field delimiter you chose at the file step, so an
unattended run splits fields and writes its result file the same way. It applies
only to your side.

**A missing file.** A folder with no `input.csv` fails the run before any
connection is attempted, as a benign state. An attended run names the file and
the folder; an unattended run records a benign `input` failure and reports it by
notification and at the next visit. You can therefore move the file out after
each run and drop the next extract in before the next window, so the folder
holds input only around the run (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).

**A file that cannot satisfy the terms.** On every path the app rejects an input
file that cannot satisfy the standing terms: every agreed linkage key must be
satisfiable, and no key's cleaning may drop every record. This catches the wrong
dataset, not a same-shaped wrong file; last period's file left in place is
reported separately (see [An input that has not changed since the last
run](#an-input-that-has-not-changed-since-the-last-run)). The shortfall is its
own state, with its own `failureKind`, distinct from an unreadable file, so an
unattended run that met it shows the two ways forward at the next visit: a file
covering every agreed key, or new terms agreed on with the partner over the keys
both files supply. The run control stays enabled. The message names no key or
field, since that detail is partner-authored.

Where the file read as a single column, the usual result of a field separator
other than the one the exchange reads it by, the next visit and the notification
name the separator as the fix instead. The separator is one of the exchange's
**Local settings**; choosing another re-reads the input file and says whether it
then covers every agreed key, before the change is saved.

#### An input too large to send

A run sends each set of values in as many messages as it needs, and each set
must hold no more than the most values the partner states it can receive ([The
receive ceiling](spec/PROTOCOL.md#the-receive-ceiling)). The party holding the
input checks its first round against that figure before building its first set,
and a later round checks each of its sets before sending it. A set over the
figure, or one that could not be counted, is refused. Retrying sends the same
set, so no retry is offered. Split the input into smaller files and set up one
exchange for each, or, for the first round's set, run the exchange with the
command line app over SFTP or a shared folder, which allow larger messages. An
attended run shows the set's size, the bound, and what to do; the next visit and
the notification state the bound and its figure, or that the set could not be
counted, and the remedy.

#### A partner's set too large for this browser

A browser can match a partner's set for one linkage key only up to a fixed size,
which it states to the partner when the run starts ([The receive
ceiling](spec/PROTOCOL.md#the-receive-ceiling)). The partner refuses to send a
larger set, or this browser refuses it at its first part and tells the partner.
Either way, this party's own first set may already have been sent, so the run
history says the run did not complete and that whether any data reached the
partner is not recorded, and points at the accounting of disclosures. The same
partner input stops the same way at every window, so no retry is offered. The
remedy is to run the exchange with the command line app, or for the partner to
split their input into smaller files and set up one exchange for each. An
attended run this browser refused shows the partner's count and this browser's
ceiling.

#### A partner's run that refuses to send its set

A partner's run that refuses its first set tells this browser so, with one of
two fixed reasons: the set is too large
([above](#a-partners-set-too-large-for-this-browser)), or another cause. The
second is a state of its own: the run screen, the next visit, and the
notification say that the partner's run refused and to ask the partner, whose
own run reported why. No retry is offered, and the run history states the same
uncertain disclosure line as above.

#### Partner data that does not follow the protocol

This browser refuses partner data that does not follow the exchange protocol: a
malformed or out-of-order PSI setup, an unreadable response or payload, a terms
message missing a required field, or another protocol version. No retry is
offered. The run screen says to ask the partner to check that they run a current
version of Alcove, and shows what was refused; where the two parties run
different protocol versions it says so, naming which runs the older one where it
can tell. The next visit and the notification say to check with the partner
which version each runs, and that whoever runs the older one updates it. The run
history states the same uncertain disclosure line as above.

#### An input that has not changed since the last run

Last period's extract left in the folder reads, satisfies every agreed key, and
links last period's rows again. Where the input file's last-changed time is
earlier than the exchange's last successful run, the schedule section states
both times and says to put this period's extract at that name before the next
window opens. Every way of replacing the file listed above changes that time.
The note blocks nothing: the run control, the cadence, and the unattended
windows stay as they are. It shows nothing where the time cannot be read, where
the exchange has no successful run, or where the exchange has no schedule.

## Running from one device

A recurring exchange runs from one browser on one device. Two copies that both
run split its shared secret: the first to run changes it, and the other copy can
no longer connect to your partner (see [Desync detection and
recovery](#desync-detection-and-recovery)). Exporting the exchange only writes
files, and neither export stops this copy: what moves the exchange is running
it somewhere else.

### When a run is already in progress

Only one run of an exchange happens at a time in a browser profile: a second
tab, or a run you start while a scheduled one is under way, waits or is told a
run is already in progress. During a scheduled window that lasts as long as the
window does, since the app keeps waiting for your partner across it. A run that
connects just before the window closes holds on until its exchange finishes,
which can be after the window is over.

The downloads and the terms controls stay available while a run is under way.
The run uses the terms it started with, and a change you make meanwhile is what
the exchange holds after it. Creating a fresh invitation and changing the relay
registration wait for the run to end, and the page says where the run is and
how to end it sooner.

### Moving the exchange to another device

To run the exchange in another browser or on another device, **Download a
backup** from the exchange's page and import that file there (see [Eviction
recovery is the import flow](#eviction-recovery-is-the-import-flow)). The
download changes nothing here but the backup state: the exchange stays runnable,
with its schedule as it was.

The first run elsewhere moves the exchange: it replaces the shared secret, and
the copy here can no longer connect to your partner. The page says so beside the
download, says that the [accounting of
disclosures](#the-accounting-of-disclosures) stays in this browser and is not in
the file, and, on an exchange scheduled here, says to turn the schedule here
off. A run of the copy here after a run elsewhere meets no partner, since where
the two parties meet is derived from the secret; its no-show message and
missed-window notification say that importing the exchange again here makes it
runnable. Importing the newer backup here asks about the older copy: choose to
replace it, and it takes the backup's secret and terms in place, keeping its run
history and accounting of disclosures.

Both downloads, the backup and the [command-line
files](#exporting-to-the-command-line), stay available while a run of the
exchange is under way, in this tab, another tab, or on its schedule. A file
downloaded then holds the secret that run is about to replace, so the page says
so beside both and asks you to download again once the run ends; the run's
change of secret also puts the backup state back to asking for a backup.

**The file is a credential.** It holds the exchange's shared secret in plain
text, like the command line's `.alcove.key` ([Key file
security](SECURITY_DESIGN.md#key-file-security)). Store it where only you can
read it, never send it over an unencrypted channel, and use an encrypted
location or a secrets manager if you want it encrypted at rest. It stays usable
until a run changes the secret or the secret expires. If a copy leaks, follow
the [compromise response](SECURITY_DESIGN.md#compromise-response): tell your
partner over another channel and send a fresh invitation.

### Exporting to the command line

Where your organization can run installed software, the exchange's page has a
collapsed **Run this from the command line** panel beside the backup panel. It
downloads two files for `alcove exchange` to run under the host's own scheduler:

- `alcove.yaml`: the agreed terms and the connection settings, with no secret.
- `.alcove.key`: the exchange's shared secret, in plain text, under the key
  file's custody rules ([Key file
  security](SECURITY_DESIGN.md#key-file-security)).

Saved into one folder, the two are what the command the panel shows opens, at
their default paths. It reads `input.csv`, appends to `exchange.log`, and writes
each run's result into the folder under that run's time stamp; on an exchange
with an agreed schedule it waits for the partner (`--peer-timeout`) as long as
the agreed window. The panel shows the command as the console's hand-off does
([Graduating to a scheduled run](CONSOLE.md#graduating-to-a-scheduled-run)): run
from Alcove's published image over the folder, with each path the configuration
names outside it mounted at its own path. Beside it are the cron and Task
Scheduler lines for the agreed schedule, or daily at 2am for an exchange with
none ([the scheduled
lines](spec/MANAGED_EXCHANGE_RECORD.md#the-command-line-exports-scheduled-lines)),
and a cron line for an installed `alcove`. The rules for a scheduled
command-line run: [Scheduling the run](CLI.md#scheduling-the-run).

The export only writes files: the exchange here stays runnable, with its
schedule and backup state unchanged. It stays available while a run of the
exchange is in progress, with a note that the run is about to change the
secret the key file holds, so you download again once it ends. Every run, here
or from the files, replaces the shared secret,
so the panel says to import the exchange again to use it here after running it
elsewhere, and, on an exchange scheduled here, to turn the schedule here off;
otherwise whichever copy runs second fails to connect ([Desync detection and
recovery](#desync-detection-and-recovery)). Importing the newer `alcove.yaml`
and `.alcove.key` brings the current secret back, replacing the copy here in
place ([Bringing a command-line configuration
back](#bringing-a-command-line-configuration-back)).

Two things are not in the files:

- **The schedule.** The command line does not read it; the cron entry or
  scheduled task is the schedule there, set to the window the partner expects.
- **The accounting of disclosures**, which stays in this browser.

A recurring web exchange's configuration names no STUN server. In the browser
its runs use the STUN servers this browser's relay settings or the exchange's
invitation name, or the default where neither names one; on the command line
they use the STUN servers the exported `invitation_relay` names, or the default
where it names none, which then learn the scheduling machine's address instead
of this browser's. The command line warns about the default on every run only
where the configuration lists no `turn` server either, or `allowed_relays` leaves
out every one. Name a `stun` server in the exported `alcove.yaml` to replace the
default ([STUN, and what it
discloses](CLI.md#stun-and-what-it-discloses)).

The two files are the command line's working copy, not a backup: every run there
rewrites `.alcove.key`. Downloading them does not change the exchange's backup
state, and the panel says so.

### When your relay runs a registrar

A relay run from the reference deployment accepts only credentials made from the
relay key it holds for each exchange, and that key changes each time the shared
secret rotates. When the relay in this browser's relay settings runs the Alcove
relay registrar, enroll the exchange there once, under **Relay registration** on
its page. The section is shown only while the relay settings name a TURN relay,
or the exchange is already enrolled or has a registration pending. Enter the
registrar's address, the exchange id to hold the key under, and the relay-owner
token. The token is sent with that one request and kept nowhere. Leave it empty
when the registrar already holds the exchange's current key, as after enrolling
it from the command line ([Registering the relay key at your
relay](CLI.md#registering-the-relay-key-at-your-relay)).

After that, each run that relays through your relay registers the key derived
from the new secret, signed with the key being replaced, before it lets the
exchange go. A fresh invitation from here registers before it is shown, and
names the exchange id beside your WebSocket relay, where your settings name one.
An exchange accepted from an invitation naming your partner's relay registers
the same way, and its runs list your relay beside your partner's. Enrolling and
stopping registration wait while a run of the exchange is under way. If the run
is in this window and still waiting for your partner, **Stop the waiting run and
enroll** ends it and enrolls; the token you entered is kept if the enrollment is
refused because a run started.

A registration the registrar does not confirm is kept on the exchange and tried
again before the next run connects. If it still fails, the run stops before
contacting your partner and says why. Where the registrar refused, enroll the
exchange again with the relay-owner token, choosing to replace the key it holds.
A fresh invitation whose registration was not confirmed needs the same, and is
not tried again. While a registration is pending, the recurring list and the
exchange's page say since when and what to do ([the pending
registration](spec/MANAGED_EXCHANGE_RECORD.md#the-pending-relay-registration)).

The enrollment travels with the exchange: a backup holds the registrar and any
pending registration. The command-line export writes the registrar and the TURN
urls it registers for into `alcove.yaml`, and a pending registration into
`.alcove.key`, which the first command-line run tries again before it dials; the
export is refused while a fresh invitation's registration is pending. It writes
the relay your partner's invitation named as named, the site's [default
relay](DEPLOYMENT.md#the-default-relay) and its registrar included, and a
command-line run using that relay registers there first. The export panel names
that registrar and says whether a run registers there ([what a registrar
learns](../PRIVACY.md#what-supporting-services-can-observe)).

### Bringing a command-line configuration back

An `alcove.yaml` written for the command line imports here on its own, without
its key file, whichever channel it runs over. It lands as a
**configuration-only** exchange: the agreed terms, the connection, and the local
settings, with no shared secret. Read it in, edit what is editable, download it
again, and run it where the data and the scheduler are. The list's one import
control takes it, as it takes a backup file ([Eviction recovery is the import
flow](#eviction-recovery-is-the-import-flow)).

**To run the exchange in this browser, choose its `.alcove.key` too**, in the
same pick as the `alcove.yaml`. The file chooser may hide it until hidden files
are shown, since its name starts with a dot. The pair lands as an exchange that
runs here, and the import names each setting of the file it keeps with no
control here, `metadata` and `standardization` among them, in the file's own
snake_case. Before the first run here, stop the scheduled command-line run of
the same exchange: each run on either side changes the shared secret, and the
copy that falls behind can no longer connect to your partner. The pair import:

- **Takes only the key file Alcove wrote.** A file that is not JSON, holds no
  shared secret or one Alcove would not write, has an `expires` that is not a
  date and time, or holds any other field is refused, saying which, without
  showing what the file holds. A key file recording an unconfirmed relay key
  registration imports, and the first run here tries it again where the
  `alcove.yaml` names the registrar (see [When your relay runs a
  registrar](#when-your-relay-runs-a-registrar)). An `alcove.yaml` naming a
  registrar imports only with its key file.
- **Takes only an exchange this browser runs.** An sftp or filedrop
  configuration, or one whose `signing` block asks for a receipt, is refused
  with its key file; import the `alcove.yaml` on its own to edit it here. A
  `signing` block with `mode: none` asks for no receipt, so it runs here and is
  kept as written.
- **Refuses a second copy.** An exchange is recognized by its shared secret: if
  this browser already holds the key file's secret, nothing is imported and the
  refusal names the exchange.
- **Asks about an exchange you already have.** Where an exchange in the list has
  the same terms and side, the import stops and names it. You can complete or
  replace that copy with the files, keeping its run history, schedule, and
  accounting of disclosures as one entry; keep it; or add the files as a new
  exchange.

The secret is kept only in this browser's stored copy of the exchange. The
import marks the exchange as restored, and it shows as needing a backup until
you export one.

A configuration imported alone **does not run in this browser**: it is listed
with Open in place of Run, and its page says why. A webrtc configuration has no
secret here; this browser runs no sftp or filedrop exchange; and it produces no
signed receipt, which a `signing` block in `certificate` or `session-derived`
mode asks for. Importing a configuration changes nothing on the other machine.

What the import accepts:

- **A file Alcove itself would load**, or a refusal naming the fields to fix.
- **A connection this app can hold.** A webrtc connection may hold a rendezvous
  address and its `allowed_relays`; a TURN credential, an ICE provisioning
  block, or a PeerJS server key is refused by field name. A filedrop or sftp
  connection is held whole.
- **A `signing` block, unchanged.** The mode, `identity_file`, and
  `partner_fingerprint` are kept exactly as written, with no editor here; this
  browser opens no file they name.
- **Credentials only as `@path` references.** An sftp `password`, `private_key`,
  or `private_key_passphrase`; the `bearer` or `password` of a `provision`
  block's `auth`; and a `password`, `passphrase`, `privateKey`, or `private_key`
  key in `provider_options`, in any letter case and at any depth, are held when
  written as `@` and a path, and refused by field name when written as any other
  value ([File references](EXCHANGE_REFERENCE.md#file-references)). Any other
  `provider_options` setting, such as a cipher list, is held as written.
- **No shared secret** in the `authentication` block: the secret comes in only
  from the `.alcove.key` chosen beside it.
- **A `role` on a webrtc connection**, as the command line requires.

Editable here: the label; the inactivity limit
(`authentication.token_max_age_days`); and the settings that are this party's
alone, `include_own_columns`, `include_matching_key`, `csv_delimiter`,
`retention_disposition`, and, on webrtc, `connection.allowed_relays`. The agreed
terms change only under [Change terms](#changing-the-terms-of-a-saved-exchange),
on an exchange imported with its key file. An import exports back with your
edits and every other setting as the file stated it.

The page names every setting it keeps without showing it, and each setting that
holds an `@path` (never the path itself), since Alcove reads that file on the
machine that runs the exchange. An SFTP configuration that names no credential
or no host key exports without one, and the export panel says to add
`private_key` or `password` (as an `@path`), `host_key_fingerprint`, or both
under `connection.server` before running it.

## Desync detection and recovery

After every run both sides change the shared secret. If only one side saves the
change, or a browser loses its copy and restores an older one, the two sides hold
different secrets: they are out of sync, and their next run fails. A failed
handshake looks the same whether the cause is that or an attack, so this section
says how the app tells them apart and how you recover. The design behind it:
[Desync detection and recovery](notes/managed-exchange-design.md#desync-detection-and-recovery).

### A missed window is neither desync nor attack

A run the partner never arrives for is a **no-show, not a failed handshake**:
nothing was authenticated and nothing failed. A scheduled run records it when a
window passes with the partner absent; an attended run, when its own wait for
the partner runs out. It is recorded as a benign `"missed"` outcome
([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) and never leads
to the out-of-band confirmation below. The recovery is another attempt with both
parties present. A window skipped under a compromise response is not a no-show
either (see [Telling a desync from an
attack](#telling-a-desync-from-an-attack)).

A no-show is no evidence for or against a desync: both rendezvous ids derive
from the shared secret, so two sides holding different secrets each record a
no-show at every window. So where this device holds a standing reason its secret
may no longer be the partnership's (a restore since the last successful run, a
one-sided save failure, an expired shared secret, or a rotation that never
saved), the run reports that state and its re-invite recovery instead. Otherwise
the no-show message says that a partner who was at their machine at an agreed
time and still never arrived points to a re-invite rather than another wait.

A rotation that never saved is detected by a marker: the run writes it once the
partner connects and before the key exchange starts, and the write that stores
the rotated secret removes it, so a tab closed or killed between the two leaves
it behind ([the rotation-in-flight
marker](spec/MANAGED_EXCHANGE_RECORD.md#the-rotation-in-flight-marker)). A
no-show after it reads as a probable partial rotation, with the re-invite
recovery and no attack checklist.

The other side of that rotation is reported too. This device saves the new
secret first when it accepted the invitation; when the partner's run then
reports that it could not save the new secret, this run says so, says that this
device already holds the new one, and names a fresh invitation, with no retry.
The run history, the recurring list, and a notification state the same. The
partner's report is matched against a fixed reason and never shown as text the
partner sent. Scheduled runs keep running afterwards, but none can reach the
partner: each side's meeting point derives from the secret it holds, so a later
window finds no partner, and one that does meet fails at the handshake. A no-show
does not replace the report, which stays until a re-invite. A handshake that
fails closed replaces the report as the standing condition and takes the
confirmation below, because the partner's report is the other side's claim and
not local evidence.

A no-show's run entry replaces the previous one, but a save failure on either
side or a failed-closed handshake is also kept as a standing condition, which a
no-show does not replace (below).

### A standing condition outlives the run that raised it

Three failures need a remedy carried out with your partner rather than on this
device: a rotation this device could not save, which may have left the two
parties on different secrets; a rotation your partner reported it could not
save, which did; and a handshake that failed closed with nothing to explain it.
Each is kept as a **standing condition** beside the run history,
which a later run's entry does not replace, so the recurring list, the
exchange's page, and a later run all read it until it is cleared. A later
failure of the same kind leaves the first in place, and the message you forward
names both, so the partner checks their logs for both. The exception is a
handshake that fails closed after a save failure your partner reported: this
device's own failed handshake replaces that report, because the report is the
other side's claim and not local evidence. A handshake that fails closed after a
save failure this device recorded is read as that save failure, which explains
it.

Three things clear a standing condition, and nothing else does:

- **Your explicit acknowledgement**, on the exchange's page. For an unexplained
  handshake failure, that is the two-outcome gate below. Where the record
  already holds the explanation (a save failure, or a restore since the last
  success), or your partner reported a save failure, the page states the
  condition and its re-invite recovery, and a short acknowledgement clears it.
- **A re-invite**, which installs a fresh secret.
- **Removing the exchange.**

A no-show or a successful run does not clear one.

### Telling a desync from an attack

When a handshake fails, the app answers from what the exchange's record already
holds, so you face the full confirmation only when nothing else explains the
failure. A failure from a scheduled run is reported the same way at your next
visit.

**Tier 1: local evidence explains the failure.** A save failure this device
recorded (the last run's `failureKind`, or the standing condition it raised), a
restore or import since the last successful run,
or an expired shared secret (see [Expiry is its own
state](#expiry-is-its-own-state-never-routed-through-attack-framing)) shows as
that state, with the re-invite as its recovery and **without** the attack
checklist. A save failure your partner reported does not excuse a later failed
handshake from the confirmation, because the other side's claim is not local
evidence.

**Tier 2: no local explanation.** A handshake failure with no recorded benign
cause gets the full out-of-band confirmation: a **pre-filled message** you send
your partner over another channel, asking them:

- to confirm their identity on that channel, not just reply;
- what their own tool reported, and when;
- whether they ran the exchange from more than one place (a second browser or
  profile, another device, a restored backup; see [Running from one
  device](#running-from-one-device)).

Their reply feeds a **two-outcome gate**. "The partner confirmed a real failure
on their side" proceeds to re-invite. "Something does not add up" is treated as
compromise and routes to the [compromise
response](SECURITY_DESIGN.md#compromise-response). You make the call, with your
partner.

A compromise response is kept with the exchange. While it stands:

- a later run that fails the same way does not ask again;
- no control on the exchange's page creates a fresh invitation, including a page
  left open from before the answer;
- every window that falls due is **skipped**: nothing connects and nothing
  rotates. A skip counts toward no miss pattern; the run history names it, and a
  notification reports it once;
- running the exchange from the page stays available, with the warning shown
  over the control.

The three acts that clear a standing condition clear the response too, and
nothing else does. The one the page offers is the acknowledgement that your
partner confirmed the failure on another channel: it clears both, the schedule
resumes at the next due window, and the fresh invitation is offered again. Reach
your partner another way first, then re-invite. Where a later run has failed the
same way since the answer, the acknowledgement asks the gate for that failure
first.

While a run of the exchange is under way anywhere in the browser profile, no
control creates an invitation either, and the page says where the run is:

- **In this window, waiting for your partner.** **Stop the waiting run and
  re-invite** ends that run, which records nothing, and creates the
  invitation. A scheduled run stopped this way is not counted as a missed
  window, and its window's next attempt uses the new invitation.
- **In this window, exchanging data with your partner.** It can no longer be
  stopped this way; the controls return when it ends.
- **In another window or tab, or the installed app.** Closing that window
  ends it. For a scheduled run, turning off the schedule under Local settings
  ends the scheduled window after its current attempt, within about 10
  minutes.

This lifts on its own once the run finishes, whatever it finished with.

### Expiry is its own state, never routed through attack framing

An expired shared secret (`expires` in the past) is detected **before** any
connection or handshake, so it shows as its own benign state with a plain
re-invite message, like the command line's expired-token error, and never as a
possible attack.

The inactivity limit, which expires the shared secret after a number of days
with no successful run, is **opt-in and off by default**, as on the command line
([Shared secret rotation and inactivity
limit](SECURITY_DESIGN.md#shared-secret-rotation-and-inactivity-limit)). It is
set at setup and can be changed or cleared on the exchange's page; a change
never moves the expiry later than it stood. With a limit set, the page states
"this exchange must run within N days", and where the next scheduled window
opens at or past the limit, the schedule entry reports it. Set a limit for a
partnership that may go idle: rotation limits exposure only for an exchange that
runs ([The primary controls](SECURITY_DESIGN.md#the-primary-controls)).

### Recovery: fast re-invite

The recovery is a **fast re-invite**, as on the command line for a lost or
out-of-sync token ([Recurring exchange
authentication](SECURITY_DESIGN.md#recurring-exchange-authentication)): both
parties discard the desynced secret and set up a new one from a fresh
invitation. The saved exchange keeps its terms, so a re-invite reuses them and
creates only a new setup secret. Its invitation names the coordination server
set in that browser's relay settings, the site's where none is set, or the
server the exchange already uses where the setting cannot be read, so a
re-invite also moves an exchange to a changed server.

The inviter creates the invitation from its saved exchange, which replaces that
exchange's secret and coordination server in place. The acceptor accepts the
fresh invitation, and saving it adds a **new** recurring exchange: nothing links
it to the old one. The acceptor then removes the superseded exchange, whose runs
would fail closed; nothing removes it for them.

Every re-invite puts a fresh setup secret on the channel you send invitations
over, so that channel has to stay trusted for as long as the partnership lasts
([Invitation contents and
confidentiality](SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
Send a re-invite only after the confirmation above, never as a reflex to a
failure.

## What the setup consent covers across runs

A recurring exchange runs on the agreement made at setup. The linkage terms and
the columns each side sends change afterwards in only two ways, each reviewed by
the other party before a run proceeds under it:

- **You change the columns you send**, and tell your partner with a terms update
  (see [Changing the terms of a saved
  exchange](#changing-the-terms-of-a-saved-exchange)).
- **Your partner changes its terms**, and you answer when a run meets the change
  (see [When your partner's terms change](#when-your-partners-terms-change)).

A scheduled run presents nothing new to review: it runs the stored terms against
the current input file. A different partner, or linkage terms this app does not
edit, take a new exchange. Your own local acts are not changes of terms: the
schedule, pausing, removing, or moving the exchange, dropping in the next
extract, and your result file's own columns and matching-key column, the input's
field separator, and the retention note. Apart from the extract (below), none of
them changes what is sent.

The input file can change what is sent without anyone editing the terms, because
the set a run sends is resolved from the file's own columns. Before connecting,
this device checks only that the file is readable and supplies every agreed
linkage key. The run states its `payload.send` from the file's columns at the
terms exchange, so the partner's run meets a changed set as a change in your
terms, after the handshake and before any linkage key or data moves
([PROTOCOL.md](spec/PROTOCOL.md#a-terms-change-at-the-terms-exchange)). A
scheduled partner run that does not take it on stops and records a
`terms-change` failure, and nothing is sent until the partner takes the change
on.

A re-invite reopens **the secret, not the agreement**. The inviter's fresh
invitation is built from the stored terms and column metadata, with a new setup
secret, the coordination server described in [Recovery: fast
re-invite](#recovery-fast-re-invite), and a fresh setup lifetime. The acceptor
walks the accept flow again, re-enters its own local fields (its name, metadata,
and standardization), and reviews the fresh invitation on its own merits:
nothing compares it with the old one.

A later run proves only that both sides still hold the shared secret descended
from the one exchanged at setup; it does not verify who your partner is. A
leaked or copied secret lets someone else take your partner's place until a run
replaces it.

### Changing the terms of a saved exchange

The exchange's page has a **Change terms** section, offered once the exchange
holds its shared secret. It does for a saved exchange what `alcove update` and
`alcove apply` do for a command-line configuration
([CLI.md](CLI.md#changing-the-terms-of-an-established-partnership)).

- **Columns you send.** Where the terms send your partner columns for matched
  records, each of your payload columns and your record identifier has a
  checkbox. Unticking the record identifier stops sending it, and it stays your
  record identifier. Columns used to match change only with the linkage terms.
  **Save columns** changes the stored exchange: the next run sends the chosen
  columns and states them in its terms. A run already in progress keeps the
  columns it started with.
- **Send a terms update.** **Make a terms update** makes the update `alcove
  update` prints for a configuration holding these terms: your linkage terms and
  the names of the columns you send, authenticated under the shared secret, with
  no secret, credential, or connection detail. Send it to your partner over any
  channel that delivers it unchanged; they apply it on their exchange's page, or
  with `alcove apply`. Every run replaces the secret an update was made under,
  so an update not applied before the next run is refused and has to be made
  again.
- **Apply a terms update.** Paste an update your partner made and choose **Check
  update**. It is refused, naming what is wrong, when it is incomplete, made for
  a different exchange or under a replaced secret, altered, made from your own
  terms, changes terms this exchange cannot take on here (such as the columns
  used to match), or fails a check `alcove apply` makes. An update that passes
  shows its change as a run shows it. **Accept** saves your partner's terms, and
  the next run uses them; **Decline** leaves the exchange as it is. Where the
  new terms leave your result file no linkage key to name (count-only,
  single-pass, or no result for you), **Accept** also turns off
  `include_matching_key`, and the check says so.

Making and applying an update are not offered once the secret has expired, or
where the terms name no identity for you. An update made while a run is in
progress is made under the secret that run replaces, so once the run finishes
your partner's apply refuses it and you make a new one. A partner who has not
applied your update meets the change at their
next run (below). How each write is stored:
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#a-terms-update).

### When your partner's terms change

A partner that changed its terms since your last run, most often by adding or
dropping a payload column, just runs. Your run meets the change at the terms
exchange, after the handshake and before any linkage key or data moves, and
shows it as the command line does ([When your partner's terms
change](CLI.md#when-your-partners-terms-change)).

- **A run you started from this page** asks. **Accept** saves your partner's
  terms and the run continues under them, except that a change to the linkage
  fields, keys, algorithm, strategy, or output direction, or to your partner's
  `deduplicate`, saves the terms and stops the run, and the next run uses them.
  **Decline** stops the run and leaves the exchange as it was. Your partner's
  run waits for your answer only within its own inactivity bound, so answer
  promptly.
- **A scheduled run** stops before any linkage key or data moves, keeps your
  partner's terms beside the exchange in this browser, and notifies you if
  notifications are on. The exchange's page then offers **Apply**, which saves
  the terms and changes nothing else, and **Decline**, which drops them. After
  Decline, scheduled runs stop the same way until your partner returns to the
  agreed terms. Both stay offered while a run is in progress; that run keeps
  the terms it started with, and the exchange holds the applied terms after it.

**Accept** and **Apply** turn off `include_matching_key` where the new terms
leave no key to name. Your partner's run ends with a partner refusal when you
decline or a scheduled run stops
([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#a-refused-terms-change)).

Where your partner's run refuses your terms instead, your run stops at the same
point and the exchange states that your partner refused your linkage terms. No
retry is offered, since your partner refuses the same terms at every window:
agree on the terms through a terms update, then run the exchange again.

Each successful run produces the same self-attested exchange record a one-shot
exchange does ([EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md)), filed in the
exchange's [accounting of disclosures](#the-accounting-of-disclosures).

## The accounting of disclosures

Each recurring exchange keeps its own accounting of what it disclosed: one entry
per run that sent this party's payload, each entry that run's self-attested
exchange record. It is the source an operator draws a HIPAA accounting of
disclosures or a FERPA disclosure record from
([COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations)), and it is on the
exchange's page, below its run history.

- **It is the records, not a summary.** An entry shows what that run's record
  says: the partner, the governing agreement and the purpose of the disclosure
  under it, the categories of data sent each way, how many records this party
  exposed, the result size where both parties received the result, and the time.
  It says "not recorded" where the record holds nothing. It is self-attested and
  unsigned, as the record is.
- **A run files its own entry, present or not**, before it reports its results.
- **A run that stopped after sending is in it, and is marked.** Cancelling a run
  or a dropped connection does not call back payload already sent. The entry
  states that delivery to your partner is not confirmed and that no result file
  was written; its columns are what had been sent and received when it stopped,
  and a result size beside them is the intersection computed, not a result you
  received. A run whose exchange completed and filed its record before a local
  output step failed keeps an unmarked completed entry, while the run history
  says no result file was written.
- **A run that stopped before sending is not in it.** Nothing was disclosed; the
  run history says what happened.
- **It is exportable** as a CSV, one row per run.
- **It stays in this browser, and is removed with the exchange.** Nothing prunes
  it, and it is not in the backup file. Export it before removing or handing off
  the exchange.

### When a run's record is missing from the accounting

A run can disclose and still fail to file its record: this browser's storage
refuses the write, or the run could not build a record. The run leaves a note
beside the accounting, and the exchange's page shows it at your next visit,
above the entries:

- **The accounting states how many further runs disclosed with no entry here**,
  so a count of entries is not read as a count of disclosures. An accounting
  exported meanwhile is short those runs.
- **Where the note holds the run's record**, one action files it into the
  accounting. Adding the same run twice does not double an entry.
- **Where no record was kept**, nothing can add the entry; record that
  disclosure in your own compliance material.
- **Where this version cannot read the run's record**, the page says so; record
  that run in your own compliance material too.
- **It is removed with the exchange**, and it is not in the backup file.

Filing can fail again for the same reason, most often an accounting this version
cannot read: clear it first (below), then add the records again.

Where this browser can store nothing at all (it is out of space, or its database
will not open), even the note cannot be written. A marker, which holds at most
20 exchanges, says that at least one run of the exchange could not be recorded;
that run cannot be added to the accounting afterwards. The marker is shown once,
on the exchange's page, and then cleared, even on a page left open unattended.
To find the run, check the run history, which keeps only the most recent runs
(the `recentRuns` row of
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)), and the
browser's developer-tools console
([DEPLOYMENT.md](DEPLOYMENT.md#diagnosing-web-connection-failures)). Past 20
exchanges, or where even the marker cannot be written, nothing records the run:
free space on the device rather than keep exchanging.

### When an app upgrade leaves an accounting unreadable

An upgrade can change the format of the records an accounting holds. The
accounting page then says so instead of showing entries. The entries are still
stored, and the exchange keeps running and disclosing, but none of its runs
files a record until the accounting is cleared. Take both steps, in order:

1. **Download the stored records**, in the form they were stored, for your
   compliance material. It is not a run's record file, so neither the Verify
   page nor this app reads it back.
2. **Start a fresh accounting.** After you confirm, this permanently removes the
   stored records and lets the exchange file its disclosures again from its next
   run. The terms, the shared secret, the schedule, and the run history are
   kept.

A cleared accounting shows empty until the next run files into it. Where the run
history records a completed run, the page names the two ways an accounting is
emptied: clearing it, or restoring the exchange from a backup file, which holds
none. Where the stored records are too damaged to download, the page says so;
clearing still lets the exchange file again.

### When the accounting could not be read right now

A different message, that the accounting could not be read **right now**,
means this browser's storage did not answer, not that anything is wrong with what
it holds. The usual cause is another tab running an older version of the app,
which holds the storage for a while and then lets go.

Nothing is offered to clear, because nothing is known to be damaged. Close any
other tab this app is open in and use the page's own "try reading it again"; a
page reload works too, but it would end a run in progress.

### When this page is the older version

A tab left open across a new deployment keeps running the version it loaded. If
a newer version has filed records for the exchange since, the page says **this
page is running an older version of Alcove**. Nothing is wrong with the records,
and clearing them is not offered. Reload before running: a run from this page
discloses and files no record. If a run is under way, reloading ends it. The
stored-records download stays available meanwhile.

If a reload shows the same message, the deployment was rolled back past the
format change. Take the stored-records download, and do not leave the exchange
running, since every run discloses and files nothing. Removing the exchange is
then the only way out this build offers, and the downloaded records stay intact.

## Surviving storage eviction

Browser storage is not durable the way a file on disk is. The browser can
delete it **silently**, with no crash and no warning, so the backup you keep
outside the browser is what restores the exchange.

### The eviction threat

These browser behaviors come from vendor documentation and reports, and browsers
change them between versions: check them against the browser versions you
support.

- **Safari Intelligent Tracking Prevention (ITP)** deletes a site's
  script-writable storage, IndexedDB included, after about **seven days of
  Safari use without a user interaction** (a click or other gesture) on the
  site. Script activity and background runs do not reset that count. Under
  Safari, an exchange on a monthly cadence can be gone by its next scheduled
  run.
- **`navigator.storage.persist()` is best-effort.** Firefox prompts the user,
  Chromium grants or denies silently on engagement (an installed app, a
  bookmark, frequent use), and a grant can later be revoked. On WebKit a grant
  does not reliably exempt a site from the ITP limit, and the backup state never
  counts it. The app requests persistence but never assumes it.
- **Storage-pressure eviction** can clear non-persistent sites under disk
  pressure in any browser.
- **Clearing site data**, by the operator or an IT policy, is the most common
  loss, and removes the exchange.

### The durability backbone: export/import

Keep a backup outside the browser: the export file, held in your own secure
storage, restores the exchange after an eviction. It is the same file that moves
the exchange to another device (see [Moving the exchange to another
device](#moving-the-exchange-to-another-device)), and taking it leaves the
exchange runnable here. The attended run's completion screen and the backup
state below prompt a new one after each rotation; an unattended run writes one
into the working folder where it can.

### The backup state

Each exchange shows one backup state, which changes only when a backup is taken
or the secret changes:

- **Backed up.** An export taken since the last rotation exists. The exchange
  shows "backed up as of" its date, naming where the backup went: downloaded
  under its file name, or written to the working folder. Only the backup file
  counts; taking the command-line export's two files leaves the state as it was
  (see [Exporting to the command line](#exporting-to-the-command-line)).
- **Backup needed.** No export was ever taken, or the secret has rotated since
  the last one; an older export restores a stale secret and lands in [desync
  recovery](#desync-detection-and-recovery). The exchange shows "Back up this
  exchange".

After an attended run, take **download updated backup** on the completion screen
(see [The second run](#the-second-run-end-to-end)). A scheduled run writes the
backup into the working folder where it can (see [The backup a scheduled run
writes](#the-backup-a-scheduled-run-writes)); otherwise the state shows backup
needed at your next visit, and a notification prompts sooner (see [The
between-visit notification](#the-between-visit-notification)).

### The backup a scheduled run writes

A scheduled run that completes has rotated the secret, so your earlier backup no
longer restores the exchange. Where the exchange has a working folder, the run
writes a new backup there without asking:

- **When.** After every scheduled run that completes, once its results are
  delivered, and only where the folder grant still holds with nobody present,
  the same check the results write makes.
- **What.** The same contents **Back up this exchange** downloads, under a name
  stating the exchange's label and the date and time it was written ([the exact
  name](spec/MANAGED_EXCHANGE_RECORD.md#the-backup-and-import-markers-local-siblings-never-in-the-artifact)),
  in the working folder and nowhere else.
- **What it replaces.** Once the new file is in the folder, the backup the
  previous scheduled run wrote there is deleted. A backup saved into the folder
  by hand is never deleted, nor is any other file.
- **What it changes.** The exchange reads "backed up as of" the date, with the
  folder's name and the file name, and no backup notification fires for that
  run.
- **What you are told.** Where the folder is chosen and once it is granted, the
  exchange says the file holds the shared secret, and asks for a folder only you
  can read and for other backups there to be deleted once no longer needed.

The exchange still asks for a backup, at the next visit and in the notification,
when it has no working folder; the browser would ask before letting the app use
the folder again, or the grant was revoked; a file already has the backup's
name, which is left untouched; or the write fails, leaving the previous backup
in place, or the secret changes again before the backup is recorded. None of
these changes the run's outcome. An attended run does not write this file.

Older backups can remain in the folder, such as one from before a run that wrote
none, or one saved by hand. Only the newest restores the exchange. Delete the
older files, and keep the folder for this exchange only: anyone who can read it
can read the current secret
([SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).

### Eviction recovery is the import flow

When the browser copy is gone, evicted or cleared with site data, the empty
recurring-exchanges list offers the import of your backup file. Restoring after
an eviction and moving to a new device are the same import. The app cannot
always tell a first visit from one after an eviction, so the import control is
always shown, beside an empty, populated, or unreadable list. It routes a file
by what it is: a backup restores the exchange, and a command-line `alcove.yaml`
lands as a configuration-only exchange, or as one that runs here when its
`.alcove.key` is chosen with it ([Bringing a command-line configuration
back](#bringing-a-command-line-configuration-back)).

**A backup is checked against the one exchange it holds, not against the rest of
the list** ([the
rules](spec/MANAGED_EXCHANGE_RECORD.md#reconciling-a-backup-import)):

- **Not in this browser**: it is added as a new entry.
- **Already running here with the backup's secret**: nothing is imported, and
  the refusal names the entry to open instead. Where that entry's saved state
  cannot be read, the refusal says to remove it from the list, then import the
  backup again.

The secret changes on every run, so a backup and the saved copy of the same
exchange hold different secrets once either has run since the other. When listed
exchanges have the same agreed terms and the same side as the backup, the import
names them all and offers three answers:

- **Replace the saved copy**, when the backup is newer because the exchange ran
  on another device. The saved copy takes the backup's secret, terms, and
  schedule in place, and keeps its label, working folder, run history, and
  [accounting of disclosures](#the-accounting-of-disclosures). It is refused
  while a run of that exchange is in progress. A configuration-only copy can be
  replaced by a backup of that exchange.
- **Keep the saved copy**, when the backup is older: nothing is imported.
- **Add as a new exchange**, when the backup is a separate exchange with the
  same terms.

Nothing in the files says which copy is newer, so you choose ([the
rule](spec/MANAGED_EXCHANGE_RECORD.md#replacing-a-saved-copy)). Replacing a copy
with an older backup leaves it holding a secret your partner has moved past, and
its next run fails to connect; import the newer backup or re-invite. Importing
the same backup again after a replace is refused as already here.

**A refused file says why.** A file that does not parse leaves only the file
itself to check. A file the format rejects, such as a backup exported by a newer
version than the page is running, names the version difference and both ways
past it: reload the page for the current version, or export the backup again
from the device that wrote it. A backup in the app's previous file format cannot
be imported; set up a new exchange with your partner.

**The import says when this browser does not hold the folder.** A backup holds
the exchange, not the pointer to the working folder (see [The input file each
run](#the-input-file-each-run)), so a restored exchange has no folder until you
choose it again here. Where the source exchange held a folder, the import says
so and links to where it is chosen.

## Removing a managed exchange

Removing a managed exchange is always available, and it removes **everything the
browser holds for it in one step**: the record, the secret, the working-folder
grant, the schedule, the run history, its [accounting of
disclosures](#the-accounting-of-disclosures), and any [results a scheduled run
kept](#where-a-scheduled-runs-results-go). The confirmation says to download
those results and export the accounting first if they must be kept. For an
exchange whose page cannot open, because part of its saved state cannot be read,
the confirmation says the accounting cannot be read and is removed with the
exchange. Removal is local: it does not notify your partner, whose copy stands
until they remove it or a re-invite replaces it. It is not secret expiry: it
erases this party's stored information whatever the secret's state. Removal
covers the browser's storage only; an exported backup file is in your own
custody, and you dispose of it (see [Moving the exchange to another
device](#moving-the-exchange-to-another-device)).

## See also

- [managed-exchange-design.md](notes/managed-exchange-design.md) - why a recurring web exchange is designed the way it is: who it serves, the automation goal, the durability contract, single-device ownership, and telling a desync from an attack
- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's shape (the exchange-file document plus local fields), the persist-before-success step sequence, and the export artifact's custody model
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - the self-attested per-run record of what this party disclosed, produced by every successful run
- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-accounting-of-disclosures) - the accounting of disclosures' stored shape, its append rule, its retention, and the note a run leaves where its record was not filed
- [COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations) - how those per-run records serve an accounting of disclosures
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
