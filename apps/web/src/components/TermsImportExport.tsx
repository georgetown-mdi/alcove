import { useState } from "react";

import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  Textarea,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertCircle, IconDownload, IconUpload } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@alcove/core";

import { exportLinkageTerms, importLinkageTerms } from "@psi/linkageTermsIO";
import { importedConstraintDivergenceMessage } from "@psi/authoring/advancedInvite";

import { triggerBlobDownload } from "./blobDownload";

import type {
  AdvancedInviteSeed,
  ProfiledDateInputFormats,
} from "@psi/authoring/advancedInvite";
import type { CSVRow, LinkageTerms, Standardization } from "@alcove/core";

const IMPORT_SUCCESS =
  "Imported. Review the loaded terms before creating the invitation.";

/** The import confirmation, naming each field whose cleaning steps in the
 * pasted configuration were not loaded. The names come from the pasted
 * document, so each is sanitized for display. */
function importConfirmation(notCarried: ReadonlyArray<string>): string {
  if (notCarried.length === 0) return IMPORT_SUCCESS;
  const names = notCarried.map((name) => sanitizeForDisplay(name)).join(", ");
  return (
    `Imported, but the cleaning steps for ${names} were not loaded: these ` +
    "terms declare no such field, or your file has no linkage column with " +
    "the input name the configuration gives. Add those steps on the " +
    "Cleaning tab, and review the loaded terms before creating the invitation."
  );
}

/**
 * Import or export linkage terms as JSON/YAML, for authoring outside the GUI
 * controls. Export writes the snake_case on-disk form (the "exported from the
 * GUI" reference). Import routes through {@link importLinkageTerms} -- which
 * validates through `safeParseLinkageTerms`, the single validation source --
 * then refuses any terms that contain per-field constraints the editor cannot
 * represent and would silently normalize
 * ({@link importedConstraintDivergenceMessage}), so they cannot reach the
 * draft past the GUI's own controls. A rejected import shows a readable,
 * value-free error and leaves the draft untouched. A pasted configuration's
 * cleaning steps load with its terms, and each field whose steps did not load
 * is named.
 */
export function TermsImportExport({
  currentTerms,
  seed,
  rawRows,
  dateInputFormats,
  onImport,
}: {
  /** The terms the current draft represents, for export. */
  currentTerms: LinkageTerms;
  /** The editor seed (inviter columns/metadata), needed to reconstruct what an
   * imported document would generate for the constraint-divergence refusal. */
  seed: AdvancedInviteSeed;
  /** The inviter's parsed rows, the reconstruction's fallback source for the
   * date-format inference when no profiled formats are threaded (the format does
   * not affect the constraint comparison, but the rebuild takes it). */
  rawRows: ReadonlyArray<CSVRow>;
  /** The profiled per-column date-of-birth input formats, threaded so the
   * reconstruction never re-derives them from the rows (the console has none). */
  dateInputFormats?: ProfiledDateInputFormats;
  /** Called with validated terms, and a pasted configuration's cleaning steps,
   * to load into the editor. Returns the outputs of the cleaning steps that
   * were not loaded. */
  onImport: (
    terms: LinkageTerms,
    standardization: Standardization | undefined,
  ) => ReadonlyArray<string>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  // The fields whose cleaning steps the last import did not load; undefined
  // until an import succeeds.
  const [imported, setImported] = useState<ReadonlyArray<string>>();

  const handleImport = () => {
    setImported(undefined);
    const result = importLinkageTerms(text);
    if (!result.success) {
      setError(result.error);
      return;
    }
    // Refuse a document whose per-field constraints the rebuild would silently
    // normalize away (the editor cannot represent custom constraints), which would
    // otherwise generate a different agreement than the document declared.
    const constraintDivergence = importedConstraintDivergenceMessage(
      result.terms,
      seed,
      rawRows,
      dateInputFormats,
    );
    if (constraintDivergence !== undefined) {
      setError(constraintDivergence);
      return;
    }
    setError(undefined);
    setImported(onImport(result.terms, result.standardization));
    // Clear the consumed document so a later Reset + Import cannot silently
    // re-import this now-stale paste (the Import button disables on empty text).
    setText("");
  };

  // A single message for the persistent live region below. Conditionally-mounted
  // alerts are missed by screen readers that only watch regions already in the DOM,
  // so the announcement lives in an always-present region whose content changes.
  const liveMessage =
    error ?? (imported !== undefined ? importConfirmation(imported) : "");

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={600}>
          Import or export
        </Text>
        <Text size="xs" c="dimmed">
          Export the current terms to a JSON or YAML document, or paste one
          below to load it. Everything stays in your browser.
        </Text>
      </div>

      <Group gap="sm">
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={14} aria-hidden />}
          onClick={() =>
            triggerBlobDownload(
              "linkage-terms.json",
              exportLinkageTerms(currentTerms, "json"),
              "application/json",
            )
          }
        >
          Download JSON
        </Button>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={14} aria-hidden />}
          onClick={() =>
            triggerBlobDownload(
              "linkage-terms.yaml",
              exportLinkageTerms(currentTerms, "yaml"),
              "application/yaml",
            )
          }
        >
          Download YAML
        </Button>
      </Group>

      <Textarea
        label="Paste a JSON or YAML linkage-terms document to import"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setImported(undefined);
          setError(undefined);
        }}
        autosize
        minRows={3}
        maxRows={12}
        placeholder="{ ... }"
        styles={{ input: { fontFamily: "monospace" } }}
      />
      {/* Visual-only status; the persistent live region holds the announcement
          at the end so it is not missed when newly mounted. */}
      {error !== undefined && (
        <Alert
          role="alert"
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="Could not import these terms"
        >
          {error}
        </Alert>
      )}
      {imported !== undefined && imported.length > 0 && (
        // A note, not a second live region: the persistent region below
        // announces the same text.
        <Alert
          role="note"
          color="yellow"
          icon={<IconAlertCircle aria-hidden />}
          title="Some cleaning steps were not loaded"
        >
          {importConfirmation(imported)}
        </Alert>
      )}
      {imported !== undefined && imported.length === 0 && (
        // Route through the tuned accessible green (theme.ts STATUS_TEXT.success)
        // rather than a bare c="green": that resolves to green-9, which is only
        // 4.37:1 on the white page, under the WCAG 2.1 AA 1.4.3 text floor.
        <Text size="xs" c="var(--mantine-color-green-light-color)">
          {IMPORT_SUCCESS}
        </Text>
      )}
      <Group>
        <Button
          size="xs"
          leftSection={<IconUpload size={14} aria-hidden />}
          onClick={handleImport}
          disabled={text.trim() === ""}
        >
          Import
        </Button>
      </Group>

      {/* Persistent polite live region: always in the DOM, only its text changes,
          so the import result is announced reliably (the visual alert/text above
          mirror it). */}
      <VisuallyHidden role="status" aria-live="polite">
        {liveMessage}
      </VisuallyHidden>
    </Stack>
  );
}
