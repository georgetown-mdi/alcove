import type {
  BuiltInLinkageRuleSet,
  ExchangeSpec,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
} from "@alcove/core";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  isDrawnFromLinkageRuleSet,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  resolveLinkageRuleSetCitation,
  ruleSetCitation,
} from "@alcove/core";

import { configFileRefusal } from "./persist";

// --- Rules a configuration writes out ----------------------------------------

/**
 * A rule-set reference as one clause, keys first -- the keys are the specific
 * artifact and the fields the substrate they are built from -- matching the
 * order the invitation display and core's mismatch message render the pair in.
 * Each half is rendered by `renderHalf`, which applies the treatment its sink
 * calls for.
 */
function ruleSetCitationClause(
  reference: LinkageRuleSetReference,
  renderHalf: (identity: LinkageSetIdentity) => string,
): string {
  return `${renderHalf(reference.keySet)} over ${renderHalf(reference.fieldSet)}`;
}

/**
 * Whether a raw block writes a key under either spelling, a present-but-empty
 * value included: what the document declares is the question here, not what
 * the declaration holds, which the schema decides.
 */
function declaresKey(
  block: Record<string, unknown>,
  written: string,
  camelized: string,
): boolean {
  return Object.hasOwn(block, written) || Object.hasOwn(block, camelized);
}

/**
 * Refuse a raw configuration whose `linkage_terms` names a rule set and writes
 * neither `linkage_fields` nor `linkage_keys`. A configuration's rules are the
 * lists it writes, and nothing fills them in from the set it cites. Every
 * other shape, one list missing included, is left for the schema. Both
 * spellings of each key are read, since this runs ahead of the camelizing
 * parse.
 */
export function refuseRuleSetCitationWithoutRules(
  rawConfig: unknown,
  configPath: string,
): void {
  if (
    rawConfig === null ||
    typeof rawConfig !== "object" ||
    Array.isArray(rawConfig)
  )
    return;
  const config = rawConfig as Record<string, unknown>;
  const terms = config["linkage_terms"] ?? config["linkageTerms"];
  if (terms === null || typeof terms !== "object" || Array.isArray(terms))
    return;
  const block = terms as Record<string, unknown>;
  if (
    !declaresKey(block, "linkage_rule_set", "linkageRuleSet") ||
    declaresKey(block, "linkage_fields", "linkageFields") ||
    declaresKey(block, "linkage_keys", "linkageKeys")
  )
    return;
  throw configFileRefusal(
    configPath,
    "names a rule set in linkage_terms.linkage_rule_set but writes no " +
      "linkage_fields or linkage_keys. Run 'alcove init' to write a " +
      "configuration that lists them, or write linkage_fields and " +
      "linkage_keys out under linkage_terms.",
  );
}

// --- Rule-set citation drift -------------------------------------------------

/**
 * One half of a rule-set citation -- a set's name and content version -- for
 * the drift warning, which names a half on its own wherever it reports on
 * that half alone.
 *
 * The names are free text the config author chose, and `log.warn` is their
 * sink, so each is escaped here before rendering through core's terms-value
 * grammar ({@link ruleSetCitation}) -- the same grammar core's own mismatch
 * message and both consent surfaces use. Escaping BEFORE delimiting:
 * escaping after could truncate a value and take the closing delimiter off
 * it.
 */
function describeRuleSetHalf(identity: LinkageSetIdentity): string {
  return ruleSetCitation(
    redactAndSanitizeForDisplay(identity.name),
    redactAndSanitizeForDisplay(identity.version),
  );
}

/**
 * A rule-set citation as one clause for the drift warning, each half escaped
 * for that sink ({@link ruleSetCitationClause}).
 */
function describeRuleSetCitation(reference: LinkageRuleSetReference): string {
  return ruleSetCitationClause(reference, describeRuleSetHalf);
}

/**
 * Whether an acceptance stands behind a config's linkage terms, which
 * decides the remedy the drift warning can accurately offer for the
 * citation those terms hold.
 *
 * - `held-alone` -- no acceptance stands behind them, so both remedies are
 *   open: drop a citation the rules no longer earn, or put the cited set's
 *   rules back.
 * - `accepted-with-partner` -- an acceptance put them under agreement with
 *   an inviting party. Editing the rules to match the citation would take
 *   them out of that agreement, and the exchange would refuse them against
 *   the partner still running the originals.
 */
export type LinkageTermsStanding = "held-alone" | "accepted-with-partner";

/**
 * What a command can offer its operator besides settling a drifted citation
 * with the party whose acceptance stands behind the terms. Only the
 * `accepted-with-partner` reading takes it.
 *
 * - `decline-to-reuse` -- the command is putting the agreed terms to use, so
 *   the operator can leave them and start from terms that hold no claim
 *   they cannot support.
 * - `author-fresh-terms` -- the command is minting an invitation FROM those
 *   terms, so the operator can author fresh ones instead of reusing the
 *   accepted ones for it.
 */
export type CitationDriftAlternative =
  "decline-to-reuse" | "author-fresh-terms";

/**
 * Whether an acceptance stands behind a loaded config's linkage terms, read
 * from `expected_partner_deduplicate`. `alcove accept` writes this field on
 * every config it writes or reuses, `alcove apply` on every config it applies
 * a terms update to, and nothing else writes one, so its presence is exactly
 * the mark of a config an acceptance stands behind (see
 * {@link persistExpectedPartnerDeduplicate}). Both values read the same
 * way: the record says an acceptance happened, not what was agreed.
 */
export function linkageTermsStandingOf(
  spec: Pick<ExchangeSpec, "expectedPartnerDeduplicate">,
): LinkageTermsStanding {
  return spec.expectedPartnerDeduplicate === undefined
    ? "held-alone"
    : "accepted-with-partner";
}

/**
 * Warn when a loaded config's `linkage_terms.linkage_rule_set` cites a set
 * this build ships over rules that are not drawn from it -- the state a
 * hand edit to `linkage_fields` or `linkage_keys` leaves behind. Left
 * unreported, that citation travels onto the invitation and both parties'
 * exchange records claiming a provenance the rules no longer have.
 *
 * Only a half this build can RESOLVE is judged: a citation naming a set
 * Alcove does not ship has no content here to compare the rules against,
 * so that half is passed over, and each half is judged separately so a
 * foreign half cannot buy the built-in half a pass.
 *
 * Warns rather than refuses: the citation is display-and-record only, and
 * the exchange runs on the declared fields and keys either way.
 *
 * `standing` decides the remedy wording (see {@link LinkageTermsStanding}):
 * terms an acceptance stands behind are agreed with the inviting party, so
 * restoring the cited set's rules would edit terms both parties hold and
 * the exchange would then abort against the partner. `alternative` names
 * what that operator can do instead of settling (see
 * {@link CitationDriftAlternative}).
 *
 * @param ruleSets the sets the citation is resolved against, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default. The rules are compared
 * against the set the terms cite, whichever of those it is.
 */
export function warnOnLinkageRuleSetCitationDrift(
  terms: Pick<LinkageTerms, "linkageRuleSet" | "linkageFields" | "linkageKeys">,
  configPath: string,
  log: { warn: (message: string) => void },
  standing: LinkageTermsStanding,
  alternative: CitationDriftAlternative,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): void {
  const cited = terms.linkageRuleSet;
  if (cited === undefined) return;

  const shipped = resolveLinkageRuleSetCitation(cited, ruleSets);

  // Each half is judged by handing the predicate that half's shipped
  // declarations over rules with nothing on the other side: an empty list
  // runs neither of the predicate's loops, so the half not under test
  // cannot decide the answer.
  const drifted: string[] = [];
  const reportDrift = (field: string, citedHalf: LinkageSetIdentity): void => {
    drifted.push(
      `its ${field} are not drawn from the ` +
        `${describeRuleSetHalf(citedHalf)} this build ships`,
    );
  };
  if (
    shipped.linkageFields !== undefined &&
    !isDrawnFromLinkageRuleSet(
      {
        reference: cited,
        linkageFields: shipped.linkageFields,
        linkageKeys: [],
      },
      { linkageFields: terms.linkageFields, linkageKeys: [] },
    )
  )
    reportDrift("linkage_fields", cited.fieldSet);
  if (
    shipped.linkageKeys !== undefined &&
    !isDrawnFromLinkageRuleSet(
      { reference: cited, linkageFields: [], linkageKeys: shipped.linkageKeys },
      { linkageFields: [], linkageKeys: terms.linkageKeys },
    )
  )
    reportDrift("linkage_keys", cited.keySet);
  if (drifted.length === 0) return;

  const consequence =
    standing === "accepted-with-partner"
      ? "The citation is recorded in both parties' exchange records, so it " +
        "credits a source these rules did not come from. You accepted these " +
        "terms from the inviting party, so editing the rules here would make " +
        "them differ from that party's and the exchange would refuse them. " +
        (alternative === "author-fresh-terms"
          ? "Agree the citation with that party, or author fresh terms for " +
            "this invitation."
          : "Agree the citation with that party and accept again, or decline " +
            "to reuse these terms.")
      : "This citation is copied into the invitation, into the terms your " +
        "partner reviews, and into both parties' exchange records, so it " +
        "credits a source these rules did not come from. Remove " +
        "linkage_rule_set if you wrote these rules yourself, or restore the " +
        "rules the cited set defines.";

  log.warn(
    `${redactAndRenderOperatorSuppliedText(operatorSuppliedText(configPath))}: ` +
      `linkage_terms.linkage_rule_set cites ` +
      `${describeRuleSetCitation(cited)}, but ${drifted.join(", and ")}. ` +
      consequence,
  );
}
