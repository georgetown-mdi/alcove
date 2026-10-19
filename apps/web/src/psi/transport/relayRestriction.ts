/**
 * An exchange's allowed relays in the web app: the relays its run may use,
 * each an entry of core's `connection.allowed_relays` form
 * (`normalizeAllowedRelay`), set where the exchange is authored -- a saved
 * exchange on its own page, an invitation on its review before it is created
 * or accepted. Read here: the field's parse and the words a run and a review
 * use. Operator page: docs/EXCHANGE_REFERENCE.md, connection.allowed_relays.
 */

import {
  ALLOWED_RELAY_FORM,
  normalizeAllowedRelay,
  sanitizeForDisplay,
} from "@alcove/core";

/** A refusal of the entered text: why, and the 1-based line it is about. */
export interface AllowedRelayProblem {
  line?: number;
  message: string;
}

/** What {@link parseExchangeAllowedRelayLines} made of the entered text. */
export type AllowedRelayLines =
  /** `entries` absent where no line names a relay: the setting is unset. */
  | { ok: true; entries?: Array<string> }
  | { ok: false; problems: Array<AllowedRelayProblem> };

/**
 * Read one allowed relay per line from `text` for an exchange's own
 * configuration, skipping blank lines, each normalized as core's
 * `connection.allowed_relays` entry is and listed once, under core's entry
 * rule alone, with no bound on how many entries or how long one is. Every
 * refused line is reported.
 */
export function parseExchangeAllowedRelayLines(
  text: string,
): AllowedRelayLines {
  const entries: Array<string> = [];
  const problems: Array<AllowedRelayProblem> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const entry = normalizeAllowedRelay(line);
    if (entry === undefined)
      problems.push({
        line: index + 1,
        message: `enter ${ALLOWED_RELAY_FORM}, with no turn: or turns: scheme`,
      });
    else if (!entries.includes(entry)) entries.push(entry);
  });
  if (problems.length > 0) return { ok: false, problems };
  return entries.length === 0 ? { ok: true } : { ok: true, entries };
}

/**
 * The text that shows an allowed-relays list in the field, one entry per
 * line; empty where the list is unset or empty.
 */
export function allowedRelaysText(
  allowedRelays: ReadonlyArray<string> | undefined,
): string {
  return (allowedRelays ?? []).join("\n");
}

/**
 * The field error for a parse of the allowed relays, each problem prefixed
 * with its line where it names one, or `undefined` where the text parsed.
 */
export function allowedRelayLinesError(
  lines: AllowedRelayLines,
): string | undefined {
  if (lines.ok) return undefined;
  return lines.problems
    .map((problem) =>
      problem.line === undefined
        ? problem.message
        : `Line ${problem.line}: ${problem.message}`,
    )
    .join("; ");
}

// --- The words a run and the acceptance review use ---------------------------

/** The mark of a TURN url the setting keeps. */
export const KEPT_BY_ALLOWED_RELAYS = "kept by your allowed relays";

/** The mark of a TURN url the setting leaves out. */
export const LEFT_OUT_BY_ALLOWED_RELAYS = "left out by your allowed relays";

function allowedRelaysFieldDescription(relays: string): string {
  return (
    "One host per line, with a port where needed, for example " +
    "relay.example.org or relay.example.org:443. Each run uses only the " +
    `relay servers listed here, ${relays}. The setting covers relay servers ` +
    "only: a run still contacts the STUN servers an invitation names. Leave " +
    "it empty to use every relay a run lists."
  );
}

/** The Allowed relays field's description where the run is this browser's
 * or a saved exchange's, which can relay through this site's relay. */
export const ALLOWED_RELAYS_FIELD_DESCRIPTION = allowedRelaysFieldDescription(
  "yours, the invitation's or this site's",
);

/** The Allowed relays field's description on the console, whose runs have
 * no relay of the site's. */
export const CONSOLE_ALLOWED_RELAYS_FIELD_DESCRIPTION =
  allowedRelaysFieldDescription("the invitation's");

/**
 * What a saved exchange's own allowed relays decide, and what they do not,
 * shown with the list on the exchange's page.
 */
export const EXCHANGE_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its runs connect " +
  "through and enroll at, and which it names in the invitations it " +
  "creates; a run still registers each new key at its own relay's " +
  "registrar whatever the list keeps. " +
  "Your partner's side can still connect through a relay the list leaves " +
  "out. The list covers relay servers only: the STUN servers a run lists " +
  "are still contacted.";

/**
 * What an accepted invitation's allowed relays decide, and what they do not:
 * the counterpart of {@link EXCHANGE_ALLOWED_RELAYS_SCOPE} shown with the list
 * on the invitation's review.
 */
export const ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its run connects " +
  "through and enrolls at; a run still registers each new key at its own " +
  "relay's registrar whatever the list keeps. " +
  "Your partner's side can still connect through a relay the list leaves " +
  "out. The list covers relay servers only: the STUN servers a run lists " +
  "are still contacted. Saving this exchange as a recurring exchange keeps " +
  "the list as its own.";

/**
 * What the allowed relays of an invitation this browser creates decide, and
 * what they do not: the counterpart of
 * {@link ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE} shown with the list on the
 * review before the invitation is created.
 */
export const CREATED_INVITATION_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its invitation names, " +
  "and which relays its run connects through and enrolls at; a run still " +
  "registers each new key at its own relay's registrar whatever the list " +
  "keeps. " +
  "Your partner's side can still connect through a relay the list leaves " +
  "out. The list covers relay servers only: the STUN servers a run lists " +
  "are still contacted. Saving this exchange as a recurring exchange keeps " +
  "the list as its own.";

/**
 * What a console accept's allowed relays decide, and what they do not: the
 * counterpart of {@link ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE} for a run
 * the console's command line conducts from the working folder's alcove.yaml.
 */
export const CONSOLE_ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its run connects " +
  "through and enrolls at. Your partner's side can still connect through a " +
  "relay the list leaves out. The list covers relay servers only: the STUN " +
  "servers a run lists are still contacted. The console writes the list " +
  "into alcove.yaml as connection.allowed_relays, so a later run of that " +
  "file uses it too.";

/**
 * The accepted invitation's review notice after Start met Allowed relays
 * edited since that step's Continue.
 */
export const ALLOWED_RELAYS_CHANGED_SINCE_CONTINUE =
  "Allowed relays changed since you pressed Continue, so the exchange did " +
  "not start. Press Continue to use them.";

/** What to do when a run that left relays out did not connect. */
export const ALLOWED_RELAYS_REMEDY =
  "To let a run try a relay left out, add its host to the exchange's " +
  "Allowed relays, or remove them. A saved exchange sets them on its own " +
  "page; any other exchange sets them on its review, before the invitation " +
  "is created or accepted.";

function urlList(urls: ReadonlyArray<string>): string {
  return urls.map((url) => sanitizeForDisplay(url)).join(", ");
}

/**
 * The run notice a run shows when the setting is set: the TURN urls it keeps
 * and the ones it leaves out, escaped, since an invitation's are partner text.
 */
export function allowedRelaysRunNotice(
  kept: ReadonlyArray<string>,
  leftOut: ReadonlyArray<string>,
): string {
  const keeps =
    kept.length === 0 ? "keep no TURN url" : `keep ${urlList(kept)}`;
  const leaves =
    leftOut.length === 0 ? "leave out none" : `leave out ${urlList(leftOut)}`;
  return `Your allowed relays ${keeps} and ${leaves} for this run.`;
}
