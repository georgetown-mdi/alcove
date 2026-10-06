/**
 * The two causes a receipt verifier gives when the verifier's own signing
 * identity, read from its configuration rather than named for the run,
 * matches neither certificate in a signed receipt. The CLI report and the web
 * verify page each lead into it with their own words for that identity.
 */
export const OWN_IDENTITY_UNMATCHED_CAUSES =
  "you were not a party to this exchange, or you have made a new signing " +
  "identity since";

export const OWN_IDENTITY_UNMATCHED_SENTENCE =
  OWN_IDENTITY_UNMATCHED_CAUSES.charAt(0).toUpperCase() +
  OWN_IDENTITY_UNMATCHED_CAUSES.slice(1);
