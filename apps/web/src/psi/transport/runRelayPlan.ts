import { OperatorConfigError, turnUrlIsAllowed } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import {
  RELAY_ONLY_DEFAULT_RELAY_NOT_ENROLLED,
  RELAY_ONLY_NO_RELAY,
  RELAY_ONLY_RELAYS_LEFT_OUT,
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

/** The relay a browser run dials with, and how it gathers. */
export interface RunRelayPlan {
  /** The relay its peer connection gathers against; none when absent. */
  relay?: RelayLocator;
  /** `relay` under this browser's Relay only setting, else `all`. */
  iceTransportPolicy: RTCIceTransportPolicy;
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
  relayOnly: boolean;
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
  const { allowedRelays, relayOnly, unreadable } = (
    restriction ?? runRelayRestriction
  )();
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
  if (relayOnly && listed.length === 0)
    throw new OperatorConfigError(RELAY_ONLY_NO_RELAY);
  if (relayOnly && kept.length === 0)
    throw new OperatorConfigError(RELAY_ONLY_RELAYS_LEFT_OUT);
  return {
    ...(allowedRelays !== undefined && { allowedRelays }),
    relayOnly,
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
 * relay restriction cannot be read, and under Relay only when it lists no
 * TURN url or every one is left out. Where the allowed relays are set, the
 * urls kept and left out are shown through `onRunNotice`. The default relay
 * is then enrolled at and added as {@link relayWithDefaultForRun} does, if it
 * is kept. Under Relay only, a run whose only TURN url was the default
 * relay's, and whose enrollment there failed, is refused before it dials.
 *
 * @throws {OperatorConfigError} with {@link RELAY_RESTRICTION_UNREADABLE},
 *   {@link RELAY_ONLY_NO_RELAY}, {@link RELAY_ONLY_RELAYS_LEFT_OUT} or
 *   {@link RELAY_ONLY_DEFAULT_RELAY_NOT_ENROLLED}.
 */
export async function relayPlanForRun(
  sharedSecret: string,
  invitationRelay: RelayUrls | undefined,
  dependencies: RunRelayPlanDependencies = {},
): Promise<RunRelayPlan> {
  const { readOwn, restriction, onRunNotice, ...defaultRelay } = dependencies;
  const { allowedRelays, relayOnly, own, listed, kept, relaysLeftOut } =
    runRelayList(invitationRelay, dependencies);
  if (allowedRelays !== undefined && listed.length > 0)
    onRunNotice?.(allowedRelaysRunNotice(kept, relaysLeftOut));
  // Shown only once the run is known to dial: that notice says the run
  // connects without the default relay, which a refused run does not.
  const enrollmentNotices: Array<string> = [];
  const relay = await relayWithDefaultForRun(
    sharedSecret,
    relayForRun(invitationRelay, () => own, allowedRelays),
    {
      ...defaultRelay,
      onRunNotice: (message) => enrollmentNotices.push(message),
      allowedRelays: () => allowedRelays,
    },
  );
  if (
    relayOnly &&
    (relay?.turn ?? []).length === 0 &&
    defaultRelay.signal?.aborted !== true
  )
    throw new OperatorConfigError(RELAY_ONLY_DEFAULT_RELAY_NOT_ENROLLED);
  for (const message of enrollmentNotices) onRunNotice?.(message);
  return {
    ...(relay !== undefined && { relay }),
    iceTransportPolicy: relayOnly ? "relay" : "all",
    relaysLeftOut,
  };
}
