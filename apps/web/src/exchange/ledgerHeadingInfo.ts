/** Plain-language explanations for the ledger's row headings, shown by the
 * info icon beside each heading (hover, focus, or tap). Keyed by row label so
 * every producer -- the inviter's, the acceptor's, and their final past-tense
 * variants -- gets one shared explanation; a label with no entry renders
 * without an icon. Perspective-neutral wording, since the same label can face
 * either party. */
export const LEDGER_HEADING_INFO: Readonly<Record<string, string | undefined>> =
  {
    "You will receive":
      "What you get when the exchange finishes, if anything: the records " +
      "you both hold and any columns your partner sends, or only how many " +
      "records you have in common.",
    "You received":
      "What arrived when the exchange finished: the records you both hold " +
      "and any columns your partner sent.",
    "Matched on":
      "The fields used to decide whether your record and your partner's " +
      "record are the same, tried in order. Only cryptographic fingerprints " +
      "of these fields are compared; the values themselves are not revealed.",
    Expires:
      "When the invitation stops working. If it expires before the exchange " +
      "runs, a new invitation is needed.",
    "Results go to":
      "Who receives the result when the exchange finishes: the matched " +
      "records, or only the count.",
    "Results went to":
      "Who received the list of matched records when the exchange finished.",
    Agreement:
      "The data sharing agreement referenced for this exchange, if any. Both " +
      "parties see the reference before the exchange runs.",
    "How it runs":
      "How the exchange runs: live between your two browsers, or through " +
      "files on an SFTP server or shared folder using the command-line " +
      "tool.",
  };

/** The "How it runs" explanation on the console, where the server runs every
 * exchange and the browser does no exchange work. */
export const CONSOLE_HOW_IT_RUNS_INFO =
  "How the exchange runs: this console runs it, not your " +
  "browser. It goes through files on an SFTP server or a shared folder, or " +
  "live over WebRTC.";
