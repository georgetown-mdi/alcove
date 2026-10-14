import { Alert, Anchor } from "@mantine/core";

import { defaultRelaySetting } from "@utils/clientConfig";

import { RELAY_OPERATOR_DISCLOSURE } from "./RelaySettingsScreen";

import type { DefaultRelaySetting } from "@utils/clientConfig";

/** The privacy statement's account of what the project's relay observes. */
const RELAY_PRIVACY_STATEMENT_URL =
  "https://github.com/georgetown-mdi/alcove/blob/main/PRIVACY.md#hosted-web-application";

/**
 * The words before {@link RELAY_OPERATOR_DISCLOSURE}, naming who runs the
 * relay.
 *
 * @internal exported for testing
 */
export const DEFAULT_RELAY_NOTICE_LEAD =
  "An exchange that runs in your browser on this site uses a relay server " +
  "the Alcove project runs.";

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
      {DEFAULT_RELAY_NOTICE_LEAD} {RELAY_OPERATOR_DISCLOSURE}{" "}
      <Anchor
        inherit
        href={RELAY_PRIVACY_STATEMENT_URL}
        target="_blank"
        rel="noreferrer"
      >
        Read what the project keeps
      </Anchor>
      .
    </Alert>
  );
}
