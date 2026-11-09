import { Alert, Button, Checkbox, TextInput } from "@mantine/core";

import { NamedStepNumberInput } from "@components/NamedStepNumberInput";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
} from "@exchange/manageOfferModel";
import {
  MAX_AGE_DAYS_LABEL,
  MAX_AGE_FIELD_NAME,
  MAX_AGE_LABEL,
} from "@psi/receiptsModel";
import styles from "@styles/app.module.css";

import type { LocalFieldsDraft } from "./useLocalFieldsDraft";

/** The label a stored exchange is listed under in this browser, as both
 * saved-exchange editors offer it. */
export function LocalLabelField({ draft }: { draft: LocalFieldsDraft }) {
  return (
    <TextInput
      label="Label"
      description={LABEL_GUIDANCE}
      value={draft.label}
      maxLength={MAX_LABEL_LENGTH}
      error={
        draft.labelValid
          ? undefined
          : `Keep the label to ${MAX_LABEL_LENGTH} characters or fewer.`
      }
      onChange={(event) => draft.editLabel(event.currentTarget.value)}
      mt="sm"
    />
  );
}

/** The max-age policy: whether one applies, and once it does, its days. */
export function MaxAgeFields({ draft }: { draft: LocalFieldsDraft }) {
  return (
    <>
      <Checkbox
        label={MAX_AGE_LABEL}
        checked={draft.maxAgeEnabled}
        onChange={(event) =>
          draft.editMaxAgeEnabled(event.currentTarget.checked)
        }
        mt="sm"
      />
      {draft.maxAgeEnabled && (
        <NamedStepNumberInput
          label={MAX_AGE_DAYS_LABEL}
          stepUnit="day"
          fieldName={MAX_AGE_FIELD_NAME}
          value={draft.maxAgeDays}
          min={1}
          max={MAX_TOKEN_MAX_AGE_DAYS}
          step={1}
          allowDecimal={false}
          error={draft.maxAgeError}
          onChange={draft.editMaxAgeDays}
          mt="xs"
        />
      )}
    </>
  );
}

/** The end of a local-settings form: a failed save's alert, the line a save
 * that took shows, and the Save button. */
export function LocalFieldsSaveFoot({
  draft,
  canSave,
  savedText,
  onSave,
}: {
  draft: LocalFieldsDraft;
  /** Whether the form as entered can be saved. */
  canSave: boolean;
  /** What the form says once a save took. */
  savedText: string;
  onSave: () => void;
}) {
  return (
    <>
      {draft.failed && (
        <Alert
          role="alert"
          color="error"
          title="That could not be saved"
          mt="sm"
          mb="sm"
        >
          These settings were not saved. Nothing changed; try again.
        </Alert>
      )}
      {draft.saved && !draft.failed && (
        <p className={`${styles.small} ${styles.statusLineOk}`}>{savedText}</p>
      )}
      <Button
        mt="sm"
        onClick={onSave}
        loading={draft.saving}
        disabled={!canSave}
      >
        Save settings
      </Button>
    </>
  );
}
