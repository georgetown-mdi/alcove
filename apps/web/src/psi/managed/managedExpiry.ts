/**
 * The lapsed-`expires` check a managed re-run applies before any connection,
 * so a lapse is its own benign expiry state with re-invite copy, never the
 * desync/attack framing (docs/MANAGED_EXCHANGE.md, "Expiry is its own state").
 * The instant comparison is core's, shared with the invitation acceptors.
 */

import { hasExpiryInstantPassed } from "@alcove/core";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/**
 * Whether the record's `expires` instant is at or before `now`; a record with
 * no bound never lapses, and an unparseable bound fails closed.
 */
export function managedExchangeLapsed(
  record: Pick<ManagedExchangeRecord, "expires">,
  now: number,
): boolean {
  return hasExpiryInstantPassed(record.expires, new Date(now), {
    onUnparseable: "fail-closed",
  });
}

/**
 * Raised when a managed re-run starts against a lapsed record, before any
 * connection, so the run driver records expiry rather than a handshake or input
 * failure.
 */
export class ManagedExchangeExpiredError extends Error {
  /** The lapsed `expires` instant (ISO 8601 UTC) the record held. */
  readonly expires: string;
  constructor(expires: string) {
    super("managed exchange stored secret has lapsed; re-invite to run again");
    this.name = "ManagedExchangeExpiredError";
    this.expires = expires;
  }
}
