/**
 * The localStorage key that opts one browser into diagnostic logging against a
 * deployed client: set it to `"1"` from the devtools console and reload.
 */
export const DIAGNOSTICS_STORAGE_KEY = "alcove:diagnostics";

/**
 * Whether the stored flag value engages diagnostic mode: anything but unset,
 * `""`, `"0"`, `"false"` or `"off"`.
 *
 * @internal exported for unit tests; production code calls {@link isDiagnosticMode}.
 */
export function isDiagnosticsFlagValue(raw: string | null): boolean {
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "off";
}

/**
 * Gates raised-verbosity logging across the web app: a development build, or a
 * deployed client with {@link DIAGNOSTICS_STORAGE_KEY} set.
 */
export function isDiagnosticMode(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return isDiagnosticsFlagValue(
      globalThis.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY),
    );
  } catch {
    // Absent during SSR and throws when storage is blocked; either way, off.
    return false;
  }
}

/**
 * Runs `emit` only under {@link isDiagnosticMode}: the gate for a devtools sink
 * that would put partner- or server-influenced bytes into a production browser
 * console. A closure keeps the live `Error` in devtools and builds nothing
 * outside diagnostic mode.
 */
export function whenDiagnostic(emit: () => void): void {
  if (isDiagnosticMode()) emit();
}
