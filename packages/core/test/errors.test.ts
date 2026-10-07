import { describe, expect, test } from "vitest";

import {
  UsageError,
  BilateralModeMismatchError,
  FrameSizeExceededError,
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  ConnectionClosedError,
  InternalConsistencyError,
  PeerAbortError,
  TransportPublishIndeterminateError,
  causeChainSome,
  isPeerWaitTimeout,
  isPsiLibraryFailure,
  isSetTooLargeError,
  isTransportPublishIndeterminate,
  markPeerWaitTimeout,
  markPsiLibraryFailure,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
  RoundSetLimitError,
  RoundCapacityError,
  InvitationTermDivergenceError,
  ConnectionError,
} from "../src/errors";
import { MAX_ERROR_CAUSE_DEPTH } from "../src/failureAnnotation";

function wrappedIn(count: number, inner: unknown): unknown {
  let link = inner;
  for (let i = 0; i < count; i++)
    link = new Error(`wrap ${i}`, { cause: link });
  return link;
}

// The recovery step each of the three classes chains behind its summary: the
// first cause link, read off the error itself rather than restated here.
const recoveryStepOf = (err: Error): string =>
  (err.cause as Error | undefined)?.message ?? "";

// A two-error `cause` cycle whose links are counting accessors rather than plain
// properties: without a seen-set a walk never returns, which would hang the run
// instead of failing it, so the chain refuses to be read past its own length.
const countingCauseCycle = (): {
  outer: Error;
  readCount: () => number;
} => {
  let reads = 0;
  const outer = new Error("outer");
  const inner = new Error("inner");
  const link = (from: Error, to: Error): void => {
    Object.defineProperty(from, "cause", {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 8)
          throw new Error("the cause chain was walked past its own length");
        return to;
      },
    });
  };
  link(outer, inner);
  link(inner, outer);
  return { outer, readCount: () => reads };
};

// These assertions guard the operator-facing-error audit: the terminal
// transport/directory UsageError family holds a recovery-hint mark and a
// concrete operator next step, so the CLI's hint-walker suppresses its
// generic "retry without re-inviting" advisory. Each test pins the mark, the
// call site's own message on `.message`, and a stable fragment of the step
// on its own cause link, plus the exit-64 classification (instanceof
// UsageError) neither may disturb -- the link's own budget is measured in
// test/connection/transportRefusalBudget.test.ts.
describe("terminal transport/directory error taxonomy", () => {
  test("FrameSizeExceededError marks the recovery hint and puts a next step on its own link", () => {
    const err = new FrameSizeExceededError("inbound frame exceeds the cap");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("FrameSizeExceededError");
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(true);
    expect(err.message).toBe("inbound frame exceeds the cap");
    expect(recoveryStepOf(err)).toContain("Confirm the shared folder");
    expect(recoveryStepOf(err)).toContain("contact your partner");
  });

  test("DirectoryListingBoundsError marks the recovery hint and puts a next step on its own link", () => {
    const err = new DirectoryListingBoundsError(
      "directory has too many entries",
    );
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("DirectoryListingBoundsError");
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(true);
    expect(err.message).toBe("directory has too many entries");
    expect(recoveryStepOf(err)).toContain(
      "Confirm the shared folder is dedicated to a single exchange",
    );
  });

  test("TransportOperationStalledError marks the recovery hint and puts a next step on its own link", () => {
    const err = new TransportOperationStalledError("SFTP read stalled");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("TransportOperationStalledError");
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(true);
    expect(err.message).toBe("SFTP read stalled");
    expect(recoveryStepOf(err)).toContain("then retry");
  });
});

describe("errors left without a recovery hint", () => {
  test("BilateralModeMismatchError stays unmarked and leaves its message intact", () => {
    // A terminal UsageError that holds its fix in the call-site message ("both
    // parties must use the same setting"), so the constructor appends nothing.
    // It is not marked, by design: the mark only suppresses the post-handshake
    // generic advisory, and a mismatch is detected pre-handshake where that
    // advisory never fires, so a mark would suppress nothing.
    const message =
      "retain_files mismatch: this party has retain_files=true but the peer " +
      "has retain_files=false; both parties must use the same setting";
    const err = new BilateralModeMismatchError(message);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("BilateralModeMismatchError");
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(false);
    expect(err.message).toBe(message);
  });

  test("ConnectionClosedError has no hint and is not a UsageError", () => {
    // Judged stepless by the audit: an internal teardown signal that almost
    // never reaches the exit code, so the generic advisory has nothing to
    // contradict and it stays a plain Error (CLI exit 69, not 64).
    const err = new ConnectionClosedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(false);
  });
});

describe("the internal fault's recovery hint", () => {
  test("InternalConsistencyError sets no hint on the class and stays a plain Error", () => {
    // Most raise sites state only the failed condition, so the class makes
    // no claim that its message holds a next step; the CLI supplies one
    // centrally. Not a UsageError: the boundary maps this class to exit 70,
    // not the 64 that would send the operator to an input the single-pass
    // ceiling gate already cleared.
    const err = new InternalConsistencyError("runKex: psk must be 32 bytes");
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err.name).toBe("InternalConsistencyError");
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(false);
  });
});

describe("errors whose recovery hint is per instance, not per class", () => {
  test("TransportPublishIndeterminateError sets no class-level mark and is not a UsageError", () => {
    // Not a UsageError, which the poll loop treats as terminal; what that
    // distinction buys is measured in fileSyncConnection.test.ts, not argued
    // here. The mark is absent from the CLASS because a transport raises this
    // for several publishes at once -- a message, an ack, a rendezvous hello,
    // an abort marker -- which share no recovery, so the transport's own
    // instance holds no next step and suppresses nothing. The one caller
    // whose recovery is established re-raises the class marked and holding
    // it; that instance is pinned in fileSyncMessageLoop.test.ts.
    const cause = new Error("_rename: No such file or directory");
    const err = new TransportPublishIndeterminateError("publish torn", {
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err.name).toBe("TransportPublishIndeterminateError");
    expect(err.cause).toBe(cause);
    expect(statesItsOwnNextStep(err, { ownOnly: true })).toBe(false);
  });
});

describe("causeChainSome", () => {
  test("matches the value handed to it, with no cause to walk", () => {
    expect(
      causeChainSome(new TypeError("boom"), (e) => e instanceof TypeError),
    ).toBe(true);
  });

  test("walks through a non-Error link instead of stopping at it", () => {
    // The chain is followed on any object link, so a plain object interposed by
    // a wrapper that is not an Error cannot hide what it wraps.
    const inner = new TypeError("boom");
    const outer = { cause: { cause: inner } };

    expect(causeChainSome(outer, (e) => e instanceof TypeError)).toBe(true);
  });

  test("returns false for a non-object, without consulting the predicate", () => {
    let consulted = false;
    const predicate = (): boolean => {
      consulted = true;
      return true;
    };

    expect(causeChainSome("not an error", predicate)).toBe(false);
    expect(causeChainSome(null, predicate)).toBe(false);
    expect(causeChainSome(undefined, predicate)).toBe(false);
    expect(consulted).toBe(false);
  });

  test("stops on a cause cycle rather than walking it forever", () => {
    const { outer, readCount } = countingCauseCycle();

    expect(causeChainSome(outer, () => false)).toBe(false);
    expect(readCount()).toBe(2);
  });

  test("walks at most MAX_ERROR_CAUSE_DEPTH links past the error", () => {
    const isType = (e: object): boolean => e instanceof TypeError;
    const inner = new TypeError("boom");
    expect(
      causeChainSome(wrappedIn(MAX_ERROR_CAUSE_DEPTH, inner), isType),
    ).toBe(true);
    expect(
      causeChainSome(wrappedIn(MAX_ERROR_CAUSE_DEPTH + 1, inner), isType),
    ).toBe(false);
  });

  test("propagates a throwing cause accessor to the caller", () => {
    const outer = new Error("outer");
    Object.defineProperty(outer, "cause", {
      configurable: true,
      get() {
        throw new Error("cause accessor exploded");
      },
    });

    expect(() => causeChainSome(outer, () => false)).toThrow(
      "cause accessor exploded",
    );
  });
});

describe("isPeerWaitTimeout cause-chain walk", () => {
  test("finds the tag on an error two links down another error's cause", () => {
    // No path inside this package wraps a tagged error, so the chain walk is
    // exercised only from outside -- and a top-level property check passes every
    // other suite. This is the case that separates the two.
    const tagged = markPeerWaitTimeout(
      new Error("synchronization has timed out"),
    );
    const middle = new Error("the exchange failed", { cause: tagged });
    const outer = new Error("Alcove exited", { cause: middle });

    expect(isPeerWaitTimeout(outer)).toBe(true);
    expect(isPeerWaitTimeout(middle)).toBe(true);
    // The mark is held beside the error, not as a property on it, so nothing
    // that enumerates or serializes the error sees it.
    expect(Object.keys(tagged)).toEqual([]);
  });

  test("returns false on a cause cycle rather than walking it forever", () => {
    // The composed predicate, not just the helper underneath it: an inlined walk
    // that dropped the seen-set would still pass every other test here and hang
    // only on a tagless cycle.
    const { outer, readCount } = countingCauseCycle();

    expect(isPeerWaitTimeout(outer)).toBe(false);
    expect(readCount()).toBe(2);
  });

  test("finds a tag that sits inside a cause cycle", () => {
    const tagged = markPeerWaitTimeout(
      new Error("synchronization has timed out"),
    );
    const outer = new Error("outer", { cause: tagged });
    (tagged as { cause?: unknown }).cause = outer;

    expect(isPeerWaitTimeout(outer)).toBe(true);
  });
});

describe("isTransportPublishIndeterminate", () => {
  const indeterminate = (): TransportPublishIndeterminateError =>
    new TransportPublishIndeterminateError("publish torn", {
      cause: new Error("_rename: No such file or directory"),
    });

  test("finds the class under the wrapping a send's rejection reaches a caller through", () => {
    // The shape the payload exchange classifies: the message connection
    // re-raises whatever the transport threw as a transport ConnectionError
    // holding it as the cause, so a top-level instanceof would miss it.
    const wrapped = new ConnectionError(
      "the publish could not be confirmed",
      "transport",
      { cause: indeterminate() },
    );

    expect(isTransportPublishIndeterminate(wrapped)).toBe(true);
    expect(isTransportPublishIndeterminate(indeterminate())).toBe(true);
  });

  test("is false for a publish the transport settled, and for what holds no error", () => {
    expect(
      isTransportPublishIndeterminate(
        new ConnectionError("the connection dropped", "transport"),
      ),
    ).toBe(false);
    expect(isTransportPublishIndeterminate(undefined)).toBe(false);
    expect(isTransportPublishIndeterminate("publish torn")).toBe(false);
  });
});

describe("PeerAbortError exemplar (unchanged)", () => {
  test("still has the hint and its pinned partner-contact message", () => {
    // The audit's exemplar: its message is pinned by design and must not be
    // reworded. This guards against an accidental edit to the bar the rest rose
    // to meet.
    const err = new PeerAbortError();
    expect(err.name).toBe("PeerAbortError");
    expect(statesItsOwnNextStep(err)).toBe(true);
    expect(err.message).toContain(
      "Your partner stopped the exchange. Their run shows the reason; contact them.",
    );
  });
});

test("a set-limit refusal for each reason is a set too large to send, and nothing else is", () => {
  for (const reason of [
    "over-set-maximum",
    "over-partner-ceiling",
    "uncounted",
  ] as const) {
    const refusal = new RoundSetLimitError("too many", reason);
    expect(refusal.reason).toBe(reason);
    expect(isSetTooLargeError(refusal)).toBe(true);
  }
  expect(isSetTooLargeError(new Error("other"))).toBe(false);
  expect(isSetTooLargeError(undefined)).toBe(false);
});

describe("statesItsOwnNextStep", () => {
  test("reads the mark on the error and on each wrap of it", () => {
    const marked = markStatesItsOwnNextStep(new Error("save failed"));
    const behindError = new Error("the run failed", { cause: marked });
    const behindTransport = new ConnectionError("send failed", "transport", {
      cause: behindError,
    });
    expect(statesItsOwnNextStep(marked)).toBe(true);
    expect(statesItsOwnNextStep(behindError)).toBe(true);
    expect(statesItsOwnNextStep(behindTransport)).toBe(true);
    expect(Object.keys(marked)).toEqual([]);
  });

  test("reads only the error itself when asked to", () => {
    const marked = markStatesItsOwnNextStep(new Error("save failed"));
    const wrapped = new Error("the run failed", { cause: marked });
    expect(statesItsOwnNextStep(marked, { ownOnly: true })).toBe(true);
    expect(statesItsOwnNextStep(wrapped, { ownOnly: true })).toBe(false);
    expect(statesItsOwnNextStep(new PeerAbortError(), { ownOnly: true })).toBe(
      true,
    );
  });

  test("reads no property of the error, only the mark", () => {
    const withProperty = Object.assign(new Error("expired"), {
      alcoveRecoveryHintEmitted: true,
    });
    expect(statesItsOwnNextStep(withProperty)).toBe(false);
    expect(
      statesItsOwnNextStep(
        new Error("the run failed", { cause: withProperty }),
      ),
    ).toBe(false);
    expect(statesItsOwnNextStep(new Error("plain"))).toBe(false);
    expect(statesItsOwnNextStep(undefined)).toBe(false);
  });

  test("reads the mark to the cause-chain depth bound", () => {
    const marked = markStatesItsOwnNextStep(new Error("save failed"));
    expect(statesItsOwnNextStep(wrappedIn(MAX_ERROR_CAUSE_DEPTH, marked))).toBe(
      true,
    );
    expect(
      statesItsOwnNextStep(wrappedIn(MAX_ERROR_CAUSE_DEPTH + 1, marked)),
    ).toBe(false);
  });

  test("each class stating its own next step is marked, with no own property", () => {
    const classMarked = [
      new InvitationTermDivergenceError("refused"),
      new RoundSetLimitError("too many", "over-set-maximum"),
      new RoundCapacityError("too many", "terms-exchange"),
      new FrameSizeExceededError("too large"),
      new DirectoryListingBoundsError("too many entries"),
      new TransportOperationStalledError("stalled"),
    ];
    for (const err of classMarked) {
      expect(statesItsOwnNextStep(err, { ownOnly: true }), err.name).toBe(true);
      expect(Object.keys(err), err.name).not.toContain(
        "alcoveRecoveryHintEmitted",
      );
    }
  });

  test("a PeerAbortError keeps the mark behind a transport wrap", () => {
    const wrapped = new ConnectionError("receive failed", "transport", {
      cause: new PeerAbortError(),
    });
    expect(statesItsOwnNextStep(wrapped)).toBe(true);
  });
});

describe("markPsiLibraryFailure", () => {
  test("is read off the error itself, never a wrap of it", () => {
    const marked = markPsiLibraryFailure(new TypeError("bad point"));
    const wrapped = new Error("the round failed", { cause: marked });
    const behindTransport = new ConnectionError("send failed", "transport", {
      cause: marked,
    });
    expect(isPsiLibraryFailure(marked)).toBe(true);
    expect(isPsiLibraryFailure(wrapped)).toBe(false);
    expect(isPsiLibraryFailure(behindTransport)).toBe(false);
  });

  test("wraps a thrown value that is not an object", () => {
    const marked = markPsiLibraryFailure("bad point");
    expect(marked).toBeInstanceOf(Error);
    expect((marked as Error).cause).toBe("bad point");
    expect(isPsiLibraryFailure(marked)).toBe(true);
  });

  test("marks a frozen error in place", () => {
    const frozen = Object.freeze(new TypeError("bad point"));
    expect(markPsiLibraryFailure(frozen)).toBe(frozen);
    expect(isPsiLibraryFailure(frozen)).toBe(true);
  });
});
