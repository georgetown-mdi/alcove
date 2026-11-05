/**
 * The first issue of a schema failure as `path: message`, or the error's own
 * message when it holds no issues, so a refusal names one field and its rule
 * rather than the whole issue list.
 */
export function firstIssue(err: unknown): string {
  const issues = (
    err as { issues?: Array<{ path?: unknown[]; message: string }> }
  ).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const issue = issues[0];
    const at =
      Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.map((segment) => String(segment)).join(".")}: `
        : "";
    return `${at}${issue.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
