import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ConnectionError,
  EncryptedMessageConnection,
  PartnerCopyBehindError,
  causeChainSome,
  deriveHistoryVerifier,
} from "@alcove/core";

import {
  AEAD_ENVELOPE_VERSION,
  createMessagePipe,
  runKex,
} from "@alcove/core/testing";

import { authenticateExchange } from "../../../src/psi/authenticateExchange.js";

import type * as AlcoveCore from "@alcove/core";
import type { MessageConnection } from "@alcove/core";

// Core's handshake runs for real; one test forces its result to carry no
// encryption decision, which the OR of the two requests cannot produce.
const forceNoEncryption = vi.hoisted(() => ({ value: false }));
vi.mock("@alcove/core", async (importOriginal) => {
  const actual = await importOriginal<typeof AlcoveCore>();
  return {
    ...actual,
    authenticateConnection: async (
      ...args: Parameters<typeof actual.authenticateConnection>
    ) => {
      const result = await actual.authenticateConnection(...args);
      return forceNoEncryption.value
        ? { ...result, applyEncryption: false }
        : result;
    },
  };
});

/** A MessageConnection whose `send` resolves and whose `receive` rejects with
 * `error`. As the initiator, the handshake sends its first frame then awaits a
 * reply, so this exposes `error` from the kex's receive -- the boundary by which
 * a peer-driven frame failure reaches the classifier. */
function rejectingReceiveMc(error: unknown): MessageConnection {
  return {
    send: () => Promise.resolve(),
    receive: () => Promise.reject(error),
    close: () => Promise.resolve(),
  };
}

// A 32-byte value, base64url-encoded, always satisfies SHARED_SECRET_REGEX (43
// chars, the final one drawn from the 4-bit-aligned set), so any fill byte gives
// a valid distinct invitation secret. Two distinct fills model matching vs.
// mismatching invitations.
const SECRET_A = Buffer.from(new Uint8Array(32).fill(0x11)).toString(
  "base64url",
);
const SECRET_B = Buffer.from(new Uint8Array(32).fill(0x22)).toString(
  "base64url",
);

// The generic, non-oracular message every key-exchange authentication failure
// reports (it must not hint at which check failed).
const GENERIC_FAILURE = "key exchange authentication failed";

// Expiry fixtures for the threaded `expires` path: a value already in the past
// (the pre-handshake guard catches it before any frame), and one far enough ahead
// that the handshake completes before it (both guards stay no-op). The
// expires-during-the-round-trip case fakes Date inline instead, so it needs no
// constant here.
const PAST_EXPIRES = "2000-01-01T00:00:00.000Z";
const FUTURE_EXPIRES = "2999-01-01T00:00:00.000Z";

/** The web handshake role assignment (ExchangeView.tsx): inviter -> responder,
 * acceptor -> initiator. Both ends share `expires` when given (an invitation
 * has one bound both peers read); omitting it models an unbounded
 * credential, leaving core's expiry guards no-op. */
function runBothEnds(
  connInitiator: MessageConnection,
  connResponder: MessageConnection,
  initiatorSecret: string,
  responderSecret: string,
  expires?: string,
) {
  return Promise.allSettled([
    authenticateExchange(connInitiator, "initiator", initiatorSecret, expires),
    authenticateExchange(connResponder, "responder", responderSecret, expires),
  ]);
}

describe("authenticateExchange", () => {
  // One test fakes Date to drive the post-handshake (during-round-trip) expiry
  // branch; restore real time after every test so it cannot leak.
  afterEach(() => {
    vi.useRealTimers();
    forceNoEncryption.value = false;
  });

  test("matching secret: both ends derive the same 32-byte session key", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await runBothEnds(
      connA,
      connB,
      SECRET_A,
      SECRET_A,
    );

    expect(initiator.status).toBe("fulfilled");
    expect(responder.status).toBe("fulfilled");
    if (initiator.status !== "fulfilled" || responder.status !== "fulfilled")
      return;

    expect(initiator.value.sessionKey).toBeInstanceOf(Uint8Array);
    expect(initiator.value.sessionKey.length).toBe(32);
    expect(initiator.value.sessionKey).toEqual(responder.value.sessionKey);
    expect(initiator.value.applyEncryption).toBe(true);
    expect(responder.value.applyEncryption).toBe(true);
    // Each end's returned connection is the AEAD wrapper, keyed so the two
    // open each other's frames.
    for (const end of [initiator.value, responder.value])
      expect(end.connection).toBeInstanceOf(EncryptedMessageConnection);
    await initiator.value.connection.send({ round: 1 });
    expect(await responder.value.connection.receive()).toEqual({ round: 1 });
    await responder.value.connection.send(new Uint8Array([1, 2, 3]));
    expect(await initiator.value.connection.receive()).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("requests the wrap in the handshake from either role", async () => {
    const [connA, connB] = createMessagePipe();
    const sent: Array<unknown> = [];
    for (const end of [connA, connB]) {
      const original = end.send.bind(end);
      end.send = (data: unknown) => {
        sent.push(data);
        return original(data);
      };
    }

    await runBothEnds(connA, connB, SECRET_A, SECRET_A);

    expect(sent).toEqual([
      expect.objectContaining({ kexMsg: "1", reqEnc: true }),
      expect.objectContaining({ kexMsg: "2", reqEnc: true }),
      expect.objectContaining({ kexMsg: "3" }),
    ]);
  });

  test.each(["initiator", "responder"] as const)(
    "a partner that does not request the wrap still gets it, and the web %s's frames cross as envelopes",
    async (webRole) => {
      const [connWeb, connPeer] = createMessagePipe();
      const peerRole = webRole === "initiator" ? "responder" : "initiator";
      const psk = new Uint8Array(Buffer.from(SECRET_A, "base64url"));
      const [web, peer] = await Promise.all([
        authenticateExchange(connWeb, webRole, SECRET_A),
        runKex(connPeer, peerRole, psk, false),
      ]);

      // The decision is the OR of both requests, so the partner's is true too.
      expect(web.applyEncryption).toBe(true);
      expect(peer.applyEncryption).toBe(true);

      await web.connection.send({ probe: "cleartext-marker" });
      const frame = await connPeer.receive();
      expect(frame).toBeInstanceOf(Uint8Array);
      expect((frame as Uint8Array)[0]).toBe(AEAD_ENVELOPE_VERSION);
      expect(Buffer.from(frame as Uint8Array).toString("latin1")).not.toContain(
        "cleartext-marker",
      );
      // The partner's own wrapper over the same session key opens it.
      const partnerSecure = await EncryptedMessageConnection.create(
        {
          send: () => Promise.resolve(),
          receive: () => Promise.resolve(frame),
          close: () => Promise.resolve(),
        },
        peer.sessionKey,
        peerRole,
      );
      expect(await partnerSecure.receive()).toEqual({
        probe: "cleartext-marker",
      });
    },
  );

  test("refuses to run the exchange bare when the handshake returns without the wrap", async () => {
    // Unreachable through core's OR of the two requests; pinned so a change
    // there cannot leave the web exchange unwrapped.
    forceNoEncryption.value = true;
    const [connA, connB] = createMessagePipe();
    const [initiator] = await runBothEnds(connA, connB, SECRET_A, SECRET_A);

    expect(initiator.status).toBe("rejected");
    if (initiator.status !== "rejected") return;
    expect(initiator.reason).toBeInstanceOf(ConnectionError);
    expect((initiator.reason as ConnectionError).kind).toBe("usage");
    expect((initiator.reason as ConnectionError).message).toMatch(
      /encryption/i,
    );
  });

  test("mismatched secret: fails closed as a security-kind ConnectionError on both ends", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await runBothEnds(
      connA,
      connB,
      SECRET_A,
      SECRET_B,
    );

    expect(initiator.status).toBe("rejected");
    expect(responder.status).toBe("rejected");
    if (initiator.status !== "rejected" || responder.status !== "rejected")
      return;

    for (const reason of [initiator.reason, responder.reason]) {
      expect(reason).toBeInstanceOf(ConnectionError);
      expect((reason as ConnectionError).kind).toBe("security");
      // The non-oracular failure message is preserved for display.
      expect((reason as ConnectionError).message).toBe(GENERIC_FAILURE);
    }
  });

  test("a malformed secret fails closed as security before any frame is sent", async () => {
    const [connA] = createMessagePipe();
    const sent: Array<unknown> = [];
    // Spy on send so we can prove the pre-handshake credential check fired before
    // any wire activity.
    const original = connA.send.bind(connA);
    connA.send = (data: unknown) => {
      sent.push(data);
      return original(data);
    };

    await expect(
      authenticateExchange(connA, "initiator", "not-a-valid-secret"),
    ).rejects.toMatchObject({
      name: "ConnectionError",
      kind: "security",
    });
    expect(sent).toHaveLength(0);
  });

  test("a transport drop is re-thrown unchanged, not re-tagged as a trust failure", async () => {
    const [connA, connB] = createMessagePipe();
    // The responder parks awaiting the initiator's first frame; dropping the peer
    // produces a transport ConnectionError, which the kex re-throws as it is (no
    // receive deadline fired, so it is not the kex timeout). That is a retryable
    // transport drop, NOT a trust failure, so authenticateExchange must not
    // re-tag it as security.
    const responder = authenticateExchange(connB, "responder", SECRET_A);
    await Promise.resolve();
    await connA.close();

    const err: unknown = await responder.then(
      () => {
        throw new Error("handshake should have rejected on the transport drop");
      },
      (reason: unknown) => reason,
    );
    // Not re-tagged as a trust failure...
    expect(err instanceof ConnectionError && err.kind === "security").toBe(
      false,
    );
    // ...and it is the transport ConnectionError itself, passed through as a
    // retryable transport drop, not swallowed or flattened to a generic Error.
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("transport");
  });

  test("a protocol violation (peer out of turn) is re-tagged as a security trust failure", async () => {
    // A peer flooding/misordering frames during the handshake overflows the
    // inbound buffer, producing a `protocol` ConnectionError. That is never
    // benign mid-handshake, so it must be a non-retryable trust failure, not the
    // retryable transport bucket.
    const mc = rejectingReceiveMc(
      new ConnectionError("the peer is sending out of turn", "protocol"),
    );

    await expect(
      authenticateExchange(mc, "initiator", SECRET_A),
    ).rejects.toMatchObject({ name: "ConnectionError", kind: "security" });
  });

  test("a local usage fault is passed through unchanged, not re-tagged as security", async () => {
    // A `usage`-kind fault (e.g. a send on an already-closed connection) is a
    // local programming fault, not the peer's doing, so it is passed through
    // unchanged rather than mislabeled "Could not verify your partner".
    const usageError = new ConnectionError("send after close", "usage");
    const mc = rejectingReceiveMc(usageError);

    const err: unknown = await authenticateExchange(
      mc,
      "initiator",
      SECRET_A,
    ).then(
      () => {
        throw new Error("handshake should have rejected on the usage fault");
      },
      (reason: unknown) => reason,
    );
    // The exact instance is re-thrown -- not wrapped, not re-tagged as security.
    expect(err).toBe(usageError);
  });

  test.each([
    ["initiator", true],
    ["initiator", false],
    ["responder", true],
    ["responder", false],
  ] as const)(
    "a peer holding the wrong secret fails as security (web %s, peer requests the wrap: %s)",
    async (webRole, peerRequestsEncryption) => {
      const [connWeb, connPeer] = createMessagePipe();
      const wrongPsk = new Uint8Array(Buffer.from(SECRET_B, "base64url"));
      const [web] = await Promise.allSettled([
        authenticateExchange(connWeb, webRole, SECRET_A),
        runKex(
          connPeer,
          webRole === "initiator" ? "responder" : "initiator",
          wrongPsk,
          peerRequestsEncryption,
        ),
      ]);

      expect(web.status).toBe("rejected");
      if (web.status !== "rejected") return;
      expect(web.reason).toBeInstanceOf(ConnectionError);
      expect((web.reason as ConnectionError).kind).toBe("security");
      expect((web.reason as ConnectionError).message).toBe(GENERIC_FAILURE);
    },
  );

  // --- Threaded invitation expiry ------------------------------------------
  //
  // authenticateExchange forwards the invitation's `expires` into core's auth
  // parameters, arming the pre- and post-handshake expiry guards. The guards live
  // in core (covered there); these pin that the web wrapper threads the value
  // and re-tags an expiry failure as the trust-distinct `security` kind, not the
  // generic retryable bucket.

  test("an already-past expires fails closed as security before any frame is sent", async () => {
    const [connA] = createMessagePipe();
    const sent: Array<unknown> = [];
    // Spy on send to prove the pre-handshake expiry check fired before any wire
    // activity (mirrors the malformed-secret test).
    const original = connA.send.bind(connA);
    connA.send = (data: unknown) => {
      sent.push(data);
      return original(data);
    };

    await expect(
      authenticateExchange(connA, "initiator", SECRET_A, PAST_EXPIRES),
    ).rejects.toMatchObject({ name: "ConnectionError", kind: "security" });
    expect(sent).toHaveLength(0);
  });

  test("a secret that expires during the round-trip completes the handshake and is handed to the terms exchange", async () => {
    // Faking only Date: start the clock just before `expires`, run both ends
    // over an in-memory pipe (real timers, so the handshake still completes),
    // then advance past `expires` while the round-trip is in flight. Core
    // checks it again at the terms exchange, before either store, so the
    // handshake passes it on.
    const expires = "2030-01-01T00:00:00.000Z";
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2029-12-31T23:59:59.000Z"),
    });
    const [connA, connB] = createMessagePipe();
    const pInitiator = authenticateExchange(
      connA,
      "initiator",
      SECRET_A,
      expires,
    );
    const pResponder = authenticateExchange(
      connB,
      "responder",
      SECRET_A,
      expires,
    );
    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z"));
    const [initiator, responder] = await Promise.all([pInitiator, pResponder]);

    expect(initiator.nextSecretInputs.expires).toBe(expires);
    expect(responder.nextSecretInputs.expires).toBe(expires);
  });

  test("a not-yet-expired invitation proceeds: both ends derive the same session key", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await runBothEnds(
      connA,
      connB,
      SECRET_A,
      SECRET_A,
      FUTURE_EXPIRES,
    );

    expect(initiator.status).toBe("fulfilled");
    expect(responder.status).toBe("fulfilled");
    if (initiator.status !== "fulfilled" || responder.status !== "fulfilled")
      return;
    expect(initiator.value.sessionKey).toEqual(responder.value.sessionKey);
  });

  test("checks a peer on a retired secret against the history it is given", async () => {
    // The responder rotated from SECRET_A to SECRET_B; a peer still on SECRET_A
    // fails as a partner copy behind, not as a bare mismatch.
    const [connA, connB] = createMessagePipe();
    const [, responder] = await Promise.allSettled([
      authenticateExchange(connA, "initiator", SECRET_A),
      authenticateExchange(connB, "responder", SECRET_B, undefined, [
        { verifier: await deriveHistoryVerifier(SECRET_A) },
      ]),
    ]);

    expect(responder.status).toBe("rejected");
    if (responder.status !== "rejected") return;
    expect((responder.reason as ConnectionError).kind).toBe("security");
    expect(
      causeChainSome(
        responder.reason,
        (link) => link instanceof PartnerCopyBehindError,
      ),
    ).toBe(true);
  });

  test("with no history given, a peer on a retired secret is a bare mismatch", async () => {
    const [connA, connB] = createMessagePipe();
    const [, responder] = await Promise.allSettled([
      authenticateExchange(connA, "initiator", SECRET_A),
      authenticateExchange(connB, "responder", SECRET_B),
    ]);

    expect(responder.status).toBe("rejected");
    if (responder.status !== "rejected") return;
    expect(
      causeChainSome(
        responder.reason,
        (link) => link instanceof PartnerCopyBehindError,
      ),
    ).toBe(false);
  });
});
