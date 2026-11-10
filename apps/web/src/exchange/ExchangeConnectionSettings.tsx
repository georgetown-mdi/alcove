import { useState } from "react";

import {
  Anchor,
  Box,
  Button,
  Group,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from "@mantine/core";

import { DEFAULT_RELAY_SWITCH_LABEL } from "@psi/transport/defaultRelaySwitch";
import { SettingSummaryLine } from "@components/SettingSummaryLine";
import { defaultRelayBuild } from "@utils/clientConfig";
import styles from "@styles/app.module.css";
import { useOpenCloseFocus } from "@components/useOpenCloseFocus";

import { CONNECTION_SETTINGS_GUIDE_URL } from "./userGuide";

import type {
  ConnectionSettingsErrors,
  ConnectionSettingsText,
} from "@recurring/managedConnectionSettingsModel";
import type { DefaultRelayBuild } from "@utils/clientConfig";

/**
 * What the relay's operator learns, beside the switch and in
 * `DefaultRelayNotice`. docs/COMMUNICATION.md and
 * docs/SHARED_RESPONSIBILITY.md state it in full, with the reason the address
 * reaches the relay when no traffic is relayed.
 */
export const RELAY_OPERATOR_DISCLOSURE =
  "The relay's operator learns each party's network address for every exchange " +
  "that uses it, even when no traffic is relayed. The relay passes only " +
  "encrypted traffic and cannot read the exchange.";

/** When a relay is needed. */
export const RELAY_INTRO =
  "Use a relay when a firewall blocks a direct connection to your partner.";

/** The server field's description. */
export const SERVER_FIELD_DESCRIPTION =
  "You and your partner must use the same server.";

/** The switch's description, where the build offers its relay server
 * switched off. */
export const DEFAULT_RELAY_SWITCH_HELP = `Use it when a network blocks a direct connection. ${RELAY_OPERATOR_DISCLOSURE}`;

/** The TURN field's description. */
export const TURN_FIELD_DESCRIPTION =
  "One per line, for example turns:relay.example.org:443?transport=tcp";

/** The STUN field's description. */
const STUN_FIELD_DESCRIPTION =
  "One per line, for example stun:stun.example.org:3478";

/** The WebSocket relay field's description. */
const WEBSOCKET_RELAY_FIELD_DESCRIPTION =
  "For example: wss://relay.example.org/relay";

/** The relay line where no relay is set. */
const NO_RELAY_SET = "No relay set.";

/** The relay line where `text` names urls: each of them. */
export function relaySummary(
  text: Pick<ConnectionSettingsText, "turn" | "stun" | "websocket">,
): string | undefined {
  const urls = [text.turn, text.stun, text.websocket]
    .flatMap((field) => field.split(/\r?\n/))
    .map((url) => url.trim())
    .filter((url) => url !== "");
  return urls.length > 0 ? `Relay: ${urls.join(", ")}` : undefined;
}

/**
 * An exchange's own TURN, STUN and WebSocket relay urls, shown as one line
 * until the user opens them: no relay, with Set a relay, or the urls set,
 * with Change and Remove. A refused value keeps them open. Where `fixed` the
 * line shows them with no action.
 */
export function RelayFields({
  text,
  errors,
  onChange,
  fixed = false,
  errorsAnnounced = false,
}: {
  text: Pick<ConnectionSettingsText, "turn" | "stun" | "websocket">;
  errors: Pick<ConnectionSettingsErrors, "turn" | "stun" | "websocket">;
  onChange: (change: Partial<ConnectionSettingsText>) => void;
  fixed?: boolean;
  /** The errors come from a Save rather than follow typing, so each is
   * announced as an alert. */
  errorsAnnounced?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const errorProps = errorsAnnounced ? { errorProps: { role: "alert" } } : {};
  const { fieldRef, actionRef, focusFieldNext, focusActionNext } =
    useOpenCloseFocus<HTMLTextAreaElement>();
  const refused =
    errors.turn !== undefined ||
    errors.stun !== undefined ||
    errors.websocket !== undefined;
  const summary = relaySummary(text);

  if ((open || refused) && !fixed)
    return (
      <Stack gap="sm">
        <Textarea
          ref={fieldRef}
          label="TURN server urls"
          description={TURN_FIELD_DESCRIPTION}
          autosize
          minRows={2}
          value={text.turn}
          error={errors.turn}
          {...errorProps}
          onChange={(event) => onChange({ turn: event.currentTarget.value })}
        />
        <Textarea
          label="STUN server urls"
          description={STUN_FIELD_DESCRIPTION}
          autosize
          minRows={2}
          value={text.stun}
          error={errors.stun}
          {...errorProps}
          onChange={(event) => onChange({ stun: event.currentTarget.value })}
        />
        <TextInput
          label="WebSocket relay url"
          description={WEBSOCKET_RELAY_FIELD_DESCRIPTION}
          value={text.websocket}
          error={errors.websocket}
          {...errorProps}
          onChange={(event) =>
            onChange({ websocket: event.currentTarget.value })
          }
        />
        <Group gap="sm">
          <Button
            size="xs"
            variant="default"
            disabled={refused}
            onClick={() => {
              focusActionNext();
              setOpen(false);
            }}
          >
            Done
          </Button>
          <Anchor
            size="sm"
            href={CONNECTION_SETTINGS_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
          >
            Learn more about relays
          </Anchor>
        </Group>
      </Stack>
    );

  return (
    <SettingSummaryLine
      summary={summary ?? NO_RELAY_SET}
      isSet={summary !== undefined}
      settingName="relay"
      setLabel="Set a relay"
      actionRef={actionRef}
      actions={!fixed}
      onOpen={() => {
        focusFieldNext();
        setOpen(true);
      }}
      onRemove={() => {
        focusActionNext();
        onChange({ turn: "", stun: "", websocket: "" });
      }}
    />
  );
}

/**
 * The Connection settings of an invitation this page creates or accepts:
 * the coordination server where `showServer`, the switch that turns on the
 * relay server the build offers switched off, and the exchange's own relays
 * ({@link RelayFields}). The caller reads the text
 * (`exchangeConnectionRead`) and passes its errors. Where `fixed`, a created
 * invitation or a started exchange took them, and nothing changes.
 */
export function ExchangeConnectionSettings({
  text,
  errors,
  onChange,
  showServer,
  fixed = false,
  build = defaultRelayBuild,
}: {
  text: ConnectionSettingsText;
  errors: ConnectionSettingsErrors;
  onChange: (change: Partial<ConnectionSettingsText>) => void;
  showServer: boolean;
  fixed?: boolean;
  /** The build's default relay and its mode; the build's own when unset. */
  build?: () => DefaultRelayBuild;
}) {
  const [offersSwitch] = useState(() => build().kind === "opt-in");
  return (
    <Box mt="md">
      <h2 className={styles.eyebrow}>Connection settings</h2>
      <Stack gap="sm" mt="xs">
        {showServer && (
          <TextInput
            label="Coordination server"
            description={SERVER_FIELD_DESCRIPTION}
            value={text.server}
            readOnly={fixed}
            error={errors.server}
            onChange={(event) =>
              onChange({ server: event.currentTarget.value })
            }
          />
        )}
        <p className={styles.small}>{RELAY_INTRO}</p>
        {offersSwitch && (
          <Switch
            label={DEFAULT_RELAY_SWITCH_LABEL}
            description={DEFAULT_RELAY_SWITCH_HELP}
            checked={text.defaultRelayOn}
            disabled={fixed}
            onChange={(event) =>
              onChange({ defaultRelayOn: event.currentTarget.checked })
            }
          />
        )}
        <RelayFields
          text={text}
          errors={errors}
          onChange={onChange}
          fixed={fixed}
        />
      </Stack>
    </Box>
  );
}
