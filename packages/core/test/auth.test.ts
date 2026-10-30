import { ConnectionError, statesItsOwnNextStep } from "../src/errors";
import { afterEach, expect, test, vi } from "vitest";

import {
  AEAD_CONTEXTS,
  assertSharedSecretReadyForHandshake,
  authenticateConnection,
  deriveAeadKey,
} from "../src/auth";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import { EncryptedMessageConnection } from "../src/connection/encryptedMessageConnection";
import type { Authentication } from "../src/config/connection";
import { toBase64Url } from "../src/utils/crypto";

// A well-formed shared secret: 43 base64url characters whose final character is
// in [AEIMQUYcgkosw048], so an expiry case turns on expiry alone.
const SHARED_SECRET = "oaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaE";

// A second well-formed secret, for the mismatched-credential handshake.
const OTHER_SHARED_SECRET = toBase64Url(
  new Uint8Array(32).fill(0x5a) as Uint8Array<ArrayBuffer>,
);

// Every shape SHARED_SECRET_REGEX must refuse: absent, empty, too short, too
// long, and 43 characters whose final character has non-zero trailing bits.
const MALFORMED_SECRETS: Array<string | undefined> = [
  undefined,
  "",
  "not-a-shared-secret",
  SHARED_SECRET.slice(0, 42),
  `${SHARED_SECRET}A`,
  `${SHARED_SECRET.slice(0, 42)}B`,
];

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

function authenticationExpiringAt(offsetMs: number): Authentication {
  return {
    sharedSecret: SHARED_SECRET,
    expires: new Date(NOW_MS + offsetMs).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("a shared secret expiring exactly now is expired (the boundary is inclusive)", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(0)),
  ).toThrow(/shared secret expired/);
});

test("a shared secret expiring one millisecond from now is still usable", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(1)),
  ).not.toThrow();
});

test("a well-formed shared secret with no expiry set is ready for the handshake", () => {
  // The expiry guard must stay conditional on `expires` being set: an unexpiring
  // credential is the common case, and an absent date parses to NaN, which the
  // guard treats as expired -- so reaching it at all refuses every such secret.
  expect(() =>
    assertSharedSecretReadyForHandshake({ sharedSecret: SHARED_SECRET }),
  ).not.toThrow();
});

test("an absent, empty, or wrong-length shared secret is refused as malformed, not as expired", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  for (const sharedSecret of MALFORMED_SECRETS) {
    // A live expiry, so only the format guard can be what rejects these; the two
    // refusals have different recovery instructions and must stay distinct.
    const authentication: Authentication = {
      sharedSecret,
      expires: new Date(NOW_MS + 86_400_000).toISOString(),
    };
    expect(() => assertSharedSecretReadyForHandshake(authentication)).toThrow(
      /base64url-encoded 32-byte value/,
    );
    expect(() =>
      assertSharedSecretReadyForHandshake(authentication),
    ).not.toThrow(/expired/);
  }
});

test("a malformed shared secret is refused as malformed even when it is also expired", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake({
      sharedSecret: "",
      expires: new Date(NOW_MS - 1).toISOString(),
    }),
  ).toThrow(/base64url-encoded 32-byte value/);
});

test("both pre-handshake refusals mark themselves as having emitted a recovery hint", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  // A higher-level catch suppresses its own generic advisory on this mark, so a
  // refusal that lost it would show the user two contradictory messages.
  for (const authentication of [
    { sharedSecret: "" },
    authenticationExpiringAt(0),
  ]) {
    let thrown: unknown;
    try {
      assertSharedSecretReadyForHandshake(authentication);
    } catch (err) {
      thrown = err;
    }
    expect(statesItsOwnNextStep(thrown, { ownOnly: true })).toBe(true);
  }
});

// --- authenticateConnection over an in-memory connection pair ----------------

function authenticateOverPipe(
  initiatorSecret: string,
  responderSecret: string,
) {
  const [initiatorConn, responderConn] = createMessagePipe();
  return Promise.allSettled([
    authenticateConnection(
      initiatorConn,
      { sharedSecret: initiatorSecret },
      "initiator",
      false,
      { history: [] },
    ),
    authenticateConnection(
      responderConn,
      { sharedSecret: responderSecret },
      "responder",
      true,
      { history: [] },
    ),
  ]);
}

test("authenticateConnection returns an agreed session key, the next secret's inputs, and the encryption decision", async () => {
  const [initiator, responder] = await authenticateOverPipe(
    SHARED_SECRET,
    SHARED_SECRET,
  );
  if (initiator.status !== "fulfilled" || responder.status !== "fulfilled") {
    throw new Error("the handshake did not complete on both sides");
  }

  expect(initiator.value.sessionKey).toHaveLength(32);
  expect(initiator.value.sessionKey).toEqual(responder.value.sessionKey);
  // Both sides hold the same inputs; the next secret itself is derived only at
  // the terms exchange, once the responder's value arrives.
  const mine = initiator.value.nextSecretInputs;
  const theirs = responder.value.nextSecretInputs;
  expect(mine.sessionKey).toEqual(initiator.value.sessionKey);
  expect(mine.keyAgreementOutput).toEqual(theirs.keyAgreementOutput);
  expect(mine.initiatorValue).toEqual(theirs.initiatorValue);
  expect(mine.expires).toBeUndefined();
  expect("rotatedSecret" in initiator.value).toBe(false);
  // Only the responder requested the encryption layer; the transcript-bound OR
  // turns it on for both.
  expect(initiator.value.applyEncryption).toBe(true);
  expect(responder.value.applyEncryption).toBe(true);
});

test("the next secret's inputs depend on neither the shared secret nor the session key", async () => {
  // ka is the ECDH output and the initiator's value is drawn fresh, so neither
  // equals any value derived from the session key the current secret feeds.
  const [initiator] = await authenticateOverPipe(SHARED_SECRET, SHARED_SECRET);
  if (initiator.status !== "fulfilled") {
    throw new Error("the handshake did not complete");
  }
  const { sessionKey, nextSecretInputs } = initiator.value;
  for (const context of AEAD_CONTEXTS) {
    const aeadKey = await deriveAeadKey(sessionKey, context);
    expect(nextSecretInputs.keyAgreementOutput).not.toEqual(aeadKey);
    expect(nextSecretInputs.initiatorValue).not.toEqual(aeadKey);
  }
  expect(nextSecretInputs.keyAgreementOutput).not.toEqual(sessionKey);
});

test("authenticateConnection passes the secret's expires to the terms exchange rather than checking it after the handshake", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  const expires = new Date(NOW_MS + 1).toISOString();
  const [initiatorConn, responderConn] = createMessagePipe();
  const both = Promise.all([
    authenticateConnection(
      initiatorConn,
      { sharedSecret: SHARED_SECRET, expires },
      "initiator",
      true,
      { history: [] },
    ),
    authenticateConnection(
      responderConn,
      { sharedSecret: SHARED_SECRET, expires },
      "responder",
      true,
      { history: [] },
    ),
  ]);
  // Lapses after the pre-handshake check: the handshake still completes.
  vi.setSystemTime(NOW_MS + 10);
  const [initiator, responder] = await both;
  expect(initiator.nextSecretInputs.expires).toBe(expires);
  expect(responder.nextSecretInputs.expires).toBe(expires);
});

test("the initiator reads the responder's abort on a failed message 3 as a security failure of the encrypted connection", async () => {
  const [initiatorConn, responderConn] = createMessagePipe();
  // A changed wrapped value in transit fails the initiator's tag at the
  // responder, after the initiator has completed.
  const tampering: MessageConnection = {
    send: async (data) => {
      const frame = data as Record<string, unknown>;
      const value = String(frame.initiatorValue);
      const changed = `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
      await initiatorConn.send(
        frame.kexMsg === "3" ? { ...frame, initiatorValue: changed } : frame,
      );
    },
    receive: (timeoutMs) => initiatorConn.receive(timeoutMs),
    close: () => initiatorConn.close(),
  };
  const responder = authenticateConnection(
    responderConn,
    { sharedSecret: SHARED_SECRET },
    "responder",
    true,
    { history: [] },
  );
  responder.catch(() => {});
  const initiator = await authenticateConnection(
    tampering,
    { sharedSecret: SHARED_SECRET },
    "initiator",
    true,
    { history: [] },
  );
  await expect(responder).rejects.toThrow("key exchange authentication failed");
  const secure = await EncryptedMessageConnection.create(
    tampering,
    initiator.sessionKey,
    "initiator",
  );
  const err = await secure.receive(1_000).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
});

test("authenticateConnection propagates a failed key exchange as a security-kind ConnectionError", async () => {
  const settled = await authenticateOverPipe(
    SHARED_SECRET,
    OTHER_SHARED_SECRET,
  );
  for (const outcome of settled) {
    expect(outcome.status).toBe("rejected");
    const reason = (outcome as PromiseRejectedResult).reason as unknown;
    // The kind is the trust-boundary marker consumers classify on, and the
    // handshake failure must reach them with it intact rather than re-wrapped as
    // a transport fault.
    expect(reason).toBeInstanceOf(ConnectionError);
    expect((reason as ConnectionError).kind).toBe("security");
  }
});

test("authenticateConnection refuses a malformed secret before touching the connection", async () => {
  const [conn, peer] = createMessagePipe();
  let peerReceived = false;
  void peer.receive().then(
    () => {
      peerReceived = true;
    },
    () => {},
  );

  await expect(
    authenticateConnection(conn, { sharedSecret: "" }, "initiator", false, {
      history: [],
    }),
  ).rejects.toThrow(/base64url-encoded 32-byte value/);
  expect(peerReceived).toBe(false);

  await conn.close();
});
