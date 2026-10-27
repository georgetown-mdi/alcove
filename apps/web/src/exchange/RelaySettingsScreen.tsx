import { useId, useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  Group,
  Input,
  Stack,
  Switch,
  TextInput,
  Textarea,
  VisuallyHidden,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { InfoButton } from "@components/InfoButton";

import {
  DEFAULT_RELAY_SWITCH_LABEL,
  readDefaultRelaySwitch,
  writeDefaultRelaySwitch,
} from "@psi/transport/defaultRelaySwitch";
import {
  parseRelayUrlLines,
  parseWebSocketRelayUrl,
  readOwnRelaySetting,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";
import { defaultRelayBuild } from "@utils/clientConfig";
import { defaultRelayInUse } from "@psi/transport/defaultRelay";
import { relayTestTargets } from "@psi/transport/relayTest";
import styles from "@styles/app.module.css";

import { CoordinationServerSection } from "./CoordinationServerSection";
import { RELAY_SETTINGS_GUIDE_URL } from "./userGuide";
import { RelayTestSection } from "./RelayTestSection";
import { WorkShell } from "./WorkShell";

import type {
  DefaultRelayBuild,
  DefaultRelaySetting,
} from "@utils/clientConfig";
import type { RelayUrlLines } from "@psi/transport/ownRelaySetting";

/**
 * What the relay's operator learns, behind the relay settings page's info
 * buttons and in `DefaultRelayNotice`. docs/COMMUNICATION.md and
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
  "This setting applies to the exchanges this browser runs and the " +
  "invitations you create. When it is on, those exchanges use the site's " +
  "relay server, unless an exchange's allowed relays leave it out, and " +
  "those invitations name it so your partner can use it too. When it is " +
  "off, this browser uses it only where an invitation you accept names it, " +
  "or where you enter its address under TURN server urls. Your partner can " +
  "still bring it into an exchange whatever you choose here, so to keep it " +
  `out, you both leave it out. ${RELAY_OPERATOR_DISCLOSURE}`;

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

/** The relay settings page's opening line: when a relay is needed. */
export const RELAY_PAGE_INTRO =
  "Use a relay when a firewall blocks a direct connection to your partner.";

/** The explanation behind the info button on {@link RELAY_PAGE_INTRO}: which
 * party sets the relay up, what its operator learns, and where an exchange
 * leaves a relay out. */
export const RELAY_PAGE_INFO =
  "If you run the relay, create the invitation so your partner uses it too. " +
  `${RELAY_OPERATOR_DISCLOSURE} The allowed relays an exchange sets on its ` +
  "review, or a saved exchange on its own page, can leave out any of the " +
  "relays saved here.";

/**
 * What the relay must hold for each run's credential, behind the TURN field's
 * info button and stated in docs/COMMUNICATION.md.
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

/** The TURN field's description. */
export const TURN_FIELD_DESCRIPTION =
  "One per line, for example turns:relay.example.org:443?transport=tcp";

/** The STUN field's description. */
export const STUN_FIELD_DESCRIPTION =
  "One per line, for example stun:stun.example.org:3478";

/** The explanation behind the STUN field's info button: what a STUN server
 * learns, and that the servers entered and an accepted invitation's take the
 * default's place (`buildIceServers`). */
export const STUN_FIELD_INFO =
  "A STUN server finds each browser's public network address, so it learns " +
  "the network address of each party that uses it. The servers you enter " +
  "replace the default, Google's public STUN server, in every exchange this " +
  "browser runs, and invitations you create name them, so your partner " +
  "contacts them in place of the default too. Servers an invitation you " +
  "accept names are contacted as well, and also replace the default.";

/** The WebSocket relay field's description. */
export const WEBSOCKET_RELAY_FIELD_DESCRIPTION =
  "For example: wss://relay.example.org/relay";

/** The explanation behind the WebSocket relay field's info button: what the
 * relay's operator learns, since each run that lists the url opens a socket
 * to it. */
export const WEBSOCKET_RELAY_FIELD_INFO =
  "A relay for networks that block connections through a TURN relay. An " +
  "invitation you send names it. Each exchange connects to it as it starts, " +
  "so its operator learns your network address, and the exchange passes " +
  "through it, encrypted, only when no other connection opens.";

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
 * The relay settings page of the hosted app: this browser's own TURN and STUN
 * urls and its WebSocket relay url, kept in browser storage for this site, a
 * test of the relays a browser run lists that the user starts, and what the
 * relay's operator learns. The page also sets the coordination server the
 * invitations this browser creates name ({@link CoordinationServerSection}).
 * A console build has no such page: its route redirects. The relays an
 * exchange may use are that exchange's own, set
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
  const turnFieldId = useId();
  const stunFieldId = useId();
  const websocketFieldId = useId();
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
  const websocketEntry = parseWebSocketRelayUrl(websocketText);
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
      <InfoButton label="About relays" explanation={RELAY_PAGE_INFO}>
        <p className={`${styles.small} ${styles.sub} ${styles.infoLine}`}>
          {RELAY_PAGE_INTRO}{" "}
          <Anchor
            inherit
            href={RELAY_SETTINGS_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
          >
            Learn more
            <VisuallyHidden>
              {" "}
              about relay settings (opens in a new tab)
            </VisuallyHidden>
          </Anchor>
        </p>
      </InfoButton>

      {offersSwitch && (
        <InfoButton
          mt="md"
          label="About this site's relay server"
          explanation={DEFAULT_RELAY_SWITCH_DESCRIPTION}
        >
          {(explanationId) => (
            <Switch
              label={DEFAULT_RELAY_SWITCH_LABEL}
              aria-describedby={explanationId}
              checked={switchOn}
              error={
                switchNotSaved ? (
                  <span role="alert">{DEFAULT_RELAY_SWITCH_NOT_SAVED}</span>
                ) : undefined
              }
              onChange={(event) =>
                switchDefaultRelay(event.currentTarget.checked)
              }
            />
          )}
        </InfoButton>
      )}

      {initial.kind === "unreadable" && status.kind === "idle" && (
        <Alert color="yellow" title="The saved relay could not be read">
          {siteRelayInUse
            ? NO_OWN_RELAY_SITE_RELAY_IN_USE
            : "Exchanges in this browser use no relay of your own until you save one again."}{" "}
          Enter the relay&apos;s addresses and save.
        </Alert>
      )}

      <Stack gap="md" mt="md">
        <InfoButton
          label="About TURN servers"
          explanation={RELAY_KEY_NOTICE}
          controls={() => (
            <Textarea
              id={turnFieldId}
              description={TURN_FIELD_DESCRIPTION}
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
          )}
        >
          <Input.Label htmlFor={turnFieldId}>TURN server urls</Input.Label>
        </InfoButton>
        <InfoButton
          label="About STUN servers"
          explanation={STUN_FIELD_INFO}
          controls={() => (
            <Textarea
              id={stunFieldId}
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
          )}
        >
          <Input.Label htmlFor={stunFieldId}>STUN server urls</Input.Label>
        </InfoButton>
        <InfoButton
          label="About the WebSocket relay"
          explanation={WEBSOCKET_RELAY_FIELD_INFO}
          controls={() => (
            <TextInput
              id={websocketFieldId}
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
        >
          <Input.Label htmlFor={websocketFieldId}>
            WebSocket relay url
          </Input.Label>
        </InfoButton>
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

      <CoordinationServerSection />

      <p className={`${styles.small} ${styles.sub}`}>
        <Anchor inherit component={Link} to="/">
          Back to the start page
        </Anchor>
      </p>
    </WorkShell>
  );
}
