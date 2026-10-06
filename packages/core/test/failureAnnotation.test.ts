import { describe, expect, test } from "vitest";

import {
  ConnectionError,
  isPeerWaitTimeout,
  markPeerWaitTimeout,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
} from "../src/errors";
import {
  failureCauseOf,
  markFailureCause,
  type FailureCause,
} from "../src/failureCause";
import {
  partnerCertificateCondition,
  withPartnerCertificateCondition,
} from "../src/records/signingIdentity";
import {
  MAX_ERROR_CAUSE_DEPTH,
  annotate,
  annotationKey,
  annotationOf,
} from "../src/failureAnnotation";

const LABEL = annotationKey<string>("label");
const OTHER = annotationKey<string>("label");

function wrappedIn(count: number, inner: unknown): unknown {
  let link = inner;
  for (let i = 0; i < count; i++)
    link = new Error(`wrap ${i}`, { cause: link });
  return link;
}

describe("annotationOf", () => {
  test("reads the annotation off the error itself", () => {
    const err = annotate(new Error("failed"), LABEL, "inner");
    expect(annotationOf(err, LABEL)).toBe("inner");
  });

  test("reads it through an Error wrap, a transport wrap, and a plain object", () => {
    const err = annotate(new Error("failed"), LABEL, "inner");
    expect(annotationOf(wrappedIn(1, err), LABEL)).toBe("inner");
    expect(
      annotationOf(
        new ConnectionError("send failed", "transport", { cause: err }),
        LABEL,
      ),
    ).toBe("inner");
    expect(annotationOf({ cause: err }, LABEL)).toBe("inner");
  });

  test("the nearest link that holds one wins", () => {
    const inner = annotate(new Error("inner"), LABEL, "inner");
    const middle = new Error("middle", { cause: inner });
    const outer = annotate(
      new Error("outer", { cause: middle }),
      LABEL,
      "outer",
    );
    expect(annotationOf(outer, LABEL)).toBe("outer");
    expect(annotationOf(middle, LABEL)).toBe("inner");
  });

  test("keys are distinct even under one description", () => {
    const err = annotate(new Error("failed"), LABEL, "inner");
    expect(annotationOf(err, OTHER)).toBeUndefined();
  });

  test("a later annotation under the same key replaces the earlier", () => {
    const err = annotate(new Error("failed"), LABEL, "first");
    annotate(err, LABEL, "second");
    expect(annotationOf(err, LABEL)).toBe("second");
  });

  test("ownOnly reads the error itself and nothing it wraps", () => {
    const err = annotate(new Error("failed"), LABEL, "inner");
    expect(annotationOf(err, LABEL, { ownOnly: true })).toBe("inner");
    expect(
      annotationOf(wrappedIn(1, err), LABEL, { ownOnly: true }),
    ).toBeUndefined();
  });

  test("walks at most MAX_ERROR_CAUSE_DEPTH links past the error", () => {
    const err = annotate(new Error("failed"), LABEL, "inner");
    expect(annotationOf(wrappedIn(MAX_ERROR_CAUSE_DEPTH, err), LABEL)).toBe(
      "inner",
    );
    expect(
      annotationOf(wrappedIn(MAX_ERROR_CAUSE_DEPTH + 1, err), LABEL),
    ).toBeUndefined();
  });

  test("stops on a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(annotationOf(a, LABEL)).toBeUndefined();
    annotate(b, LABEL, "in the cycle");
    expect(annotationOf(a, LABEL)).toBe("in the cycle");
  });

  test("a value that is not an object holds nothing", () => {
    expect(annotationOf(undefined, LABEL)).toBeUndefined();
    expect(annotationOf(null, LABEL)).toBeUndefined();
    expect(annotationOf("failed", LABEL)).toBeUndefined();
  });

  test("annotates a frozen error and adds no property to it", () => {
    const err = Object.freeze(new Error("failed"));
    expect(annotate(err, LABEL, "frozen")).toBe(err);
    expect(annotationOf(err, LABEL)).toBe("frozen");
    expect(Object.keys(err)).toEqual([]);
  });

  test("a property named like an annotation is not one", () => {
    expect(annotationOf({ label: "spoofed" }, LABEL)).toBeUndefined();
  });
});

// Each marker in this package, read through each wrap a failure meets on its
// way to a command boundary: bare, an Error holding it as its cause, and the
// message bridge's transport-kind ConnectionError.
describe("each failure annotation through each wrap", () => {
  const wraps: ReadonlyArray<[string, (err: Error) => unknown]> = [
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
  const cause: FailureCause = {
    kind: "partner-never-arrived",
    channel: "sftp",
  };
  const markers: ReadonlyArray<
    [string, (err: Error) => Error, (err: unknown) => unknown, unknown]
  > = [
    [
      "failure cause",
      (err) => markFailureCause(err, cause),
      failureCauseOf,
      cause,
    ],
    ["peer wait timeout", markPeerWaitTimeout, isPeerWaitTimeout, true],
    [
      "partner certificate condition",
      (err) => withPartnerCertificateCondition(err, "divergent"),
      partnerCertificateCondition,
      "divergent",
    ],
    [
      "states its own next step",
      markStatesItsOwnNextStep,
      statesItsOwnNextStep,
      true,
    ],
  ];
  for (const [marker, mark, read, expected] of markers)
    for (const [wrap, wrapped] of wraps)
      test(`${marker}, ${wrap}`, () => {
        expect(read(wrapped(mark(new Error("failed"))))).toEqual(expected);
        expect(read(wrapped(new Error("failed")))).not.toEqual(expected);
      });
});
