import {
  dateFormatComponents,
  DEFAULT_DATE_OUTPUT_FORMAT,
  FAN_OUT_FUNCTION_NAMES,
} from "../standardization.js";
import {
  coalesceSubstitutesConstant,
  CONSENT_VERDICT_PARAM_NAMES,
  gradeElementPipeline,
  parseDateInputDropsEveryRecord,
} from "../linkageSatisfiability.js";
import { displayText } from "../utils/sanitizeForDisplay.js";
import {
  frozenLookupTable,
  frozenLookupTableEntry,
} from "../utils/frozenLookupTable.js";
import { redactAndSanitizeForDisplay } from "../utils/sanitizeErrorForDisplay.js";
import { redactAndDisplayPartyIdentity } from "../records/partyIdentityDisplay.js";

import {
  declaredParamEntries,
  describedTransformParamEntry,
  MAX_DISPLAYED_PARAMS,
} from "../config/transformParamDisplay.js";
import { endpointRequiresRetainedFiles } from "../config/invitation.js";
import type { InvitationToken } from "../config/invitation.js";
import { checkLinkageRuleSetCitation } from "../defaults/builtInLinkageTerms.js";
import type { LinkageRuleSetCitationVerdict } from "../defaults/builtInLinkageTerms.js";
import {
  bothSidedDeduplicateRefused,
  candidateSetIsImplementedForStrategy,
  declaresNoPayloadColumn,
  deduplicateIsImplementedForStrategy,
} from "../linkageTermsPolicy.js";
import { deriveAcceptedLinkageTerms } from "../linkageTermsNegotiation.js";
import { termsDeclareCandidateSet } from "../fanOutFunctions.js";
import { withholdsSenderAssociationTable } from "../psi/link.js";
import type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
  TransformStep,
} from "../config/linkageTermsSchema.js";
import type { Algorithm } from "../types.js";
import type { Displayable } from "../utils/sanitizeForDisplay.js";

/**
 * Label per linkage-field type. `type` is a schema-validated enum, so the
 * labels render verbatim; the field `name` is partner free text and is not
 * shown. Typed {@link Displayable} because a label shares display fields with
 * the sanitized fallback in {@link summarizeKey}.
 */
const FIELD_TYPE_LABELS: Record<LinkageField["type"], Displayable> = {
  first_name: displayText`First name`,
  last_name: displayText`Last name`,
  date_of_birth: displayText`Date of birth`,
  ssn: displayText`Social Security number`,
  ssn4: displayText`Last 4 of Social Security number`,
  phone_number: displayText`Phone number`,
  email_address: displayText`Email address`,
  zip_code: displayText`ZIP code`,
};

/**
 * Compact label per field type for the per-key one-liner
 * ({@link InvitationKeySummary.headerFields}). `ssn4` keeps "(last 4)" because
 * full SSN versus last 4 is a disclosure difference the acceptor must see.
 */
const COMPACT_FIELD_TYPE_LABELS: Record<LinkageField["type"], Displayable> = {
  first_name: displayText`first name`,
  last_name: displayText`last name`,
  date_of_birth: displayText`date of birth`,
  ssn: displayText`SSN`,
  ssn4: displayText`SSN (last 4)`,
  phone_number: displayText`phone`,
  email_address: displayText`email`,
  zip_code: displayText`ZIP`,
};

/**
 * Label per fuzzy-comparison expansion (a schema-validated enum). Each loosens
 * the match and, under `psi`, widens what is disclosed.
 */
const FUZZY_COMPARISON_LABELS: Record<
  NonNullable<LinkageKeyElement["generateFuzzyComparisons"]>,
  string
> = {
  transpositions: "two-digit transpositions",
  edit_distances: "single-character edits",
  adjacent_years: "adjacent years",
  day_month_swaps: "day and month exchanged",
};

/**
 * Description of what each transform function does to matching, keyed by its
 * raw `snake_case` name. A name core does not recognize has no entry and shows
 * as the bare sanitized name. Exported so the coverage test can assert its key
 * set equals {@link STANDARDIZATION_FUNCTION_NAMES} in both directions.
 */
export const TRANSFORM_FUNCTION_GLOSSARY = frozenLookupTable({
  remove_non_ascii:
    "Deletes every character outside the ASCII set before matching -- an accented letter, emoji, or symbol is dropped entirely, not simplified.",
  replace_separators_with_spaces:
    "Turns hyphens, dashes, apostrophes (straight or curly), ampersands, slashes, and underscores into spaces before matching.",
  squash_spaces:
    "Turns every run of whitespace, including tabs, line breaks, and non-breaking spaces, into a single space before matching.",
  remove_punctuation: "Removes punctuation and symbols before matching.",
  remove_dashes: "Removes hyphens before matching.",
  trim_whitespace: "Removes leading and trailing spaces before matching.",
  to_upper_case:
    "Upper-cases the value before matching, so values differing only in letter case can match.",
  to_lower_case:
    "Lower-cases the value before matching, so values differing only in letter case can match.",
  remove_accents:
    "Strips accents and diacritics but keeps the base letter, and spells out letters such as sharp s and O-stroke in ASCII, before matching, so accented and unaccented spellings can match.",
  remove_affixes:
    "Removes name titles (Mr., Dr.) from the start and suffixes (Jr., III) from the end of the name before matching, always keeping at least one word.",
  substring:
    "Matches on only part of the value, not the whole value, so more values can match.",
  parse_date:
    "Reformats the date to a canonical form before matching, so dates written in different formats can match.",
  pad_left:
    "Left-pads the value to a fixed length before matching (e.g. zero-filling a short identifier).",
  phonetic:
    "Matches names by a sound-alike code rather than the literal spelling, so different names that sound alike can match.",
  null_if: "Treats listed values as empty, dropping them from matching.",
  replace_regex:
    "Rewrites the parts of the value matching a pattern before matching.",
  extract_regex:
    "Matches on only the part of the value a pattern captures; a value with no match is dropped.",
  filter_regex:
    "Drops values that do not match a pattern, removing them from matching.",
  split_on:
    "Splits the value into several parts, each able to match " +
    "independently, so a record matches when any one of them does.",
  coalesce:
    "Substitutes a fallback value where an earlier rule left the value empty, " +
    "which can create matches that would not otherwise occur.",
});

/**
 * Description of a `coalesce` that cannot substitute
 * ({@link coalesceSubstitutesConstant} is false): a non-text `default`, a
 * position no emptying rule precedes, or both.
 */
const COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION =
  "Declares a fallback value but substitutes nothing here: a value is replaced " +
  "only where an earlier rule left it empty, and only by a text default. " +
  "Records pass through this step unchanged.";

/** Legal-agreement context, with the partner-controlled free text sanitized. */
export interface InvitationLegalAgreementSummary {
  /** Agreement identifier (e.g. "MOU-2025-0042"), sanitized for display. */
  reference: Displayable;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: Displayable;
  /**
   * ISO 8601 date (YYYY-MM-DD) after which the exchange is refused, sanitized
   * even though the `z.iso` schema already rejects deceptive characters.
   */
  expirationDate: Displayable;
}

/**
 * One half of the inviter's rule-set citation (the field set or the key set),
 * with both strings sanitized.
 *
 * The name and version are the inviter's own declaration, not alcove-vouched
 * provenance: the token is accepted on a transcription checksum.
 * {@link verdict} is this build's own check against the rule sets it ships.
 */
interface InvitationRuleSetIdentitySummary {
  /** The set's declared name, sanitized for display. */
  name: Displayable;
  /** The set's declared content version, sanitized for display. */
  version: Displayable;
  /** This build's check of this half against the rule sets it ships. */
  verdict: LinkageRuleSetCitationVerdict;
}

/**
 * The rule set the inviter cites its fields and keys to. Present only when the
 * invitation declares one; authored terms have none.
 */
export interface InvitationRuleSetSummary {
  /** The set the declared linkage fields are cited to. */
  fieldSet: InvitationRuleSetIdentitySummary;
  /** The set the declared linkage keys are cited to. */
  keySet: InvitationRuleSetIdentitySummary;
}

/** The optional data columns the inviter declares, with names sanitized. */
interface InvitationPayloadSummary {
  /**
   * Columns the inviter sends for matched records, sanitized. Read
   * {@link sendDeclared} to tell empty from lazy.
   */
  send: Array<Displayable>;
  /**
   * Whether the send set is a declaration (an authored `payload.send`, even if
   * empty) rather than lazy (the inviter sends whatever its metadata
   * discloses). A declared empty send is shown as "(none)", since the acceptor
   * mirrors it into its own `payload.receive`. False as well where
   * `output.shareWithPartner` is clear: no column is transmitted then.
   */
  sendDeclared: boolean;
  /**
   * Columns the inviter requests from the acceptor, sanitized. Read
   * {@link receiveDeclared} to tell empty from lazy.
   */
  receive: Array<Displayable>;
  /**
   * Whether the receive set is a declaration (an authored `payload.receive`,
   * even if empty) rather than lazy. A declared empty receive means the
   * acceptor sends nothing (a stated column is refused at the terms exchange)
   * and is shown as "(none)". Mirrors {@link sendDeclared}.
   */
  receiveDeclared: boolean;
}

/**
 * A transform step reduced to display form: the function name and a bounded,
 * sanitized view of its parameters.
 */
interface InvitationTransformSummary {
  /** Sanitized name of the transform function. */
  function: Displayable;
  /**
   * One sanitized `key: value` string per declared parameter, verdict-bearing
   * ones first ({@link orderedParamEntries}), capped at
   * {@link MAX_DISPLAYED_PARAMS} with a trailing "... N more" entry. Decode
   * refuses parameters this view would misstate. What differs at compile is in
   * docs/spec/CHANNEL_SECURITY.md, "Transform-parameter declared types"; the
   * escape format is in "Display sanitization escape format".
   */
  params: Array<Displayable>;
  /**
   * Description from {@link TRANSFORM_FUNCTION_GLOSSARY}; absent for an
   * unrecognized name. A `coalesce` that substitutes nothing takes
   * {@link COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION} instead.
   */
  description?: string;
  /**
   * Literal phrase for a `substring` on a name field ("the first 3
   * characters"). Leads the element's detail and suppresses
   * {@link description}. Absent for a date or other reformatted field, a
   * negative or non-integer slice, or another function. Composed through
   * `displayText`, which admits a number but no partner string.
   */
  effect?: Displayable;
}

/**
 * One linkage-key element: its field and any non-default matching rule (a
 * transform or a fuzzy expansion).
 */
interface InvitationKeyElementSummary {
  /**
   * Fixed label for the field's type, or the sanitized raw name when the
   * reference does not resolve.
   */
  fieldLabel: Displayable;
  /**
   * Transform steps applied before hashing, in order; empty when matched as-is.
   */
  transforms: Array<InvitationTransformSummary>;
  /** Plain-language label for the fuzzy-comparison expansion, if any. */
  fuzzyComparison?: string;
  /**
   * Whether today's exchange applies the fuzzy comparison: the verdict of
   * {@link InvitationSummary.fanOutApplied}, since a count-only exchange
   * refuses the expanded element. Meaningful only with `fuzzyComparison`.
   */
  fuzzyComparisonApplied: boolean;
}

/**
 * A linkage key with the ordered elements and rules that decide which records
 * match and, under `psi`, which identifiers are disclosed.
 */
export interface InvitationKeySummary {
  /**
   * Stable identity for per-key UI state across a reorder: the raw key name,
   * which schema validation makes unique (the sanitized {@link name} can
   * collapse). Never rendered; the web browser suite and the CLI suite fail on
   * any non-printable-ASCII output from hostile terms.
   */
  id: string;
  /** The key's name, sanitized for display. */
  name: Displayable;
  /** Ordered elements combined to form the key. */
  elements: Array<InvitationKeyElementSummary>;
  /**
   * True when the key declares a swap (two elements matched in either order).
   */
  hasSwap: boolean;
  /**
   * Whether today's exchange applies the swap: the verdict of
   * {@link InvitationSummary.fanOutApplied}, since a count-only exchange
   * refuses a swapped key. Meaningful only with {@link hasSwap}.
   */
  swapApplied: boolean;
  /**
   * The two swapped elements' field labels, present only when both references
   * resolve to elements with distinct labels. Otherwise absent and the renderer
   * shows a generic note keyed off {@link hasSwap}; an unresolved swap
   * identifier never enters the tuple.
   */
  swap?: [Displayable, Displayable];
  /**
   * The always-visible one-liner of the fields this key matches on: a compact
   * label per element plus a breadth marker where it loosens matching ("last
   * name (partial)"), deduped by the full entry. An unresolved field falls back
   * to its sanitized identifier. A swap re-attributes each marker to its
   * partner's field, since each swapped element reads the other's value on the
   * receiver (core's `swapElements`). The either-order note is
   * {@link swapHeaderMarker}.
   */
  headerFields: Array<Displayable>;
  /**
   * Header suffix for a swapped key, present only when {@link hasSwap}: states
   * the either-order match when {@link swapApplied}, else the refusal. Fixed
   * copy; the remedy stays in the per-key swap caveat.
   */
  swapHeaderMarker?: Displayable;
}

/**
 * A linkage field's label and declared constraints (advisory: the application
 * warns and does not enforce), shown so the acceptor sees every rule on the
 * matched data.
 */
interface InvitationFieldSummary {
  /** Human-readable label for the field's semantic type. */
  label: string;
  /**
   * Descriptions of the declared constraints. `exclude` is summarized as a
   * count. The partner-authored `allowedCharacters` class is held apart in
   * {@link allowedCharacters} so the renderer can bind it in its own element.
   */
  constraints: Array<string>;
  /**
   * The partner-authored `allowedCharacters` class, sanitized, present only
   * when declared. Held apart from {@link constraints} so a partner cannot
   * place separator text inside it to impersonate the surrounding label.
   * Accepted on a transcription checksum and never vetted (the check is
   * advisory, core's `withinAllowedCharacters`); the renderer labels it
   * unverified.
   */
  allowedCharacters?: Displayable;
}

/**
 * A display-ready view of the inviter's linkage terms, derived from a decoded
 * {@link InvitationToken}. Every partner-controlled value passes through
 * {@link redactAndSanitizeForDisplay} here, once, so neither acceptance surface
 * re-derives the escaping; the redaction also protects a log line
 * (`consentSurfaceSink`, `apps/cli/src/invitationDisplay.ts`).
 *
 * Fields a partner value can reach are typed {@link Displayable}. The brand
 * does not force a new field to be declared that way, so a runtime test walks a
 * summary built from hostile terms and fails on any string outside printable
 * ASCII. {@link InvitationKeySummary.id} holds the raw key name and is never
 * rendered.
 */
export interface InvitationSummary {
  /**
   * The inviter's self-asserted identity, sanitized, or the absence marker from
   * `partyIdentityDisplay.ts`.
   */
  invitingParty: Displayable;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  /**
   * How the agreed keys are exchanged: `cascade` (default) or `single-pass`.
   * single-pass is disclosure-affecting: the receiver sees matches on less
   * precise keys the cascade would have filtered out, so the renderer always
   * shows it. A schema enum, rendered verbatim.
   */
  linkageStrategy: LinkageStrategy;
  /** Whether the inviter expects to receive the intersection result. */
  inviterReceivesOutput: boolean;
  /** Whether the inviter will share the result with the accepting partner. */
  inviterSharesResult: boolean;
  /**
   * The inviter's declared deduplicate setting: whether several of its records
   * may match one of the accepting party's.
   */
  deduplicate: boolean;
  /**
   * Whether an exchange on these terms applies {@link deduplicate}. False when
   * the named strategy matches no deduplicating cardinality, which acceptance
   * refuses (`assertDeduplicateImplemented`). Not covered: the both-sided pair
   * under a strategy that pairs no `many-to-many`, which an invitation alone
   * cannot answer (see {@link acceptorDeduplicateRefused} and
   * `resolveLinkageCardinality`).
   */
  deduplicateApplied: boolean;
  /**
   * Whether any key's element transforms split one value into several match
   * candidates, the fan-out an element marker names. Read from the agreed terms
   * alone; the inviter's own standardization can fan out a field the terms do
   * not show.
   */
  fansOut: boolean;
  /**
   * Whether the exchange matches on those candidates. True for either linkage
   * strategy under `psi` (docs/spec/PROTOCOL.md, Fan-out runs under both
   * linkage strategies); `psi-c` refuses terms declaring a fan-out before the
   * exchange runs. Meaningful only with {@link fansOut}.
   */
  fanOutApplied: boolean;
  /**
   * Whether a `deduplicate: true` the ACCEPTING party declares is refused: the
   * inviter declares its own `deduplicate` under a strategy that pairs no
   * both-sided cardinality. Both conditions are the invitation's own, so the
   * consequence is statable before that value is set. The pair is refused at
   * the accept boundary (`assertBothSidedDeduplicateImplemented`) and at the
   * agreed-terms run boundary (`resolveLinkageCardinality`).
   */
  acceptorDeduplicateRefused: boolean;
  /**
   * Whether a key expands one value into several candidates under a
   * `deduplicate` pair whose grouping chains: the terms declare a candidate set
   * the exchange matches on and a `deduplicate`, and the accept boundary takes
   * the pair the other party's `deduplicate` would complete, so one group can
   * hold two records no key links (docs/spec/PROTOCOL.md, The `many-to-many`
   * entity closure). False wherever that party cannot set the value, such as a
   * sole-receiver document. Unlike {@link fansOut}, it covers every
   * candidate-set producer (`swap`, fuzzy comparison, `split_on`). The other
   * party's value is not in these terms, so the sentence this selects is
   * conditional.
   */
  candidateSetChainsGrouping: boolean;
  /**
   * Whether the exchange suppresses the accepting party's half of the
   * matched-pair table, so it learns neither which of its records matched nor
   * how many of the inviter's stand behind one. The verdict of
   * {@link withholdsAcceptorAssociationTable}.
   */
  acceptorTableWithheld: boolean;
  /**
   * The same verdict for the inviting party's half
   * ({@link withholdsInviterAssociationTable}).
   */
  inviterTableWithheld: boolean;
  /** Linkage keys in the inviter's order, with their elements and rules. */
  linkageKeys: Array<InvitationKeySummary>;
  /**
   * The unique fields the keys match on, as compact labels in order of first
   * appearance, with no markers or grouping. Always visible above the collapsed
   * detail. An unresolved reference falls back to its sanitized name.
   */
  matchedFields: Array<Displayable>;
  /** PII fields involved, each with its label and declared constraints. */
  linkageFields: Array<InvitationFieldSummary>;
  /**
   * The rule set the keys and fields are cited to, present only when the
   * invitation declares one. {@link InvitationRuleSetSummary} says why a
   * surface shows it as the inviter's citation.
   */
  linkageRuleSet?: InvitationRuleSetSummary;
  /** Present only when the inviter attached a legal agreement. */
  legalAgreement?: InvitationLegalAgreementSummary;
  /** Present only when the inviter declared payload columns to send or
   * receive. */
  payload?: InvitationPayloadSummary;
  /**
   * The invitation's expiry instant (ISO 8601), if any, sanitized like the
   * agreement dates.
   */
  expires?: Displayable;
  /**
   * Whether the invitation discloses that its exchange keeps every file it
   * writes (retain mode), leaving a permanent transcript. True when the
   * invitation declares `inviterRetainsFiles: true`, or its endpoint has the
   * split inbound/outbound directory pair, which requires retain mode
   * ({@link endpointRequiresRetainedFiles}). One-way: false means neither
   * ground applies, not that the partner deletes files, a claim `CONSENT_FACTS`'
   * `retainedFiles` entry records as one no surface may make. The value is
   * schema-validated, so it needs no sanitize call.
   */
  disclosesRetainedFiles: boolean;
  /**
   * The `path` of a single-directory file-drop endpoint, sanitized for text
   * display only (never an attribute or raw HTML). Advisory: it is the folder's
   * own name only where the inviting console could name the folder.
   */
  connectionPath?: Displayable;
  /**
   * The relay urls a webrtc endpoint names, sanitized. Present only when the
   * endpoint names a relay; a list is empty when none of that kind is named.
   */
  relay?: { turn: Array<Displayable>; stun: Array<Displayable> };
}

/**
 * Descriptions of a field's declared constraints, in a stable order. `exclude`
 * is reported as a count, not its values. `allowedCharacters` is held apart
 * ({@link allowedCharactersClass}).
 */
function describeConstraints(field: LinkageField): Array<string> {
  const constraints = field.constraints;
  if (constraints === undefined) return [];

  const descriptions: Array<string> = [];
  if ("validOnly" in constraints && constraints.validOnly === true)
    descriptions.push("values must be valid");
  if ("affixesAllowed" in constraints && constraints.affixesAllowed === false)
    descriptions.push("honorifics and suffixes removed");
  const exclude = constraints.exclude ?? [];
  if (exclude.length > 0)
    descriptions.push(
      `${exclude.length} excluded value${exclude.length === 1 ? "" : "s"}`,
    );
  return descriptions;
}

/**
 * The field's `allowedCharacters` class, sanitized, or undefined. Returned
 * alone, without a system label, so the renderer binds it in its own element
 * and separator text cannot impersonate the label. A crafted class can read
 * differently to a human than the set it admits (a leading `^` negates;
 * `\p{L}`, `[:alpha:]` and `]|\w|[` are opaque), so the renderer labels it
 * partner-supplied and unverified. The check is advisory (core's
 * `withinAllowedCharacters`).
 */
function allowedCharactersClass(field: LinkageField): Displayable | undefined {
  const constraints = field.constraints;
  if (
    constraints === undefined ||
    !("allowedCharacters" in constraints) ||
    constraints.allowedCharacters === undefined
  )
    return undefined;
  return redactAndSanitizeForDisplay(constraints.allowedCharacters);
}

/**
 * A step's declared params in display order: the ones a consent verdict reads
 * ({@link CONSENT_VERDICT_PARAM_NAMES}) first, then the rest in declaration
 * order. In plain order, the party that authors the transform could push a
 * compensating row (a `parse_date`'s `outputFormat`) past
 * {@link MAX_DISPLAYED_PARAMS} into the overflow marker. The entries come from
 * {@link declaredParamEntries}, so the shown and refused counts agree. The
 * lookup uses the table's read path because the function name is partner free
 * text: `constructor` must answer undefined.
 */
function orderedParamEntries(step: TransformStep): Array<[string, unknown]> {
  const entries = declaredParamEntries(step.params);
  const verdictBearing = new Set<string>(
    frozenLookupTableEntry(CONSENT_VERDICT_PARAM_NAMES, step.function) ?? [],
  );
  return [
    ...entries.filter(([name]) => verdictBearing.has(name)),
    ...entries.filter(([name]) => !verdictBearing.has(name)),
  ];
}

/**
 * The literal slice phrase for a `substring` step, or undefined.
 * `positionalSafe` is true only for a name field's FIRST step, so the slice
 * runs on the unmodified value; a reformatted field (a date) or a substring
 * after a rewriting step would misstate it and falls back to the glossary.
 * Params are partner-controlled `unknown`; only a positive integer `start`
 * yields a literal (core's `substring` is 1-indexed SQL SUBSTR).
 */
function substringEffect(
  step: TransformStep,
  positionalSafe: boolean,
): Displayable | undefined {
  if (step.function !== "substring" || !positionalSafe) return undefined;
  const start = step.params?.start;
  const length = step.params?.length;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1
  )
    return undefined;
  if (start === 1)
    return length === 1
      ? displayText`the first character`
      : displayText`the first ${length} characters`;
  if (start > 1)
    return displayText`characters ${start} to ${start + length - 1}`;
  return undefined;
}

/**
 * Reduce one transform step to its display summary. Each parameter entry is
 * sanitized and truncated as a whole, spelled as the document writes it
 * ({@link describedTransformParamEntry}), and the entry count is capped.
 * `positionalSafe` allows a literal slice phrase ({@link substringEffect});
 * `substitutesFallback` is core's verdict on whether a `coalesce` substitutes
 * where it sits, and picks between its two descriptions.
 */
function summarizeTransform(
  step: TransformStep,
  positionalSafe: boolean,
  substitutesFallback: boolean,
): InvitationTransformSummary {
  const entries = orderedParamEntries(step);
  const shown = entries.slice(0, MAX_DISPLAYED_PARAMS);
  const params = shown.map((entry) =>
    redactAndSanitizeForDisplay(
      describedTransformParamEntry(entry[0], entry[1]),
    ),
  );
  if (entries.length > MAX_DISPLAYED_PARAMS)
    params.push(displayText`... ${entries.length - MAX_DISPLAYED_PARAMS} more`);
  const summary: InvitationTransformSummary = {
    function: redactAndSanitizeForDisplay(step.function),
    params,
  };
  // The literal slice phrase leads where faithful; the glossary is the
  // fallback. The lookup reads the raw function name through the table's read
  // path, so an unmatched partner name answers undefined. A non-substituting
  // coalesce takes its own description so the row never asserts a substitution
  // the header marker declined to name.
  const effect = substringEffect(step, positionalSafe);
  if (effect !== undefined) summary.effect = effect;
  else if (step.function === "coalesce" && !substitutesFallback)
    summary.description = COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION;
  else {
    const glossed = frozenLookupTableEntry(
      TRANSFORM_FUNCTION_GLOSSARY,
      step.function,
    );
    if (glossed !== undefined) summary.description = glossed;
  }
  return summary;
}

// Core's parseDateFactory default input format (standardization.ts): an absent
// inputFormat drops nothing. The output default is DEFAULT_DATE_OUTPUT_FORMAT.
const DEFAULT_PARSE_DATE_INPUT = "MM/DD/YYYY";

/**
 * The breadth marker a `parse_date` step's output layout gets, or undefined
 * when it only reformats between equivalent full layouts or its input format
 * cannot supply a full date.
 *
 * - "any date": the output layout has no date token, so every date collapses
 *   to one constant.
 * - "partial": the output keeps a date token but omits a component its input
 *   contains.
 *
 * A later `substring` run can also collapse every date;
 * {@link elementBreadthMarker} takes that from {@link gradeElementPipeline}. An
 * input format missing a required component drops every record, a narrowing the
 * dead-key advisory reports, so it gets no marker (core's
 * `parseDateInputDropsEveryRecord`). The returned word is one of two fixed
 * literals.
 */
function parseDateBreadth(
  step: TransformStep,
): "any date" | "partial" | undefined {
  if (step.function !== "parse_date") return undefined;
  // An input format that cannot assemble a full date drops every record (core's
  // check, which also covers a non-string format). Guarding per step also stops
  // a dead parse_date that a later `coalesce` rescues from being labelled a
  // date collapse; the right marker there is "fallback".
  if (parseDateInputDropsEveryRecord(step.params)) return undefined;
  const rawInput = step.params?.inputFormat;
  const rawOutput = step.params?.outputFormat;
  const input =
    typeof rawInput === "string" ? rawInput : DEFAULT_PARSE_DATE_INPUT;
  const output =
    typeof rawOutput === "string" ? rawOutput : DEFAULT_DATE_OUTPUT_FORMAT;
  // The output is classified in its own context: `YY` in an output format is an
  // unsubstituted literal (the factory fills only YYYY/MM/DD), so "YY" is a
  // constant and "MM/DD/YY" drops the year.
  const outputComponents = dateFormatComponents(output, "output");
  if (outputComponents.size === 0) return "any date";
  const dropsComponent = [...dateFormatComponents(input, "input")].some(
    (component) => !outputComponents.has(component),
  );
  return dropsComponent ? "partial" : undefined;
}

/**
 * Whether the element's transform expands its value into several match
 * candidates: the "multiple" marker, or "not supported" where the strategy
 * refuses.
 */
function declaresFanOut(element: LinkageKeyElement): boolean {
  const functions = new Set((element.transform ?? []).map((s) => s.function));
  return FAN_OUT_FUNCTION_NAMES.some((name) => functions.has(name));
}

/**
 * Transform functions whose output the acceptor's own identifier need not
 * compose, so a later `substring` is not a truncation of the identifier and
 * gets no "partial" (see {@link elementBreadthMarker}). Membership is a policy
 * decision about the consent marker, over core's schema-validated names.
 */
const LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS: ReadonlySet<string> = new Set([
  "phonetic",
  "replace_regex",
  "pad_left",
]);

/**
 * The marker for a key element's collapsed-header entry: a single, most salient
 * one (the full rule set is in {@link InvitationKeySummary.elements}).
 * Undefined when the element matches exactly, only canonicalizes, or its
 * pipeline matches nothing (a narrowing the dead-key advisory reports).
 * Ranking, widest first:
 *
 * 1. "multiple" or "not supported": fan-out; `fanOutMatches` picks which, since
 *    a count-only `psi-c` exchange refuses a candidate set.
 * 2. A pipeline that matches nothing: no marker.
 * 3. "any date" (a `parse_date` output with no date token, or one a later
 *    `substring` run leaves constant, per {@link gradeElementPipeline}), then
 *    "fallback" (a `coalesce` that substitutes a constant,
 *    {@link coalesceSubstitutesConstant}).
 * 4. "partial" (a truncating `substring`, counted after a routine normalizer
 *    but not after {@link LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS}), "fuzzy",
 *    "sound-alike" (`phonetic`), then a component-dropping `parse_date`'s
 *    "partial".
 * 5. Rules whose direction is indeterminate: "pattern replacement", "pattern
 *    extraction", "padded slice", "pattern filter", "excludes values".
 *
 * Known limits: a tier 3 or 4 marker can mask "padded slice" (for `[pad_left,
 * substring, parse_date]` it renders "partial"), which no built-in key set
 * reaches. The date-collapse measurement cannot see a value-dependent drop (a
 * `filter_regex` that passes the probes but drops a real record), so such an
 * element earns "any date".
 */
function elementBreadthMarker(
  element: LinkageKeyElement,
  fanOutMatches: boolean,
): Displayable | undefined {
  const steps = element.transform ?? [];
  const functions = new Set(steps.map((s) => s.function));
  // Tier 1: fan-out outranks every marker below.
  if (declaresFanOut(element))
    return fanOutMatches ? displayText`multiple` : displayText`not supported`;
  // Tier 2: a pipeline that matches nothing gets no marker, per core's drop
  // verdict (which accounts for a rescuing `coalesce`). The grading also
  // answers tier 3a, off one walk of the steps.
  const grading = gradeElementPipeline(steps);
  if (grading.alwaysDrops()) return undefined;
  // Tier 3a: "any date", the maximal collapse. The whole pipeline is offered at
  // once because core decides which step ends a maximal substring run.
  const parseDateBreadths = steps.map(parseDateBreadth);
  if (
    parseDateBreadths.includes("any date") ||
    grading.collapsesParsedDateToConstant()
  )
    return displayText`any date`;
  // Tier 3b: "fallback", gated on core's position-aware predicate so it fires
  // only where the substitution runs.
  if (
    steps.some((step, index) =>
      coalesceSubstitutesConstant(step, steps.slice(0, index)),
    )
  )
    return displayText`fallback`;
  // Tier 4: the coarsening markers, in rank order.
  const truncatesLiteral = steps.some(
    (step, index) =>
      step.function === "substring" &&
      !steps
        .slice(0, index)
        .some((prior) =>
          LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS.has(prior.function),
        ),
  );
  if (truncatesLiteral) return displayText`partial`;
  if (element.generateFuzzyComparisons !== undefined) return displayText`fuzzy`;
  if (functions.has("phonetic")) return displayText`sound-alike`;
  if (parseDateBreadths.includes("partial")) return displayText`partial`;
  // Tier 5: the directly-named rules. The rewriting rules rank above "padded
  // slice" because a rewrite between the pad and the slice can dissolve the
  // padding.
  if (functions.has("replace_regex")) return displayText`pattern replacement`;
  if (functions.has("extract_regex")) return displayText`pattern extraction`;
  const slicesPaddedValue = steps.some(
    (step, index) =>
      step.function === "substring" &&
      steps.slice(0, index).some((prior) => prior.function === "pad_left"),
  );
  if (slicesPaddedValue) return displayText`padded slice`;
  // The narrowing-only rules rank last: each substitutes nothing, so "padded
  // slice" stays true beside them.
  if (functions.has("filter_regex")) return displayText`pattern filter`;
  if (functions.has("null_if")) return displayText`excludes values`;
  return undefined;
}

/**
 * Reduce one linkage key to its display summary. `fieldByName` maps a field
 * `name` to its semantic type; an unresolved element or swap reference falls
 * back to the sanitized raw string. `fanOutMatches` is whether the agreed
 * algorithm and strategy match a candidate set.
 */
function summarizeKey(
  key: LinkageKey,
  fieldByName: Map<string, LinkageField["type"]>,
  fanOutMatches: boolean,
): InvitationKeySummary {
  const labelForField = (fieldName: string): Displayable => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? FIELD_TYPE_LABELS[type]
      : redactAndSanitizeForDisplay(fieldName);
  };

  const compactLabelForField = (fieldName: string): Displayable => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? COMPACT_FIELD_TYPE_LABELS[type]
      : redactAndSanitizeForDisplay(fieldName);
  };

  const elements: Array<InvitationKeyElementSummary> = key.elements.map(
    (element) => {
      const type = fieldByName.get(element.field);
      // A character slice reads faithfully only on a free-text name; a date or
      // other reformatted field is canonicalized by a standardization the token
      // does not hold.
      const positionalSafe = type === "first_name" || type === "last_name";
      const steps = element.transform ?? [];
      return {
        fieldLabel: labelForField(element.field),
        // A substring literal is faithful only on a name field's first step,
        // since a later step runs on an already-rewritten value. A coalesce's
        // description depends on the steps before it for the same reason.
        transforms: steps.map((step, stepIndex) =>
          summarizeTransform(
            step,
            positionalSafe && stepIndex === 0,
            coalesceSubstitutesConstant(step, steps.slice(0, stepIndex)),
          ),
        ),
        fuzzyComparison:
          element.generateFuzzyComparisons !== undefined
            ? FUZZY_COMPARISON_LABELS[element.generateFuzzyComparisons]
            : undefined,
        fuzzyComparisonApplied: fanOutMatches,
      };
    },
  );

  const hasSwap = key.swap !== undefined;
  const swapApplied = fanOutMatches;
  let swap: [Displayable, Displayable] | undefined;
  // Header-marker re-attribution across a swap: each swapped element maps to
  // the marker its header entry shows instead of its own (an explicit
  // `undefined` blanks it). Empty for a non-swap, a same-label swap, or a pair
  // holding a refused rule.
  const headerMarkerOverride = new Map<
    LinkageKeyElement,
    Displayable | undefined
  >();
  if (key.swap !== undefined) {
    // A swap names two elements by identifier (`name ?? field`, unique within a
    // key by schema). The note names the fields only when both resolve with
    // distinct labels; otherwise `swap` stays undefined.
    const elementByIdentifier = new Map(
      key.elements.map((element) => [element.name ?? element.field, element]),
    );
    const first = elementByIdentifier.get(key.swap[0]);
    const second = elementByIdentifier.get(key.swap[1]);
    if (first !== undefined && second !== undefined) {
      const firstLabel = labelForField(first.field);
      const secondLabel = labelForField(second.field);
      if (firstLabel !== secondLabel) {
        swap = [firstLabel, secondLabel];
        // On the receiver each swapped element keeps its own rules but reads
        // the other's field (core's `swapElements`), so each header entry shows
        // its partner's marker. The exception is a refused fan-out: "not
        // supported" names a step the operator must find and remove, which sits
        // in the declaring element, so a refusal anywhere in the pair leaves
        // both markers where declared.
        const refusedFanOut =
          !fanOutMatches && (declaresFanOut(first) || declaresFanOut(second));
        if (!refusedFanOut) {
          headerMarkerOverride.set(
            first,
            elementBreadthMarker(second, fanOutMatches),
          );
          headerMarkerOverride.set(
            second,
            elementBreadthMarker(first, fanOutMatches),
          );
        }
      }
    }
  }

  // The always-visible field one-liner: a compact label per element with its
  // marker (re-attributed across a swap), deduped by the full entry so a
  // truncated element does not collapse onto a whole-value one of the same
  // field.
  const headerFields: Array<Displayable> = [];
  const seenHeaderFields = new Set<string>();
  for (const element of key.elements) {
    const label = compactLabelForField(element.field);
    const marker = headerMarkerOverride.has(element)
      ? headerMarkerOverride.get(element)
      : elementBreadthMarker(element, fanOutMatches);
    const entry =
      marker !== undefined ? displayText`${label} (${marker})` : label;
    if (seenHeaderFields.has(entry)) continue;
    seenHeaderFields.add(entry);
    headerFields.push(entry);
  }

  const swapHeaderMarker = hasSwap
    ? swapApplied
      ? displayText`(matched in either order)`
      : displayText`(either order not supported)`
    : undefined;

  return {
    id: key.name,
    name: redactAndSanitizeForDisplay(key.name),
    elements,
    headerFields,
    hasSwap,
    // A swapped key order is a candidate-set producer like the fuzzy expansion
    // (`keyDeclaresCandidateSet`, fanOutFunctions.ts), so it applies where
    // `fanOutMatches` does.
    swapApplied,
    swap,
    swapHeaderMarker,
  };
}

/**
 * Whether the exchange withholds the ACCEPTING party's half of the association
 * table at the wire, leaving it blind to which of its records matched and to
 * the size of any group of the inviter's records behind one.
 *
 * Asks {@link withholdsSenderAssociationTable} about the reading of the
 * invitation's terms that puts the accepting party on the withheld side:
 *
 * - The strategy is `single-pass`; a cascade's rounds carry each party's
 *   matched positions as they go (docs/spec/PROTOCOL.md, Withholding the
 *   sender's table from a blind helper).
 * - The inviter is entitled to output and the accepting party is not, which
 *   makes the accepting party the sender (pinned against `resolveRole` in
 *   `test/consent/invitationSummary.test.ts`).
 * - The invitation declares `payload.receive` present and empty, which mirrors
 *   to the acceptor's empty `payload.send`, held by
 *   `assertPayloadSendDisclosed`. An absent `receive` binds nothing and reads
 *   as disclosure.
 *
 * Deduplication adds no condition (docs/spec/PROTOCOL.md, Where the "one" party
 * receives no output). A document no acceptance can reach resolves false:
 * `deriveAcceptedLinkageTerms` refuses it (pinned in the same test).
 */
export function withholdsAcceptorAssociationTable(
  terms: LinkageTerms,
): boolean {
  if (terms.linkageStrategy !== "single-pass") return false;
  if (!terms.output.expectsOutput) return false;
  if (!terms.output.shareWithPartner && (terms.payload?.send?.length ?? 0) > 0)
    return false;
  const requestsNoPayload = declaresNoPayloadColumn(terms.payload?.receive);
  return withholdsSenderAssociationTable(
    terms.output.shareWithPartner,
    !requestsNoPayload,
  );
}

/**
 * Whether the exchange withholds the INVITING party's half of the association
 * table: the mirror of {@link withholdsAcceptorAssociationTable}, with the
 * inviter as the sender. Conditions:
 *
 * - The strategy is `single-pass`.
 * - The accepting party is entitled to output and the inviter is not.
 * - The invitation declares an empty `payload.send`, which binds the inviter to
 *   disclosing no column (`assertPayloadSendDisclosed`). An absent `send` binds
 *   nothing and reads as disclosure.
 *
 * Read once for both surfaces: the own-membership fact
 * (`partnerLearnsOwnMembership` / `partnerOwnMembershipWithheld`) and the
 * grouping fact (`partnerReadsDuplicateGrouping` /
 * `partnerDuplicateGroupingWithheld`). Deduplication adds no condition
 * (docs/spec/PROTOCOL.md, Where the "one" party receives no output).
 */
export function withholdsInviterAssociationTable(terms: LinkageTerms): boolean {
  if (terms.linkageStrategy !== "single-pass") return false;
  if (terms.output.expectsOutput) return false;
  if (!terms.output.shareWithPartner) return false;
  const disclosesNoPayload = declaresNoPayloadColumn(terms.payload?.send);
  return withholdsSenderAssociationTable(
    terms.output.expectsOutput,
    !disclosesNoPayload,
  );
}

/**
 * Whether the exchange withholds the PARTNER's half of the association table,
 * read from terms a party wrote for ITSELF, with no invitation between the
 * parties. The same rule ({@link withholdsSenderAssociationTable}), with
 * `output.expectsOutput` as this party's entitlement, `output.shareWithPartner`
 * the partner's, and `payload.receive` what this party takes from the partner.
 * Conditions:
 *
 * - The strategy is `single-pass`.
 * - This party is entitled to output and the partner is not;
 *   `validateCompatibility` keeps the two documents from disagreeing on that.
 * - This party declares an empty `payload.receive`, which binds the partner to
 *   sending no column (`validateCompatibility`). An absent `receive` reads as
 *   disclosure.
 *
 * This party's `payload.send` does not enter it. The empty `receive` is checked
 * against the partner's DECLARED `payload.send` alone, so this reading can
 * predict a withheld table for a pair the run refuses before any round
 * (`resolveDirectionDisclosesPayload`, exchange/termsRefusals.ts).
 */
export function withholdsPartnerAssociationTable(terms: LinkageTerms): boolean {
  if (terms.linkageStrategy !== "single-pass") return false;
  if (!terms.output.expectsOutput) return false;
  const requestsNoPayload = declaresNoPayloadColumn(terms.payload?.receive);
  return withholdsSenderAssociationTable(
    terms.output.shareWithPartner,
    !requestsNoPayload,
  );
}

/**
 * Stand-in for the other party's `identity` in the accept probe below. The
 * result is discarded, so the value is never displayed or run.
 */
const ACCEPT_PROBE_IDENTITY = "you";

/**
 * Whether the accept boundary takes these terms with the OTHER party's own
 * `deduplicate` set: the accepting party for an invitation, the partner for
 * terms this party wrote. Runs `deriveAcceptedLinkageTerms` rather than
 * restating its rules, so the fact is withheld wherever accept refuses for any
 * reason: a sole-receiver document, a count-only shape, a strategy pairing no
 * both-sided cardinality, or a document mirroring to no acceptable acceptance.
 */
function acceptTakesPartnerDeduplicate(terms: LinkageTerms): boolean {
  try {
    deriveAcceptedLinkageTerms(terms, ACCEPT_PROBE_IDENTITY, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a display-ready {@link InvitationSummary} from an invitation's linkage
 * terms and optional expiry. The parameter is a structural subset of
 * {@link InvitationToken}, so a decoded token and the terms/expiry pair the
 * exchange screen holds without a token are both accepted. Pure: the single
 * tested boundary for sanitizing every partner-controlled string.
 */
export function summarizeInvitation(
  source: Pick<
    InvitationToken,
    "linkageTerms" | "expires" | "connectionEndpoint" | "inviterRetainsFiles"
  >,
): InvitationSummary {
  const terms = source.linkageTerms;

  // The advisory path is partner free text, sanitized like every other partner
  // string; the split pair and non-filedrop endpoints hold no single locator.
  const endpoint = source.connectionEndpoint;
  const connectionPath =
    endpoint?.channel === "filedrop" && endpoint.path !== undefined
      ? redactAndSanitizeForDisplay(endpoint.path)
      : undefined;

  const fieldByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );

  // Collapse fields identical for display (same label, constraint phrases and
  // allowed-character class), such as a maiden and a current name both typed
  // `first_name`. The key is the JSON encoding of the triple, since a plain
  // join is not injective when a phrase or class holds the separator. It is
  // built from the sanitized strings, so fields differing only in characters
  // sanitization folds together also collapse.
  const seenFields = new Set<string>();
  const linkageFields: Array<InvitationFieldSummary> = [];
  for (const field of terms.linkageFields) {
    const allowed = allowedCharactersClass(field);
    const summary: InvitationFieldSummary = {
      label: FIELD_TYPE_LABELS[field.type],
      constraints: describeConstraints(field),
      ...(allowed !== undefined ? { allowedCharacters: allowed } : {}),
    };
    const dedupeKey = JSON.stringify([
      summary.label,
      summary.constraints,
      summary.allowedCharacters ?? null,
    ]);
    if (seenFields.has(dedupeKey)) continue;
    seenFields.add(dedupeKey);
    linkageFields.push(summary);
  }

  // The unique matched fields, compact and in order of first appearance,
  // derived from the keys' elements (not the declared field list) through the
  // same label path as the per-key sublines.
  const matchedFields: Array<Displayable> = [];
  const seenMatchedFields = new Set<string>();
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      const type = fieldByName.get(element.field);
      const label =
        type !== undefined
          ? COMPACT_FIELD_TYPE_LABELS[type]
          : redactAndSanitizeForDisplay(element.field);
      if (seenMatchedFields.has(label)) continue;
      seenMatchedFields.add(label);
      matchedFields.push(label);
    }
  }

  // The consent screen shows the inviter's terms as proposed, not only what
  // today's exchange runs; the *Applied flags report the gap to the renderer.
  //
  // `fanOutMatches` is which fan-out register applies: a combination that
  // matches a candidate set, or one the terms are refused for. It is read from
  // the refusal's own predicates, once, so the markers, key summaries and
  // consent fact follow one verdict.
  const fanOutMatches =
    terms.algorithm !== "psi-c" &&
    candidateSetIsImplementedForStrategy(terms.linkageStrategy);
  // Whether the strategy matches the deduplicating cardinality the term asks
  // for, from the refusal's own predicate; a strategy that does not is refused
  // at acceptance.
  const deduplicateApplied = deduplicateIsImplementedForStrategy(
    terms.linkageStrategy,
  );
  // The pair the accepting party's `deduplicate: true` would complete, from the
  // accept boundary's own predicate (`bothSidedDeduplicateRefused`,
  // linkageTermsPolicy.ts).
  const acceptorDeduplicateRefused = bothSidedDeduplicateRefused(
    { ...terms, deduplicate: true },
    terms,
  );
  // The grouping a candidate set makes once both parties deduplicate, read over
  // every producer (`termsDeclareCandidateSet`, fanOutFunctions.ts) rather than
  // the `split_on` half `fansOut` holds, and over the accept boundary's whole
  // verdict, so a sole-receiver document that leaves that party no value to set
  // does not state a disclosure the exchange cannot make.
  const candidateSetChainsGrouping =
    fanOutMatches &&
    terms.deduplicate &&
    acceptTakesPartnerDeduplicate(terms) &&
    termsDeclareCandidateSet(terms);

  const summary: InvitationSummary = {
    invitingParty: redactAndDisplayPartyIdentity(terms.identity),
    algorithm: terms.algorithm,
    linkageStrategy: terms.linkageStrategy,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    deduplicate: terms.deduplicate,
    deduplicateApplied,
    fansOut: terms.linkageKeys.some((key) => key.elements.some(declaresFanOut)),
    fanOutApplied: fanOutMatches,
    acceptorDeduplicateRefused,
    candidateSetChainsGrouping,
    acceptorTableWithheld: withholdsAcceptorAssociationTable(terms),
    inviterTableWithheld: withholdsInviterAssociationTable(terms),
    linkageKeys: terms.linkageKeys.map((key) =>
      summarizeKey(key, fieldByName, fanOutMatches),
    ),
    matchedFields,
    linkageFields,
    // Narrowed to the one value a surface may state, over both grounds for
    // retain mode: the declaration, and an endpoint whose split-directory shape
    // seeds the acceptor's connection (the same predicate, so they cannot
    // drift). The declaration is three-valued; only "declared retain" is a fact
    // about the run, so the other two collapse here.
    disclosesRetainedFiles:
      source.inviterRetainsFiles === true ||
      endpointRequiresRetainedFiles(endpoint),
  };

  if (terms.linkageRuleSet !== undefined) {
    // Verdicts run over the same terms the names are read from.
    const verdicts = checkLinkageRuleSetCitation(terms.linkageRuleSet, terms);
    summary.linkageRuleSet = {
      fieldSet: {
        name: redactAndSanitizeForDisplay(terms.linkageRuleSet.fieldSet.name),
        version: redactAndSanitizeForDisplay(
          terms.linkageRuleSet.fieldSet.version,
        ),
        verdict: verdicts.fieldSet,
      },
      keySet: {
        name: redactAndSanitizeForDisplay(terms.linkageRuleSet.keySet.name),
        version: redactAndSanitizeForDisplay(
          terms.linkageRuleSet.keySet.version,
        ),
        verdict: verdicts.keySet,
      },
    };
  }

  if (terms.legalAgreement !== undefined) {
    summary.legalAgreement = {
      reference: redactAndSanitizeForDisplay(terms.legalAgreement.reference),
      purpose: redactAndSanitizeForDisplay(terms.legalAgreement.purpose),
      expirationDate: redactAndSanitizeForDisplay(
        terms.legalAgreement.expirationDate,
      ),
    };
  }

  // The columns the acceptor receives are the inviter's `payload.send`;
  // `receive` (requested from the acceptor) stays the authored list. The send
  // is read only where the inviter shares the result: `runExchange` builds a
  // payload only when the partner is entitled to one, so a count of arriving
  // columns would contradict a screen stating no result arrives.
  const sendDeclared =
    terms.output.shareWithPartner && terms.payload?.send !== undefined;
  const receiveDeclared = terms.payload?.receive !== undefined;
  const send = sendDeclared
    ? (terms.payload?.send ?? []).map((column) => column.name)
    : [];
  const receive = (terms.payload?.receive ?? []).map((column) => column.name);
  if (sendDeclared || receiveDeclared) {
    summary.payload = {
      send: send.map((name) => redactAndSanitizeForDisplay(name)),
      sendDeclared,
      receive: receive.map((name) => redactAndSanitizeForDisplay(name)),
      receiveDeclared,
    };
  }

  if (source.expires !== undefined)
    summary.expires = redactAndSanitizeForDisplay(source.expires);

  if (connectionPath !== undefined) summary.connectionPath = connectionPath;

  if (endpoint?.channel === "webrtc" && endpoint.relay !== undefined)
    summary.relay = {
      turn: (endpoint.relay.turn ?? []).map((url) =>
        redactAndSanitizeForDisplay(url),
      ),
      stun: (endpoint.relay.stun ?? []).map((url) =>
        redactAndSanitizeForDisplay(url),
      ),
    };

  return summary;
}
