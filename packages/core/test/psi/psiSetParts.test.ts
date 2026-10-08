import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_WEBRTC_FRAME_BYTES } from "../../src/connection/binaryPackBounds";
import {
  AEAD_ENVELOPE_OVERHEAD_BYTES,
  EncryptedMessageConnection,
} from "../../src/connection/encryptedMessageConnection";
import { fileSyncMessageFileBytes } from "../../src/connection/fileSyncOutboundBound";
import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
} from "../../src/connection/frameSize";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  binaryPackByteStringLength,
  webrtcFrameExceedsBound,
} from "../../src/connection/webrtcOutboundBound";
import {
  PeerAbortError,
  ProtocolRefusalError,
  RoundCapacityError,
  RoundSetLimitError,
} from "../../src/errors";
import { sendAbort } from "../../src/protocolSetup";
import {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
} from "../../src/partnerAbortFrame";
import { PSIParticipant } from "../../src/psi/participant";
import { serializeSetup } from "../../src/psi/psiChunks";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  ownSetOverPartnerCeilingMessage,
  ownSetTooLargeMessage,
  partnerSetOverCeilingMessage,
  PSI_SET_PART_HEADER_BYTES,
  psiSetByteBound,
  psiSetPartPayloadBytes,
  psiSetParts,
  receivePsiSet,
  sendPsiSet,
} from "../../src/psi/psiSetParts";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";
import type { PsiElementBounds } from "../../src/connection/frameSize";

const psiLibrary = await PSI();

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

afterEach(() => {
  vi.restoreAllMocks();
});

function bytes(count: number): Uint8Array {
  return Uint8Array.from({ length: count }, (_unused, i) => (i * 7) % 256);
}

/** `conn` stating the given partner bounds. */
function withBounds(
  conn: MessageConnection,
  bounds: { webRtc?: number; fileSync?: number },
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
    outboundWebRtcFrameBound: () => bounds.webRtc,
    outboundFileSyncFrameBound: () => bounds.fileSync,
  };
}

/** Receives on `b` after sending `frames` on `a`, one pipe per call. */
async function receiveAfter(
  frames: Array<unknown>,
  maxSetBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const [a, b] = createMessagePipe();
  for (const frame of frames) await a.send(frame);
  return receivePsiSet(b, "client", "serverSetup", maxSetBytes);
}

function partsOf(set: Uint8Array, payloadBytes: number): Array<Uint8Array> {
  return [...psiSetParts(set, payloadBytes)];
}

test("a set joins back from its parts in order, at every split", async () => {
  for (const [size, payloadBytes] of [
    [0, 10],
    [1, 10],
    [10, 10],
    [11, 10],
    [95, 10],
    [95, 1],
  ]) {
    const set = bytes(size);
    const parts = partsOf(set, payloadBytes);
    expect(parts).toHaveLength(Math.max(1, Math.ceil(size / payloadBytes)));
    for (const part of parts)
      expect(part.byteLength).toBeLessThanOrEqual(
        PSI_SET_PART_HEADER_BYTES + payloadBytes,
      );
    expect(await receiveAfter(parts)).toEqual(set);
  }
});

test("every part's header states its index, the part count, and the set's length", () => {
  const parts = partsOf(bytes(25), 10);
  parts.forEach((part, index) => {
    const header = new DataView(part.buffer, 0, PSI_SET_PART_HEADER_BYTES);
    expect(header.getUint32(0)).toBe(index);
    expect(header.getUint32(4)).toBe(3);
    expect(header.getBigUint64(8)).toBe(25n);
  });
});

test("a missing part is refused", async () => {
  const [first, , third] = partsOf(bytes(25), 10);
  await expect(receiveAfter([first, third])).rejects.toThrow(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup is missing part 1",
    ),
  );
  await expect(receiveAfter([third])).rejects.toThrow(/is missing part 0/);
});

test("a repeated part is refused", async () => {
  const [first, second] = partsOf(bytes(25), 10);
  await expect(receiveAfter([first, second, second])).rejects.toThrow(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup repeats part 1",
    ),
  );
  await expect(receiveAfter([first, first])).rejects.toThrow(/repeats part 0/);
});

test("a set declaring more bytes than the bound admits is refused at its first part", async () => {
  const parts = partsOf(bytes(25), 10);
  // Only the first part is queued: a receiver that read on would wait forever.
  await expect(receiveAfter(parts.slice(0, 1), 24)).rejects.toThrow(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup declares 25 bytes, " +
        "over the 24 the agreed record counts admit",
    ),
  );
  expect(await receiveAfter(parts, 25)).toEqual(bytes(25));

  // A length no buffer could hold is refused by the bound, where allocating
  // it would have thrown a RangeError instead.
  const huge = partsOf(bytes(25), 10)[0];
  new DataView(huge.buffer).setBigUint64(8, 2n ** 62n);
  await expect(receiveAfter([huge], psiSetByteBound(10))).rejects.toThrow(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup declares " +
        "4611686018427387904 bytes, over the 356 the agreed record counts admit",
    ),
  );
});

test("a set within the bound but over this party's capacity is refused at its first part as its capacity, and the partner told", async () => {
  const parts = partsOf(bytes(25), 10);
  const [a, b] = createMessagePipe();
  // Only the first part is queued: a receiver that read on would wait forever.
  await a.send(parts[0]);
  const refusal = await receivePsiSet(b, "client", "serverSetup", 25, {
    setBytes: 24,
    elements: 3,
  }).catch((err: unknown) => err);
  expect(refusal).toBeInstanceOf(RoundCapacityError);
  expect((refusal as RoundCapacityError).stage).toBe("set-first-part");
  expect((refusal as Error).message).toBe(partnerSetOverCeilingMessage(3));
  expect(await a.receive()).toEqual({
    decision: "abort",
    abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
  });

  const [c, d] = createMessagePipe();
  for (const part of parts) await c.send(part);
  expect(
    await receivePsiSet(d, "client", "serverSetup", 25, {
      setBytes: 25,
      elements: 3,
    }),
  ).toEqual(bytes(25));
});

test("a set over the bound is refused as a protocol error even when it is also over this party's capacity", async () => {
  const [a, b] = createMessagePipe();
  await a.send(partsOf(bytes(25), 10)[0]);
  const refusal = await receivePsiSet(b, "client", "serverSetup", 24, {
    setBytes: 20,
    elements: 3,
  }).catch((err: unknown) => err);
  expect(refusal).toEqual(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup declares 25 bytes, " +
        "over the 24 the agreed record counts admit",
    ),
  );
  await b.close();
  await expect(a.receive()).rejects.toThrow("peer closed the connection");
});

test("an abort in place of any part ends the receive as the partner's abort", async () => {
  const parts = partsOf(bytes(25), 10);
  for (let k = 0; k < parts.length; k++) {
    const [a, b] = createMessagePipe();
    for (const part of parts.slice(0, k)) await a.send(part);
    await sendAbort(a, ["a reason"]);
    await expect(
      receivePsiSet(b, "client", "serverSetup", 25),
    ).rejects.toBeInstanceOf(PeerAbortError);
  }
});

test("a part that disagrees with the set's framing is refused", async () => {
  const [first, second, third] = partsOf(bytes(25), 10);

  const recounted = second.slice();
  new DataView(recounted.buffer).setUint32(4, 4);
  await expect(receiveAfter([first, recounted])).rejects.toThrow(
    /part 1 declares a different set than part 0/,
  );

  const relengthed = second.slice();
  new DataView(relengthed.buffer).setBigUint64(8, 26n);
  await expect(receiveAfter([first, relengthed])).rejects.toThrow(
    /part 1 declares a different set than part 0/,
  );

  const overlong = new Uint8Array(third.byteLength + 1);
  overlong.set(third);
  await expect(receiveAfter([first, second, overlong])).rejects.toThrow(
    /part 2 runs past the set's declared length/,
  );

  await expect(
    receiveAfter([first, second, third.subarray(0, third.byteLength - 1)]),
  ).rejects.toThrow(/ends short of the set's declared length/);

  await expect(receiveAfter([first.subarray(0, 15)])).rejects.toThrow(
    /part 0 is shorter than its header/,
  );

  const tooManyParts = partsOf(bytes(2), 10)[0];
  new DataView(tooManyParts.buffer).setUint32(4, 3);
  await expect(receiveAfter([tooManyParts])).rejects.toThrow(
    /declares 3 parts for a set of 2 bytes/,
  );

  const noParts = partsOf(bytes(2), 10)[0];
  new DataView(noParts.buffer).setUint32(4, 0);
  await expect(receiveAfter([noParts])).rejects.toThrow(
    /declares 0 parts for a set of 2 bytes/,
  );
});

test("a part with no set bytes is refused unless it is an empty set's only part", async () => {
  const parts = partsOf(bytes(25), 10);
  const headerOnly = parts[0].slice(0, PSI_SET_PART_HEADER_BYTES);
  const [a, b] = createMessagePipe();
  for (const frame of [headerOnly, ...parts]) await a.send(frame);
  const receive = vi.spyOn(b, "receive");
  await expect(receivePsiSet(b, "client", "serverSetup", 25)).rejects.toThrow(
    new ProtocolRefusalError(
      "client protocol error: inbound PSI serverSetup part 0 holds no set bytes",
    ),
  );
  expect(receive).toHaveBeenCalledTimes(1);

  const emptyLast = parts[2].slice(0, PSI_SET_PART_HEADER_BYTES);
  await expect(receiveAfter([parts[0], parts[1], emptyLast])).rejects.toThrow(
    /part 2 holds no set bytes/,
  );

  expect(await receiveAfter(partsOf(bytes(0), 10))).toEqual(new Uint8Array(0));
});

test("a part fills the transport's bound to the byte", () => {
  const [raw] = createMessagePipe();
  for (const envelope of [0, AEAD_ENVELOPE_OVERHEAD_BYTES]) {
    const overhead = PSI_SET_PART_HEADER_BYTES + envelope;
    const conn = (bounds: { webRtc?: number; fileSync?: number }) => ({
      ...withBounds(raw, bounds),
      outboundFrameOverheadBytes: () => envelope,
    });

    for (const webRtc of [4096, 70_000, MAX_WEBRTC_FRAME_BYTES]) {
      const payload = psiSetPartPayloadBytes(conn({ webRtc }));
      const fits = (p: number) =>
        !webrtcFrameExceedsBound(
          binaryPackByteStringLength(p + overhead),
          webRtc,
        );
      expect(fits(payload)).toBe(true);
      expect(fits(payload + 1)).toBe(false);
    }

    for (const fileSync of [4096, MAX_FRAME_SIZE_BYTES]) {
      const payload = psiSetPartPayloadBytes(conn({ fileSync }));
      expect(
        fileSyncMessageFileBytes(payload + PSI_SET_PART_HEADER_BYTES, envelope),
      ).toBe(fileSync);
    }

    expect(psiSetPartPayloadBytes(conn({ webRtc: 4096, fileSync: 2000 }))).toBe(
      psiSetPartPayloadBytes(conn({ fileSync: 2000 })),
    );
    expect(psiSetPartPayloadBytes(conn({}))).toBe(
      MAX_FRAME_SIZE_BYTES - overhead,
    );
  }
  expect(() =>
    psiSetPartPayloadBytes(withBounds(raw, { fileSync: 26 })),
  ).toThrow(/leaves no room for a PSI set part/);
});

test("at the real bounds, the largest set the decode admits goes in two message files or three WebRTC messages", () => {
  const [raw] = createMessagePipe();
  const largestSet = psiSetByteBound(Number.POSITIVE_INFINITY);
  expect(largestSet).toBe(MAX_PSI_DECODE_ELEMENTS * 35 + 6);

  const fileSync = psiSetPartPayloadBytes({
    ...withBounds(raw, { fileSync: MAX_FRAME_SIZE_BYTES }),
    outboundFrameOverheadBytes: () => AEAD_ENVELOPE_OVERHEAD_BYTES,
  });
  expect(fileSync).toBe(536_870_832);
  expect(Math.ceil(largestSet / fileSync)).toBe(2);

  const webRtc = psiSetPartPayloadBytes(
    withBounds(raw, { webRtc: MAX_WEBRTC_FRAME_BYTES }),
  );
  expect(webRtc).toBe(267_532_665);
  expect(Math.ceil(largestSet / webRtc)).toBe(3);
});

function values(count: number, prefix: string): Array<string> {
  return Array.from({ length: count }, (_unused, i) => `${prefix}-${i}`);
}

type Bounds = { webRtc?: number; fileSync?: number };

/**
 * One round between a starter holding `starterSet` and a joiner holding
 * `joinerSet`, over AEAD-wrapped connections stating `bounds`, recording every
 * frame each side sends. Resolves to each side's table, pairs sorted.
 */
async function round(
  starterSet: Array<string>,
  joinerSet: Array<string>,
  bounds: Bounds,
  countOnly = false,
): Promise<{ starter: unknown; joiner: unknown; sent: Array<unknown> }> {
  const [rawA, rawB] = createMessagePipe();
  const sent: Array<unknown> = [];
  // Recorded above the envelope, where each frame is what a round sent.
  const recording = (conn: EncryptedMessageConnection): MessageConnection => ({
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
    outboundWebRtcFrameBound: () => conn.outboundWebRtcFrameBound(),
    outboundFileSyncFrameBound: () => conn.outboundFileSyncFrameBound(),
    outboundFrameOverheadBytes: () => conn.outboundFrameOverheadBytes(),
  });
  const [a, b] = (
    await Promise.all([
      EncryptedMessageConnection.create(
        withBounds(rawA, bounds),
        SESSION_KEY,
        "initiator",
      ),
      EncryptedMessageConnection.create(
        withBounds(rawB, bounds),
        SESSION_KEY,
        "responder",
      ),
    ])
  ).map(recording);
  const mode = countOnly ? "count-only" : "identifier-revealing";
  const participant = (role: "starter" | "joiner") =>
    new PSIParticipant(
      role === "starter" ? "server" : "client",
      psiLibrary,
      { role, verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      new InProcessPsiEngine(
        psiLibrary,
        role,
        role === "starter" ? "server" : "client",
        mode,
      ),
    );
  const starter = participant("starter");
  const joiner = participant("joiner");
  const run = (
    p: PSIParticipant,
    conn: MessageConnection,
    set: Array<string>,
  ) =>
    countOnly
      ? p.countIntersection(conn, set)
      : p
          .identifyIntersection(conn, set)
          .then(([local, partner]) =>
            local.map((l, i) => [l, partner[i]]).sort((x, y) => x[0] - y[0]),
          );
  const [starterEnd, joinerEnd] = await Promise.all([
    run(starter, a, starterSet),
    run(joiner, b, joinerSet),
  ]);
  await a.close();
  await b.close();
  starter.dispose();
  joiner.dispose();
  return { starter: starterEnd, joiner: joinerEnd, sent };
}

/** The sent binary frames, the PSI set parts among them. */
function binaryFrames(sent: Array<unknown>): Array<Uint8Array> {
  return sent.filter(
    (frame): frame is Uint8Array => frame instanceof Uint8Array,
  );
}

test.each([
  ["a WebRTC message", { webRtc: 2048 }],
  ["a message file", { fileSync: 2048 }],
])(
  "a round whose sets exceed %s sends them in parts and matches as one-part sets do",
  async (_label, bounds: Bounds) => {
    const starterSet = values(300, "v");
    const joinerSet = [...values(150, "v"), ...values(150, "w")];
    const whole = await round(starterSet, joinerSet, {});
    const parted = await round(starterSet, joinerSet, bounds);

    expect(parted.starter).toEqual(whole.starter);
    expect(parted.joiner).toEqual(whole.joiner);
    expect((parted.starter as Array<unknown>).length).toBe(150);
    // Three sets of about 10 KiB in parts of about 2 KiB, every frame within
    // the bound once the envelope is added.
    expect(binaryFrames(whole.sent)).toHaveLength(3);
    expect(binaryFrames(parted.sent).length).toBeGreaterThan(15);
    for (const frame of binaryFrames(parted.sent)) {
      const envelope = AEAD_ENVELOPE_OVERHEAD_BYTES;
      if (bounds.webRtc !== undefined)
        expect(
          webrtcFrameExceedsBound(
            binaryPackByteStringLength(frame.byteLength + envelope),
            bounds.webRtc,
          ),
        ).toBe(false);
      else
        expect(
          fileSyncMessageFileBytes(frame.byteLength, envelope),
        ).toBeLessThanOrEqual(bounds.fileSync!);
    }

    const counted = await round(starterSet, joinerSet, bounds, true);
    expect(counted).toMatchObject({ starter: undefined, joiner: 150 });
  },
);

/** A joiner bounded by `elementBounds`, parked on a setup fed by `feed`. */
async function joinerFed(
  elementBounds: PsiElementBounds,
  feed: (starter: MessageConnection) => Promise<void>,
): Promise<unknown> {
  const [a, b] = createMessagePipe();
  const joiner = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    elementBounds,
  );
  const ended = joiner.identifyIntersection(b, values(3, "j")).then(
    () => "completed",
    (err: unknown) => err,
  );
  await feed(a);
  const outcome = await ended;
  joiner.dispose();
  await a.close();
  return outcome;
}

test("a round ends on an abort in place of a setup part before the setup completes", async () => {
  const pieces = vi.spyOn(
    InProcessPsiEngine.prototype,
    "receiveServerSetupPiece",
  );
  const complete = vi.spyOn(
    InProcessPsiEngine.prototype,
    "completeServerSetup",
  );
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(values(100, "s"));
  engine.dispose();
  const parts = partsOf(setup, 1000);
  expect(parts.length).toBeGreaterThan(2);

  const ended = await joinerFed(UNBOUNDED_PSI_ELEMENTS, async (starter) => {
    await starter.send(parts[0]);
    await starter.send(parts[1]);
    await sendAbort(starter, ["a reason"]);
  });
  expect(ended).toBeInstanceOf(PeerAbortError);
  // Each part reaches the engine as it arrives; the setup never completes.
  expect(pieces).toHaveBeenCalledTimes(2);
  expect(complete).not.toHaveBeenCalled();
});

test("a round refuses a setup out of ascending order at the part that shows it, before reading the rest or sending its request", async () => {
  const request = vi.spyOn(InProcessPsiEngine.prototype, "createClientRequest");
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(values(100, "s"));
  engine.dispose();
  const elements = [
    ...psiLibrary.serverSetup
      .deserializeBinary(setup)
      .getRaw()!
      .getEncryptedElementsList_asU8(),
  ];
  [elements[10], elements[11]] = [elements[11]!, elements[10]!];
  const parts = partsOf(serializeSetup(psiLibrary, elements), 1000);
  expect(parts.length).toBeGreaterThan(2);

  // Only the first part is sent: the elements it swaps lie inside it.
  const ended = await joinerFed(UNBOUNDED_PSI_ELEMENTS, (starter) =>
    starter.send(parts[0]),
  );
  expect((ended as Error).message).toBe(
    "client protocol error: PSI server setup is not in strictly ascending element order",
  );
  expect(request).not.toHaveBeenCalled();
});

test("a round refuses a setup at the part whose elements pass the bound, before that part reaches the engine", async () => {
  const pieces = vi.spyOn(
    InProcessPsiEngine.prototype,
    "receiveServerSetupPiece",
  );
  // Fifty ascending one-byte elements under a Raw data structure, 3 bytes
  // each: inside the byte bound for 40 elements but over its element count,
  // with no more than 40 in the first part.
  const setup = serializeSetup(
    psiLibrary,
    Array.from({ length: 50 }, (_, index) => Uint8Array.of(index)),
  );
  expect(setup.byteLength).toBeLessThanOrEqual(psiSetByteBound(40));
  const parts = partsOf(setup, 100);
  expect(parts).toHaveLength(2);

  const ended = await joinerFed(
    { ...UNBOUNDED_PSI_ELEMENTS, setup: 40 },
    async (starter) => {
      for (const part of parts) await starter.send(part);
    },
  );
  expect(ended).toBeInstanceOf(ProtocolRefusalError);
  expect((ended as Error).message).toBe(
    "client protocol error: inbound PSI serverSetup declares more than 40 " +
      "encrypted element(s)",
  );
  expect(pieces).toHaveBeenCalledTimes(1);
});

test.each([
  ["an abort in place of its next part", "abort"],
  ["its next part passing the element bound", "over-bound"],
] as const)(
  "a setup refused at %s after a part reached the engine leaves no live partial match",
  async (_label, refusal) => {
    const matches = { created: 0, deleted: 0 };
    const clients = psiLibrary.client!;
    const counting: typeof psiLibrary = {
      ...psiLibrary,
      client: {
        ...clients,
        createWithNewKey: (reveal) => {
          const client = clients.createWithNewKey(reveal);
          return {
            ...client,
            createMatch: () => {
              const match = client.createMatch();
              matches.created += 1;
              return {
                ...match,
                delete: () => {
                  matches.deleted += 1;
                  match.delete();
                },
              };
            },
          };
        },
      },
    };
    const setup = serializeSetup(
      psiLibrary,
      Array.from({ length: 50 }, (_, index) => Uint8Array.of(index)),
    );
    const parts = partsOf(setup, 100);
    expect(parts).toHaveLength(2);
    const [a, b] = createMessagePipe();
    const joiner = new PSIParticipant(
      "client",
      counting,
      { role: "joiner", verbose: -1 },
      { ...UNBOUNDED_PSI_ELEMENTS, setup: 40 },
    );
    const ended = joiner.identifyIntersection(b, values(3, "j")).then(
      () => "completed",
      (err: unknown) => err,
    );
    await a.send(parts[0]);
    if (refusal === "abort") await sendAbort(a, ["a reason"]);
    else await a.send(parts[1]);
    const outcome = await ended;
    const liveAtRefusal = matches.created - matches.deleted;
    joiner.dispose();
    await a.close();

    expect(outcome).toBeInstanceOf(
      refusal === "abort" ? PeerAbortError : ProtocolRefusalError,
    );
    expect(matches.created).toBe(1);
    expect(liveAtRefusal).toBe(0);
    expect(matches.deleted).toBe(1);
  },
);

test("a round refuses a setup longer than the partner's record counts admit", async () => {
  const decode = vi.spyOn(
    InProcessPsiEngine.prototype,
    "receiveServerSetupPiece",
  );
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(values(10, "s"));
  engine.dispose();
  const bounds = { ...UNBOUNDED_PSI_ELEMENTS, setup: 9 };

  const ended = await joinerFed(bounds, (starter) =>
    sendPsiSet(starter, setup),
  );
  expect(ended).toBeInstanceOf(ProtocolRefusalError);
  expect((ended as Error).message).toBe(
    `client protocol error: inbound PSI serverSetup declares ` +
      `${setup.byteLength} bytes, over the ${psiSetByteBound(9)} the agreed ` +
      "record counts admit",
  );
  expect(decode).not.toHaveBeenCalled();

  // At the count the setup holds, the same set is admitted.
  expect(setup.byteLength).toBeLessThanOrEqual(psiSetByteBound(10));
});

/** `conn` stating `ceiling` as its ceiling on a partner's set. */
// This party's receive ceiling `local`, with the partner's at the protocol's
// maximum.
const localCeiling = (local: number) => ({
  local,
  partner: MAX_PSI_DECODE_ELEMENTS,
});

// A joiner held to `ceiling` and the setup element bound `setupBound`, fed
// only the first of several parts of a 10-value setup: a receiver that
// allocated the joined set and read on would wait forever. Returns how the
// joiner's round ended and the first frame it sent.
async function joinerFedFirstSetupPart(
  setupBound: number,
  ceiling: number,
): Promise<{ outcome: unknown; firstSent: unknown }> {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(values(10, "s"));
  engine.dispose();
  expect(setup.byteLength).toBeGreaterThan(psiSetByteBound(9));
  expect(setup.byteLength).toBeLessThanOrEqual(psiSetByteBound(10));
  const [a, b] = createMessagePipe();
  const joiner = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    { ...UNBOUNDED_PSI_ELEMENTS, setup: setupBound },
    undefined,
    undefined,
    localCeiling(ceiling),
  );
  const ended = joiner.identifyIntersection(b, values(3, "j")).then(
    () => "completed",
    (err: unknown) => err,
  );
  await a.send(partsOf(setup, 100)[0]);
  const outcome = await ended;
  joiner.dispose();
  // The joiner sends any abort before its round ends, so a short wait
  // finds it queued.
  const firstSent = await a.receive(50).catch((err: unknown) => err);
  await a.close();
  return { outcome, firstSent };
}

test("a round refuses a partner's setup within the record counts but over this party's receive ceiling at its first part, as this party's capacity", async () => {
  const decode = vi.spyOn(
    InProcessPsiEngine.prototype,
    "receiveServerSetupPiece",
  );
  const { outcome, firstSent } = await joinerFedFirstSetupPart(10, 9);
  expect(outcome).toBeInstanceOf(RoundCapacityError);
  expect((outcome as RoundCapacityError).stage).toBe("set-first-part");
  expect((outcome as Error).message).toBe(partnerSetOverCeilingMessage(9));
  expect(firstSent).toEqual({
    decision: "abort",
    abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
  });
  expect(decode).not.toHaveBeenCalled();
});

test("a round refuses a partner's setup over the record counts as a protocol error, whatever this party's receive ceiling", async () => {
  const decode = vi.spyOn(
    InProcessPsiEngine.prototype,
    "receiveServerSetupPiece",
  );
  for (const ceiling of [5, 9, 20]) {
    const { outcome, firstSent } = await joinerFedFirstSetupPart(9, ceiling);
    expect(outcome).toBeInstanceOf(ProtocolRefusalError);
    expect((outcome as Error).message).toMatch(
      new RegExp(
        `inbound PSI serverSetup declares \\d+ bytes, over the ` +
          `${psiSetByteBound(9)} the agreed record counts admit$`,
      ),
    );
    expect(firstSent).not.toEqual(
      expect.objectContaining({ decision: "abort" }),
    );
  }
  expect(decode).not.toHaveBeenCalled();
});

test.each([
  ["a starter holds the partner's request to it", "starter", 1, 3, "starter"],
  ["a joiner holds the partner's setup to it", "joiner", 3, 1, "joiner"],
  ["a joiner's own response is not held to it", "joiner", 1, 3, undefined],
] as const)(
  "this party's receive ceiling on a partner's set: %s",
  async (_name, ceilingRole, starterValues, joinerValues, refusedRole) => {
    const ceiling = 2;
    const [a, b] = createMessagePipe();
    const participant = (role: "starter" | "joiner") =>
      new PSIParticipant(
        role === "starter" ? "server" : "client",
        psiLibrary,
        { role, verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
        undefined,
        undefined,
        role === ceilingRole ? localCeiling(ceiling) : undefined,
      );
    const starter = participant("starter");
    const joiner = participant("joiner");
    const run = (
      p: PSIParticipant,
      conn: MessageConnection,
      set: Array<string>,
    ): Promise<unknown> =>
      p.identifyIntersection(conn, set).then(
        () => "completed",
        (err: unknown) => err,
      );
    const ends = {
      starter: run(starter, a, values(starterValues, "s")),
      joiner: run(joiner, b, values(joinerValues, "j")),
    };
    if (refusedRole === undefined) {
      expect(await Promise.all([ends.starter, ends.joiner])).toEqual([
        "completed",
        "completed",
      ]);
    } else {
      const refusal = await ends[refusedRole];
      expect(refusal).toBeInstanceOf(RoundCapacityError);
      expect((refusal as Error).message).toBe(
        partnerSetOverCeilingMessage(ceiling),
      );
    }
    // The refusing side sends nothing more, so its partner is released by
    // the close.
    await Promise.all([a.close(), b.close()]);
    await Promise.all([ends.starter, ends.joiner]);
    starter.dispose();
    joiner.dispose();
  },
);

test.each([
  ["starter", false],
  ["starter", true],
  ["joiner", false],
  ["joiner", true],
] as const)(
  "a %s whose own set is one value over the decode cap refuses it before sending any part (count-only: %s)",
  async (overRole, countOnly) => {
    const build = [
      vi.spyOn(InProcessPsiEngine.prototype, "createServerSetup"),
      vi.spyOn(InProcessPsiEngine.prototype, "createClientRequest"),
    ];
    const [a, b] = createMessagePipe();
    const sent: Array<unknown> = [];
    const overConn: MessageConnection = {
      send: (data) => {
        sent.push(data);
        return a.send(data);
      },
      receive: (timeoutMs) => a.receive(timeoutMs),
      close: () => a.close(),
    };
    const partnerRole = overRole === "starter" ? "joiner" : "starter";
    const mode = countOnly ? "count-only" : "identifier-revealing";
    const participant = (role: "starter" | "joiner") =>
      new PSIParticipant(
        role === "starter" ? "server" : "client",
        psiLibrary,
        { role, verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
        new InProcessPsiEngine(
          psiLibrary,
          role,
          role === "starter" ? "server" : "client",
          mode,
        ),
      );
    const over = participant(overRole);
    const partner = participant(partnerRole);
    const run = (
      p: PSIParticipant,
      conn: MessageConnection,
      set: Array<string>,
    ): Promise<unknown> =>
      (countOnly
        ? p.countIntersection(conn, set)
        : p.identifyIntersection(conn, set)
      ).then(
        () => "completed",
        (err: unknown) => err,
      );
    // Sparse: the check reads only the count, so no value is materialized.
    const overSet = new Array<string>(MAX_PSI_DECODE_ELEMENTS + 1);
    const [overEnd, partnerEnd] = await Promise.all([
      run(over, overConn, overSet),
      run(partner, b, values(3, "p")),
    ]);
    over.dispose();
    partner.dispose();
    await a.close();

    expect(overEnd).toBeInstanceOf(RoundSetLimitError);
    expect((overEnd as RoundSetLimitError).reason).toBe("over-set-maximum");
    expect((overEnd as Error).message).toBe(
      ownSetTooLargeMessage(MAX_PSI_DECODE_ELEMENTS + 1),
    );
    expect(sent).toEqual([
      { decision: "abort", abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON] },
    ]);
    expect(partnerEnd).toBeInstanceOf(PeerAbortError);
    for (const spy of build)
      for (const [built] of spy.mock.calls)
        expect(built.length).toBeLessThanOrEqual(MAX_PSI_DECODE_ELEMENTS);
  },
);

test.each([
  ["starter", false],
  ["starter", true],
  ["joiner", false],
  ["joiner", true],
] as const)(
  "a %s whose own set is over the partner's stated ceiling refuses it before building it (count-only: %s)",
  async (overRole, countOnly) => {
    const build = [
      vi.spyOn(InProcessPsiEngine.prototype, "createServerSetup"),
      vi.spyOn(InProcessPsiEngine.prototype, "createClientRequest"),
    ];
    const [a, b] = createMessagePipe();
    const sent: Array<unknown> = [];
    const overConn: MessageConnection = {
      send: (data) => {
        sent.push(data);
        return a.send(data);
      },
      receive: (timeoutMs) => a.receive(timeoutMs),
      close: () => a.close(),
    };
    const partnerRole = overRole === "starter" ? "joiner" : "starter";
    const mode = countOnly ? "count-only" : "identifier-revealing";
    const participant = (role: "starter" | "joiner") =>
      new PSIParticipant(
        role === "starter" ? "server" : "client",
        psiLibrary,
        { role, verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
        new InProcessPsiEngine(
          psiLibrary,
          role,
          role === "starter" ? "server" : "client",
          mode,
        ),
        undefined,
        role === overRole
          ? { local: MAX_PSI_DECODE_ELEMENTS, partner: 2 }
          : undefined,
      );
    const over = participant(overRole);
    const partner = participant(partnerRole);
    const run = (
      p: PSIParticipant,
      conn: MessageConnection,
      set: Array<string>,
    ): Promise<unknown> =>
      (countOnly
        ? p.countIntersection(conn, set)
        : p.identifyIntersection(conn, set)
      ).then(
        () => "completed",
        (err: unknown) => err,
      );
    const [overEnd, partnerEnd] = await Promise.all([
      run(over, overConn, values(3, "o")),
      run(partner, b, values(2, "p")),
    ]);
    over.dispose();
    partner.dispose();
    await a.close();

    expect(overEnd).toBeInstanceOf(RoundSetLimitError);
    expect((overEnd as RoundSetLimitError).reason).toBe("over-partner-ceiling");
    expect((overEnd as Error).message).toBe(
      ownSetOverPartnerCeilingMessage(3, 2),
    );
    expect(sent).toEqual([
      { decision: "abort", abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON] },
    ]);
    expect(partnerEnd).toBeInstanceOf(PeerAbortError);
    for (const spy of build)
      for (const [built] of spy.mock.calls) expect(built.length).toBe(2);
  },
);

test("the element scan holds a partner's setup or request to this party's receive ceiling", async () => {
  const engine = (role: "starter" | "joiner") =>
    new InProcessPsiEngine(
      psiLibrary,
      role,
      role === "starter" ? "server" : "client",
      "identifier-revealing",
    );
  const starterEngine = engine("starter");
  const joinerEngine = engine("joiner");
  const { setup } = await starterEngine.createServerSetup(values(3, "s"));
  const request = await joinerEngine.createClientRequest(values(3, "j"));
  const response = await starterEngine.processClientRequest(request);
  starterEngine.dispose();
  joinerEngine.dispose();
  const held = (role: "starter" | "joiner") =>
    new PSIParticipant(
      role === "starter" ? "server" : "client",
      psiLibrary,
      { role, verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      undefined,
      undefined,
      localCeiling(2),
    );
  const decode = [
    vi.spyOn(InProcessPsiEngine.prototype, "processClientRequest"),
    vi.spyOn(InProcessPsiEngine.prototype, "receiveServerSetup"),
  ];

  const starter = held("starter");
  await expect(starter.processClientRequest(request)).rejects.toThrow(
    new ProtocolRefusalError(
      "server protocol error: inbound PSI request declares more than 2 " +
        "encrypted element(s)",
    ),
  );
  starter.dispose();
  const joiner = held("joiner");
  await expect(joiner.computeValueMatches(setup, response)).rejects.toThrow(
    "client protocol error: inbound PSI serverSetup declares more than 2 " +
      "encrypted element(s)",
  );
  joiner.dispose();
  for (const spy of decode) expect(spy).not.toHaveBeenCalled();
});
