import { expect, test } from "vitest";
import { ConnectionError, TermsChangeRefusedError } from "@alcove/core";
import type { TermsDelta } from "@alcove/core";

import {
  recordTermsChangeNotTaken,
  termsChangeNotTakenOf,
} from "../../src/termsChangeNotTaken";

const DELTA: TermsDelta = {
  received: undefined,
  sent: undefined,
  partnerDeduplicate: undefined,
  otherTerms: ["linkage_keys"],
};

const WRAPS: ReadonlyArray<[string, (err: Error) => unknown]> = [
  ["bare", (err) => err],
  ["behind an Error", (err) => new Error("the run failed", { cause: err })],
  [
    "behind a transport wrap",
    (err) =>
      new ConnectionError("the message send failed", "transport", {
        cause: err,
      }),
  ],
];

for (const [wrap, wrapped] of WRAPS) {
  test(`a recorded terms change is read ${wrap}`, () => {
    const refusal = new Error("the terms changed");
    recordTermsChangeNotTaken(refusal, { delta: DELTA, proposalWritten: true });
    expect(termsChangeNotTakenOf(wrapped(refusal))).toEqual({
      delta: DELTA,
      proposalWritten: true,
    });
    expect(termsChangeNotTakenOf(wrapped(new Error("other")))).toBeUndefined();
  });

  test(`core's terms change refusal is read ${wrap}`, () => {
    expect(
      termsChangeNotTakenOf(
        wrapped(new TermsChangeRefusedError("the terms changed", DELTA)),
      ),
    ).toEqual({ delta: DELTA, proposalWritten: false });
  });
}

test("the nearest link that states a terms change wins", () => {
  const inner = new TermsChangeRefusedError("the terms changed", DELTA);
  const outer = new Error("the run failed", { cause: inner });
  recordTermsChangeNotTaken(outer, { delta: DELTA, proposalWritten: true });
  expect(termsChangeNotTakenOf(outer)?.proposalWritten).toBe(true);
});
