import { expect, test } from "vitest";

import {
  ConnectionError,
  FAILURE_CAUSE_KINDS,
  failureCauseFromUntrusted,
  failureCauseSentence,
  markFailureCause,
  sanitizeForDisplay,
} from "@alcove/core";
import type { FailureCause } from "@alcove/core";

import { buildErrorEvent } from "../../src/eventStream";
import { markArrivalWait, remedyForCause } from "../../src/failureRemedy";
import { renderFailureForOperator } from "../../src/util/exit";

function causeError(cause: FailureCause): Error {
  return markFailureCause(new Error(failureCauseSentence(cause)), cause);
}

test("a catalog cause is emitted as its kind and facts, marked as stating its step", () => {
  const cause: FailureCause = {
    kind: "partner-never-arrived",
    channel: "filedrop",
    waitedMs: 90_000,
  };
  const event = buildErrorEvent(causeError(cause), "prepare");
  expect(event.cause).toEqual(cause);
  expect(event.recoveryHint).toBe(true);
  expect(event.message).toBe(
    `${failureCauseSentence(cause)}\n${remedyForCause(cause)}`,
  );
  expect(event.message).toBe(renderFailureForOperator(causeError(cause)));
});

test("the cause is read through a wrap, as the remedy is", () => {
  const cause: FailureCause = {
    kind: "folder-missing",
    path: "/data/drop",
    code: "ENOENT",
  };
  const wrapped = new ConnectionError("connect failed", "transport", {
    cause: causeError(cause),
  });
  const event = buildErrorEvent(wrapped, "prepare");
  expect(event.cause).toEqual(cause);
  expect(event.recoveryHint).toBe(true);
});

test("an online invitation's no-show emits the same cause", () => {
  const cause: FailureCause = { kind: "partner-never-arrived" };
  const err = markArrivalWait(causeError(cause), "online-invitation");
  const event = buildErrorEvent(err, "prepare");
  expect(event.cause).toEqual(cause);
  expect(event.message).toContain("--accept-timeout");
});

test("a failure the catalog does not name has no cause field", () => {
  const event = buildErrorEvent(new Error("boom"), "run");
  expect("cause" in event).toBe(false);
  expect(event.recoveryHint).toBeUndefined();
});

test("a folder path is escaped and every fact off the kind is left behind", () => {
  const path = "/data/\u001b[2Jdrop\u202e";
  const tagged = Object.assign(
    { kind: "folder-missing", path, code: "ENOTDIR" } as const,
    { extra: "not a fact" },
  );
  const event = buildErrorEvent(causeError(tagged), "prepare");
  expect(event.cause).toEqual({
    kind: "folder-missing",
    path: sanitizeForDisplay(path),
    code: "ENOTDIR",
  });
  expect(JSON.stringify(event.cause)).not.toContain("\u001b");
});

test("a wait is floored to a whole count of milliseconds", () => {
  const event = buildErrorEvent(
    causeError({ kind: "partner-never-arrived", waitedMs: 1500.7 }),
    "prepare",
  );
  expect(event.cause).toEqual({
    kind: "partner-never-arrived",
    waitedMs: 1500,
  });
});

test("every emitted cause passes the allowlist a consumer checks it against", () => {
  const emitted: FailureCause[] = [
    { kind: "partner-never-arrived" },
    { kind: "partner-never-arrived", channel: "sftp", waitedMs: 60_000 },
    { kind: "partner-never-arrived", channel: "webrtc" },
    { kind: "folder-missing", path: "/data", code: "ENOENT" },
    { kind: "folder-missing", path: "/data", code: "ENOTDIR" },
  ];
  expect(new Set(emitted.map((cause) => cause.kind))).toEqual(
    new Set(FAILURE_CAUSE_KINDS),
  );
  for (const cause of emitted) {
    const line = JSON.parse(
      JSON.stringify(buildErrorEvent(causeError(cause), "prepare")),
    ) as { cause?: unknown };
    expect(failureCauseFromUntrusted(line.cause)).toEqual(cause);
  }
});
