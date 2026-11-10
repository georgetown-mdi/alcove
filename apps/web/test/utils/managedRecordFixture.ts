import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_DEFAULT_RELAY_REFUSAL,
  NO_HELD_APP_UPDATE,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/** A stored inviter record on a default WebRTC connection, with every required
 * field set; `overrides` replaces any of them. */
export function managedRecordFixture(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    heldAppUpdate: NO_HELD_APP_UPDATE,
    defaultRelayRefusal: NO_DEFAULT_RELAY_REFUSAL,
    ...overrides,
  };
}
