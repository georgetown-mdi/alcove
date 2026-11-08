import type { InvitationKeySummary } from "@alcove/core";

/**
 * A linkage key's fields in plain words, with any either-order and
 * less-certain marks: the line the terms panel shows under each key and the
 * acceptor's ledger shows in place of the key's name. Read from core's field
 * labels, never from the partner-authored key name.
 */
export function keyFieldsLine(key: InvitationKeySummary): string {
  return [
    key.headerFields.join(" - "),
    key.swapHeaderMarker,
    key.lessCertainHeaderMarker,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}
