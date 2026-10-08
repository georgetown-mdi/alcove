import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  MANAGED_LOAD_INITIAL,
  classifyManagedRecordRead,
  managedLoadFailed,
  managedLoadReducer,
} from "@recurring/managedRunLoadModel";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedLoadAction,
  ManagedLoadState,
} from "@recurring/managedRunLoadModel";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

function runnableRecord(sharedSecret: string): RunnableManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret,
    standingCondition: NO_STANDING_CONDITION,
  };
}

const RECORD = runnableRecord("loaded-secret");
const ROTATED = runnableRecord("fresh-secret");
const CONFIGURATION: ManagedExchangeRecord = {
  ...RECORD,
  sharedSecret: undefined,
  side: undefined,
};
const MARKER: ManagedBackupMarker = {
  backedUpAt: "2026-07-10T09:00:00.000Z",
};
const LOCAL: ManagedLocalState = { backup: MARKER };
const SPENT = { spentAt: "2026-07-14T09:00:00.000Z" };

function fold(
  actions: ReadonlyArray<ManagedLoadAction>,
  from: ManagedLoadState = MANAGED_LOAD_INITIAL,
): ManagedLoadState {
  return actions.reduce(managedLoadReducer, from);
}

const read = (
  record: ManagedExchangeRecord | undefined,
  localState?: ManagedLocalState,
): ManagedLoadAction => ({ type: "record-read", record, localState });

const runnable = fold([read(RECORD, LOCAL)]);
const configuration = fold([read(CONFIGURATION)]);
const heldRunnable = {
  kind: "runnable",
  record: RECORD,
  localState: LOCAL,
  backupMarker: MARKER,
} as const;

describe("a read of the store", () => {
  test("finds no record: missing", () => {
    expect(classifyManagedRecordRead(undefined, LOCAL)).toEqual({
      kind: "missing",
    });
  });

  test("finds a spent copy: spent, whatever the record's shape", () => {
    for (const record of [RECORD, CONFIGURATION])
      expect(classifyManagedRecordRead(record, { spent: SPENT })).toEqual({
        kind: "spent",
        spent: SPENT,
      });
  });

  test("finds a record holding no secret: a configuration", () => {
    expect(classifyManagedRecordRead(CONFIGURATION, LOCAL)).toEqual({
      kind: "configuration",
      configuration: CONFIGURATION,
    });
  });

  test("finds a runnable record: it, its local state and its backup marker", () => {
    expect(classifyManagedRecordRead(RECORD, LOCAL)).toEqual(heldRunnable);
    expect(classifyManagedRecordRead(RECORD, undefined)).toEqual({
      kind: "runnable",
      record: RECORD,
      localState: undefined,
      backupMarker: undefined,
    });
  });
});

describe("the first read", () => {
  test("is under way at the start, with nothing to run from", () => {
    expect(MANAGED_LOAD_INITIAL).toEqual({ kind: "loading", reads: 0 });
    expect(managedLoadFailed(MANAGED_LOAD_INITIAL)).toBe(false);
  });

  test("lands on what it found", () => {
    expect(runnable).toEqual({ ...heldRunnable, reads: 0 });
    expect(configuration).toEqual({
      kind: "configuration",
      configuration: CONFIGURATION,
      reads: 0,
    });
    expect(fold([read(undefined)])).toEqual({
      kind: "missing",
      heldBefore: undefined,
      reads: 0,
    });
    expect(fold([read(RECORD, { spent: SPENT })])).toEqual({
      kind: "spent",
      spent: SPENT,
      byRefusedRun: false,
      heldBefore: undefined,
      reads: 0,
    });
  });

  test("that rejects lands on unloadable", () => {
    const state = fold([{ type: "record-read-failed" }]);
    expect(state).toEqual({
      kind: "unloadable",
      heldBefore: undefined,
      reads: 0,
    });
    expect(managedLoadFailed(state)).toBe(true);
  });
});

describe("a later read", () => {
  test("keeps what is on screen until it answers", () => {
    const requested = fold([{ type: "record-read-requested" }], runnable);
    expect(requested).toEqual({ ...runnable, reads: 1 });
  });

  test("of a runnable record replaces the record and what was read beside it", () => {
    const state = fold([read(ROTATED, undefined)], runnable);
    expect(state).toEqual({
      kind: "runnable",
      record: ROTATED,
      localState: undefined,
      backupMarker: undefined,
      reads: 0,
    });
  });

  test("that finds a failure keeps the record held before it", () => {
    expect(fold([read(undefined)], runnable)).toEqual({
      kind: "missing",
      heldBefore: heldRunnable,
      reads: 0,
    });
    expect(fold([{ type: "record-read-failed" }], configuration)).toEqual({
      kind: "unloadable",
      heldBefore: { kind: "configuration", configuration: CONFIGURATION },
      reads: 0,
    });
  });

  test("leaves a failure on screen unless it finds another", () => {
    const missing = fold([read(undefined)], runnable);
    expect(fold([read(ROTATED)], missing)).toBe(missing);
    expect(fold([read(CONFIGURATION)], missing)).toBe(missing);
    expect(fold([read(RECORD, { spent: SPENT })], missing)).toEqual({
      kind: "spent",
      spent: SPENT,
      byRefusedRun: false,
      heldBefore: heldRunnable,
      reads: 0,
    });
  });

  test("of a spent copy keeps the refused run's account", () => {
    const refused = fold(
      [{ type: "run-handed-off", spent: undefined }],
      runnable,
    );
    const reread = fold([read(RECORD, { spent: SPENT })], refused);
    expect(reread).toEqual({
      kind: "spent",
      spent: SPENT,
      byRefusedRun: true,
      heldBefore: heldRunnable,
      reads: 0,
    });
  });

  test("of a configuration replaces a runnable record, and not the other way", () => {
    expect(fold([read(CONFIGURATION)], runnable)).toEqual(configuration);
    expect(fold([read(RECORD, LOCAL)], configuration)).toBe(configuration);
  });
});

describe("a re-take of a spent copy", () => {
  test("shows the record held before the hand-off again and reads it again", () => {
    const refused = fold([{ type: "run-handed-off", spent: SPENT }], runnable);
    expect(fold([{ type: "record-retaken" }], refused)).toEqual({
      ...heldRunnable,
      reads: 1,
    });
  });

  test("of a copy the first read found spent returns to loading", () => {
    const spent = fold([read(RECORD, { spent: SPENT })]);
    const retaken = fold([{ type: "record-retaken" }], spent);
    expect(retaken).toEqual({ kind: "loading", reads: 1 });
    expect(fold([read(RECORD, LOCAL)], retaken)).toEqual({
      ...heldRunnable,
      reads: 1,
    });
  });

  test("away from a failure only reads again", () => {
    expect(fold([{ type: "record-retaken" }], runnable)).toEqual({
      ...runnable,
      reads: 1,
    });
  });
});

describe("a run the hand-off refused", () => {
  test("spends the copy with the run's account, keeping the record held", () => {
    const state = fold([{ type: "run-handed-off", spent: SPENT }], runnable);
    expect(state).toEqual({
      kind: "spent",
      spent: SPENT,
      byRefusedRun: true,
      heldBefore: heldRunnable,
      reads: 0,
    });
    expect(managedLoadFailed(state)).toBe(true);
  });

  test("names no hand-off where the reload did not answer", () => {
    const state = fold(
      [{ type: "run-handed-off", spent: undefined }],
      runnable,
    );
    expect(state.kind === "spent" && state.spent).toBeUndefined();
  });
});

describe("the events of a runnable record", () => {
  const others: ReadonlyArray<ManagedLoadState> = [
    MANAGED_LOAD_INITIAL,
    configuration,
    fold([read(undefined)], runnable),
    fold([{ type: "run-handed-off", spent: SPENT }], runnable),
  ];

  test("an adopted write replaces the record and keeps what was read beside it", () => {
    expect(
      fold([{ type: "record-adopted", record: ROTATED }], runnable),
    ).toEqual({ ...runnable, record: ROTATED });
  });

  test("a failed run's reload replaces the local state alone", () => {
    const reloaded: ManagedLocalState = { imported: { importedAt: "x" } };
    expect(
      fold([{ type: "local-state-reloaded", localState: reloaded }], runnable),
    ).toEqual({ ...runnable, localState: reloaded });
  });

  test("a backup replaces the backup marker alone", () => {
    const marker: ManagedBackupMarker = {
      backedUpAt: "2026-07-20T09:00:00.000Z",
    };
    expect(fold([{ type: "backup-marked", marker }], runnable)).toEqual({
      ...runnable,
      backupMarker: marker,
    });
  });

  test("change nothing on any other page", () => {
    for (const state of others)
      for (const action of [
        { type: "record-adopted", record: ROTATED },
        { type: "local-state-reloaded", localState: undefined },
        { type: "backup-marked", marker: MARKER },
      ] satisfies ReadonlyArray<ManagedLoadAction>)
        expect(managedLoadReducer(state, action)).toBe(state);
  });
});

describe("an edited configuration", () => {
  test("replaces the configuration on its own page", () => {
    const edited = { ...CONFIGURATION, label: "Renamed" };
    expect(
      fold(
        [{ type: "configuration-edited", configuration: edited }],
        configuration,
      ),
    ).toEqual({ ...configuration, configuration: edited });
  });

  test("changes nothing elsewhere", () => {
    expect(
      managedLoadReducer(runnable, {
        type: "configuration-edited",
        configuration: CONFIGURATION,
      }),
    ).toBe(runnable);
  });
});
