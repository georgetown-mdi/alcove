import type { JobHandoff } from "./handoff";
import type { RelayEvent } from "./cliDriver";

/**
 * What the console says when a run it drove took the payload columns its
 * partner declares without asking, as every console run does where its terms
 * list none it receives: the CLI child has no terminal to ask at.
 *
 * The CLI's own message names the configuration file it wrote the columns
 * into, a path inside this container, and says later exchanges hold the
 * partner to them, which is true of that per-run file and of nothing the
 * operator keeps. The console's notice is rebuilt from the event's `columns`
 * field instead of parsed out of that sentence.
 */

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
 * whole number at least that long.
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

/**
 * The console's notice for a run of `mode` that took `taken`. Composed raw:
 * the column names are the partner's, and the run view's warning sink escapes
 * the whole message once as it shows it. A double quote inside a name is
 * written `\"` so the name cannot fake the end of its quotes. The names come
 * last, so a message cut at the sink's budget loses names rather than the
 * step the operator has to take.
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
  const names = taken.columns
    .map((name) => `"${name.replaceAll('"', '\\"')}"`)
    .join(", ");
  const more = taken.columnCount - taken.columns.length;
  return `${lead} The columns taken: ${names}${more > 0 ? `, and ${String(more)} more` : ""}.`;
}

/**
 * `event` with the console's notice in place of the CLI's where it is a
 * `payloadReceiveTaken` warning from a run of `mode`; any other event
 * unchanged.
 */
export function withConsolePayloadReceiveTakenNotice(
  event: RelayEvent,
  mode: JobHandoff["mode"],
): RelayEvent {
  if (event.type !== "warning" || event.source !== PAYLOAD_RECEIVE_TAKEN_SOURCE)
    return event;
  return {
    ...event,
    message: payloadReceiveTakenConsoleNotice(mode, relayedTakenColumns(event)),
  };
}
