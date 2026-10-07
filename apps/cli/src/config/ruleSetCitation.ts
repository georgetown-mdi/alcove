import type {
  BuiltInLinkageRuleSet,
  ExchangeSpec,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
} from "@alcove/core";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  findBuiltInLinkageRuleSet,
  isDrawnFromLinkageRuleSet,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  resolveLinkageRuleSetCitation,
  ruleSetCitation,
} from "@alcove/core";

import { configFileRefusal } from "./persist";

// --- Rules taken from a named rule set ---------------------------------------

/**
 * A rule-set reference as one clause, keys first -- the keys are the specific
 * artifact and the fields the substrate they are built from -- matching the
 * order the invitation display and core's mismatch message render the pair in.
 * Each half is rendered by `renderHalf`, which applies the treatment its sink
 * calls for: a warning escapes the two names for its `log.warn`, a refusal
 * composes them raw for the single escape its display applies.
 */
function ruleSetCitationClause(
  reference: LinkageRuleSetReference,
  renderHalf: (identity: LinkageSetIdentity) => string,
): string {
  return `${renderHalf(reference.keySet)} over ${renderHalf(reference.fieldSet)}`;
}

/**
 * One half of a rule-set citation for a refusal message, through core's
 * terms-value grammar ({@link ruleSetCitation}) and otherwise raw: a fragment
 * composed into an `Error` is escaped once at the sink that shows it, so
 * escaping it here would double-escape every backslash the operator reads.
 */
function refusalRuleSetHalf(identity: LinkageSetIdentity): string {
  return ruleSetCitation(identity.name, identity.version);
}

/**
 * The set identity `raw` writes, or `undefined` where it is not written as one.
 * Shape only, and the shallowest shape a lookup needs: what a name and a
 * version may hold is the linkage-terms schema's to decide, and a citation it
 * refuses reaches the operator under its own issue path either way.
 */
function citedSetIdentity(raw: unknown): LinkageSetIdentity | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const { name, version } = raw as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  return { name, version };
}

/**
 * The rule set `raw` names, or `undefined` where it does not name one whole.
 * Both spellings of each half are read, as every raw-document read here is: a
 * configuration file writes `field_set`, and the camelCase form is what
 * reaches the schema.
 */
function citedRuleSetReference(
  raw: unknown,
): LinkageRuleSetReference | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const halves = raw as Record<string, unknown>;
  const fieldSet = citedSetIdentity(halves["field_set"] ?? halves["fieldSet"]);
  const keySet = citedSetIdentity(halves["key_set"] ?? halves["keySet"]);
  if (fieldSet === undefined || keySet === undefined) return undefined;
  return { fieldSet, keySet };
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

/** The two rule lists, each as the pair of spellings a raw read accepts. */
const RULE_LIST_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ["linkage_fields", "linkageFields"],
  ["linkage_keys", "linkageKeys"],
];

/**
 * The rule lists `document` writes at its own top level, spelled as it writes
 * them. A list un-indented out of `linkage_terms` lands exactly there, and the
 * block it left then holds no rules at all.
 *
 * The top level and nothing deeper: that is where the mis-indentation puts a
 * list. A list under a key spelled some third way is outside what any read
 * here can see, a limit docs/EXCHANGE_REFERENCE.md states.
 */
function ruleListsWrittenAtTopLevel(document: unknown): Array<string> {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  )
    return [];
  const top = document as Record<string, unknown>;
  return RULE_LIST_SPELLINGS.flatMap(([written, camelized]) => {
    if (Object.hasOwn(top, written)) return [written];
    if (Object.hasOwn(top, camelized)) return [camelized];
    return [];
  });
}

/**
 * What this build ships, as the sentence the unknown-set refusal states it in.
 * A build shipping none says so rather than trailing an empty list: the
 * refusal is read by someone deciding what to write instead.
 */
function shippedRuleSets(
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet>,
): string {
  if (ruleSets.length === 0) return "This build ships no rule set at all.";
  const shipped = ruleSets
    .map((ruleSet) =>
      ruleSetCitationClause(ruleSet.reference, refusalRuleSetHalf),
    )
    .join("; ");
  return `It ships ${shipped}.`;
}

/**
 * A raw configuration's `linkage_terms` with its `linkage_fields` and
 * `linkage_keys` taken from the rule set the block's `linkage_rule_set` names,
 * where it names a set this build ships and writes neither list of its own.
 * Every path that reads a configuration file runs its terms through this ahead
 * of the schema, so a named set resolves alike whether the file is read to run
 * an exchange, to mint an invitation from, or to compare against one.
 *
 * Rules are taken whole or not at all:
 *
 * - Both lists written -- what every configuration written to date holds --
 *   are the rules, untouched here. The citation beside them stays the claim
 *   {@link warnOnLinkageRuleSetCitationDrift} judges.
 * - Neither list written, and the citation names a shipped set: both lists
 *   come from that set, and the citation stands as the file wrote it.
 * - Neither list written, and the citation names a set this build does not
 *   ship: refused, naming what was cited and what this build ships. Nothing
 *   here guesses at a name it does not ship, and the file writes no rules to
 *   fall back to.
 * - One list written and the other not: refused. A key set is built from its
 *   own fields, so filling in the missing half would compose the rules of one
 *   exchange from two sources under one name.
 * - Neither list written in the block, but one of them written at the top
 *   level of the document around it: refused, naming where it was found and
 *   where it belongs. A list un-indented out of the block is an editing
 *   mistake, not a file asking to run the whole set.
 *
 * A citation written in some other shape is left for the schema, which names
 * the field and the issue.
 *
 * @param ruleSets the sets a citation is looked up in, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 * @param enclosingDocument the raw document the block was read out of, where
 * the caller holds it, for the misplacement check above. Omitting it checks
 * the block alone.
 */
export function linkageTermsWithNamedRuleSetRules(
  rawTerms: unknown,
  configPath: string,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
  enclosingDocument?: unknown,
): unknown {
  if (
    rawTerms === null ||
    typeof rawTerms !== "object" ||
    Array.isArray(rawTerms)
  )
    return rawTerms;
  const terms = rawTerms as Record<string, unknown>;
  const citation = terms["linkage_rule_set"] ?? terms["linkageRuleSet"];
  if (citation === undefined) return rawTerms;

  const writesFields = declaresKey(terms, "linkage_fields", "linkageFields");
  const writesKeys = declaresKey(terms, "linkage_keys", "linkageKeys");
  if (writesFields && writesKeys) return rawTerms;

  const reference = citedRuleSetReference(citation);
  if (reference === undefined) return rawTerms;
  const cited = ruleSetCitationClause(reference, refusalRuleSetHalf);

  if (writesFields || writesKeys) {
    const written = writesFields ? "linkage_fields" : "linkage_keys";
    const missing = writesFields ? "linkage_keys" : "linkage_fields";
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        `writes ${written} but no ${missing}. Alcove takes both lists from ` +
        `a named set or neither: remove ${written} to run the set's own ` +
        `rules, or write ${missing} out beside it.`,
    );
  }

  const misplaced = ruleListsWrittenAtTopLevel(enclosingDocument);
  if (misplaced.length > 0) {
    const names = misplaced.join(" and ");
    const them = misplaced.length === 1 ? "it" : "them";
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        "writes no linkage_fields or linkage_keys inside that block, but " +
        `writes ${names} at the top level of the file. Indent ${them} under ` +
        `linkage_terms to run the rules the file holds, or delete ${them} ` +
        "to run the named set's own rules.",
    );
  }

  const ruleSet = findBuiltInLinkageRuleSet(reference, ruleSets);
  if (ruleSet === undefined)
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        "writes no linkage_fields or linkage_keys of its own, but this build " +
        `ships no such rule set. ${shippedRuleSets(ruleSets)} Name a set ` +
        "this build ships, or write the linkage_fields and linkage_keys out " +
        "in the file.",
    );

  // Cloned rather than aliased: a built-in set is frozen through every level,
  // and what this returns is a document later passes rewrite.
  return {
    ...terms,
    linkageFields: structuredClone(ruleSet.linkageFields),
    linkageKeys: structuredClone(ruleSet.linkageKeys),
  };
}

/**
 * `rawConfig` with its linkage terms' rules taken from the rule set they name
 * ({@link linkageTermsWithNamedRuleSetRules}), for a caller holding the whole
 * raw document. A new object where anything was filled in, leaving the
 * caller's own value as it read it, and the configuration itself otherwise.
 *
 * Runs on the raw configuration, ahead of the schema: what it fills in is a
 * block the schema requires.
 *
 * @param ruleSets the sets a citation is looked up in, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function configWithNamedRuleSetRules(
  rawConfig: unknown,
  configPath: string,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): unknown {
  if (
    rawConfig === null ||
    typeof rawConfig !== "object" ||
    Array.isArray(rawConfig)
  )
    return rawConfig;
  const config = rawConfig as Record<string, unknown>;
  const key = Object.hasOwn(config, "linkage_terms")
    ? "linkage_terms"
    : Object.hasOwn(config, "linkageTerms")
      ? "linkageTerms"
      : undefined;
  if (key === undefined) return rawConfig;
  const filled = linkageTermsWithNamedRuleSetRules(
    config[key],
    configPath,
    ruleSets,
    config,
  );
  return filled === config[key] ? rawConfig : { ...config, [key]: filled };
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
