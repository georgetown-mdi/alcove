import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SHARED_SECRET_EXPIRED_ABORT_REASON,
  exchangeTerms,
  releasableTermsRotation,
} from "../src/protocolSetup";
import type {
  ReleasableTermsRotation,
  TermsRotation,
} from "../src/protocolSetup";
import {
  deriveNextSecret,
  drawRotationValue,
  unwrapRotationValue,
  wrapRotationValue,
} from "../src/nextSecret";
import type { NextSecretInputs } from "../src/nextSecret";
import { SHARED_SECRET_REGEX } from "../src/config/connection";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import {
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  receiveAfterTerms,
} from "../src/partnerAbortFrame";
import { isPartnerNextSecretStoreFailure } from "../src/failureClass";
import {
  ConnectionError,
  InternalConsistencyError,
  PartnerProtocolRefusalError,
  PeerAbortError,
  ProtocolRefusalError,
  statesItsOwnNextStep,
} from "../src/errors";
import { fromBase64Url, randomBytes, toBase64Url } from "../src/utils/crypto";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import { recordingConnection } from "./utils/recordingConnection";

// The rotation step of the terms exchange: the responder's value on terms
// message 2, its rules, and the store order (docs/spec/PROTOCOL.md,
// "Shared-secret rotation"). Each side's NextSecretInputs are fixed here, as a
// completed key exchange would leave them, so the terms exchange is driven
// alone.

const terms: LinkageTerms = {
  version: "1.0.0",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

function handshakeInputs(expires?: string): NextSecretInputs {
  return {
    sessionKey: randomBytes(32),
    keyAgreementOutput: randomBytes(32),
    initiatorValue: randomBytes(32),
    expires,
  };
}

/** A side's rotation, recording every next secret its store was handed, what
 * the side had sent when the store ran, and each report of whether the
 * partner may hold a next secret this side has not stored. */
function storing(
  inputs: NextSecretInputs,
  sent: Array<Record<string, unknown>>,
  fail?: Error,
) {
  const stored: string[] = [];
  const sentAtStore: number[] = [];
  const partnerMayHold: boolean[] = [];
  const rotation: TermsRotation = {
    inputs,
    store: async (nextSecret) => {
      sentAtStore.push(sent.length);
      if (fail !== undefined) throw fail;
      stored.push(nextSecret);
    },
    partnerMayHoldNextSecret: (mayHold) => {
      partnerMayHold.push(mayHold);
    },
  };
  return { rotation, stored, sentAtStore, partnerMayHold };
}

/** A connection whose outgoing frames pass through `rewrite` first; a frame
 * it maps to `undefined` is dropped. */
function rewriting(
  conn: MessageConnection,
  rewrite: (frame: Record<string, unknown>) => unknown,
): MessageConnection {
  return {
    send: async (data) => {
      const out = rewrite(data as Record<string, unknown>);
      if (out !== undefined) await conn.send(out);
    },
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/** Rewrite the responder's proceeding terms message 2 only. */
function rewriteTermsReply(
  edit: (frame: Record<string, unknown>) => unknown,
): (frame: Record<string, unknown>) => unknown {
  return (frame) =>
    frame.decision === "proceed" && "linkageTerms" in frame
      ? edit(frame)
      : frame;
}

async function runRotating(options: {
  initiatorInputs?: NextSecretInputs;
  responderInputs?: NextSecretInputs;
  initiatorRotates?: boolean;
  responderRotates?: boolean;
  initiatorStoreFails?: Error;
  responderStoreFails?: Error;
  rewriteResponder?: (frame: Record<string, unknown>) => unknown;
  rewriteInitiator?: (frame: Record<string, unknown>) => unknown;
  closeWhenInitiatorStops?: boolean;
  releasable?: boolean;
}) {
  const inputs = handshakeInputs();
  const [rawA, rawB] = createMessagePipe();
  const a = recordingConnection(
    options.rewriteInitiator ? rewriting(rawA, options.rewriteInitiator) : rawA,
  );
  const b = recordingConnection(
    options.rewriteResponder ? rewriting(rawB, options.rewriteResponder) : rawB,
  );
  const initiator = storing(
    options.initiatorInputs ?? inputs,
    a.sent,
    options.initiatorStoreFails,
  );
  const responder = storing(
    options.responderInputs ?? inputs,
    b.sent,
    options.responderStoreFails,
  );
  if (options.releasable === true) {
    initiator.rotation = releasableTermsRotation(initiator.rotation);
    responder.rotation = releasableTermsRotation(responder.rotation);
  }
  const initiatorRun = exchangeTerms(
    a.conn,
    "initiator",
    terms,
    10,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.initiatorRotates === false ? undefined : initiator.rotation,
  );
  // A responder whose abort was rewritten waits for a terms message 3 the
  // initiator never sends; the initiator's stop closes its end.
  if (options.closeWhenInitiatorStops === true)
    initiatorRun.catch(() => setTimeout(() => void rawA.close(), 5));
  const settled = await Promise.allSettled([
    initiatorRun,
    exchangeTerms(
      b.conn,
      "responder",
      terms,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options.responderRotates === false ? undefined : responder.rotation,
    ),
  ]);
  return { inputs, settled, initiator, responder, a, b, rawA, rawB };
}

function rejection(outcome: PromiseSettledResult<unknown>): unknown {
  if (outcome.status !== "rejected") throw new Error("expected a rejection");
  return outcome.reason;
}

function abortReasonsSent(sent: Array<Record<string, unknown>>): unknown {
  return sent.find((frame) => frame.decision === "abort")?.abortReasons;
}

describe("a proceeding authenticated terms exchange", () => {
  test("both sides store the same next secret, derived over ka and both values", async () => {
    const { inputs, settled, initiator, responder, b } = await runRotating({});
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(initiator.stored).toHaveLength(1);
    expect(responder.stored).toEqual(initiator.stored);
    expect(SHARED_SECRET_REGEX.test(initiator.stored[0]!)).toBe(true);

    const reply = b.sent[0]!;
    expect(typeof reply.responderValue).toBe("string");
    expect(reply.responderValue as string).toHaveLength(54);
    const responderValue = await unwrapRotationValue(
      inputs.sessionKey,
      "responder",
      fromBase64Url(reply.responderValue as string),
    );
    expect(initiator.stored[0]).toBe(
      await deriveNextSecret(
        inputs.keyAgreementOutput,
        inputs.initiatorValue,
        responderValue!,
      ),
    );
  });

  test("the initiator stores before it sends proceed, and the responder once it has read it", async () => {
    const { initiator, responder, a, b } = await runRotating({});
    // The initiator had sent terms message 1 only when its store ran.
    expect(initiator.sentAtStore).toEqual([1]);
    expect(a.sent.map((frame) => frame.decision)).toEqual([
      undefined,
      "proceed",
    ]);
    // The responder had sent terms message 2 when its store ran.
    expect(responder.sentAtStore).toEqual([1]);
    expect(b.sent).toHaveLength(1);
  });

  test("each run draws a fresh responder value", async () => {
    const first = await runRotating({});
    const second = await runRotating({
      initiatorInputs: first.inputs,
      responderInputs: first.inputs,
    });
    expect(first.initiator.stored[0]).not.toBe(second.initiator.stored[0]);
  });

  test("the next secret differs between two legs that relay the same values with their own key agreement", async () => {
    // A party in the middle that unwraps on one leg and rewraps the same values
    // on the other cannot make the two legs store one secret: ka differs.
    const leg1 = handshakeInputs();
    const leg2: NextSecretInputs = {
      ...handshakeInputs(),
      initiatorValue: leg1.initiatorValue,
    };
    const value = await drawRotationValue();
    expect(
      await deriveNextSecret(
        leg1.keyAgreementOutput,
        leg1.initiatorValue,
        value.bytes,
      ),
    ).not.toBe(
      await deriveNextSecret(
        leg2.keyAgreementOutput,
        leg2.initiatorValue,
        value.bytes,
      ),
    );
  });
});

describe("the responder's value on terms message 2", () => {
  test("a missing value ends the run on the initiator with an abort, and nothing is stored on either side", async () => {
    const { settled, initiator, responder, a } = await runRotating({
      rewriteResponder: rewriteTermsReply(
        ({ responderValue: _dropped, ...rest }) => rest,
      ),
    });
    const err = rejection(settled[0]);
    expect(err).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((err as Error).message).toMatch(
      /did not include a readable value for the next shared secret/,
    );
    expect(abortReasonsSent(a.sent)).toEqual([
      "partner omitted a readable next-secret value",
    ]);
    expect(rejection(settled[1])).toBeInstanceOf(ProtocolRefusalError);
    expect(initiator.stored).toEqual([]);
    expect(responder.stored).toEqual([]);
    expect(initiator.sentAtStore).toEqual([]);
  });

  test.each([
    ["not a string", 42],
    ["not base64url", "!".repeat(54)],
    ["32 bytes, not 40", toBase64Url(randomBytes(32))],
    ["48 bytes, not 40", toBase64Url(randomBytes(48))],
    ["empty", ""],
  ])(
    "a malformed value (%s) ends the run with nothing stored",
    async (_name, malformed) => {
      const { settled, initiator, responder } = await runRotating({
        rewriteResponder: rewriteTermsReply((frame) => ({
          ...frame,
          responderValue: malformed,
        })),
      });
      expect(rejection(settled[0])).toBeInstanceOf(PartnerProtocolRefusalError);
      expect(settled[1].status).toBe("rejected");
      expect(initiator.stored).toEqual([]);
      expect(responder.stored).toEqual([]);
    },
  );

  test("a value that fails to unwrap ends the run as a security failure, with nothing stored", async () => {
    const wrapped = toBase64Url(
      await wrapRotationValue(
        randomBytes(32),
        "responder",
        await drawRotationValue(),
      ),
    );
    const run = await runRotating({
      rewriteResponder: rewriteTermsReply((frame) => ({
        ...frame,
        responderValue: wrapped,
      })),
    });
    const err = rejection(run.settled[0]);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("security");
    expect((err as Error).message).toMatch(/failed its integrity check/);
    expect(abortReasonsSent(run.a.sent)).toEqual([
      "partner's next-secret value failed to unwrap",
    ]);
    expect(run.initiator.stored).toEqual([]);
    expect(run.responder.stored).toEqual([]);
  });

  test("a value wrapped under the initiator's label fails to unwrap", async () => {
    const inputs = handshakeInputs();
    const wrapped = toBase64Url(
      await wrapRotationValue(
        inputs.sessionKey,
        "initiator",
        await drawRotationValue(),
      ),
    );
    const run = await runRotating({
      initiatorInputs: inputs,
      responderInputs: inputs,
      rewriteResponder: rewriteTermsReply((frame) => ({
        ...frame,
        responderValue: wrapped,
      })),
    });
    expect((rejection(run.settled[0]) as ConnectionError).kind).toBe(
      "security",
    );
    expect(run.initiator.stored).toEqual([]);
    expect(run.responder.stored).toEqual([]);
  });

  test("a value on an abort is not read, and nothing is stored", async () => {
    const wrapped = toBase64Url(randomBytes(40));
    const run = await runRotating({
      closeWhenInitiatorStops: true,
      rewriteResponder: rewriteTermsReply((frame) => ({
        ...frame,
        decision: "abort",
        abortReasons: ["refused"],
        responderValue: wrapped,
      })),
    });
    const err = rejection(run.settled[0]);
    expect(err).toBeInstanceOf(ProtocolRefusalError);
    expect((err as Error).message).not.toMatch(/next shared secret/);
    expect(run.initiator.stored).toEqual([]);
    expect(run.initiator.sentAtStore).toEqual([]);
    expect(run.responder.stored).toEqual([]);
  });

  test("an exchange that ran no key exchange refuses a value rather than reading past it", async () => {
    const run = await runRotating({ initiatorRotates: false });
    const err = rejection(run.settled[0]);
    expect(err).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((err as Error).message).toMatch(/ran no key exchange/);
    expect(abortReasonsSent(run.a.sent)).toEqual([
      "partner sent a next-secret value on an exchange with no key exchange",
    ]);
    expect(run.responder.stored).toEqual([]);
  });

  test("an exchange that ran no key exchange sends no value", async () => {
    const run = await runRotating({
      initiatorRotates: false,
      responderRotates: false,
    });
    expect(run.settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect("responderValue" in run.b.sent[0]!).toBe(false);
  });
});

describe("a failed store", () => {
  test("the initiator's ends the run with an abort naming it, and nothing is stored on either side", async () => {
    const failure = new Error("disk full");
    const run = await runRotating({ initiatorStoreFails: failure });
    expect(rejection(run.settled[0])).toBe(failure);
    expect(abortReasonsSent(run.a.sent)).toEqual([
      NEXT_SECRET_STORE_FAILED_ABORT_REASON,
    ]);
    expect(run.a.sent.map((frame) => frame.decision)).toEqual([
      undefined,
      "abort",
    ]);
    const responderErr = rejection(run.settled[1]);
    expect(responderErr).toBeInstanceOf(ProtocolRefusalError);
    expect(run.initiator.stored).toEqual([]);
    expect(run.responder.stored).toEqual([]);
    expect(run.responder.sentAtStore).toEqual([]);
  });

  test("the responder's sends an abort the initiator reads past the terms exchange, and leaves the initiator ahead", async () => {
    const failure = new Error("disk full");
    const run = await runRotating({ responderStoreFails: failure });
    expect(run.settled[0].status).toBe("fulfilled");
    expect(rejection(run.settled[1])).toBe(failure);
    expect(run.initiator.stored).toHaveLength(1);
    expect(run.responder.stored).toEqual([]);
    expect(run.b.sent.at(-1)).toEqual({
      decision: "abort",
      abortReasons: [NEXT_SECRET_STORE_FAILED_ABORT_REASON],
    });
    const abort: unknown = await receiveAfterTerms(run.rawA, {
      parse: (v: unknown) => v,
    }).catch((err: unknown) => err);
    expect(abort).toBeInstanceOf(PeerAbortError);
    expect((abort as PeerAbortError).partnerReason).toBe(
      NEXT_SECRET_STORE_FAILED_ABORT_REASON,
    );
    expect(isPartnerNextSecretStoreFailure(abort)).toBe(true);
  });
});

describe("an expired secret at each commit point", () => {
  const expires = new Date(NOW_MS).toISOString();

  test("the responder's, before terms message 2: an abort naming it, no value sent, nothing stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const inputs = handshakeInputs(expires);
    const run = await runRotating({
      initiatorInputs: { ...inputs, expires: undefined },
      responderInputs: inputs,
    });
    const responderErr = rejection(run.settled[1]);
    expect((responderErr as Error).message).toMatch(
      /expired at .*, before the next one was saved/,
    );
    expect(statesItsOwnNextStep(responderErr, { ownOnly: true })).toBe(true);
    const reply = run.b.sent[0]!;
    expect(reply.decision).toBe("abort");
    expect(reply.abortReasons).toEqual([SHARED_SECRET_EXPIRED_ABORT_REASON]);
    expect("responderValue" in reply).toBe(false);
    // The initiator is told the partner's secret expired.
    expect(rejection(run.settled[0])).toBeInstanceOf(ProtocolRefusalError);
    expect(run.initiator.stored).toEqual([]);
    expect(run.responder.stored).toEqual([]);
  });

  test("the initiator's, just before its store: an abort naming it, nothing stored on either side", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const inputs = handshakeInputs(expires);
    const run = await runRotating({
      initiatorInputs: inputs,
      responderInputs: { ...inputs, expires: undefined },
    });
    const initiatorErr = rejection(run.settled[0]);
    expect((initiatorErr as Error).message).toMatch(
      /before the next one was saved/,
    );
    expect(abortReasonsSent(run.a.sent)).toEqual([
      SHARED_SECRET_EXPIRED_ABORT_REASON,
    ]);
    expect(run.initiator.sentAtStore).toEqual([]);
    expect(run.initiator.stored).toEqual([]);
    expect(run.responder.stored).toEqual([]);
  });

  test("the responder stores after proceed whatever its clock reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS - 1);
    const inputs = handshakeInputs(expires);
    const run = await runRotating({
      initiatorInputs: { ...inputs, expires: undefined },
      responderInputs: inputs,
      // The secret lapses while proceed is in transit.
      rewriteInitiator: (frame) => {
        if (frame.decision === "proceed") vi.setSystemTime(NOW_MS + 1);
        return frame;
      },
    });
    expect(run.settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(run.responder.stored).toEqual(run.initiator.stored);
  });
});

describe("whether the initiator may hold a next secret the responder has not stored", () => {
  test("the responder reports it as it sends its value, and the initiator never does", async () => {
    const run = await runRotating({});
    expect(run.responder.partnerMayHold).toEqual([true]);
    expect(run.initiator.partnerMayHold).toEqual([]);
  });

  test("a responder that refuses before terms message 2 never reports it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const inputs = handshakeInputs(new Date(NOW_MS).toISOString());
    const run = await runRotating({
      initiatorInputs: { ...inputs, expires: undefined },
      responderInputs: inputs,
    });
    expect(run.settled[1].status).toBe("rejected");
    expect(run.responder.partnerMayHold).toEqual([]);
  });

  test("the initiator's abort in place of proceed withdraws it", async () => {
    const run = await runRotating({
      initiatorStoreFails: new Error("disk full"),
    });
    expect(rejection(run.settled[1])).toBeInstanceOf(ProtocolRefusalError);
    expect(run.responder.partnerMayHold).toEqual([true, false]);
  });

  test("a lost proceed leaves it reported", async () => {
    const [rawA, rawB] = createMessagePipe();
    const inputs = handshakeInputs();
    const initiator = storing(inputs, []);
    const responder = storing(inputs, []);
    const lost = rewriting(rawA, (frame) =>
      frame.decision === "proceed" ? undefined : frame,
    );
    const responderRun = exchangeTerms(
      rawB,
      "responder",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      responder.rotation,
    );
    responderRun.catch(() => {});
    await exchangeTerms(
      lost,
      "initiator",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      initiator.rotation,
    );
    await rawA.close();
    await expect(responderRun).rejects.toThrow();
    expect(responder.partnerMayHold).toEqual([true]);
  });
});

describe("the store order's cut points", () => {
  test("terms message 2 lost: nothing is stored on either side", async () => {
    const [rawA, rawB] = createMessagePipe();
    const inputs = handshakeInputs();
    const initiator = storing(inputs, []);
    const responder = storing(inputs, []);
    const lost = rewriting(
      rawB,
      rewriteTermsReply(() => undefined),
    );
    const initiatorRun = exchangeTerms(
      rawA,
      "initiator",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      initiator.rotation,
    );
    const responderRun = exchangeTerms(
      lost,
      "responder",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      responder.rotation,
    );
    initiatorRun.catch(() => {});
    responderRun.catch(() => {});
    // Both stop: the transport closes under them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rawA.close();
    await expect(initiatorRun).rejects.toThrow();
    await expect(responderRun).rejects.toThrow();
    expect(initiator.stored).toEqual([]);
    expect(responder.stored).toEqual([]);
  });

  test("proceed lost: the initiator holds the next secret and the responder is unchanged", async () => {
    const [rawA, rawB] = createMessagePipe();
    const inputs = handshakeInputs();
    const initiator = storing(inputs, []);
    const responder = storing(inputs, []);
    const lost = rewriting(rawA, (frame) =>
      frame.decision === "proceed" ? undefined : frame,
    );
    const initiatorRun = exchangeTerms(
      lost,
      "initiator",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      initiator.rotation,
    );
    const responderRun = exchangeTerms(
      rawB,
      "responder",
      terms,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      responder.rotation,
    );
    responderRun.catch(() => {});
    await initiatorRun;
    await rawA.close();
    await expect(responderRun).rejects.toThrow();
    expect(initiator.stored).toHaveLength(1);
    expect(responder.stored).toEqual([]);
  });
});

describe("a releasable rotation", () => {
  function released(rotation: TermsRotation): ReleasableTermsRotation {
    return rotation as ReleasableTermsRotation;
  }

  test("each side holds no inputs once its store has run", async () => {
    const run = await runRotating({ releasable: true });
    expect(run.settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(run.responder.stored).toEqual(run.initiator.stored);
    for (const side of [run.initiator, run.responder]) {
      expect(released(side.rotation).holdsInputs()).toBe(false);
      expect(() => side.rotation.inputs).toThrow(InternalConsistencyError);
    }
  });

  test("a store that throws still releases the inputs", async () => {
    const run = await runRotating({
      releasable: true,
      initiatorStoreFails: new Error("disk full"),
    });
    expect(run.settled[0].status).toBe("rejected");
    expect(released(run.initiator.rotation).holdsInputs()).toBe(false);
  });

  test("a run that ends before its store keeps them until released", async () => {
    const run = await runRotating({
      releasable: true,
      rewriteResponder: rewriteTermsReply(
        ({ responderValue: _dropped, ...rest }) => rest,
      ),
    });
    expect(run.initiator.stored).toEqual([]);
    const initiatorRotation = released(run.initiator.rotation);
    expect(initiatorRotation.holdsInputs()).toBe(true);
    initiatorRotation.release();
    expect(initiatorRotation.holdsInputs()).toBe(false);
    expect(() => initiatorRotation.inputs).toThrow(InternalConsistencyError);
  });

  test("the wrapper passes the store, the report, and a fixed value through", async () => {
    const stored: string[] = [];
    const reports: boolean[] = [];
    const fixed = randomBytes(32);
    const inputs = handshakeInputs();
    const rotation = releasableTermsRotation({
      inputs,
      store: (nextSecret) => {
        stored.push(nextSecret);
      },
      partnerMayHoldNextSecret: (mayHold) => {
        reports.push(mayHold);
      },
      fixedResponderValue: fixed,
    });
    expect(rotation.inputs).toBe(inputs);
    expect(rotation.fixedResponderValue).toBe(fixed);
    rotation.partnerMayHoldNextSecret?.(true);
    await rotation.store("next");
    expect(stored).toEqual(["next"]);
    expect(reports).toEqual([true]);
  });
});
