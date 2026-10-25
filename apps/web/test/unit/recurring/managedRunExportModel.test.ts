import { describe, expect, test } from "vitest";

import {
  MANAGED_EXPORTS_INITIAL,
  managedExportsReducer,
} from "@recurring/managedRunExportModel";

import type {
  ManagedExportAction,
  ManagedExportsState,
} from "@recurring/managedRunExportModel";

function fold(
  actions: ReadonlyArray<ManagedExportAction>,
  from: ManagedExportsState = MANAGED_EXPORTS_INITIAL,
): ManagedExportsState {
  return actions.reduce(managedExportsReducer, from);
}

describe("an export", () => {
  test("starts idle", () => {
    expect(MANAGED_EXPORTS_INITIAL).toEqual({ export: { kind: "idle" } });
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
