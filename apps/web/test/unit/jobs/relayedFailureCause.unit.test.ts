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
    { failure: "no-connection", code: "UND_ERR_CONNECT_TIMEOUT" },
    { failure: "name-not-resolved", code: "EAI_AGAIN" },
    { failure: "no-answer", code: "ECONNRESET" },
    { failure: "no-answer", timedOutMs: 15000 },
  ])("keeps an unreachable registrar's %o, its host escaped", (facts) => {
    const event = validateAndSanitizeEvent({
      ...NO_SHOW_EVENT,
      cause: {
        kind: "relay-registrar-unreachable",
        host: "relay\u202e.example.org",
        port: 8443,
        ...facts,
        smuggled: "field",
      },
    });
    expect(event?.cause).toEqual({
      kind: "relay-registrar-unreachable",
      host: "relay\\u202e.example.org",
      port: 8443,
      ...facts,
    });
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
    [
      "a registrar with no host",
      {
        kind: "relay-registrar-unreachable",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar host that is empty",
      {
        kind: "relay-registrar-unreachable",
        host: "",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar host that is not text",
      {
        kind: "relay-registrar-unreachable",
        host: 7,
        port: 443,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port of zero",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 0,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port past 65535",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 65536,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a fractional registrar port",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443.5,
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar port as text",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: "443",
        failure: "no-answer",
        timedOutMs: 1,
      },
    ],
    [
      "a registrar failure class off the list",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "refused",
        code: "ECONNREFUSED",
      },
    ],
    [
      "a registrar with no failure class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        code: "ECONNREFUSED",
      },
    ],
    [
      "a no-connection code from another class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-connection",
        code: "ENOTFOUND",
      },
    ],
    [
      "a name-not-resolved code from another class",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "name-not-resolved",
        code: "ECONNREFUSED",
      },
    ],
    [
      "a no-answer code off the list",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        code: "ETIMEDOUT",
      },
    ],
    [
      "a no-answer with both a code and a timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        code: "ECONNRESET",
        timedOutMs: 1,
      },
    ],
    [
      "a no-answer with neither a code nor a timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
      },
    ],
    [
      "a fractional registrar timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        timedOutMs: 1.5,
      },
    ],
    [
      "a negative registrar timeout",
      {
        kind: "relay-registrar-unreachable",
        host: "r",
        port: 443,
        failure: "no-answer",
        timedOutMs: -1,
      },
    ],
  ])("refuses %s by dropping the field and relaying the rest", (_, cause) => {
    const event = validateAndSanitizeEvent({ ...NO_SHOW_EVENT, cause });
    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("cause");
    expect(event?.recoveryHint).toBe(true);
    expect(event?.exitCode).toBe(69);
    expect(event?.[ERROR_MESSAGE_CHAIN_FIELD]).toHaveLength(1);
  });
});
