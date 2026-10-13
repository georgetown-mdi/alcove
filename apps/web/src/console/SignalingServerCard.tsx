import { useState } from "react";

import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@alcove/core";

import styles from "@styles/app.module.css";

import {
  deleteSignalingServer,
  putSignalingServer,
} from "@psi/jobClient/signalingServerClient";

import {
  EMPTY_OWN_RELAY_DRAFT,
  HOSTED_WEB_APP_ADDRESS,
  HOSTED_WEB_APP_FILL_NOTE,
  NO_RELAY_NOTE,
  UNENCRYPTED_SERVER_INVITATION_NOTE,
  ownRelayDraft,
  ownRelayEnrollmentNotice,
  ownRelayFromDraft,
  signalingServerAddress,
  signalingServerReachProblem,
} from "./signalingServerModel";

import type { OwnRelayDraft } from "./signalingServerModel";
import type { SignalingServerProjection } from "@jobContract/signalingServer";

/** The problems of each relay field, empty where it has none. */
interface OwnRelayProblems {
  turn: Array<string>;
  registrarUrl: Array<string>;
  exchangeId: Array<string>;
}

const NO_RELAY_PROBLEMS: OwnRelayProblems = {
  turn: [],
  registrarUrl: [],
  exchangeId: [],
};

function problemText(problems: ReadonlyArray<string>): string | undefined {
  return problems.length > 0 ? problems.join(" ") : undefined;
}

const SUPERSEDED_MESSAGE =
  "Another change to the address took effect first. Check the address below " +
  "and set it again.";

const UNREACHABLE_CONSOLE_MESSAGE =
  "The console did not answer. Check that it is still running, then set the " +
  "address again.";

/**
 * The coordination server a console WebRTC exchange connects through, under
 * the WebRTC transport choice, and the relay (TURN) server its invitations
 * name: shows what the console holds, or fields to set them. The address is
 * a `wss://` server address or an `https://` web app address, which the
 * console resolves. The address starts empty; the hosted web app's address is
 * filled in only when the operator chooses the action that names it and what
 * it means. A relay set here states, before the run, the step that enrolls
 * the exchange's key at it.
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
  const [relay, setRelay] = useState<OwnRelayDraft>(EMPTY_OWN_RELAY_DRAFT);
  const [relayProblems, setRelayProblems] =
    useState<OwnRelayProblems>(NO_RELAY_PROBLEMS);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  function changeRelay(change: Partial<OwnRelayDraft>) {
    setRelay((draft) => ({ ...draft, ...change }));
  }

  function startEditing(held: SignalingServerProjection) {
    setAddress(held.webAppOrigin ?? signalingServerAddress(held));
    setRelay(ownRelayDraft(held.ownRelay));
    setRelayProblems(NO_RELAY_PROBLEMS);
    setEditing(true);
  }

  async function save() {
    setRefusal(undefined);
    const read = ownRelayFromDraft(relay);
    if (!read.ok) {
      setRelayProblems({
        turn: read.turnProblems,
        registrarUrl: read.registrarUrlProblems,
        exchangeId: read.exchangeIdProblems,
      });
      return;
    }
    setRelayProblems(NO_RELAY_PROBLEMS);
    setSaving(true);
    const result = await putSignalingServer(
      address,
      undefined,
      read.ownRelay !== undefined ? { ownRelay: read.ownRelay } : undefined,
    );
    setSaving(false);
    if (result.kind === "ok") {
      setEditing(false);
      setAddress("");
      setRelay(EMPTY_OWN_RELAY_DRAFT);
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
    const enrollment = ownRelayEnrollmentNotice(server.ownRelay);
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
        {server.ownRelay === undefined ? (
          <Text size="sm" c="dimmed">
            {NO_RELAY_NOTE}
          </Text>
        ) : (
          <Text size="sm">
            Relays through{" "}
            <span className={styles.mono}>
              {sanitizeForDisplay(server.ownRelay.turn.join(", "))}
            </span>{" "}
            when a direct connection fails, and the invitation names it for your
            partner.
            {server.ownRelay.relayRegistrar !== undefined && (
              <>
                {" "}
                The relay key is registered at{" "}
                <span className={styles.mono}>
                  {sanitizeForDisplay(server.ownRelay.relayRegistrar.url)}
                </span>{" "}
                under the exchange id{" "}
                <span className={styles.mono}>
                  {sanitizeForDisplay(
                    server.ownRelay.relayRegistrar.exchangeId,
                  )}
                </span>
                .
              </>
            )}
          </Text>
        )}
        {enrollment !== undefined && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Enroll this exchange at your relay"
          >
            {enrollment}
          </Alert>
        )}
        <Group gap="sm">
          <Button
            size="xs"
            variant="default"
            onClick={() => startEditing(server)}
          >
            Change address or relay
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
      <Textarea
        label="Relay (TURN) servers, optional"
        description="The run connects through it when a direct connection fails, and the invitation names it for your partner. No username or password goes here: each run presents a credential derived from the exchange's shared secret. One turns: or turn: url per line, for example turns:relay.example.org:443?transport=tcp"
        autosize
        minRows={2}
        value={relay.turn}
        onChange={(event) => changeRelay({ turn: event.currentTarget.value })}
        error={problemText(relayProblems.turn)}
        errorProps={{ role: "alert" }}
      />
      <TextInput
        label="Relay registrar address, optional"
        description="Where your relay keeps each exchange's key, if it runs the reference registrar: an https:// address."
        value={relay.registrarUrl}
        onChange={(event) =>
          changeRelay({ registrarUrl: event.currentTarget.value })
        }
        error={problemText(relayProblems.registrarUrl)}
        errorProps={{ role: "alert" }}
      />
      <TextInput
        label="Exchange id at the registrar"
        description="The id the registrar keeps this exchange's key under. Choose one for this exchange that names neither party."
        value={relay.exchangeId}
        onChange={(event) =>
          changeRelay({ exchangeId: event.currentTarget.value })
        }
        error={problemText(relayProblems.exchangeId)}
        errorProps={{ role: "alert" }}
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
