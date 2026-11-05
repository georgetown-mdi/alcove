import { describe, expect, test } from "vitest";

import {
  UPDATE_HOLD_TEXT,
  updateReadyText,
} from "@components/appShellUpdateCopy";
import { APP_UPDATE_HOLDERS } from "@utils/appUpdateHolder";

describe("the waiting-update banner", () => {
  test("with nothing holding the update states the reload alone", () => {
    expect(updateReadyText([])).toBe(
      "Reload to use it. It replaces the app's code; your saved exchanges " +
        "stay in this browser.",
    );
  });

  test.each(APP_UPDATE_HOLDERS)(
    "held for %s states that holder and how to release it",
    (holder) => {
      const text = updateReadyText([holder]);
      expect(text.startsWith(`${UPDATE_HOLD_TEXT[holder]} Then reload`)).toBe(
        true,
      );
      for (const other of APP_UPDATE_HOLDERS)
        if (other !== holder)
          expect(text).not.toContain(UPDATE_HOLD_TEXT[other]);
    },
  );

  test("gives each holder its own text, each with a release instruction", () => {
    const texts = APP_UPDATE_HOLDERS.map((holder) => UPDATE_HOLD_TEXT[holder]);
    expect(new Set(texts).size).toBe(APP_UPDATE_HOLDERS.length);
    for (const text of texts) expect(text.split(". ")).toHaveLength(2);
  });

  test("names every holder that holds it, in order", () => {
    expect(updateReadyText(["run", "edits"])).toBe(
      `${UPDATE_HOLD_TEXT.run} ${UPDATE_HOLD_TEXT.edits} Then reload to use ` +
        "it. It replaces the app's code; your saved exchanges stay in this " +
        "browser.",
    );
  });
});
