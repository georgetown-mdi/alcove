import {
  redactAndFitUnescaped,
  redactAndSanitizeForDisplay,
} from "./sanitizeErrorForDisplay";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "./sanitizeForDisplay";
import type { Displayable } from "./sanitizeForDisplay";

/**
 * One Zod issue-path segment, or any other object key a message names, fitted to
 * a single value's display budget. A segment can be a partner-written key bounded
 * only by the frame cap, and the path leads the description, so an unfitted one
 * would cut the refusal reason behind it.
 *
 * @internal not a stable public API.
 */
export const fittedPathSegment = (segment: PropertyKey): string =>
  redactAndFitUnescaped(String(segment), DEFAULT_MAX_DISPLAY_LENGTH);

/**
 * An invitation decode or validation failure, composed raw for an `Error`
 * message or `cause`: a `ZodError` as its first issue, `<path>: <message>` plus
 * `(and N more)`; any other `Error` as its message; anything else as `String(err)`.
 * It escapes nothing (the rendered error is escaped once where shown) but fits
 * each partner-chosen fragment, so none spends the budget of the reason beside
 * it. A caller that redacts does so where it interpolates this. The split between
 * this and {@link describeDecodeError}: docs/spec/CHANNEL_SECURITY.md, Display
 * sanitization escape format.
 */
export function rawDecodeErrorDescription(err: unknown): string {
  if (err !== null && typeof err === "object" && "issues" in err) {
    const { issues } = err as {
      issues?: Array<{ path?: Array<PropertyKey>; message?: string }>;
    };
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0];
      const at =
        Array.isArray(first.path) && first.path.length > 0
          ? `${first.path.map(fittedPathSegment).join(".")}: `
          : "";
      const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
      return `${at}${first.message ?? "schema validation failed"}${more}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * {@link rawDecodeErrorDescription} redacted and escaped once, as a
 * {@link Displayable}, for a consumer whose render is the sink (the web accept
 * screen's React text node, which does not neutralize control or bidi bytes).
 * Capped at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}: the description is a
 * composition, and the per-value budget would cut its first-party guidance.
 */
export function describeDecodeError(err: unknown): Displayable {
  return redactAndSanitizeForDisplay(rawDecodeErrorDescription(err), {
    maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  });
}
