import { describe, expect, test } from "vitest";

import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { validateAndSanitizeEvent } from "@jobs/cliDriver";

/** A terminal event as the CLI emits it for a partner that never arrived. */
const NO_SHOW_EVENT = {
  v: 1,
  type: "error",
  category: "exchange",
  message:
    "Your partner did not arrive in the shared folder within 90 seconds.\n" +
    "Check that you and your partner use the same folder and that it is " +
    "syncing, then run again; --peer-timeout sets how long to wait.",
  recoveryHint: true,
  exitCode: 69,
  cause: {
    kind: "partner-never-arrived",
    channel: "filedrop",
    waitedMs: 90000,
  },
};

describe("the relayed failure cause", () => {
  test("keeps a cause on the allowlist, rebuilt from its own facts", () => {
    const event = validateAndSanitizeEvent({
      ...NO_SHOW_EVENT,
      cause: { ...NO_SHOW_EVENT.cause, smuggled: "field" },
    });
    expect(event?.cause).toEqual(NO_SHOW_EVENT.cause);
  });

  test("escapes a folder path again at this boundary", () => {
    const event = validateAndSanitizeEvent({
      ...NO_SHOW_EVENT,
      cause: { kind: "folder-missing", path: "/data/a\u202eb", code: "ENOENT" },
    });
    expect(event?.cause).toEqual({
      kind: "folder-missing",
      path: "/data/a\\u202eb",
      code: "ENOENT",
    });
  });

  test("keeps a deep folder path whole past the per-value cap", () => {
    const path = `/${"d".repeat(1000)}`;
    const event = validateAndSanitizeEvent({
      ...NO_SHOW_EVENT,
      cause: { kind: "folder-missing", path, code: "ENOTDIR" },
    });
    expect((event?.cause as { path?: unknown }).path).toBe(path);
  });

  test.each([
    ["an unknown kind", { kind: "partner-refused" }],
    ["a kind that is not text", { kind: 7 }],
    ["no kind", { channel: "filedrop" }],
    ["a cause that is not an object", "partner-never-arrived"],
    [
      "a channel off the list",
      { kind: "partner-never-arrived", channel: "carrier-pigeon" },
    ],
    [
      "a wait that is not a count",
      { kind: "partner-never-arrived", waitedMs: -5 },
    ],
    [
      "a folder code off the list",
      { kind: "folder-missing", path: "/d", code: "EACCES" },
    ],
    ["a folder with no path", { kind: "folder-missing", code: "ENOENT" }],
  ])("refuses %s by dropping the field and relaying the rest", (_, cause) => {
    const event = validateAndSanitizeEvent({ ...NO_SHOW_EVENT, cause });
    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("cause");
    expect(event?.recoveryHint).toBe(true);
    expect(event?.exitCode).toBe(69);
    expect(event?.[ERROR_MESSAGE_CHAIN_FIELD]).toHaveLength(1);
  });
});
