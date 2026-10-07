import type {
  CompatibilityMessageFragment,
  LinkageRuleSetReference,
  LinkageTerms,
} from "@alcove/core";
import {
  bareTermsValue,
  canonicalString,
  CanonicalEncodingError,
  clipToRenderedCost,
  compatibilityMessage,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  keepFirstPartyLineBreaks,
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  quoteTermsValue,
  quoteTermsValueList,
  redactPrivateKeyMaterial,
  renderedDisplayCost,
  renderedDisplayCostKeepingLineBreaks,
  replaceControlCharactersForDisplay,
  trimPartialControlCharacterMarker,
  UsageError,
} from "@alcove/core";

/**
 * One field that disagrees between a pre-existing configuration file and the
 * source it is reconciled against -- an invitation's linkage terms, or (for the
 * connection block, online) an accept URL. Collected into the user-facing
 * "resolve the conflict" error so the user sees exactly what differs.
 */
export interface ReconcileDiff {
  /**
   * snake_case field path as it appears in `alcove.yaml` (e.g. `algorithm`,
   * `linkage_keys`, `connection.server.host`). First-party text: every producer
   * supplies a literal, and it is what the conflict line's own structure is
   * built from.
   */
  field: string;
  /**
   * Rendering of the value in the pre-existing config; `(unset)` when absent.
   *
   * A fragment rather than a `string`, so a value cannot be interpolated into
   * a conflict line without passing through {@link reconcileDiffValue} (or a
   * renderer beside it) first.
   */
  existing: CompatibilityMessageFragment;
  /** Rendering of the value the invitation or URL requires. */
  incoming: CompatibilityMessageFragment;
  /**
   * How each side is fitted where the line's slot cannot hold it whole.
   *
   * Absent when a side is one delimited run: the slot's clip degrades that
   * run directly. Supplied when a side is a CLAUSE -- several values inside
   * first-party structure -- so the slot's share divides among those values
   * instead of being spent left to right on the first of them (see
   * {@link reconcileClause}).
   */
  fit?: ReconcileDiffFit;
}

/**
 * The two sides of one conflict line as claims on the block's budget.
 *
 * Held BESIDE the sides rather than in place of them, and produced by the one
 * composition that produced those sides ({@link reconcileClause}), so a fitted
 * side cannot describe a different clause than the unfitted one it replaces.
 */
export interface ReconcileDiffFit {
  existing: ReconcileSideFit;
  incoming: ReconcileSideFit;
}

/**
 * What one side of a conflict line needs, what it cannot go below, and how it
 * renders at what it is given.
 *
 * The two measurements are what makes the block's allocation NEED-AWARE rather
 * than count-driven ({@link formatReconcileDiffs}): a side takes only `need`,
 * and what it leaves is available to the sides that exceed their share, so the
 * count of disagreeing fields no longer decides on its own whether any value is
 * shown.
 */
export interface ReconcileSideFit {
  /** Rendered cost of this side whole, which is all it can ever spend. */
  need: number;
  /**
   * Least this side can be given and still display as what it is. A side given
   * less than the smaller of this and its `need` is not fitted at all: its LINE
   * names its field and drops both values, which costs the operator less than a
   * clause cut back to punctuation and truncation markers.
   */
  minimum: number;
  /** This side rendered into `budget`. */
  fit: (budget: number) => string;
}

/** Placeholder rendered for an absent value in a {@link ReconcileDiff}. */
export const RECONCILE_UNSET = compatibilityMessage`(unset)`;

/**
 * One value somebody else chose, treated for a reconcile conflict line and
 * delimited as one run through core's terms-value grammar by
 * {@link quoteTermsValue}, which redacts the value itself before delimiting
 * it. This wrapper's own redaction ahead of that call is defense in depth:
 * {@link redactPrivateKeyMaterial} is idempotent, so a second pass over a
 * value {@link quoteTermsValue} already redacts is inert.
 */
export function reconcileDiffValue(
  value: string,
): CompatibilityMessageFragment {
  return quoteTermsValue(redactPrivateKeyMaterial(value));
}

/**
 * The same treatment for a value the linkage-terms schema constrains to a shape
 * no clause boundary is made of -- a semver string, an ISO date -- rendered
 * undelimited by {@link bareTermsValue}, which redacts the value itself before
 * checking that shape. This wrapper's own redaction ahead of that call is
 * defense in depth, and a second pass over a value {@link bareTermsValue}
 * already redacts is inert.
 */
function reconcileDiffBareValue(value: string): CompatibilityMessageFragment {
  return bareTermsValue(redactPrivateKeyMaterial(value));
}

const DISPLAY_TRUNCATION_MARKER_COST = renderedDisplayCost(
  DISPLAY_TRUNCATION_MARKER,
);

/**
 * The delimiter core's terms-value grammar wraps a value in and doubles
 * inside one, read off that grammar rather than restated, so the fit below
 * cannot drift from it.
 */
const TERMS_VALUE_DELIMITER = quoteTermsValue("")[0];

const TERMS_VALUE_DELIMITER_COST = renderedDisplayCost(TERMS_VALUE_DELIMITER);

/**
 * Fit a composed conflict-line fragment to `budget`, cutting the VALUE inside
 * a delimited run rather than the run's rendering: a cut never falls between
 * the two characters of a doubled delimiter, and a cut inside a run closes it
 * (truncation marker, then delimiter) rather than leaving it open. Unlike
 * core's {@link clipToRenderedCost}, which cuts the rendered form and can
 * leave a run open mid-cut, misreading everything composed after it at the
 * wrong run parity. A partial control-character marker is trimmed off the
 * kept prefix ({@link trimPartialControlCharacterMarker}) before the closing
 * marker and delimiter are appended.
 */
function fitToRenderedCostClosingRuns(text: string, budget: number): string {
  if (renderedDisplayCost(text) <= budget) return text;
  const units = Array.from(text);
  let kept = "";
  let cost = 0;
  let insideRun = false;
  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    const delimiter = unit === TERMS_VALUE_DELIMITER;
    const doubled: boolean =
      delimiter && insideRun && units[index + 1] === TERMS_VALUE_DELIMITER;
    const taken = doubled ? unit + unit : unit;
    const nextInsideRun: boolean =
      delimiter && !doubled ? !insideRun : insideRun;
    const spent = cost + renderedDisplayCost(taken);
    // What closing this cut costs is reserved before the unit is kept, so the
    // run this enters is one the budget can still close.
    const closing = nextInsideRun ? TERMS_VALUE_DELIMITER_COST : 0;
    if (spent + DISPLAY_TRUNCATION_MARKER_COST + closing > budget) break;
    kept += taken;
    cost = spent;
    insideRun = nextInsideRun;
    index += doubled ? 2 : 1;
  }
  return `${trimPartialControlCharacterMarker(kept)}${DISPLAY_TRUNCATION_MARKER}${insideRun ? TERMS_VALUE_DELIMITER : ""}`;
}

/**
 * Least a conflict line may spend on ONE of its two values while still
 * showing any of that value's own bytes. A fitted value pays for its
 * delimiters and, when cut, the truncation marker; below this floor a side
 * renders as punctuation and a marker with nothing of the value inside. A
 * line whose sides cannot both reach this is named without its values
 * instead ({@link formatReconcileDiffs}).
 */
const RECONCILE_MIN_VALUE_BUDGET = 32;

/**
 * The same floor for ONE value inside a clause. Sized off the truncation
 * marker's own cost: at or below it a clipped value renders as a run with
 * nothing of its own inside. Smaller than the whole-side floor above, since a
 * clause fits several values into a slot sized for one side.
 */
const RECONCILE_MIN_CLAUSE_VALUE_BUDGET = DISPLAY_TRUNCATION_MARKER_COST + 8;

/**
 * Divide `budget` among claims of the given `needs`, need-aware: a claim
 * takes only what it needs, and what it leaves is available to claims that
 * exceed an equal share, so the constraint falls only on claims too wide for
 * the room. Serving claims in ascending order decides this in one pass:
 * every claim still unserved is at least as wide as the one being served.
 */
function allocateByNeed(needs: readonly number[], budget: number): number[] {
  const shares = needs.map(() => 0);
  const ascending = needs
    .map((_, index) => index)
    .sort((a, b) => needs[a] - needs[b]);
  let remaining = Math.max(0, budget);
  for (let served = 0; served < ascending.length; served += 1) {
    const share = Math.floor(remaining / (ascending.length - served));
    if (needs[ascending[served]] > share) {
      // Every claim still unserved is at least this wide, so they all take the
      // same share; what the division leaves over goes unspent rather than to
      // whichever claim was served last, so two claims of equal need render
      // alike.
      for (let rest = served; rest < ascending.length; rest += 1)
        shares[ascending[rest]] = share;
      break;
    }
    shares[ascending[served]] = needs[ascending[served]];
    remaining -= needs[ascending[served]];
  }
  return shares;
}

/**
 * One side of a conflict line built from more than one value: the clause whole,
 * what it claims on the block's budget, and the same clause fitted to a budget.
 */
export interface ReconcileClause extends ReconcileSideFit {
  /** Every value at its full width, for a slot that can hold them. */
  text: CompatibilityMessageFragment;
}

/**
 * Compose a conflict line's side as a tagged template, keeping the values
 * apart from the first-party spans around them so a slot too small for the
 * whole clause is divided among the VALUES, not spent left to right (which
 * would delete the connective and everything behind the first value). A
 * share too small for its value degrades only that value's own bytes: the
 * fit cuts inside the run and delimits what it kept
 * ({@link fitToRenderedCostClosingRuns}). The fitted form is a plain string,
 * not a fragment, since it is composed by concatenation; a test over the
 * rendered lines holds the run structure instead (config.test.ts).
 */
export function reconcileClause(
  fixedSpans: TemplateStringsArray,
  ...values: readonly CompatibilityMessageFragment[]
): ReconcileClause {
  const structureCost = renderedDisplayCost(fixedSpans.join(""));
  const needs = values.map((value) => renderedDisplayCost(value));
  return {
    text: compatibilityMessage(fixedSpans, ...values),
    need: needs.reduce((total, need) => total + need, structureCost),
    // The spans do not shrink and every value the clause names has to stay
    // visible inside them, so this is what the clause structurally is. A value
    // already narrower than the floor asks for its own width instead, which is
    // the same rule the block applies to a side.
    minimum: needs.reduce(
      (total, need) =>
        total + Math.min(need, RECONCILE_MIN_CLAUSE_VALUE_BUDGET),
      structureCost,
    ),
    fit: (budget: number): string => {
      const shares = allocateByNeed(needs, Math.max(0, budget - structureCost));
      let composed: string = fixedSpans[0];
      for (let index = 0; index < values.length; index += 1)
        composed +=
          fitToRenderedCostClosingRuns(values[index], shares[index]) +
          fixedSpans[index + 1];
      // A share below what the marker and delimiters cost leaves a clipped
      // value wider than its share, so the composed clause is held to the
      // slot it was given. This is a fallback for a budget reached some other
      // way; the block's own floor keeps a fitted line off that shape.
      return fitToRenderedCostClosingRuns(composed, budget);
    },
  };
}

/**
 * One delimited run as a clause side, for a conflict line whose OTHER side is a
 * clause: the line's fit covers both sides, and this one has nothing inside it
 * to partition -- the slot's clip degrades the single run and takes nothing else
 * with it.
 */
export function reconcileValueClause(value: string): ReconcileClause {
  const text = reconcileDiffValue(value);
  return {
    text,
    need: renderedDisplayCost(text),
    minimum: RECONCILE_MIN_VALUE_BUDGET,
    fit: (budget: number): string => fitToRenderedCostClosingRuns(text, budget),
  };
}

/**
 * The side of a conflict on an OPTIONAL block that names no chosen value at all,
 * as a clause -- so a line whose other side is one can hold a fit for both of
 * its sides. Nothing here to sub-partition: the placeholder is first-party copy,
 * so it asks for exactly its own width and is held to the slot it was given.
 */
const RECONCILE_ABSENT_CLAUSE: ReconcileClause = {
  text: RECONCILE_UNSET,
  need: renderedDisplayCost(RECONCILE_UNSET),
  minimum: renderedDisplayCost(RECONCILE_UNSET),
  fit: (budget: number): string =>
    fitToRenderedCostClosingRuns(RECONCILE_UNSET, budget),
};

/**
 * One conflict line whose two sides are clauses: the sides themselves, and the
 * per-side fit beside them.
 *
 * Both come from the composition that produced the sides
 * ({@link reconcileClause}), which is what keeps a fitted side an account of the
 * same clause the unfitted one is.
 */
export function reconcileClauseConflict(
  existing: ReconcileClause,
  incoming: ReconcileClause,
): Omit<ReconcileDiff, "field"> {
  return {
    existing: existing.text,
    incoming: incoming.text,
    fit: { existing, incoming },
  };
}

/**
 * Recursively drop every key whose value is `undefined` from a JSON-like
 * value, preserving the rest of its structure, so an absent key and an
 * explicitly-`undefined` one compare equal to {@link canonicalString} (which
 * rejects `undefined`). Strings pass through untouched, normalization form
 * included, since the compare this feeds is byte-exact (see
 * {@link diffLinkageTerms}).
 *
 * `depth` bounds the native recursion at {@link MAX_NESTING_DEPTH}. Both
 * sides reach this walk already depth-bounded upstream, but this is the
 * walk's own check: an unguarded deep value overflows with an uncaught
 * `RangeError` instead of the clean {@link NestingDepthExceededError}
 * (`UsageError`, exit 64) this raises well ahead of the real limit. See
 * docs/spec/CHANNEL_SECURITY.md.
 */
function withoutUndefinedDeep(value: unknown, depth = 0): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  if (Array.isArray(value))
    return value.map((v) => withoutUndefinedDeep(v, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, withoutUndefinedDeep(v, depth + 1)]),
    );
  return value;
}

/**
 * Canonical (RFC 8785) encoding of a value for the reconcile's structural
 * equality check, byte-exact over the strings inside it. Object keys are
 * sorted; array order is preserved, so the caller pre-sorts any list whose
 * order is not significant.
 *
 * No key-casing fold is applied: `transform.params` keys are normalized to
 * camelCase upstream on every parse path that produces these terms, so both
 * sides reach this compare already in that form.
 */
function reconcileCanonical(value: unknown): string {
  return canonicalString(withoutUndefinedDeep(value));
}

/**
 * Render the identifiers of a list of named entries (linkage fields/keys,
 * payload columns) for a diff line, in the order given. Each name is
 * delimited on its own rather than the joined list once, so `a,b` as one
 * entry renders differently from `a` and `b` as two.
 */
function renderNames(
  list: ReadonlyArray<{ name: string }>,
): CompatibilityMessageFragment {
  return compatibilityMessage`[${quoteTermsValueList(
    list.map((e) => redactPrivateKeyMaterial(e.name)),
  )}]`;
}

/**
 * When the two rendered sides of a diff come out identical despite a
 * canonical difference -- e.g. values sharing every name but differing in a
 * sub-field -- fall back to the full JSON of each value, so the conflict
 * message shows what actually differs. The JSON is of whatever the caller
 * hands it, not the form the comparison encoded, so the user sees the stored
 * values to edit. It takes the same treatment as the summary form
 * ({@link reconcileDiffValue}), over the serialized text rather than value by
 * value.
 */
function disambiguate(
  existingRendered: CompatibilityMessageFragment,
  incomingRendered: CompatibilityMessageFragment,
  existingValue: unknown,
  incomingValue: unknown,
): {
  existing: CompatibilityMessageFragment;
  incoming: CompatibilityMessageFragment;
} {
  if (existingRendered === incomingRendered)
    return {
      existing: reconcileDiffValue(JSON.stringify(existingValue)),
      incoming: reconcileDiffValue(JSON.stringify(incomingValue)),
    };
  return { existing: existingRendered, incoming: incomingRendered };
}

/** Render the existing/incoming sides of a structural-list (linkage fields/keys)
 *  conflict: names when the lists differ by name, else the full JSON. */
function renderStructural(
  existing: ReadonlyArray<{ name: string }>,
  incoming: ReadonlyArray<{ name: string }>,
): {
  existing: CompatibilityMessageFragment;
  incoming: CompatibilityMessageFragment;
} {
  return disambiguate(
    renderNames(existing),
    renderNames(incoming),
    existing,
    incoming,
  );
}

/**
 * Render a rule-set citation for a diff line, keys first -- the order core's
 * own mismatch message and the drift warning both use, so the two accounts
 * of one citation cannot drift apart on how a name is delimited. Unescaped,
 * unlike {@link describeRuleSetCitation}: a diff line is composed into a
 * {@link UsageError} and escaped once where it is shown. All four values
 * stand in ONE clause rather than two nested halves, so the
 * {@link reconcileClause} sub-partition runs once rather than dividing a
 * quarter share twice over.
 */
function renderRuleSetCitation(
  reference: LinkageRuleSetReference,
): ReconcileClause {
  return reconcileClause`${reconcileDiffValue(reference.keySet.name)} ${reconcileDiffBareValue(reference.keySet.version)} over ${reconcileDiffValue(reference.fieldSet.name)} ${reconcileDiffBareValue(reference.fieldSet.version)}`;
}

/**
 * The two sides of a `linkage_rule_set` conflict, each as its clause.
 *
 * No full-detail fallback beside it, unlike the structural lists: the clause
 * is built from delimited runs and a checked bare form, which no two
 * different citations can spell alike, so two clauses that read the same are
 * citations whose difference redaction took out. {@link formatReconcileDiffs}
 * is where a pair that reads alike is reported.
 */
function renderRuleSetCitationConflict(
  existing: LinkageRuleSetReference,
  incoming: LinkageRuleSetReference,
): Omit<ReconcileDiff, "field"> {
  return reconcileClauseConflict(
    renderRuleSetCitation(existing),
    renderRuleSetCitation(incoming),
  );
}

/**
 * Compare a pre-existing config's linkage terms against the terms an
 * acceptance would adopt from the invitation, returning the mandatory
 * disagreements that must abort the acceptance and the soft mismatches that
 * only warn.
 *
 * This is an equality check ("do these describe the same exchange
 * agreement?"), not the cross-party {@link validateCompatibility} (which
 * checks that two different parties' terms work together). The
 * agreement-defining fields -- version, algorithm, linkage strategy, linkage
 * fields and keys, the rule-set citation (where both sides declare one),
 * legal agreement, and payload -- must match; per-party fields (`identity`,
 * `output`, `deduplicate`) are excluded, since each party legitimately holds
 * its own value. `date` is soft, matching `validateCompatibility`.
 *
 * Every value is compared BYTE-EXACT (canonical form, or string equality for
 * a schema-constrained scalar), matching the predicate `validateCompatibility`
 * applies to the same values -- so a pair differing only in Unicode
 * normalization is a mismatch here too, reported at accept rather than
 * aborting mid-exchange later. On the payload this compare is stricter than
 * core (a column's `description` takes part here; core cross-checks only
 * names), an asymmetry that only refuses a reuse the operator can still make
 * onto a fresh config.
 */
export function diffLinkageTerms(
  existing: LinkageTerms,
  incoming: LinkageTerms,
): { conflicts: ReconcileDiff[]; warnings: string[] } {
  const conflicts: ReconcileDiff[] = [];
  const warnings: string[] = [];
  const add = (
    field: string,
    a: CompatibilityMessageFragment,
    b: CompatibilityMessageFragment,
  ): void => {
    conflicts.push({ field, existing: a, incoming: b });
  };

  // canonicalString rejects a value it cannot encode (e.g. an integer outside
  // the JSON-safe range in a transform param). Wrapped so an un-encodable
  // value warns rather than aborting the reconcile on two otherwise-identical
  // configs; validateCompatibility re-checks compatibility at exchange setup
  // and reports it there as a hard error.
  //
  // Only CanonicalEncodingError is softened. NestingDepthExceededError from
  // withoutUndefinedDeep's own depth guard is left to propagate as the
  // terminal usage error for a pathological token, not reconciled-and-deferred.
  const canonicalDiffers = (a: unknown, b: unknown, label: string): boolean => {
    let ca: string;
    let cb: string;
    try {
      ca = reconcileCanonical(a);
      cb = reconcileCanonical(b);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        warnings.push(
          `the ${label} could not be compared against the configuration ` +
            "because a value is outside the JSON-safe range; verify it manually " +
            "(the exchange re-checks compatibility before running)",
        );
        return false;
      }
      throw err;
    }
    return ca !== cb;
  };

  // version, algorithm, and linkageStrategy compare by string equality, not
  // the canonical encoder below: all three are schema-constrained scalars
  // (semver, and two fixed enums), so each one's encoding is the string
  // itself -- the same byte-exact equality validateCompatibility uses.
  if (existing.version !== incoming.version)
    add(
      "version",
      reconcileDiffBareValue(existing.version),
      reconcileDiffBareValue(incoming.version),
    );
  if (existing.algorithm !== incoming.algorithm)
    add(
      "algorithm",
      reconcileDiffValue(existing.algorithm),
      reconcileDiffValue(incoming.algorithm),
    );
  // linkageStrategy is mandatory-consistency like algorithm
  // (validateCompatibility aborts on a mismatch): without this check a reused
  // config could silently diverge from the strategy the acceptor consented
  // to, and the later exchange would abort against the partner only after a
  // false "matches" assurance here.
  if (existing.linkageStrategy !== incoming.linkageStrategy)
    add(
      "linkage_strategy",
      reconcileDiffValue(existing.linkageStrategy),
      reconcileDiffValue(incoming.linkageStrategy),
    );

  // Sort linkage fields by name (order not significant) before comparing;
  // compare linkage keys in place (order is significant). The comparator is
  // core's own -- raw name, UTF-16 code unit order, not localeCompare -- so
  // both sides reach the compare in the order validateCompatibility uses.
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const existingFields = [...existing.linkageFields].sort(byName);
  const incomingFields = [...incoming.linkageFields].sort(byName);
  if (canonicalDiffers(existingFields, incomingFields, "linkage fields")) {
    const r = renderStructural(existingFields, incomingFields);
    add("linkage_fields", r.existing, r.incoming);
  }

  if (
    canonicalDiffers(existing.linkageKeys, incoming.linkageKeys, "linkage keys")
  ) {
    const r = renderStructural(existing.linkageKeys, incoming.linkageKeys);
    add("linkage_keys", r.existing, r.incoming);
  }

  // Only where BOTH sides cite, which is validateCompatibility's own gate for
  // the citation rather than a second rule invented here (see the doc comment).
  if (
    existing.linkageRuleSet !== undefined &&
    incoming.linkageRuleSet !== undefined &&
    canonicalDiffers(
      existing.linkageRuleSet,
      incoming.linkageRuleSet,
      "linkage rule set",
    )
  ) {
    conflicts.push({
      field: "linkage_rule_set",
      ...renderRuleSetCitationConflict(
        existing.linkageRuleSet,
        incoming.linkageRuleSet,
      ),
    });
  }

  // The reference is partner-chosen free text and the expiration date is
  // schema-constrained, so each takes the form its own shape earns, as a
  // clause: a slot too small divides between the two values rather than
  // deleting the expiry.
  const renderAgreement = (
    la: LinkageTerms["legalAgreement"],
  ): ReconcileClause =>
    la === undefined
      ? RECONCILE_ABSENT_CLAUSE
      : reconcileClause`${reconcileDiffValue(la.reference)} (expires ${reconcileDiffBareValue(la.expirationDate)})`;
  if (
    canonicalDiffers(
      existing.legalAgreement ?? null,
      incoming.legalAgreement ?? null,
      "legal agreement",
    )
  )
    conflicts.push({
      field: "legal_agreement",
      ...reconcileClauseConflict(
        renderAgreement(existing.legalAgreement),
        renderAgreement(incoming.legalAgreement),
      ),
    });

  const renderPayload = (
    p: LinkageTerms["payload"],
  ): CompatibilityMessageFragment =>
    p === undefined
      ? RECONCILE_UNSET
      : compatibilityMessage`send=${renderNames(p.send ?? [])} receive=${renderNames(p.receive ?? [])}`;
  if (
    canonicalDiffers(
      existing.payload ?? null,
      incoming.payload ?? null,
      "payload",
    )
  ) {
    const r = disambiguate(
      renderPayload(existing.payload),
      renderPayload(incoming.payload),
      existing.payload ?? null,
      incoming.payload ?? null,
    );
    add("payload", r.existing, r.incoming);
  }

  if (existing.date !== incoming.date)
    warnings.push(
      `the existing config's linkage-terms date (${existing.date}) differs from ` +
        `the invitation's (${incoming.date}); one copy may be stale`,
    );

  return { conflicts, warnings };
}

/**
 * What the operator's own configuration path may render to at the head of
 * the reconciliation refusal. Fitted so a long path (or one whose bytes
 * escape wide at the display boundary) cannot crowd out the conflict detail
 * and recovery step behind it. Sized well above any real path and below what
 * would leave the diff block without room; a longer path is clipped rather
 * than dropped.
 */
const RECONCILE_CONFIG_PATH_BUDGET = 128;

/** First-party spans a conflict line is built from, measured rather than
 *  restated wherever the budget arithmetic needs their cost. */
const RECONCILE_LINE_PREFIX = "  - ";
const RECONCILE_LINE_EXISTING = ": existing ";
const RECONCILE_LINE_INCOMING = " vs required ";

/**
 * Explains a line whose two sides read alike -- what a pair differing only
 * inside redacted or clipped bytes comes to -- once for the block rather
 * than once per line. Both sides are still shown as they fitted rather than
 * a standin replacing the second, since that would delete the operator's own
 * reading of a value the display cannot show. Its cost comes out of the
 * block's budget before the values are re-fitted, so this note never costs
 * the line that needed it.
 */
const RECONCILE_WITHHELD_NOTE =
  "  (two sides that read alike differ only inside what this display withheld: " +
  "bytes redacted as private-key material, or clipped for length)";

/**
 * Explains a line the block named without its values, so a bare field name
 * does not look as though nothing differs -- beside lines holding both
 * their values, or as the whole block when no line got room. Truncation
 * eats conflict detail here, which is why the recovery step is composed
 * ahead of this block (see {@link reconcileConflictMessage}).
 */
const RECONCILE_NAMED_ONLY_NOTE =
  "  (a field named above without its values has values too wide for the room " +
  "this message has left; every line names a field whose values differ)";

/**
 * The most the notices below a block can cost it, which is what the last layout
 * pass reserves so it cannot need more than it was given.
 */
const RECONCILE_NOTICE_RESERVE_CEILING = renderedDisplayCostKeepingLineBreaks(
  `\n${RECONCILE_NAMED_ONLY_NOTE}\n${RECONCILE_WITHHELD_NOTE}`,
);

/**
 * Render a list of {@link ReconcileDiff} as an indented, human-readable block
 * for a reconciliation error message, fitted so its rendered cost at the
 * display boundary is at most `budget`.
 *
 * Both sides of every line hold bytes somebody else chose, already redacted
 * and delimited by the producer that composed it ({@link reconcileDiffValue}).
 * They are interpolated RAW: the display boundary escapes each line of the
 * block once where it is shown and keeps the breaks between them, since the
 * refusal states those lines as its own
 * ({@link reconcileConflictError}). So `budget` is spent in the units
 * {@link renderedDisplayCostKeepingLineBreaks} measures -- a break costs one
 * character, not the four of the escape's `\x0a`.
 *
 * The budget is shared out by NEED, not by count: every line is charged its
 * first-party skeleton, each side is measured at what it would actually
 * render to, and what a short value does not take is available to a longer
 * one beside it -- so a constraint falls only on the sides too wide for the
 * room. A clause side sub-partitions its own slot among its values the same
 * way ({@link reconcileClause}). A side that cannot be given the least it
 * can display as drops both of that LINE's values, naming only the field,
 * with a first-party notice under the block explaining why.
 *
 * A cut always lands inside a delimited run closed properly (marker inside,
 * per {@link fitToRenderedCostClosingRuns}), which a check over the rendered
 * lines holds (`apps/cli/test/unit/config.test.ts`) rather than this comment.
 * The one property recorded rather than closed: the marker is plain ASCII a
 * value could also spell, so a value can claim a cut that did not happen --
 * what an operator can rely on is the marker's ABSENCE.
 *
 * @internal exported for testing; `reconcileConflictMessage` is the caller.
 */
export function formatReconcileDiffs(
  diffs: ReconcileDiff[],
  budget: number,
): string {
  if (diffs.length === 0) return "";

  const nameOnly = (d: ReconcileDiff): string =>
    `${RECONCILE_LINE_PREFIX}${d.field}`;
  // Charged with the one character the line break that follows it renders as.
  // Its field name is what a line costs even after its values are dropped, so
  // it is taken off the top rather than shared out.
  const nameCost = diffs.reduce(
    (total, d) =>
      total + renderedDisplayCostKeepingLineBreaks(`${nameOnly(d)}\n`),
    0,
  );
  // What a line pays on top of its name for holding values at all.
  const valueSkeletonCost = renderedDisplayCost(
    `${RECONCILE_LINE_EXISTING}${RECONCILE_LINE_INCOMING}`,
  );

  // A side that composed no fit is ONE delimited run, which asks for its own
  // width and cannot go below what shows any of its bytes.
  const sideOf = (
    side: CompatibilityMessageFragment,
    fit: ReconcileSideFit | undefined,
  ): ReconcileSideFit =>
    fit ?? {
      need: renderedDisplayCost(side),
      minimum: RECONCILE_MIN_VALUE_BUDGET,
      fit: (slot: number): string => fitToRenderedCostClosingRuns(side, slot),
    };
  // A side already narrower than its own floor asks for its width, not the
  // floor: it renders whole at what it asked for.
  const floorOf = (side: ReconcileSideFit): number =>
    Math.min(side.need, side.minimum);
  const lines = diffs.map((d) => {
    const existing = sideOf(d.existing, d.fit?.existing);
    const incoming = sideOf(d.incoming, d.fit?.incoming);
    return {
      diff: d,
      existing,
      incoming,
      floor: valueSkeletonCost + floorOf(existing) + floorOf(incoming),
    };
  });

  const layOut = (reserved: number): { block: string; noticeCost: number } => {
    const pool = budget - reserved - nameCost;
    // Cheapest first, which shows values on as many lines as the room admits;
    // ascending order also means the first line that does not fit decides
    // every line behind it, each of which asks for at least as much.
    const shown = new Set<number>();
    let claimed = 0;
    for (const index of lines
      .map((_, position) => position)
      .sort((a, b) => lines[a].floor - lines[b].floor)) {
      if (claimed + lines[index].floor > pool) break;
      shown.add(index);
      claimed += lines[index].floor;
    }

    // Every shown side holds its floor, and what is left over is shared out
    // among the sides that asked for more than one by the same need-aware rule.
    const shownLines = lines.filter((_, index) => shown.has(index));
    const surplus = allocateByNeed(
      shownLines.flatMap((line) => [
        line.existing.need - floorOf(line.existing),
        line.incoming.need - floorOf(line.incoming),
      ]),
      pool - claimed,
    );

    let withheld = false;
    let dropped = 0;
    let position = 0;
    const rendered = lines.map((line, index) => {
      if (!shown.has(index)) {
        dropped += 1;
        return nameOnly(line.diff);
      }
      const existing = line.existing.fit(
        floorOf(line.existing) + surplus[position * 2],
      );
      const incoming = line.incoming.fit(
        floorOf(line.incoming) + surplus[position * 2 + 1],
      );
      position += 1;
      if (existing === incoming) withheld = true;
      return (
        `${nameOnly(line.diff)}${RECONCILE_LINE_EXISTING}${existing}` +
        `${RECONCILE_LINE_INCOMING}${incoming}`
      );
    });

    const notices: string[] = [];
    if (dropped > 0) notices.push(RECONCILE_NAMED_ONLY_NOTE);
    if (withheld) notices.push(RECONCILE_WITHHELD_NOTE);
    return {
      block: [...rendered, ...notices].join("\n"),
      noticeCost: notices.reduce(
        (total, notice) =>
          total + renderedDisplayCostKeepingLineBreaks(`\n${notice}`),
        0,
      ),
    };
  };

  // A notice's own cost comes out of the values' share rather than the budget
  // already spent, so the explanation cannot push the block past its bound.
  // Which notices are needed is only known once laid out, so a layout
  // needing more than it reserved is laid out again under what it needed.
  let reserved = 0;
  let attempt = layOut(reserved);
  if (attempt.noticeCost > reserved) {
    reserved = attempt.noticeCost;
    attempt = layOut(reserved);
  }
  if (attempt.noticeCost > reserved)
    attempt = layOut(RECONCILE_NOTICE_RESERVE_CEILING);
  // The arithmetic above holds the block inside `budget` for every shape
  // reached today, pinned by a test asserting no line of a worst-case
  // message is cut. This is the fallback under it: a wider first-party
  // skeleton or field-name list is bounded here rather than silently
  // spending the recovery step's room.
  return fitBlockToRenderedCostClosingRuns(attempt.block, budget);
}

/**
 * Fit a whole block to `budget` in the units the display boundary charges it
 * once its breaks are kept: each line takes what the lines before it left,
 * fitted by {@link fitToRenderedCostClosingRuns} so a cut still closes its
 * delimited run, and a line with no room left is dropped along with the rest.
 * The fallback under {@link formatReconcileDiffs}'s own arithmetic, which the
 * shapes reached today keep inside the bound without it.
 */
function fitBlockToRenderedCostClosingRuns(
  block: string,
  budget: number,
): string {
  if (renderedDisplayCostKeepingLineBreaks(block) <= budget) return block;
  const fitted: string[] = [];
  let spent = 0;
  for (const line of block.split("\n")) {
    const room = budget - spent;
    if (room <= 0) break;
    const kept = fitToRenderedCostClosingRuns(line, room);
    fitted.push(kept);
    spent += renderedDisplayCost(kept) + 1;
  }
  return fitted.join("\n");
}

/**
 * The refusal `alcove accept` raises when a pre-existing configuration
 * disagrees with the invitation (and, online, the connection URL): what
 * disagreed, and what the operator does about it, composed to one display
 * link.
 *
 * The recovery step is composed AHEAD of the diff block: the display
 * boundary caps a link and drops the tail, and the recovery step is the one
 * part the operator cannot reconstruct from their own config, so truncation
 * should eat conflict detail instead.
 *
 * The budget is partitioned by WHO CHOSE THE BYTES: first-party copy is
 * measured where it stands, the operator's own configuration path is fitted
 * to {@link RECONCILE_CONFIG_PATH_BUDGET}, and the diff block gets exactly
 * what remains ({@link formatReconcileDiffs}). The path takes the same
 * redact/replace/fit treatment as a chooser's value even though it is the
 * operator's own, so no later caller can assume a fragment is exempt from
 * that treatment because of its provenance.
 *
 * Its line breaks are structure, not spacing, so the refusal is raised
 * through {@link reconcileConflictError} rather than from this text
 * directly.
 *
 * @internal exported for testing; `reconcileConflictError` is the caller.
 */
export function reconcileConflictMessage(params: {
  configPath: string;
  against: string;
  retryWith: string;
  diffs: ReconcileDiff[];
}): string {
  const { against, retryWith, diffs } = params;
  const configPath = clipToRenderedCost(
    replaceControlCharactersForDisplay(
      redactPrivateKeyMaterial(params.configPath),
    ),
    RECONCILE_CONFIG_PATH_BUDGET,
  );
  const head =
    `the configuration file at ${configPath} disagrees with ${against}. ` +
    `Resolve the differences below (or pass --config-file to write elsewhere), ` +
    `then retry with ${retryWith}. The differences:\n`;
  return (
    head +
    formatReconcileDiffs(
      diffs,
      Math.max(
        0,
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH -
          renderedDisplayCostKeepingLineBreaks(head),
      ),
    )
  );
}

/**
 * The refusal `alcove accept` raises for a configuration that disagrees with
 * the invitation, as the error the command throws: the message of
 * {@link reconcileConflictMessage}, marked so the display boundary shows the
 * conflict list and the recovery step on the lines the block is built from
 * ({@link keepFirstPartyLineBreaks}).
 *
 * Composing the message and marking it happen together here, so the one
 * composition writing those breaks has no route to an operator that eats
 * them.
 *
 * The lines are read back off the composed message, which is where that
 * composition's structure is: every value on them is control-replaced and
 * delimited where it was interpolated, so the breaks between them are the
 * composition's own -- a property the tests over this file's rendered refusal
 * hold rather than this sentence.
 */
export function reconcileConflictError(params: {
  configPath: string;
  against: string;
  retryWith: string;
  diffs: ReconcileDiff[];
}): UsageError {
  const message = reconcileConflictMessage(params);
  return keepFirstPartyLineBreaks(new UsageError(message), message.split("\n"));
}
