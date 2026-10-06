// The operator's notice for an event a consumer of this schema skipped because
// it fell outside it, shared by every reader of the stream so each states what
// arrived the same way.

import { redactAndFitUnescaped } from "@alcove/core";

/** The budget of each value an {@link unknownEventNotice} quotes. */
export const UNKNOWN_EVENT_VALUE_MAX_LENGTH = 64;

/** What {@link unknownEventNotice} is handed for data that was not JSON. */
export const UNREADABLE_EVENT: unique symbol = Symbol("unreadable event");

/** Who sent the skipped event, who skipped it, and what the operator does. */
export interface UnknownEventNoticeParties {
  /** The sender, as the sentence's subject: "The console". */
  sender: string;
  /** The reader that skipped it: "this page". */
  reader: string;
  /** The sentence that tells the operator what to do. */
  remedy: string;
}

/**
 * The notice for an event `value` outside the schema: what arrived, by the
 * field that put it outside (its `v`, else its `type`), and the remedy. A
 * quoted value is redacted and fitted but not escaped, since the warning sink
 * that shows the notice escapes it once.
 */
export function unknownEventNotice(
  value: unknown,
  parties: UnknownEventNoticeParties,
): string {
  const quoted = (field: unknown): string =>
    typeof field === "string"
      ? `"${redactAndFitUnescaped(field, UNKNOWN_EVENT_VALUE_MAX_LENGTH)}"`
      : typeof field === "number"
        ? String(field)
        : "(none)";
  let what: string;
  if (value === UNREADABLE_EVENT) what = "an event that is not readable JSON";
  else if (value === null || typeof value !== "object" || Array.isArray(value))
    what = "an event that is not a JSON object";
  else {
    const record = value as Record<string, unknown>;
    what =
      record.v !== 1
        ? `an event of schema version ${quoted(record.v)}`
        : `an event of type ${quoted(record.type)}`;
  }
  return (
    `${parties.sender} sent ${what}, which ${parties.reader} does not read, ` +
    `so it was skipped. ${parties.remedy}`
  );
}
