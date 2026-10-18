import { useState } from "react";

import { Alert, Anchor, Button, Group, Stack, Textarea } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { AllowedRelaysField } from "@components/AllowedRelaysField";

import {
  ALLOWED_RELAYS_SCOPE,
  parseAllowedRelayLines,
  readRelayRestriction,
  writeRelayRestriction,
} from "@psi/transport/relayRestriction";
import { defaultRelaySetting, isConsoleBuild } from "@utils/clientConfig";
import {
  parseRelayUrlLines,
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { relayTestTargets } from "@psi/transport/relayTest";
import styles from "@styles/app.module.css";

import { RelayTestSection } from "./RelayTestSection";
import { WorkShell } from "./WorkShell";

import type { AllowedRelayLines } from "@psi/transport/relayRestriction";
import type { DefaultRelaySetting } from "@utils/clientConfig";
import type { RelayUrlLines } from "@psi/transport/ownRelaySetting";

/**
 * What the relay's operator learns, shown beside the setting and stated in
 * docs/COMMUNICATION.md and docs/SHARED_RESPONSIBILITY.md.
 */
export const RELAY_OPERATOR_DISCLOSURE =
  "Whoever runs the relay learns the network address of each party to every " +
  "exchange that uses it, whether or not any traffic is relayed: your browser " +
  "reserves an address on the relay while it gathers connection candidates, " +
  "before it knows whether a direct connection will work. The relay forwards " +
  "encrypted traffic only and cannot read the exchange.";

/**
 * What the relay must hold for each run's credential, shown in the page's
 * opening paragraph and stated in docs/COMMUNICATION.md.
 */
export const RELAY_KEY_NOTICE =
  "Each exchange signs in to the relay with a credential derived from that " +
  "exchange's current shared secret and valid for at most one hour, so the " +
  "relay must hold the key derived from the current secret. The shared secret " +
  "changes after every run that completes its handshake, even one that then " +
  "fails. A saved exchange enrolled at your relay's registrar, under Relay " +
  "registration on its page, registers each new key there itself; any other " +
  "exchange through your relay needs its key registered with the relay again " +
  "after each run.";

/**
 * What a console shows in place of Allowed relays: its exchanges run the
 * command line, which reads its configuration, not this browser's setting.
 */
export const CONSOLE_RELAY_RESTRICTION_LINE =
  "Exchanges run from this console follow the command-line configuration: " +
  "its connection.allowed_relays key decides which relays an exchange may " +
  "use.";

/** Where a saved exchange's allowed relays are set instead of here. */
export const SAVED_EXCHANGE_ALLOWED_RELAYS_LINE =
  "A saved exchange uses the Allowed relays on its own page instead.";

/** The status after a save stored the allowed relays, and not the relay
 * server addresses. */
export const RESTRICTION_SAVED_RELAY_NOT_SAVED =
  "Your allowed relays were saved, and the relay server addresses were " +
  "not. Check that site storage is allowed for this site, then save again.";

/** The status after a save stored nothing. */
export const NOTHING_SAVED =
  "This browser did not save the relay server addresses or the allowed " +
  "relays. Check that site storage is allowed for this site, then save " +
  "again.";

/** The field error for one list's parse, or `undefined` when it parsed. */
function fieldError(
  lines: RelayUrlLines | AllowedRelayLines,
): string | undefined {
  if (lines.ok) return undefined;
  return lines.problems
    .map((problem) =>
      problem.line === undefined
        ? problem.message
        : `Line ${problem.line}: ${problem.message}`,
    )
    .join("; ");
}

/** The relays a run may use. */
function AllowedRelaysControls({
  allowedText,
  allowedError,
  onAllowedText,
}: {
  allowedText: string;
  allowedError: string | undefined;
  onAllowedText: (text: string) => void;
}) {
  return (
    <>
      <p>{ALLOWED_RELAYS_SCOPE}</p>
      <p>{SAVED_EXCHANGE_ALLOWED_RELAYS_LINE}</p>

      <Stack gap="md" mt="md">
        <AllowedRelaysField
          value={allowedText}
          error={allowedError}
          onChange={onAllowedText}
        />
      </Stack>
    </>
  );
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "savedWithoutRelay" }
  | { kind: "removed" }
  /** The relay server addresses were not stored; nothing else was written. */
  | { kind: "failed" }
  /** The restriction was stored, and the relay server addresses were not. */
  | { kind: "restrictionSavedOnly" }
  /** Neither the restriction nor the relay server addresses were stored. */
  | { kind: "nothingSaved" };

/**
 * The relay settings page: this browser's own TURN and STUN urls and the
 * relays a run may use, kept in browser storage for this site, with what the
 * relay's operator learns stated beside them, and a test of the relays a
 * browser run lists that the user starts. The hosted app and a console each
 * hold their own. A console withholds the relays a run may use, which its
 * exchanges do not read, and states what decides them instead.
 */
export function RelaySettingsScreen({
  defaultRelay = defaultRelaySetting,
}: {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  defaultRelay?: () => DefaultRelaySetting | undefined;
}) {
  const consoleBuild = isConsoleBuild();
  const [initial] = useState(readOwnRelaySetting);
  const [turnText, setTurnText] = useState(
    initial.kind === "set" ? initial.relay.turn.join("\n") : "",
  );
  const [stunText, setStunText] = useState(
    initial.kind === "set" ? initial.relay.stun.join("\n") : "",
  );
  const [initialRestriction] = useState(readRelayRestriction);
  const [allowedText, setAllowedText] = useState(
    (initialRestriction.allowedRelays ?? []).join("\n"),
  );
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [testTargets, setTestTargets] = useState(() =>
    relayTestTargets(
      initialRestriction.allowedRelays,
      () => initial,
      defaultRelay,
    ),
  );
  const [savedTurn, setSavedTurn] = useState<ReadonlyArray<string>>(
    initial.kind === "set" ? initial.relay.turn : [],
  );
  const [savedAllowed, setSavedAllowed] = useState<ReadonlyArray<string>>(
    initialRestriction.allowedRelays ?? [],
  );

  const turnLines = parseRelayUrlLines(turnText, "turn");
  const stunLines = parseRelayUrlLines(stunText, "stun");
  const allowedLines = parseAllowedRelayLines(allowedText);
  const turnError = attempted ? fieldError(turnLines) : undefined;
  const stunError = attempted ? fieldError(stunLines) : undefined;
  const allowedError = attempted ? fieldError(allowedLines) : undefined;
  const unsavedTurnChanges =
    !turnLines.ok || turnLines.urls.join("\n") !== savedTurn.join("\n");
  const unsavedAllowedChanges =
    !allowedLines.ok ||
    (allowedLines.entries ?? []).join("\n") !== savedAllowed.join("\n");

  function refreshTestTargets(turn: ReadonlyArray<string>) {
    setSavedTurn(turn);
    const allowedRelays = readRelayRestriction().allowedRelays;
    setSavedAllowed(allowedRelays ?? []);
    setTestTargets(
      relayTestTargets(allowedRelays, readOwnRelaySetting, defaultRelay),
    );
  }

  function save() {
    setAttempted(true);
    if (!turnLines.ok || !stunLines.ok || !allowedLines.ok) {
      setStatus({ kind: "idle" });
      return;
    }
    // Two writes, the restriction first: each outcome is stated, and the
    // saved state and the test are re-read from storage after a failure.
    const refreshFromStorage = () => {
      const stored = readOwnRelaySetting();
      refreshTestTargets(stored.kind === "set" ? stored.relay.turn : []);
    };
    if (!consoleBuild) {
      try {
        writeRelayRestriction(
          allowedLines.entries !== undefined
            ? { allowedRelays: allowedLines.entries }
            : {},
        );
      } catch {
        refreshFromStorage();
        setStatus({ kind: "nothingSaved" });
        return;
      }
    }
    try {
      writeOwnRelaySetting({ turn: turnLines.urls, stun: stunLines.urls });
    } catch {
      refreshFromStorage();
      setStatus({ kind: consoleBuild ? "failed" : "restrictionSavedOnly" });
      return;
    }
    refreshTestTargets(turnLines.urls);
    const restricted = !consoleBuild && allowedLines.entries !== undefined;
    setStatus({
      kind:
        turnLines.urls.length + stunLines.urls.length > 0
          ? "saved"
          : restricted
            ? "savedWithoutRelay"
            : "removed",
    });
  }

  function remove() {
    try {
      writeOwnRelaySetting({ turn: [], stun: [] });
      refreshTestTargets([]);
      setTurnText("");
      setStunText("");
      setAttempted(false);
      setStatus({
        kind:
          consoleBuild || readRelayRestriction().allowedRelays === undefined
            ? "removed"
            : "savedWithoutRelay",
      });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  return (
    <WorkShell>
      <h1>Relay server</h1>
      <p className={`${styles.small} ${styles.sub}`}>
        When a direct connection to your partner cannot be made, your browser
        can connect through a TURN relay your side runs. Enter the relay&apos;s
        addresses here. They are kept in this browser for this site only. An
        invitation you send names these addresses so your partner connects
        through the same relay. A run also lists the relay named by an
        invitation you accept, after yours
        {consoleBuild
          ? "."
          : ", unless your allowed relays below leave it out."}{" "}
        {RELAY_KEY_NOTICE}
      </p>

      <h2>What the relay&apos;s operator learns</h2>
      <p>{RELAY_OPERATOR_DISCLOSURE}</p>

      {initial.kind === "unreadable" && status.kind === "idle" && (
        <Alert color="yellow" title="The saved relay could not be read">
          Exchanges in this browser use no relay until it is saved again. Enter
          the relay&apos;s addresses and save.
        </Alert>
      )}

      <Stack gap="md" mt="md">
        <Textarea
          label="TURN server urls"
          description="One per line, for example turns:relay.example.org:443?transport=tcp"
          autosize
          minRows={2}
          value={turnText}
          error={turnError}
          errorProps={{ role: "alert" }}
          onChange={(event) => {
            setTurnText(event.currentTarget.value);
            setStatus({ kind: "idle" });
          }}
        />
        <Textarea
          label="STUN server urls"
          description="One per line, listed beside the default STUN server every exchange in this browser uses. For example: stun:stun.example.org:3478"
          autosize
          minRows={2}
          value={stunText}
          error={stunError}
          errorProps={{ role: "alert" }}
          onChange={(event) => {
            setStunText(event.currentTarget.value);
            setStatus({ kind: "idle" });
          }}
        />
      </Stack>

      <h2>Which relays an exchange may use</h2>
      {consoleBuild ? (
        <p>{CONSOLE_RELAY_RESTRICTION_LINE}</p>
      ) : (
        <AllowedRelaysControls
          allowedText={allowedText}
          allowedError={allowedError}
          onAllowedText={(text) => {
            setAllowedText(text);
            setStatus({ kind: "idle" });
          }}
        />
      )}

      <div className={styles.workFoot}>
        <Group>
          <Button onClick={save}>Save</Button>
          <Button variant="outline" onClick={remove}>
            Remove relay
          </Button>
        </Group>
        <p className={styles.statusLine} role="status">
          {status.kind === "saved" &&
            "Saved. Exchanges started from now on use this relay."}
          {status.kind === "savedWithoutRelay" &&
            "Saved. No relay of your own is set."}
          {status.kind === "removed" &&
            "No relay is set. Exchanges connect without one."}
          {status.kind === "failed" &&
            "This browser did not save the setting. Check that site storage is allowed for this site, then save again."}
          {status.kind === "restrictionSavedOnly" &&
            RESTRICTION_SAVED_RELAY_NOT_SAVED}
          {status.kind === "nothingSaved" && NOTHING_SAVED}
        </p>
      </div>

      <RelayTestSection
        key={testTargets.map((target) => target.url).join("\n")}
        targets={testTargets}
        unsavedChanges={unsavedTurnChanges || unsavedAllowedChanges}
      />

      <p className={`${styles.small} ${styles.sub}`}>
        <Anchor inherit component={Link} to="/">
          Back to the start page
        </Anchor>
      </p>
    </WorkShell>
  );
}
