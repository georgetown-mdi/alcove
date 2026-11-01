import { describe, expect, test } from "vitest";

import {
  FormatMigrationError,
  migrateOnRead,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import {
  LATER_VERSION_RECORDS_CAUSE,
  LATER_VERSION_RECORD_LABEL,
  STATE_UNREADABLE_NOTE,
  UNREADABLE_RECORDS_CAUSE,
  UNREADABLE_RECORD_LABEL,
  recoveryRow,
  recoveryRows,
  savedExchangesFailedCauses,
} from "@recurring/savedExchangesRecovery";

import type { ManagedExchangeDiagnosticEntry } from "@psi/managed/managedExchangeStore";

// The read-failed recovery listing's display derivation, tested in Node: a
// readable entry shows its label, side, and last-run date; an unreadable
// entry shows a fixed label and its stored key, and nothing more. Every row
// has the key the one-step delete-by-key acts on.

function readable(
  overrides: Partial<{
    id: string;
    label: string;
    side: "inviter" | "acceptor" | undefined;
    elsewhereChannel: "sftp" | "filedrop";
    lastRunAt: string;
    backedUp: boolean;
    stateUnreadable: true;
  }> = {},
): ManagedExchangeDiagnosticEntry {
  // An explicit `side: undefined` stands for a configuration whose channel
  // names no side.
  const side = "side" in overrides ? overrides.side : "inviter";
  return {
    kind: "readable",
    backedUp: overrides.backedUp ?? false,
    ...(overrides.stateUnreadable === true ? { stateUnreadable: true } : {}),
    essentials: {
      id: overrides.id ?? "abc",
      label: overrides.label ?? "Riverbend quarterly",
      ...(side !== undefined ? { side } : {}),
      ...(overrides.elsewhereChannel !== undefined
        ? { elsewhereChannel: overrides.elsewhereChannel }
        : {}),
      ...(overrides.lastRunAt !== undefined
        ? { lastRunAt: overrides.lastRunAt }
        : {}),
    },
  };
}

describe("recoveryRow", () => {
  test("a readable entry shows its label, side, and last-run date", () => {
    const row = recoveryRow(
      readable({
        id: "one",
        label: "Riverbend quarterly",
        side: "acceptor",
        lastRunAt: "2026-07-10T09:00:00.000Z",
      }),
    );
    expect(row.id).toBe("one");
    expect(row.label).toBe("Riverbend quarterly");
    expect(row.deleteLabel).toBe("Riverbend quarterly");
    expect(row.sideLabel).toBe("You accepted");
    expect(row.lastRunAt).toBeDefined();
    expect(row.unreadable).toBe(false);
  });

  test("a readable configuration with no side names its channel, as the saved list does", () => {
    const row = recoveryRow(
      readable({ side: undefined, elsewhereChannel: "filedrop" }),
    );
    expect(row.sideLabel).toBe("Shared-folder exchange");
    expect(
      recoveryRow(readable({ side: undefined, elsewhereChannel: "sftp" }))
        .sideLabel,
    ).toBe("SFTP exchange");
  });

  test("an empty label displays as (unnamed exchange) in the row text", () => {
    expect(recoveryRow(readable({ label: "" })).label).toBe(
      "(unnamed exchange)",
    );
  });

  test("an empty label leaves the delete confirm's label raw, so the button says 'Delete this exchange?'", () => {
    // The row text is the display transform, but the delete confirm names the raw
    // label: an empty deleteLabel fires the button's own empty-label branch rather
    // than a doubly-transformed "(unnamed exchange)".
    expect(recoveryRow(readable({ label: "" })).deleteLabel).toBe("");
  });

  test("a readable entry with no run has no last-run date", () => {
    expect(recoveryRow(readable()).lastRunAt).toBeUndefined();
  });

  test("a readable entry threads its backup custody state through to the confirm", () => {
    expect(recoveryRow(readable({ backedUp: true })).backedUp).toBe(true);
    expect(recoveryRow(readable({ backedUp: false })).backedUp).toBe(false);
  });

  test("an unreadable entry shows the fixed label, an empty delete label, and its key", () => {
    const row = recoveryRow({
      kind: "unreadable",
      id: "bad-key",
      backedUp: false,
    });
    expect(row.id).toBe("bad-key");
    expect(row.label).toBe(UNREADABLE_RECORD_LABEL);
    expect(row.deleteLabel).toBe("");
    expect(row.sideLabel).toBeUndefined();
    expect(row.lastRunAt).toBeUndefined();
    expect(row.unreadable).toBe(true);
    expect(row.migrationFailure).toBeUndefined();
  });

  test("an unreadable entry whose migration failed shows the refusal, escaped", () => {
    let refusal: unknown;
    try {
      migrateOnRead(
        { schemaVersion: "alcove-managed-exchange/v3\u0007", label: "x" },
        {
          fileName: "A saved exchange",
          versionField: "schemaVersion",
          current: "alcove-managed-exchange/v4",
          steps: [
            {
              from: "alcove-managed-exchange/v3\u0007",
              to: "alcove-managed-exchange/v4",
              migrate: () => {
                throw new Error("the step cannot move it");
              },
            },
          ],
          failureRemedy: "Remove it.",
        },
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(FormatMigrationError);

    const row = recoveryRow({
      kind: "unreadable",
      id: "bad-key",
      backedUp: false,
      migrationFailure: refusal as FormatMigrationError,
    });

    expect(row.migrationFailure).toBe(sanitizeErrorForDisplay(refusal));
    expect(row.migrationFailure).toContain("the step cannot move it");
    expect(row.migrationFailure).not.toContain("\u0007");
  });

  test("a readable entry whose saved state cannot be read keeps its essentials and says so", () => {
    const row = recoveryRow(
      readable({
        lastRunAt: "2026-07-10T09:00:00.000Z",
        stateUnreadable: true,
      }),
    );
    expect(row.label).toBe("Riverbend quarterly");
    expect(row.sideLabel).toBe("You sent the invitation");
    expect(row.lastRunAt).toBeDefined();
    expect(row.unreadable).toBe(false);
    expect(row.stateUnreadable).toBe(true);
    expect(STATE_UNREADABLE_NOTE).toBe(
      "Part of its saved state cannot be read",
    );
    expect(recoveryRow(readable()).stateUnreadable).toBe(false);
    expect(
      recoveryRow({ kind: "unreadable", id: "bad-key", backedUp: true })
        .stateUnreadable,
    ).toBe(false);
  });

  test("an unreadable entry with a live backup marker threads its custody state through", () => {
    expect(
      recoveryRow({ kind: "unreadable", id: "bad-key", backedUp: true })
        .backedUp,
    ).toBe(true);
  });
});

describe("a record a newer version saved", () => {
  const later: ManagedExchangeDiagnosticEntry = {
    kind: "later-version",
    id: "later-key",
    backedUp: true,
  };

  test("shows its fixed label, offers no delete, and keeps its custody", () => {
    expect(recoveryRow(later)).toEqual({
      id: "later-key",
      label: LATER_VERSION_RECORD_LABEL,
      deleteLabel: "",
      unreadable: true,
      laterVersion: true,
      stateUnreadable: false,
      backedUp: true,
    });
  });

  test("is stated as a newer version's, never as damaged", () => {
    expect(savedExchangesFailedCauses(recoveryRows([later]))).toEqual([
      LATER_VERSION_RECORDS_CAUSE,
    ]);
  });

  test("beside a damaged record states both causes", () => {
    expect(
      savedExchangesFailedCauses(
        recoveryRows([
          later,
          { kind: "unreadable", id: "bad-key", backedUp: false },
        ]),
      ),
    ).toEqual([LATER_VERSION_RECORDS_CAUSE, UNREADABLE_RECORDS_CAUSE]);
  });
});

describe("savedExchangesFailedCauses", () => {
  test("states the unreadable cause for a damaged record, or when no row names one", () => {
    expect(
      savedExchangesFailedCauses(
        recoveryRows([{ kind: "unreadable", id: "bad-key", backedUp: false }]),
      ),
    ).toEqual([UNREADABLE_RECORDS_CAUSE]);
    expect(savedExchangesFailedCauses([])).toEqual([UNREADABLE_RECORDS_CAUSE]);
    expect(savedExchangesFailedCauses(recoveryRows([readable()]))).toEqual([
      UNREADABLE_RECORDS_CAUSE,
    ]);
  });

  test("states nothing while the rows are loading", () => {
    expect(savedExchangesFailedCauses(undefined)).toEqual([]);
  });
});

describe("recoveryRows", () => {
  test("derives a row per entry in order, mixing readable and unreadable", () => {
    const rows = recoveryRows([
      readable({ id: "one" }),
      { kind: "unreadable", id: "two", backedUp: false },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
    expect(rows[0].unreadable).toBe(false);
    expect(rows[1].unreadable).toBe(true);
  });
});
