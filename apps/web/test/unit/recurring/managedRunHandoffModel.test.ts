import { describe, expect, test } from "vitest";

import {
  MANAGED_HANDOFF_INITIAL,
  managedHandoffReducer,
} from "@recurring/managedRunHandoffModel";

import type {
  ManagedHandoffAction,
  ManagedHandoffState,
} from "@recurring/managedRunHandoffModel";

function fold(
  actions: ReadonlyArray<ManagedHandoffAction>,
  from: ManagedHandoffState = MANAGED_HANDOFF_INITIAL,
): ManagedHandoffState {
  return actions.reduce(managedHandoffReducer, from);
}

describe("an export", () => {
  test("starts idle", () => {
    expect(MANAGED_HANDOFF_INITIAL).toEqual({ export: { kind: "idle" } });
  });

  test("is busy until it ends", () => {
    expect(fold([{ type: "export-started" }]).export).toEqual({ kind: "busy" });
    expect(
      fold([{ type: "export-started" }, { type: "export-finished" }]).export,
    ).toEqual({ kind: "idle" });
    expect(
      fold([{ type: "export-started" }, { type: "backup-exported" }]).export,
    ).toEqual({ kind: "idle" });
  });

  test("a failed one shows until the next starts", () => {
    const failed = fold([
      { type: "export-started" },
      { type: "export-failed" },
    ]);
    expect(failed.export).toEqual({ kind: "failed" });
    expect(fold([{ type: "export-started" }], failed).export).toEqual({
      kind: "busy",
    });
  });
});
