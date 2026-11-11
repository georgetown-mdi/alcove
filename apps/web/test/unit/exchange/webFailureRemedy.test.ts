import { expect, test } from "vitest";

import {
  markFailureCause,
  sanitizeErrorForDisplay,
  setOverLimitError,
} from "@alcove/core";

import {
  webFailureMessage,
  webRemedyForCause,
} from "@exchange/webFailureRemedy";

const SPLIT =
  "Split the input into smaller files and run one exchange for each.";

test("a set too large to send states core's sentence, then the remedy", () => {
  const err = setOverLimitError({
    kind: "set-over-limit",
    stage: "in-round",
    limit: "set-maximum",
    valueCount: 16_777_217,
    limitValues: 16_777_216,
  });
  expect(webFailureMessage(err)).toBe(`${err.message} ${SPLIT}`);
});

test("the remedy goes before the cause chain, where core composed it", () => {
  const err = setOverLimitError(
    { kind: "set-over-limit", stage: "after-terms", limit: "uncounted" },
    { cause: new RangeError("Map maximum size exceeded\u001b[2J") },
  );
  const [head, ...chain] = sanitizeErrorForDisplay(err).split("\ncaused by: ");
  expect(webFailureMessage(err)).toBe(
    [`${head} ${SPLIT}`, ...chain].join("\ncaused by: "),
  );
  expect(webFailureMessage(err)).not.toContain("\u001b");
});

test("a failure with no cause, or a cause this app states in its own copy, is rendered alone", () => {
  const plain = new Error("plain failure");
  expect(webFailureMessage(plain)).toBe(sanitizeErrorForDisplay(plain));
  const noShow = markFailureCause(new Error("no show"), {
    kind: "partner-never-arrived",
    channel: "webrtc",
  });
  expect(webRemedyForCause({ kind: "partner-never-arrived" })).toBeUndefined();
  expect(webFailureMessage(noShow)).toBe(sanitizeErrorForDisplay(noShow));
});
