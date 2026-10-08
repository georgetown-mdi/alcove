/**
 * Why the exchange-record pair is withheld for a job, distinguished because a
 * client may act on each differently: `no-record` is the console's definitive
 * denial (nothing at the record path), the only one that licenses destroying
 * the workdir without asking; `undescribable-record` is a record file present
 * but not one this bundle can parse (unknown `outcome`, malformed, or missing
 * its keys half); `not-settled` is a run whose child has not exited, even
 * where its terminal event has arrived, since the CLI writes the pair near the
 * end and the run's artifacts are resolved only on exit.
 */
export type RecordUnavailableReason =
  "not-settled" | "no-record" | "undescribable-record";
