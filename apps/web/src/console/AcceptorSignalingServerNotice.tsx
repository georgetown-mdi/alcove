import { Alert, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@alcove/core";

import { allowedRelaysCoveredKinds } from "@exchange/acceptorScreenModel";
import { invitationReach } from "@exchange/invitationReach";
import styles from "@styles/app.module.css";

import type { AcceptedSignalingServer } from "./signalingServerModel";

/** The end of the sentence stating the run uses the partner's relay: the
 * kinds of relay in it the Allowed relays list can leave out, where it names
 * any. */
function allowedRelaysExceptionClause(relay: {
  turn?: ReadonlyArray<string>;
  websocket?: string;
}): string {
  const kinds = allowedRelaysCoveredKinds(relay).map((kind) =>
    kind === "turn" ? "its TURN servers" : "its WebSocket relay",
  );
  return kinds.length === 0
    ? "."
    : `, unless the Allowed relays below leave out ${kinds.join(" or ")}.`;
}

/**
 * How a console WebRTC accept connects, shown read-only at the review step:
 * the coordination server the invitation names, the scheme the console dials
 * it over, whether the relay the terms show is used, the files the run
 * writes into the working folder, and the console setting it replaces. The
 * address is the partner's, escaped for display and rendered as text only.
 */
export function AcceptorSignalingServerNotice({
  accepted,
}: {
  accepted: AcceptedSignalingServer;
}) {
  const unencrypted = accepted.address.startsWith("ws:");
  const onThisComputer =
    invitationReach(`https://${accepted.signalingServer.host}/`) ===
    "thisComputer";
  return (
    <fieldset className={styles.fieldset}>
      <legend>How this console connects</legend>
      <Stack gap="xs">
        <Text size="sm">
          This console connects through the coordination server the invitation
          names,{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(accepted.address)}
          </span>
          . Both computers contact it to find each other; it sees your network
          addresses, not your data.
        </Text>
        {unencrypted && (
          <Alert color="yellow" icon={<IconAlertTriangle aria-hidden />}>
            This console reaches it over ws://, which is not encrypted, because
            you set this server at a ws:// address earlier. Use ws:// only for a
            server on this machine.
          </Alert>
        )}
        {!unencrypted && onThisComputer && (
          <Text size="sm" c="dimmed">
            To reach a test server on this machine over ws://, first choose
            WebRTC when creating an invitation and set the server&apos;s ws://
            address there, then open this invitation again.
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {accepted.signalingServer.relay !== undefined
            ? "The run uses the relay your partner named, shown with the terms above" +
              allowedRelaysExceptionClause(accepted.signalingServer.relay)
            : "The run connects directly to your partner's computer, so a network that blocks direct connections on either side stops the exchange from connecting."}
        </Text>
        <Text size="sm" c="dimmed">
          When the exchange starts, the console writes alcove.yaml and
          .alcove.key into your working folder, as alcove accept does, and runs
          alcove exchange on them. It does not start if either file is already
          there.
        </Text>
        <Text size="sm" c="dimmed">
          Starting the exchange also sets this console&apos;s coordination
          server to this one, replacing any server or web app address you set
          for your own invitations. To use yours again, choose WebRTC when you
          next create an invitation and set it there.
        </Text>
      </Stack>
    </fieldset>
  );
}
