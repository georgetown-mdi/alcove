/**
 * The names the CLI gives a run's artifacts when its output argument is a
 * folder: each holds the run's stamp, the record's `createdAt` made
 * filesystem-safe (docs/spec/EXCHANGE_RECORD.md, Result file name). The
 * console passes the job's workdir as that folder and runs the CLI in it, so
 * every artifact of one run lands there under one stamp.
 */

/** A stamp as the CLI writes it: an ISO-8601 UTC instant with the colons and
 * the fractional-second dot replaced by hyphens. Nothing else is a stamp, so a
 * name built from one cannot hold a separator or a `..`. */
const STAMP_SOURCE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,9})?Z`;

const RUN_ARTIFACT_PATTERN = new RegExp(
  String.raw`^alcove-(results|record|receipt)-(${STAMP_SOURCE})(\.keys\.json|\.terms\.json|\.json|\.csv)$`,
);

/** One run's artifact kinds. */
export type RunArtifactKind =
  "result" | "record" | "keys" | "terms" | "receipt";

/** Each of one run's artifact names, all sharing its stamp. */
export type RunArtifactNames = Record<RunArtifactKind, string>;

/** The artifact names a run with this stamp writes. */
export function runArtifactNames(stamp: string): RunArtifactNames {
  return {
    result: `alcove-results-${stamp}.csv`,
    record: `alcove-record-${stamp}.json`,
    keys: `alcove-record-${stamp}.keys.json`,
    terms: `alcove-record-${stamp}.terms.json`,
    receipt: `alcove-receipt-${stamp}.json`,
  };
}

const KIND_BY_STEM_AND_SUFFIX: Record<string, RunArtifactKind> = {
  "results.csv": "result",
  "record.json": "record",
  "record.keys.json": "keys",
  "record.terms.json": "terms",
  "receipt.json": "receipt",
};

/** The kind and stamp of a run artifact's file name, or null for any other
 * name. */
export function parseRunArtifactName(
  name: string,
): { kind: RunArtifactKind; stamp: string } | null {
  const match = RUN_ARTIFACT_PATTERN.exec(name);
  if (match === null) return null;
  const [, stem, stamp, suffix] = match;
  const kind = KIND_BY_STEM_AND_SUFFIX[`${stem}${suffix}`] as
    RunArtifactKind | undefined;
  return kind === undefined ? null : { kind, stamp };
}

/** The instant a stamp names, in milliseconds since the epoch. */
function runStampTime(stamp: string): number {
  return Date.parse(
    stamp.replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-(\d+))?Z$/,
      (_whole, head: string, minutes: string, seconds: string, fraction) =>
        `${head}:${minutes}:${seconds}${typeof fraction === "string" ? `.${fraction}` : ""}Z`,
    ),
  );
}

/** The latest run among `stamps` by the instant each names, or null for none. */
export function latestRunStamp(stamps: Iterable<string>): string | null {
  let latest: string | null = null;
  for (const stamp of stamps)
    if (latest === null || compareRunStamps(stamp, latest) > 0) latest = stamp;
  return latest;
}

function compareRunStamps(left: string, right: string): number {
  const byTime = runStampTime(left) - runStampTime(right);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The stamp of the result file a `result` event's `resultPath` names, or null
 * where its last segment is not a result name -- a path the relay cut short
 * included. */
export function stampOfResultPath(resultPath: unknown): string | null {
  if (typeof resultPath !== "string") return null;
  const name = resultPath.slice(
    Math.max(resultPath.lastIndexOf("/"), resultPath.lastIndexOf("\\")) + 1,
  );
  const parsed = parseRunArtifactName(name);
  return parsed?.kind === "result" ? parsed.stamp : null;
}

/** A run's artifact names with the stamp spelled `<time>`, for text naming
 * them where the stamp is not known. */
export const RUN_ARTIFACT_NAME_PATTERNS: RunArtifactNames =
  runArtifactNames("<time>");
