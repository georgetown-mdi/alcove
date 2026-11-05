import { useEffect, useRef } from "react";

import { Checkbox, TextInput } from "@mantine/core";

import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from "@alcove/core";

import styles from "@styles/app.module.css";

import type {
  AdvancedValidation,
  DraftLegalAgreement,
} from "@psi/authoring/advancedInvite";
import type { InviterEditor } from "@psi/inviterEditor";

const EMPTY_AGREEMENT: DraftLegalAgreement = {
  reference: "",
  purpose: "",
  expirationDate: "",
};

/** The Attach checkbox's description: what the partner sees of the values. */
export const ATTACH_AGREEMENT_DESCRIPTION =
  "Shown to your partner before they accept";

/**
 * The Legal agreement tab: attach or detach the optional agreement block and
 * author the values the partner's consent step displays: a reference, and a
 * purpose and expiration date left blank when the agreement states none.
 * Validation errors show inline on the field they belong to.
 */
export function AgreementTab({
  editor,
  validation,
  onAgreement,
  onBack,
}: {
  editor: InviterEditor;
  validation: AdvancedValidation;
  onAgreement: (agreement: DraftLegalAgreement | undefined) => void;
  onBack: () => void;
}) {
  const agreement = editor.draft.legalAgreement;
  // No-op when the block is detached (the fields unmount with it), so a
  // batched field patch can never silently re-attach an emptied agreement.
  const set = (patch: Partial<DraftLegalAgreement>) => {
    if (agreement === undefined) return;
    onAgreement({ ...agreement, ...patch });
  };

  // Checking "Attach" reveals the three fields below the checkbox; send a
  // keyboard user into the first one rather than leaving them on the checkbox
  // with no cue the block opened.
  const referenceRef = useRef<HTMLInputElement>(null);
  const wasAttached = useRef(agreement !== undefined);
  useEffect(() => {
    if (!wasAttached.current && agreement !== undefined)
      referenceRef.current?.focus();
    wasAttached.current = agreement !== undefined;
  }, [agreement]);
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"\u2190"} Back to Review &amp; create
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1}>Legal agreement</h1>
      <Checkbox
        label="Attach a legal agreement"
        description={ATTACH_AGREEMENT_DESCRIPTION}
        checked={agreement !== undefined}
        onChange={(event) =>
          onAgreement(event.currentTarget.checked ? EMPTY_AGREEMENT : undefined)
        }
        mt="sm"
      />
      {agreement !== undefined && (
        <>
          <TextInput
            ref={referenceRef}
            label="Agreement reference"
            placeholder="MOU-2025-0042"
            value={agreement.reference}
            maxLength={MAX_NAME_LENGTH}
            error={validation.errors.legalReference}
            errorProps={{ role: "alert" }}
            onChange={(event) => set({ reference: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            label="Purpose of the disclosure"
            placeholder="Program evaluation"
            value={agreement.purpose}
            maxLength={MAX_TEXT_LENGTH}
            error={validation.errors.legalPurpose}
            errorProps={{ role: "alert" }}
            onChange={(event) => set({ purpose: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            type="date"
            label="Expiration date"
            placeholder="YYYY-MM-DD"
            value={agreement.expirationDate}
            error={validation.errors.legalExpiration}
            errorProps={{ role: "alert" }}
            onChange={(event) =>
              set({ expirationDate: event.currentTarget.value })
            }
            mt="md"
            maw={220}
          />
        </>
      )}
    </>
  );
}
