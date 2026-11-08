/**
 * The privacy footer under the disclosure ledger, shared by the inviter and
 * acceptor screens in the browser and the console. The linkage PII (the PSI
 * match keys) is encrypted locally before leaving the machine on every
 * transport, and the machine running the exchange is the operator's own, so
 * the pre-run statement holds for every way an exchange runs.
 */

/** What the agreed terms give the viewer's partner: the matched results, only
 * the count, or nothing. */
export type PartnerResult = "matched" | "count-only" | "none";

/** The {@link PartnerResult} of a run, from whether the partner is entitled to
 * a result and whether the run is count-only. */
export function partnerResultOf(input: {
  partnerReceives: boolean;
  countOnly: boolean;
}): PartnerResult {
  if (!input.partnerReceives) return "none";
  return input.countOnly ? "count-only" : "matched";
}

/** The pre-run footer. */
export const PRE_RUN_TRUST_FOOTER =
  "The fields you match on are encrypted before they leave your machine. " +
  'Your partner gets only the columns listed under "You will send", and only for ' +
  "records you both hold.";

/** The footer's closing sentence once a result lands, by what the partner
 * got. */
const SETTLED_PARTNER_RESULT_SENTENCES: Record<PartnerResult, string> = {
  matched:
    "Your partner's results show only the records you have in common and " +
    "the columns you sent for them.",
  "count-only":
    "Your partner's results show only how many records you have in common.",
  none: "Your partner gets no results.",
};

/** The footer once a result lands. A server-driven run reads the input file on
 * the console host, not in the browser, so it omits the "encrypted locally in
 * your browser" sentence. */
export function settledTrustFooter(
  serverJob: boolean,
  partnerResult: PartnerResult,
): string {
  const sentence = SETTLED_PARTNER_RESULT_SENTENCES[partnerResult];
  return serverJob
    ? sentence
    : `Data was encrypted locally in your browser before being sent to your partner. ${sentence}`;
}
