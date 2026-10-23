import { Fragment, useState } from "react";

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
import { OWN_RELAY_REFUSED_PREFIX } from "@jobContract/signalingServer";
import { SettingSummaryLine } from "@components/SettingSummaryLine";
import { useOpenCloseFocus } from "@components/useOpenCloseFocus";

import {
  EMPTY_OWN_RELAY_DRAFT,
  HOSTED_WEB_APP_ADDRESS,
  HOSTED_WEB_APP_FILL_NOTE,
  NO_RELAY_SUMMARY,
  OWN_WEBSOCKET_RELAY_FIELD_DESCRIPTION,
  UNENCRYPTED_SERVER_INVITATION_NOTE,
  ownRelayDraft,
  ownRelayEnrollmentNotice,
  ownRelayFromDraft,
  ownRelaySummary,
  signalingServerAddress,
  signalingServerReachProblem,
} from "./signalingServerModel";

import type { ReactNode } from "react";

import type {
  JobOwnRelay,
  SignalingServerProjection,
} from "@jobContract/signalingServer";
import type {
  OwnRelayDraft,
  OwnRelayDraftResult,
} from "./signalingServerModel";

/** The problems of each relay field, empty where it has none. */
interface OwnRelayProblems {
  turn: Array<string>;
  websocket: Array<string>;
  registrarUrl: Array<string>;
  exchangeId: Array<string>;
}

const NO_RELAY_PROBLEMS: OwnRelayProblems = {
  turn: [],
  websocket: [],
  registrarUrl: [],
  exchangeId: [],
};

function problemText(problems: ReadonlyArray<string>): string | undefined {
  return problems.length > 0 ? problems.join(" ") : undefined;
}

function anyRelayProblem(problems: OwnRelayProblems): boolean {
  return Object.values(problems).some((list) => list.length > 0);
}

function relayProblemsOf(
  read: Extract<OwnRelayDraftResult, { ok: false }>,
): OwnRelayProblems {
  return {
    turn: read.turnProblems,
    websocket: read.websocketProblems,
    registrarUrl: read.registrarUrlProblems,
    exchangeId: read.exchangeIdProblems,
  };
}

const SUPERSEDED_MESSAGE =
  "Another change to the address took effect first. Check the address below " +
  "and set it again.";

const UNREACHABLE_CONSOLE_MESSAGE =
  "The console did not answer. Check that it is still running, then set the " +
  "address again.";

/** The relay the console holds for its own invitations, each url escaped for
 * display: its TURN urls, its WebSocket relay, and its registrar. */
function HeldOwnRelay({ relay }: { relay: JobOwnRelay }) {
  const sentences: Array<ReactNode> = [];
  if (relay.turn !== undefined)
    sentences.push(
      <Fragment key="turn">
        Relays through{" "}
        <span className={styles.mono}>
          {sanitizeForDisplay(relay.turn.join(", "))}
        </span>{" "}
        when a direct connection fails, and the invitation names it for your
        partner.
      </Fragment>,
    );
  if (relay.websocket !== undefined)
    sentences.push(
      <Fragment key="websocket">
        Falls back to the WebSocket relay{" "}
        <span className={styles.mono}>
          {sanitizeForDisplay(relay.websocket)}
        </span>{" "}
        when no other connection opens, and the invitation names it for your
        partner.
      </Fragment>,
    );
  if (relay.relayRegistrar !== undefined)
    sentences.push(
      <Fragment key="registrar">
        The relay key is registered at{" "}
        <span className={styles.mono}>
          {sanitizeForDisplay(relay.relayRegistrar.url)}
        </span>{" "}
        under the exchange id{" "}
        <span className={styles.mono}>
          {sanitizeForDisplay(relay.relayRegistrar.exchangeId)}
        </span>
        .
      </Fragment>,
    );
  return (
    <Text size="sm">
      {sentences.map((sentence, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          {sentence}
        </Fragment>
      ))}
    </Text>
  );
}

/**
 * The relay fields of the coordination server form, shown as one line until
 * the operator opens them: no relay, with Set a relay, or the relay the
 * fields set, with Change and Remove. They show while `open`, or while a
 * value is refused or does not read as a relay. Done reads them and, where
 * every value reads, closes them.
 */
function OwnRelayFields({
  relay,
  problems,
  open,
  onChange,
  onOpen,
  onDone,
  onRemove,
}: {
  relay: OwnRelayDraft;
  problems: OwnRelayProblems;
  open: boolean;
  onChange: (change: Partial<OwnRelayDraft>) => void;
  onOpen: () => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const { fieldRef, actionRef, focusFieldNext, focusActionNext } =
    useOpenCloseFocus<HTMLTextAreaElement>();
  const read = ownRelayFromDraft(relay);

  if (open || anyRelayProblem(problems) || !read.ok)
    return (
      <Stack gap="xs">
        <Textarea
          ref={fieldRef}
          label="Relay (TURN) servers, optional"
          description="The run connects through it when a direct connection fails, and the invitation names it for your partner. No username or password goes here: each run presents a credential derived from the exchange's shared secret. One turns: or turn: url per line, for example turns:relay.example.org:443?transport=tcp"
          autosize
          minRows={2}
          value={relay.turn}
          onChange={(event) => onChange({ turn: event.currentTarget.value })}
          error={problemText(problems.turn)}
          errorProps={{ role: "alert" }}
        />
        <TextInput
          label="WebSocket relay url, optional"
          description={OWN_WEBSOCKET_RELAY_FIELD_DESCRIPTION}
          value={relay.websocket}
          onChange={(event) =>
            onChange({ websocket: event.currentTarget.value })
          }
          error={problemText(problems.websocket)}
          errorProps={{ role: "alert" }}
        />
        <TextInput
          label="Relay registrar address, optional"
          description="Where your relay keeps each exchange's key, if it runs the reference registrar: an https:// address."
          value={relay.registrarUrl}
          onChange={(event) =>
            onChange({ registrarUrl: event.currentTarget.value })
          }
          error={problemText(problems.registrarUrl)}
          errorProps={{ role: "alert" }}
        />
        <TextInput
          label="Exchange id at the registrar"
          description="The id the registrar keeps this exchange's key under. Choose one for this exchange that names neither party."
          value={relay.exchangeId}
          onChange={(event) =>
            onChange({ exchangeId: event.currentTarget.value })
          }
          error={problemText(problems.exchangeId)}
          errorProps={{ role: "alert" }}
        />
        <Button
          size="xs"
          variant="default"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            focusActionNext();
            onDone();
          }}
        >
          Done
        </Button>
      </Stack>
    );

  return (
    <SettingSummaryLine
      summary={
        read.ownRelay !== undefined
          ? ownRelaySummary(read.ownRelay)
          : NO_RELAY_SUMMARY
      }
      isSet={read.ownRelay !== undefined}
      settingName="relay"
      setLabel="Set a relay"
      actionRef={actionRef}
      onOpen={() => {
        focusFieldNext();
        onOpen();
      }}
      onRemove={() => {
        focusActionNext();
        onRemove();
      }}
    />
  );
}

/**
 * The coordination server a console WebRTC exchange connects through, under
 * the WebRTC transport choice, and the relay (TURN) server and WebSocket relay
 * its invitations name: shows what the console holds, naming a relay only
 * where one is set, or a form to set them, its relay fields behind one line
 * ({@link OwnRelayFields}). The address is a `wss://` server address or an
 * `https://` web app address, which the console resolves. The address starts
 * empty; the hosted web app's address is filled in only when the operator
 * chooses the action that names it and what it means. A relay set here
 * states, before the run, the step that enrolls the exchange's key at it.
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
  const [relayOpen, setRelayOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  function changeRelay(change: Partial<OwnRelayDraft>) {
    setRelay((draft) => ({ ...draft, ...change }));
  }

  function resetRelay(draft: OwnRelayDraft) {
    setRelay(draft);
    setRelayProblems(NO_RELAY_PROBLEMS);
    setRelayOpen(false);
  }

  function startEditing(held: SignalingServerProjection) {
    setAddress(held.webAppOrigin ?? signalingServerAddress(held));
    resetRelay(ownRelayDraft(held.ownRelay));
    setEditing(true);
  }

  function closeRelay() {
    const read = ownRelayFromDraft(relay);
    if (!read.ok) {
      setRelayProblems(relayProblemsOf(read));
      return;
    }
    resetRelay(read.ownRelay === undefined ? EMPTY_OWN_RELAY_DRAFT : relay);
  }

  async function save() {
    setRefusal(undefined);
    const read = ownRelayFromDraft(relay);
    if (!read.ok) {
      setRelayProblems(relayProblemsOf(read));
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
      resetRelay(EMPTY_OWN_RELAY_DRAFT);
      onSet(result.server);
      return;
    }
    if (
      result.kind === "refused" &&
      result.message.startsWith(OWN_RELAY_REFUSED_PREFIX)
    ) {
      setRelayProblems({
        ...NO_RELAY_PROBLEMS,
        turn: [sanitizeForDisplay(result.message)],
      });
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
    setAddress("");
    resetRelay(EMPTY_OWN_RELAY_DRAFT);
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
        {server.ownRelay !== undefined && (
          <HeldOwnRelay relay={server.ownRelay} />
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
            Clear address and relay
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
      <OwnRelayFields
        relay={relay}
        problems={relayProblems}
        open={relayOpen}
        onChange={changeRelay}
        onOpen={() => setRelayOpen(true)}
        onDone={closeRelay}
        onRemove={() => resetRelay(EMPTY_OWN_RELAY_DRAFT)}
      />
      <Group gap="sm">
        <Button
          size="xs"
          loading={saving}
          disabled={address.trim() === ""}
          onClick={() => void save()}
        >
          Set address and relay
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
