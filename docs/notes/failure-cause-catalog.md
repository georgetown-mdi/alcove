---
title: "The Failure-Cause Catalog"
---

# A failure's cause sentence comes from core; each app binds the remedy

_Status: decided and built. The rule it serves is the failure-message bullet in [CONTRIBUTING.md](../../CONTRIBUTING.md#code-conventions). See [docs/notes/README.md](README.md)._

A failure more than one app reports -- a partner that never arrived, a shared folder that is missing -- used to be worded at each raise site, with a flag name appended by whichever app had injected its guidance into core. The same cause read differently in the CLI and the console, and a core message could name a flag the run did not take.

## Where the two sentences live

Core holds the catalog, `packages/core/src/failureCause.ts`: a `FailureCause` union whose members carry facts only (a channel, a path, an errno code, a wait in milliseconds), `failureCauseSentence` giving the one sentence stating what happened, and `markFailureCause` / `failureCauseOf` attaching the cause to an error as a property tag and reading it back through the cause chain. The tag leaves the error's class alone, so exit-code classification is unchanged. Core's sentence names no flag, control or command. The CLI draws on the catalog, and so does the console for a run its server conducted through the CLI: the CLI's terminal event states the cause as data ([CLI_EVENTS.md](../spec/CLI_EVENTS.md#the-failure-cause)), and the console shows core's sentence with its own remedy. The public web app draws on it for the causes a browser exchange can meet, through its remedy map `apps/web/src/exchange/webFailureRemedy.ts`; the rest of its failure copy does not, and its WebRTC no-show wording lives in apps/web/src (useInviterExchange.ts).

Each app binds the remedy in a map keyed on every `FailureCauseKind`, so a cause core adds fails to compile in an app until it has a remedy. The console's is `apps/web/src/console/consoleFailureCause.ts`, naming the Connection tuning control that sets the wait and the console's shared-folder mount; the CLI's is `apps/cli/src/failureRemedy.ts`; it names only the flag that bounds the run in hand -- `--peer-timeout` on an exchange, `--accept-timeout` on an online invitation -- by reading a second tag the command boundary sets on a partner-never-arrived error. A no-show whose cause holds the shared-name fact (a file with this side's name appeared during the wait) takes a remedy naming the name instead of the wait: `peer_id` in the CLI, "Name for this side" under "How files are handled" in the console, whose seats also offer their way back to those settings beside the retry. Without the fact, the console's no-show remedy on a shared folder adds a clause asking both sides to check that their names differ when this side set one, since a partner that arrived second with the same name refuses this side's file at entry and leaves this side no file to report. The remedy for an unreachable relay registrar is the same in both apps, since the registrar address is set in the configuration and neither app has a flag or control for it, so core holds it (`relayRegistrarUnreachableRemedy`) and both maps return it. A partner that stopped responding during matching takes one remedy in both apps for the same reason, no setting changes the bound it reached, so core holds that one too (`PARTNER_STOPPED_RESPONDING_REMEDY`).

A set of this party's own refused as too large to send, or whose first round could not be counted (`set-over-limit`), takes one remedy in all three apps, since no setting raises the limit, so core holds it too (`setOverLimitRemedy`): split the input or, for a first round over the partner's stated ceiling, ask the partner to run the exchange with the command-line application. The public web app returns it from `webFailureRemedy.ts`, which places it after core's sentence and before the cause chain of an uncounted set. The console titles the failure as the public web app does (`tooLargeFailureTitle`), and for an uncounted set adds the cause chain from the CLI's report, without the sentence and the remedy it already shows, since only that chain states why the count failed.

A single-pass exchange's data over a limit (`single-pass-over-limit`) and more matches than one message can send (`matches-over-limit`) take the same remedy in all three apps for the same reason, so core holds them too (`singlePassOverLimitRemedy`, `MATCHES_OVER_LIMIT_REMEDY`). The single-pass remedy depends on whose data is over: this party's asks to reduce the record count or to split the dataset, and notes when a step that splits values or expands a key raised the count; the partner's alone asks the partner to do so. The console titles a set over the most distinct values one single-pass set holds as it titles a set too large to send, and the other single-pass and matched-list refusals with titles of their own.

A no-show whose cause holds the ignored-hello fact (this run ignored, at start-up, a partner hello nobody had answered, as older than its `ignore_files_older_than_ms`) has core's sentence state that hello's age and the age limit. Its remedy names the two ways to keep a waiting partner's hello from being ignored: in the CLI a longer `ignore_files_older_than_ms` (or `--ignore-files-older-than`) or the same `peer_timeout_ms` on both sides, and the matching Connection tuning controls in the console. The fact holds no file name, so the event stream gains no free text; the CLI's message names the file.

## States no cause names

The CLI's remedy module also states the step for two states only the CLI reaches: an online `alcove invite` or `alcove accept` that saved its key file and stopped without writing its configuration (`keyFileSavedConfigNotWrittenRemedy`), or that stopped before it saved its key file while its partner may have saved the next secret (`keyFileNotSavedRemedy`). Neither is a catalog cause, for three reasons:

- The console runs `alcove exchange` alone, so no second app reports them.
- The state comes with whatever failure ended the run, or with an interrupt that raises no error at all, and an error holds one cause.
- It is no fact of an existing cause either: those state why a partner or a place could not be reached, not what a run left on disk.

So `apps/cli/src/protocol.ts` records the first state, with the configuration the online commands pass it, on the error the run ends with. The command boundary states the step in place of a catalog remedy, and the signal handler states it on an interrupt. The second takes the place of the rotation line the run logs beneath the error or on the interrupt.

The rotation line states what the store order left the two parties holding, and is no catalog cause for the same three reasons. The failure site and the signal handler both write it through one builder, `keyFileStateStep`, from the rotation standing, whether the run is an online setup, the first state above, and how the run ended: on a failure, whether the failure states its own step and whether it was an authentication failure. So the two read alike but for when the run stopped. A failed write to the key file during a run (`keyFileWriteFailure`) takes its wording from the same module, which `protocol.ts` names only by the write that failed.

## Advice written outside the remedy maps

_Survey as of 2026-11-10, read-only. The refactor that moves every run-ending remedy into the app's remedy function cites it, and each stage of that refactor updates the list it changes._

The rule this section measures against: core states causes and facts, and each app writes a run-ending remedy by calling its one remedy function. Every site below writes advice somewhere else.

### Core

- **Named remedy constants composed into core's own error messages.** `NEW_INVITATION_REMEDY` (`auth.ts`; used in `config/keyFile.ts`, and the CLI's `keyFile.ts` and `failureRemedy.ts`), `INVITATION_NEWER_REMEDY` (`config/invitation.ts`; the web app's `invitationDecodeRefusal.ts` reads it), `TERMS_UPDATE_NEWER_REMEDY` (`config/termsUpdate.ts`; the web app's `managedTermsUpdateModel.ts`), `KEY_FILE_NEWER_REMEDY` (`config/keyFile.ts`), `RECORD_MIGRATION_REMEDY` (`records/exchangeRecord.ts`), `EMPTY_MATCHING_DELIMITER_REMEDY` (`config/transformRegexDialect.ts`), and `RELAY_NOT_REACHED_REMEDY` (`relayCheckWords.ts`; the CLI's doctor).
- **Remedies the catalog holds for the apps to share.** `relayRegistrarUnreachableRemedy`, `PARTNER_STOPPED_RESPONDING_REMEDY`, `setOverLimitRemedy`, `singlePassOverLimitRemedy`, `MATCHES_OVER_LIMIT_REMEDY`, `PARTNER_STOPPED_AT_MATCHING_REMEDY` and `CLEAN_DIRECTORY_RESTART_REMEDY` in `failureCause.ts`, by the rule in [Where the two sentences live](#where-the-two-sentences-live): no flag or control changes what they ask.
- **Errors that state their own step.** Fifteen calls in nine core files mark an error with `markStatesItsOwnNextStep`: six error classes in `errors.ts` (`InvitationTermDivergenceError`, `RoundSetLimitError`, `RoundCapacityError`, `FrameSizeExceededError`, `DirectoryListingBoundsError`, `TransportOperationStalledError`), the receipt refusal in `exchange/signingChecks.ts`, the still-working refusals in `exchange/stillWorking.ts`, and one each in `fileSyncRendezvous.ts`, `utils/partnerIndices.ts`, `psi/entityClosure.ts` and `psi/link.ts`, each message ending in advice; and the catalog refusals of an unusable shared secret (`auth.ts`), a partner stopped at matching (`exchange/stillWorking.ts`) and an unconfirmed write (`connection/fileSyncMessageLoop.ts`), whose step each app's remedy map writes.
- **Advice an app injects into core.** The CLI passes `inactivityTimeoutGuidance` and `renameRefusedGuidance` (`run/prepare.ts`, from `run/notices.ts`) into the file-sync connection, which appends them to its own messages; the CLI and the web app pass a `remedy` into `webAppSignaling.ts`. Of these, only the injected `remedy` parameter already follows the shape: core states the fact and the app names its step.
- **Inline advice in configuration refusals.** About 47 lines across 26 core files end a message with a step ("run again", "ask your partner", "then run"), most of them configuration and terms refusals (`config/`, `linkageTermsPolicy.ts`, `payloadExchange.ts`, `config/serverProvision.ts`, `config/metadata.ts`, `config/formatVersion.ts`). They are refusals of the operator's own input, which every app shows as written.

### The CLI

- **`protocol.ts`, the lines the failure site logs itself.** None is written outside the remedy module: [The failure site's own lines](#the-failure-sites-own-lines) lists them.
- **The command boundary and the terminal event.** Both go through `renderFailureForOperator` and `nextStepBeneathFailure` (`util/exit.ts`), which take the fixed steps (`INTERNAL_FAULT_NEXT_STEP`, `PARTNER_REFUSED_NEXT_STEP`, `termsRefusalNextStep` in `termsRefusalRemedy.ts`), the catalog remedy (`failureRemedy`), and the online-setup state. So the `error` event's `message` states the same step as stderr's error line. The lines the failure site logs, the key-file state line among them, reach stderr only, and an interrupt emits no terminal event.
- **Command-local remedy constants.** About forty constants across the commands and their helpers (`commands/*.ts`, `config/exchangeConfig.ts`, `config/persist.ts`, `keyFile.ts`, `fileUtils.ts`, `allowedRelays.ts`, `invitationRelayEnrollment.ts`, `relayKeyRotation.ts`, `signingIdentityDivergence.ts`, `termsUpdateFiles.ts`), and seven CLI errors marked as stating their own step (`psiMemoryBudget.ts`, `termsChange.ts`, `relayKeyRotation.ts`, and the WebRTC broker and relay clients). Each refuses a command's own input before a run starts, and no second app reports it.

### The console and the web app

- **The console's remedy map** is `consoleFailureCause.ts`, reached from `failureContentFor` in `apps/web/src/exchange/useInviterExchange.ts` for a relayed `error` event holding a `cause`.
- **Copy keyed on message text.** `partnerCertificateRefusal.ts` matches core's five `PARTNER_CERTIFICATE_REFUSAL_MESSAGES` by text to replace their configuration-key remedy with the receipts card's controls: a cause the catalog does not name, read back from its sentence.
- **Copy keyed on error class and exit code.** `failureContentFor` writes about forty titled accounts by error class, category and exit code, the partner refusal (exit 76) and the security fallback among them, beside the relayed message where the event holds `recoveryHint`.
- **The public web app** runs core in the browser and shows core's messages, so every core constant above reaches it as written. Its remedy map, `exchange/webFailureRemedy.ts`, writes the remedy for a set too large to send, the single-pass and matched-list refusals, an unusable shared secret and a partner stopped at matching, wherever it shows a failure raised in the browser: the one-shot exchange's alert (`useInviterExchange.ts`) and a managed run's launch state (`recurring/managedRunLaunchModel.ts`); its no-show and managed-run copy (`useInviterExchange.ts`, `psi/managed/managedFailureCopy.ts`) does not draw on the catalog.

### The failure site's own lines

The lines `runProtocol`'s catch (`apps/cli/src/protocol.ts`) logs beside a failure are built in the CLI's remedy module, `apps/cli/src/failureRemedy.ts`. The catch passes each function the facts it knows, and the function returns the line or `undefined`:

- `bothSweptStep` writes `BOTH_SWEPT_GUIDANCE` for a peer-wait timeout on a run that swept the shared folder in delete mode first.
- `missingReceiptWarning` writes the signed-receipt warning for a run that configured a signed receipt and failed before the receipt swap completed, naming the inactivity limit through `raiseInactivityLimit` (`connection/timeoutGuidance.ts`).

The survey names no other run-ending remedy the failure site writes itself. Across the apps:

- Neither line has a second copy: the signal handler states only the key-file state line, and the `error` event states neither, as `protocol.test.ts` checks. The key-file state line stays out of the terminal event as well.
- The console reads the `error` event, and the CLI's stderr only when no terminal event arrives, so it reaches neither line and holds no copy of either.
- On a run that cleared leftover files in delete mode and then timed out waiting for the partner, both apps state the both-swept line: the CLI's stderr beneath its no-show remedy, the console in its own words ahead of its no-show remedy (`consoleFailureCause.ts`). Both apps cover both timeouts: the rendezvous wait, which the side that cleared files second meets, and the key-exchange handshake, which the side that entered first meets. The handshake timeout states no cause on the `error` event, so the console recognizes it by the first line of the event's `message`, core's `KEX_HANDSHAKE_TIMEOUT_MESSAGE`, which `protocol.test.ts` pins on the event the CLI builds.

### What the survey decides

- **The event contract.** Writing the CLI's key-file state line and key-file write failures from its remedy module, with the state line still logged by the run, changes nothing in `packages/cli-contract` or [CLI_EVENTS.md](../spec/CLI_EVENTS.md). Two later moves would:
  - Stating the key-file state line inside the `error` event's `message` sets `recoveryHint` on every failure it follows, an exit-77 key-exchange failure among them, which by [The self-explaining marker](../spec/CLI_EVENTS.md#the-self-explaining-marker) has no marker; the console would then show its trust-check copy for it in place of its fresh-invitation copy.
  - Turning a core remedy constant into a catalog cause adds a `cause` kind (`packages/cli-contract/src/failureCauses.ts` and the event spec's table), additive under `v: 1`. The event's `message` keeps its text, with the remedy on a line of its own after core's sentence, and `recoveryHint` stays set. The web app then needs a remedy for each new kind, since it shows core's sentence and remedy together as core wrote them.
- **The remedy-type guard.** A type only the remedy maps can produce is not built while most of the sites above write their advice inline: every sink would need an exception until its sites move. It fits the last stage, once the maps hold every run-ending remedy.

### Core's remedy constants as causes, in parts

_Plan as of 2026-11-11: parts 1, 2 and 3 built; the remedy-type guard, the last stage, not yet built._ Turning every core constant into a cause needs a sentence in the catalog for each of about thirty raise sites, a validator and a stream row per kind, a remedy in each app's map, and a remedy map for the public web app. So the work lands in three parts, grouped by what the failure is.

Every part follows one shape:

- The raise site throws an error whose message is core's sentence, tagged with the cause, the facts the message states today as its fields. The kind is added to `packages/cli-contract/src/failureCauses.ts` and the table in [CLI_EVENTS.md](../spec/CLI_EVENTS.md#the-failure-cause), additive under `v: 1`.
- The CLI states its remedy through `failureRemedy`, so stderr and the `error` event's `message` show the remedy on its own line beneath core's sentence rather than at the end of it. `recoveryHint` stays set, since `nextStepBeneathFailure` returns the remedy.
- An error marked by `markStatesItsOwnNextStep` keeps the mark, which also keeps the key-file state line and the generic post-handshake advice from printing beneath it.
- The console binds the remedy in `consoleFailureCause.ts`, and the public web app in `exchange/webFailureRemedy.ts`, applied where it shows a core error's message. A file-sync failure reaches the CLI and the console only, since the public web app conducts WebRTC exchanges alone (`CLAUDE.md`, Applications).

The parts:

- **Part 1, set-size refusals: built.** A set of this party's own refused as too large to send, or uncounted, is the `set-over-limit` kind, raised by `setOverLimitError` from `exchange/firstRoundCapacity.ts` (five refusals) and `psi/participant.ts` (two), with the remedy in `setOverLimitRemedy` (see [Where the two sentences live](#where-the-two-sentences-live)). Its facts are when the set was refused, whose limit it is over, the count and the limit, and the rounds the count covers. The copy follows the catalog's rules:
  - Each sentence is one sentence ("... can hold, so nothing was sent."), and the uncounted refusals join their two clauses with ", and".
  - Its counts go through `formatCount`, as [Formatting the facts](#formatting-the-facts) states: "16,777,216".
  - The CLI writes the remedy on a line of its own beneath the sentence, after the cause chain of an uncounted set, as it does for every cause. The console and the public web app keep it on the sentence's line.
  - The console shows core's sentence and remedy under the public web app's title for the refusal.
- **Part 2, single-pass and matched-list ceilings: built.** A single-pass exchange's data over a limit is the `single-pass-over-limit` kind, raised by the browser pre-flight in `exchange.ts` (`browser-dataset`) and three sites in `psi/link.ts` (`value-slots`, `frame`, `distinct-values`), with the remedy in `singlePassOverLimitRemedy`. More matches than one message holds is the `matches-over-limit` kind, raised by `sendMatchedListWithin` in `psi/matchedListParts.ts` for a round's grouping and a single-pass resolved table, with the remedy in `MATCHES_OVER_LIMIT_REMEDY`. The copy follows Part 1's rules:
  - The sentence names no participant role, and its counts go through `formatCount` with plural nouns ("2 value slots").
  - A partner's value slots over the limit read as one sentence ending "while your own N value slots are within it.", and the remedy asks the partner to reduce their record count.
  - The matched-list sentence states that the exchange stopped and told the partner; the remedy states the likely reason and the step.
- **Part 3, run-ending refusals outside the data: built.** Four kinds, raised where core wrote the remedy into its message:
  - `shared-secret-unusable`, a malformed secret or one expired before the handshake (`auth.ts`) or before the next one was saved (`protocolSetup.ts`), both through `sharedSecretUnusableError`. The CLI remedies it with `NEW_INVITATION_REMEDY`; the public web app and the console ask for a new invitation without naming a command.
  - `partner-stopped-at-matching` (`exchange/stillWorking.ts`), with `PARTNER_STOPPED_AT_MATCHING_REMEDY`. The console keeps the partner refusal's config category and withheld retry for it.
  - `message-write-unconfirmed`, the three write refusals in `connection/fileSyncMessageLoop.ts`, with `CLEAN_DIRECTORY_RESTART_REMEDY`.
  - `shared-name-at-entry`, the start-up refusal of a hello with this side's name (`connection/fileSyncRendezvous.ts`). The CLI's remedy and its no-show remedy for the shared-name fact share one step, so no copy of the sentence remains; the console names its name control and its sweep control.

  The copy follows the catalog's rules. Each sentence is capitalized; the malformed-secret sentence drops the list of allowed final characters, which the key-file schema's own refusal still states, since no catalog sentence holds brackets; and the shared-name sentence says "this side's name" for `peer_id`, as the no-show sentence does. The console shows the CLI's cause chain for the write and entry refusals (the transport's error, the files found), cut before the CLI's remedy line as for an uncounted set.

Left as they are:

- Refusals of a file or document the operator supplied, raised as validation issues before any run, by the rule in [Core](#core) for configuration refusals: the format-version remedies `INVITATION_NEWER_REMEDY`, `TERMS_UPDATE_NEWER_REMEDY`, `KEY_FILE_NEWER_REMEDY` and `RECORD_MIGRATION_REMEDY`, the key-file schema's malformed-secret message (`config/keyFile.ts`, a schema issue with no error to tag), and `EMPTY_MATCHING_DELIMITER_REMEDY`, which a step editor also shows as its field error.
- `RELAY_NOT_REACHED_REMEDY`, which ends no run: it is a diagnostic line the CLI's doctor and the web app's relay check share, naming no flag or control.
- `NEW_INVITATION_REMEDY` stays exported for the CLI's key-file steps, which no cause names ([States no cause names](#states-no-cause-names)).

The remedy-type guard follows the three parts.

## Formatting the facts

A wait is stated by `formatWaitDuration` in the largest whole unit that states it exactly, and every count goes through `formatCount` (`packages/core/src/utils/formatCount.ts`), whose explicit locale keeps the digit separator ASCII for the CLI's console check. An OS error code goes in parentheses after the path or host it concerns. A fact the raise site cannot know -- a channel or a wait when the connection holds no configuration -- is left out of the sentence rather than guessed. Internal tags such as a `[role]` prefix stay in debug logs.
