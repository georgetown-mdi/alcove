/**
 * Name-shape rules for mounted work inputs ({@link isAdmissibleInputName}, used by
 * {@link @jobs/workInputs} and the job intent's `inputFile`) and mount browsing
 * ({@link browseSegment}, used by {@link @jobs/mountBrowse}). Free of filesystem
 * imports so the intent schema can use them. These bound only a name's shape:
 * every by-name file operation re-resolves the name under the mount.
 */

/** The maximum length of an admissible input file name (a single path segment). */
export const MAX_INPUT_NAME_LENGTH = 255;

// C0 controls (which include NUL) and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * A single path segment (no `/`, `\`, or NUL), not `.`/`..`, no control
 * characters, length 1..255. Its two callers differ only in the leading-dot rule.
 */
function hasAdmissibleSegmentShape(name: string): boolean {
  if (name.length === 0 || name.length > MAX_INPUT_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(name)) return false;
  return true;
}

/**
 * Whether `name` is an admissible input file name: the segment shape plus no
 * leading dot, so a `.alcove.key`-shaped file is excluded by construction.
 */
export function isAdmissibleInputName(name: string): boolean {
  if (!hasAdmissibleSegmentShape(name)) return false;
  if (name.startsWith(".")) return false;
  return true;
}

/**
 * Whether `name` is an admissible mount-browse segment: the segment shape with
 * no leading-dot ban, since SSH key material lives under names like `.ssh`.
 */
export function browseSegment(name: string): boolean {
  return hasAdmissibleSegmentShape(name);
}
