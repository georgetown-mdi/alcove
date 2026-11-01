import { useState } from "react";

import { Alert, Button, Group, TextInput } from "@mantine/core";

import { InfoButton } from "@components/InfoButton";

import {
  parseSftpRelayUrl,
  readSftpRelaySetting,
  writeSftpRelaySetting,
} from "@psi/transport/sftpRelaySetting";
import styles from "@styles/app.module.css";

/** The explanation behind the info button on the section's heading: what the
 * relay is for, what it sees, and which relay a setting here replaces. */
export const SFTP_RELAY_INFO =
  "To exchange over SFTP, a browser connects through an SFTP relay in front " +
  "of the SFTP server. An SFTP invitation can name your partner's relay. Set " +
  "a relay here to use your own instead, such as one your organization runs. " +
  "The relay sees your network address and the start of each connection, " +
  "and none of your data: the SFTP server's own sign-in and encryption " +
  "protect it.";

/** The address field's description. */
export const SFTP_RELAY_FIELD_DESCRIPTION =
  "For example: wss://sftp.example.org/sftp";

/** What the section reports once a relay is set. */
export const SFTP_RELAY_SET =
  "Set. This browser uses this relay in place of the one an SFTP " +
  "invitation names.";

/** What the section reports once the setting is cleared. */
export const SFTP_RELAY_CLEARED =
  "Cleared. This browser uses the SFTP relay an invitation names.";

/** What the section reports where this browser did not store the change. */
export const SFTP_RELAY_NOT_SAVED =
  "This browser did not save the setting. Check that site storage is " +
  "allowed for this site, then try again.";

/** What the section says where the stored setting cannot be read, until a
 * Set or Clear replaces it. */
export const SFTP_RELAY_UNREADABLE =
  "Until you set it again, this browser uses no SFTP relay. Enter its " +
  "address and choose Set SFTP relay, or choose Clear SFTP relay to use " +
  "the one an invitation names.";

type Status = "idle" | "set" | "cleared" | "failed";

/**
 * This browser's own SFTP relay, on the relay settings page of the hosted
 * app: a `wss://` url kept in browser storage for this site, used in place of
 * the one an SFTP invitation names, refused when set unless it passes core's
 * rule, and cleared to use the invitation's. No address is contacted here.
 */
export function SftpRelaySection() {
  const [initial] = useState(readSftpRelaySetting);
  const [text, setText] = useState(initial.kind === "set" ? initial.url : "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [unreadable, setUnreadable] = useState(initial.kind === "unreadable");

  function store(url: string | undefined): boolean {
    try {
      writeSftpRelaySetting(url);
    } catch {
      setStatus("failed");
      return false;
    }
    setUnreadable(false);
    return true;
  }

  function set() {
    const entry = parseSftpRelayUrl(text);
    if (!entry.ok) {
      setError(entry.message);
      setStatus("idle");
      return;
    }
    setError(undefined);
    if (!store(entry.url)) return;
    if (entry.url !== undefined) setText(entry.url);
    setStatus(entry.url === undefined ? "cleared" : "set");
  }

  function clear() {
    setError(undefined);
    if (!store(undefined)) return;
    setText("");
    setStatus("cleared");
  }

  return (
    <section aria-labelledby="sftp-relay-heading">
      <InfoButton
        mt="xl"
        label="About the SFTP relay"
        explanation={SFTP_RELAY_INFO}
      >
        <h2 id="sftp-relay-heading" className={styles.infoLine}>
          SFTP relay
        </h2>
      </InfoButton>
      {unreadable && (
        <Alert color="yellow" title="The saved SFTP relay could not be read">
          {SFTP_RELAY_UNREADABLE}
        </Alert>
      )}
      <TextInput
        mt="md"
        label="SFTP relay url"
        description={SFTP_RELAY_FIELD_DESCRIPTION}
        placeholder="wss://..."
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
          <Button onClick={set}>Set SFTP relay</Button>
          <Button variant="outline" onClick={clear}>
            Clear SFTP relay
          </Button>
        </Group>
        <p className={styles.statusLine} aria-live="polite" aria-atomic="true">
          {status === "set" && SFTP_RELAY_SET}
          {status === "cleared" && SFTP_RELAY_CLEARED}
          {status === "failed" && SFTP_RELAY_NOT_SAVED}
        </p>
      </div>
    </section>
  );
}
