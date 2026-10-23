/**
 * The platform wiring for fast re-invite from a stored record: it plugs core's secret
 * generation and token encoding, this page's location, and the record store into the
 * pure {@link composeManagedReinvite}, then persists the fresh secret onto the record.
 * Split from the pure composer so the .tsx stays thin and the composition/token shape
 * is testable in Node without real crypto or a database.
 *
 * The record write reuses {@link persistManagedExchangeReinvite}: it replaces the
 * desynced secret with the fresh setup secret (the field-scoped rotation write over
 * the secret, the record's own `expires` and the document's coordination server),
 * drops the stale `lastRun`, and clears the backup and import markers in the same
 * cross-store transaction. The write is awaited before the operator forwards the
 * invitation, so this party's own re-run listens on the rendezvous the fresh secret
 * derives, at the server the invitation names. On an exchange enrolled at a
 * relay registrar, the same step registers the fresh secret's relay key, signed with
 * the replaced secret's ({@link registerReinvitedManagedRelayKey}).
 */

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import { defaultRelayInUse } from "../transport/defaultRelay";
import { ownRelayForInvitation } from "../transport/ownRelaySetting";
import { reinviteLocation } from "../invitationLocation";

import { composeManagedReinvite } from "./managedReinvite";
import { managedAllowedRelays } from "./managedExchangeRecord";
import { persistManagedExchangeReinvite } from "./managedExchangeStore";
import { registerReinvitedManagedRelayKey } from "./managedRelayRegistration";

import type { ManagedReinvite, ReinviteLocation } from "./managedReinvite";
import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayUrls } from "../transport/ownRelaySetting";
import type { RunnableManagedExchangeRecord } from "./managedExchangeRecord";

/** The dependencies the re-invite driver injects, defaulted to the real platform
 * wiring but overridable in a test. */
interface ManagedReinviteDriverDeps {
  /** Read this page's origin and the coordination server a re-invite names,
   * for the fresh webrtc endpoint. */
  location: () => ReinviteLocation;
  /** Mint a fresh setup secret. */
  generateSecret: () => string;
  /** Encode the composed token to the shareable string. */
  encode: typeof encodeInvitation;
  /** Persist the fresh secret onto the record (the re-invite rotation write). */
  persistRotation: typeof persistManagedExchangeReinvite;
  /** Register the fresh secret's relay key at the record's registrar. */
  registerRelayKey: typeof registerReinvitedManagedRelayKey;
  /** The moment the setup lifetime and the record's max-age stamp count from. */
  now: () => number;
  /** Read this browser's own relay, less the TURN urls `allowedRelays`, the
   * record's own, leaves out, which the invitation names. */
  ownRelay: (
    allowedRelays: ReadonlyArray<string> | undefined,
  ) => RelayUrls | undefined;
  /** Read the default relay in use, which the invitation also names. */
  defaultRelay: () => DefaultRelaySetting | undefined;
}

const defaultDeps: ManagedReinviteDriverDeps = {
  location: reinviteLocation,
  generateSecret: generateSharedSecret,
  encode: encodeInvitation,
  persistRotation: persistManagedExchangeReinvite,
  registerRelayKey: (replaced, written) =>
    registerReinvitedManagedRelayKey(replaced, written),
  now: () => Date.now(),
  ownRelay: (allowedRelays) => ownRelayForInvitation(allowedRelays),
  defaultRelay: () => defaultRelayInUse(),
};

/** A completed re-invite: the shareable artifacts the operator forwards out-of-band,
 * plus the record as it now stands in the store -- rotated to the fresh secret with the
 * consumed failure cleared. The caller adopts {@link record} so every subsequent action
 * derives from the fresh secret, never the stale in-memory copy. */
interface ManagedReinviteResult {
  /** The shareable invitation artifacts (link, code, setup expiry). */
  reinvite: ManagedReinvite;
  /** The persisted record after the re-invite rotation. */
  record: RunnableManagedExchangeRecord;
}

/**
 * Re-invite from a stored inviter record: compose a fresh invitation from the record's
 * own document, persist the fresh secret onto the record, and return the shareable
 * artifacts for the operator to forward out-of-band plus the rotated record. The
 * operator re-authors nothing.
 *
 * The rotation is persisted before the result is returned, so a persist failure
 * aborts the re-invite rather than handing the operator an invitation the record
 * cannot back. Only the inviter side reaches this; the composer throws for an
 * acceptor.
 *
 * @throws {Error} if the record is not the inviter side.
 * @throws {ZodError} if the assembled token fails validation at encode, or the
 *   rotation is invalid.
 * @throws {ManagedExchangeLockUnavailableError} if a run of the record holds the lock.
 * @throws {ManagedReinviteWithheldError} if the record holds a standing compromise.
 */
export async function reinviteManagedExchange(
  record: RunnableManagedExchangeRecord,
  deps: ManagedReinviteDriverDeps = defaultDeps,
): Promise<ManagedReinviteResult> {
  const reinvite = await composeManagedReinvite(record, deps.location(), {
    generateSecret: deps.generateSecret,
    encode: deps.encode,
    now: deps.now,
    ownRelay: deps.ownRelay(managedAllowedRelays(record.exchangeFile)),
    defaultRelay: deps.defaultRelay(),
  });
  const persisted = await deps.persistRotation(
    record.id,
    reinvite.rotation,
    deps.registerRelayKey,
  );
  return { reinvite, record: persisted };
}
