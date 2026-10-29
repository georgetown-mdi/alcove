import {
  countOnlyTransmitsColumn,
  decideLinkageTermsVerdict,
  fieldSourceColumnTypes,
  inferMetadataForEveryColumn,
  overlongDisclosedColumnPositions,
  sanitizeForDisplay,
} from "@alcove/core";

import { CSV_DELIMITER_SINGLE_COLUMN_REMEDY } from "@components/csvDelimiterChoice";

import {
  DISCLOSURE_LABELS,
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  disclosureOf,
  hasMultipleIdentifiers,
  normalizeForEditor,
  setColumnDisclosure,
} from "@psi/metadataEditing";

import {
  applyCleaningSettingsOverrides,
  applyInputOverrides,
  applyStepOverrides,
  functionDisplay,
  isMaxPeoplePerValueValid,
  isStepValid,
  refusedCleaningFanOut,
} from "@psi/standardizationAuthoring";

import { defaultStandardizationForRows } from "@psi/authoring/advancedInvite";

import { fieldCleaningCard } from "@psi/authoring/advancedInviteValidation";

import { isSilentEmpty } from "@psi/workers/nonEmptyAggregate";

import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import type {
  CSVRow,
  Displayable,
  LinkageField,
  LinkageKey,
  LinkageKeyFitness,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@alcove/core";

import type {
  CleaningSettings,
  FieldStepOverride,
} from "@psi/standardizationAuthoring";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { FieldValueCoverage } from "@psi/workers/nonEmptyAggregate";
import type { ProfiledDateInputFormats } from "@psi/authoring/advancedInvite";

/**
 * The pure, React-free model behind the acceptor console's "Confirm your columns"
 * step: the verdict, mapper, cleaning-attention, launch-payload, and gate logic are
 * the one tested boundary, keeping the React component thin. No I/O and no state;
 * every consent/verdict semantic reuses the existing logic layer
 * ({@link decideLinkageTermsVerdict},
 * {@link normalizeForEditor}/{@link inferMetadataForEveryColumn},
 * {@link defaultStandardizationForRows}, the override-layering helpers,
 * {@link isStepValid}, {@link hasMultipleIdentifiers}), never a re-derivation.
 *
 * The verdict and the launch payload derive from the SAME `{ metadata, standardization }`
 * pair ({@link acceptorColumnsEditorState} produces it once; {@link acceptorVerdict}
 * and {@link acceptorLaunchPayload} both read it), so the gate the operator sees and
 * the exchange that runs cannot disagree.
 *
 * The acceptor cannot edit fields or keys: they are adopted verbatim from the
 * invitation's `linkageTerms`. Satisfiability is assessed against those exact terms.
 */

/**
 * The acceptor's own parsed CSV, held in console state on a passing parse (instead
 * of discarded): the column list and raw rows the columns step and its verdict
 * consume, plus the file's name and byte size for display. The run package feeds
 * `columns` / `rawRows` straight into the exchange with no re-parse.
 */
export interface AcceptorAcquiredCsv {
  fileName: string;
  sizeBytes: number;
  columns: Array<string>;
  rawRows: Array<CSVRow>;
  /** The file's row total, held explicitly so display surfaces never read
   * `rawRows.length` (the console profiles the count server-side). */
  rowCount: number;
  /** The per-column date-of-birth input layouts a profile inferred
   * ({@link dateInputFormatsForColumns}), set only by sources that profile
   * without rows (the console); when absent, derivations infer the layout from
   * the rows. */
  dateInputFormats?: ProfiledDateInputFormats;
}

/**
 * The acceptor's column-step working state: the seed metadata, plus three
 * override LAYERS (input-column rebinds, authored step edits, and authored
 * cleaning settings) over the standardization derived from the current
 * metadata. Held as layers rather than a whole standardization so the binding
 * is always re-derived and the verdict stays accurate; an empty override map
 * means the effective standardization equals the derived default byte for byte.
 */
export interface AcceptorColumnsState {
  metadata: Metadata;
  /** Per-field input-column overrides, keyed by field name (the transformation
   * `output`). */
  inputOverrides: ReadonlyMap<string, string>;
  /** Per-field authored step overrides, keyed by field name and paired with the
   * input column they were authored against. */
  stepOverrides: ReadonlyMap<string, FieldStepOverride>;
  /** Per-field authored shared-value limit and last-name rule, keyed by field
   * name, each stating both settings whole. */
  settingsOverrides: ReadonlyMap<string, CleaningSettings>;
}

/**
 * The seed metadata for a freshly-acquired file:
 * {@link inferMetadataForEveryColumn} over the file's columns, so a column
 * inference does not recognize is listed as ignored for the operator to declare,
 * normalized for the editor so the collapsed disclosure control is faithful (see
 * {@link normalizeForEditor}). No column starts sent, the record identifier
 * included, so the seed fits a count-only invitation as it is. "Reset to
 * defaults" restores exactly this, and the override layers start empty.
 */
export function acceptorInitialColumnsState(
  columns: Array<string>,
): AcceptorColumnsState {
  // Columns the file step already committed: it read the header, holds the
  // sanitized positions, and refuses an empty name before this seeds.
  return {
    metadata: normalizeForEditor(inferMetadataForEveryColumn(columns, [])),
    inputOverrides: new Map(),
    stepOverrides: new Map(),
    settingsOverrides: new Map(),
  };
}

/**
 * The effective `{ metadata, standardization }` the verdict and the launch consume,
 * derived from {@link AcceptorColumnsState} in a fixed order:
 *
 * 1. The base standardization is the recommended per-type cleaning for the current
 *    metadata, with the date-of-birth input format inferred from the operator's own
 *    rows ({@link defaultStandardizationForRows}) -- so an ISO-dated file is not
 *    parsed as US-format and under-matched.
 * 2. Input-column overrides are applied FIRST, but only the ones that still bind to a
 *    `role: linkage` column of a type the field may read
 *    ({@link fieldSourceColumnTypes}; a stale override is dropped so it
 *    never drives a column the core would refuse).
 * 3. Authored step overrides are applied over that; {@link applyStepOverrides} gates
 *    each on the current input column, so a step authored against the old column is
 *    seen as stale and dropped after a remap rather than silently cleaning a different
 *    column.
 * 4. Authored cleaning settings are applied last
 *    ({@link applyCleaningSettingsOverrides}), replacing the field's default limit
 *    and last-name rule whatever column it reads.
 *
 * The input rebind running before the step layer is critical: it is what makes a
 * post-remap step override stale. With no overrides the result equals the derived
 * default.
 */
export function acceptorColumnsEditorState(
  state: AcceptorColumnsState,
  linkageTerms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
  dateInputFormats?: ProfiledDateInputFormats,
): { metadata: Metadata; standardization: Standardization } {
  const { metadata } = state;
  const fieldByName = new Map(
    linkageTerms.linkageFields.map((field) => [field.name, field]),
  );
  const effectiveInputOverrides = new Map<string, string>();
  for (const [output, column] of state.inputOverrides) {
    const field = fieldByName.get(output);
    if (
      field !== undefined &&
      metadata.some(
        (c) =>
          c.name === column &&
          c.role === "linkage" &&
          fieldSourceColumnTypes(field.type).includes(c.type),
      )
    )
      effectiveInputOverrides.set(output, column);
  }
  const baseStandardization = defaultStandardizationForRows(
    metadata,
    linkageTerms,
    rawRows,
    dateInputFormats,
  );
  const standardization = applyCleaningSettingsOverrides(
    applyStepOverrides(
      applyInputOverrides(
        baseStandardization,
        effectiveInputOverrides,
        linkageTerms.linkageFields,
        metadata,
      ),
      state.stepOverrides,
    ),
    state.settingsOverrides,
  );
  return { metadata, standardization };
}

/** Which of the three verdict states holds. */
type AcceptorVerdictKind = "blocked" | "partial" | "allClear";

/**
 * The verdict view-model: which alert to render, its exact visible title, and the
 * deferred announcement string (worded distinctly from the visible title, per the
 * announcement contract). The dead-key count is included here too, since it is
 * derived from the same satisfiability assessment.
 */
export interface AcceptorVerdictViewModel {
  kind: AcceptorVerdictKind;
  /** The visible alert title, exact per the mockup. */
  title: string;
  /** The number of linkage keys whose columns can all be produced. */
  satisfiableKeyCount: number;
  /** The total number of adopted linkage keys. */
  totalKeys: number;
  /** The spoken announcement for the deferred polite region, distinct from the
   * visible title. Always non-empty (one of the three states always holds). */
  announcement: string;
  /** Shape-satisfiable keys whose declared cleaning can never produce a value (a
   * self-defeating rule in the adopted terms). A count only -- never the
   * partner-controlled key names. */
  deadKeyCount: number;
  /** The delimiter remedy this verdict states beneath its title, or the empty
   * string. Non-empty where the graded read yielded exactly ONE column and the
   * coverage is short: that is the shape a file separated by something other than
   * the delimiter it was read by comes out as, and the delimiter is a control on
   * this screen while the adopted terms this copy otherwise sends the operator to
   * are the partner's. */
  delimiterRemedy: string;
  /** Whether this file may be run under the adopted terms at all: core's own
   * grading, which the launch gate reads rather than re-deriving a threshold from
   * the counts above. `false` on any shortfall -- an unproducible key, a dead one,
   * or terms declaring none. */
  fullySatisfied: boolean;
}

/**
 * The live linkage-terms verdict over the EDITED `{ metadata, standardization }`.
 * Reuses {@link decideLinkageTermsVerdict} against the adopted terms -- never a
 * re-derivation -- and maps its result to the mockup's exact copy and the spoken
 * announcement. Blocked when no key can match, partial when some but not all can,
 * all-clear when every key is covered.
 *
 * The three display kinds are a reading of coverage, not the launch decision: the
 * gate is `fullySatisfied`, core's own, which an all-clear coverage reading can
 * still fail when a covered key's declared cleaning drops every record.
 *
 * A short verdict over a file whose whole header read as one column carries
 * {@link CSV_DELIMITER_SINGLE_COLUMN_REMEDY} as well, for the step to state beside
 * the column mapper: a file read by the wrong delimiter puts every field in that
 * one column, and the remedy for it is this screen's delimiter control rather than
 * a remap or the partner's terms.
 */
export function acceptorVerdict(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): AcceptorVerdictViewModel {
  const verdict = decideLinkageTermsVerdict(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const totalKeys = linkageTerms.linkageKeys.length;
  const satisfiable = verdict.keys.length - verdict.unsatisfiableKeys.length;
  const blocked = satisfiable === 0;
  const partial = satisfiable > 0 && satisfiable < totalKeys;
  const kind: AcceptorVerdictKind = blocked
    ? "blocked"
    : partial
      ? "partial"
      : "allClear";
  const title = blocked
    ? "This file cannot match yet"
    : partial
      ? `${satisfiable} of ${totalKeys} keys can match`
      : `All ${totalKeys} keys can match`;
  const announcement = blocked
    ? "No agreed linkage key can be satisfied by your columns yet."
    : partial
      ? `${satisfiable} of ${totalKeys} linkage keys can be satisfied by your columns.`
      : `All ${totalKeys} linkage keys can be satisfied by your columns.`;
  return {
    kind,
    title,
    satisfiableKeyCount: satisfiable,
    totalKeys,
    announcement,
    deadKeyCount: verdict.deadKeys.length,
    delimiterRemedy:
      kind !== "allClear" && columns.length === 1
        ? CSV_DELIMITER_SINGLE_COLUMN_REMEDY
        : "",
    fullySatisfied: verdict.fullySatisfied,
  };
}

/** One row of the quick-fix mapper: a missing field type and its human label. */
interface AcceptorUnsatisfiedType {
  type: LinkageField["type"];
  label: string;
}

/**
 * The field types the file cannot currently produce, de-duplicated by type (several
 * fields can share a type). `LinkageField["type"]` is a closed semantic-type enum,
 * so its label is safe; the partner-controlled field NAME is never exposed. The
 * quick-fix mapper renders one Select per entry, and ONLY when this list is
 * non-empty.
 */
export function acceptorUnsatisfiedTypes(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): Array<AcceptorUnsatisfiedType> {
  const verdict = decideLinkageTermsVerdict(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const seen = new Map<LinkageField["type"], string>();
  for (const { field } of verdict.unsatisfiedFieldColumns)
    seen.set(field.type, SEMANTIC_TYPE_LABELS[field.type]);
  return [...seen.entries()].map(([type, label]) => ({ type, label }));
}

/**
 * The gates the columns step itself contributes, which the model cannot derive from
 * the terms and the editor state: the transport connection an SFTP accept must have
 * authored, and a file-handling combination core refuses. Passed in so the whole
 * launch chain -- model-side and step-side -- resolves in one place.
 */
interface AcceptorLaunchStepBlocks {
  /** Whether the browser reports no network. Every accept ends in a live
   * two-party session -- in this browser, or on the console -- so an
   * offline device blocks the launch outright. Only this direction is a block:
   * a device reporting online is no promise the partner is reachable (see
   * `apps/web/src/utils/networkStatus.ts`). */
  offline: boolean;
  /** Whether the two parties' `deduplicate` values make a pair the run refuses,
   * read at the review step from the same boundary the run resolves the
   * cardinality at (`acceptorDeduplicateRefusal`). Re-read here because step
   * position is restored from browser history: a Forward past the disabled
   * Continue would otherwise reach this step with the refused value and launch
   * it. Cleared on the review step alone, which holds the control. */
  deduplicatePairRefused: boolean;
  /** Whether this party's own `deduplicate` control stands somewhere other than
   * the value the consent gate committed, which is the one the run presents.
   * Held rather than resolved silently either way: launching would present a
   * value the terms step no longer shows, and adopting the control's value
   * would present one no consent gate passed. */
  deduplicateChangedAfterConsent: boolean;
  /** An SFTP accept whose transport connection is not authored yet. */
  connectionBlocked: boolean;
  /** A file-handling combination core refuses. */
  exchangeFilesBlocked: boolean;
  /** A connection-tuning value the run would refuse. Separate from
   * {@link exchangeFilesBlocked} because the two are separate cards: folding them
   * together would send the operator to the wrong one. */
  connectionTuningBlocked: boolean;
  /** An unconfirmed recovery sweep on the diagnostics-and-recovery card. A third
   * separate card, gated separately for the same reason. */
  runDiagnosticsBlocked: boolean;
  /** A receipt-signing or retention choice the run itself would refuse. A fourth
   * separate card, gated separately for the same reason. */
  receiptsBlocked: boolean;
  /** The requirement a split rendezvous makes of the file-handling choices, in the
   * console's own words, or undefined when it is met. Held as its own SENTENCE
   * rather than a flag, because the remedy is the one control to turn on and the
   * blocked-launch line is where the operator meets it. */
  splitDirectoryProblem?: string;
  /** Why the signing identity and the name these terms state diverge, in the
   * console's own words, or undefined when they agree or nothing signs. Its own
   * SENTENCE for the reason above, and a sharper one: neither remedy is a
   * control on this screen -- one is the name committed at the consent gate, the
   * other a re-key at the command line. */
  signingIdentityDivergence?: string;
}

const NO_STEP_BLOCKS: AcceptorLaunchStepBlocks = {
  offline: false,
  deduplicatePairRefused: false,
  deduplicateChangedAfterConsent: false,
  connectionBlocked: false,
  exchangeFilesBlocked: false,
  connectionTuningBlocked: false,
  runDiagnosticsBlocked: false,
  receiptsBlocked: false,
};

/**
 * The launch gate's sentence, exactly as the step renders it beside the disabled
 * button and points its `aria-describedby` at -- `undefined` exactly when nothing
 * blocks, which is what the step disables on. Widened to core's own grading: the
 * file cannot be run under the adopted terms (`verdict.fullySatisfied` is false),
 * a count-only invitation meets a marked column
 * ({@link countOnlyTransmitsColumn}), a marked column's name is too long to fit
 * in the frame ({@link acceptorOverlongDisclosedColumns}), the metadata has
 * more than one identifier column, an authored cleaning step is invalid,
 * mid-edit, or splits a value under terms that refuse one
 * ({@link refusedCleaningFanOut}), a shared-value limit is one the
 * configuration schema refuses ({@link isMaxPeoplePerValueValid}), or one of
 * the step's own blocks holds.
 *
 * The gate and the explanation are ONE derivation, so a state that disables the
 * button while telling a screen-reader operator nothing is unrepresentable.
 *
 * Checks run in the step's own reading order, with the three nothing on this
 * screen clears first: offline, then the refused duplicate-matching pair and a
 * duplicate-matching setting moved since consent, whose control is back on the
 * review step. Then the verdict, the count-only refusal, the over-long name
 * notice, the identifier rule, the cleaning steps, the shared-value limits,
 * the connection, the split rendezvous's retain-mode requirement, and the
 * file-handling and connection-tuning cards -- so an operator working down the
 * screen is sent to the first unresolved card. The signing-identity divergence
 * comes last of all: it is the one reason whose remedies are both off this
 * screen. Each reason is
 * worded from the notice it points at, and none names a partner-controlled key.
 */
export function acceptorLaunchBlockedReason(
  verdict: AcceptorVerdictViewModel,
  editorState: { metadata: Metadata; standardization: Standardization },
  invitationTerms: LinkageTerms,
  stepBlocks: AcceptorLaunchStepBlocks = NO_STEP_BLOCKS,
): string | undefined {
  if (stepBlocks.offline) return OFFLINE_EXCHANGE_REASON;
  if (stepBlocks.deduplicatePairRefused)
    return (
      "Go back to the terms and resolve the duplicate-matching settings " +
      "before you can start."
    );
  if (stepBlocks.deduplicateChangedAfterConsent)
    return (
      "This exchange runs with the duplicate-matching setting you accepted, " +
      "which is not the one now on the terms step. Accept again to apply the " +
      "change, or set the control back."
    );
  if (!verdict.fullySatisfied) {
    if (verdict.satisfiableKeyCount === 0)
      return "Set your columns to the missing field types above before you can start.";
    if (verdict.satisfiableKeyCount < verdict.totalKeys)
      return (
        "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree on terms with your partner over the keys both files can supply."
      );
    return (
      "Ask your partner for a corrected invitation before you can start: " +
      "cleaning declared in the agreed terms drops every record for a key, so " +
      "it can never match."
    );
  }
  // A count-only exchange holds no data column in either direction whichever
  // party the terms entitle to the count, so a marked column is refused here
  // whatever the invitation's expected list says. Core's own refusal at accept
  // enforces the same fact (`assertCountOnlyTransmitsNoColumn`).
  if (countOnlyTransmitsColumn(invitationTerms.algorithm, editorState.metadata))
    return "Unmark the columns you send above before you can start: a count-only exchange sends none.";
  const overlong = acceptorOverlongDisclosedColumns(
    invitationTerms,
    editorState.metadata,
  );
  if (overlong.length > 0)
    return overlong.length === 1
      ? "Resolve the column name that is too long to send above before you can start."
      : "Resolve the column names that are too long to send above before you can start.";
  if (hasMultipleIdentifiers(editorState.metadata))
    return "Choose a single record identifier column above before you can start.";
  if (!acceptorStandardizationValid(editorState.standardization))
    return "Finish, fix, or remove the highlighted cleaning steps above before you can start.";
  const overLimit = editorState.standardization.find(
    (transformation) =>
      !isMaxPeoplePerValueValid(transformation.maxPeoplePerValue),
  );
  if (overLimit !== undefined) {
    const fieldType = invitationTerms.linkageFields.find(
      (field) => field.name === overLimit.output,
    )?.type;
    return (
      "Fix or clear the highlighted limit on people sharing one value in " +
      `${fieldCleaningCard(fieldType)} above before you can start.`
    );
  }
  const refusedFanOut = refusedCleaningFanOut(
    invitationTerms,
    editorState.standardization,
  );
  if (refusedFanOut !== undefined)
    return (
      (invitationTerms.algorithm === "psi-c"
        ? "Your partner chose a count-only exchange, which matches"
        : "Your partner chose a linkage strategy that matches") +
      " one value per record, so remove the " +
      `${functionDisplay(refusedFanOut.functionName).label} step from your ` +
      "cleaning before you can start."
    );
  if (stepBlocks.connectionBlocked)
    return "Set up the SFTP connection above before you can start.";
  if (stepBlocks.splitDirectoryProblem !== undefined)
    return stepBlocks.splitDirectoryProblem;
  if (stepBlocks.exchangeFilesBlocked)
    return "Resolve the file-handling settings above before you can start.";
  if (stepBlocks.connectionTuningBlocked)
    return "Resolve the connection-tuning settings above before you can start.";
  if (stepBlocks.runDiagnosticsBlocked)
    return "Resolve the diagnostics-and-recovery settings above before you can start.";
  if (stepBlocks.receiptsBlocked)
    return "Resolve the receipts-and-record-keeping settings above before you can start.";
  if (stepBlocks.signingIdentityDivergence !== undefined)
    return stepBlocks.signingIdentityDivergence;
  return undefined;
}

/** Whether every authored cleaning step is well-formed, gating launch so a
 * malformed pipeline (which core would run as a silent full-field exclusion or throw
 * at compile) never reaches the exchange. Reuses {@link isStepValid}. */
export function acceptorStandardizationValid(
  standardization: Standardization,
): boolean {
  return standardization.every((transformation) =>
    (transformation.steps ?? []).every(isStepValid),
  );
}

/**
 * The launch payload: the edited `{ metadata, standardization }`, the exact shape
 * {@link AcceptorDataEdits} expects. The pair is the SAME one the verdict consumed,
 * so the gate and the run cannot disagree.
 *
 * It includes no coverage advisory: partial coverage stops the launch
 * ({@link acceptorLaunchBlockedReason}), so an exchange that reaches this payload is
 * one whose every agreed key the file can produce, and there is nothing left to warn
 * the run surface about.
 */
export function acceptorLaunchPayload(editorState: {
  metadata: Metadata;
  standardization: Standardization;
}): { edits: AcceptorDataEdits } {
  return {
    edits: {
      metadata: editorState.metadata,
      standardization: editorState.standardization,
    },
  };
}

/** The disclosed columns ("What you will send to your partner"), the same predicate
 * the run transmits on. */
export function acceptorDisclosedColumns(metadata: Metadata): Array<string> {
  return disclosedColumnNames(metadata);
}

/**
 * The 1-based positions of the marked columns whose name is too long to fit in the
 * frame, gated on at launch and named in its own notice. Reuses
 * {@link overlongDisclosedColumnPositions}, the same predicate core's prepare-time
 * refusal reads, so this screen refuses exactly the names the run would -- the
 * acceptor's metadata is seeded by {@link inferMetadataForEveryColumn} over its
 * own header, which no schema bounds, so without this gate an oversized marked header would reach the
 * partner's parse and be refused only after the frame was sent.
 *
 * Empty when the inviting party is entitled to no result: the payload step then
 * transmits nothing whatever the operator marks, so there is no name to bound --
 * and a refusal here would contradict the panel beside it, which states that
 * nothing is sent. The same gate {@link acceptorPayloadDeclarationConflict} applies
 * to the empty declaration, and core's own refusal applies to this bound.
 */
export function acceptorOverlongDisclosedColumns(
  invitationTerms: LinkageTerms,
  metadata: Metadata,
): Array<number> {
  if (!invitationTerms.output.expectsOutput) return [];
  return overlongDisclosedColumnPositions(metadata);
}

/**
 * One column the invitation's declared payload set names that this party's marks do
 * not send -- core's OVER-declaration.
 */
interface AcceptorDeclaredColumnGap {
  /**
   * The declared name as the notice shows it: partner-controlled text, escaped
   * ({@link sanitizeForDisplay}) at this boundary because this view-model IS its
   * display sink -- the step renders the string as given. The operator's own column
   * names in the same notice take the opposite treatment (`ColumnName`'s bidi
   * isolation, applied where they are rendered), so the two provenances stay
   * distinguishable: only the half the operator cannot inspect is escaped.
   */
  displayName: Displayable;
  /**
   * Whether the operator's own file has a column of that name, which is what decides
   * whether marking it to send exists as a remedy at all. Read from the metadata,
   * which holds one entry per column of the chosen file.
   */
  inFile: boolean;
}

/**
 * The disagreement between the payload set the invitation declares for this party
 * and the columns the operator's marks disclose. Core offers the difference to
 * the inviting party as a terms change at run start, an empty declaration
 * included, and an inviter with no way to answer refuses it there before any
 * payload is sent, so the step informs and never holds the launch on it.
 */
interface AcceptorPayloadDeclarationConflict {
  /** The notice's visible title, naming the direction(s) that hold. */
  title: string;
  /**
   * Columns the marks disclose that the declaration does not name -- core's
   * UNDER-declaration. The operator's OWN CSV headers, raw: the step renders them
   * through `ColumnName`, the isolation every column-name sink on that screen uses.
   */
  sentButNotDeclared: Array<string>;
  /**
   * Columns the declaration names that the marks do not send -- core's
   * OVER-declaration, distinct and in the order the declaration first lists them
   * ({@link declaredNotSentNames}). Partner-controlled names
   * ({@link AcceptorDeclaredColumnGap}).
   */
  declaredButNotSent: Array<AcceptorDeclaredColumnGap>;
}

/**
 * The declaration's column names this party's marks do not send, raw and in
 * declaration order -- partner-controlled text, escaped by whichever sink paints it
 * ({@link AcceptorDeclaredColumnGap}). The one derivation of that set: the notice's
 * list, its remedies and its widening offer
 * ({@link acceptorWideningOfferSentence}) read the same names, whole, whatever
 * the notice paints.
 *
 * DISTINCT, keeping each name's first position: a declaration may name the same
 * column twice, which is still one column to list, one to mark and one to speak
 * about, so every consumer counts columns rather than declaration entries.
 */
function declaredNotSentNames(
  invitationTerms: LinkageTerms,
  metadata: Metadata,
): Array<string> {
  const disclosed = new Set(acceptorDisclosedColumns(metadata));
  const declared = new Set(
    (invitationTerms.payload?.receive ?? []).map((column) => column.name),
  );
  return [...declared].filter((name) => !disclosed.has(name));
}

/**
 * The disagreement between the invitation's declared payload set for this party and
 * the operator's marks, or `undefined` when there is nothing to state. It clears
 * as the operator re-marks.
 *
 * An exact-set comparison in both directions, read from the INVITATION's own
 * perspective. An ABSENT `payload.receive` is reconciled against this party's own
 * disclosure when the exchange runs, never compared here.
 *
 * The EMPTY declaration is stated only when the inviting party expects output
 * (`output.expectsOutput`, core's `shareWithPartner` on the mirrored side):
 * when it does not, the run transmits nothing whatever the operator marks, so
 * there is nothing to conflict with. `LinkageTermsSchema` refuses a non-empty
 * `payload.receive` alongside `expectsOutput: false`
 * (packages/core/test/config/linkageTermsSchema.test.ts), so that combination
 * never reaches this step.
 */
export function acceptorPayloadDeclarationConflict(
  invitationTerms: LinkageTerms,
  metadata: Metadata,
): AcceptorPayloadDeclarationConflict | undefined {
  const declared = invitationTerms.payload?.receive;
  if (declared === undefined) return undefined;
  if (declared.length === 0 && !invitationTerms.output.expectsOutput)
    return undefined;
  const declaredNames = declared.map((column) => column.name);
  const disclosed = acceptorDisclosedColumns(metadata);
  const declaredSet = new Set(declaredNames);
  const sentButNotDeclared = disclosed.filter((name) => !declaredSet.has(name));
  const declaredButNotSent = declaredNotSentNames(
    invitationTerms,
    metadata,
  ).map((name) => ({
    displayName: sanitizeForDisplay(name),
    inFile: metadata.some((column) => column.name === name),
  }));
  if (sentButNotDeclared.length === 0 && declaredButNotSent.length === 0)
    return undefined;
  return {
    title: declarationConflictTitle(
      declaredNames.length === 0,
      sentButNotDeclared.length,
      declaredButNotSent.length,
    ),
    sentButNotDeclared,
    declaredButNotSent,
  };
}

/** The conflict notice's title, naming the direction(s) that actually hold. */
function declarationConflictTitle(
  declaresNothing: boolean,
  sentButNotDeclaredCount: number,
  declaredButNotSentCount: number,
): string {
  if (declaresNothing)
    return "Your partner's invitation lists no columns to receive";
  if (declaredButNotSentCount === 0)
    return sentButNotDeclaredCount === 1
      ? "Your partner's invitation does not list this column"
      : "Your partner's invitation does not list these columns";
  if (sentButNotDeclaredCount === 0)
    return declaredButNotSentCount === 1
      ? "Your partner's invitation lists a column you are not sending"
      : "Your partner's invitation lists columns you are not sending";
  return "Your columns differ from your partner's invitation";
}

/**
 * The columns the notice's widening offer would mark: the declared names this
 * party's marks do not send that the operator's file HAS, distinct and in
 * declaration order ({@link declaredNotSentNames}).
 */
function widenableDeclaredColumns(
  linkageTerms: LinkageTerms,
  metadata: Metadata,
): Array<string> {
  return declaredNotSentNames(linkageTerms, metadata).filter((name) =>
    metadata.some((column) => column.name === name),
  );
}

/**
 * The choice the notice's widening offer sets a column to: a column the file
 * matches on takes `match-sent`, so it keeps the agreed keys it feeds; the
 * file's one record identifier takes `identifier-sent`, so it stays the
 * identifier its own result file begins with; any other column takes
 * `payload`. While the marks hold more than one identifier
 * ({@link hasMultipleIdentifiers}) no column is the record identifier, so an
 * identifier column takes `payload`.
 */
function widenedDisclosure(
  metadata: Metadata,
  name: string,
): "match-sent" | "identifier-sent" | "payload" {
  const role = metadata.find((column) => column.name === name)?.role;
  if (role === "linkage") return "match-sent";
  if (role === "identifier" && !hasMultipleIdentifiers(metadata))
    return "identifier-sent";
  return "payload";
}

/** The marks after the notice's widening offer is taken: every
 * {@link widenableDeclaredColumns} column set to its {@link widenedDisclosure},
 * through the grid's own edit. At most one column takes `identifier-sent`, and
 * only when it is the sole identifier, so no edit demotes another identifier,
 * no column the file matches on stops matching, and no column outside the
 * declared set changes. */
export function acceptorWidenedMetadata(
  linkageTerms: LinkageTerms,
  metadata: Metadata,
): Metadata {
  return widenableDeclaredColumns(linkageTerms, metadata).reduce(
    (widened, name) =>
      setColumnDisclosure(widened, name, widenedDisclosure(metadata, name))
        .metadata,
    metadata,
  );
}

/**
 * The notice's widening offer as one sentence, with a leading space, or
 * `undefined` when the file has none of the declared columns it does not send.
 * Counts columns, not declaration entries: a declaration naming one held
 * column twice offers one column.
 * Names the choice {@link acceptorWidenedMetadata} applies to each column, read
 * from the marks it returns.
 */
export function acceptorWideningOfferSentence(
  linkageTerms: LinkageTerms,
  metadata: Metadata,
): string | undefined {
  const widenable = widenableDeclaredColumns(linkageTerms, metadata);
  if (widenable.length === 0) return undefined;
  const label = (choice: DisclosureChoice) => `"${DISCLOSURE_LABELS[choice]}"`;
  const choices = acceptorWidenedMetadata(linkageTerms, metadata)
    .filter((column) => widenable.includes(column.name))
    .map(disclosureOf);
  const one = widenable.length === 1;
  const pronoun = one ? "it" : "them";
  const allInFile =
    declaredNotSentNames(linkageTerms, metadata).length === widenable.length;
  const target = allInFile
    ? pronoun
    : `the ${one ? "one" : "ones"} in your file`;
  const distinct = [...new Set(choices)];
  if (distinct.length === 1)
    return ` To send ${target}, set ${pronoun} to ${label(distinct[0])} below.`;
  const count = (choice: DisclosureChoice) =>
    choices.filter((c) => c === choice).length;
  const settings: Array<string> = [];
  if (count("identifier-sent") > 0)
    settings.push(`your record identifier to ${label("identifier-sent")}`);
  if (count("match-sent") > 0)
    settings.push(
      `${count("match-sent") === 1 ? "the column" : "the columns"} used to match to ${label("match-sent")}`,
    );
  if (count("payload") > 0)
    settings.push(
      `${count("payload") === 1 ? "the other column" : "the other columns"} to ${label("payload")}`,
    );
  return ` To send ${target}, set ${joinClauses(settings)} below.`;
}

/** Two or three clauses joined as one list: "a and b", "a, b, and c". */
function joinClauses(clauses: Array<string>): string {
  if (clauses.length <= 2) return clauses.join(" and ");
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

/** Whether the metadata has more than one identifier column, shown as the
 * identifier-conflict hint and gated on at launch. Reuses
 * {@link hasMultipleIdentifiers}. */
export function acceptorHasIdentifierConflict(metadata: Metadata): boolean {
  return hasMultipleIdentifiers(metadata);
}

/**
 * The Cleaning tab's Customize-menu attention state. The tab keeps its em-dash
 * placeholder until there is a REASON to review cleaning -- a silent-empty field (a transform
 * that drops every row), a dead key (a self-defeating adopted rule), or an
 * invalid/mid-edit step -- then it shows an amber attention value naming the failing
 * field count. The attention value itself decides nothing: what closes the launch is
 * the standardization gate a mid-edit step trips, and the linkage verdict a dead key
 * fails.
 *
 * `rates` is the host's full-CSV coverage (null before the first sweep settles); a
 * pending sweep contributes no silent-empty count -- attention is computed only
 * from a resolved map.
 */
interface AcceptorCleaningAttention {
  /** Whether the tab needs attention (any failing reason present). */
  needsAttention: boolean;
  /** The number of fields failing (silent-empty or invalid), for the amber value.
   * Zero when only a dead key drives attention (dead keys are counted separately and
   * are the partner's to fix). */
  failingFieldCount: number;
  /** The Customize-menu fact string: undefined (em-dash) when no attention is
   * needed, else the amber value naming the reason -- the failing-field count, the
   * dead-key count, or the coverage-unavailable state. */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the effective standardization, the
 * full-CSV coverage, the dead-key count, and whether the coverage sweep failed for
 * good. A field is "failing" when its transform drops every row ({@link isSilentEmpty})
 * or an authored step is invalid; the count de-duplicates by field name. A dead key
 * alone still raises attention (there is a reason to open the tab -- the dead-key
 * advisory renders there) but contributes no failing-FIELD count, since the acceptor
 * cannot fix it. A `coverageUnavailable` sweep (a deterministic coverage failure)
 * raises attention as the lowest-priority reason -- with no field or key count -- so
 * the rail flags that the check could not run rather than staying silent.
 */
export function acceptorCleaningAttention(
  standardization: Standardization,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  deadKeyCount: number,
  coverageUnavailable: boolean,
): AcceptorCleaningAttention {
  const failing = new Set<string>();
  for (const transformation of standardization) {
    const rate = rates?.get(transformation.output);
    const silentEmpty = rate !== undefined && isSilentEmpty(rate);
    const invalid = (transformation.steps ?? []).some(
      (step) => !isStepValid(step),
    );
    if (silentEmpty || invalid) failing.add(transformation.output);
  }
  const failingFieldCount = failing.size;
  const needsAttention =
    failingFieldCount > 0 || deadKeyCount > 0 || coverageUnavailable;
  const railValue = !needsAttention
    ? undefined
    : failingFieldCount > 0
      ? `${failingFieldCount} field${failingFieldCount === 1 ? "" : "s"} failing`
      : deadKeyCount > 0
        ? `${deadKeyCount} key${deadKeyCount === 1 ? "" : "s"} to review`
        : "Coverage unavailable";
  return { needsAttention, failingFieldCount, railValue };
}

/**
 * The note an acceptor whose file cannot cover the agreed keys copies to send
 * the inviter, or undefined while every key is covered. It names each key by
 * the field types its elements draw on -- never a key or field name from the
 * terms, a column header, or a value -- since it leaves this page outside the
 * exchange. Keys naming the same types are listed once with a count.
 */
export function acceptorPartnerNote(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): string | undefined {
  const verdict = decideLinkageTermsVerdict(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const total = verdict.keys.length;
  const supplied = verdict.keys.filter((k) => k.fitness === "satisfiable");
  if (total === 0 || supplied.length === total) return undefined;
  const typeOf = new Map(
    linkageTerms.linkageFields.map((field) => [field.name, field.type]),
  );
  const describe = (key: LinkageKey): string =>
    key.elements
      .map((element) => {
        const type = typeOf.get(element.field);
        return type !== undefined
          ? SEMANTIC_TYPE_LABELS[type]
          : "a field the terms do not declare";
      })
      .join(" + ");
  const listed = (keys: Array<LinkageKey>): Array<string> => {
    const counts = new Map<string, number>();
    for (const key of keys) {
      const text = describe(key);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return [...counts].map(
      ([text, count]) => `- ${text}${count > 1 ? ` (${count} keys)` : ""}`,
    );
  };
  const ofFitness = (fitness: LinkageKeyFitness) =>
    verdict.keys.filter((k) => k.fitness === fitness).map((k) => k.key);
  const unsatisfiable = ofFitness("unsatisfiable");
  const dead = ofFitness("dead");
  const lines = [
    "About the Alcove invitation you sent me:",
    "",
    supplied.length === 0
      ? `My file cannot supply any of the ${total} agreed linkage keys.`
      : `My file can supply ${supplied.length} of the ${total} agreed linkage keys.`,
  ];
  if (supplied.length > 0)
    lines.push(
      "",
      "Keys my file can supply:",
      ...listed(supplied.map((k) => k.key)),
    );
  if (unsatisfiable.length > 0)
    lines.push("", "Keys my file cannot supply:", ...listed(unsatisfiable));
  if (dead.length > 0)
    lines.push(
      "",
      "Keys whose agreed cleaning removes every value:",
      ...listed(dead),
    );
  const missing = [
    ...new Set(
      verdict.unsatisfiedFieldColumns.map(
        ({ field }) => SEMANTIC_TYPE_LABELS[field.type],
      ),
    ),
  ];
  if (missing.length > 0)
    lines.push("", `Field types my file does not have: ${missing.join(", ")}.`);
  lines.push(
    "",
    supplied.length === 0
      ? "Could you send a new invitation with keys built from field types my file has?"
      : "Could you send a new invitation that uses only the keys my file can supply?",
  );
  return lines.join("\n");
}
