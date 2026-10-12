import { Stack, Text } from "@mantine/core";

import { sanitizeForDisplay } from "@alcove/core";

import styles from "@styles/app.module.css";

import type { AcceptedSignalingServer } from "./signalingServerModel";

/**
 * How a console WebRTC accept connects, shown read-only at the review step:
 * the coordination server the invitation names, the scheme the console dials
 * it over, whether the relay the terms show is used, and the files the run
 * writes into the working folder. The address is the partner's, escaped for
 * display and rendered as text only.
 */
export function AcceptorSignalingServerNotice({
  accepted,
}: {
  accepted: AcceptedSignalingServer;
}) {
  const unencrypted = accepted.address.startsWith("ws:");
  return (
    <fieldset className={styles.fieldset}>
      <legend>How this console connects</legend>
      <Stack gap="xs">
        <Text size="sm">
          Through the coordination server the invitation names,{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(accepted.address)}
          </span>
          . Both computers contact it to find each other; it sees your network
          addresses, not your data.
        </Text>
        {unencrypted && (
          <Text size="sm" c="dimmed">
            This console reaches it over ws://, as you set this server earlier,
            which is not encrypted. Use ws:// only for a server on this machine.
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {accepted.signalingServer.relay !== undefined
            ? "The run uses the relay your partner named, shown with the terms above."
            : "The run connects directly to your partner's computer, so a network that blocks direct connections on either side stops the exchange from connecting."}
        </Text>
        <Text size="sm" c="dimmed">
          When the exchange starts, the console writes alcove.yaml and
          .alcove.key into your working folder, as alcove accept does, and runs
          alcove exchange on them. It does not start if either file is already
          there.
        </Text>
      </Stack>
    </fieldset>
  );
}
