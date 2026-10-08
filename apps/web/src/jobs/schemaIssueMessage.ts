/**
 * How a job route describes a body its schema rejected: a field path and a
 * fixed shape reason, never a byte the submitter chose. Every route that
 * answers a rejected body with a message composes it here.
 *
 * A leaf module: it imports nothing else from the job API, since modules that
 * already depend on each other both import it.
 */

/** The part of a schema issue these formatters read; a zod issue from any job
 * body satisfies it. */
interface JobSchemaIssue {
  code: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/** The fixed reason for an unrecognized-key rejection, whose own message
 * quotes the submitter's key names. */
const UNRECOGNIZED_KEY_REASON = "unrecognized key";

/** The reason clause for one issue. */
function issueReason(issue: JobSchemaIssue): string {
  return issue.code === "unrecognized_keys"
    ? UNRECOGNIZED_KEY_REASON
    : issue.message;
}

/**
 * Format a rejected body's first schema issue as `<field>: <reason>`, for a
 * parse over the request body itself; an issue with no path is `body`. Throws
 * on an empty list, which a failed parse never reports.
 */
export function formatFirstIssue(
  issues: ReadonlyArray<JobSchemaIssue>,
): string {
  if (issues.length === 0)
    throw new Error("a rejected body had no schema issue to format");
  const issue = issues[0];
  const field =
    issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
  return `${field}: ${issueReason(issue)}`;
}

/**
 * Format every issue of a rejected body as one `<root>[.<path>]: <reason>`
 * message, for the authoring path. `root` names the sub-object the parse ran
 * over (`server`, `connection`, `connection.credential`). Throws on an empty
 * list, as {@link formatFirstIssue} does.
 */
export function formatIssues(
  issues: ReadonlyArray<JobSchemaIssue>,
  root: string,
): string {
  if (issues.length === 0)
    throw new Error("a rejected body had no schema issue to format");
  return issues
    .map((issue) => {
      const fieldPath = [root, ...issue.path.map(String)].join(".");
      return `${fieldPath}: ${issueReason(issue)}`;
    })
    .join("; ");
}
