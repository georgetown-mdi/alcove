import * as z from "zod";

/**
 * An array schema validating its elements in one pass that emits at most one
 * issue, for partner-controlled arrays legitimately in the millions: Zod's
 * one-issue-per-element accumulation throws a `RangeError` on millions of invalid
 * elements, and a count `.max()` runs after the elements and would reject a real
 * exchange (docs/spec/CHANNEL_SECURITY.md, Application-layer parsed-input bounds).
 * `isElement` must mirror exactly the element schema it replaces. Pass `T`
 * explicitly; it is not inferred from `isElement`.
 */
export function singleIssueArray<T>(
  isElement: (value: unknown) => boolean,
  message: string,
): z.ZodType<T[]> {
  return z.custom<T[]>(
    (value) => Array.isArray(value) && value.every(isElement),
    { message },
  );
}
