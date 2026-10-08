import { describe, expect, test } from "vitest";

import { errorWithPartnerCauseLinks } from "@alcove/core";
import { partnerOriginTextList } from "@alcove/core/testing";

import { failureFor } from "@exchange/useInviterExchange";
import { layOutValueLineBreaks } from "@exchange/RunSurface";

// How a terms-exchange abort reads once a seat has laid it out. The abort packs
// the partner's reasons several to a cause link, separated by a break of its
// own (`errorWithPartnerCauseLinks` in packages/core/src/utils/partnerOriginText.ts,
// whose budgets and ceiling packages/core/test/partnerAbortLinkBudget.test.ts
// pins); the seat lays the rendered chain out on the breaks a VALUE holds, and
// those are the two different breaks that meet on this route.
//
// What the layout leaves is measured rather than assumed: each labelled value
// opens a line of its own, and a break a partner wrote opens a line headed by
// its marker.

/** The first-party sentence and label the abort composes, as
 * `packages/core/src/protocolSetup.ts` writes them. */
const ABORT_MESSAGE = "Your partner stopped the exchange at the linkage terms";
const ABORT_LABEL = "reason your partner gave: ";

/** The seat's rendering of an abort holding `reasons`, laid out as the operator
 * reads it: the display escape the category's block applies, then the break in
 * front of each line-break marker. */
function laidOutLines(reasons: ReadonlyArray<string>): Array<string> {
  const failure = failureFor(
    "exchange",
    errorWithPartnerCauseLinks(
      ABORT_MESSAGE,
      ABORT_LABEL,
      partnerOriginTextList(reasons),
    ),
  );
  expect(failure.reportedCause).toBeDefined();
  return layOutValueLineBreaks(failure.reportedCause ?? "").split("\n");
}

describe("a packed abort-reason list at a seat", () => {
  test("a partner's own break opens a line headed by its marker", () => {
    const lines = laidOutLines([
      "first line\nsecond line",
      "another reason",
      "third reason",
    ]);
    // The sentence, the link the pack opens, the line the partner's break
    // opened, then one line for each value packed behind it.
    expect(lines).toEqual([
      ABORT_MESSAGE,
      `caused by: 1. ${ABORT_LABEL}first line`,
      "<0a>second line",
      `2. ${ABORT_LABEL}another reason`,
      `3. ${ABORT_LABEL}third reason`,
    ]);
  });

  test("the two breaks are told apart by what opens the line", () => {
    const lines = laidOutLines(["first line\nsecond line", "another reason"]);
    // A line the partner's break opened is headed by its marker; a line the
    // composition opened is headed by a value's first-party label, which a
    // value cannot open a line in front of.
    expect(lines[2]).toMatch(/^<0a>/);
    expect(lines[3]).toBe(`2. ${ABORT_LABEL}another reason`);
    expect(lines.join("\n")).not.toContain("\\x0a");
  });

  test("each reason with no break of its own is one line", () => {
    expect(laidOutLines(["plain reason", "another plain reason"])).toEqual([
      ABORT_MESSAGE,
      `caused by: 1. ${ABORT_LABEL}plain reason`,
      `2. ${ABORT_LABEL}another plain reason`,
    ]);
  });
});
