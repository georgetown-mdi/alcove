import { describe, expect, it } from "vitest";

import {
  FAILURE_CAUSE_PATH_MAX_LENGTH,
  failureCauseFromUntrusted,
  parseBoundedJson,
  sanitizeForDisplay,
} from "@alcove/core";
import { FAILURE_CAUSE_KINDS } from "@alcove/core/testing";
import type { FailureCause } from "@alcove/core";

import {
  FAILURE_CAUSE_STREAM_FIELDS,
  FAILURE_CAUSE_STREAM_KINDS,
  failureCauseStreamField,
  isFailureCauseStreamKind,
} from "../src/failureCauses.js";

describe("the kind list", () => {
  it("is the record's keys", () => {
    expect([...FAILURE_CAUSE_STREAM_KINDS]).toEqual(
      Object.keys(FAILURE_CAUSE_STREAM_FIELDS),
    );
  });

  it("holds every kind core's catalog allows, and no other", () => {
    expect([...FAILURE_CAUSE_STREAM_KINDS].sort()).toEqual(
      [...FAILURE_CAUSE_KINDS].sort(),
    );
  });

  it("does not take an inherited property for a kind", () => {
    for (const kind of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ])
      expect(isFailureCauseStreamKind(kind)).toBe(false);
    expect(isFailureCauseStreamKind(undefined)).toBe(false);
    expect(isFailureCauseStreamKind(7)).toBe(false);
  });
});

describe("the stream field", () => {
  it("copies a no-show's facts and floors its wait to a whole count", () => {
    expect(
      failureCauseStreamField({
        kind: "partner-never-arrived",
        channel: "sftp",
        waitedMs: 1500.7,
      }),
    ).toEqual({
      kind: "partner-never-arrived",
      channel: "sftp",
      waitedMs: 1500,
    });
    expect(
      failureCauseStreamField({ kind: "partner-never-arrived", waitedMs: -3 }),
    ).toEqual({ kind: "partner-never-arrived", waitedMs: 0 });
    expect(failureCauseStreamField({ kind: "partner-never-arrived" })).toEqual({
      kind: "partner-never-arrived",
    });
  });

  it("round trips the shared-name fact through a stream line and the validator", () => {
    const cause: FailureCause = {
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      sharedName: true,
    };
    const field = failureCauseStreamField(cause);
    expect(field).toEqual(cause);
    const line = JSON.stringify({ v: 1, type: "error", cause: field });
    const read = (parseBoundedJson(line) as { cause: unknown }).cause;
    expect(failureCauseFromUntrusted(read)).toEqual(cause);
    expect(
      failureCauseStreamField({
        kind: "partner-never-arrived",
        channel: "sftp",
      }),
    ).not.toHaveProperty("sharedName");
  });

  // A consumer older than the shared-name fact rebuilt the cause from the
  // facts it knew; the same rule here drops a fact newer than this build.
  it("a consumer that does not know a fact drops it and keeps the cause", () => {
    const line = JSON.stringify({
      v: 1,
      type: "error",
      cause: {
        kind: "partner-never-arrived",
        channel: "filedrop",
        waitedMs: 90_000,
        sharedName: true,
        laterFact: { nested: 1 },
      },
    });
    const read = (parseBoundedJson(line) as { cause: unknown }).cause;
    const rebuilt = failureCauseFromUntrusted(read);
    expect(rebuilt).toEqual({
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 90_000,
      sharedName: true,
    });
    expect(failureCauseStreamField(rebuilt!)).toEqual(rebuilt);
  });

  it("escapes a folder path and leaves every fact off the kind behind", () => {
    const path = "/data/\u001b[2Jdrop\u202e";
    const tagged = Object.assign(
      { kind: "folder-missing", path, code: "ENOENT" } as const,
      { extra: "not a fact" },
    );
    expect(failureCauseStreamField(tagged)).toEqual({
      kind: "folder-missing",
      path: sanitizeForDisplay(path, {
        maxLength: FAILURE_CAUSE_PATH_MAX_LENGTH,
      }),
      code: "ENOENT",
    });
  });

  it("escapes a registrar host and copies only its failure class's facts", () => {
    const host = "relay\u001b[2J.example.org";
    const cause = Object.assign(
      {
        kind: "relay-registrar-unreachable",
        host,
        port: 8443,
        failure: "no-answer",
        timedOutMs: 2000.9,
      } as const,
      { code: "ECONNRESET" },
    );
    expect(failureCauseStreamField(cause as FailureCause)).toEqual({
      kind: "relay-registrar-unreachable",
      host: sanitizeForDisplay(host, {
        maxLength: FAILURE_CAUSE_PATH_MAX_LENGTH,
      }),
      port: 8443,
      failure: "no-answer",
      timedOutMs: 2000,
    });
  });

  it("drops a cause whose kind has no row rather than throwing", () => {
    for (const kind of ["partner-went-away", "toString", "__proto__", ""]) {
      const unknown = { kind } as unknown as FailureCause;
      expect(() => failureCauseStreamField(unknown)).not.toThrow();
      expect(failureCauseStreamField(unknown)).toBeUndefined();
    }
  });
});
