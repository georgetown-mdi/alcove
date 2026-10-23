import { useState } from "react";

import { Alert, Button, Group, TextInput } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import {
  parseCoordinationServerUrl,
  readCoordinationServerSetting,
  writeCoordinationServerSetting,
} from "@psi/transport/coordinationServerSetting";
import styles from "@styles/app.module.css";

import type { CoordinationServerRead } from "@psi/transport/coordinationServerSetting";

/** What the coordination server section opens with: what the server is for,
 * what it learns, and which server an invitation names by default. */
export const COORDINATION_SERVER_INTRO =
  "Your browser and your partner's find each other through a coordination " +
  "server. It learns the network address of each party that uses it, and " +
  "none of your data. Invitations you create name this site's coordination " +
  "server unless you set your own here.";

/** The address field's description, its example in the scheme `scheme`. */
export function coordinationServerFieldDescription(
  scheme: "wss" | "ws",
): string {
  return (
    "Invitations you create from now on name this server, and both your " +
    "browser and your partner's connect to it. Invitations you already " +
    "sent, saved exchanges, and invitations you accept keep the server they " +
    "name, until you re-invite your partner from a saved exchange you " +
    "created, which then names the server set here. " +
    `For example: ${scheme}://signaling.example.org/api/`
  );
}

/** What the section reports once a server is set. */
export const COORDINATION_SERVER_SET =
  "Set. Invitations you create from now on name this coordination server. " +
  "It is first contacted when you create one.";

/** What the section reports once the setting is cleared. */
export const COORDINATION_SERVER_CLEARED =
  "Cleared. Invitations you create from now on name this site's " +
  "coordination server.";

/** What the section reports where this browser did not store the change. */
export const COORDINATION_SERVER_NOT_SAVED =
  "This browser did not save the setting. Check that site storage is " +
  "allowed for this site, then try again.";

/** What the section says where the stored setting cannot be read, until a
 * Set or Clear replaces it. */
export const COORDINATION_SERVER_UNREADABLE =
  "Invitations you create name this site's coordination server until you " +
  "set yours again. Enter its address and choose Set coordination server.";

/** What Review & create says where the stored setting cannot be read, before
 * the invitation is created. */
export const COORDINATION_SERVER_UNREADABLE_AT_INVITE =
  "Your saved coordination server could not be read, so this invitation " +
  "will name this site's coordination server. To use yours, set it again " +
  "in relay settings before you create the invitation.";

/**
 * Review & create's warning that the invitation about to be created names
 * this site's coordination server because the stored setting cannot be read.
 * Renders nothing where the setting is unset or readable.
 */
export function UnreadableCoordinationServerNotice({
  read = () => readCoordinationServerSetting(window.location.protocol),
}: {
  /** Read the stored setting; this page's own when unset. */
  read?: () => CoordinationServerRead;
}) {
  if (read().kind !== "unreadable") return null;
  return (
    <Alert
      role="note"
      color="yellow"
      icon={<IconAlertTriangle aria-hidden />}
      mt="md"
    >
      {COORDINATION_SERVER_UNREADABLE_AT_INVITE}
    </Alert>
  );
}

type Status = "idle" | "set" | "cleared" | "failed";

/**
 * The coordination server the invitations this browser creates name, on the
 * relay settings page of the hosted app: a `wss://` address, kept in browser
 * storage for this site, refused when set unless it has the form that works,
 * and cleared to use the site's own. No address is contacted here.
 */
export function CoordinationServerSection({
  pageProtocol = window.location.protocol,
}: {
  /** The page's protocol, which decides the scheme an address takes. */
  pageProtocol?: string;
}) {
  const [initial] = useState(() => readCoordinationServerSetting(pageProtocol));
  const [text, setText] = useState(initial.kind === "set" ? initial.url : "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [unreadable, setUnreadable] = useState(initial.kind === "unreadable");
  const scheme = pageProtocol === "https:" ? "wss" : "ws";

  function set() {
    const entry = parseCoordinationServerUrl(text, pageProtocol);
    if (!entry.ok) {
      setError(entry.message);
      setStatus("idle");
      return;
    }
    setError(undefined);
    try {
      writeCoordinationServerSetting(entry.url);
    } catch {
      setStatus("failed");
      return;
    }
    setUnreadable(false);
    if (entry.url !== undefined) setText(entry.url);
    setStatus(entry.url === undefined ? "cleared" : "set");
  }

  function clear() {
    setError(undefined);
    try {
      writeCoordinationServerSetting(undefined);
    } catch {
      setStatus("failed");
      return;
    }
    setUnreadable(false);
    setText("");
    setStatus("cleared");
  }

  return (
    <section aria-labelledby="coordination-server-heading">
      <h2 id="coordination-server-heading">Coordination server</h2>
      <p className={`${styles.small} ${styles.sub}`}>
        {COORDINATION_SERVER_INTRO}
      </p>
      {unreadable && (
        <Alert
          color="yellow"
          title="The saved coordination server could not be read"
        >
          {COORDINATION_SERVER_UNREADABLE}
        </Alert>
      )}
      <TextInput
        mt="md"
        label="Coordination server address"
        description={coordinationServerFieldDescription(scheme)}
        placeholder={`${scheme}://...`}
        value={text}
        error={error}
        errorProps={{ role: "alert" }}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setStatus("idle");
        }}
      />
      <div className={styles.workFoot}>
        <Group>
          <Button onClick={set}>Set coordination server</Button>
          <Button variant="outline" onClick={clear}>
            Clear coordination server
          </Button>
        </Group>
        <p className={styles.statusLine} aria-live="polite" aria-atomic="true">
          {status === "set" && COORDINATION_SERVER_SET}
          {status === "cleared" && COORDINATION_SERVER_CLEARED}
          {status === "failed" && COORDINATION_SERVER_NOT_SAVED}
        </p>
      </div>
    </section>
  );
}
