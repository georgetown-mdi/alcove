import { OperatorConfigError, turnUrlIsAllowed } from "@alcove/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import {
  RELAY_ONLY_RELAYS_LEFT_OUT,
  allowedRelaysRunNotice,
  runRelayRestriction,
} from "./relayRestriction";
import { readOwnRelaySetting, relayForRun } from "./ownRelaySetting";
import { relayWithDefaultForRun } from "./defaultRelay";

import type { OwnRelayRead, RelayUrls } from "./ownRelaySetting";
import type { DefaultRelayDependencies } from "./defaultRelay";
import type { RelayLocator } from "./rendezvous";
import type { RelayRestriction } from "./relayRestriction";

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
  restriction?: () => RelayRestriction;
}

/**
 * The relay a browser run dials with. Every TURN url it would list, this
 * browser's own, the invitation's and the build's default relay's, is kept or
 * left out by the allowed relays (`turnUrlIsAllowed` in core). Under Relay
 * only, a run whose every such url is left out is refused here, before it
 * contacts any host. Where the allowed relays are set, the urls kept and left
 * out are shown through `onRunNotice`. The default relay is then enrolled at
 * and added as {@link relayWithDefaultForRun} does, if it is kept.
 *
 * @throws {OperatorConfigError} with {@link RELAY_ONLY_RELAYS_LEFT_OUT}.
 */
export async function relayPlanForRun(
  sharedSecret: string,
  invitationRelay: RelayUrls | undefined,
  dependencies: RunRelayPlanDependencies = {},
): Promise<RunRelayPlan> {
  const {
    readOwn = readOwnRelaySetting,
    restriction,
    ...defaultRelay
  } = dependencies;
  const { allowedRelays, relayOnly } = (restriction ?? runRelayRestriction)();
  const own = readOwn();
  const site = (defaultRelay.setting ?? defaultRelaySetting)();
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
  if (relayOnly && relaysLeftOut.length > 0 && kept.length === 0)
    throw new OperatorConfigError(RELAY_ONLY_RELAYS_LEFT_OUT);
  if (allowedRelays !== undefined && listed.length > 0)
    defaultRelay.onRunNotice?.(allowedRelaysRunNotice(kept, relaysLeftOut));
  const relay = await relayWithDefaultForRun(
    sharedSecret,
    relayForRun(invitationRelay, () => own, allowedRelays),
    { ...defaultRelay, allowedRelays: () => allowedRelays },
  );
  return {
    ...(relay !== undefined && { relay }),
    iceTransportPolicy: relayOnly ? "relay" : "all",
    relaysLeftOut,
  };
}
