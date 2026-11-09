import { Alert } from "@mantine/core";

import { defaultRelayBuild } from "@utils/clientConfig";
import { defaultRelayForRun } from "@psi/transport/defaultRelay";

import { RELAY_OPERATOR_DISCLOSURE } from "./ExchangeConnectionSettings";

import type { OwnRelay, RelayUrls } from "@psi/transport/ownRelaySetting";
import type { DefaultRelayBuild } from "@utils/clientConfig";

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
 * invitation that names the site's relay server where the exchange has it
 * switched off.
 *
 * @internal exported for testing
 */
export const INVITED_DEFAULT_RELAY_NOTICE_LEAD =
  "This invitation names the site's relay server, so this exchange may " +
  "connect through it, unless its allowed relays leave it out.";

/**
 * The words before {@link RELAY_OPERATOR_DISCLOSURE} where the exchange has
 * the site's relay server switched off, its own relay names that relay, and
 * no accepted invitation names it.
 *
 * @internal exported for testing
 */
export const OWN_DEFAULT_RELAY_NOTICE_LEAD =
  "Your Connection settings name the site's relay server, so this exchange " +
  "may connect through it, unless its allowed relays leave it out.";

/**
 * What the default relay a run uses lets its operator learn, shown where a
 * party creates or accepts a browser exchange: where the build turns it on,
 * or, where the build offers it switched off and the exchange's switch is
 * off, where `invitationRelay`, an accepted invitation's, or `ownRelay`, the
 * exchange's own, names it (`defaultRelayForRun`). Renders nothing where the
 * run uses none, or where the switch is on, since the switch states it.
 */
export function DefaultRelayNotice({
  build = defaultRelayBuild,
  ownRelay,
  switchedOn,
  invitationRelay,
}: {
  /** The build's default relay and its mode; the build's own when unset. */
  build?: () => DefaultRelayBuild;
  /** The exchange's own relay, where its Connection settings name one. */
  ownRelay?: OwnRelay;
  /** The exchange's switch. */
  switchedOn: boolean;
  /** The relay an accepted invitation names; absent where one is created. */
  invitationRelay?: RelayUrls;
}) {
  const forRun = defaultRelayForRun(
    invitationRelay,
    build,
    () => switchedOn,
    ownRelay,
  );
  const lead =
    build().kind === "on"
      ? DEFAULT_RELAY_NOTICE_LEAD
      : switchedOn
        ? undefined
        : forRun.kind === "invited"
          ? INVITED_DEFAULT_RELAY_NOTICE_LEAD
          : forRun.kind === "own"
            ? OWN_DEFAULT_RELAY_NOTICE_LEAD
            : undefined;
  if (lead === undefined) return null;
  return (
    <Alert variant="light" color="info" role="note" mt="md">
      {lead} {RELAY_OPERATOR_DISCLOSURE}
    </Alert>
  );
}
