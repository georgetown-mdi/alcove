import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  MANAGED_HANDOFF_INITIAL,
  managedHandoffReducer,
  managedMigrationAwaitingConfirm,
  managedMigrationRefusal,
  managedMigrationStale,
  managedRunHoldsMigration,
} from "@recurring/managedRunHandoffModel";

import type {
  ManagedHandoffAction,
  ManagedHandoffState,
} from "@recurring/managedRunHandoffModel";
import type { ManagedMigrationDispatch } from "@psi/managed/managedExchangeExport";
import type { RunLines } from "@recurring/scheduledRunCommand";

const DISPATCH: ManagedMigrationDispatch = {
  backedUpAt: new Date("2026-10-07T12:00:00Z"),
  record: {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: "loaded-secret",
    standingCondition: NO_STANDING_CONDITION,
  },
  confirm: () => Promise.resolve(),
};

const COMMAND_LINE: RunLines = {
  kind: "withheld",
  notice: "Run it on the other machine.",
};

function fold(
  actions: ReadonlyArray<ManagedHandoffAction>,
  from: ManagedHandoffState = MANAGED_HANDOFF_INITIAL,
): ManagedHandoffState {
  return actions.reduce(managedHandoffReducer, from);
}

const awaiting = fold([
  { type: "export-started" },
  { type: "migration-dispatched", dispatch: DISPATCH },
]);

describe("an export", () => {
  test("starts idle with no hand-off", () => {
    expect(MANAGED_HANDOFF_INITIAL).toEqual({
      export: { kind: "idle" },
      migration: { kind: "none" },
      commandLine: undefined,
    });
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

describe("a migration", () => {
  test("once dispatched awaits the operator's confirmation", () => {
    expect(awaiting.export).toEqual({ kind: "idle" });
    expect(managedMigrationAwaitingConfirm(awaiting)).toBe(DISPATCH);
    expect(managedMigrationRefusal(awaiting)).toBeUndefined();
  });

  test("confirmed is migrated and holds no dispatch", () => {
    const migrated = fold(
      [{ type: "migration-confirm-started" }, { type: "migration-confirmed" }],
      awaiting,
    );
    expect(migrated.migration).toEqual({ kind: "migrated" });
    expect(migrated.export).toEqual({ kind: "idle" });
    expect(managedMigrationAwaitingConfirm(migrated)).toBeUndefined();
  });

  test("once migrated stays migrated", () => {
    const migrated = fold([{ type: "migration-confirmed" }], awaiting);
    expect(
      fold([{ type: "migration-dispatched", dispatch: DISPATCH }], migrated)
        .migration,
    ).toEqual({ kind: "migrated" });
    expect(fold([{ type: "migration-kept" }], migrated)).toBe(migrated);
  });

  test("a refused spend keeps the confirmation and states the refusal", () => {
    const refused = fold(
      [
        { type: "migration-confirm-started" },
        { type: "migration-refused", refusal: "superseded" },
      ],
      awaiting,
    );
    expect(refused.export).toEqual({ kind: "idle" });
    expect(managedMigrationAwaitingConfirm(refused)).toBe(DISPATCH);
    expect(managedMigrationRefusal(refused)).toBe("superseded");
  });

  test("a confirmation started again drops the last refusal", () => {
    const retried = fold(
      [
        { type: "migration-refused", refusal: "run-in-flight" },
        { type: "migration-confirm-started" },
      ],
      awaiting,
    );
    expect(retried.export).toEqual({ kind: "busy" });
    expect(managedMigrationRefusal(retried)).toBeUndefined();
  });

  test("a refusal or a confirmation start outside a confirmation changes no migration", () => {
    expect(
      fold([{ type: "migration-refused", refusal: "record-gone" }]).migration,
    ).toEqual({ kind: "none" });
    expect(fold([{ type: "migration-confirm-started" }]).migration).toEqual({
      kind: "none",
    });
  });

  test("kept on this device drops the dispatch and its refusal", () => {
    const kept = fold(
      [
        { type: "migration-refused", refusal: "record-gone" },
        { type: "migration-kept" },
      ],
      awaiting,
    );
    expect(kept.migration).toEqual({ kind: "none" });
    expect(managedMigrationRefusal(kept)).toBeUndefined();
  });

  test("kept with no confirmation showing returns the same state", () => {
    expect(fold([{ type: "migration-kept" }])).toBe(MANAGED_HANDOFF_INITIAL);
  });
});

describe("what holds a migration", () => {
  test("a run holds it: the polled reading or the spend's own refusal", () => {
    expect(managedRunHoldsMigration(awaiting, false)).toBe(false);
    expect(managedRunHoldsMigration(awaiting, true)).toBe(true);
    const refused = fold(
      [{ type: "migration-refused", refusal: "run-in-flight" }],
      awaiting,
    );
    expect(managedRunHoldsMigration(refused, false)).toBe(true);
  });

  test("a run's refusal is not stale; the others are", () => {
    expect(managedMigrationStale(awaiting)).toBe(false);
    for (const [refusal, stale] of [
      ["run-in-flight", false],
      ["superseded", true],
      ["record-gone", true],
    ] as const) {
      const refused = fold([{ type: "migration-refused", refusal }], awaiting);
      expect(managedMigrationStale(refused)).toBe(stale);
      expect(managedRunHoldsMigration(refused, false)).toBe(!stale);
    }
  });
});

describe("a command-line hand-off", () => {
  test("holds the invocation handed over", () => {
    expect(
      fold([{ type: "command-line-handed-off", handoff: COMMAND_LINE }])
        .commandLine,
    ).toBe(COMMAND_LINE);
  });

  test("leaves the export and the migration as they were", () => {
    const handedOff = fold(
      [{ type: "command-line-handed-off", handoff: COMMAND_LINE }],
      awaiting,
    );
    expect(handedOff.export).toBe(awaiting.export);
    expect(handedOff.migration).toBe(awaiting.migration);
  });
});
