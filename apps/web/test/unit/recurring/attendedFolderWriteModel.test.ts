import { describe, expect, test } from "vitest";

import { attendedFolderWriteNote } from "@recurring/attendedFolderWriteModel";

/**
 * The line an attended run's completion surface shows beside its result
 * download about the copy written into the working folder: where it went, or
 * that it did not land and the download is the way to the results.
 */

const directoryName = "Riverbend exchange";

describe("the note beside an attended run's result download", () => {
  test("names the file and the folder a landed write went to", () => {
    const note = attendedFolderWriteNote({
      directoryName,
      delivery: {
        kind: "written",
        fileName: "alcove-results-riverbend-2026-03-01.csv",
        directoryName,
      },
    });
    expect(note.failed).toBe(false);
    expect(note.message).toContain("alcove-results-riverbend-2026-03-01.csv");
    expect(note.message).toContain(directoryName);
  });

  test("says a write is under way before it settles", () => {
    const note = attendedFolderWriteNote({ directoryName });
    expect(note.failed).toBe(false);
    expect(note.message).toContain(directoryName);
  });

  test("reports a write that did not land, and points at the download", () => {
    for (const delivery of [
      { kind: "ungranted", state: "prompt" },
      { kind: "ungranted", state: "denied" },
      { kind: "write-failed", error: new Error("the disk is full") },
    ] as const) {
      const note = attendedFolderWriteNote({ directoryName, delivery });
      expect(note.failed).toBe(true);
      expect(note.message).toContain("were not written");
      expect(note.message).toContain(directoryName);
      expect(note.message).toContain("Download them above");
    }
  });
});
