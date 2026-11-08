/**
 * The causes a receipt verifier gives when the verifier's own signing
 * identity, read from its configuration rather than named for the run,
 * matches neither certificate in a signed receipt. The CLI report and the web
 * verify page each append it, with a closing period, to their own sentence
 * naming that identity.
 */
export const OWN_IDENTITY_UNMATCHED_SENTENCE =
  "You were not a party to this exchange, or you have made a new signing " +
  "identity since";
