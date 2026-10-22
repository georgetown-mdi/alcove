import { Alert } from "@mantine/core";

import {
  defaultRelayForRun,
  defaultRelayInUse,
} from "@psi/transport/defaultRelay";
import { defaultRelayBuild } from "@utils/clientConfig";

import { RELAY_OPERATOR_DISCLOSURE } from "./RelaySettingsScreen";

import type {
  DefaultRelayBuild,
  DefaultRelaySetting,
} from "@utils/clientConfig";
import type { RelayUrls } from "@psi/transport/ownRelaySetting";

/**
 * The words before {@link RELAY_OPERATOR_DISCLOSURE}. They name no operator:
 * any deployment can build in a default relay, so the build cannot tell who
 * runs it.
 *
 * @internal exported for testing
 */
export const DEFAULT_RELAY_NOTICE_LEAD =
  "Exchanges that run in your browser on this site use the site's relay " +
  "server, unless an exchange's allowed relays leave it out.";

/**
 * The words before {@link RELAY_OPERATOR_DISCLOSURE} on the review of an
 * invitation that names the site's relay server where this browser has it
 * switched off.
 *
 * @internal exported for testing
 */
export const INVITED_DEFAULT_RELAY_NOTICE_LEAD =
  "This invitation names the site's relay server, so this exchange may " +
  "connect through it, unless its allowed relays leave it out.";

/**
 * What the default relay a run uses lets its operator learn, shown where a
 * party creates or accepts a browser exchange. The relay is the one in use
 * or, on the review of an accepted invitation, `invitationRelay`, the one the
 * invitation names where the build offers it switched off
 * (`defaultRelayForRun`). Renders nothing where the run uses none.
 */
export function DefaultRelayNotice({
  build = defaultRelayBuild,
  setting = () => defaultRelayInUse(build),
  invitationRelay,
}: {
  /** The build's default relay and its mode; the build's own when unset. */
  build?: () => DefaultRelayBuild;
  /** The default relay in use; {@link defaultRelayInUse} of `build` when
   * unset. */
  setting?: () => DefaultRelaySetting | undefined;
  /** The relay an accepted invitation names; absent where one is created. */
  invitationRelay?: RelayUrls;
}) {
  const lead =
    setting() !== undefined
      ? DEFAULT_RELAY_NOTICE_LEAD
      : invitationRelay !== undefined &&
          defaultRelayForRun(invitationRelay, build, () => false).kind ===
            "invited"
        ? INVITED_DEFAULT_RELAY_NOTICE_LEAD
        : undefined;
  if (lead === undefined) return null;
  return (
    <Alert variant="light" color="blue" role="note" mt="md">
      {lead} {RELAY_OPERATOR_DISCLOSURE}
    </Alert>
  );
}
