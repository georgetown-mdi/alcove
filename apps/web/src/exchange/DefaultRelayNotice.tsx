import { Alert } from "@mantine/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import { RELAY_OPERATOR_DISCLOSURE } from "./RelaySettingsScreen";

import type { DefaultRelaySetting } from "@utils/clientConfig";

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
 * What the build's default relay lets its operator learn, shown where a party
 * creates or accepts a browser exchange. Renders nothing when the build names
 * no default relay.
 */
export function DefaultRelayNotice({
  setting = defaultRelaySetting,
}: {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  setting?: () => DefaultRelaySetting | undefined;
}) {
  if (setting() === undefined) return null;
  return (
    <Alert variant="light" color="blue" role="note" mt="md">
      {DEFAULT_RELAY_NOTICE_LEAD} {RELAY_OPERATOR_DISCLOSURE}
    </Alert>
  );
}
