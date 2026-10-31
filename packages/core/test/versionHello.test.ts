import { describe, expect, test } from "vitest";

import {
  KEX_SUITES,
  computeKexKeys,
  initiatorConfirmTag,
  offeredKexSuites,
  responderConfirmTag,
  runKex,
  supportedVersions,
} from "../src/kex";
import {
  ENVELOPE_VERSION,
  NO_COMMON_VERSION_MESSAGE,
  PROTOCOL_VERSION,
  encodeHello,
  helloPrologue,
  readHello,
  selectVersions,
  type SupportedVersions,
} from "../src/versionHello";
import {
  AuthenticationError,
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../src/errors";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { EncryptedMessageConnection } from "../src/connection/encryptedMessageConnection";
import {
  MESSAGE_ENVELOPE_VERSION,
  envelopeVersionForFrame,
} from "../src/connection/fileSyncFraming";
import { enc, fromBase64Url, toBase64Url } from "../src/utils/crypto";
import { deriveKeyAgreement } from "../src/kex";
import { drawRotationValue, wrapRotationValue } from "../src/nextSecret";
import { authenticateConnection, type AuthResult } from "../src/auth";
import { exchangeTerms } from "../src/protocolSetup";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import { recordingConnection } from "./utils/recordingConnection";

const GENERIC_FAILURE = "key exchange authentication failed";
const PSK = new Uint8Array(32).fill(0x42);
const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const SUITE = String(supportedVersions().kex[0]);

function offer(protocol: number[], envelope = [1]): SupportedVersions {
  return { kex: supportedVersions().kex, protocol, envelope };
}

// A connection that rewrites each frame this side sends with `rewrite`, and
// records every frame either side sent.
function tamperedPipe(
  rewrite: (frame: Record<string, unknown>) => Record<string, unknown>,
): {
  initiatorConn: MessageConnection;
  responderConn: MessageConnection;
  initiatorSent: unknown[];
  responderSent: unknown[];
} {
  const [a, b] = createMessagePipe();
  const initiatorSent: unknown[] = [];
  const responderSent: unknown[] = [];
  const recording = (
    conn: MessageConnection,
    sent: unknown[],
  ): MessageConnection => ({
    send: async (data) => {
      const frame = rewrite(data as Record<string, unknown>);
      sent.push(frame);
      await conn.send(frame);
    },
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
  });
  return {
    initiatorConn: recording(a, initiatorSent),
    responderConn: recording(b, responderSent),
    initiatorSent,
    responderSent,
  };
}

describe("the selection rule", () => {
  test("each layer takes the highest version both offer", () => {
    const local: SupportedVersions = {
      kex: [1, 3, 4],
      protocol: [1, 2, 5],
      envelope: [1, 2],
    };
    const partner: SupportedVersions = {
      kex: [3, 4, 9],
      protocol: [2, 5, 7],
      envelope: [1],
    };
    const selection = selectVersions(local, partner);
    expect(selection).toEqual({
      ok: true,
      negotiated: { kex: 4, protocol: 5, envelope: 1 },
    });
    expect(selectVersions(partner, local)).toEqual(selection);
  });

  test("a layer with no common version is no selection, naming the older side", () => {
    const base = { kex: [3], envelope: [1] };
    expect(
      selectVersions(
        { ...base, protocol: [3, 4] },
        { ...base, protocol: [1, 2] },
      ),
    ).toEqual({ ok: false, olderVersion: "partner" });
    expect(
      selectVersions(
        { ...base, protocol: [1, 2] },
        { ...base, protocol: [3, 4] },
      ),
    ).toEqual({ ok: false, olderVersion: "this-party" });
    expect(
      selectVersions(
        { ...base, protocol: [1, 3] },
        { ...base, protocol: [2, 4] },
      ),
    ).toEqual({ ok: false, olderVersion: "unknown" });
  });

  test("this build offers its one version in each layer", () => {
    expect(supportedVersions()).toEqual({
      kex: KEX_SUITES.map((s) => s.id),
      protocol: [PROTOCOL_VERSION],
      envelope: [1],
    });
  });
});

describe("the FIPS variant offers only approved key-exchange suites", () => {
  const suites = [
    { id: 3, approved: true },
    { id: 4, approved: false },
    { id: 5, approved: true },
  ];

  test("approvedOnly drops every suite that is not approved", () => {
    expect(offeredKexSuites(suites, true)).toEqual([3, 5]);
    expect(offeredKexSuites(suites, false)).toEqual([3, 4, 5]);
  });

  test("the build's offer under approvedKexSuitesOnly is its approved suites", () => {
    expect(supportedVersions({ approvedKexSuitesOnly: true }).kex).toEqual(
      KEX_SUITES.filter((s) => s.approved).map((s) => s.id),
    );
    expect(
      supportedVersions({ approvedKexSuitesOnly: true }).kex.length,
    ).toBeGreaterThan(0);
  });

  test("runKex refuses to offer a suite this build does not implement", async () => {
    const [a] = createMessagePipe();
    await expect(
      runKex(
        a,
        "initiator",
        PSK,
        false,
        { history: [] },
        {
          ...supportedVersions(),
          kex: [99],
        },
      ),
    ).rejects.toBeInstanceOf(InternalConsistencyError);
  });
});

describe("reading a hello", () => {
  const wire = (text: string) => toBase64Url(enc.encode(text));

  test("a member this build does not know is accepted, and the bytes are kept as received", () => {
    const text = '{"kex":[3],"protocol":[1],"envelope":[1],"later":{"x":[1]}}';
    const hello = readHello(wire(text));
    expect(hello?.versions).toEqual({ kex: [3], protocol: [1], envelope: [1] });
    expect(new TextDecoder().decode(hello!.bytes)).toBe(text);
  });

  test.each([
    ["a missing layer", '{"kex":[3],"protocol":[1]}'],
    ["an empty layer", '{"kex":[3],"protocol":[],"envelope":[1]}'],
    ["a non-integer version", '{"kex":[3],"protocol":[1.5],"envelope":[1]}'],
    ["a zero version", '{"kex":[3],"protocol":[0],"envelope":[1]}'],
    ["a non-object", "[1,2,3]"],
    ["text that is not JSON", "kex=3"],
  ])("%s is refused", (_name, text) => {
    expect(readHello(wire(text))).toBeUndefined();
  });

  test("a hello over 1024 bytes is refused", () => {
    const text = `{"kex":[3],"protocol":[1],"envelope":[1],"x":"${"a".repeat(1024)}"}`;
    expect(readHello(wire(text))).toBeUndefined();
  });

  test("the prologue is each hello behind its two-byte length, initiator first", () => {
    const prologue = helloPrologue(Uint8Array.of(7, 8), Uint8Array.of(9));
    expect([...prologue]).toEqual([0, 2, 7, 8, 0, 1, 9]);
  });
});

describe("the hello over a handshake", () => {
  test("both sides return the highest common version per layer", async () => {
    const [a, b] = createMessagePipe();
    const [initiator, responder] = await Promise.all([
      runKex(a, "initiator", PSK, true, { history: [] }, offer([1, 2, 5])),
      runKex(b, "responder", PSK, true, { history: [] }, offer([2, 5, 7])),
    ]);
    expect(initiator.negotiated).toEqual({
      kex: Number(SUITE),
      protocol: 5,
      envelope: 1,
    });
    expect(responder.negotiated).toEqual(initiator.negotiated);
    expect(responder.sessionKey).toEqual(initiator.sessionKey);
  });

  test("no common version stops both sides before the key exchange with the fixed refusal", async () => {
    const { initiatorConn, responderConn, initiatorSent, responderSent } =
      tamperedPipe((frame) => frame);
    const results = await Promise.allSettled([
      runKex(
        initiatorConn,
        "initiator",
        PSK,
        true,
        { history: [] },
        offer([1]),
      ),
      runKex(
        responderConn,
        "responder",
        PSK,
        true,
        { history: [] },
        offer([2]),
      ),
    ]);
    for (const [result, olderVersion] of [
      [results[0], "this-party"],
      [results[1], "partner"],
    ] as const) {
      expect(result.status).toBe("rejected");
      const reason = (result as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(PartnerProtocolRefusalError);
      expect((reason as Error).message).toBe(NO_COMMON_VERSION_MESSAGE);
      expect((reason as PartnerProtocolRefusalError).olderVersion).toBe(
        olderVersion,
      );
    }
    // The responder sends its hello on an abort in place of message 2, and
    // the initiator sends nothing after message 1: no tag, no wrapped value.
    expect(responderSent).toEqual([
      { kexMsg: "abort", hello: toBase64Url(encodeHello(offer([2]))) },
    ]);
    expect(initiatorSent).toHaveLength(1);
    expect(initiatorSent[0]).toMatchObject({ kexMsg: "1" });
  });

  test("the refusal holds nothing the partner authored", () => {
    expect(NO_COMMON_VERSION_MESSAGE).not.toMatch(/\d/);
  });

  test.each([
    ["message 1", "1"],
    ["message 2", "2"],
  ])(
    "a hello stripped from %s fails the handshake with the generic failure",
    async (_name, kexMsg) => {
      const { initiatorConn, responderConn } = tamperedPipe((frame) => {
        if (frame.kexMsg !== kexMsg) return frame;
        const { hello: _hello, ...rest } = frame;
        return rest;
      });
      const results = await Promise.allSettled([
        runKex(initiatorConn, "initiator", PSK, true),
        runKex(responderConn, "responder", PSK, true),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(AuthenticationError);
        expect((reason as Error).message).toBe(GENERIC_FAILURE);
      }
    },
  );

  test.each([
    ["message 1", "1"],
    ["message 2", "2"],
  ])(
    "a hello altered in %s, still selecting the same versions, fails the handshake with the generic failure",
    async (_name, kexMsg) => {
      // An added member the reader does not know: the selection is unchanged,
      // so only the transcript tells the two hellos apart.
      const altered = toBase64Url(
        enc.encode('{"kex":[3],"protocol":[1],"envelope":[1],"added":true}'),
      );
      const { initiatorConn, responderConn } = tamperedPipe((frame) =>
        frame.kexMsg === kexMsg ? { ...frame, hello: altered } : frame,
      );
      const results = await Promise.allSettled([
        runKex(initiatorConn, "initiator", PSK, true),
        runKex(responderConn, "responder", PSK, true),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as unknown;
        expect(reason).toBeInstanceOf(AuthenticationError);
        expect((reason as Error).message).toBe(GENERIC_FAILURE);
      }
    },
  );

  test("a hello with a member this build does not know completes, and the member is bound", async () => {
    // A hand-rolled initiator whose hello holds an unknown member, computing
    // its keys over the hello as it sent it.
    const [a, b] = createMessagePipe();
    const responder = runKex(b, "responder", PSK, true);
    const helloBytes = enc.encode(
      '{"kex":[3],"protocol":[1],"envelope":[1],"later":{"x":1}}',
    );
    const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
      "deriveKey",
    ]);
    const share = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    await a.send({
      kexMsg: "1",
      hello: toBase64Url(helloBytes),
      e: { [SUITE]: toBase64Url(share) },
      reqEnc: true,
    });
    const msg2 = (await a.receive()) as {
      hello: string;
      e: string;
      confirm: string;
      reqEnc: boolean;
    };
    const responderShare = fromBase64Url(msg2.e);
    const blocks = await deriveKeyAgreement(
      pair.privateKey,
      await crypto.subtle.importKey(
        "raw",
        responderShare,
        ECDH_P256,
        false,
        [],
      ),
      share,
      responderShare,
    );
    const keysOver = (initiatorHello: Uint8Array<ArrayBuffer>) =>
      computeKexKeys(
        PSK,
        helloPrologue(initiatorHello, fromBase64Url(msg2.hello)),
        share,
        responderShare,
        blocks!.ee,
        true,
        msg2.reqEnc,
      );
    const keys = await keysOver(helloBytes);
    // The responder's tag verifies over the hello as sent, unknown member
    // included, and not over the same hello without it.
    expect(
      toBase64Url(
        await responderConfirmTag(keys.confirmKey, keys.handshakeHash, false),
      ),
    ).toBe(msg2.confirm);
    const withoutMember = await keysOver(
      enc.encode('{"kex":[3],"protocol":[1],"envelope":[1]}'),
    );
    expect(
      toBase64Url(
        await responderConfirmTag(
          withoutMember.confirmKey,
          withoutMember.handshakeHash,
          false,
        ),
      ),
    ).not.toBe(msg2.confirm);
    const wrapped = await wrapRotationValue(
      keys.sessionKey,
      "initiator",
      await drawRotationValue(),
    );
    await a.send({
      kexMsg: "3",
      confirm: toBase64Url(
        await initiatorConfirmTag(
          keys.confirmKey,
          keys.handshakeHash,
          false,
          wrapped,
        ),
      ),
      initiatorValue: toBase64Url(wrapped),
      usedPrevious: false,
    });
    const result = await responder;
    expect(result.sessionKey).toEqual(keys.sessionKey);
  });

  test("message 1 must hold one share per offered suite and no other", async () => {
    const [a, b] = createMessagePipe();
    const responder = runKex(b, "responder", PSK, true);
    responder.catch(() => {});
    const pair = await crypto.subtle.generateKey(ECDH_P256, true, [
      "deriveKey",
    ]);
    const share = toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
    await a.send({
      kexMsg: "1",
      hello: toBase64Url(encodeHello(supportedVersions())),
      e: { [SUITE]: share, "4": share },
      reqEnc: true,
    });
    const err = await responder.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(await a.receive()).toEqual({ kexMsg: "abort" });
  });
});

describe("the negotiated envelope version", () => {
  test("a party's first file-sync frame is version 1 whatever was negotiated, and later frames the negotiated one", () => {
    expect(MESSAGE_ENVELOPE_VERSION).toBe(1);
    expect(envelopeVersionForFrame(true, 7)).toBe(1);
    expect(envelopeVersionForFrame(false, 7)).toBe(7);
    expect(envelopeVersionForFrame(false, undefined)).toBe(1);
  });

  test("this build offers envelope version 1 only, the version a party aborts at before it has negotiated", () => {
    for (const approvedKexSuitesOnly of [false, true])
      expect(
        supportedVersions({ approvedKexSuitesOnly }).envelope,
        "This build offers an envelope version other than 1. A party that " +
          "aborts before it has negotiated sends that abort at envelope " +
          "version 1, so its partner reports the abort as an incompatible " +
          "version rather than the generic failure (docs/spec/FILE_SYNC.md, " +
          "Message body format). Settle the pre-negotiation abort before a " +
          "second envelope version ships.",
      ).toEqual([MESSAGE_ENVELOPE_VERSION]);
  });
});

describe("an authenticated run takes the negotiated versions from its authentication result", () => {
  const SECRET = toBase64Url(PSK);
  const offerBoth: SupportedVersions = {
    kex: supportedVersions().kex,
    protocol: [PROTOCOL_VERSION, PROTOCOL_VERSION + 1],
    envelope: [ENVELOPE_VERSION, ENVELOPE_VERSION + 1],
  };

  async function authenticatedPair() {
    const [a, b] = createMessagePipe();
    const [initiator, responder] = await Promise.all([
      authenticateConnection(
        a,
        { sharedSecret: SECRET },
        "initiator",
        true,
        { history: [] },
        offerBoth,
      ),
      authenticateConnection(
        b,
        { sharedSecret: SECRET },
        "responder",
        true,
        { history: [] },
        offerBoth,
      ),
    ]);
    return { a, b, initiator, responder };
  }

  test("the terms exchange states and checks the protocol version the result names", async () => {
    const { a, b, initiator, responder } = await authenticatedPair();
    expect(initiator.negotiated.protocol).toBe(PROTOCOL_VERSION + 1);
    const { conn: recordingA, sent: initiatorSent } = recordingConnection(a);
    const { conn: recordingB, sent: responderSent } = recordingConnection(b);
    const terms = (identity: string): LinkageTerms => ({
      version: "1.0.0",
      identity,
      date: "2025-01-01",
      algorithm: "psi",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields: [{ name: "ssn", type: "ssn" }],
      linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    });
    const run = (
      conn: MessageConnection,
      role: "initiator" | "responder",
      auth: AuthResult,
    ) =>
      exchangeTerms(
        conn,
        role,
        terms(role),
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { inputs: auth.nextSecretInputs, store: () => {} },
      );
    await Promise.all([
      run(recordingA, "initiator", initiator),
      run(recordingB, "responder", responder),
    ]);
    expect(initiatorSent[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    expect(responderSent[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION + 1,
    });
  });

  test("the encrypted connection keys the channel at the envelope version the result names", async () => {
    const { a, initiator } = await authenticatedPair();
    expect(initiator.negotiated.envelope).toBe(ENVELOPE_VERSION + 1);
    // This build implements only its own envelope version, so the guard
    // naming the result's version shows the connection read it.
    const refused = await EncryptedMessageConnection.create(
      a,
      initiator,
      "initiator",
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InternalConsistencyError);
    expect((refused as Error).message).toContain(
      `envelope version ${ENVELOPE_VERSION + 1}`,
    );
  });
});
