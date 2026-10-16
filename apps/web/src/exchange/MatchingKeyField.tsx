import { Checkbox } from "@mantine/core";

import {
  MATCHING_KEY_DESCRIPTION,
  MATCHING_KEY_LABEL,
  MATCHING_KEY_LOCAL_NOTICE,
  MATCHING_KEY_WITHHELD_COPY,
} from "@psi/matchingKeyModel";

import styles from "@styles/app.module.css";

import type { MatchingKeyUnavailableReason } from "@alcove/core";

/**
 * The "Name the linkage key each match was made on" control: whether this
 * party's result file ends with the `matched_on_key` column.
 *
 * Presentational over the choice; the choice goes up through `onChange`. Where
 * the terms being authored cannot write the column (`withheld`), the box is
 * shown unchecked and disabled with the reason, so the operator learns what to
 * change rather than finding the control missing.
 */
export function MatchingKeyField({
  chosen,
  withheld,
  onChange,
}: {
  chosen: boolean;
  withheld: MatchingKeyUnavailableReason | undefined;
  onChange: (chosen: boolean) => void;
}) {
  return (
    <>
      <h2>The key each match was made on</h2>
      <Checkbox
        label={MATCHING_KEY_LABEL}
        description={MATCHING_KEY_DESCRIPTION}
        checked={withheld === undefined && chosen}
        disabled={withheld !== undefined}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <p className={`${styles.small} ${styles.sub}`}>
        {withheld !== undefined
          ? MATCHING_KEY_WITHHELD_COPY[withheld]
          : MATCHING_KEY_LOCAL_NOTICE}
      </p>
    </>
  );
}
