import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, describe, expect, test, vi } from "vitest";

import { authenticateConnection } from "../src/auth";
import type { RotationState } from "../src/auth";
import { runKex } from "../src/kex";
import {
  ROTATION_HISTORY_MAX_ENTRIES,
  deriveHistoryVerifier,
} from "../src/rotationHistory";
import type { RotationHistoryEntry } from "../src/rotationHistory";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import {
  AuthenticationError,
  LocalCopyBehindError,
  PartnerCopyBehindError,
} from "../src/errors";
import { randomBytes, toBase64Url } from "../src/utils/crypto";
import type { HandshakeRole } from "../src/types";

// The key exchange's previous-secret trial verification and the history proofs
// and behind notices (docs/spec/PROTOCOL.md, "Which secret a handshake uses"
// and "The rotation history").

const GENERIC_FAILURE = "key exchange authentication failed";

const secret = (): string => toBase64Url(randomBytes(32));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Side {
  current: string;
  state?: RotationState;
}

async function entriesFor(
  retired: ReadonlyArray<string>,
): Promise<RotationHistoryEntry[]> {
  return Promise.all(
    retired.map(async (s) => ({ verifier: await deriveHistoryVerifier(s) })),
  );
}

function authenticate(
  conn: MessageConnection,
  side: Side,
  role: HandshakeRole,
) {
  return authenticateConnection(
    conn,
    { sharedSecret: side.current },
    role,
    true,
    side.state ?? { history: [] },
  );
}

async function handshake(initiator: Side, responder: Side) {
  const [a, b] = createMessagePipe();
  return Promise.allSettled([
    authenticate(a, initiator, "initiator"),
    authenticate(b, responder, "responder"),
  ]);
}

/** A fresh P-256 share in its wire encoding. */
async function freshShare(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
}

function reasonOf(outcome: PromiseSettledResult<unknown>): unknown {
  if (outcome.status !== "rejected") throw new Error("expected a rejection");
  return outcome.reason;
}

function valueOf<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status !== "fulfilled")
    throw new Error("expected the handshake to complete", {
      cause: (outcome as PromiseRejectedResult).reason,
    });
  return outcome.value;
}

describe("which secret a handshake completes under", () => {
  test("two sides on one secret complete under it whatever each keeps besides", async () => {
    const x = secret();
    const [i, r] = await handshake(
      {
        current: x,
        state: {
          previous: { sharedSecret: secret() },
          history: await entriesFor([secret()]),
        },
      },
      {
        current: x,
        state: { previous: { sharedSecret: secret() }, history: [] },
      },
    );
    expect(valueOf(i).secretUsed).toEqual({
      local: "current",
      partner: "current",
    });
    expect(valueOf(r).secretUsed).toEqual({
      local: "current",
      partner: "current",
    });
    expect(valueOf(i).sessionKey).toEqual(valueOf(r).sessionKey);
  });

  const x = secret();
  const y = secret();
  const z = secret();
  const cases: ReadonlyArray<{
    name: string;
    initiator: Side;
    responder: Side;
    initiatorUsed: "current" | "previous";
    responderUsed: "current" | "previous";
  }> = [
    {
      name: "the initiator ahead",
      initiator: {
        current: y,
        state: { previous: { sharedSecret: x }, history: [] },
      },
      responder: { current: x },
      initiatorUsed: "previous",
      responderUsed: "current",
    },
    {
      name: "the responder ahead",
      initiator: { current: x },
      responder: {
        current: y,
        state: { previous: { sharedSecret: x }, history: [] },
      },
      initiatorUsed: "current",
      responderUsed: "previous",
    },
    {
      name: "both ahead on different secrets from one previous",
      initiator: {
        current: y,
        state: { previous: { sharedSecret: x }, history: [] },
      },
      responder: {
        current: z,
        state: { previous: { sharedSecret: x }, history: [] },
      },
      initiatorUsed: "previous",
      responderUsed: "previous",
    },
  ];
  for (const c of cases) {
    test(`${c.name}: both complete under the shared secret and each learns which side used its previous one`, async () => {
      const [i, r] = await handshake(c.initiator, c.responder);
      expect(valueOf(i).secretUsed).toEqual({
        local: c.initiatorUsed,
        partner: c.responderUsed,
      });
      expect(valueOf(r).secretUsed).toEqual({
        local: c.responderUsed,
        partner: c.initiatorUsed,
      });
      expect(valueOf(i).sessionKey).toEqual(valueOf(r).sessionKey);
      expect(valueOf(i).nextSecretInputs.initiatorValue).toEqual(
        valueOf(r).nextSecretInputs.initiatorValue,
      );
    });
  }

  test("a previous secret whose expires has passed is not offered", async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const [i, r] = await handshake(
      {
        current: y,
        state: { previous: { sharedSecret: x, expires: past }, history: [] },
      },
      { current: x },
    );
    expect(reasonOf(i)).toBeInstanceOf(AuthenticationError);
    expect(reasonOf(r)).toBeInstanceOf(AuthenticationError);
  });

  test("the expires the terms exchange checks is the one of the secret the handshake used", async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const [i] = await handshake(
      {
        current: y,
        state: { previous: { sharedSecret: x, expires: later }, history: [] },
      },
      { current: x },
    );
    expect(valueOf(i).nextSecretInputs.expires).toBe(later);
  });

  test("a changed previous-secret flag in message 3 fails the responder's tag", async () => {
    const [a, b] = createMessagePipe();
    const flipping: MessageConnection = {
      send: async (data) => {
        const frame = data as Record<string, unknown>;
        await a.send(
          frame.kexMsg === "3"
            ? { ...frame, usedPrevious: !(frame.usedPrevious as boolean) }
            : frame,
        );
      },
      receive: (t) => a.receive(t),
      close: () => a.close(),
    };
    const responder = authenticate(
      b,
      { current: y, state: { previous: { sharedSecret: x }, history: [] } },
      "responder",
    );
    responder.catch(() => {});
    await authenticate(flipping, { current: x }, "initiator");
    await expect(responder).rejects.toThrow(GENERIC_FAILURE);
  });
});

describe("the history proof and the behind notice", () => {
  // A copy `behind` rotations old: the current side retired its secret then.
  async function staleCopy(behind: number) {
    const retired = Array.from({ length: behind + 1 }, secret);
    const current = retired.shift()!;
    const stale = retired[behind - 1]!;
    return {
      current: { current, state: { history: await entriesFor(retired) } },
      stale: { current: stale },
    };
  }

  for (const staleRole of ["initiator", "responder"] as const) {
    for (const behind of [1, 3]) {
      test(`a copy ${behind} rotation(s) behind, as the ${staleRole}: the current side names the bound and the stale side is told`, async () => {
        const { current, stale } = await staleCopy(behind);
        const [i, r] =
          staleRole === "initiator"
            ? await handshake(stale, current)
            : await handshake(current, stale);
        const [staleOutcome, currentOutcome] =
          staleRole === "initiator" ? [i, r] : [r, i];
        const onCurrent = reasonOf(currentOutcome);
        expect(onCurrent).toBeInstanceOf(PartnerCopyBehindError);
        expect(onCurrent).toBeInstanceOf(AuthenticationError);
        expect(
          (onCurrent as PartnerCopyBehindError).rotationsBehindAtMost,
        ).toBe(behind);
        expect((onCurrent as Error).message).toContain(
          `no more than ${behind} rotation`,
        );
        const onStale = reasonOf(staleOutcome);
        expect(onStale).toBeInstanceOf(LocalCopyBehindError);
        expect((onStale as Error).message).toMatch(
          /^This copy of the exchange is older than the one on the other side\./,
        );
        expect((onStale as Error).message).not.toContain(String(behind));
      });
    }
  }

  test("a stranger meets the generic failure on both sides, whatever the histories hold", async () => {
    const [i, r] = await handshake(
      {
        current: secret(),
        state: { history: await entriesFor([secret(), secret()]) },
      },
      { current: secret(), state: { history: await entriesFor([secret()]) } },
    );
    for (const outcome of [i, r]) {
      const reason = reasonOf(outcome) as Error;
      expect(reason).toBeInstanceOf(AuthenticationError);
      expect(reason).not.toBeInstanceOf(PartnerCopyBehindError);
      expect(reason).not.toBeInstanceOf(LocalCopyBehindError);
      expect(reason.message).toBe(GENERIC_FAILURE);
    }
  });

  test("an expired entry is not checked and keeps its place in the count", async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const [current, newest, older] = [secret(), secret(), secret()];
    const history: RotationHistoryEntry[] = [
      { verifier: await deriveHistoryVerifier(newest), expires: past },
      { verifier: await deriveHistoryVerifier(older) },
    ];
    const counted = await handshake(
      { current, state: { history } },
      { current: older },
    );
    expect(
      (reasonOf(counted[0]) as PartnerCopyBehindError).rotationsBehindAtMost,
    ).toBe(2);
    const unchecked = await handshake(
      { current, state: { history } },
      { current: newest },
    );
    expect((reasonOf(unchecked[0]) as Error).message).toBe(GENERIC_FAILURE);
  });

  test(`only the ${ROTATION_HISTORY_MAX_ENTRIES} newest entries are checked`, async () => {
    const retired = Array.from(
      { length: ROTATION_HISTORY_MAX_ENTRIES + 1 },
      secret,
    );
    const history = await entriesFor(retired);
    const [last] = await handshake(
      { current: secret(), state: { history } },
      { current: retired[ROTATION_HISTORY_MAX_ENTRIES - 1]! },
    );
    expect(
      (reasonOf(last) as PartnerCopyBehindError).rotationsBehindAtMost,
    ).toBe(ROTATION_HISTORY_MAX_ENTRIES);
    const [beyond] = await handshake(
      { current: secret(), state: { history } },
      { current: retired[ROTATION_HISTORY_MAX_ENTRIES]! },
    );
    expect((reasonOf(beyond) as Error).message).toBe(GENERIC_FAILURE);
  });

  test("a behind notice that does not verify leaves the generic failure", async () => {
    const [a, b] = createMessagePipe();
    const forging: MessageConnection = {
      send: (data) => b.send(data),
      receive: async (t) => {
        const frame = (await b.receive(t)) as Record<string, unknown>;
        return frame.kexMsg === "abort"
          ? {
              ...frame,
              behindNotice: { count: 1, tag: toBase64Url(randomBytes(32)) },
            }
          : frame;
      },
      close: () => b.close(),
    };
    const [i, r] = await Promise.allSettled([
      runKex(a, "initiator", randomBytes(32), true),
      runKex(forging, "responder", randomBytes(32), true),
    ]);
    expect((reasonOf(i) as Error).message).toBe(GENERIC_FAILURE);
    expect((reasonOf(r) as Error).message).toBe(GENERIC_FAILURE);
  });

  test("the responder answers an abort holding a proof even with no match, and not a plain one", async () => {
    const cases: ReadonlyArray<[Record<string, unknown>, boolean]> = [
      [{ kexMsg: "abort", historyProof: toBase64Url(randomBytes(32)) }, true],
      [{ kexMsg: "abort" }, false],
    ];
    for (const [abort, answered] of cases) {
      const [a, b] = createMessagePipe();
      const responder = runKex(b, "responder", randomBytes(32), true);
      responder.catch(() => {});
      await a.send({ kexMsg: "1", e: await freshShare(), reqEnc: true });
      expect(await a.receive()).toMatchObject({ kexMsg: "2" });
      await a.send(abort);
      await expect(responder).rejects.toThrow(GENERIC_FAILURE);
      if (answered) expect(await a.receive(1_000)).toEqual({ kexMsg: "abort" });
      else await expect(a.receive(50)).rejects.toThrow();
    }
  });

  test("an initiator whose partner sends no reply to its proof fails with the generic failure", async () => {
    const [a, b] = createMessagePipe();
    const initiator = runKex(a, "initiator", randomBytes(32), true);
    initiator.catch(() => {});
    expect(await b.receive()).toMatchObject({ kexMsg: "1" });
    await b.send({
      kexMsg: "2",
      e: await freshShare(),
      confirm: toBase64Url(randomBytes(32)),
      previousConfirm: toBase64Url(randomBytes(32)),
      historyProof: toBase64Url(randomBytes(32)),
      reqEnc: true,
    });
    const abort = (await b.receive()) as Record<string, unknown>;
    expect(abort.kexMsg).toBe("abort");
    expect(typeof abort.historyProof).toBe("string");
    expect(abort).not.toHaveProperty("behindNotice");
    await b.close();
    const err = await initiator.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(GENERIC_FAILURE);
  });
});

describe("the work of a completed handshake does not depend on the previous secret", () => {
  const SUBTLE_METHODS = [
    "decrypt",
    "deriveBits",
    "deriveKey",
    "digest",
    "encrypt",
    "exportKey",
    "generateKey",
    "importKey",
    "sign",
    "unwrapKey",
    "verify",
    "wrapKey",
  ] as const;

  // Counts each side's crypto.subtle calls, by method, through an async
  // context each side's handshake runs in.
  async function workPerSide(initiator: Side, responder: Side) {
    const side = new AsyncLocalStorage<HandshakeRole>();
    const counts = {
      initiator: new Map<string, number>(),
      responder: new Map<string, number>(),
    };
    for (const method of SUBTLE_METHODS) {
      const original = crypto.subtle[method].bind(crypto.subtle) as (
        ...args: unknown[]
      ) => unknown;
      vi.spyOn(crypto.subtle, method).mockImplementation(((
        ...args: unknown[]
      ) => {
        const role = side.getStore();
        if (role !== undefined)
          counts[role].set(method, (counts[role].get(method) ?? 0) + 1);
        return original(...args);
      }) as never);
    }
    const [a, b] = createMessagePipe();
    const outcomes = await Promise.allSettled([
      side.run("initiator", () => authenticate(a, initiator, "initiator")),
      side.run("responder", () => authenticate(b, responder, "responder")),
    ]);
    vi.restoreAllMocks();
    valueOf(outcomes[0]);
    valueOf(outcomes[1]);
    return {
      initiator: Object.fromEntries(counts.initiator),
      responder: Object.fromEntries(counts.responder),
    };
  }

  test("each side does the same work whether either holds a previous secret, and whichever secret completes", async () => {
    const x = secret();
    const y = secret();
    const withPrevious = (current: string, previous: string): Side => ({
      current,
      state: { previous: { sharedSecret: previous }, history: [] },
    });
    const baseline = await workPerSide({ current: x }, { current: x });
    expect(baseline.initiator).not.toEqual({});
    expect(baseline.responder).not.toEqual({});
    for (const [initiator, responder] of [
      [withPrevious(x, secret()), withPrevious(x, secret())],
      [withPrevious(y, x), { current: x }],
      [{ current: x }, withPrevious(y, x)],
    ] as const) {
      expect(await workPerSide(initiator, responder)).toEqual(baseline);
    }
  });
});
