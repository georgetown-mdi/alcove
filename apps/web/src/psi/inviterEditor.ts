/**
 * The pure model behind the inviter spine: seeding the draft from the read
 * file and applying the edits each step offers. No React, no I/O. The draft is
 * the AdvancedInvite model's ({@link AdvancedInviteDraft}); every derivation
 * and edit goes through the same seed/reconcile helpers that model is tested
 * on.
 */

import {
  DEFAULT_PRECISION_FLOOR_SELECTION,
  PRECISION_FLOORS,
  authoredLinkageFields,
  derivedFieldSteps,
  getDefaultLinkageTerms,
  precisionFloorLabel,
} from "@alcove/core";

import { isolatedColumnName } from "@components/ColumnName";

import {
  citationDropFor,
  draftFromTerms,
  draftOffersBuiltInKeys,
  draftWithBuiltInKeys,
  draftWithConfigurationCleaning,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  draftWithPrecisionFloorSelection,
  gradeAuthoredKeys,
  inviterDefaultStandardization,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  validateAdvancedInvite,
} from "./authoring/advancedInvite";

import {
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "./metadataEditing";
import { transformationWithCleaningSettings } from "./standardizationAuthoring";

import { LIFETIME_CHOICES } from "./formatting";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AuthoredKeyGrade,
  CitationDrop,
  CleaningNotLoaded,
  DraftLegalAgreement,
  OutputDirection,
  ProfiledDateInputFormats,
} from "./authoring/advancedInvite";

import type {
  CSVRow,
  LinkageField,
  LinkageKey,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  PrecisionFloorSelection,
  SemanticType,
  Standardization,
} from "@alcove/core";

import type { DisclosureChoice } from "./metadataEditing";

import type { CleaningSettings } from "./standardizationAuthoring";

import type { OwnColumnsChoice } from "./ownColumnsModel";

import type { Transport } from "./transportChooser";

/** The read file the spine works over: identity for the file card plus the
 * parsed rows and columns every derivation binds to. `rowCount` is the file's
 * row total, held explicitly so display surfaces do not read `rawRows.length`
 * (the console acquires only a server-side profile, not the rows).
 * `dateInputFormats` holds the per-column date-of-birth layouts a profile
 * inferred ({@link dateInputFormatsForColumns}), set only by sources that
 * profile without rows (the console); absent, each derivation infers the
 * layout from the rows. */
export interface AcquiredCsv {
  fileName: string;
  sizeBytes: number;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  rowCount: number;
  dateInputFormats?: ProfiledDateInputFormats;
  /** True when this shape holds no rows -- the console acquires a server-side
   * profile, not the file, so `rawRows` is a throwing getter there. The draft
   * reconciliations read rows only to infer the date-of-birth format, which the
   * console supplies in `dateInputFormats`, so a rows-withheld shape contributes an
   * empty row set to those helpers ({@link seedRows}) rather than reading the
   * getter. */
  rowsWithheld?: boolean;
}

/** The rows the draft reconciliations feed to the seed/standardization helpers,
 * whose only use of rows is date-of-birth format inference. A rows-withheld
 * console shape ({@link AcquiredCsv.rowsWithheld}) contributes an empty set,
 * since its `dateInputFormats` were already profiled; a hosted shape contributes
 * its parsed rows. Exported so the expert-mode terms import/export -- the one
 * other `rawRows` consumer -- reads through the same guard. */
export function seedRows(csv: AcquiredCsv): Array<CSVRow> {
  return csv.rowsWithheld === true ? [] : csv.rawRows;
}

/** An editing session over the read file: the live draft and the fixed seed it
 * derived from ({@link seedAdvancedInvite}). Once `sealed`, every mutator in
 * this module returns the session unchanged -- the terms a partner is
 * consenting to can never drift from what was minted. `keysAuthored` marks
 * the key set as author-controlled (an expert edit or an import): a later
 * column edit reconciles the metadata and standardization but leaves the
 * keys untouched. */
export interface InviterEditor {
  draft: AdvancedInviteDraft;
  seed: AdvancedInviteSeed;
  sealed?: boolean;
  keysAuthored?: boolean;
  /** The transport chosen at Review & create ({@link Transport}); defaults to
   * `browser` until the chooser sets it. Survives a trip into a Customize tab
   * and reflects into the ledger and the review answers. */
  transport?: Transport;
}

/** Seal the session at create time; see {@link InviterEditor.sealed}. */
export function sealEditor(editor: InviterEditor): InviterEditor {
  return { ...editor, sealed: true };
}

/** Reopen the session -- the "start over with a fresh invitation" recovery
 * after a failed run. Every input survives (a failure never clears what the
 * operator authored); only the seal lifts, and the invitation it certified is
 * discarded by the caller, so the next create mints a fresh secret. */
export function unsealEditor(editor: InviterEditor): InviterEditor {
  if (editor.sealed !== true) return editor;
  const { sealed: _sealed, ...unsealed } = editor;
  return unsealed;
}

/** Seed the editing session from the read file: default terms derive from
 * the file as soon as it is read. */
export function editorFromCsv(
  inviterName: string,
  csv: AcquiredCsv,
): InviterEditor {
  return seedAdvancedInvite(
    inviterName,
    csv.columns,
    seedRows(csv),
    csv.dateInputFormats,
  );
}

/** Fold a later name edit into the draft without disturbing the derived
 * terms; the identity only labels the terms, it never changes which keys the
 * columns can produce. */
export function editorWithIdentity(
  editor: InviterEditor,
  identity: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, identity } };
}

/** Set the invitation lifetime step 3 offers ({@link LIFETIME_CHOICES}). */
export function editorWithLifetime(
  editor: InviterEditor,
  lifetimeSeconds: number,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, lifetimeSeconds } };
}

/** Set who receives the matched results. */
export function editorWithOutputDirection(
  editor: InviterEditor,
  outputDirection: OutputDirection,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, outputDirection } };
}

/** Set the transport the exchange runs over ({@link Transport}), chosen at
 * Review & create. Editor state so it survives a Customize-tab trip and drives
 * both Create's branch and the ledger/answers How-it-runs rows. */
export function editorWithTransport(
  editor: InviterEditor,
  transport: Transport,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, transport };
}

/** Replace the whole draft -- the expert key editor's change channel. Marks
 * the key set author-controlled, so later column edits stop reconciling it
 * away ({@link InviterEditor.keysAuthored}). */
export function editorWithAuthoredDraft(
  editor: InviterEditor,
  draft: AdvancedInviteDraft,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft, keysAuthored: true };
}

/** Enable or disable the key at `index` in the guided list, keeping a phone,
 * email or ZIP cleaning attached to its key (see {@link draftWithKeyEnabled}). */
export function editorWithKeyEnabled(
  editor: InviterEditor,
  index: number,
  enabled: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: draftWithKeyEnabled(editor.draft, index, enabled),
  };
}

/** Choose the precision floor the guided keys are drawn
 * with, reseeding them from the built-in catalog
 * ({@link draftWithPrecisionFloorSelection}). Returns the session unchanged
 * where its keys were written in the expert editor or loaded from a document
 * ({@link InviterEditor.keysAuthored}): no floor selected those, and reseeding
 * would replace them. */
export function editorWithPrecisionFloorSelection(
  editor: InviterEditor,
  selection: PrecisionFloorSelection,
): InviterEditor {
  if (editor.sealed === true || editor.keysAuthored === true) return editor;
  return {
    ...editor,
    draft: draftWithPrecisionFloorSelection(editor.draft, selection),
  };
}

/** Whether Matching keys offers {@link editorWithBuiltInKeys}: a new
 * invitation for the session's columns would start with a built-in key. */
export function editorOffersBuiltInKeys(editor: InviterEditor): boolean {
  return draftOffersBuiltInKeys(editor.draft);
}

/** Whether Matching keys shows the action that runs
 * {@link editorWithBuiltInKeys}: for keys written in Expert authoring or
 * loaded from a document where the columns supply a built-in key, and not
 * for keys an opened configuration states, which the partner agreed to
 * (`keysFromOpenedConfiguration`, `@exchange/inviterScreenModel`). */
export function editorOffersUseBuiltInRules(
  editor: InviterEditor,
  keysFromOpenedConfiguration: boolean,
): boolean {
  return (
    editor.keysAuthored === true &&
    !keysFromOpenedConfiguration &&
    editorOffersBuiltInKeys(editor)
  );
}

/** The dropped-citation notice for the session ({@link citationDropFor}),
 * naming the Matching keys action only where
 * {@link editorOffersUseBuiltInRules} shows it for the same
 * `keysFromOpenedConfiguration`. */
export function editorCitationDrop(
  editor: InviterEditor,
  keysFromOpenedConfiguration: boolean,
  builtTerms?: LinkageTerms,
): CitationDrop | undefined {
  return citationDropFor(
    editor.draft,
    editor.seed,
    editorOffersUseBuiltInRules(editor, keysFromOpenedConfiguration),
    builtTerms,
  );
}

/** Replace keys written in the expert editor or loaded from a document, with
 * their fields and cleaning, by those a new invitation starts with for the
 * session's columns ({@link draftWithBuiltInKeys}), returning the session to
 * the guided list: the precision floor control applies again, and
 * a later column edit reconciles the keys. Returns the session unchanged
 * where the columns supply no built-in key ({@link editorOffersBuiltInKeys}). */
export function editorWithBuiltInKeys(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true || !editorOffersBuiltInKeys(editor)) return editor;
  const { keysAuthored: _keysAuthored, ...guided } = editor;
  return {
    ...guided,
    draft: draftWithBuiltInKeys(
      editor.draft,
      seedRows(csv),
      csv.dateInputFormats,
    ),
  };
}

/** What Matching keys shows in place of the precision floor
 * control on a session whose keys no floor selected
 * ({@link editorWithPrecisionFloorSelection} refuses there), beside the
 * action that replaces them ({@link editorWithBuiltInKeys}). */
export const AUTHORED_KEYS_FLOOR_NOTE =
  "These keys were written in Expert authoring or loaded from a document, so " +
  "no choice of built-in rules applies to them.";

/** What the confirm before {@link editorWithBuiltInKeys} states. */
export const USE_BUILT_IN_RULES_STATEMENT =
  "This replaces the keys, fields and cleaning with the ones a new " +
  "invitation starts with for your file, all turned on, and sets Built-in " +
  `rules to ${precisionFloorLabel(DEFAULT_PRECISION_FLOOR_SELECTION.floor)}. ` +
  "The invitation will cite the built-in rules. Your columns and other " +
  "settings stay. This cannot be undone.";

/** What Matching keys shows in place of the precision floor
 * control on the console, for keys a run of an opened configuration
 * continues under: the partner holds them, so no action here replaces them. */
export const OPENED_CONFIGURATION_KEYS_NOTE =
  "These keys come from the configuration you opened, which your partner " +
  "agreed to. To change them, edit alcove.yaml and run alcove update, then " +
  "have your partner run alcove apply on what it prints.";

/** What Matching keys tells the reader of a key marked less certain to do to
 * leave it out: turn off the checkbox on its row, or, for keys an opened
 * configuration states, change them with the partner as
 * {@link OPENED_CONFIGURATION_KEYS_NOTE} says. */
export const MATCHING_KEYS_LESS_CERTAIN_REMEDY = {
  checkbox: "To leave one out, turn off its checkbox.",
  openedConfiguration:
    "To leave them out, delete them from linkage_keys in alcove.yaml, run " +
    "alcove update, and have your partner run alcove apply on what it prints.",
} as const;

/** What the key list's help says about its order: the bands the floor
 * selects, in the order the built-in keys list them, or for keys no floor
 * selected, only that they are tried in the order listed. */
export function keyOrderHelp(
  editor: InviterEditor,
  keysFromOpenedConfiguration = false,
): string {
  const selection = editor.draft.precisionFloorSelection;
  if (
    editor.keysAuthored === true ||
    keysFromOpenedConfiguration ||
    selection === undefined
  )
    return (
      "Records are matched on these keys, tried in the order listed, and " +
      "earlier keys match first."
    );
  const lead =
    "Records are matched on these keys, tried in order, and earlier keys " +
    "match first.";
  return selection.floor === PRECISION_FLOORS[0]
    ? `${lead} The built-in keys are only the highest-certainty rules.`
    : `${lead} The built-in keys list the highest-certainty rules first, ` +
        "then the others.";
}

/** What a screen reader hears after a precision floor choice
 * reseeds the guided keys: how many the list shows and how many are on. */
export function guidedKeysAnnouncement(editor: InviterEditor): string {
  const count = editor.draft.keys.length;
  if (count === 0) return "The key list shows no built-in rules.";
  const on = enabledKeys(editor.draft).length;
  return (
    `The key list shows ${String(count)} built-in ` +
    `${count === 1 ? "rule" : "rules"} your file supplies, ` +
    `${on === count ? "all" : String(on)} turned on.`
  );
}

/** Move the key at `index` one place earlier (`-1`) or later (`+1`); a move
 * past either end is a no-op. Key order is match order, so this is the guided
 * list's reorder control. */
export function editorWithKeyMoved(
  editor: InviterEditor,
  index: number,
  offset: -1 | 1,
): InviterEditor {
  if (editor.sealed === true) return editor;
  const target = index + offset;
  if (target < 0 || target >= editor.draft.keys.length) return editor;
  const keys = [...editor.draft.keys];
  [keys[index], keys[target]] = [keys[target], keys[index]];
  return { ...editor, draft: { ...editor.draft, keys } };
}

/** Set how the agreed keys are exchanged (cascade or single-pass). */
export function editorWithLinkageStrategy(
  editor: InviterEditor,
  linkageStrategy: LinkageStrategy,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, linkageStrategy } };
}

/** Attach, edit, or (with `undefined`) detach the legal agreement. */
export function editorWithLegalAgreement(
  editor: InviterEditor,
  legalAgreement: DraftLegalAgreement | undefined,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, legalAgreement } };
}

/** Load an imported, validated terms document into the session, keeping the
 * inviter's own columns, lifetime, and own-columns choice -- all three are
 * per-party and local, so no terms document states them and an import leaves
 * them where the operator set them. An unsupplyable imported key arrives
 * disabled, never dropped ({@link draftFromTerms}). Imported
 * keys are author-controlled.
 *
 * `metadata` is the column set the import binds against and the draft opens
 * on, for a caller holding roles the file's headers alone do not give -- a
 * configuration opened from the console's mount. The seed's own inference is
 * the default, and stays the grid's reset anchor either way. */
export function editorWithImportedTerms(
  editor: InviterEditor,
  csv: AcquiredCsv,
  terms: LinkageTerms,
  metadata: Metadata = editor.seed.metadata,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: draftFromTerms(
      terms,
      { ...editor.seed, metadata },
      editor.draft.lifetimeSeconds,
      seedRows(csv),
      csv.dateInputFormats,
      editor.draft.includeOwnColumns,
      editor.draft.includeMatchingKey,
    ),
    keysAuthored: true,
  };
}

/** Set one cleaned field's ordered steps. */
export function editorWithFieldSteps(
  editor: InviterEditor,
  output: string,
  steps: AdvancedInviteDraft["standardization"][number]["steps"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.map((transformation) =>
        transformation.output === output
          ? { ...transformation, steps }
          : transformation,
      ),
    },
  };
}

/** Set one cleaned field's shared-value limit and last-name rule, removing
 * either one `settings` leaves out. */
export function editorWithFieldCleaningSettings(
  editor: InviterEditor,
  output: string,
  settings: CleaningSettings,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.map((transformation) =>
        transformation.output === output
          ? transformationWithCleaningSettings(transformation, settings)
          : transformation,
      ),
    },
  };
}

/** Rebind a cleaned field to a different input column. A field bound to a
 * column it is derived from (`ssn4` from an `ssn` column) takes the default
 * steps that derive it, since steps written for its own type could emit the
 * whole source value. */
export function editorWithFieldInput(
  editor: InviterEditor,
  output: string,
  input: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  const rebound = editor.draft.standardization.map((transformation) =>
    transformation.output === output
      ? { ...transformation, input }
      : transformation,
  );
  const fieldType = authoredLinkageFields(editor.draft.metadata, rebound).find(
    (field) => field.name === output,
  )?.type;
  const columnType = editor.draft.metadata.find(
    (column) => column.name === input,
  )?.type;
  const steps =
    fieldType === undefined || columnType === undefined
      ? undefined
      : derivedFieldSteps(fieldType, columnType);
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization:
        steps === undefined
          ? rebound
          : rebound.map((transformation) =>
              transformation.output === output
                ? { ...transformation, steps }
                : transformation,
            ),
    },
  };
}

/**
 * Load a configuration's `standardization` block onto a just-imported draft
 * ({@link draftWithConfigurationCleaning}); an absent block leaves the draft's
 * cleaning as the import built it. Returns each transformation that did not
 * load, so the caller names it rather than dropping it unseen.
 */
export function editorWithConfigurationCleaning(
  editor: InviterEditor,
  standardization: Standardization | undefined,
): { editor: InviterEditor; notLoaded: Array<CleaningNotLoaded> } {
  if (editor.sealed === true || standardization === undefined)
    return { editor, notLoaded: [] };
  const cleaned = draftWithConfigurationCleaning(editor.draft, standardization);
  return {
    editor: { ...editor, draft: cleaned.draft },
    notLoaded: cleaned.notLoaded,
  };
}

/**
 * Load terms and a configuration's cleaning pasted into the import box,
 * bound against the columns as the operator has set them, so a column edit
 * made before the paste holds across it.
 */
export function editorWithPastedConfiguration(
  editor: InviterEditor,
  csv: AcquiredCsv,
  terms: LinkageTerms,
  standardization: Standardization | undefined,
): { editor: InviterEditor; notLoaded: Array<CleaningNotLoaded> } {
  return editorWithConfigurationCleaning(
    editorWithImportedTerms(editor, csv, terms, editor.draft.metadata),
    standardization,
  );
}

/** Remove an authored same-typed field's transformation. */
export function editorWithFieldRemoved(
  editor: InviterEditor,
  output: string,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: editor.draft.standardization.filter(
        (transformation) => transformation.output !== output,
      ),
    },
  };
}

/** Append a same-typed field via the shared {@link draftWithFieldAdded}. */
export function editorWithFieldAdded(
  editor: InviterEditor,
  type: LinkageField["type"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: draftWithFieldAdded(editor.draft, type) };
}

/** Set the matching algorithm. Ungated -- the exchange honors both members -- so
 * the built terms hold it as authored; a count-only draft outside the shape a
 * count-only run admits blocks generation at {@link validateAdvancedInvite}. */
export function editorWithAlgorithm(
  editor: InviterEditor,
  algorithm: AdvancedInviteDraft["algorithm"],
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, algorithm } };
}

/** Set which of this party's own input columns its result file holds beside the
 * partner's values. `"none"` drops the field rather than storing a value for
 * it, so an operator who turns the setting back off leaves a draft
 * indistinguishable from one that never set it -- the config key's own absent
 * state. */
export function editorWithIncludeOwnColumns(
  editor: InviterEditor,
  choice: OwnColumnsChoice,
): InviterEditor {
  if (editor.sealed === true) return editor;
  if (choice === "none") {
    const { includeOwnColumns: _dropped, ...draft } = editor.draft;
    return { ...editor, draft };
  }
  return { ...editor, draft: { ...editor.draft, includeOwnColumns: choice } };
}

/** Set whether this party's result file ends with the `matched_on_key`
 * column. Off drops the field, as {@link editorWithIncludeOwnColumns} drops
 * `"none"`, so a draft turned back off matches one that never set it. */
export function editorWithIncludeMatchingKey(
  editor: InviterEditor,
  chosen: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  if (!chosen) {
    const { includeMatchingKey: _dropped, ...draft } = editor.draft;
    return { ...editor, draft };
  }
  return { ...editor, draft: { ...editor.draft, includeMatchingKey: true } };
}

/** Set input deduplication. Gated exactly as {@link editorWithAlgorithm}: the
 * build clamps minted terms to no-dedup until the run honors it. */
export function editorWithDeduplicate(
  editor: InviterEditor,
  deduplicate: boolean,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return { ...editor, draft: { ...editor.draft, deduplicate } };
}

/** Restore the recommended cleaning for the current metadata and the keys the
 * draft has turned on -- the cleaning error boundary's recovery, scoped to the
 * cleaning alone. Reading the enabled keys is what keeps the reset from minting
 * a phone, email, street number, ZIP, state or county pipeline whose keys are
 * off, which the terms this draft emits would declare no field for. */
export function editorWithRecommendedCleaning(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: {
      ...editor.draft,
      standardization: inviterDefaultStandardization(
        editor.draft.metadata,
        getDefaultLinkageTerms(editor.draft.identity, editor.draft.metadata),
        enabledKeys(editor.draft),
        seedRows(csv),
        csv.dateInputFormats,
      ),
    },
  };
}

/** The fields a key element may reference, in offer order -- the authored
 * field set, so a second same-typed field is offerable. */
export function declaredFieldsFor(
  draft: AdvancedInviteDraft,
): Array<LinkageField> {
  return authoredLinkageFields(draft.metadata, draft.standardization);
}

/**
 * A per-key verdict for the expert editor's badges: core's own
 * `LinkageKeyFitness`, so a badge reads what the Generate gate, the mint, and
 * the run boundary all grade the key at. Its three outcomes -- `satisfiable`,
 * `unsatisfiable` (an element references a field the columns cannot produce), and
 * `dead` (the columns produce every element field, but an element's declared
 * cleaning can never yield a value) -- are documented on core's type. An
 * `unsatisfiable` verdict names the first field the columns cannot produce.
 */
export type KeyVerdict = AuthoredKeyGrade;

/** The per-key verdict function behind the expert editor's badges
 * ({@link KeyVerdict}). Grades every draft key at once, in declaration order, so
 * the badge index is the draft index. */
export function keySatisfiabilityFor(
  editor: InviterEditor,
): (index: number) => KeyVerdict {
  const grades = gradeAuthoredKeys(
    editor.draft.metadata,
    editor.draft.standardization,
    editor.seed.columns,
    editor.draft.keys.map((entry) => entry.key),
  );
  return (index) => grades[index];
}

/** Discard every edit and re-derive the recommended draft from the file,
 * keeping only the inviter's name -- step 3's "Reset to defaults". */
export function resetToRecommended(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return editorFromCsv(editor.draft.identity, csv);
}

/** Reconcile an existing session onto a re-profiled file whose column set is
 * unchanged: the authored draft (keys, cleaning, disclosure, transport) is kept and
 * the profile-derived date-of-birth formats are threaded back through the keep-keys
 * reconciliation ({@link setDraftMetadataKeepingKeys}), so a re-profile refreshes the
 * file's facts without discarding the operator's customizations. A sealed session is
 * returned unchanged -- its terms are locked. The caller reseeds instead when the
 * columns changed. */
export function editorReprofiled(
  editor: InviterEditor,
  csv: AcquiredCsv,
): InviterEditor {
  if (editor.sealed === true) return editor;
  return {
    ...editor,
    draft: setDraftMetadataKeepingKeys(
      editor.draft,
      editor.draft.metadata,
      seedRows(csv),
      csv.dateInputFormats,
    ),
  };
}

/** The result of a step-2 column edit: the reconciled session plus any
 * identifier columns the single-identifier rule demoted, for the caller to
 * announce. */
interface ColumnEditResult {
  editor: InviterEditor;
  demotedIdentifiers: Array<string>;
}

function withMetadata(
  editor: InviterEditor,
  csv: AcquiredCsv,
  metadata: AdvancedInviteDraft["metadata"],
  demotedIdentifiers: Array<string>,
): ColumnEditResult {
  return {
    editor: {
      ...editor,
      // Reconcile the standardization on every metadata edit, so a column retype
      // re-derives its cleaning and can never leave a stale transformation minting
      // a name/type-mismatched field into the agreed terms. The keysAuthored guard
      // protects only the authored/imported KEY set from the template-driven key
      // reconciliation (setDraftMetadata), never the standardization.
      draft:
        editor.keysAuthored === true
          ? setDraftMetadataKeepingKeys(
              editor.draft,
              metadata,
              seedRows(csv),
              csv.dateInputFormats,
            )
          : setDraftMetadata(
              editor.draft,
              metadata,
              seedRows(csv),
              csv.dateInputFormats,
            ),
    },
    demotedIdentifiers,
  };
}

/** Apply the "Type" select: retype a column, letting the draft reconcile its
 * offerable keys and cleaning against the new metadata. */
export function editorWithColumnType(
  editor: InviterEditor,
  csv: AcquiredCsv,
  columnName: string,
  type: SemanticType,
): ColumnEditResult {
  if (editor.sealed === true) return { editor, demotedIdentifiers: [] };
  const { metadata, demotedIdentifiers } = setColumnType(
    editor.draft.metadata,
    columnName,
    type,
  );
  return withMetadata(editor, csv, metadata, demotedIdentifiers);
}

/** Apply the "How it is used" select: change a column's disclosure choice. */
export function editorWithColumnDisclosure(
  editor: InviterEditor,
  csv: AcquiredCsv,
  columnName: string,
  choice: DisclosureChoice,
): ColumnEditResult {
  if (editor.sealed === true) return { editor, demotedIdentifiers: [] };
  const { metadata, demotedIdentifiers } = setColumnDisclosure(
    editor.draft.metadata,
    columnName,
    choice,
  );
  return withMetadata(editor, csv, metadata, demotedIdentifiers);
}

/**
 * What step 2's polite region says about a {@link ColumnEditResult}'s demoted
 * identifiers. The names are the operator's own CSV headers going into a string
 * sink, so they hold the isolation as characters, the treatment every other
 * column-name sink on the step gives them. Displacing more than one column puts
 * the names in one text block with the separators and the sentence after them;
 * what the isolation does not contain there is stated on `@components/ColumnName`
 * and driven in test/browser/inviterSharing.test.ts.
 */
export function demotionNotice(demoted: ReadonlyArray<string>): string {
  if (demoted.length === 0) return "";
  return `${demoted.map(isolatedColumnName).join(", ")} changed to Ignored - only one column can be the record identifier.`;
}

/** The linkage keys the draft currently authors, in order. */
export function enabledKeys(draft: AdvancedInviteDraft): Array<LinkageKey> {
  return draft.keys.filter((entry) => entry.enabled).map((entry) => entry.key);
}

/** Whether the metadata sits in the two-identifier state the single-identifier
 * rule forbids -- the work column's Problems entry for step 2. */
export function identifierProblem(draft: AdvancedInviteDraft): boolean {
  return hasMultipleIdentifiers(draft.metadata);
}
