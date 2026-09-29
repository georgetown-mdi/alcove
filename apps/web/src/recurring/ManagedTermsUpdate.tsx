import { useState } from "react";

import { Button, Checkbox, Stack } from "@mantine/core";

import { isDisclosedToPartner } from "@alcove/core";

import {
  ManagedTermsUpdateRefusedError,
  makeManagedTermsUpdate,
  managedTermsUpdateRefusal,
  saveManagedSentColumns,
} from "@psi/managed/managedTermsUpdate";
import {
  managedSentColumnsEditable,
  sentColumnChoiceOffered,
} from "@psi/managed/managedExchangeRecord";
import { ColumnName } from "@components/ColumnName";
import { CopyRow } from "@exchange/RunSurface";
import { whenDiagnostic } from "@utils/diagnostics";

import styles from "@styles/app.module.css";

import {
  CHANGE_TERMS_TITLE,
  MAKE_TERMS_UPDATE_LABEL,
  SAVE_SENT_COLUMNS_LABEL,
  SEND_TERMS_UPDATE_LABEL,
  SEND_TERMS_UPDATE_TEXT,
  SENT_COLUMNS_LABEL,
  SENT_COLUMNS_SAVED_TEXT,
  SENT_COLUMNS_TEXT,
  TERMS_UPDATE_COPY_HINT,
  TERMS_UPDATE_COPY_LABEL,
  TERMS_UPDATE_NOT_MADE_TEXT,
  TERMS_UPDATE_WITHHELD_TEXT,
  fixedColumnNote,
  sentColumnsFailureText,
} from "./managedTermsUpdateModel";

import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/**
 * Changing a saved exchange's terms between runs: the columns this party
 * sends, and the terms update that tells the partner. Every write is withheld
 * while a run holds the exchange. `onChanged` is told once the stored
 * exchange changed, so the page reads it again.
 */
export function ManagedTermsUpdate({
  record,
  runInFlight,
  onChanged,
}: {
  record: RunnableManagedExchangeRecord;
  runInFlight: boolean;
  onChanged: () => void;
}) {
  const refusal = managedTermsUpdateRefusal(record, Date.now(), runInFlight);
  const storedKey = sentColumnsKey(storedSentColumns(record));
  const [savedKey, setSavedKey] = useState<string>();
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>{CHANGE_TERMS_TITLE}</h2>
      {managedSentColumnsEditable(record.exchangeFile) && (
        <SentColumnsEditor
          key={storedKey}
          record={record}
          runInFlight={runInFlight}
          saved={savedKey === storedKey}
          onSaved={(key) => {
            setSavedKey(key);
            onChanged();
          }}
        />
      )}
      {refusal !== null ? (
        <p className={styles.small}>{TERMS_UPDATE_WITHHELD_TEXT[refusal]}</p>
      ) : (
        <SendTermsUpdate record={record} />
      )}
    </div>
  );
}

function sentColumnsKey(names: ReadonlyArray<string>): string {
  return JSON.stringify(names);
}

function storedSentColumns(
  record: RunnableManagedExchangeRecord,
): Array<string> {
  return (record.exchangeFile.metadata ?? [])
    .filter(sentColumnChoiceOffered)
    .filter(isDisclosedToPartner)
    .map((column) => column.name);
}

/**
 * The column choice, seeded from the stored set: the caller keys it on that
 * set, so a re-read that changes it starts the choice again. `saved` states
 * the stored set is the one this page last saved.
 */
function SentColumnsEditor({
  record,
  runInFlight,
  saved,
  onSaved,
}: {
  record: RunnableManagedExchangeRecord;
  runInFlight: boolean;
  saved: boolean;
  onSaved: (key: string) => void;
}) {
  const columns = record.exchangeFile.metadata ?? [];
  const stored = storedSentColumns(record);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(stored));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const unchanged =
    chosen.size === stored.length && stored.every((name) => chosen.has(name));
  const shownStatus =
    status ?? (saved && unchanged ? SENT_COLUMNS_SAVED_TEXT : undefined);

  function toggle(name: string, sent: boolean): void {
    const next = new Set(chosen);
    if (sent) next.add(name);
    else next.delete(name);
    setChosen(next);
    setStatus(undefined);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setStatus(undefined);
    const sent = columns
      .filter((column) => chosen.has(column.name))
      .map((column) => column.name);
    try {
      await saveManagedSentColumns(record.id, sent);
      onSaved(sentColumnsKey(sent));
    } catch (error) {
      whenDiagnostic(() => console.error(error));
      setStatus(sentColumnsFailureText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className={styles.fieldset}>
      <legend>{SENT_COLUMNS_LABEL}</legend>
      <p className={styles.small}>{SENT_COLUMNS_TEXT}</p>
      <Stack gap="xs" mt="xs">
        {columns.map((column) =>
          sentColumnChoiceOffered(column) ? (
            <Checkbox
              key={column.name}
              label={<ColumnName name={column.name} />}
              checked={chosen.has(column.name)}
              onChange={(event) =>
                toggle(column.name, event.currentTarget.checked)
              }
            />
          ) : (
            <Checkbox
              key={column.name}
              label={<ColumnName name={column.name} />}
              description={fixedColumnNote(column)}
              checked={isDisclosedToPartner(column)}
              disabled
              readOnly
            />
          ),
        )}
      </Stack>
      <Button
        mt="sm"
        variant="default"
        loading={busy}
        disabled={unchanged || runInFlight}
        onClick={() => void save()}
      >
        {SAVE_SENT_COLUMNS_LABEL}
      </Button>
      {shownStatus !== undefined && (
        <p className={styles.small} role="status">
          {shownStatus}
        </p>
      )}
    </fieldset>
  );
}

function SendTermsUpdate({
  record,
}: {
  record: RunnableManagedExchangeRecord;
}) {
  const [made, setMade] = useState<{
    record: RunnableManagedExchangeRecord;
    update: string;
  }>();
  const [failed, setFailed] = useState<{
    record: RunnableManagedExchangeRecord;
    message: string;
  }>();

  async function make(): Promise<void> {
    setMade(undefined);
    setFailed(undefined);
    try {
      setMade({ record, update: await makeManagedTermsUpdate(record) });
    } catch (error) {
      whenDiagnostic(() => console.error(error));
      setFailed({
        record,
        message:
          error instanceof ManagedTermsUpdateRefusedError
            ? TERMS_UPDATE_WITHHELD_TEXT[error.refusal]
            : TERMS_UPDATE_NOT_MADE_TEXT,
      });
    }
  }

  return (
    <div>
      <p className={styles.calloutLead}>{SEND_TERMS_UPDATE_LABEL}</p>
      <p className={styles.small}>{SEND_TERMS_UPDATE_TEXT}</p>
      <Button variant="default" onClick={() => void make()}>
        {MAKE_TERMS_UPDATE_LABEL}
      </Button>
      {failed?.record === record && (
        <p className={styles.small}>{failed.message}</p>
      )}
      {made?.record === record && (
        <CopyRow
          label={TERMS_UPDATE_COPY_LABEL}
          hint={TERMS_UPDATE_COPY_HINT}
          value={made.update}
        />
      )}
    </div>
  );
}
