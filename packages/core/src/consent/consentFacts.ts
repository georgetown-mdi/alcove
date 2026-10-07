// The enforced-versus-trust-contingent classification of the facts an acceptance
// surface states, and the caveat copy each surface renders for them. Both surfaces
// read this one table so a fact cannot take two classifications or two caveats, a
// divergence the consent-coverage check cannot see. The `countOnly*` bases follow
// docs/spec/PROTOCOL.md's PSI-C learn-basis rows. All copy is fixed first-party
// text, so a surface may render it verbatim. Rationale:
// docs/notes/shared-consent-summary.md.

import type { LinkageRuleSetCitationVerdict } from "../defaults/builtInLinkageTerms.js";

/**
 * Whether the exchange holds a consent fact itself, or the fact is the inviting
 * party's declaration -- shown faithfully, neither verified nor enforceable.
 *
 * `enforced` is a claim about the run: either the fact is true of it, or the
 * exchange aborts rather than proceed without it. `trust-contingent` is a claim
 * about the partner: a partner that does not honor it is not stopped by Alcove.
 */
export type ConsentFactBasis = "enforced" | "trust-contingent";

/** One classified fact of the acceptance display. */
export interface ConsentFact {
  /** Which of the two registers this fact belongs to. */
  basis: ConsentFactBasis;
  /** Why the fact has that basis, for a person auditing the table; no renderer
   * reads it. */
  reason: string;
  /** The caveat both surfaces render where the marker alone would understate
   * the fact. */
  note?: string;
}

/**
 * Every fact an acceptance surface states, with its basis and shared caveat copy.
 * A renderer reads both the marker and the caveat from here, never inline.
 */
export const CONSENT_FACTS = {
  outboundSend: {
    basis: "enforced",
    reason:
      "The acceptor's own disclosure, derived from its resolved metadata " +
      "through the same predicate the payload step transmits on, so no column " +
      "outside the displayed set leaves the machine. The acceptance records the " +
      "displayed set as this party's consent to it, and a run whose own resolved " +
      "set differs -- including one on a configuration already on disk, whose " +
      "stored metadata this line is not rendered from -- stops and asks rather " +
      "than transmit a set that was never shown. Where the set is not resolvable " +
      "at acceptance the line says so, and the same confirmation is taken at the " +
      "first run that can resolve it.",
  },
  outboundSendSelfAuthored: {
    basis: "enforced",
    reason:
      "The same disclosure at the seat that wrote its own configuration, where " +
      "the half of `outboundSend` resting on a recorded acceptance has nothing " +
      "to rest on: this party consented to no set and Alcove holds none for " +
      "it. What remains is the derivation, which is the whole basis here -- the " +
      "displayed set comes from the run's own resolved metadata through the " +
      "same predicate the payload step transmits on, so no column outside it " +
      "leaves the machine. A later run whose file discloses a different set " +
      "displays that set rather than stopping, since there is no confirmed set " +
      "to differ from.",
  },
  invitingParty: {
    basis: "trust-contingent",
    reason:
      "A free-text name the inviter typed, carried in an invitation accepted " +
      "on a transcription checksum. Nothing authenticates it, and Alcove " +
      "substitutes nothing for an inviter that typed none -- but the absence " +
      "marker shown in its place is itself free text an inviter could type, so " +
      "display does not separate the two cases.",
    note:
      "Your partner chose what you see here; Alcove has not verified it and " +
      "adds no name of its own.",
  },
  algorithm: {
    basis: "enforced",
    reason:
      "A mandatory-consistency term both parties adopt, asserted on every run " +
      "path: an algorithm this version does not implement aborts the exchange.",
  },
  countOnlyResult: {
    basis: "enforced",
    reason:
      "The two halves docs/spec/PROTOCOL.md assigns to the run rather than to " +
      "the partner. A party's own count-only outcome: its base function is " +
      "constructed with the library's reveal-intersection flag cleared, and the " +
      "operations returning the matched positions or the association table throw " +
      "with it cleared, so its own software cannot produce a pairing. And its " +
      "view of what the PARTNER receives: a request whose flag disagrees with " +
      "the sender's is refused rather than served, in both orientations, so a " +
      "round that completes at all is one both parties ran count-only. Neither " +
      "half asks for the partner's cooperation or its honesty. What this basis " +
      "does not reach is the partner's choice of contributed values, which is a " +
      "fact of its own below.",
    note:
      "Neither party is handed a matched identifier or a record-by-record " +
      "pairing, and Alcove enforces this. A partner asking for a revealing " +
      "round is refused, whatever software it runs.",
  },
  countOnlyRoundDisclosures: {
    basis: "enforced",
    reason:
      "What a count-only run discloses beside the count, and it discloses both " +
      "however either party behaves. Each party's raw record count is sent in " +
      "the terms exchange that opens every exchange, and each party's round " +
      "frame holds one encrypted element per value it contributes: the key " +
      "values that appear exactly once in its file. " +
      "Neither figure is the intersection and the count-only mode hides " +
      "neither, so this sits in the run's register rather than the partner's -- " +
      "the same one as the own-membership disclosure a one-sided `psi` " +
      "exchange carries.",
    note:
      "Your partner also learns how many records you hold, and how many " +
      "values you contribute for the key being matched on, which are the " +
      "values that appear exactly once in your file. Neither number is your " +
      "overlap, and a count-only exchange hides neither.",
  },
  countOnlyReportedCount: {
    basis: "trust-contingent",
    reason:
      "Only the receiver computes the count. Where both parties are entitled to " +
      "it the other party's copy arrives as the receiver's report, and Alcove " +
      "does not stop a receiver that reports a different number -- the same " +
      "arrangement as the `psi` association-table return leg, where the sender's " +
      "half of the pairing likewise arrives as the receiver's word. Which party " +
      "computes follows from the record counts the run exchanges, so acceptance " +
      "cannot tell either side which of the two it will be, and the fact is " +
      "stated for both.",
    note:
      "Alcove does not check a count your partner sends you against a run of " +
      "its own. Only one of you computes the count and sends it to the " +
      "other, and which one follows from the record counts you exchange when " +
      "the run starts.",
  },
  countOnlyInputChoice: {
    basis: "trust-contingent",
    reason:
      "The count-only claim holds against a partner that contributes a genuine " +
      "dataset, and Alcove checks no such thing. A partner that chooses its " +
      "contributed values -- one live candidate padded with values it knows this " +
      "party cannot hold, or two runs differing in a single value -- reads that " +
      "value's membership off the count, and nothing on the wire distinguishes a " +
      "crafted set from a genuine one. Both routes are accepted rather than " +
      "prevented, so the protection they bound rests on the partner's conduct " +
      "even though the round itself is enforced. This matters most here: a " +
      "count-only exchange is the one run before the agreement the " +
      "honest-but-curious model leans on exists.",
    note:
      "Your partner can learn whether one person is in your data by choosing " +
      "which records to ask about. A count-only exchange bounds what Alcove " +
      "hands your partner, not what its choice of records reveals. A crafted " +
      "list, or a second run differing by one record, turns a count into an " +
      "answer about one person, and Alcove does not check what your partner " +
      "contributes.",
  },
  countOnlyNoPayload: {
    basis: "enforced",
    reason:
      "A count-only exchange carries no payload in either direction: a psi-c " +
      "terms document declaring a non-empty payload send or receive, or input " +
      "metadata that would transmit a column, is refused when the terms are " +
      "authored, again at the local prepare step, and again at the agreed-terms " +
      "run boundary, fail-closed at all three. The reason no column leaves the " +
      "machine is therefore the algorithm rather than this exchange's output " +
      "entitlements, which is what OUTBOUND_SEND_NO_PAYLOAD_SENTENCE reasons " +
      "from and so cannot state here.",
    note:
      "No columns are sent to your partner, whatever your file contains. A " +
      "count-only exchange sends no data columns in either direction.",
  },
  linkageStrategy: {
    basis: "enforced",
    reason:
      "A mandatory-consistency term: the parties must end up agreeing on it or " +
      "the exchange aborts.",
  },
  viewerReceivesResult: {
    basis: "enforced",
    reason:
      "The viewer's own receipt is settled by the exchange, not by the " +
      "partner's conduct.",
  },
  viewerReceivesNoResult: {
    basis: "enforced",
    reason:
      "A party set to receive no result is sent none, and its receive check " +
      "fails closed on any result it is sent.",
    note: "You are sent no result, and Alcove rejects any result sent to you.",
  },
  partnerReceivesResult: {
    basis: "enforced",
    reason:
      "The receipt is settled by the run rather than by the partner's conduct: " +
      "the two parties' output directions are compared as a mirror before data " +
      "moves, and the run then delivers the result to the party those agreed " +
      "terms entitle to it. What the partner does with the result once it holds " +
      "it is governed by the agreement, not by Alcove -- a limit on its use, " +
      "which the note carries, not on whether the disclosure happens.",
    note:
      "Your agreement governs how your partner uses the result; Alcove does " +
      "not control it.",
  },
  partnerReceivesNoResult: {
    basis: "trust-contingent",
    reason:
      "Keeping a result from a partner rests on the agreed terms being " +
      "honored; one-sided PSI gives this side nothing to impose it with.",
    note:
      "Alcove cannot stop your partner from receiving the result. Keeping it " +
      "from your partner depends on the agreed terms being honored.",
  },
  partnerLearnsOwnMembership: {
    basis: "enforced",
    reason:
      "An intrinsic property of an identifier-revealing match rather than a " +
      "matter of conduct: under `psi` a non-receiving partner whose half of " +
      "the association table the run returns learns its own records' " +
      "membership however honestly it behaves. Bounded to that -- never which " +
      "of the viewer's records they met, nor anything about the rest of the " +
      "set beyond its size. Gated first on the ALGORITHM: no `psi-c` exchange " +
      "states it at all, since the role rule makes the non-receiving party of " +
      "a count-only run the sender -- which computes nothing from the round " +
      "and is sent no count-report frame (docs/spec/PROTOCOL.md, PSI-C), so it " +
      "learns no membership to state, and what a count-only run does disclose " +
      "is the `countOnly*` tier's. Within `psi` it is the case where that half " +
      "is returned at all: a single-pass run that withholds the partner's half " +
      "discloses no membership either, and `partnerOwnMembershipWithheld` " +
      "below is that case, selected from the run's own resolution rather than " +
      "from a second reading of the strategy and the payload declaration.",
    note:
      "Even when the terms are honored, your partner learns which of its own " +
      "records are in your data, though not which of your records they are. " +
      "A match that reveals identifiers discloses this whenever your partner " +
      "is sent its half of the matched-pair table. That is inherent to the " +
      "match, not a breach.",
  },
  partnerOwnMembershipWithheld: {
    basis: "enforced",
    reason:
      "The other case of the same line, on the one combination the exchange " +
      "closes itself: a single-pass run whose sole receiver is the VIEWER, " +
      "leaving the partner entitled to no result, over a document declaring " +
      "that partner's payload direction present and empty. Role resolution " +
      "seats the party entitled to the result as the receiver, so the partner " +
      "is the sender the withholding covers, and the receiver suppresses that " +
      "party's half of the association table entirely while it skips awaiting " +
      "it, both sides deriving the decision from the same authenticated " +
      "session state -- so the partner's process never receives, and so never " +
      "learns, which of its own records the viewer also holds " +
      "(docs/spec/PROTOCOL.md, Withholding the sender's table from a blind " +
      "helper). The declared-empty direction is what binds the partner to " +
      "disclosing no column, which is the second condition the rule asks. " +
      "Resolved off the run's own predicate -- " +
      "`withholdsInviterAssociationTable` where the partner is the inviting " +
      "party, `withholdsAcceptorAssociationTable` where it is the accepting " +
      "party, and `withholdsPartnerAssociationTable` where the viewer reads " +
      "linkage terms it wrote itself (consent/invitationSummary.ts) -- so a " +
      "surface never states this basis for a run that does not withhold. The " +
      "third of those reads two documents from one of them, and its own " +
      "documentation states the shape it cannot see.",
    note:
      "Your partner's process is never sent which of its own records are in " +
      "your data, because this exchange withholds its half of the " +
      "matched-pair table. The exchange enforces this whatever software your " +
      "partner runs.",
  },
  partnerOwnMembershipWithheldSelfAuthored: {
    basis: "enforced",
    reason:
      "The same case at the seat reading terms it wrote itself " +
      "(`withholdsPartnerAssociationTable`), which holds this party's " +
      "declared `payload.receive` against the partner's DECLARED " +
      "`payload.send` rather than against what the partner's resolved " +
      "metadata will transmit -- `validateCompatibility` passes a partner " +
      "config with no payload block by comparing against " +
      "`partner.payload?.send ?? []`. The run does not leave that " +
      "difference to the agreement: both parties resolve each " +
      "direction's disclosure from the two agreed documents and both " +
      "parties' asserted disclosure immediately after the terms exchange, so " +
      "a partner whose metadata discloses a column against this party's " +
      "declared-empty `payload.receive` refuses BOTH parties before the " +
      "linkage round, the association table and the payload " +
      "(`resolveBothDirectionsDisclosePayload`, exchange.ts). Either the " +
      "partner's half is withheld or the exchange stops before it could " +
      "move, which is what `enforced` means here. It stays a fact of its own " +
      "rather than folding into `partnerOwnMembershipWithheld` because an " +
      "acceptance surface must not address a seat that accepted no " +
      "invitation.",
    note:
      "Your partner's process is never sent which of its own records are in " +
      "your data, because this exchange withholds its half of the " +
      "matched-pair table. If your partner's input would send a column your " +
      "agreed terms declare none for, the exchange is refused for both " +
      "parties before the match starts.",
  },
  duplicateMatches: {
    basis: "enforced",
    reason:
      "Matching multiplicity is fixed by the run: the cardinality both parties " +
      "resolve from the agreed pair decides which side's within-dataset " +
      "duplicates take part, and a pair no strategy matches aborts the " +
      "exchange rather than matching looser. The marker carries that fact and " +
      "no more. Where the invitation makes the inviting party the sole " +
      "receiver, what reaches the accepting party of the grouping is a further " +
      "fact of its own -- `duplicateGroupingWithheld` where the exchange " +
      "closes it, `duplicateGroupingDisplayLimit` in the other register where " +
      "the client alone does -- so this marker is never read as covering " +
      "either.",
  },
  duplicateGroupingDisplayLimit: {
    basis: "trust-contingent",
    reason:
      "What a sole-receiver acceptance is not handed is the RESULT, and the " +
      "entitlement gate on the table `runExchange` returns holds that. On the " +
      "runs this basis is measured over the grouping still reaches the " +
      "accepting party's process: under cascade the rounds carry each matched " +
      "position once per group member, and under single-pass the wire-level " +
      "withholding does not reach a party that transmits a payload column of " +
      "its own or is left free to. So presenting none of the grouping is the " +
      "client's doing rather than the exchange's, and what an operator on that " +
      "side is shown rests on the software that side runs -- the partner's " +
      "register, not the run's. The combination the exchange does close is " +
      "`duplicateGroupingWithheld` below, resolved from the run's own rule " +
      "(`withholdsAcceptorAssociationTable`) rather than from a second reading " +
      "here, so neither entry claims the other's ground. Carried as a fact of " +
      "its own rather than inside " +
      "DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT: it renders beside that " +
      "statement, under the same enforced headline, but as a classified fact " +
      "of its own rather than as a clause of a sentence whose basis is the " +
      "headline's.",
    note:
      "Your side receives the group sizes and row positions, and Alcove does " +
      "not show them to you. The exchange does not withhold them, so other " +
      "software on your side could show them.",
  },
  duplicateGroupingWithheld: {
    basis: "enforced",
    reason:
      "The other case of the same line, on the one combination the exchange " +
      "itself closes: a single-pass run whose sole receiver is the inviting " +
      "party and whose invitation requests no payload column of the accepting " +
      "party. The receiver suppresses the accepting party's half of the " +
      "association table entirely and that party skips awaiting it, both sides " +
      "deriving the decision from the same authenticated session state, so its " +
      "process is sent neither the group sizes and row positions nor its own " +
      "records' membership (docs/spec/PROTOCOL.md, Withholding the sender's " +
      "table from a blind helper, and its composition with a deduplicating " +
      'cardinality under Where the "one" party receives no output). Enforced ' +
      "in the register's own sense rather than merely likely: the empty " +
      "payload request mirrors to an empty `payload.send` for the accepting " +
      "party, which is held to exactly the columns its metadata discloses " +
      "before any data moves, so a run whose file would disclose a column " +
      "stops there instead of reaching the linkage with the table exchanged. " +
      "The condition is resolved by `withholdsAcceptorAssociationTable` " +
      "(consent/invitationSummary.ts) off the run's own predicate, so a " +
      "surface never states this basis for a run that does not withhold.",
    note:
      "You are shown no group sizes, no row positions, and nothing about " +
      "which of your own records matched. This exchange withholds your half " +
      "of the matched-pair table: Alcove on your side never reads it, and a " +
      "partner running Alcove never sends it. Withholding them is a limit of " +
      "the exchange rather than this software's choice.",
  },
  partnerReadsDuplicateGrouping: {
    basis: "trust-contingent",
    reason:
      "The same two registers as the pair above, read from the other side: " +
      "the ACCEPTING party groups its own records and the inviting party is " +
      "entitled to no result. The result gate hands that party none, but the " +
      "run still reaches its process -- under cascade the rounds carry each " +
      "matched position once per group member, and under single-pass the " +
      "wire-level withholding does not reach a party that transmits a payload " +
      "column of its own or is left free to. So what a partner is shown of " +
      "the grouping rests on the software it runs, which is the partner's " +
      "register rather than the run's. The combination the exchange does " +
      "close is `partnerDuplicateGroupingWithheld` below, resolved from the " +
      "run's own rule (`withholdsInviterAssociationTable`) rather than from a " +
      "second reading here.",
    note:
      "Your partner's process is sent the group sizes and row positions your " +
      "matched records fall into, though these terms hand it no result. What " +
      "it shows of them depends on the software your partner runs.",
  },
  partnerDuplicateGroupingWithheld: {
    basis: "enforced",
    reason:
      "The other case of the same line: a single-pass run whose sole receiver " +
      "is the ACCEPTING party and whose inviting party declares an empty " +
      "`payload.send`. Role resolution seats the party entitled to the result " +
      "as the receiver, so the inviting party is the sender the withholding " +
      "covers, and the receiver suppresses its half of the association table " +
      "entirely while that party skips awaiting it, both sides deriving the " +
      "decision from the same authenticated session state (docs/spec/" +
      "PROTOCOL.md, Withholding the sender's table from a blind helper, and " +
      'its composition with a deduplicating cardinality under Where the "one" ' +
      "party receives no output). The declared-empty send is what binds the " +
      "inviting party to disclosing no column, which is the second condition " +
      "the rule asks. Resolved by `withholdsInviterAssociationTable` " +
      "(consent/invitationSummary.ts) off the run's own predicate, so a " +
      "surface never states this basis for a run that does not withhold.",
    note:
      "Your partner's process is sent no group sizes and no row positions " +
      "for your matched records, because this exchange withholds its half " +
      "of the matched-pair table. The exchange enforces this whatever " +
      "software your partner runs.",
  },
  acceptorDeduplicateRefused: {
    basis: "enforced",
    reason:
      "What this party's own `deduplicate` would do against an invitation " +
      "that declares the inviting party's own `deduplicate` under a linkage " +
      "strategy pairing no both-sided cardinality: the pair resolves to a " +
      "many-to-many match that strategy does not run, so the accept boundary " +
      "refuses it (`assertBothSidedDeduplicateImplemented`, reached from " +
      "`deriveAcceptedLinkageTerms`) and the agreed-terms run boundary " +
      "refuses it again (`resolveLinkageCardinality`). Both of the " +
      "conditions this party does not set are the invitation's own, so the " +
      "consequence is stated before the value that completes the " +
      "combination is set rather than met at the accept. Resolved by " +
      "`acceptorDeduplicateRefused` (consent/invitationSummary.ts) off the " +
      "refusal's own predicate, so a surface never states it for an " +
      "invitation the accept would take. The exchange does not run at all, " +
      "which is a fact of the run rather than of the partner's conduct.",
    note:
      "With duplicate matching set for your own records, the exchange will " +
      "refuse to run. Your partner declares that several of its records may " +
      "match one of yours, so each party's records could group the other's, " +
      "and the linkage strategy these terms name does not match records " +
      "grouped on both sides. Leave your own setting off " +
      "to run these terms, or ask your partner for an invitation that drops " +
      "its own duplicate matching.",
  },
  matchedFields: {
    basis: "enforced",
    reason:
      "The fields the linkage keys are computed over -- what the exchange " +
      "actually hashes and compares.",
  },
  personalDataCategories: {
    basis: "enforced",
    reason:
      "The semantic categories the keys draw on, resolved from the schema-" +
      "validated field types the run binds.",
  },
  declaredDataStandards: {
    basis: "trust-contingent",
    reason:
      "Data standards the inviting party commits its own values to. Alcove " +
      "warns where a value falls outside one; it does not filter or reject.",
  },
  allowedCharacterPatterns: {
    basis: "trust-contingent",
    reason:
      "A partner-authored regular expression, never vetted. A crafted class " +
      "reads very differently to a human than the set it admits, and the check " +
      "evaluating it warns rather than enforces.",
    note:
      "Alcove does not enforce these allowed-character patterns. Each is a " +
      "regular expression your partner supplied for these fields, which " +
      "Alcove has not verified, stating what your partner expects the data " +
      "to hold.",
  },
  linkageKeys: {
    basis: "enforced",
    reason:
      "The keys, their elements, and every declared matching rule are what the " +
      "run computes; under `psi` they decide which identifiers are revealed.",
  },
  fanOutCandidates: {
    basis: "enforced",
    reason:
      "What the run does with a record that has several candidate values for " +
      "one key, not what the partner does with it. Every candidate enters that " +
      "key's round as its own entry; a record appearing in any of the round's " +
      "candidate pairs leaves candidacy for every later key, paired or not; and " +
      "each strategy discloses a grouping of its own -- the index table " +
      "the single-pass receiver holds carries each sender record's candidate " +
      "grouping for every key, matched or not, where a cascade round states " +
      "each party's grouping of that round's matched values alone. All three " +
      "are properties of the round rather than of anyone's conduct. The " +
      "normative rows are docs/spec/PROTOCOL.md's (Fan-out matching, the " +
      "disclosure delta fan-out pays, the per-side rules, which the pairing " +
      "counts under a one-sided duplicate matching are read from, and the " +
      "`many-to-many` entity closure, which the count under both parties' " +
      "duplicate matching is read from), so a row reclassified there and not " +
      "here is a divergence between a specification and the sentence an " +
      "acceptor consents on.",
    note:
      "A match on this key can rest on one part of a value, such as one word " +
      "of a name, which is weaker evidence than the whole value. A record " +
      "matched this way is left out of the later, less precise keys, even if " +
      "that pairing does not stand. With neither party's duplicate matching " +
      "set, it is paired at most once; with one party's set, a record of " +
      "that party is paired at most once while a record of the other party " +
      "may be paired with several; with both set, it is paired with every " +
      "one of the other party's records any of its parts reached, and the " +
      "records joined that way are disclosed to both parties as one group. " +
      "Under single-pass linkage, the party that receives the other's key " +
      "structure also learns how many parts each of the other's records " +
      "produced for each key and which of those values came from the same " +
      "record. Under cascade linkage, each party instead learns how the " +
      "other's matched values group into records, round by round, for the " +
      "records still in the running.",
  },
  fanOutRefused: {
    basis: "enforced",
    reason:
      "The other case of the same line, and enforced for the same reason the " +
      "`deduplicate` refusal is: a count-only exchange counts matched values " +
      "where the matching pairs each record at most once, so terms declaring " +
      "a candidate set under it are refused when they are authored or " +
      "minted, at the local prepare step, and again at the agreed-terms run " +
      "boundary. The note names the count-only case alone because a " +
      "count-only exchange is the one that refuses split values: both " +
      "linkage strategies match them (docs/spec/PROTOCOL.md, Fan-out runs " +
      "under both linkage strategies). The exchange this invitation " +
      "proposes does not run at all, which is a fact of the run rather than " +
      "of the partner's conduct.",
    note:
      "The exchange will refuse to run these terms. Your partner proposes " +
      "matching on parts of a value, which a count-only exchange cannot do. " +
      "Ask your partner for an invitation that drops the split, or one that " +
      "reveals which records match instead of only their number.",
  },
  candidateSetChainsGrouping: {
    basis: "enforced",
    reason:
      "What the run's own pairing does with a record holding several " +
      "candidate values for one key once BOTH parties group their duplicates: " +
      "acceptance is total there, so every record any of those values matched " +
      "is paired with it, and one group can hold two records no linkage key " +
      "links to each other. The pairs that grouping rests on stand in the " +
      "association table both parties hold, so it is a property of the round " +
      "rather than of anyone's conduct, and the closure reading them is each " +
      "party's own local pass. The normative row is docs/spec/PROTOCOL.md's " +
      "(the `many-to-many` entity closure), so a row reclassified there and " +
      "not here is a divergence between a specification and the sentence an " +
      "acceptor consents on. Resolved by `candidateSetChainsGrouping` " +
      "(consent/invitationSummary.ts) over every producer of a candidate set " +
      "rather than over the `split_on` half alone, and off the accept " +
      "boundary's own verdict on the other party's value rather than the " +
      "strategy rule alone, so no surface withholds the sentence for a key " +
      "that expands its value by another route and none states it where that " +
      "value is one the accept refuses -- a sole-receiver document, which " +
      "leaves that party none to set, as much as a refused pair. The " +
      "sentence states the pair conditionally, since the party reading it " +
      "holds one side and not the other wherever it is rendered.",
    note:
      "Where both parties set duplicate matching for their own records, " +
      "records sharing no matched value are disclosed to both parties as one " +
      "group when a key here matches one record on several values. Every " +
      "record matching any one of those values is grouped with that record " +
      "and with each other.",
  },
  inboundPayloadColumns: {
    basis: "trust-contingent",
    reason:
      "The inviting party's declared payload send, which the acceptance " +
      "mirrors into its own payload receive list. Every run's terms exchange " +
      "compares that list against the send set the inviting party's run " +
      "states, before any key or payload moves, and refuses the run on a " +
      "difference unless this party takes the change on as its new terms. " +
      "What then crosses is held to that set only by the inviting party's own " +
      "build, which sends the columns it stated: this party does not compare " +
      "the received payload against the list, so a partner whose software " +
      "states one set and sends another is not stopped.",
  },
  requestedPayloadColumns: {
    basis: "trust-contingent",
    reason:
      "A request for the acceptor's columns, not a statement of what the " +
      "acceptor sends -- that is settled by the acceptor's own metadata.",
  },
  legalAgreement: {
    basis: "trust-contingent",
    reason:
      "Partner-authored text. The reference and expiry are byte-compared " +
      "against this party's own copy before data moves, but Alcove vets " +
      "neither the agreement nor the purpose it states.",
  },
  linkageRuleSet: {
    basis: "trust-contingent",
    reason:
      "The inviting party's citation of its own rules -- two names and two " +
      "content versions it wrote into the invitation, carried on a " +
      "transcription checksum. Nothing authenticates them, and where BOTH " +
      "parties cite a set the two citations must match before data moves, " +
      "which binds an acceptor to the inviter's own string rather than " +
      "vouching for it. What consent actually turns on is the declared keys " +
      "and fields shown beside this, which ARE byte-compared between the " +
      "parties. The caveat this row would otherwise carry is per half and " +
      "per verdict, so it lives in LINKAGE_RULE_SET_VERDICT_COPY below: a " +
      "single sentence cannot serve a name this build resolved and one it " +
      "could not.",
  },
  invitationExpiry: {
    basis: "enforced",
    reason:
      "Re-checked before and after the key exchange; an expired invitation is " +
      "refused.",
  },
  // The note's "what you send stays encrypted there" is true only because every
  // path rendering this fact is an authenticated accept. The zero-setup exchange
  // takes --retain-files over the bare transport and renders no consent fact,
  // which apps/cli/test/unit/commands/zeroSetup.test.ts pins.
  retainedFiles: {
    basis: "enforced",
    reason:
      "That the exchange runs in retain mode, and the mode AGREEMENT is the " +
      "half the run holds: both parties advertise their retain_files setting in " +
      "the hello and a disagreement aborts both sides before any data moves " +
      "(BilateralModeMismatchError), so an exchange that runs at all is one both " +
      "parties ran in the stated mode. What the run does not hold is what " +
      "becomes of the transcript once it ends -- retain mode deletes nothing, " +
      "and the rendezvous location is the inviting party's to keep or clear -- " +
      "so that half is carried by the note rather than by the marker. Nothing " +
      "applies the inviter's declaration: the accepting party still sets its own " +
      "half, which is what leaves the mismatch to fast-fail (see " +
      "InvitationToken.inviterRetainsFiles). " +
      "Stated on either ground that puts an acceptor's run in retain mode -- the " +
      "inviter declaring it, or an invitation endpoint whose split-directory " +
      "shape requires it of the connection the acceptor is seeded with, where a " +
      "display gated on the declaration alone would say nothing to a party " +
      "consenting to a permanent transcript. One wording covers both: a split " +
      "rendezvous cannot be configured without retain mode on either side, so " +
      "the inviter offering one is running the mode this states. Delete mode is " +
      "not the mirror claim: a run killed outright, or one that fails after the " +
      "handshake, leaves files behind in either mode, so a stated negative would " +
      "promise a cleanup the transport does not make -- and an invitation " +
      "carrying no declaration has made no claim to state at all.",
    note:
      "Every file your partner writes stays in the shared folder or on the " +
      "server after it is read, because your partner runs in retain mode. " +
      "What you send stays encrypted there, and no file left behind is your " +
      "data file or the matched result. The small files the two sides use to " +
      "connect are not encrypted. Anyone who can read that location later " +
      "sees when an exchange ran, how many messages each side sent and their " +
      "sizes, the name each side ran under, and the settings each side " +
      "announced. Your side must also run in retain mode, or the exchange " +
      "stops with an error when the two sides connect. Your partner decides " +
      "what happens to these files afterwards; Alcove does not.",
  },
  invitationRelay: {
    basis: "enforced",
    reason:
      "The urls shown are the invitation's own, and a side that relays " +
      "through them is choosing to with its own software: the command line " +
      "and the browser select them in place of their own relay settings and " +
      "mint the credential themselves, so nothing about which relay a side " +
      "contacts rests on " +
      "the partner's cooperation. What the relay's operator can observe is " +
      "the note's, since that follows from contacting the relay at all.",
    note:
      "The relay's operator learns your network address on every run, " +
      "whether or not any traffic passes through the relay. Your partner " +
      "named this relay for the exchange, and your side uses it in place of " +
      "any relay of your own.",
  },
} as const satisfies Record<string, ConsentFact>;

/** A key of {@link CONSENT_FACTS}. */
export type ConsentFactId = keyof typeof CONSENT_FACTS;

/**
 * The facts only a surface where the accepting party sets its own `deduplicate`
 * can reach. A surface without that control derives the side false
 * ({@link deriveAcceptedLinkageTerms}), so these sentences would describe a run it
 * never conducts. The per-surface note checks read this set.
 */
export const ACCEPTOR_DEDUPLICATE_CONTROL_FACTS = [
  "partnerReadsDuplicateGrouping",
  "partnerDuplicateGroupingWithheld",
  "acceptorDeduplicateRefused",
] as const satisfies ReadonlyArray<ConsentFactId>;

/**
 * The facts only a party reading linkage terms it wrote itself can reach. No
 * invitation or acceptance record is behind either configuration, so an
 * acceptance surface must not render them. Every id ends in `SelfAuthored`, which
 * a core test pins so a new one cannot be left out of this list.
 */
export const SELF_AUTHORED_EXCHANGE_FACTS = [
  "outboundSendSelfAuthored",
  "partnerOwnMembershipWithheldSelfAuthored",
] as const satisfies ReadonlyArray<ConsentFactId>;

/**
 * The terse marker a surface with no styling budget puts on a fact's label for its
 * {@link ConsentFactBasis}. The web states the distinction through its tiering and
 * caveat copy, so it renders no marker.
 */
export const CONSENT_BASIS_MARKERS: Record<ConsentFactBasis, string> = {
  enforced: "enforced",
  "trust-contingent": "your partner's word",
};

/** The finding a `contradicted` half states and what governs the run regardless:
 * both readers' caveats are composed from these, so they differ only in remedy. */
const CONTRADICTED_FINDING =
  "A half marked as not matching names a rule set Alcove ships, but the " +
  "rules declared for it are not drawn from that set, so the citation does " +
  "not describe what the exchange would match on.";

const CONTRADICTED_RULES_GOVERN =
  "the declared keys and fields are what the exchange holds both parties to, " +
  "and what would run.";

/**
 * The marker and caveat for one half of a cited linkage rule set, keyed by this
 * build's verdict on that half; the halves are decided independently. The marker
 * goes on the half's first-party label, never after the partner-controlled value,
 * where a crafted set name could imitate one. Each `note` addresses the recipient;
 * see {@link linkageRuleSetVerdictNote} and docs/notes/rule-set-citation-verdict.md.
 */
export const LINKAGE_RULE_SET_VERDICT_COPY: Record<
  LinkageRuleSetCitationVerdict,
  { marker: string; note: string }
> = {
  consistent: {
    marker: "checked: matches",
    note:
      "A half marked as matching names a rule set Alcove ships, and the rules " +
      "declared for it are drawn from that set. The declared keys and fields " +
      "are still what the exchange holds both parties to.",
  },
  contradicted: {
    marker: "checked: does not match",
    note:
      `${CONTRADICTED_FINDING} Treat the name as unreliable and raise it with ` +
      `the other party; ${CONTRADICTED_RULES_GOVERN}`,
  },
  unchecked: {
    marker: "not checked",
    note:
      "A half marked as not checked names a rule set Alcove does not ship, so " +
      "nothing was compared against it. Your partner's declared keys and " +
      "fields are what the exchange holds both parties to.",
  },
};

/**
 * Verdict severity, most severe first. A rank per verdict rather than an ordered
 * list, so a verdict added to the union and not ranked here fails to compile.
 */
const LINKAGE_RULE_SET_VERDICT_SEVERITY: Record<
  LinkageRuleSetCitationVerdict,
  number
> = {
  contradicted: 0,
  unchecked: 1,
  consistent: 2,
};

/**
 * The distinct verdicts a citation's halves reached, most severe first: one caveat
 * per verdict rather than per half, in an order both surfaces share.
 */
export function distinctLinkageRuleSetVerdicts(
  ...verdicts: ReadonlyArray<LinkageRuleSetCitationVerdict>
): Array<LinkageRuleSetCitationVerdict> {
  return [...new Set(verdicts)].sort(
    (one, other) =>
      LINKAGE_RULE_SET_VERDICT_SEVERITY[one] -
      LINKAGE_RULE_SET_VERDICT_SEVERITY[other],
  );
}

/**
 * Who reads a citation's verdict. A recipient can only raise the name with the
 * other party; the citing party can correct its own terms.
 */
type LinkageRuleSetVerdictReader = "recipient" | "citing-party";

/** Citing-party substitutes. Only `contradicted` has one: the other caveats name
 * a partner as the citation's author, so its actual author is shown none. */
const LINKAGE_RULE_SET_CITING_PARTY_NOTES: Partial<
  Record<LinkageRuleSetCitationVerdict, string>
> = {
  contradicted:
    `${CONTRADICTED_FINDING} The terms are yours to correct: restore the rules ` +
    `the cited set declares, or drop the citation. Either way, ` +
    `${CONTRADICTED_RULES_GOVERN}`,
};

/** The caveat `verdict` has for the party the citation was made to. */
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: "recipient",
): string;
/**
 * The caveat `verdict` has for a reader that may have written the citation: the
 * citing-party substitute, the recipient's sentence for a recipient, or
 * `undefined` where the citing party has none, which a surface renders as nothing.
 */
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: LinkageRuleSetVerdictReader,
): string | undefined;
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: LinkageRuleSetVerdictReader,
): string | undefined {
  return reader === "citing-party"
    ? LINKAGE_RULE_SET_CITING_PARTY_NOTES[verdict]
    : LINKAGE_RULE_SET_VERDICT_COPY[verdict].note;
}

/**
 * The caveat a surface reading a filed exchange record (the disclosure accounting
 * screen and its CSV) renders beside the rule-set citation. A record always pairs
 * the citation with the writing party's verdict (docs/spec/EXCHANGE_RECORD.md), so
 * one sentence pointing at that verdict serves all three verdicts.
 */
export const RECORDED_LINKAGE_RULE_SET_CAVEAT =
  "This citation is the authoring party's own declaration, recorded as " +
  "written. What Alcove could check about it -- whether these names resolve " +
  "to a rule set it ships, and whether the declared rules are drawn from that " +
  "set -- is the writing party's verdict, recorded beside the citation in the " +
  "exchange record itself. What the exchange held both parties to is the " +
  "matching basis recorded beside it.";

/**
 * The outbound-send line when the viewer's partner receives no result. The payload
 * step then sends an empty message, so listing a column set would overstate the
 * disclosure. Viewer-relative, so one sentence serves either side.
 */
export const OUTBOUND_SEND_NO_PAYLOAD_SENTENCE =
  "Your partner receives no result from this exchange, so no columns are sent " +
  "to them, whatever your file contains.";

/**
 * The headline beside the algorithm for a count-only (`psi-c`) exchange; the
 * `countOnly*` entries of {@link CONSENT_FACTS} render with it, for exactly a
 * `psi-c` invitation. The web renders it as the matching-method headline, the CLI
 * beneath the algorithm name.
 */
export const COUNT_ONLY_DISCLOSURE_STATEMENT =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";

/**
 * The disclosure statement beside the duplicate-matches headline when the result
 * reaches the accepting party; the sole-receiver shape takes
 * {@link DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}. Drawn from
 * docs/spec/PROTOCOL.md (The disclosure delta a deduplicating match pays). The
 * closing unverified-count clause is the integrity limit and must stay. Written in
 * party names so it reads correctly from either side.
 */
export const DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT =
  "For each of the accepting party's matched records, that party learns how " +
  "many of the inviting party's records share the matched linkage-key value " +
  "and which of the inviting party's rows they are. It learns a count and " +
  "row positions, never the value behind them, and only for groups that " +
  "matched. That count is the inviting party's own declaration, which Alcove " +
  "does not check against its data.";

/**
 * The disclosure statement when the inviting party is the sole receiver. Its
 * non-receipt is the display half: {@link runExchange} hands a sole-receiver
 * acceptance no association table (packages/core/test/config/linkageCardinality.test.ts).
 * What the wire does with the grouping is a separate fact,
 * `duplicateGroupingWithheld` or `duplicateGroupingDisplayLimit`, selected by
 * {@link withholdsAcceptorAssociationTable}.
 */
export const DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT =
  "Only the inviting party sees the grouping under this invitation. The " +
  "result it receives links several of its own records to a single one of " +
  "the accepting party's records, which is evidence that those of its own " +
  "rows name one individual. The accepting party receives no result from " +
  "this exchange, so Alcove shows it no group sizes and no row positions.";

/**
 * What an inviting party's `deduplicate` costs the accepting party it does not
 * group, shared by both acceptor-side notes and pinned across surfaces by
 * `consent/linkageTermConsentCoverage.ts`. It states the outcome; the mechanism is
 * in docs/notes/deduplicate-matching-semantics.md.
 */
export const DEDUPLICATE_ACCEPTOR_WIDENING_NOTE =
  "It still widens what the accepting party discloses: more of its records " +
  "can match than in a plain one-to-one run of the same two files, and each " +
  "one discloses its membership and any payload columns it sends.";

/**
 * The direction note for a surface with no control over the accepting party's own
 * `deduplicate`, rendered at the level of the disclosure statement it follows.
 * Accepting derives that party's side false ({@link deriveAcceptedLinkageTerms}),
 * so the note names the configuration file as the way to the other direction. A
 * surface with the control renders {@link DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE}.
 */
export const DEDUPLICATE_ACCEPTOR_SIDE_NOTE =
  "This setting is the inviting party's own: the accepting party's records are " +
  "never grouped. " +
  DEDUPLICATE_ACCEPTOR_WIDENING_NOTE +
  " Grouping the accepting party's records instead is set up from each party's " +
  "own configuration file, where each party declares its own side.";

/**
 * The direction note for a surface where the accepting party sets its own
 * `deduplicate`. It drops the "never grouped" clause, which
 * {@link describeDeduplicatePair} states with the selected values, and names the
 * control rather than a configuration file a browser operator may not have.
 */
export const DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE =
  "This setting is the inviting party's own. " +
  DEDUPLICATE_ACCEPTOR_WIDENING_NOTE +
  " Grouping the accepting party's records is that party's own setting, which " +
  "it declares with these terms rather than taking from this invitation.";

/**
 * {@link DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT} in the second person, for
 * a run with no invitation, where nothing tells the reader which party role is
 * theirs. The reader declared the setting, and the grouping reaches its partner's
 * matched records. The integrity-limit clause must stay.
 */
export const DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT =
  "For each of your partner's matched records, your partner learns how many " +
  "of your records share the matched linkage-key value and which of your " +
  "rows they are. It learns a count and row positions, never the value " +
  "behind them, and only for groups that matched. That count is your own " +
  "declaration, which Alcove does not check against your data.";

/** {@link DEDUPLICATE_ACCEPTOR_WIDENING_NOTE} in the second person: the party
 * paying it is the reader's partner. */
export const DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE =
  "It still widens what your partner discloses: more of its records can " +
  "match than in a plain one-to-one run of the same two files, and each one " +
  "discloses its membership and any payload columns it sends.";

/**
 * The direction note for a run with no invitation, where each party declares its
 * own `deduplicate` on its own run. It drops the "never grouped" clause because
 * nothing here knows the partner's value.
 */
export const DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE =
  "This setting is your own. " +
  DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE +
  " Grouping your partner's records is that party's own setting, which it " +
  "declares on its own run rather than reading from these terms.";

/** The two parties' `deduplicate` values and the output shape
 * {@link describeDeduplicatePair} reads. */
export interface DeduplicatePair {
  /** The value the invitation declares for the inviting party. */
  inviterDeduplicate: boolean;
  /** The value the accepting party declares for itself at the seat. */
  acceptorDeduplicate: boolean;
  /**
   * Whether `output.expectsOutput` entitles the inviting party to the result;
   * false leaves the accepting party the only receiver. A deduplicating party must
   * receive output, so this is false only where {@link inviterDeduplicate} is.
   */
  inviterReceivesResult: boolean;
}

/**
 * The sentence a surface where the accepting party sets its own `deduplicate`
 * renders for both parties' values, before any data moves (`describeResolvedMatching`
 * states the agreed pair after the terms exchange). What the inviting party's
 * process reads when it receives no result is a separate fact. Each branch is
 * whole fixed copy, so a surface may render it verbatim.
 */
export function describeDeduplicatePair({
  inviterDeduplicate,
  acceptorDeduplicate,
  inviterReceivesResult,
}: DeduplicatePair): string {
  if (inviterDeduplicate && acceptorDeduplicate)
    return (
      "Both parties declare deduplicate true. The result discloses both " +
      "parties' groupings and holds one row per matched pair, since a matched " +
      "linkage-key value pairs every record of one party holding it with " +
      "every record of the other holding it. " +
      "Where a key matches one record on several values, the records those " +
      "values reach are all grouped with it, so records sharing no matched " +
      "value are disclosed to both parties as one group."
    );
  if (inviterDeduplicate)
    return (
      "The inviting party declares deduplicate true and the accepting party " +
      "declares deduplicate false. Several of the inviting party's records may " +
      "match a single one of the accepting party's; none of the accepting " +
      "party's records are grouped onto one of the inviting party's."
    );
  if (acceptorDeduplicate)
    return inviterReceivesResult
      ? "The inviting party declares deduplicate false and the accepting " +
          "party declares deduplicate true. Several of the accepting party's " +
          "records may match a single one of the inviting party's, so both " +
          "parties receive a result stating how many of the accepting party's " +
          "records share a matched linkage-key value and which of its rows " +
          "they are."
      : "The inviting party declares deduplicate false and the accepting " +
          "party declares deduplicate true. Several of the accepting party's " +
          "records may match a single one of the inviting party's, so the " +
          "result states how many of the accepting party's records share a " +
          "matched linkage-key value and which of its rows they are. These " +
          "terms hand that result to the accepting party alone.";
  return (
    "Both parties declare deduplicate false. Each party's records match at " +
    "most one of the other's, so neither party's file is grouped."
  );
}

/**
 * The caveat for a term an inviter may declare that a count-only exchange refuses,
 * keyed by the term. Each names the refusal and the two invitations the reader can
 * ask for; why a refused term and a narrowing term take different copy: "Proposed
 * is not applied" in docs/notes/shared-consent-summary.md.
 */
export const PROPOSED_NOT_APPLIED_NOTES = {
  fuzzyComparisons:
    "(The exchange will refuse to run these terms, because a count-only " +
    "exchange cannot match approximate variants. Ask your partner for an " +
    "invitation that drops the approximate matching, or one that reveals " +
    "which records match instead of only their number.)",
  swappedKeyOrder:
    "(The exchange will refuse to run these terms, because a count-only " +
    "exchange cannot match in either order. Ask your partner for an " +
    "invitation that drops the swapped key order, or one that reveals which " +
    "records match instead of only their number.)",
} as const;

/**
 * The line a consent surface renders in place of a transform's matching effect when
 * this version recognizes neither the function's slice phrase nor a glossary entry.
 * The function name is partner free text: a surface may show it as identity but
 * must not compose it into a sentence stating an effect.
 */
export const UNRECOGNIZED_TRANSFORM_NOTE =
  "Not recognized by this version; its effect on matching is not shown.";
