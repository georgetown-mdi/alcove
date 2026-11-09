import { describe, expect, test } from "vitest";

import * as inviterEditorModule from "@psi/inviterEditor";
import { buildAdvancedTerms } from "@psi/authoring/advancedInvite";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";

const {
  editorFromCsv,
  editorWithAlgorithm,
  editorWithAuthoredDraft,
  editorWithBuiltInKeys,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithConfigurationCleaning,
  editorWithDeduplicate,
  editorWithFieldAdded,
  editorWithFieldCleaningSettings,
  editorWithFieldInput,
  editorWithFieldRemoved,
  editorWithFieldSteps,
  editorWithIdentity,
  editorWithImportedTerms,
  editorWithIncludeMatchingKey,
  editorWithIncludeOwnColumns,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithLegalAgreement,
  editorWithLifetime,
  editorWithLinkageStrategy,
  editorWithOutputDirection,
  editorWithPastedConfiguration,
  editorWithPrecisionFloorSelection,
  editorWithRecommendedCleaning,
  editorWithTransport,
  sealEditor,
} = inviterEditorModule;

const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 1024,
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      ssn4: "1234",
      program_code: "A",
    },
  ],
  columns: [
    "client_id",
    "first_name",
    "last_name",
    "dob",
    "ssn4",
    "program_code",
  ],
  rowCount: 1,
};

type MutatorResult = InviterEditor | { editor: InviterEditor };

function firstOutput(editor: InviterEditor): string {
  return editor.draft.standardization[0].output;
}

// One call per exported `editorWith*` mutator, each with arguments that
// change an unsealed editor.
const CALLS: Record<string, (editor: InviterEditor) => MutatorResult> = {
  editorWithIdentity: (editor) => editorWithIdentity(editor, "Lee"),
  editorWithLifetime: (editor) => editorWithLifetime(editor, 3600),
  editorWithOutputDirection: (editor) =>
    editorWithOutputDirection(editor, "inviter"),
  editorWithTransport: (editor) => editorWithTransport(editor, "sftp"),
  editorWithAuthoredDraft: (editor) =>
    editorWithAuthoredDraft(editor, editor.draft),
  editorWithKeyEnabled: (editor) => editorWithKeyEnabled(editor, 0, false),
  editorWithPrecisionFloorSelection: (editor) =>
    editorWithPrecisionFloorSelection(editor, { floor: 99 }),
  editorWithBuiltInKeys: (editor) => editorWithBuiltInKeys(editor, csv),
  editorWithKeyMoved: (editor) => editorWithKeyMoved(editor, 0, 1),
  editorWithLinkageStrategy: (editor) =>
    editorWithLinkageStrategy(editor, "single-pass"),
  editorWithLegalAgreement: (editor) =>
    editorWithLegalAgreement(editor, undefined),
  editorWithImportedTerms: (editor) =>
    editorWithImportedTerms(editor, csv, buildAdvancedTerms(editor.draft)),
  editorWithFieldSteps: (editor) =>
    editorWithFieldSteps(editor, firstOutput(editor), []),
  editorWithFieldCleaningSettings: (editor) =>
    editorWithFieldCleaningSettings(editor, firstOutput(editor), {}),
  editorWithFieldInput: (editor) =>
    editorWithFieldInput(editor, firstOutput(editor), "program_code"),
  editorWithConfigurationCleaning: (editor) =>
    editorWithConfigurationCleaning(editor, editor.draft.standardization),
  editorWithPastedConfiguration: (editor) =>
    editorWithPastedConfiguration(
      editor,
      csv,
      buildAdvancedTerms(editor.draft),
      editor.draft.standardization,
    ),
  editorWithFieldRemoved: (editor) =>
    editorWithFieldRemoved(editor, firstOutput(editor)),
  editorWithFieldAdded: (editor) => editorWithFieldAdded(editor, "last_name"),
  editorWithAlgorithm: (editor) => editorWithAlgorithm(editor, "psi-c"),
  editorWithIncludeOwnColumns: (editor) =>
    editorWithIncludeOwnColumns(editor, "none"),
  editorWithIncludeMatchingKey: (editor) =>
    editorWithIncludeMatchingKey(editor, true),
  editorWithDeduplicate: (editor) => editorWithDeduplicate(editor, true),
  editorWithRecommendedCleaning: (editor) =>
    editorWithRecommendedCleaning(editor, csv),
  editorWithColumnType: (editor) =>
    editorWithColumnType(editor, csv, "ssn4", "other"),
  editorWithColumnDisclosure: (editor) =>
    editorWithColumnDisclosure(editor, csv, "program_code", "payload"),
};

const MUTATOR_NAMES = Object.keys(inviterEditorModule)
  .filter((name) => name.startsWith("editorWith"))
  .sort();

function editorOf(result: MutatorResult): InviterEditor {
  return "draft" in result ? result : result.editor;
}

describe("every inviter editor mutator leaves a sealed editor unchanged", () => {
  test("each exported editorWith* mutator has a call here", () => {
    expect(Object.keys(CALLS).sort()).toEqual(MUTATOR_NAMES);
  });

  test.each(MUTATOR_NAMES)("%s", (name) => {
    const call = CALLS[name];
    const unsealed = editorFromCsv("Dana", csv);
    expect(editorOf(call(unsealed))).not.toBe(unsealed);

    const sealed = sealEditor(unsealed);
    const before = structuredClone(sealed);
    expect(editorOf(call(sealed))).toBe(sealed);
    expect(sealed).toEqual(before);
  });
});
