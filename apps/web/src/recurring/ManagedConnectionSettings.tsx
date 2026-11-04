import { useState } from "react";

import { Alert, Button, Stack, Switch, TextInput } from "@mantine/core";

import {
  DEFAULT_RELAY_SWITCH_HELP,
  RELAY_INTRO,
  RelayFields,
  SERVER_FIELD_DESCRIPTION,
} from "@exchange/ExchangeConnectionSettings";
import { DEFAULT_RELAY_SWITCH_LABEL } from "@psi/transport/defaultRelaySwitch";
import { defaultRelayBuild } from "@utils/clientConfig";
import styles from "@styles/app.module.css";

import {
  connectionSettingsEdits,
  connectionSettingsTextFrom,
  signalingServerText,
} from "./managedConnectionSettingsModel";

import type {
  ConnectionSettingsErrors,
  ConnectionSettingsText,
} from "./managedConnectionSettingsModel";
import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { DefaultRelayBuild } from "@utils/clientConfig";

/**
 * A saved exchange's Connection settings: the coordination server its runs
 * and re-invites use, its own TURN, STUN and WebSocket relay urls, and,
 * where the build offers its relay server switched off, the switch that
 * turns it on for this exchange. One Save writes them all through the
 * store's local-fields edit.
 */
export function ManagedConnectionSettings({
  record,
  onSave,
  build = defaultRelayBuild,
}: {
  record: ManagedExchangeRecord;
  onSave: (edits: ManagedExchangeLocalEdits) => Promise<void>;
  /** The build's default relay and its mode; the build's own when unset. */
  build?: () => DefaultRelayBuild;
}) {
  const pageProtocol = window.location.protocol;
  const [offersSwitch] = useState(() => build().kind === "opt-in");
  const [text, setText] = useState<ConnectionSettingsText>(() =>
    connectionSettingsTextFrom(record, pageProtocol),
  );
  const [errors, setErrors] = useState<ConnectionSettingsErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  function edit(fields: Partial<ConnectionSettingsText>) {
    setText((current) => ({ ...current, ...fields }));
    setSaved(false);
  }

  function save() {
    const read = connectionSettingsEdits(
      text,
      signalingServerText(record, pageProtocol),
      pageProtocol,
    );
    if (!read.ok) {
      setErrors(read.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    setFailed(false);
    onSave(read.edits).then(
      () => {
        setSaving(false);
        setSaved(true);
      },
      () => {
        setSaving(false);
        setFailed(true);
      },
    );
  }

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Connection settings</h2>
      <Stack gap="sm" mt="sm">
        <TextInput
          label="Coordination server"
          description={SERVER_FIELD_DESCRIPTION}
          value={text.server}
          error={errors.server}
          errorProps={{ role: "alert" }}
          onChange={(event) => edit({ server: event.currentTarget.value })}
        />
        <p className={styles.small}>{RELAY_INTRO}</p>
        {offersSwitch && (
          <Switch
            label={DEFAULT_RELAY_SWITCH_LABEL}
            description={DEFAULT_RELAY_SWITCH_HELP}
            checked={text.defaultRelayOn}
            onChange={(event) =>
              edit({ defaultRelayOn: event.currentTarget.checked })
            }
          />
        )}
        <RelayFields
          text={text}
          errors={errors}
          onChange={edit}
          errorsAnnounced
        />
      </Stack>
      {failed && (
        <Alert
          role="alert"
          color="red"
          title="That could not be saved"
          mt="sm"
          mb="sm"
        >
          These settings were not saved. Nothing changed; try again.
        </Alert>
      )}
      {saved && !failed && (
        <p className={`${styles.small} ${styles.statusLineOk}`}>
          Connection settings saved.
        </p>
      )}
      <Button mt="sm" onClick={save} loading={saving}>
        Save connection settings
      </Button>
    </div>
  );
}
