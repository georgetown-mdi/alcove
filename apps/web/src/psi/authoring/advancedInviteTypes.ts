import type {
  Algorithm,
  BuiltInLinkageRuleSet,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  Output,
  OwnColumnSelection,
  Payload,
  Standardization,
} from "@alcove/core";

/**
 * The data model of the inviter's authoring console: the draft the editor holds,
 * the seed it opens from, and the output-direction mapping. A leaf module, so the
 * draft operations, terms mapping and validation depend on it rather than on each
 * other.
 *
 * The editor authors no fan-out transform step at any strategy, and an imported
 * document holding one is refused at the mint. It authors no payload block, and
 * column metadata goes to the inviter's own `prepareForExchange`, never the token.
 */

/** The per-element fuzzy-comparison expansion (core does not export the bare union). */
export type FuzzyComparison = NonNullable<
  LinkageKeyElement["generateFuzzyComparisons"]
>;

/**
 * What an imported terms document said about its rule set: the set it cited, or
 * that it cited none. Uncited is a state of its own so an uncited import is not
 * given a citation on export. `honoredAtImport` is fixed at import, so a later
 * drop is attributed to an edit rather than to the document.
 */
type ImportedRuleSetCitation =
  | { kind: "cited"; ruleSet: BuiltInLinkageRuleSet; honoredAtImport: boolean }
  | { kind: "uncited" };

/** One linkage key in the editor and whether it is enabled. Array position is
 * match order; a disabled key is dropped from the built terms. Built-in and opt-in
 * keys are not marked apart: ask `isOptInDraftKey`. */
export interface DraftKey {
  key: LinkageKey;
  enabled: boolean;
}

/**
 * Who receives the matched results, from the inviter's point of view: `"both"`,
 * `"inviter"` or `"partner"`. A 3-value choice rather than two booleans, so the
 * "neither party receives" {@link Output} pair has no direction to map to.
 */
export type OutputDirection = "both" | "inviter" | "partner";

/**
 * The date-of-birth input format a server-side profile inferred, keyed by column
 * name. The console holds no rows, so the browser looks the format up here.
 */
export type ProfiledDateInputFormats = ReadonlyMap<string, string>;

/** Map an {@link OutputDirection} to the inviter's {@link Output} pair. */
export function outputForDirection(direction: OutputDirection): Output {
  switch (direction) {
    case "both":
      return { expectsOutput: true, shareWithPartner: true };
    case "inviter":
      return { expectsOutput: true, shareWithPartner: false };
    case "partner":
      return { expectsOutput: false, shareWithPartner: true };
  }
}

/** Inverse of {@link outputForDirection}, for an imported terms set. The schema
 * does not reject the "neither receives" pair (`validateCompatibility` does), so
 * an import could hold it; it maps to `"both"`. */
export function directionForOutput(output: Output): OutputDirection {
  if (output.expectsOutput && output.shareWithPartner) return "both";
  if (output.expectsOutput) return "inviter";
  if (output.shareWithPartner) return "partner";
  return "both";
}

/** The optional legal-agreement block before validation. Free text is
 * NFC-normalized and trimmed by {@link buildAdvancedTerms}; the expiry check is in
 * {@link validateAdvancedInvite}, not the core schema. */
export interface DraftLegalAgreement {
  reference: string;
  purpose: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  expirationDate: string;
}

/** The editor's in-progress state. */
export interface AdvancedInviteDraft {
  identity: string;
  /** Invitation lifetime in seconds, for `generateInvitation`, not the terms.
   * Bounded in {@link validateAdvancedInvite}. */
  lifetimeSeconds: number;
  /** Who receives the matched results, applied to the built terms' `output`. */
  outputDirection: OutputDirection;
  /** The matching algorithm: `psi` reveals matched identifiers, `psi-c` only the
   * count. */
  algorithm: Algorithm;
  /** Whether more than one of the holder's own records may match the same
   * partner record (EXCHANGE_REFERENCE `linkage_terms.deduplicate`). */
  deduplicate: boolean;
  /** How the agreed linkage keys are exchanged (see {@link LinkageStrategy}).
   * `single-pass` discloses the sender's per-key value structure to the receiver,
   * which the control states. */
  linkageStrategy: LinkageStrategy;
  legalAgreement?: DraftLegalAgreement;
  /** The inviter's per-party column metadata. A type edit re-derives the
   * offerable keys ({@link setDraftMetadata}); the disclosure choice governs what
   * the inviter sends. */
  metadata: Metadata;
  /**
   * The inviter's per-party standardization: cleaning steps and the input column
   * bound to each field. Seeded from `inviterDefaultStandardization` so an
   * unedited draft builds byte-identical cross-party terms. Goes to the
   * inviter's own `prepareForExchange`, never the token. */
  standardization: Standardization;
  /**
   * Which of this party's own input columns its result file holds beside the
   * partner's values (local `include_own_columns`). Local only: never in the
   * token, never compared with the partner, and not part of either party's
   * consent.
   */
  includeOwnColumns?: OwnColumnSelection;
  keys: Array<DraftKey>;
  /**
   * An imported terms document's `linkageFields`, held verbatim for round-trip
   * fidelity. Set only by {@link draftFromTerms}.
   */
  importedLinkageFields?: Array<LinkageField>;
  /**
   * An imported terms document's rule-set citation, so
   * {@link buildAdvancedTerms} re-emits what the document claimed. Set by
   * {@link draftFromTerms} on every import. An import narrowed only by disabling
   * keys still builds rules drawn from the document; one with keys edited,
   * reordered or added does not.
   */
  importedRuleSetCitation?: ImportedRuleSetCitation;
  /**
   * Terms settings a configuration opened in the console states that no control
   * here edits, so {@link buildAdvancedTerms} writes them back unchanged. Set
   * only by that load.
   */
  heldTermsSettings?: HeldTermsSettings;
}

/**
 * What {@link AdvancedInviteDraft.heldTermsSettings} holds; field constraints are
 * read from {@link AdvancedInviteDraft.importedLinkageFields} instead.
 */
export interface HeldTermsSettings {
  /** The document's `payload`. */
  payload?: Payload;
}

/** The fixed starting point for an editor session. */
export interface AdvancedInviteSeed {
  /** The auto-derived terms for the file's inferred metadata, the same terms
   * the quick path embeds. */
  terms: LinkageTerms;
  /** The inferred, normalized starting metadata, the grid's reset point. */
  metadata: Metadata;
  /** The inviter's CSV column names. */
  columns: Array<string>;
}

/** The control an editor error is shown beside. */
export type AdvancedField =
  | "identity"
  | "lifetime"
  | "legalReference"
  | "legalPurpose"
  | "legalExpiration"
  | "output"
  | "payload"
  | "keys"
  | "standardization";

/** The result of validating a draft. */
export interface AdvancedValidation {
  /** True only when the draft parses, every non-schema check (lifetime bounds,
   * a future legal-agreement expiry, a column-satisfiable key) passes, and the
   * terms canonically encode. */
  canGenerate: boolean;
  /** The terms, present only when {@link canGenerate}; passed to
   * `generateInvitation` verbatim. */
  terms?: LinkageTerms;
  /** Per-control error messages; an absent field has no error. */
  errors: Partial<Record<AdvancedField, string>>;
}
