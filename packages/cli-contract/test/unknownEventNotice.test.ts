import { describe, expect, it } from "vitest";

import {
  UNKNOWN_EVENT_VALUE_MAX_LENGTH,
  UNREADABLE_EVENT,
  unknownEventNotice,
} from "../src/unknownEventNotice.js";

const PARTIES = {
  sender: "The sender",
  reader: "this reader",
  remedy: "Do the thing.",
};

/** The notice for `value`, under {@link PARTIES}. */
const noticeFor = (value: unknown): string =>
  unknownEventNotice(value, PARTIES);

describe("unknownEventNotice", () => {
  it.each([
    { value: { v: 2, type: "stage" }, named: "an event of schema version 2" },
    { value: { v: "1" }, named: 'an event of schema version "1"' },
    { value: {}, named: "an event of schema version (none)" },
    { value: { v: 1, type: "invented" }, named: 'an event of type "invented"' },
    { value: { v: 1 }, named: "an event of type (none)" },
    { value: [1], named: "an event that is not a JSON object" },
    { value: null, named: "an event that is not a JSON object" },
    { value: "text", named: "an event that is not a JSON object" },
    { value: UNREADABLE_EVENT, named: "an event that is not readable JSON" },
  ])("names $named", ({ value, named }) => {
    expect(noticeFor(value)).toBe(
      `The sender sent ${named}, which this reader does not read, so it was ` +
        "skipped. Do the thing.",
    );
  });

  it("fits a long quoted value to the budget", () => {
    const notice = noticeFor({ v: 1, type: "t".repeat(500) });
    expect(notice).not.toContain(
      "t".repeat(UNKNOWN_EVENT_VALUE_MAX_LENGTH + 1),
    );
  });

  it("redacts private key material from a quoted value", () => {
    const notice = noticeFor({
      v: 1,
      type: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    });
    expect(notice).not.toContain("MIIB");
  });
});
