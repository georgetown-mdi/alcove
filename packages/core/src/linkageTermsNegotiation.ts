// The two-party half of linkage terms: what an ACCEPTOR runs after adopting an
// inviter's terms, and whether the two parties' terms agree closely enough to
// run at all. Neither is configuration parsing -- both read terms already
// parsed by the schema in config/linkageTermsSchema.ts -- and both are driven by the
// exchange rather than by a document load.

import { AcceptedTermsShapeError, UsageError } from "./errors.js";
import { canonicalString, CanonicalEncodingError } from "./utils/canonical.js";
import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import {
  bareTermsValue,
  compatibilityMessage,
  quoteTermsValue,
  quoteTermsValueList,
  ruleSetCitation,
} from "./config/compatibilityMessage.js";
import type { CompatibilityMessageFragment } from "./config/compatibilityMessage.js";
import {
  assertBothSidedDeduplicateImplemented,
  assertCountOnlyTermsShape,
  assertDeduplicateImplemented,
} from "./linkageTermsPolicy.js";
import { assertTransformsCompile } from "./linkageSatisfiability.js";
import {
  LinkageTermsSchema,
  MAX_TEXT_LENGTH,
  PRIVATE_KEY_IDENTITY_MESSAGE,
  TEXT_CONTROL_CHAR_MESSAGE,
  TEXT_CONTROL_CHAR_PATTERN,
  TEXT_DIRECTION_MESSAGE,
} from "./config/linkageTermsSchema.js";
import { BIDI_CONTROL_PATTERN } from "./utils/nameControls.js";
import { holdsPrivateKeyMaterial } from "./utils/sanitizeErrorForDisplay.js";
import type {
  LinkageField,
  LinkageRuleSetReference,
  LinkageTerms,
  Payload,
  PayloadColumn,
} from "./config/linkageTermsSchema.js";

/**
 * Derive the {@link LinkageTerms} an ACCEPTOR runs from the inviter's terms
 * decoded from an invitation. The acceptor adopts the inviter's shared,
 * agreed fields verbatim -- `version`, `algorithm`, `linkageFields`,
 * `linkageKeys`, `linkageRuleSet`, `legalAgreement`, and so on are
 * cross-checked for equality at exchange time -- but four facets are the
 * acceptor's own perspective and are derived, not copied:
 *
 * - `identity` is replaced with the acceptor's own name (a CLI flag or
 *   prompt, a browser field), so the inviter's identity does not leak into
 *   the acceptor's terms. Held here to the same rules the schema holds a
 *   party `identity` to (control characters, text-direction characters,
 *   non-empty, {@link MAX_TEXT_LENGTH}), under a refusal naming the local
 *   input, rather than at the generic re-check below.
 * - `output` is MIRRORED, not copied: {@link validateCompatibility} compares
 *   it as a mirror (`local.expectsOutput` against `partner.shareWithPartner`
 *   and vice versa), so a verbatim copy is only accidentally correct for the
 *   symmetric "both receive" case.
 * - `payload` is MIRRORED for the same reason: the acceptor's `send` becomes
 *   the inviter's `receive` and vice versa. An absent inviter `receive`
 *   yields an absent acceptor `send` (lazy); an explicit empty inviter
 *   `receive: []` yields an explicit empty acceptor `send: []` (strict),
 *   matching {@link validateCompatibility}'s lazy/strict reading.
 * - `deduplicate` is the ACCEPTOR's own, taken from `acceptorDeduplicate`
 *   and defaulting to false, neither copied nor mirrored: it is per-party
 *   and declares that several of the DECLARING party's own records may
 *   match the partner's, so it is never the inviter's to set for the
 *   acceptor -- copying it would let a hostile inviter claim
 *   `deduplicate: true` to put the acceptor on the "many" side, then
 *   present `false` at the terms exchange. A seat where the accepting
 *   party authors its own side passes its operator's value; a caller with
 *   no such control passes none and gets the closed default. The
 *   invitation's declared value for the inviter's own side is retained
 *   separately by a caller holding the token, as
 *   `expectedPartnerDeduplicate` (`PreparedExchange`, exchange.ts); what
 *   the resulting pair discloses is stated on the consent surfaces
 *   (`describeDeduplicatePair`, `consent/consentFacts.ts`).
 *
 * Metadata and standardization stay per-party and local; this function
 * shapes only the agreed linkage terms.
 *
 * It fails closed: a config valid for the INVITER can mirror to one
 * incoherent for the acceptor (an inviter that is the sole receiver may
 * have a `payload.send` that needs the acceptor to receive output, but the
 * acceptor mirrors to `expectsOutput: false`), and an `acceptorDeduplicate`
 * the mirrored document cannot hold is refused the same way -- the schema
 * takes `deduplicate: true` only from a party that receives the result, so a
 * sole-receiver invitation admits no value but the closed default, which a
 * seat offering a control for this party's own side reads before offering
 * it. The derived terms are re-checked against {@link LinkageTermsSchema}
 * and an incoherent result throws, aborting acceptance cleanly, under the
 * SCHEMA's own issues rather than an account of one shape, so the refusal
 * names the rule the derived document broke. Each issue is delimited
 * ({@link quoteTermsValueList}), so a value one of them names cannot spell a
 * clause of Alcove's own; `identity` -- the one substituted value, and the
 * accepting operator's own -- is refused above under an account naming the
 * local input if it fails its own rules.
 *
 * It also refuses a `psi-c` document outside the count-only shape
 * ({@link assertCountOnlyTermsShape}) and a deduplicating invitation under a
 * strategy that cannot match one ({@link assertDeduplicateImplemented}),
 * both read from the INVITER's terms before the mirror is built, so the
 * refusal names the rule the received document breaks and keeps such an
 * invitation off the consent surfaces and off the wire. Both rules are
 * asserted again over the DERIVED document, which is what answers an
 * `acceptorDeduplicate` the accepting party's own side cannot hold: a
 * count-only document sets it false, and a strategy matching no
 * deduplicating cardinality takes it from neither party.
 *
 * It also compiles every element transform the inviter's terms declare
 * ({@link assertTransformsCompile}), so a step whose factory refuses its
 * declared params is refused here rather than at key realization, where the
 * run reaches it. The invitation's own transforms alone: a standardization is
 * per-party and local, and this party's own is checked at its prepare step.
 *
 * @throws {UsageError} when `acceptorIdentity` contains a control or
 *   text-direction character or private key material, is empty, or exceeds
 *   {@link MAX_TEXT_LENGTH},
 *   or when either party's terms are `psi-c` outside the count-only shape or
 *   declare `deduplicate` under a strategy that matches no deduplicating
 *   cardinality, or when an element transform the inviter declared does not
 *   compile.
 * @throws {AcceptedTermsShapeError} when the derived document fails
 *   {@link LinkageTermsSchema}: the inviter's terms cannot be coherently
 *   accepted for the mirrored output direction, or `acceptorDeduplicate` is
 *   a value that document cannot hold.
 */
export function deriveAcceptedLinkageTerms(
  inviterTerms: LinkageTerms,
  acceptorIdentity: string,
  acceptorDeduplicate: boolean = false,
): LinkageTerms {
  // This party's own name takes the rules the schema holds a party `identity` to
  // here, before it is substituted (see the doc comment): left to the re-check at
  // the end, the same value is refused as an invitation that cannot be accepted --
  // an account of an input the operator supplied itself. Every content rule the
  // field holds, each under the message the schema states it by.
  if (TEXT_CONTROL_CHAR_PATTERN.test(acceptorIdentity))
    throw new UsageError(
      "the identity supplied for this party cannot be used: " +
        `${TEXT_CONTROL_CHAR_MESSAGE}. Supply one that has none.`,
    );
  if (BIDI_CONTROL_PATTERN.test(acceptorIdentity))
    throw new UsageError(
      "the identity supplied for this party cannot be used: " +
        `${TEXT_DIRECTION_MESSAGE}. Supply one that has none.`,
    );
  if (holdsPrivateKeyMaterial(acceptorIdentity))
    throw new UsageError(
      "the identity supplied for this party cannot be used: " +
        `${PRIVATE_KEY_IDENTITY_MESSAGE}. Supply one that has none.`,
    );
  if (acceptorIdentity.length === 0)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is empty. " +
        "Supply a name for this party.",
    );
  if (acceptorIdentity.length > MAX_TEXT_LENGTH)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is longer than " +
        `${MAX_TEXT_LENGTH} characters. Supply a shorter one.`,
    );
  assertCountOnlyTermsShape(inviterTerms);
  assertDeduplicateImplemented(inviterTerms);
  // The element transforms are compiled here rather than left to key
  // realization, which is the first point a run would reach them: the accept
  // boundary is where this party still holds the decision, and a step whose
  // factory refuses its params makes the exchange the invitation offers one
  // that cannot run. The standardization is omitted -- this reads the
  // invitation's own content, and a standardization is per-party and local.
  assertTransformsCompile(inviterTerms);
  const derived: LinkageTerms = {
    ...inviterTerms,
    identity: acceptorIdentity,
    // This party's own side of the cardinality, which the invitation does
    // not pass to it: whether SEVERAL of this party's records may match one
    // of the partner's is a disclosure about this party's own data, so it
    // starts closed and is the accepting party's alone to open (see the doc
    // comment).
    deduplicate: acceptorDeduplicate,
    output: {
      expectsOutput: inviterTerms.output.shareWithPartner,
      shareWithPartner: inviterTerms.output.expectsOutput,
    },
  };
  // Mirror the payload `send`/`receive` (see the doc comment). Built explicitly so
  // an absent inviter `receive` yields an absent acceptor `send` (rather than an
  // empty list), keeping the acceptor lazy on a direction the inviter left open; an
  // explicit empty inviter `receive: []` mirrors to an explicit empty acceptor
  // `send: []` (present, not absent), preserving the strict reading on that direction.
  if (inviterTerms.payload !== undefined) {
    const mirrored: Payload = {};
    if (inviterTerms.payload.receive !== undefined)
      mirrored.send = inviterTerms.payload.receive;
    if (inviterTerms.payload.send !== undefined)
      mirrored.receive = inviterTerms.payload.send;
    derived.payload = mirrored;
  }
  // The same two rules over the derived document: the checks above read the
  // inviter's terms, where the accepting party's own `deduplicate` does not
  // appear, so a value that document cannot hold is refused here.
  assertCountOnlyTermsShape(derived);
  assertDeduplicateImplemented(derived);
  // The accept boundary is the first point the `deduplicate` PAIR is knowable,
  // this party holding the inviter's document and setting its own side, so a
  // pair no strategy of the two documents matches is refused here as well as at
  // the run boundary rather than only there, which is what keeps it off the
  // consent surfaces (docs/spec/PROTOCOL.md, The combinations that stay
  // unsupported).
  assertBothSidedDeduplicateImplemented(derived, inviterTerms);
  // Fail closed on an inviter config that mirrors to an incoherent acceptor config
  // (see the doc comment). safeParse is a validity gate only; return the object we
  // built, not parsed.data, so the canonical/agreed-terms bytes are unchanged.
  const recheck = LinkageTermsSchema.safeParse(derived);
  if (!recheck.success) {
    throw new AcceptedTermsShapeError(
      "the invitation's linkage terms cannot be accepted unchanged: the terms " +
        "derived for the accepting party -- the invitation's output direction " +
        "and payload mirrored, this party's own deduplicate applied -- are not " +
        "a valid linkage terms document: " +
        quoteTermsValueList(
          recheck.error.issues.map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          ),
        ) +
        ". Ask the inviting party for terms the accepting party can run, or " +
        "clear the deduplicate this party declares for its own side.",
    );
  }
  return derived;
}

// --- Compatibility -----------------------------------------------------------

/**
 * A rule-set reference as one readable clause, keys first: the keys are the
 * specific artifact and the fields the substrate they are built from, so a
 * reader meets the narrower claim before the broader one.
 *
 * Each half renders through {@link ruleSetCitation}, which supplies the
 * shared grammar for the pair, so a name holding a space, this clause's own
 * " over ", or a delimiter of its own is treated as content of one value
 * rather than as structure the clause asserted.
 */
export function describeRuleSet(
  reference: LinkageRuleSetReference,
): CompatibilityMessageFragment {
  return compatibilityMessage`${ruleSetCitation(reference.keySet.name, reference.keySet.version)} over ${ruleSetCitation(reference.fieldSet.name, reference.fieldSet.version)}`;
}

// Sort by UTF-16 code unit, not localeCompare: this comparator decides the
// element order and therefore the canonical bytes (canonical encoding
// preserves array order), and localeCompare is locale-dependent for non-ASCII
// names -- two parties under different locales could otherwise derive
// different bytes, and different receipt hashes, for the same terms. This is
// the same code-unit ordering the canonical encoder applies to object keys.
const linkageFieldsByName = (a: LinkageField, b: LinkageField): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The clause naming how two lists of named terms entries -- linkage fields or
 * linkage keys -- differ: the names only one party declares, then the names
 * both declare with different content, each list opened by `: ` and separated
 * by `; `. Empty where no name differs; for two lists holding the same entries
 * in a different order, it says so, which only the ordered keys can reach.
 *
 * An entry is compared by canonical form, the comparison that found the lists
 * unequal; one that cannot be encoded counts as differing, its encoding error
 * reported beside this clause.
 */
function namedEntryDifferences(
  local: ReadonlyArray<{ readonly name: string }>,
  partner: ReadonlyArray<{ readonly name: string }>,
  noun: CompatibilityMessageFragment,
): CompatibilityMessageFragment {
  const canonicalOrUndefined = (entry: unknown): string | undefined => {
    try {
      return canonicalString(entry);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) return undefined;
      throw err;
    }
  };
  const byName = (
    entries: ReadonlyArray<{ readonly name: string }>,
  ): Map<string, unknown> => {
    const map = new Map<string, unknown>();
    for (const entry of entries)
      if (!map.has(entry.name)) map.set(entry.name, entry);
    return map;
  };
  const localByName = byName(local);
  const partnerByName = byName(partner);
  // Names are listed in code-unit order so both parties render the same text.
  const byCodeUnit = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  const oneSideOnly = [
    ...[...localByName.keys()].filter((name) => !partnerByName.has(name)),
    ...[...partnerByName.keys()].filter((name) => !localByName.has(name)),
  ].sort(byCodeUnit);
  const differing = [...localByName.keys()]
    .filter((name) => {
      if (!partnerByName.has(name)) return false;
      const localCanonical = canonicalOrUndefined(localByName.get(name));
      return (
        localCanonical === undefined ||
        localCanonical !== canonicalOrUndefined(partnerByName.get(name))
      );
    })
    .sort(byCodeUnit);
  const clauses: CompatibilityMessageFragment[] = [];
  // A reason is relayed to the other party, so a clause holds from either side.
  if (oneSideOnly.length > 0)
    clauses.push(
      oneSideOnly.length === 1
        ? compatibilityMessage`${quoteTermsValueList(oneSideOnly)} is declared by one party only`
        : compatibilityMessage`${quoteTermsValueList(oneSideOnly)} are declared by one party only`,
    );
  if (differing.length > 0)
    clauses.push(
      compatibilityMessage`local and partner declare ${quoteTermsValueList(differing)} differently`,
    );
  if (
    clauses.length === 0 &&
    local.length === partner.length &&
    localByName.size === local.length &&
    partnerByName.size === partner.length
  )
    clauses.push(
      compatibilityMessage`local and partner declare the same ${noun} in a different order`,
    );
  if (clauses.length === 0) return compatibilityMessage``;
  return clauses
    .slice(1)
    .reduce(
      (joined, clause) => compatibilityMessage`${joined}; ${clause}`,
      compatibilityMessage`: ${clauses[0]!}`,
    );
}

/** The fields of {@link LinkageTerms} a partner's copy may differ in without
 * refusing the exchange: `identity` is each party's own name, and a `date`
 * mismatch only warns ({@link validateCompatibility}). */
export const TERMS_FIELDS_PARTNER_DOES_NOT_BIND = ["identity", "date"] as const;

/** The part of a party's {@link LinkageTerms} its partner refuses an exchange
 * over when its own copy differs ({@link partnerBoundTerms}). */
export type PartnerBoundTerms = Omit<
  LinkageTerms,
  (typeof TERMS_FIELDS_PARTNER_DOES_NOT_BIND)[number]
>;

/**
 * The part of `terms` a partner holding its own copy refuses an exchange over
 * when the two differ, in the form {@link validateCompatibility} compares it:
 * `linkageFields` in name order, since their array order is not significant.
 * An edit that leaves the projection's canonical encoding unchanged changes
 * nothing {@link validateCompatibility} compares, nor the `deduplicate` an
 * accepted invitation binds (`assertPresentedDeduplicateMatchesInvitation`,
 * exchange.ts).
 */
export function partnerBoundTerms(terms: LinkageTerms): PartnerBoundTerms {
  const { identity: _identity, date: _date, ...bound } = terms;
  return {
    ...bound,
    linkageFields: [...terms.linkageFields].sort(linkageFieldsByName),
  };
}

/**
 * How one direction's payload columns differ between the party that sends
 * them and the party that receives them, by column name. Adopting the
 * partner's terms takes the partner's list in both directions, so in
 * {@link TermsDelta}'s `received` (the partner sends) `added` is what the
 * partner now sends this party, while in its `sent` (the partner receives)
 * `removed` is what this party now sends and `added` what it no longer sends.
 */
export interface PayloadColumnsChange {
  /** Columns the sender's terms send that the receiver's do not receive. */
  added: string[];
  /** Columns the receiver's terms receive that the sender's do not send. */
  removed: string[];
}

/**
 * The partner's `deduplicate` against the value this party holds it to.
 */
export interface PartnerDeduplicateChange {
  /** The value this party holds the partner to. */
  expected: boolean;
  /** The value the partner's terms state. */
  presented: boolean;
}

/**
 * How a partner's terms differ from this party's: `received` is the partner's
 * send set against the columns this party receives, `sent` this party's send
 * set against the columns the partner receives, `partnerDeduplicate` the
 * partner's `deduplicate` against the value this party holds it to, and
 * `otherTerms` a diagnostic for each other term the two copies disagree on. A
 * direction is undefined where the two agree or the receiving party states no
 * list; `partnerDeduplicate` is undefined where the two agree or this party
 * holds the partner to no value.
 */
export interface TermsDelta {
  received: PayloadColumnsChange | undefined;
  sent: PayloadColumnsChange | undefined;
  partnerDeduplicate: PartnerDeduplicateChange | undefined;
  otherTerms: string[];
}

interface CompatibilityResult {
  errors: string[];
  warnings: string[];
  /** The disagreements `errors` states, sorted by what each changes. */
  delta: TermsDelta;
}

/**
 * {@link validateCompatibility}'s findings with each payload direction kept
 * apart from the other terms: `receivedMessage` and `sentMessage` are the
 * diagnostics for the two directions `delta` describes, and
 * `partnerDeduplicateMessage` the one for its `partnerDeduplicate`.
 */
export interface TermsComparison {
  delta: TermsDelta;
  warnings: string[];
  receivedMessage: string | undefined;
  sentMessage: string | undefined;
  partnerDeduplicateMessage: string | undefined;
}

/**
 * What {@link compareTerms} holds the partner to beside the two documents:
 * `partnerDeduplicate` is the `deduplicate` this party holds the partner to;
 * undefined compares no `deduplicate`, since the term is each party's own.
 */
export interface TermsBaselines {
  partnerDeduplicate?: boolean;
}

function columnsChange(
  receiverNames: ReadonlyArray<string>,
  senderNames: ReadonlyArray<string>,
): PayloadColumnsChange {
  const receiving = new Set(receiverNames);
  const sending = new Set(senderNames);
  return {
    added: senderNames.filter((name) => !receiving.has(name)),
    removed: receiverNames.filter((name) => !sending.has(name)),
  };
}

/**
 * Cross-party consistency check for a pair of {@link LinkageTerms}.
 *
 * Returns errors for mandatory mismatches that must cancel the exchange,
 * and warnings for soft mismatches (currently only `date`) that produce a
 * notice but allow the exchange to continue.
 *
 * Every diagnostic it composes names its terms values through the
 * delimiting boundary in `config/compatibilityMessage.ts`, so no value a
 * partner chooses can close a delimiter or spell a second clause of
 * Alcove's own prose. Enforced by type: the two accumulators hold
 * `CompatibilityMessageFragment`, so a message composed any other way does
 * not compile. `test/config/compatibilityMessage.test.ts` drives adversarial value
 * shapes through each message and asserts the clause structure holds.
 */
export function validateCompatibility(
  local: LinkageTerms,
  partner: LinkageTerms,
): CompatibilityResult {
  const comparison = compareTerms(local, partner);
  const errors = [...comparison.delta.otherTerms];
  if (comparison.sentMessage !== undefined) errors.push(comparison.sentMessage);
  if (comparison.receivedMessage !== undefined)
    errors.push(comparison.receivedMessage);
  return { errors, warnings: comparison.warnings, delta: comparison.delta };
}

/**
 * The comparison {@link validateCompatibility} reports, each payload direction
 * kept apart, with the partner held to `baselines` where given.
 */
export function compareTerms(
  local: LinkageTerms,
  partner: LinkageTerms,
  baselines: TermsBaselines = {},
): TermsComparison {
  // Both accumulators hold CompatibilityMessageFragment rather than string, which
  // is the whole of the sweep below: a diagnostic reaches either list only
  // through the compatibilityMessage tagged template, whose interpolations are
  // fragments and whose fixed spans the compiler supplies. So a terms value put
  // into a message without passing the delimiting boundary -- an edit to a
  // message here, or a mismatch check added later -- does not compile. Both
  // lists are returned as the `string[]` of CompatibilityResult, which the
  // brand is transparent to.
  const errors: CompatibilityMessageFragment[] = [];
  const warnings: CompatibilityMessageFragment[] = [];

  // Both arrays below answer the same threat: a mutually-distrusting
  // partner controls reference/purpose/set/column names, and controls them
  // on the side these messages call "local" too, since
  // deriveAcceptedLinkageTerms adopts the inviter's legalAgreement and
  // linkageRuleSet verbatim.
  //
  // DELIMITING is applied here, at composition, to every value either list
  // names (config/compatibilityMessage.ts). ESCAPING stays assigned to one
  // altitude per route: `errors` becomes an Error message, escaped once by
  // sanitizeErrorForDisplay where it is shown, so the values inside the
  // delimiters are the RAW ones; `warnings` is handed to the caller as
  // display text with no error to hold it, so it is escaped and redacted
  // here. The CLI escapes each warning again downstream, which stays
  // unobservable because every value interpolated below is
  // schema-constrained to a shape the escape does not rewrite. Full
  // reasoning: docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape
  // format".
  //
  // The equality CHECKS always compare the RAW values either way -- both
  // transforms are display-only and the escape is lossy, so comparing
  // transformed forms could mask a genuine mismatch.
  if (local.version !== partner.version) {
    // TODO: implement migration when new versions exist
    errors.push(
      compatibilityMessage`version mismatch: local is ${bareTermsValue(local.version)}, partner is ${bareTermsValue(partner.version)}`,
    );
  }

  if (local.algorithm !== partner.algorithm) {
    errors.push(
      compatibilityMessage`algorithm mismatch: local is ${bareTermsValue(local.algorithm)}, partner is ${bareTermsValue(partner.algorithm)}`,
    );
  }

  // Strictly consistent, like algorithm: both parties must use the same strategy
  // or they would compute different matches. The schema fills in "cascade" when
  // omitted, so the value is always present and compared directly.
  if (local.linkageStrategy !== partner.linkageStrategy) {
    errors.push(
      compatibilityMessage`linkage strategy mismatch: local is ${bareTermsValue(local.linkageStrategy)}, partner is ${bareTermsValue(partner.linkageStrategy)}`,
    );
  }

  // Each branch spells its whole sentence rather than interpolating a phrase
  // chosen by a ternary: the four readings are fixed first-party copy, and
  // writing them out is what lets the tagged template above hold for every
  // message in this function without a `string` step for a first-party fragment
  // to slip through.
  if (local.output.shareWithPartner !== partner.output.expectsOutput) {
    errors.push(
      local.output.shareWithPartner
        ? compatibilityMessage`output mismatch: local will share with partner, but partner does not expect output`
        : compatibilityMessage`output mismatch: local will not share with partner, but partner expects output`,
    );
  }
  if (local.output.expectsOutput !== partner.output.shareWithPartner) {
    errors.push(
      local.output.expectsOutput
        ? compatibilityMessage`output mismatch: local expects output, but partner will not share`
        : compatibilityMessage`output mismatch: local does not expect output, but partner will share`,
    );
  }
  if (!local.output.expectsOutput && !partner.output.expectsOutput) {
    errors.push(compatibilityMessage`neither party expects output`);
  }

  if (local.date !== partner.date) {
    warnings.push(
      compatibilityMessage`date mismatch: local is ${bareTermsValue(redactAndSanitizeForDisplay(local.date))}, partner is ${bareTermsValue(redactAndSanitizeForDisplay(partner.date))}; one party may have a stale copy of the linkage terms`,
    );
  }

  // Compare by canonical form (RFC 8785): two field/key sets are equal iff
  // their canonical encodings match -- the same encoding hashed into the
  // exchange-agreement receipt, so equality here means hash-equality there.
  // The canonical encoder sorts keys, so property-insertion order does not
  // affect the result; fields are pre-sorted by name (their array order is
  // not significant), while linkage keys are ordered most-to-least precise
  // and compared in place.
  //
  // No casing fold is applied here: `transform.params` keys are normalized
  // to camelCase at every parse chokepoint that produces a LinkageTerms, so
  // both sides reach this comparison in the one camelCase form already.
  //
  // canonicalString throws CanonicalEncodingError on a value outside the
  // reproducible domain -- a partner can reach this via a `transform.params`
  // JSON integer beyond 2^53. validateCompatibility's contract is to report
  // problems via `errors`, not to throw, so such a value becomes an error
  // instead of a crash.
  //
  // When canonicalOrError returns null the value could not be encoded, so
  // the mismatch comparisons below are skipped for that side: an
  // un-encodable value cannot be compared, and the encoding error already
  // aborts the exchange.
  //
  // `label` is first-party copy composed through the same tagged template;
  // the encoder's own message is delimited, naming the offending JSON path.
  const canonicalOrError = (
    value: unknown,
    label: CompatibilityMessageFragment,
  ): string | null => {
    try {
      return canonicalString(value);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        errors.push(
          compatibilityMessage`${label} cannot be canonically encoded: ${quoteTermsValue(err.message)}`,
        );
        return null;
      }
      throw err;
    }
  };

  const localFields = [...local.linkageFields].sort(linkageFieldsByName);
  const partnerFields = [...partner.linkageFields].sort(linkageFieldsByName);
  const localFieldsCanonical = canonicalOrError(
    localFields,
    compatibilityMessage`local linkage fields`,
  );
  const partnerFieldsCanonical = canonicalOrError(
    partnerFields,
    compatibilityMessage`partner linkage fields`,
  );
  if (
    localFieldsCanonical !== null &&
    partnerFieldsCanonical !== null &&
    localFieldsCanonical !== partnerFieldsCanonical
  ) {
    errors.push(
      compatibilityMessage`linkage fields do not match${namedEntryDifferences(
        localFields,
        partnerFields,
        compatibilityMessage`fields`,
      )}`,
    );
  }

  const localKeysCanonical = canonicalOrError(
    local.linkageKeys,
    compatibilityMessage`local linkage keys`,
  );
  const partnerKeysCanonical = canonicalOrError(
    partner.linkageKeys,
    compatibilityMessage`partner linkage keys`,
  );
  if (
    localKeysCanonical !== null &&
    partnerKeysCanonical !== null &&
    localKeysCanonical !== partnerKeysCanonical
  ) {
    errors.push(
      compatibilityMessage`linkage keys do not match${namedEntryDifferences(
        local.linkageKeys,
        partner.linkageKeys,
        compatibilityMessage`keys`,
      )}`,
    );
  }

  // The rule-set citation, checked only where BOTH parties declare one. It
  // names rules the two documents already had to agree on field by field
  // and key by key, so a disagreement here is a disagreement about the NAME
  // of matching content -- which still cancels, since each party records
  // its own citation in its own exchange record. Skipped where either party
  // declares none: a hand-authored document has no citation, and holding it
  // to the partner's would refuse an exchange whose rules match exactly.
  // Compared by canonical form, like the fields and keys above. The set
  // names are delimited by describeRuleSet, and the values inside those
  // delimiters stay raw for the same reason the legal-agreement mismatches
  // below are: an error is escaped once where it is shown.
  if (
    local.linkageRuleSet !== undefined &&
    partner.linkageRuleSet !== undefined
  ) {
    const localRuleSet = canonicalOrError(
      local.linkageRuleSet,
      compatibilityMessage`local linkage rule set`,
    );
    const partnerRuleSet = canonicalOrError(
      partner.linkageRuleSet,
      compatibilityMessage`partner linkage rule set`,
    );
    if (
      localRuleSet !== null &&
      partnerRuleSet !== null &&
      localRuleSet !== partnerRuleSet
    ) {
      errors.push(
        compatibilityMessage`linkage rule set mismatch: local names ${describeRuleSet(local.linkageRuleSet)}, partner names ${describeRuleSet(partner.linkageRuleSet)}`,
      );
    }
  }

  if (
    local.legalAgreement !== undefined ||
    partner.legalAgreement !== undefined
  ) {
    if (local.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`partner has a legal agreement but local does not`,
      );
    } else if (partner.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`local has a legal agreement but partner does not`,
      );
    } else {
      if (local.legalAgreement.reference !== partner.legalAgreement.reference) {
        errors.push(
          compatibilityMessage`legal agreement reference mismatch: local is ${quoteTermsValue(local.legalAgreement.reference)}, partner is ${quoteTermsValue(partner.legalAgreement.reference)}`,
        );
      }
      if (local.legalAgreement.purpose !== partner.legalAgreement.purpose) {
        errors.push(
          compatibilityMessage`legal agreement purpose mismatch: local is ${quoteTermsValue(local.legalAgreement.purpose)}, partner is ${quoteTermsValue(partner.legalAgreement.purpose)}`,
        );
      }
      if (
        local.legalAgreement.expirationDate !==
        partner.legalAgreement.expirationDate
      ) {
        errors.push(
          compatibilityMessage`legal agreement expiration date mismatch: local is ${bareTermsValue(local.legalAgreement.expirationDate)}, partner is ${bareTermsValue(partner.legalAgreement.expirationDate)}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (local.legalAgreement.expirationDate < today) {
        errors.push(
          compatibilityMessage`legal agreement expired on ${bareTermsValue(local.legalAgreement.expirationDate)}`,
        );
      }
    }
  }

  // Payload mirror, LAZY on the receive side. Each of the two directions is
  // gated on whether the RECEIVING party declared a `payload.receive`
  // expectation:
  //
  // - `receive` DECLARED (present, even if empty) asserts "I expect exactly
  //   these columns": the partner's `send` must match it byte-for-byte or
  //   the exchange aborts. An explicit empty `receive: []` is strict BY
  //   INTENT -- "the partner sends nothing" -- distinct from an absent
  //   `receive`, as the web consent display shows: a declared-empty receive
  //   renders as a "(none)" commitment, not lazy.
  // - `receive` ABSENT means "take whatever I'm given": that direction is
  //   skipped here. This is what lets the invite/accept flow reconcile
  //   without the inviter knowing the acceptor's schema. A recurring run then
  //   fills the absent list from the partner's declared `send`
  //   (`payloadReceiveFillsOnFirstRun`, runExchange), so the next run is
  //   strict; a one-off run leaves it absent.
  //
  // Laziness relaxes only this cross-party DECLARATION check; it never
  // widens what a party sends, which each party's own metadata governs
  // (`isDisclosedToPartner`). The gate is symmetric: each direction keys on the same
  // receiver's declared `receive`, so the two parties (which call this with
  // swapped arguments) compute identical verdicts. The equality is
  // byte-exact and element-wise -- compared per sorted column, NOT by a
  // delimiter-joined string, so a partner-controlled name containing the
  // separator cannot make two distinct sets join equal (`["a,b"]` vs
  // `["a","b"]`) and slip a genuine mismatch past the check.
  const sameColumnSet = (a: Array<string>, b: Array<string>): boolean =>
    a.length === b.length && a.every((name, i) => name === b[i]);

  // One direction of the payload mirror: the receiver's declared `receive` must
  // match the sender's `send`, byte-exact and element-wise. Both directions share
  // the sort/compare/delimit-join logic; only the two messages vary, so they are
  // supplied by the caller (emptyReceiveMessage for the strict empty `receive: []`
  // case, mismatchMessage otherwise).
  const checkPayloadDirection = (
    receiverReceive: ReadonlyArray<string>,
    senderSend: ReadonlyArray<PayloadColumn>,
    messages: {
      emptyReceiveMessage: (
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
      mismatchMessage: (
        receiverShown: CompatibilityMessageFragment,
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
    },
  ): { change: PayloadColumnsChange; message: string } | undefined => {
    const receiverNames = [...receiverReceive].sort();
    const senderNames = senderSend.map((c) => c.name).sort();
    if (sameColumnSet(senderNames, receiverNames)) return undefined;
    const receiverShown = quoteTermsValueList(receiverNames);
    const senderShown = quoteTermsValueList(senderNames);
    return {
      change: columnsChange(receiverNames, senderNames),
      message:
        receiverNames.length === 0
          ? messages.emptyReceiveMessage(senderShown)
          : messages.mismatchMessage(receiverShown, senderShown),
    };
  };
  const namesOf = (columns: ReadonlyArray<PayloadColumn>): string[] =>
    columns.map((column) => column.name);

  const sent =
    partner.payload?.receive === undefined
      ? undefined
      : checkPayloadDirection(
          namesOf(partner.payload.receive),
          local.payload?.send ?? [],
          {
            // An empty partner receive is the strict "partner expects no
            // payload" declaration (see the gate comment above); spell that
            // out rather than printing an empty bracket pair that reads like
            // a rendering glitch.
            emptyReceiveMessage: (localShown) =>
              compatibilityMessage`payload mismatch: partner declared an empty payload.receive (asserting local sends no payload columns), but local sends [${localShown}]`,
            mismatchMessage: (partnerShown, localShown) =>
              compatibilityMessage`payload mismatch: local send columns [${localShown}] do not match partner receive columns [${partnerShown}]`,
          },
        );

  const localReceive =
    local.payload?.receive === undefined
      ? undefined
      : namesOf(local.payload.receive);
  const received =
    localReceive === undefined
      ? undefined
      : checkPayloadDirection(localReceive, partner.payload?.send ?? [], {
          // An empty local receive is the strict "I expect no payload"
          // declaration; name it and point the operator at the unset
          // alternative, since a hand-authored `receive: []` is the most
          // likely way to land here.
          emptyReceiveMessage: (partnerShown) =>
            compatibilityMessage`payload mismatch: local declared an empty payload.receive (asserting partner sends no payload columns), but partner sends [${partnerShown}]. To receive the partner's columns, remove payload.receive: a recurring exchange sets it from the partner's declared columns on its next run and holds the partner to them after that.`,
          mismatchMessage: (localShown, partnerShown) =>
            compatibilityMessage`payload mismatch: local receive columns [${localShown}] do not match partner send columns [${partnerShown}]`,
        });

  const expectedDeduplicate = baselines.partnerDeduplicate;
  const partnerDeduplicate =
    expectedDeduplicate === undefined ||
    expectedDeduplicate === partner.deduplicate
      ? undefined
      : { expected: expectedDeduplicate, presented: partner.deduplicate };

  return {
    delta: {
      received: received?.change,
      sent: sent?.change,
      partnerDeduplicate,
      otherTerms: errors,
    },
    warnings,
    receivedMessage: received?.message,
    sentMessage: sent?.message,
    partnerDeduplicateMessage:
      partnerDeduplicate === undefined
        ? undefined
        : compatibilityMessage`partner deduplicate mismatch: local expects ${bareTermsValue(String(partnerDeduplicate.expected))}, partner is ${bareTermsValue(String(partnerDeduplicate.presented))}`,
  };
}

/**
 * This party's terms with the partner's adopted, as `alcove apply` adopts
 * them from a terms update: every agreed field is the partner's, `output` and
 * `payload` are mirrored, and `identity` and `deduplicate` stay this party's
 * own. A partner stating no receive list leaves this party's send list as it
 * was, except under count-only terms and where the partner expects no output,
 * which send nothing. Undefined where
 * the result is not a valid terms document.
 */
export function termsAdoptingPartnerTerms(
  local: LinkageTerms,
  partner: LinkageTerms,
): LinkageTerms | undefined {
  const {
    identity: _partnerIdentity,
    payload: partnerPayload,
    ...agreed
  } = partner;
  const adopted: LinkageTerms = {
    ...agreed,
    ...(local.identity !== undefined ? { identity: local.identity } : {}),
    deduplicate: local.deduplicate,
    output: {
      expectsOutput: partner.output.shareWithPartner,
      shareWithPartner: partner.output.expectsOutput,
    },
  };
  // A partner sharing output with no stated send list sends nothing: an absent
  // receive list here would accept whatever columns it sends.
  const partnerSend: PayloadColumn[] | undefined =
    partnerPayload?.send ?? (partner.output.shareWithPartner ? [] : undefined);
  const sendsNothing =
    adopted.algorithm === "psi-c" || !adopted.output.shareWithPartner;
  const send =
    partnerPayload?.receive ?? (sendsNothing ? undefined : local.payload?.send);
  if (
    partnerPayload !== undefined ||
    send !== undefined ||
    partnerSend !== undefined
  ) {
    const mirrored: Payload = {};
    if (send !== undefined) mirrored.send = send;
    if (partnerSend !== undefined) mirrored.receive = partnerSend;
    adopted.payload = mirrored;
  }
  return LinkageTermsSchema.safeParse(adopted).success ? adopted : undefined;
}

/**
 * This party's terms with its received payload set taken from the partner's
 * stated send set, each column by name alone, and nothing else changed.
 * Undefined where the result is not a valid terms document.
 */
export function termsReceivingPartnerSend(
  local: LinkageTerms,
  partner: LinkageTerms,
): LinkageTerms | undefined {
  const adopted: LinkageTerms = {
    ...local,
    payload: {
      ...local.payload,
      receive: (partner.payload?.send ?? []).map(({ name }) => ({ name })),
    },
  };
  return LinkageTermsSchema.safeParse(adopted).success ? adopted : undefined;
}

// The terms whose difference a run already prepared can take on without
// re-reading its input: the rest shape the linkage keys, the record count and
// payload disclosure the terms exchange has already advertised.
const TERMS_A_PREPARED_RUN_CAN_ADOPT = [
  "identity",
  "date",
  "deduplicate",
  "payload",
  "legalAgreement",
  "linkageRuleSet",
] as const;

/**
 * Whether a run prepared under `prepared` can run under `adopted` instead:
 * the two differ in none of the terms that shape its keys, its record count,
 * or what it advertised it discloses.
 */
export function adoptableWithoutPreparing(
  prepared: LinkageTerms,
  adopted: LinkageTerms,
): boolean {
  const shaping = (terms: LinkageTerms): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...partnerBoundTerms(terms) };
    for (const field of TERMS_A_PREPARED_RUN_CAN_ADOPT) delete copy[field];
    return copy;
  };
  try {
    return (
      canonicalString(shaping(prepared)) === canonicalString(shaping(adopted))
    );
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return false;
    throw err;
  }
}
