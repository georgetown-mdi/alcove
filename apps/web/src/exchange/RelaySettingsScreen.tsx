import { useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  Group,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";

import {
  DEFAULT_RELAY_SWITCH_LABEL,
  readDefaultRelaySwitch,
  writeDefaultRelaySwitch,
} from "@psi/transport/defaultRelaySwitch";
import { defaultRelayBuild, isConsoleBuild } from "@utils/clientConfig";
import {
  parseRelayUrlLines,
  parseWebSocketRelayUrl,
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { defaultRelayInUse } from "@psi/transport/defaultRelay";
import { relayTestTargets } from "@psi/transport/relayTest";
import styles from "@styles/app.module.css";

import { RelayTestSection } from "./RelayTestSection";
import { WorkShell } from "./WorkShell";

import type {
  DefaultRelayBuild,
  DefaultRelaySetting,
} from "@utils/clientConfig";
import type { RelayUrlLines } from "@psi/transport/ownRelaySetting";

/**
 * What the relay's operator learns, shown at the end of the relay settings page
 * and in `DefaultRelayNotice`. docs/COMMUNICATION.md and
 * docs/SHARED_RESPONSIBILITY.md state it in full, with the reason the address
 * reaches the relay when no traffic is relayed.
 */
export const RELAY_OPERATOR_DISCLOSURE =
  "The relay's operator learns each party's network address for every exchange " +
  "that uses it, even when no traffic is relayed. The relay passes only " +
  "encrypted traffic and cannot read the exchange.";

/**
 * What the switch for a default relay the build offers switched off does,
 * then {@link RELAY_OPERATOR_DISCLOSURE}, as `DefaultRelayNotice` states them.
 */
export const DEFAULT_RELAY_SWITCH_DESCRIPTION =
  "The switch covers the exchanges this browser runs and the invitations " +
  "you create. When it is on, those exchanges use the site's relay server, " +
  "unless an exchange's allowed relays leave it out, and those invitations " +
  "name it, so your partner's exchange can use it too. When it is off, an " +
  "exchange in this browser uses it only where an invitation you accept, or " +
  "the TURN server urls below, name it. Your partner can still bring it " +
  "into an exchange whatever you choose here, so its operator can learn " +
  `your network address too. ${RELAY_OPERATOR_DISCLOSURE}`;

/** The switch's error where this browser did not store its new state. */
export const DEFAULT_RELAY_SWITCH_NOT_SAVED =
  "This browser did not save the setting. Check that site storage is " +
  "allowed for this site, then try again.";

/** What the page reports where this browser has no relay of its own set and
 * this site's relay server is not in use. */
export const NO_RELAY_SET = "No relay of your own is set.";

/** What the page reports where this browser has no relay of its own set and
 * this site's relay server is in use. */
export const NO_OWN_RELAY_SITE_RELAY_IN_USE =
  "No relay of your own is set. Exchanges use this site's relay server.";

/** The relay settings page's opening paragraph: when a relay is needed, and
 * which party sets it up. */
export const RELAY_PAGE_INTRO =
  "When a firewall blocks a direct connection to your partner, you can both " +
  "connect through a TURN relay. If you run the relay, create the invitation " +
  "so your partner uses it too.";

/**
 * What the relay must hold for each run's credential, shown under the page's
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

/** The STUN field's description: what a STUN server learns, and that the
 * servers entered take the default's place (`buildIceServers`). */
export const STUN_FIELD_DESCRIPTION =
  "One per line. A STUN server finds each browser's public network address, " +
  "so it learns the network address of each party that uses it. The servers " +
  "you enter replace the default, Google's public STUN server, in every " +
  "exchange this browser runs, and invitations you create name them, so your " +
  "partner contacts them too. Servers an invitation you accept names are " +
  "contacted as well, and your partner follows their own setting. For " +
  "example: stun:stun.example.org:3478";

/** The WebSocket relay field's description. */
export const WEBSOCKET_RELAY_FIELD_DESCRIPTION =
  "A relay for networks that block connections through a TURN relay. An " +
  "invitation you send names it. Exchanges do not connect through a " +
  "WebSocket relay yet. For example: wss://relay.example.org/relay";

/** The field error for one list's parse, or `undefined` when it parsed. */
function fieldError(lines: RelayUrlLines): string | undefined {
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
  | { kind: "removed" }
  /** The relay server addresses were not stored. */
  | { kind: "failed" };

/**
 * The relay settings page: this browser's own TURN and STUN urls and, on the
 * hosted app, its WebSocket relay url, kept in browser storage for this site,
 * a test of the relays a browser run lists that the user starts, and what the
 * relay's operator learns. The hosted app and a console each hold their own; a
 * console runs no exchange over a WebSocket relay, so it offers no WebSocket
 * relay field. The relays an exchange may use are that exchange's own, set
 * where it is authored, so none is set here. Where the build offers its
 * default relay switched off, the page has the switch that turns it on in
 * this browser, which takes effect when it is changed.
 */
export function RelaySettingsScreen({
  build = defaultRelayBuild,
  defaultRelay = () => defaultRelayInUse(build),
}: {
  /** The build's default relay and its mode; the build's own when unset. */
  build?: () => DefaultRelayBuild;
  /** The default relay in use; {@link defaultRelayInUse} of `build` when
   * unset. */
  defaultRelay?: () => DefaultRelaySetting | undefined;
}) {
  const consoleBuild = isConsoleBuild();
  const [offersSwitch] = useState(() => build().kind === "opt-in");
  const [switchOn, setSwitchOn] = useState(readDefaultRelaySwitch);
  const [switchNotSaved, setSwitchNotSaved] = useState(false);
  const [initial] = useState(readOwnRelaySetting);
  const [turnText, setTurnText] = useState(
    initial.kind === "set" ? initial.relay.turn.join("\n") : "",
  );
  const [stunText, setStunText] = useState(
    initial.kind === "set" ? initial.relay.stun.join("\n") : "",
  );
  const [websocketText, setWebsocketText] = useState(
    initial.kind === "set" ? (initial.relay.websocket ?? "") : "",
  );
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [testTargets, setTestTargets] = useState(() =>
    relayTestTargets(() => initial, defaultRelay),
  );
  const [savedTurn, setSavedTurn] = useState<ReadonlyArray<string>>(
    initial.kind === "set" ? initial.relay.turn : [],
  );

  const turnLines = parseRelayUrlLines(turnText, "turn");
  const stunLines = parseRelayUrlLines(stunText, "stun");
  const websocketEntry = parseWebSocketRelayUrl(
    consoleBuild ? "" : websocketText,
  );
  const turnError = attempted ? fieldError(turnLines) : undefined;
  const stunError = attempted ? fieldError(stunLines) : undefined;
  const websocketError =
    attempted && !websocketEntry.ok ? websocketEntry.message : undefined;
  const unsavedTurnChanges =
    !turnLines.ok || turnLines.urls.join("\n") !== savedTurn.join("\n");
  const siteRelayInUse = defaultRelay() !== undefined;

  function refreshTestTargets(turn: ReadonlyArray<string>) {
    setSavedTurn(turn);
    setTestTargets(relayTestTargets(readOwnRelaySetting, defaultRelay));
  }

  function switchDefaultRelay(on: boolean) {
    try {
      writeDefaultRelaySwitch(on);
    } catch {
      setSwitchNotSaved(true);
      return;
    }
    setSwitchOn(on);
    setSwitchNotSaved(false);
    setTestTargets(relayTestTargets(readOwnRelaySetting, defaultRelay));
  }

  function save() {
    setAttempted(true);
    if (!turnLines.ok || !stunLines.ok || !websocketEntry.ok) {
      setStatus({ kind: "idle" });
      return;
    }
    const websocket = websocketEntry.url;
    try {
      writeOwnRelaySetting({
        turn: turnLines.urls,
        stun: stunLines.urls,
        ...(websocket !== undefined && { websocket }),
      });
    } catch {
      const stored = readOwnRelaySetting();
      refreshTestTargets(stored.kind === "set" ? stored.relay.turn : []);
      setStatus({ kind: "failed" });
      return;
    }
    refreshTestTargets(turnLines.urls);
    setStatus({
      kind:
        turnLines.urls.length + stunLines.urls.length > 0 ||
        websocket !== undefined
          ? "saved"
          : "removed",
    });
  }

  function remove() {
    try {
      writeOwnRelaySetting({ turn: [], stun: [] });
      refreshTestTargets([]);
      setTurnText("");
      setStunText("");
      setWebsocketText("");
      setAttempted(false);
      setStatus({ kind: "removed" });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  return (
    <WorkShell>
      <h1>Relay server</h1>
      <p className={`${styles.small} ${styles.sub}`}>{RELAY_PAGE_INTRO}</p>
      <p className={`${styles.small} ${styles.sub}`}>
        {consoleBuild
          ? "Exchanges run from this console follow the command-line configuration: its connection.allowed_relays key decides which relays an exchange may use, and a WebRTC invitation you accept that names a TURN server sets it in the Allowed relays field on its first step."
          : "The allowed relays an exchange sets on its review, or a saved exchange on its own page, can leave out any of the relays saved here."}{" "}
        {RELAY_KEY_NOTICE}
      </p>

      {offersSwitch && (
        <Switch
          mt="md"
          label={DEFAULT_RELAY_SWITCH_LABEL}
          description={DEFAULT_RELAY_SWITCH_DESCRIPTION}
          checked={switchOn}
          error={
            switchNotSaved ? (
              <span role="alert">{DEFAULT_RELAY_SWITCH_NOT_SAVED}</span>
            ) : undefined
          }
          onChange={(event) => switchDefaultRelay(event.currentTarget.checked)}
        />
      )}

      {initial.kind === "unreadable" && status.kind === "idle" && (
        <Alert color="yellow" title="The saved relay could not be read">
          {siteRelayInUse
            ? NO_OWN_RELAY_SITE_RELAY_IN_USE
            : "Exchanges in this browser use no relay of your own until it is saved again."}{" "}
          Enter the relay&apos;s addresses and save.
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
          description={STUN_FIELD_DESCRIPTION}
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
        {!consoleBuild && (
          <TextInput
            label="WebSocket relay url"
            description={WEBSOCKET_RELAY_FIELD_DESCRIPTION}
            value={websocketText}
            error={websocketError}
            errorProps={{ role: "alert" }}
            onChange={(event) => {
              setWebsocketText(event.currentTarget.value);
              setStatus({ kind: "idle" });
            }}
          />
        )}
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
          {status.kind === "removed" &&
            (siteRelayInUse ? NO_OWN_RELAY_SITE_RELAY_IN_USE : NO_RELAY_SET)}
          {status.kind === "failed" &&
            "This browser did not save the setting. Check that site storage is allowed for this site, then save again."}
        </p>
      </div>

      <RelayTestSection
        key={testTargets.map((target) => target.url).join("\n")}
        targets={testTargets}
        unsavedChanges={unsavedTurnChanges}
      />

      <h2>What the relay&apos;s operator learns</h2>
      <p>{RELAY_OPERATOR_DISCLOSURE}</p>

      <p className={`${styles.small} ${styles.sub}`}>
        <Anchor inherit component={Link} to="/">
          Back to the start page
        </Anchor>
      </p>
    </WorkShell>
  );
}
