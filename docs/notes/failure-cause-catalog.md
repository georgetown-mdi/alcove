---
title: "The Failure-Cause Catalog"
---

# A failure's cause sentence comes from core; each app binds the remedy

_Status: decided and built. The rule it serves is the failure-message bullet in [CONTRIBUTING.md](../../CONTRIBUTING.md#code-conventions). See [docs/notes/README.md](README.md)._

A failure more than one app reports -- a partner that never arrived, a shared folder that is missing -- used to be worded at each raise site, with a flag name appended by whichever app had injected its guidance into core. The same cause read differently in the CLI and the console, and a core message could name a flag the run did not take.

## Where the two sentences live

Core holds the catalog, `packages/core/src/failureCause.ts`: a `FailureCause` union whose members carry facts only (a channel, a path, an errno code, a wait in milliseconds), `failureCauseSentence` giving the one sentence stating what happened, and `markFailureCause` / `failureCauseOf` attaching the cause to an error as a property tag and reading it back through the cause chain. The tag leaves the error's class alone, so exit-code classification is unchanged. Core's sentence names no flag, control or command. The CLI draws on the catalog, and so does the console for a run its server conducted through the CLI: the CLI's terminal event states the cause as data ([CLI_EVENTS.md](../spec/CLI_EVENTS.md#the-failure-cause)), and the console shows core's sentence with its own remedy. The public web app's failure copy does not, and its WebRTC no-show wording lives in apps/web/src (useInviterExchange.ts).

Each app binds the remedy in a map keyed on every `FailureCauseKind`, so a cause core adds fails to compile in an app until it has a remedy. The console's is `apps/web/src/console/consoleFailureCause.ts`, naming the Connection tuning control that sets the wait and the console's shared-folder mount; the CLI's is `apps/cli/src/failureRemedy.ts`; it names only the flag that bounds the run in hand -- `--peer-timeout` on an exchange, `--accept-timeout` on an online invitation -- by reading a second tag the command boundary sets on a partner-never-arrived error. The remedy for an unreachable relay registrar is the same in both apps, since the registrar address is set in the configuration and neither app has a flag or control for it, so core holds it (`relayRegistrarUnreachableRemedy`) and both maps return it.

## A state no cause names

The CLI's remedy module also states the step for a state only the CLI reaches: an online `alcove invite` or `alcove accept` that saved its key file and stopped before it wrote its configuration (`keyFileSavedConfigNotWrittenRemedy`). It is not a catalog cause, for three reasons:

- The console runs `alcove exchange` alone, so no second app reports it.
- The state comes with whatever failure ended the run, or with an interrupt that raises no error at all, and an error holds one cause.
- It is no fact of an existing cause either: those state why a partner or a place could not be reached, not what a run left on disk.

So `apps/cli/src/protocol.ts` records the state, with the configuration the online commands pass it, on the error the run ends with. The command boundary states the step in place of a catalog remedy, and the signal handler states it on an interrupt.

## Formatting the facts

A wait is stated by `formatWaitDuration` in the largest whole unit that states it exactly, and every count goes through `formatCount` (`packages/core/src/utils/formatCount.ts`), whose explicit locale keeps the digit separator ASCII for the CLI's console check. An OS error code goes in parentheses after the path or host it concerns. A fact the raise site cannot know -- a channel or a wait when the connection holds no configuration -- is left out of the sentence rather than guessed. Internal tags such as a `[role]` prefix stay in debug logs.
