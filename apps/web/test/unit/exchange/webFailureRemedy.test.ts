import { expect, test } from "vitest";

import {
  MATCHES_OVER_LIMIT_REMEDY,
  failureCauseSentence,
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

test("a single-pass or matched-list refusal raised in this browser states core's sentence, then the remedy", () => {
  const cause = {
    kind: "matches-over-limit",
    list: "resolved",
    matchCount: 5,
    limitMatches: 4,
  } as const;
  const err = markFailureCause(new Error(failureCauseSentence(cause)), cause);
  expect(webFailureMessage(err)).toBe(
    `${err.message} ${MATCHES_OVER_LIMIT_REMEDY}`,
  );
  const slots = {
    kind: "single-pass-over-limit",
    limit: "value-slots",
    local: { effectiveKeyCount: 1, recordCount: 2 },
    partner: { effectiveKeyCount: 1, recordCount: 9 },
    limitSlots: 3,
  } as const;
  expect(webRemedyForCause(slots)).toBe(
    "Ask your partner to reduce their record count or split their dataset.",
  );
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
