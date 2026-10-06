/**
 * The privacy footer under the disclosure ledger, shared by the inviter and
 * acceptor screens in the browser and the console. The linkage PII (the PSI
 * match keys) is encrypted locally before leaving the machine on every
 * transport, and the machine running the exchange is the operator's own, so
 * the pre-run statement holds for every way an exchange runs.
 */

/** The step that decides the send set: step 2 for the inviter, step 3 (confirm
 * columns) for the acceptor. */
export type SendSetStep = 2 | 3;

/** The pre-run footer, pointing at the step where the "you will send" set is
 * decided. */
export function preRunTrustFooter(sendSetStep: SendSetStep): string {
  return (
    "PII for linkage is encrypted locally before leaving your machine. " +
    "Your partner receives only the fields listed under 'you will send' " +
    `(step ${sendSetStep} above) and only for clients who are in common.`
  );
}

const SETTLED_RESULTS_SENTENCE =
  "The results above are all your partner received about your data.";

/** The footer once a result lands. A server-driven run reads the input file on
 * the console host, not in the browser, so it omits the "never left this
 * browser" sentence. */
export function settledTrustFooter(serverJob: boolean): string {
  return serverJob
    ? SETTLED_RESULTS_SENTENCE
    : `Your file never left this browser. ${SETTLED_RESULTS_SENTENCE}`;
}
