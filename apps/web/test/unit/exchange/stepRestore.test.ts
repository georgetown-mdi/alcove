import { describe, expect, test } from "vitest";

import { restorablePosition, restorableSection } from "@exchange/stepRestore";

describe("restorableSection", () => {
  // A start-over clears the invitation but leaves the loaded file and terms, so
  // a `share` entry Back lands on clamps to review rather than a blank column.
  test("clamps share to review when the invitation is gone", () => {
    expect(
      restorableSection("share", {
        hasFile: true,
        hasInvitation: false,
        isCliTransport: false,
      }),
    ).toBe("review");
  });

  test("keeps share when the invitation is still present", () => {
    expect(
      restorableSection("share", {
        hasFile: true,
        hasInvitation: true,
        isCliTransport: false,
      }),
    ).toBe("share");
  });

  // The save surface renders only under a CLI transport; a fresh file resets the
  // transport to browser, stranding a `save` entry the same way.
  test("clamps save to review when the transport is not a CLI transport", () => {
    expect(
      restorableSection("save", {
        hasFile: true,
        hasInvitation: false,
        isCliTransport: false,
      }),
    ).toBe("review");
  });

  test("keeps save under a CLI transport", () => {
    expect(
      restorableSection("save", {
        hasFile: true,
        hasInvitation: false,
        isCliTransport: true,
      }),
    ).toBe("save");
  });

  test("restores a step with intact backing state unchanged", () => {
    for (const step of ["file", "columns", "review", "cleaning"] as const)
      expect(
        restorableSection(step, {
          hasFile: true,
          hasInvitation: false,
          isCliTransport: false,
        }),
      ).toBe(step);
  });

  // A delimiter change under the columns drops the file and the draft, so every
  // entry past the file step would render an empty work column.
  test("clamps every section past file to file when no file is held", () => {
    const sections = [
      "columns",
      "review",
      "cleaning",
      "keys",
      "agreement",
      "share",
      "save",
    ] as const;
    for (const step of sections)
      expect(
        restorableSection(step, {
          hasFile: false,
          hasInvitation: true,
          isCliTransport: true,
        }),
      ).toBe("file");
  });

  test("keeps file when no file is held", () => {
    expect(
      restorableSection("file", {
        hasFile: false,
        hasInvitation: false,
        isCliTransport: false,
      }),
    ).toBe("file");
  });
});

describe("restorablePosition", () => {
  // A back-to-columns recovery discards the launch but keeps the acquired file
  // and confirmed columns, so a `launched` entry Back lands on clamps to columns
  // rather than a run surface backed by nothing.
  test("clamps launched to columns when the launch is gone", () => {
    expect(
      restorablePosition("launched", {
        hasLaunch: false,
        reviewCommitted: true,
        hasAcquired: true,
      }),
    ).toBe("columns");
  });

  test("keeps launched when the launch is still present", () => {
    for (const reviewCommitted of [true, false])
      for (const hasAcquired of [true, false])
        expect(
          restorablePosition("launched", {
            hasLaunch: true,
            reviewCommitted,
            hasAcquired,
          }),
        ).toBe("launched");
  });

  test("restores a step with intact backing state unchanged", () => {
    for (const token of ["review", "consent", "columns", "columns:cleaning"])
      expect(
        restorablePosition(token, {
          hasLaunch: false,
          reviewCommitted: true,
          hasAcquired: true,
        }),
      ).toBe(token);
  });

  // An edit to the review step's Allowed relays voids its commit, so a Forward
  // past it lands back on the field rather than on a step that launches the
  // list the field no longer shows.
  test("clamps every step before the run to review while the review is uncommitted", () => {
    for (const token of ["consent", "columns", "columns:cleaning", "launched"])
      expect(
        restorablePosition(token, {
          hasLaunch: false,
          reviewCommitted: false,
          hasAcquired: true,
        }),
      ).toBe("review");
  });

  // Choosing another file on the consent step clears the admitted rows, so a
  // Forward lands back on that step rather than on columns read from the
  // earlier file.
  test("clamps every step that renders the rows to consent while none are admitted", () => {
    for (const token of ["columns", "columns:cleaning", "launched"])
      expect(
        restorablePosition(token, {
          hasLaunch: false,
          reviewCommitted: true,
          hasAcquired: false,
        }),
      ).toBe("consent");
    expect(
      restorablePosition("consent", {
        hasLaunch: false,
        reviewCommitted: true,
        hasAcquired: false,
      }),
    ).toBe("consent");
  });

  test("passes a token naming no step through for the caller to ignore", () => {
    expect(
      restorablePosition("retired-step", {
        hasLaunch: false,
        reviewCommitted: false,
        hasAcquired: false,
      }),
    ).toBe("retired-step");
  });
});
