import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "@alcove/core";

import type { JobHandoff } from "./handoff";
import type { RelayEvent } from "./cliDriver";

/** The CLI warning source an unattended fill rides (docs/spec/CLI_EVENTS.md). */
export const PAYLOAD_RECEIVE_TAKEN_SOURCE = "payloadReceiveTaken";

/** The columns a relayed fill warning names, and how many the run took. */
export interface TakenColumns {
  columns: Array<string>;
  columnCount: number;
}

/**
 * The columns a relayed `payloadReceiveTaken` warning names, or undefined
 * where its `columns` is not a list of strings or its `columnCount` is not a
 * whole number at least that long. The names are as the relay passed them,
 * unescaped (`relayedTakenColumnNames` in `./cliDriver.ts`).
 */
export function relayedTakenColumns(
  event: RelayEvent,
): TakenColumns | undefined {
  const { columns, columnCount } = event;
  if (
    !Array.isArray(columns) ||
    !columns.every((name) => typeof name === "string") ||
    typeof columnCount !== "number" ||
    !Number.isInteger(columnCount) ||
    columnCount < columns.length
  )
    return undefined;
  return { columns, columnCount };
}

/** Whether `message` fits the run view's warning budget once its sink
 * (`appendSanitizedRunWarning` in `@psi/runWarnings`) escapes it. */
function fitsRunViewWarning(message: string): boolean {
  return (
    sanitizeForDisplay(message, { maxLength: Number.POSITIVE_INFINITY })
      .length <= WARNING_MESSAGE_MAX_DISPLAY_LENGTH
  );
}

/**
 * The console's notice for a run of `mode` that took `taken`. Composed raw:
 * the column names are the partner's, and the run view's warning sink escapes
 * the whole message once as it shows it. A double quote inside a name is
 * doubled, so the name cannot fake the end of its quotes and the sink's escape
 * leaves the doubling as it is. Whole names are cut from the end of the list
 * until the escaped notice fits the sink's budget, and the names not shown are
 * counted.
 */
export function payloadReceiveTakenConsoleNotice(
  mode: JobHandoff["mode"],
  taken: TakenColumns | undefined,
): string {
  const lead =
    mode === "zeroSetup"
      ? "Your partner declares payload columns it sends you, and this direct " +
        "exchange took them without asking. It records them in no " +
        "configuration."
      : "Your partner declares payload columns it sends you, and this run's " +
        "configuration listed none you receive, so the run took them without " +
        "asking. The console records them only in this run's own " +
        "configuration, not in the alcove.yaml in your working folder or in " +
        "the recurring-run configuration. To have later exchanges refuse a " +
        "partner that sends a different list, add them there under " +
        "linkage_terms.payload.receive.";
  if (taken === undefined || taken.columns.length === 0) return lead;
  const quoted = taken.columns.map((name) => `"${name.replaceAll('"', '""')}"`);
  const noticeShowing = (shown: number): string => {
    const more = taken.columnCount - shown;
    const names = quoted.slice(0, shown).join(", ");
    return `${lead} The columns taken: ${names}${more > 0 ? `, and ${String(more)} more` : ""}.`;
  };
  if (fitsRunViewWarning(noticeShowing(quoted.length)))
    return noticeShowing(quoted.length);
  // Below the whole list each added name outgrows the count's lost digit, so
  // the escaped length rises with `shown` and a bisection finds the most that
  // fit.
  let fewest = 1;
  let most = quoted.length - 1;
  while (fewest < most) {
    const middle = Math.ceil((fewest + most) / 2);
    if (fitsRunViewWarning(noticeShowing(middle))) fewest = middle;
    else most = middle - 1;
  }
  return noticeShowing(fewest);
}

/**
 * `event` with the console's notice in place of the CLI's where it is a
 * `payloadReceiveTaken` warning from a run of `mode`; any other event
 * unchanged. The served `columns` is escaped here, the one pass that field
 * takes; a list not in the CLI's shape is dropped.
 */
export function withConsolePayloadReceiveTakenNotice(
  event: RelayEvent,
  mode: JobHandoff["mode"],
): RelayEvent {
  if (event.type !== "warning" || event.source !== PAYLOAD_RECEIVE_TAKEN_SOURCE)
    return event;
  const { columns: _relayed, ...rest } = event;
  const taken = relayedTakenColumns(event);
  return {
    ...rest,
    message: payloadReceiveTakenConsoleNotice(mode, taken),
    ...(taken !== undefined
      ? { columns: taken.columns.map((name) => sanitizeForDisplay(name)) }
      : {}),
  };
}
