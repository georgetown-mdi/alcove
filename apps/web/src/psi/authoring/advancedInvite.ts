/**
 * The pure data model behind the inviter's authoring console, split by concern
 * across five siblings and re-exported here as the console's single import
 * surface. No React, no I/O.
 *
 * - {@link ./advancedInviteTypes} -- the shared draft/seed types and the
 *   {@link OutputDirection} <-> {@link Output} mapping the others build on.
 * - {@link ./advancedInviteDraft} -- draft-editing operations: seeding, metadata
 *   reconciliation, expert key/element authoring, and import-to-draft.
 * - {@link ./advancedInviteTerms} -- the linkage-terms mapping: a draft to the
 *   {@link LinkageTerms} it represents, and the inviter's own exchange spec.
 * - {@link ./advancedInviteValidation} -- the Generate gate, the import-refusal
 *   messages, and the notice that refuses nothing: a declared default value
 *   the run will not substitute.
 * - {@link ./linkageComparison} -- the key compare taken over draft-side
 *   values, pruning the explicitly-`undefined` optional properties core's
 *   strict canonical equality cannot read. A lint ban keeps the rest of
 *   `apps/web/src` off core's own encoder, so it is the whole surface for that
 *   question.
 */

export type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
  DraftKey,
  DraftLegalAgreement,
  FuzzyComparison,
  OutputDirection,
  ProfiledDateInputFormats,
} from "./advancedInviteTypes";
export { outputForDirection } from "./advancedInviteTypes";
export type { CleaningNotLoaded } from "./advancedInviteDraft";

export {
  addElement,
  addKey,
  dateInputFormatsForColumns,
  defaultStandardizationForRows,
  draftFromTerms,
  draftHasOfferedKeys,
  draftKeysAreBuiltIn,
  draftOffersBuiltInKeys,
  draftWithBuiltInKeys,
  draftWithConfigurationCleaning,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  draftWithPrecisionFloorSelection,
  inferDateInputFormat,
  inviterDefaultStandardization,
  moveElement,
  removeAllKeys,
  removeElement,
  removeKey,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  updateElementAt,
  updateKeyAt,
} from "./advancedInviteDraft";

export type { AuthoredKeyGrade, InviterDataEdits } from "./advancedInviteTerms";
export {
  buildAdvancedTerms,
  gradeAuthoredKeys,
  inviterExchangeDataSpec,
  standardizationForTerms,
} from "./advancedInviteTerms";

export {
  USE_BUILT_IN_RULES_LABEL,
  importedConstraintDivergenceMessage,
  inertCoalesceNotice,
  validateAdvancedInvite,
} from "./advancedInviteValidation";

export { encodeKeyForComparison } from "../linkageComparison";
