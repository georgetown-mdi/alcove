import { describe, expect, test } from "vitest";

import {
  AuthenticationError,
  ConnectionError,
  InternalConsistencyError,
  OperatorConfigError,
  PeerAbortError,
  ProtocolRefusalError,
  UsageError,
} from "../src/errors";
import {
  classifyFailure,
  firstLinkBehindTransportWraps,
  isTrustBoundaryFailure,
  type FailureClass,
} from "../src/failureClass";
import { ReceiptVerificationError } from "../src/records/signedReceipt";
import { MAX_ERROR_CAUSE_DEPTH } from "../src/utils/sanitizeErrorForDisplay";

function behindTransport(cause: unknown): ConnectionError {
  return new ConnectionError("the message send failed", "transport", {
    cause,
  });
}

function behindTransportWraps(count: number, inner: unknown): unknown {
  let link = inner;
  for (let i = 0; i < count; i++) link = behindTransport(link);
  return link;
}

const BARE_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly err: () => unknown;
  readonly expected: FailureClass;
}> = [
  {
    name: "a UsageError",
    err: () => new UsageError("unusable"),
    expected: "usage-error",
  },
  {
    name: "an OperatorConfigError",
    err: () => new OperatorConfigError("bad config"),
    expected: "usage-error",
  },
  {
    name: 'a ConnectionError of kind "usage"',
    err: () => new ConnectionError("misuse", "usage"),
    expected: "usage-error",
  },
  {
    name: "an InternalConsistencyError",
    err: () => new InternalConsistencyError("disagreed"),
    expected: "internal-fault",
  },
  {
    name: "a ProtocolRefusalError",
    err: () => new ProtocolRefusalError("terms incompatible"),
    expected: "partner-refused",
  },
  {
    name: "a PeerAbortError",
    err: () => new PeerAbortError(),
    expected: "partner-refused",
  },
  {
    name: 'a ConnectionError of kind "protocol"',
    err: () => new ConnectionError("malformed frame", "protocol"),
    expected: "partner-refused",
  },
  {
    name: "a ReceiptVerificationError",
    err: () => new ReceiptVerificationError("certificate not trusted"),
    expected: "receipt-not-verified",
  },
  {
    name: "an AuthenticationError",
    err: () => new AuthenticationError("key exchange failed"),
    expected: "authentication-failed",
  },
  {
    name: 'a ConnectionError of kind "security"',
    err: () => new ConnectionError("integrity check failed", "security"),
    expected: "trust-check-failed",
  },
  {
    name: 'a ConnectionError of kind "closed"',
    err: () => new ConnectionError("wait cancelled", "closed"),
    expected: "cancelled",
  },
  {
    name: 'a ConnectionError of kind "transport" with no cause',
    err: () => new ConnectionError("server went away", "transport"),
    expected: "unavailable",
  },
  {
    name: "a plain Error",
    err: () => new Error("unclassified"),
    expected: "unavailable",
  },
  { name: "undefined", err: () => undefined, expected: "unavailable" },
  { name: "a string", err: () => "thrown text", expected: "unavailable" },
];

describe("classifyFailure", () => {
  test.each(BARE_SHAPES)("$name classifies $expected", ({ err, expected }) => {
    expect(classifyFailure(err())).toBe(expected);
  });

  test.each(BARE_SHAPES.filter(({ name }) => !name.includes("no cause")))(
    '$name behind a ConnectionError of kind "transport" keeps $expected',
    ({ err, expected }) => {
      expect(classifyFailure(behindTransport(err()))).toBe(expected);
    },
  );

  test("a PeerAbortError ends the walk: what it wraps does not classify it", () => {
    const abort = new PeerAbortError({ cause: new UsageError("inner") });
    expect(firstLinkBehindTransportWraps(abort)).toBe(abort);
    expect(classifyFailure(abort)).toBe("partner-refused");
    expect(classifyFailure(behindTransport(abort))).toBe("partner-refused");
  });

  test.each([
    ["a UsageError", () => new UsageError("inner")],
    ["an AuthenticationError", () => new AuthenticationError("inner")],
    ["an InternalConsistencyError", () => new InternalConsistencyError("x")],
  ])(
    'a ConnectionError of kind "security" holding %s is not unwrapped',
    (_name, inner) => {
      const security = new ConnectionError("integrity", "security", {
        cause: inner(),
      });
      expect(firstLinkBehindTransportWraps(security)).toBe(security);
      expect(classifyFailure(security)).toBe("trust-check-failed");
      expect(classifyFailure(behindTransport(security))).toBe(
        "trust-check-failed",
      );
    },
  );

  test("the walk stops after the cause-depth bound", () => {
    const usage = new UsageError("deep");
    expect(
      classifyFailure(behindTransportWraps(MAX_ERROR_CAUSE_DEPTH, usage)),
    ).toBe("usage-error");
    const tooDeep = behindTransportWraps(MAX_ERROR_CAUSE_DEPTH + 1, usage);
    expect(firstLinkBehindTransportWraps(tooDeep)).toBeInstanceOf(
      ConnectionError,
    );
    expect(classifyFailure(tooDeep)).toBe("unavailable");
  });

  test("a cause cycle of transport wraps ends at the depth bound", () => {
    const a = new ConnectionError("a", "transport");
    const b = new ConnectionError("b", "transport", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(classifyFailure(a)).toBe("unavailable");
  });
});

describe("isTrustBoundaryFailure", () => {
  const TRUST_BOUNDARY: Record<FailureClass, boolean> = {
    "usage-error": false,
    "internal-fault": false,
    "partner-refused": false,
    "receipt-not-verified": true,
    "authentication-failed": true,
    "trust-check-failed": true,
    cancelled: false,
    unavailable: false,
  };

  test.each(Object.entries(TRUST_BOUNDARY))("%s -> %s", (cls, expected) => {
    expect(isTrustBoundaryFailure(cls as FailureClass)).toBe(expected);
  });

  test("holds exactly the bare security-kind ConnectionErrors", () => {
    for (const { err } of BARE_SHAPES) {
      const e = err();
      expect(isTrustBoundaryFailure(classifyFailure(e))).toBe(
        e instanceof ConnectionError && e.kind === "security",
      );
    }
  });
});
