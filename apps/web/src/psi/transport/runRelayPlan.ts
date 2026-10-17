import { OperatorConfigError, turnUrlIsAllowed } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import {
  RELAY_RESTRICTION_UNREADABLE,
  allowedRelaysRunNotice,
  runRelayRestriction,
} from "./relayRestriction";
import { readOwnRelaySetting, relayForRun } from "./ownRelaySetting";
import { relayWithDefaultForRun } from "./defaultRelay";

import type { OwnRelayRead, RelayUrls } from "./ownRelaySetting";
import type { DefaultRelayDependencies } from "./defaultRelay";
import type { RelayLocator } from "./rendezvous";
import type { RunRelayRestriction } from "./relayRestriction";

/** The relay a browser run dials with. */
export interface RunRelayPlan {
  /** The relay its peer connection gathers against; none when absent. */
  relay?: RelayLocator;
  /** The TURN urls the allowed relays left out, named by a failed open. */
  relaysLeftOut: ReadonlyArray<string>;
}

/** What {@link relayPlanForRun} reads: injectable for tests. */
export interface RunRelayPlanDependencies extends DefaultRelayDependencies {
  /** This browser's own relay; the stored setting when unset. */
  readOwn?: () => OwnRelayRead;
  /** This browser's relay restriction; the stored setting when unset. */
  restriction?: () => RunRelayRestriction;
}

/** What {@link assertRunRelayPlanPossible} reads: injectable for tests. */
export type RunRelayRefusalDependencies = Pick<
  RunRelayPlanDependencies,
  "readOwn" | "restriction" | "setting"
>;

interface RunRelayList {
  allowedRelays?: ReadonlyArray<string>;
  own: OwnRelayRead;
  listed: Array<string>;
  kept: Array<string>;
  relaysLeftOut: Array<string>;
}

/**
 * The TURN urls a run lists and which the allowed relays keep, after the
 * refusals {@link relayPlanForRun} states. It reads only this browser's
 * storage and the build's settings.
 */
function runRelayList(
  invitationRelay: RelayUrls | undefined,
  dependencies: RunRelayRefusalDependencies,
): RunRelayList {
  const { readOwn = readOwnRelaySetting, restriction, setting } = dependencies;
  const { allowedRelays, unreadable } = (restriction ?? runRelayRestriction)();
  if (unreadable === true)
    throw new OperatorConfigError(RELAY_RESTRICTION_UNREADABLE);
  const own = readOwn();
  const site = (setting ?? defaultRelaySetting)();
  const listed = [
    ...new Set([
      ...(own.kind === "set" ? own.relay.turn : []),
      ...(invitationRelay?.turn ?? []),
      ...(site !== undefined ? [site.turnUrl] : []),
    ]),
  ];
  const kept = listed.filter((url) => turnUrlIsAllowed(url, allowedRelays));
  const relaysLeftOut = listed.filter(
    (url) => !turnUrlIsAllowed(url, allowedRelays),
  );
  return {
    ...(allowedRelays !== undefined && { allowedRelays }),
    own,
    listed,
    kept,
    relaysLeftOut,
  };
}

/**
 * Refuse a run as {@link relayPlanForRun} does, without contacting any host:
 * a caller that contacts a host before it plans the run's relay runs this
 * first, so the refusal still comes before any contact.
 *
 * @throws {OperatorConfigError} as {@link relayPlanForRun} does.
 */
export function assertRunRelayPlanPossible(
  invitationRelay: RelayUrls | undefined,
  dependencies: RunRelayRefusalDependencies = {},
): void {
  runRelayList(invitationRelay, dependencies);
}

/**
 * The relay a browser run dials with. Every TURN url it would list, this
 * browser's own, the invitation's and the build's default relay's, is kept or
 * left out by the allowed relays (`turnUrlIsAllowed` in core). A run is
 * refused here, before it contacts any host, when this browser's stored
 * relay restriction cannot be read. Where the allowed relays are set, the
 * urls kept and left out are shown through `onRunNotice`. The default relay
 * is then enrolled at and added as {@link relayWithDefaultForRun} does, if it
 * is kept.
 *
 * @throws {OperatorConfigError} with {@link RELAY_RESTRICTION_UNREADABLE}.
 */
export async function relayPlanForRun(
  sharedSecret: string,
  invitationRelay: RelayUrls | undefined,
  dependencies: RunRelayPlanDependencies = {},
): Promise<RunRelayPlan> {
  const { readOwn, restriction, ...defaultRelay } = dependencies;
  const { allowedRelays, own, listed, kept, relaysLeftOut } = runRelayList(
    invitationRelay,
    dependencies,
  );
  if (allowedRelays !== undefined && listed.length > 0)
    defaultRelay.onRunNotice?.(allowedRelaysRunNotice(kept, relaysLeftOut));
  const relay = await relayWithDefaultForRun(
    sharedSecret,
    relayForRun(invitationRelay, () => own, allowedRelays),
    { ...defaultRelay, allowedRelays: () => allowedRelays },
  );
  return { ...(relay !== undefined && { relay }), relaysLeftOut };
}
