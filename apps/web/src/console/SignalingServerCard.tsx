import { useState } from "react";

import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@alcove/core";

import styles from "@styles/app.module.css";

import {
  deleteSignalingServer,
  putSignalingServer,
} from "@psi/jobClient/signalingServerClient";

import {
  HOSTED_WEB_APP_ADDRESS,
  HOSTED_WEB_APP_FILL_NOTE,
  UNENCRYPTED_SERVER_INVITATION_NOTE,
  signalingServerAddress,
  signalingServerReachProblem,
} from "./signalingServerModel";

import type { SignalingServerProjection } from "@jobContract/signalingServer";

const SUPERSEDED_MESSAGE =
  "Another change to the address took effect first. Check the address below " +
  "and set it again.";

const UNREACHABLE_CONSOLE_MESSAGE =
  "The console did not answer. Check that it is still running, then set the " +
  "address again.";

/**
 * The coordination server a console WebRTC exchange connects through, under
 * the WebRTC transport choice: shows the server the console holds, or a field
 * to set one from a `wss://` server address or an `https://` web app address,
 * which the console resolves. The field starts empty; the hosted web app's
 * address is filled in only when the operator chooses the action that names
 * it and what it means.
 */
export function SignalingServerCard({
  server,
  onSet,
  onCleared,
}: {
  /** The server the console holds, null when none, undefined while unread. */
  server: SignalingServerProjection | null | undefined;
  onSet: (server: SignalingServerProjection) => void;
  onCleared: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  async function save() {
    setSaving(true);
    setRefusal(undefined);
    const result = await putSignalingServer(address);
    setSaving(false);
    if (result.kind === "ok") {
      setEditing(false);
      setAddress("");
      onSet(result.server);
      return;
    }
    setRefusal(
      result.kind === "refused"
        ? sanitizeForDisplay(result.message)
        : result.kind === "superseded"
          ? SUPERSEDED_MESSAGE
          : UNREACHABLE_CONSOLE_MESSAGE,
    );
  }

  async function clear() {
    await deleteSignalingServer();
    onCleared();
  }

  if (server === undefined) return null;

  if (server !== null && !editing) {
    const reachProblem = signalingServerReachProblem(server);
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">
          Connects through{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(signalingServerAddress(server))}
          </span>
          {server.webAppOrigin !== undefined && (
            <>
              , the coordination server of the web app at{" "}
              <span className={styles.mono}>
                {sanitizeForDisplay(server.webAppOrigin)}
              </span>
              . The invitation link opens there
            </>
          )}
          .
        </Text>
        {server.webAppOrigin === undefined && (
          <Text size="sm" c="dimmed">
            With a coordination server's own address there is no link to share:
            you send your partner the invitation as text. Give a web app's
            https:// address instead to share a link.
          </Text>
        )}
        {reachProblem !== undefined && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle aria-hidden />}
            title="Your partner may not reach this server"
          >
            {reachProblem}
          </Alert>
        )}
        {server.warnings.map((warning) => (
          <Alert
            key={warning}
            color="yellow"
            icon={<IconAlertTriangle aria-hidden />}
          >
            {sanitizeForDisplay(warning)}
          </Alert>
        ))}
        {!server.secure && (
          <Text size="sm" c="dimmed">
            {UNENCRYPTED_SERVER_INVITATION_NOTE}
          </Text>
        )}
        <Group gap="sm">
          <Button size="xs" variant="default" onClick={() => setEditing(true)}>
            Change address
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="red"
            onClick={() => void clear()}
          >
            Clear address
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="xs" mt="xs">
      <TextInput
        label="Coordination server or web app address"
        description="A coordination server's wss:// address, or an Alcove web app's https:// address, which names its own coordination server."
        placeholder="wss://... or https://..."
        value={address}
        onChange={(event) => setAddress(event.currentTarget.value)}
        error={refusal}
      />
      <Group gap="sm">
        <Button
          size="xs"
          loading={saving}
          disabled={address.trim() === ""}
          onClick={() => void save()}
        >
          Set address
        </Button>
        <Button
          size="xs"
          variant="subtle"
          onClick={() => setAddress(HOSTED_WEB_APP_ADDRESS)}
        >
          Use the Alcove web app's server
        </Button>
        {server !== null && (
          <Button size="xs" variant="subtle" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed">
        {HOSTED_WEB_APP_FILL_NOTE}
      </Text>
    </Stack>
  );
}
