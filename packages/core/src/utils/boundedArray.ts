import * as z from "zod";

/**
 * Wrap an array schema so an over-count array is rejected with one issue before
 * per-element validation runs; a plain `.max()` runs after it, too late to stop
 * Zod's per-element issues from throwing a `RangeError` (docs/spec/CHANNEL_SECURITY.md,
 * Application-layer parsed-input bounds). The count refine is `abort` so a
 * cross-field refine never runs on the raw elements. For collections legitimately
 * in the millions use {@link singleIssueArray}.
 */
export function boundedArray<T>(
  element: z.ZodType<T>,
  maxEntries: number,
  message: string,
  min?: number,
): z.ZodType<T[]> {
  const validated =
    min === undefined ? z.array(element) : z.array(element).min(min);
  return z
    .array(z.unknown())
    .refine((value) => value.length <= maxEntries, { message, abort: true })
    .pipe(validated);
}
