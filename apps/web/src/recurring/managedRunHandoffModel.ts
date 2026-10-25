/**
 * The managed run surface's backup exports: the backup download on the page
 * and the updated backup a finished run offers. No rendering and no I/O -- the
 * surface makes each export and reports its outcome here as an action.
 */

/** The last export's request. Every export on the page shares it: one runs at a
 * time, and a failed one shows its alert until the next starts. */
export type ManagedExportRequest =
  { kind: "idle" } | { kind: "busy" } | { kind: "failed" };

/** The exports' whole state. */
export interface ManagedHandoffState {
  export: ManagedExportRequest;
}

/** No export this visit. */
export const MANAGED_HANDOFF_INITIAL: ManagedHandoffState = {
  export: { kind: "idle" },
};

/** The exports' events. `backup-exported` also marks the backup on the loaded
 * record; the composed surface reducer routes it to both. `export-finished`
 * ends an export that marked nothing, a run-lock refusal included. */
export type ManagedHandoffAction =
  | { type: "export-started" }
  | { type: "export-finished" }
  | { type: "export-failed" }
  | { type: "backup-exported" };

/** The exports' reducer. */
export function managedHandoffReducer(
  state: ManagedHandoffState,
  action: ManagedHandoffAction,
): ManagedHandoffState {
  switch (action.type) {
    case "export-started":
      return { ...state, export: { kind: "busy" } };
    case "export-finished":
    case "backup-exported":
      return { ...state, export: { kind: "idle" } };
    case "export-failed":
      return { ...state, export: { kind: "failed" } };
  }
}
