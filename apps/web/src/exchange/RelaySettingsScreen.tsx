import { useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Stack,
  Textarea,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";

import {
  ALLOWED_RELAYS_SCOPE,
  parseAllowedRelayLines,
  readRelayRestriction,
  writeRelayRestriction,
} from "@psi/transport/relayRestriction";
import {
  parseRelayUrlLines,
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { defaultRelaySetting } from "@utils/clientConfig";
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

/** What Relay only does, shown beside the setting. */
export const RELAY_ONLY_DESCRIPTION =
  "Your browser offers your partner only addresses on a relay, never its " +
  "own network address. A run with no relay to use does not connect.";

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

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "savedWithoutRelay" }
  | { kind: "removed" }
  | { kind: "failed" };

/**
 * The relay settings page: this browser's own TURN and STUN urls and the
 * relays a run may use, with whether it connects through a relay only, kept
 * in browser storage for this site, with what the relay's operator learns
 * stated beside them, and a test of the relays a browser run lists that the
 * user starts. The hosted app and a console each hold their own.
 */
export function RelaySettingsScreen({
  defaultRelay = defaultRelaySetting,
}: {
  /** The build's default relay; {@link defaultRelaySetting} when unset. */
  defaultRelay?: () => DefaultRelaySetting | undefined;
}) {
  const [initial] = useState(readOwnRelaySetting);
  const [turnText, setTurnText] = useState(
    initial.kind === "set" ? initial.relay.turn.join("\n") : "",
  );
  const [stunText, setStunText] = useState(
    initial.kind === "set" ? initial.relay.stun.join("\n") : "",
  );
  const [initialRestriction] = useState(readRelayRestriction);
  const [allowedText, setAllowedText] = useState(
    initialRestriction.kind === "set"
      ? (initialRestriction.restriction.allowedRelays ?? []).join("\n")
      : "",
  );
  const [relayOnly, setRelayOnly] = useState(
    initialRestriction.kind === "set" &&
      initialRestriction.restriction.relayOnly,
  );
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [testTargets, setTestTargets] = useState(() =>
    relayTestTargets(() => initial, defaultRelay),
  );
  const [savedTurn, setSavedTurn] = useState<ReadonlyArray<string>>(
    initial.kind === "set" ? initial.relay.turn : [],
  );
  const [savedAllowed, setSavedAllowed] = useState<ReadonlyArray<string>>(
    initialRestriction.kind === "set"
      ? (initialRestriction.restriction.allowedRelays ?? [])
      : [],
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
    const stored = readRelayRestriction();
    setSavedAllowed(
      stored.kind === "set" ? (stored.restriction.allowedRelays ?? []) : [],
    );
    setTestTargets(relayTestTargets(readOwnRelaySetting, defaultRelay));
  }

  function save() {
    setAttempted(true);
    if (!turnLines.ok || !stunLines.ok || !allowedLines.ok) {
      setStatus({ kind: "idle" });
      return;
    }
    try {
      writeRelayRestriction({
        ...(allowedLines.entries !== undefined && {
          allowedRelays: allowedLines.entries,
        }),
        relayOnly,
      });
      writeOwnRelaySetting({ turn: turnLines.urls, stun: stunLines.urls });
      refreshTestTargets(turnLines.urls);
      const restricted = allowedLines.entries !== undefined || relayOnly;
      setStatus({
        kind:
          turnLines.urls.length + stunLines.urls.length > 0
            ? "saved"
            : restricted
              ? "savedWithoutRelay"
              : "removed",
      });
    } catch {
      // The restriction may be stored while the own relay is not, so the
      // saved state and the test are re-read from storage.
      const stored = readOwnRelaySetting();
      refreshTestTargets(stored.kind === "set" ? stored.relay.turn : []);
      setStatus({ kind: "failed" });
    }
  }

  function remove() {
    try {
      writeOwnRelaySetting({ turn: [], stun: [] });
      refreshTestTargets([]);
      setTurnText("");
      setStunText("");
      setAttempted(false);
      const stored = readRelayRestriction();
      setStatus({
        kind:
          stored.kind === "set" &&
          stored.restriction.allowedRelays === undefined &&
          !stored.restriction.relayOnly
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
        invitation you accept, after yours, unless your allowed relays below
        leave it out. {RELAY_KEY_NOTICE}
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
      <p>{ALLOWED_RELAYS_SCOPE}</p>

      {initialRestriction.kind === "unreadable" && status.kind === "idle" && (
        <Alert
          color="yellow"
          title="The saved allowed relays could not be read"
        >
          Exchanges in this browser use no relay and connect through a relay
          only until they are saved again. Enter your allowed relays, choose
          Relay only if you want it, and save.
        </Alert>
      )}

      <Stack gap="md" mt="md">
        <Textarea
          label="Allowed relays"
          description="One host per line, with a port where needed, for example relay.example.org or relay.example.org:443. Each run uses only the relays listed here, yours, the invitation's or this site's. Leave it empty to use every relay a run lists."
          autosize
          minRows={2}
          value={allowedText}
          error={allowedError}
          errorProps={{ role: "alert" }}
          onChange={(event) => {
            setAllowedText(event.currentTarget.value);
            setStatus({ kind: "idle" });
          }}
        />
        <Checkbox
          label="Relay only"
          description={RELAY_ONLY_DESCRIPTION}
          checked={relayOnly}
          onChange={(event) => {
            setRelayOnly(event.currentTarget.checked);
            setStatus({ kind: "idle" });
          }}
        />
      </Stack>

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
