import { Alert, Checkbox, NativeSelect, Textarea } from "@mantine/core";

import {
  CSV_DELIMITER_LOCAL_NOTICE,
  CsvDelimiterField,
} from "@components/CsvDelimiterField";
import {
  MATCHING_KEY_DESCRIPTION,
  MATCHING_KEY_LABEL,
  MATCHING_KEY_STORED_WITHHELD_COPY,
} from "@psi/matchingKeyModel";
import { OWN_COLUMNS_LABELS, OWN_COLUMNS_ORDER } from "@psi/ownColumnsModel";
import { RETENTION_NOTE_LABEL } from "@psi/receiptsModel";
import { AllowedRelaysField } from "@components/AllowedRelaysField";

import styles from "@styles/app.module.css";

import {
  NO_ALLOWED_RELAY_NOTE,
  REMOVE_ALLOWED_RELAYS_DESCRIPTION,
  REMOVE_ALLOWED_RELAYS_LABEL,
  delimiterRecheckNote,
} from "./localDocumentFieldsModel";

import type { LocalFieldsDraft } from "./useLocalFieldsDraft";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

/** What the own-columns and matched-key controls say they do and do not
 * change. */
const RESULT_FILE_STORED_NOTICE =
  "This changes only the result file written for you. Your partner is sent " +
  "nothing extra, and their own result file is untouched.";

/**
 * The controls for the five settings of a stored exchange's document that
 * are this party's alone: which of its own columns its result file holds (only
 * where the terms give it a result file), whether that file names the key each
 * match was made on (shown disabled, with the reason, where the terms leave no
 * key to name), how its input file separates fields, the retention note
 * filed with its exchange record, and the relays its runs may use (only on a
 * webrtc connection). Each starts on the value the stored document holds.
 * Presentational over the draft ({@link useLocalFieldsDraft}); the surface
 * saves the draft's edits with its own.
 *
 * A changed separator re-reads the stored input file, where there is one, and
 * what the read found is stated under the control. A document holding allowed
 * relays, an empty list included, is offered a control that removes them on
 * save. `allowedRelaysScope`, where given, states under the relays what they
 * decide for the runs that read them.
 */
export function LocalDocumentFields({
  draft,
  allowedRelaysScope,
}: {
  draft: Pick<
    LocalFieldsDraft,
    | "ownColumns"
    | "ownColumnsOffered"
    | "editOwnColumns"
    | "matchingKey"
    | "matchingKeyWithheld"
    | "editMatchingKey"
    | "delimiter"
    | "editDelimiter"
    | "delimiterRecheck"
    | "retentionNote"
    | "editRetentionNote"
    | "retentionError"
    | "allowedRelays"
    | "allowedRelaysOffered"
    | "allowsNoRelay"
    | "editAllowedRelays"
    | "allowedRelaysRemovable"
    | "removeAllowedRelays"
    | "editRemoveAllowedRelays"
    | "allowedRelaysError"
  >;
  allowedRelaysScope?: string;
}) {
  const recheckNote =
    draft.delimiterRecheck === undefined
      ? undefined
      : delimiterRecheckNote(draft.delimiterRecheck);
  return (
    <>
      {draft.ownColumnsOffered && (
        <NativeSelect
          label="Your own columns in your result file"
          description={RESULT_FILE_STORED_NOTICE}
          value={draft.ownColumns}
          data={OWN_COLUMNS_ORDER.map((option) => ({
            value: option,
            label: OWN_COLUMNS_LABELS[option],
          }))}
          onChange={(event) =>
            draft.editOwnColumns(event.currentTarget.value as OwnColumnsChoice)
          }
          mt="sm"
        />
      )}
      <Checkbox
        label={MATCHING_KEY_LABEL}
        description={MATCHING_KEY_DESCRIPTION}
        checked={draft.matchingKeyWithheld === undefined && draft.matchingKey}
        disabled={draft.matchingKeyWithheld !== undefined}
        onChange={(event) => draft.editMatchingKey(event.currentTarget.checked)}
        mt="sm"
      />
      <p className={`${styles.small} ${styles.sub}`}>
        {draft.matchingKeyWithheld !== undefined
          ? MATCHING_KEY_STORED_WITHHELD_COPY[draft.matchingKeyWithheld]
          : RESULT_FILE_STORED_NOTICE}
      </p>
      <CsvDelimiterField
        choice={draft.delimiter}
        onChange={draft.editDelimiter}
        note={CSV_DELIMITER_LOCAL_NOTICE}
      />
      {draft.delimiterRecheck?.kind === "reading" && (
        <p className={`${styles.small} ${styles.sub}`} role="status">
          Reading your input file with this separator...
        </p>
      )}
      {recheckNote !== undefined &&
        (recheckNote.tone === "ok" ? (
          <p className={`${styles.small} ${styles.statusLineOk}`} role="status">
            {recheckNote.message}
          </p>
        ) : (
          <Alert
            color="yellow"
            title="Check this separator"
            mt="sm"
            role="status"
          >
            {recheckNote.message}
          </Alert>
        ))}
      <Textarea
        label={RETENTION_NOTE_LABEL}
        autosize
        minRows={2}
        maxRows={5}
        value={draft.retentionNote}
        error={draft.retentionError}
        onChange={(event) => draft.editRetentionNote(event.currentTarget.value)}
        mt="sm"
      />
      {draft.allowedRelaysOffered && (
        <>
          <AllowedRelaysField
            value={draft.allowedRelays}
            error={draft.allowedRelaysError}
            onChange={draft.editAllowedRelays}
            disabled={draft.allowedRelaysRemovable && draft.removeAllowedRelays}
            mt="sm"
          />
          {draft.allowsNoRelay && (
            <p className={`${styles.small} ${styles.sub}`}>
              {NO_ALLOWED_RELAY_NOTE}
            </p>
          )}
          {draft.allowedRelaysRemovable && (
            <Checkbox
              label={REMOVE_ALLOWED_RELAYS_LABEL}
              description={REMOVE_ALLOWED_RELAYS_DESCRIPTION}
              checked={draft.removeAllowedRelays}
              onChange={(event) =>
                draft.editRemoveAllowedRelays(event.currentTarget.checked)
              }
              mt="sm"
            />
          )}
          {allowedRelaysScope !== undefined && (
            <p className={`${styles.small} ${styles.sub}`}>
              {allowedRelaysScope}
            </p>
          )}
        </>
      )}
    </>
  );
}
