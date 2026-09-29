/**
 * The placeholder `alcove init` writes into a fresh template when given no
 * `--identity`. It must be non-empty for the template to parse -- the
 * linkage-terms schema gives identity a one-character minimum -- so no schema
 * check catches it; only this exact string distinguishes it from a name the
 * operator chose.
 */
export const PLACEHOLDER_IDENTITY = "REPLACE_WITH_YOUR_IDENTITY";

/**
 * Why a party identity names no party, or undefined where it names one:
 * `"absent"` for a missing or whitespace-only value, `"placeholder"` for
 * {@link PLACEHOLDER_IDENTITY}. The placeholder comparison is whole-string
 * against the trimmed value, so a label that merely contains that text, or
 * differs from it in case, is a name like any other.
 */
export function unnamedPartyIdentity(
  identity: string | undefined,
): "absent" | "placeholder" | undefined {
  if (identity === undefined) return "absent";
  const trimmed = identity.trim();
  if (trimmed === "") return "absent";
  if (trimmed === PLACEHOLDER_IDENTITY) return "placeholder";
  return undefined;
}
