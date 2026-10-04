import { describe, expect, test } from "vitest";

import {
  installOffer,
  keepRunningChecklist,
  readinessLines,
  readinessReady,
  readinessTitle,
} from "@recurring/keepRunningModel";

import type { ReadinessReport } from "@recurring/keepRunningModel";

// The keep-running section's pure model: which install offer stands, which
// checklist items this page can mark, and the readiness result's lines.

describe("installOffer", () => {
  test("the installed app offers nothing to install", () => {
    expect(
      installOffer({
        installedRuntime: true,
        installedFromThisPage: false,
        promptAvailable: true,
      }),
    ).toBe("installedRuntime");
  });

  test("an install from this page points at the installed app", () => {
    expect(
      installOffer({
        installedRuntime: false,
        installedFromThisPage: true,
        promptAvailable: false,
      }),
    ).toBe("installedFromThisPage");
  });

  test("a held browser offer shows the button, and its absence the instructions", () => {
    const base = { installedRuntime: false, installedFromThisPage: false };
    expect(installOffer({ ...base, promptAvailable: true })).toBe("button");
    expect(installOffer({ ...base, promptAvailable: false })).toBe(
      "instructions",
    );
  });
});

describe("keepRunningChecklist", () => {
  test("marks the install and folder items from what this page can see", () => {
    const items = keepRunningChecklist({
      installedRuntime: true,
      folderGrantSupported: true,
      hasWorkingFolder: false,
    });
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ done: true });
    expect(items[4]).toMatchObject({ done: false });
    expect(items[4].instruction).toContain("input.csv");
    expect(items.slice(1, 4).every((item) => item.done === undefined)).toBe(
      true,
    );
  });

  test("a browser without folder grants names the limit instead", () => {
    const [, , , , folder] = keepRunningChecklist({
      installedRuntime: false,
      folderGrantSupported: false,
      hasWorkingFolder: false,
    });
    expect(folder.instruction).toContain("cannot give a site a folder");
    expect(folder.done).toBe(false);
  });
});

describe("readiness result", () => {
  const ready: ReadinessReport = {
    installedRuntime: true,
    folder: "ready",
    signaling: "answered",
  };

  test("every check passing reads as ready", () => {
    expect(readinessReady(ready)).toBe(true);
    expect(readinessTitle(ready)).toBe("Ready for the next window");
    expect(readinessLines(ready).every((line) => line.ok)).toBe(true);
  });

  test.each([
    [{ installedRuntime: false }, "browser tab"],
    [{ folder: "none" as const }, "No folder is chosen"],
    [{ folder: "notGranted" as const }, "no longer has permission"],
    [{ folder: "inputMissing" as const }, "no file named input.csv"],
    [{ folder: "unreadable" as const }, "could not be read"],
    [{ folder: "unsupported" as const }, "cannot give a site a folder"],
    [{ signaling: "noAnswer" as const }, "could not connect"],
    [{ signaling: "offline" as const }, "offline"],
  ])("a failing check names its remedy (%o)", (change, phrase) => {
    const report = { ...ready, ...change };
    expect(readinessReady(report)).toBe(false);
    expect(readinessTitle(report)).toBe("Not ready for the next window");
    const failing = readinessLines(report).filter((line) => !line.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0].message).toContain(phrase);
  });
});
