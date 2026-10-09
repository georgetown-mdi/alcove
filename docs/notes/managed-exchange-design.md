---
title: "Recurring Web Exchange Design"
---

# Recurring web exchanges: the design and the decisions taken

_Status: decided and built, except the grace window, which is deferred and not designed.
The user guide is [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md), which says what an operator does and sees.
The record's fields, the persist-before-success step sequence and the export artifact's format are specified in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md) and are not restated here.
The browser at-rest threat model is in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
This note records why the recurring (managed) exchange is shaped the way it is.
See [docs/notes/README.md](README.md)._

Persisting a rotating secret at rest reverses the one-shot exchange's discard (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)), so work on this feature stays gated on security review.

## Who this is for

The managed exchange serves the **small or no-IT organization**: the audience [DESIGN.md](../DESIGN.md) names as often lacking the technical sophistication for regular data linking, for whom the project works browser-first without installed software.
That organization cannot take the documented web-to-CLI handoff (download an exchange file, run the CLI on a schedule), because the handoff's destination is the installed, IT-operated tooling it does not have.
The managed exchange gives that operator a recurring partnership without leaving the browser.

The calibration holds in both directions.
An organization **with** IT support should still graduate to the CLI plus host cron.
The CLI remains the stronger recurring tool: on-disk key-file durability instead of evictable browser storage, an OS scheduler instead of a browser runtime kept alive, and the hardened container deployment.
The graduation point is when the organization can vet and operate installed software at all.

Every choice below is calibrated to the no-IT persona, not to the organization that has better options:
browser persistence with plain eviction handling,
automation inside the operator's own browser runtime,
and a plaintext export under operator custody.

## What "managed" adds, and what it does not

A one-shot web exchange is single-use: the browser runs the authenticated exchange, derives the rotated secret, and **discards** it, so the exchange cannot run again and nothing sensitive persists.
A managed exchange instead persists the rotated secret alongside this party's exchange-file document (the standing terms and rendezvous locator, the browser's analog of `alcove.yaml` plus `.alcove.key`), so the same partnership can run again later.

What managed **adds**:

- A **managed exchange record** in the browser (IndexedDB, origin-isolated) that survives runs, crashes, and restarts.
- A **rotating shared secret at rest** in that record, in place of the one-shot discard.
- **Scheduled, unattended runs** as the design goal.
  Once an exchange is managed and a schedule agreed, runs happen with nobody present, on the platforms that can support it.
  An attended one-action re-run is the named degradation (see [The automation goal and its platform envelope](#the-automation-goal-and-its-platform-envelope)).
- **The results of those runs kept for the next visit**, since nobody is present to download them.
  That puts linkage results at rest in the browser, bounded by a stated retention, by a size above which nothing is kept, by a control that clears them now, and by deleting the exchange (see [Where a scheduled run's results go](../MANAGED_EXCHANGE.md#where-a-scheduled-runs-results-go)).

What managed does **not** add:

- **No server-side execution.**
  Automation runs in the operator's own browser runtime, an installed app kept running on the operator's machine, never on a server acting for the party.
  The installed-software path for scheduled runs remains the CLI plus a host scheduler such as cron (see [Scheduling the run](../CLI.md#scheduling-the-run)).
  The console is not a scheduling path: it facilitates a single exchange (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary)).
- **No second copy of the input data.**
  The record never holds the input file's contents or any row value.
  Where the platform allows, it holds a folder **handle**, a pointer to the folder the operator's file is in, not a copy (see [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md)).
  A scheduled run's kept results are the one thing at rest that does hold row values, and they are the run's output, not a copy of the input.
- **No server-side persistence.**
  There is one persistence target: the browser, origin-isolated, never a server.
  There is no profile-split persistence provider to choose between.

## The automation goal and its platform envelope

The design goal is a **fully automated recurring exchange**: once an exchange is managed and its schedule agreed with the partner, runs happen unattended.
Browser automation is a compromise against installed software, and the compromises are accepted.
What is not accepted is settling for an attended flow where the platform can support an unattended one.

**The primary path is an installed PWA on Chromium.**
The app is installed and launched at OS login (or otherwise kept running), and the exchange executes in the app's own window context.
WebRTC is unavailable to service workers, and Periodic Background Sync's short opportunistic windows cannot support a live exchange, so the mechanism is an open app runtime and not a service-worker wakeup.
At the agreed window the runtime reads `input.csv` from the exchange's working folder, through the record's persisted `FileSystemDirectoryHandle` under its persistent permission (a pointer, never a copy).
The run then executes, rotates, and persists per [the durability contract](#the-durability-and-crash-consistency-contract), with nobody present.

The degradations are named, and none of them is a design floor:

- **No installed PWA** (an ordinary Chromium tab): the run is operator-initiated, one action reading from the working folder.
- **No File System Access API** (Safari, Firefox): the run is attended and the operator chooses the input file for it.

The surfaces name the degradation the operator is looking at, never the capability in general.
The guide's [How a scheduled run happens](../MANAGED_EXCHANGE.md#how-a-scheduled-run-happens) says what each one shows.

**An unattended run takes two parties.**
A WebRTC exchange is live: both parties' runners must be awake in an overlapping window, so the run schedule is partnership-level agreement, coordinated out-of-band as the terms are.
A partner whose runner does not arrive in the agreed window is a benign retry-at-next-window outcome, never evidence of an attack.
The record's closed field layout for the schedule and the retry bookkeeping is in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object).

## Why the schedule is a local field

The schedule is **not** written into the exchange-file document and **not** part of the invitation wire.
The document is the shared terms-and-locator config, whose terms change only through a terms change both parties review.
A reschedule is neither a terms change nor a credential, so the schedule is a local record field instead (the `schedule` object; see [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object)).
Nothing about the schedule is sent to a server or to the partner over the wire; there is no server-side coordination anywhere in the design.

The cost of local-only entry is that each side types the same values by hand, so a mistyped cadence or window on one side produces windows that never overlap.
That failure is benign and announces itself as mutual missed windows, which the operators resolve out-of-band where they agreed the schedule in the first place.

## Retry and repeated misses

Retry happens at the next agreed window and never sooner, because a sooner retry would need the partner's runner to be awake off-schedule, which an agreed window exists to avoid.
Whoever showed up records the miss.

That bookkeeping is **one-sided by construction**.
The escalating surface fires on the party that keeps showing up, the party positioned to reach out, while a persistently absent party's runtime may never be awake to see anything.
The asymmetry is accepted because reconciliation needs only one side to raise it, over the channel where the schedule was agreed.
The absent side is not left permanently ignorant either.
A runtime that wakes to find windows fully elapsed counts each one as a miss and lands on the next live window (the catch-up rule; see [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#catch-up-on-wake)), so its own repeated-miss surface fires at that wake.
It learns late, but it does learn.

The coordination prompt names a schedule that differs from the partner's as the likely cause, because each side enters the agreed window on its own clock and a hand conversion between time zones is the easiest way to get it wrong.
It also names this machine's own clock, because a wrong local time source produces the same pattern of misses, and a no-IT operator pointed only at the partner would never look at their own machine.

The escalation threshold is a window count, not a wall-clock age, so it is **cadence-relative**: on a monthly partnership the escalated state is months away.
That is accepted because each miss already fires its own notification at its window, so the operator is not in the dark in the interim.
The threshold gates only the escalated coordination-problem wording, not the operator's first knowledge of a miss.

### Repeated misses surface, they do not auto-pause

The question: after enough consecutive misses, should the app **automatically pause** the schedule (stop attempting until the operator re-enables it), or only **report** the problem and keep attempting on cadence?

The design chooses **report-only, no auto-pause**, because for the no-IT persona the two failure modes are not symmetric:

- **Auto-pausing is silent, and the persona visits rarely.**
  A paused schedule stops trying with no visible signal, so a partnership that stopped attempting looks like a healthy one until the next in-person visit, which may be weeks away.
  A schedule paused without notice ends the partnership without notice.
- **Continuing to attempt is cheap, and what it costs is bounded.**
  A window against a partner who has gone away is a bounded series of attempts: the window's width divided by the per-attempt wait for the peer, up to a cap (see [Occupying a due window](../spec/MANAGED_EXCHANGE_RECORD.md#occupying-a-due-window)).
  Each attempt re-reads and column-checks the input file from the working folder, since the input guard runs ahead of the rendezvous.
  Each attempt also registers a peer at the coordination server under the rendezvous id derived from the record's current secret.
  A miss does not rotate that secret, so a partnership that has stopped meeting re-registers the *same* id at every attempt of every window.
  The cost is repeated local file reads plus a repeating registration pattern at the server the partnership already uses.
  No payload leaves the device, nothing of the exchange is sent anywhere, and the secret is neither exposed nor rotated.

The full cost of not pausing is that the miss surface must itself be trustworthy.
If it read as noise the operator learned to ignore, endless quiet retries would hide a lapsed partnership as well as a silent pause would.
So the miss surface is **moment-anchored and escalating**: one informational note per miss at its window, and the actionable coordination state only once the pattern is real.
A standing warning the operator clicks through would defeat it (the backup surfaces follow the same discipline; see [Moment-anchored backup surfaces](#moment-anchored-backup-surfaces)).

One thing does stop the attempts, and it is not a heuristic: the operator's own "something does not add up" answer at a failure check holds every window after it until they clear it.
Those windows are recorded as skipped, not missed, so they never build the pattern the coordination prompt reads.

Deleting the exchange stops all attempts.
A pause control and in-place schedule editing arrive with the scheduling surface.
What the design declines to do is make the pause decision *for* the operator on a heuristic.
For this persona a wrong automatic pause (a partnership ended without notice) is worse than not pausing (cheap, visible, ignorable retries).

## Why no file handle is kept across runs

A `File` the platform hands back is the file as it stood at that instant.
Once the file underneath it changes, reading that `File` fails and returns neither period's contents.
The design therefore looks the name `input.csv` up at each run start and keeps no `File` across runs: a run reads the current file or fails, never last period's data.

## The durability and crash-consistency contract

The persisted secret is a **linear resource**: after each successful run both parties derive the same replacement secret and retire the old one, so there is one live secret between the two parties at any moment.
That property makes the ordering of persistence and success critical.

### Persist-before-success

Within a run, the rotated secret is written durably to the browser store, and the write is awaited to completion, **before** this party begins the data exchange, the first peer-visible act after the handshake.
The protocol has no discrete "success" signal to hold back.
Both sides rotate at handshake completion, and the exchange's terminal act is a fire-and-forget final send, so the data exchange itself is what the persist must precede.

The order is:
handshake completes,
rotated secret persisted and the write awaited,
data exchange proceeds,
local success recorded.

This is the browser analog of the CLI's write-then-exchange ordering, where the key file is written through an atomic, fsync-durable path right after the handshake rotates the secret and before the data exchange runs (see [Key file security](../SECURITY_DESIGN.md#key-file-security)).
The step sequence and the store transaction it awaits are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering).

What the ordering buys is scoped: it removes **this party's contribution** to the desync window.
After the handshake, a crash on this side leaves this party either on the old secret (persist not committed; it retries from the old secret) or durably on the new one.
It never advances into the exchange with the new secret held only in volatile memory.
It cannot remove the two-sided residual: the partner's own persist can fail independently, and neither side can know whether the other's save succeeded.
The CLI states the same one-sided limit when its key-file write fails after rotation.
That residual is what [desync recovery](#desync-detection-and-recovery) exists for.

### The durability limit

The browser cannot match the CLI's on-disk durability, and the contract says so:

- **A committed browser write is not a flushed one.**
  The rotated-secret write asks the store for the strongest durability the engine offers and still cannot promise the bytes reached stable media.
  It survives a tab or renderer crash, but not necessarily an OS crash or power loss, and nothing in the browser matches the CLI's forced flush and directory flush (see [CREDENTIAL_STORAGE.md](../spec/CREDENTIAL_STORAGE.md)).
  The transaction durability semantics this rests on are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering).
- The store can be **evicted wholesale** by the browser, silently, with no crash and no operator action (see [Surviving storage eviction](../MANAGED_EXCHANGE.md#surviving-storage-eviction)).
  The CLI's on-disk key file is not removed out from under it.

The ordering therefore guarantees renderer-crash consistency.
The OS-crash and power-loss residual, like eviction, is covered by [fast re-invite](../MANAGED_EXCHANGE.md#recovery-fast-re-invite) and not by a stronger at-rest guarantee.
Browser at-rest durability is best-effort, and the design never presents the browser store as equivalent to a file on disk.

## Single-device ownership

Because the secret is a linear resource, a managed exchange is owned by **one device**: on the scheduled path, the one machine whose installed app runtime executes the runs.
Two devices (or two runners) that both hold the secret and both run fork it permanently.
The first to run rotates, and the other's copy is stale at once with no way to reconcile automatically (there is no [grace window](#the-grace-window)).
Single-device ownership is an invariant, not a recommendation.

Two mechanisms uphold it: a lock within one browser profile, and migration in place of sync across devices.
Both are specified in [Single-owner invariant](../spec/MANAGED_EXCHANGE_RECORD.md#single-owner-invariant); this section records why they take the shape they do.

### Cross-tab single-writer locking (Web Locks)

The **run+rotate** critical section is guarded by a single-writer lock (the Web Locks API, `navigator.locks`) keyed to the managed record's id.
It is held from "begin this run" through the success that run records, the exchange with the partner included.
Two tabs of the same origin cannot both enter it: the second waits or is refused.
So a scheduled run and an operator-opened tab, or two tabs, on one device cannot fork the secret by racing a run, and no two of them exchange with the partner for one record at the same time.

A hand-off's confirmation takes the same lock before it spends this device's copy, so a hand-off and a run exclude each other as two runs do.
Whichever takes the lock first wins: a confirmation meeting a run is refused and told to wait, and a run meeting a confirmation waits for it and then finds the copy handed off.
Creating a re-invitation takes the lock on the same terms before it replaces the secret, so a run and a fresh invitation cannot each write a secret the other discards.

On the scheduled path a runner occupying a window holds the lock almost continuously from the window's open to its close, hours at the intended widths.
Each attempt holds it across its whole wait for the partner, and the next attempt begins as soon as the last one's wait ends.
An attempt's wait is clamped to the window's close, but a handshake that completes just before the close holds the lock through the payload exchange that follows.
An operator told a run is already in progress is seeing the single-writer property work.

The lock is a same-profile **liveness guard**, not a persistent claim.
It is released automatically when the holding tab or worker is destroyed, and it is taken without `steal: true`, since a steal would defeat the single-writer property it exists to provide.
Web Locks is origin-scoped and same-profile, so it guards concurrency **within one browser profile on one device**, the scope where a racing second context is a realistic accident.
It does **not** and cannot guard against a second physical device or a second browser profile holding a copy.
The durable single-owner property rests on migration in place of sync, below, and not on the lock.

### Export/import is migration, not sync

Moving a managed exchange to another device is **migration**: the source copy is spent when the handover completes, so the secret is handed over and never duplicated.
There is no sync by design, since syncing a linear secret across two live copies is the fork the invariant forbids.
Framing the operation as "take over on this device" in place of "copy to this device" is what keeps a single owner across a device change.

The two export intents are distinct in the UI even though the artifact is one format.
A backup export leaves the source live; a migration export spends it.
The source is spent on the operator's attestation that they saved the artifact, not at the moment of export, so a cancelled or failed save leaves the source live and recoverable by exporting again.
On confirmation the source record visibly turns into a spent, handed-off state, so the invalidation, which rests on cooperation and not cryptography, is clear at the one moment it can be broken.

Both hand-offs re-read the stored record at confirmation and refuse unless what was downloaded still holds the current secret.
A run rotates that secret at its handshake, so a run that reaches the partner between the download and the attestation supersedes what was downloaded.
Confirming it would hand the new owner a copy whose first run meets a partner that has moved on, and only a re-invite would recover the pair.

The refusal also runs the other way, on the run path itself and not on what a screen last read.
A run that finds this browser's copy spent stops before reading the input or connecting, so a hand-off confirmed while a run surface stood open, or between two attempts at one window, is not overtaken by the run that follows it.

The hand-offs are also withheld from the screen while a run holds the lock.
That withholding is a reading of the lock taken every so often, so it can miss a run that starts between two readings.
Nothing rests on it: confirming a hand-off takes the run's own lock before it spends anything, so a confirmation that spends and a run that rotates exclude each other, in either order.

The artifact is a **plaintext credential file in the operator's custody**.
Passphrase encryption is not done, by design: the record must be usable with nobody present to supply a passphrase at the moment of use.
It is the browser analog of handing over `alcove.yaml` plus `.alcove.key`, and it adopts the key file's trust model: `.alcove.key` is a plaintext credential protected by custody and storage permissions, not a passphrase (see [Key file security](../SECURITY_DESIGN.md#key-file-security)).
The artifact does not rotate: it snapshots the secret current at export, so a stale artifact stays usable until the partnership rotates past it or any `expires` it holds lapses.
Its shape and the no-anti-rollback caveat are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#export-artifact).

The invalidation is an **operator-cooperation property, not a cryptographic one**.
Nothing in the protocol prevents a copied artifact, a browser-profile backup, or a VM snapshot from bringing back a copy the UI spent.
A captured or duplicated export is therefore a captured credential, live until the partnership rotates past it, under the standard [compromise response](../SECURITY_DESIGN.md#compromise-response) (notify the partner out-of-band, re-invite).
Why the protocol cannot detect that, and the deferred hardening that would, are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).

The command-line export is a migration by another route, and the single-owner rule applies to it unchanged.
Its spend is operator-attested for the same reason a device migration's is: two downloads are two chances for a save to fail, and a click gives no landing signal.
No path hands the secret to a scheduler and leaves a second live owner behind.
Its two files are the command line's working copy, rewritten by every run there, so taking them does not count as a backup this browser restores from.

## Bringing a command-line configuration back

The import of an `alcove.yaml` serves an operator who would rather set an exchange up in a browser than author YAML, and run it where the data and the scheduler are.
What it accepts follows from what this browser can hold and run.

- **Connection settings this browser cannot apply are refused.**
  The record holds a webrtc connection as the credential-free locator this app composes, so a TURN credential, an ICE provisioning block or a PeerJS server key is refused rather than stored.
  An sftp connection is held whole because nothing here runs it: each setting goes back into the file Alcove runs.
- **No secret is stored from the configuration.**
  A credential is held only as an `@path` reference, since this browser stores no secret value.
  A shared secret comes in only from the `.alcove.key` chosen beside it.
  The command line warns about and strips a secret written in `alcove.yaml`; the import refuses one, so the key file is the one route a secret takes into this browser.
- **Refusals name fields as the file spells them**, so the operator fixes the line in the file rather than looking for a control in the app.
- **A match by terms and side lands only on the operator's word.**
  A pair holds no record id, and two separate exchanges can share terms and side, so a stored exchange found that way is offered, never assumed.

The import's rules are in [The configuration-only record](../spec/MANAGED_EXCHANGE_RECORD.md#the-configuration-only-record) and [Importing the key file beside a configuration](../spec/MANAGED_EXCHANGE_RECORD.md#importing-the-key-file-beside-a-configuration).

## Desync detection and recovery

A rotation desync is the failure the durability contract is built to avoid, but it cannot be driven to zero.
A wholesale eviction between rotation and the next run, or a migration the operator mishandles, can still leave the two parties on different secrets.
The design must let a party tell a desync apart from an attack and recover quickly.

### Detection: an implicit generic failure

When the two parties hold different secrets, the authenticated handshake **fails closed**, the same failure a wrong secret, a tampered frame, or an active impersonation attempt produces.
That shows as one generic authentication failure with no way to tell "we rotated out of sync" from "someone is attacking this exchange".
The web handshake wrapper re-tags every trust failure as a single `security`-kind error on the one-shot and managed flows (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)).
A managed exchange makes this ambiguity sharper than the one-shot flow does, because a desync is an event an operator will hit in normal operation of a recurring partnership, not a one-time setup slip.

A no-show is no evidence of a desync, and no evidence against one.
Both rendezvous ids derive from the shared secret, so two sides holding different secrets wait on addresses the other is not using, and each records a no-show for as long as the desync stands.
So the no-show is the reading of last resort, outranked by any standing reason this device holds to doubt its secret.

A one-sided rotation leaves a marker behind for the same reason.
The run writes a rotation-in-flight marker once the partner connects, and the write storing the rotated secret removes it, so a tab killed between the two leaves the marker as evidence of the one-sided rotation persist-before-success cannot rule out.
Its fields and write order are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-rotation-in-flight-marker).

A run's bookkeeping holds one run, so the next stamp, a benign no-show above all, would replace the evidence of a failure the operator must settle with their partner.
That is why such evidence is also raised as a standing condition, beside the run bookkeeping, where no later run's stamp reaches it.
Without it, the confirmation reserved for this class would be asked for once and never again: every visit after the first no-show would report that the partner did not arrive, and stop.
A successful run does not clear it either: it rules out neither a third party who tried and moved on nor an accidental self-fork, the two readings the confirmation exists to separate.
The first condition stands against later ones because answering it is a single act over everything that stood before it.
A store failure can span a run's rotation write and its own best-effort bookkeeping write, then recover in time for the schedule's advance, so the window's own write raises the condition a second time.
The raise sites and what clears the condition are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-standing-condition).

### The grace window

A grace-window mitigation for a rotation desync is deferred.
On a handshake failure it would briefly also accept the **previous** rotated secret, so a one-sided persist failure heals itself on the next run in place of forcing a re-invite.
It is a core-level change for a later, separately reviewed step, and it is **not implemented anywhere**: neither the CLI nor core accepts a previous secret.
The current handling is the re-invite recovery, with the rotation-in-flight marker naming a probable partial rotation.
The first managed release ships with implicit-only detection plus the explicit recovery.

The grace window belongs in core and not in the web app, and later and not first, because it is a threat-model change.
It widens the active-impersonation window for a leaked secret (it accepts an extra, older secret), so the CLI and the web app should inherit one reviewed implementation and not diverge on a web-first version.
Fast re-invite already closes the operational gap without it, so the first release is not blocked on it.
The anticipated core shape is a brief **two-secret rotation window**, keeping the previous secret during rotation, which stays deferred and is not designed here.

### Telling a desync from an attack

Without a grace window, the design cannot *cryptographically* tell a desync from an attack: both are the same failed handshake.
What the managed UX does is **tier the response by what the record already knows**, so the operator faces the full confirmation only when nothing else explains the failure.
The tiers read the record's evidence, not whether the operator is present, so a failure from an unattended run is reported through the same tiers at the operator's next visit.
The record's run bookkeeping is structured enums so that the first tier, a local benign explanation, can be derived and never guessed.

The second tier, no local explanation, makes the operator do real work.
Naming benign causes first is the reading an active impersonator wants the operator to reach, and "did you also see a failure" is a question an adversary who just caused the failure can predict will be answered yes.
So the confirmation is a forwardable, pre-filled out-of-band message, never prose the operator has to compose under stress.
It asks the partner to confirm a real failure on their side, since inferring one from this side's failure alone is the reading the adversary wants.
It also asks whether they ran the exchange from more than one place, because an accidental self-fork looks like an attack to the other party and this question is the only way to expose it.

The partner's reply feeds a **two-outcome gate**, not a free-form judgment.
This follows the CLI's approach: the tool reports the failure and structures the confirmation, and the operator, not the tool, makes the desync-versus-attack call out-of-band.

A standing compromise response skips scheduled windows but leaves the attended run available.
The difference is who decides: an attended run is the operator's own act, taken with the response's warning in front of them, while a scheduled one would be taken by a machine with nobody watching, putting the flagged secret back on the flagged channel.

While a compromise response stands, no control offers a fresh invitation, because creating one on that channel is the act the response names as the wrong one.
The controls read the record a page loaded, so the write that would rotate the secret reads the stored record again and refuses, and a tab opened before the answer cannot create an invitation past it.
The acknowledgement that clears the response puts the invitation back on offer after it, so the order is: reach the partner another way first, then re-invite.
That order is what the response is for.
A run that failed the same way after the answer is a failure the operator has confirmed nothing about, so it gets its own gate before any invitation.
The response's rules are in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-operators-response-to-it).

A run in flight withholds the same two controls for a different reason: a fresh invitation would replace the secret the run is connecting on.
The screen's reading of a run in flight is polled and can be stale, so nothing rests on it: creating the invitation takes the run's lock before it replaces the secret ([Cross-tab single-writer locking](#cross-tab-single-writer-locking-web-locks)).

### Recovery: fast re-invite

"Fast" means the managed exchange keeps everything a re-invite needs that is **not** the secret: the exchange-file document, with its terms and rendezvous locator.
A re-invite reuses the standing definition and only creates and exchanges a new setup secret, without re-authoring the exchange.
That makes re-invite cheap enough to be the first-line recovery, which is what lets the first release ship without the grace window.

Cheap recovery has a cost.
Every re-invite puts a fresh live setup secret on the out-of-band channel, so over a partnership's life the invitation-confidentiality requirement (see [Invitation contents and confidentiality](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)) is **ongoing, not one-time**.
Each re-invite is a fresh exposure of an invitation in transit, on a channel whose security must still hold.
An adversary who can provoke handshake failures, or who exploits the desync ambiguity itself, can farm an operator who re-invites on autopilot for fresh secrets over a channel the adversary may already have compromised.
The confirmation checklist is what breaks that loop, which is why it must verify a real partner-side failure and never approve the benign reading by default.
This trade, cheap recovery against repeated exposure of a secret in transit, is accepted by design.

## What a re-run is authenticated against

A re-run is authenticated against **continuity of the shared secret**, and nothing else.
Each side proves it holds the current rotated secret, the handshake fails closed if either does not, and the rendezvous the two runners meet at is itself derived from that secret.
A run's whole claim to be the agreed partnership is that the secret has descended unbroken from the one exchanged at setup (see [Key-agreement design](../SECURITY_DESIGN.md#key-agreement-design)).

That does not include a verified counterparty identity.
The exchange authenticates possession of the secret, never who holds it, and no partner certificate or fingerprint is checked on this path.
A leaked or copied secret therefore permits impersonation until the partnership rotates past it (see the [compromise response](../SECURITY_DESIGN.md#compromise-response)), and a failed handshake cannot by itself say whether the two sides drifted apart or someone is attacking the exchange.

## Moment-anchored backup surfaces

Eviction is silent, so the UI must not be.
But a warning that is always on trains the operator to click through the one that matters.
The design therefore collapses persistence status into **one derived backup state**, shown at the moments it changes and never as standing chrome.

The browser's storage grant (`navigator.storage.persisted()`) is never its own displayed line, because the operator cannot act on it except by exporting, which the backup state already covers.
On WebKit a granted `persisted()` never suppresses the backup-needed state, since the grant does not reliably exempt Safari's seven-day cap.

A scheduled exchange's standing export goes stale between visits **by design**, when the run cannot write the backup into the working folder itself.
The backup state reports that at the next visit as a state, not a nag, and the between-visit notification prompts sooner.
The rule throughout: each statement appears at the moment it becomes true and actionable.

The in-browser copy is treated as convenience and the exported credential file as the durability of record, so an operator is never surprised by a silent eviction they were implicitly told could not happen.
