import { expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";
import PSI from "@openmined/psi.js";

import { util } from "peerjs";

import {
  InProcessPsiEngine,
  MAX_WEBRTC_FRAME_BYTES,
  PEERJS_CHUNK_MTU,
  RoundSetLimitError,
  setOverLimitError,
} from "@alcove/core";
import {
  PSIParticipant,
  PSI_SET_PART_HEADER_BYTES,
  binaryPackByteStringLength,
  webrtcFrameReceiveCharge,
} from "@alcove/core/testing";

import { failureFor } from "@exchange/useInviterExchange";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";

import type { DataConnection } from "peerjs";

// The browser's half of the sender-side WebRTC frame bound: its data channel
// states the bound its own receive path applies, a PSI round over it hands
// PeerJS a set past that bound in parts within it, and a set-size refusal
// reaches the operator as its own alert rather than as a connection problem.

const psiLibrary = await PSI();

/** The PeerJS connection surface openPeerMessageConnection installs on. */
class FakeDataConnection extends EventEmitter {
  open = true;
  peer = "";
  send = vi.fn();
  close = vi.fn();
  _chunkedData: Record<number, unknown> = {};
  _handleChunk = (_chunk: unknown) => {};
  _handleDataMessage = (_message: unknown) => {};
  chunker = { chunkedMTU: 16_300 };
  _send = (_data: unknown, _chunked: boolean) => {};
  _sendChunks = (_packed: ArrayBuffer) => {};
  _bufferedSend = (_packed: ArrayBuffer) => {};
}

function open(maxFrameBytes?: number) {
  const fake = new FakeDataConnection();
  return {
    fake,
    connection: openPeerMessageConnection(fake as unknown as DataConnection, {
      maxFrameBytes,
      closeDrainTimeoutMs: 0,
    }),
  };
}

const SET = Array.from({ length: 150 }, (_unused, i) => `value-${i}`);

/** What the first frame of a starter's round over the browser channel was. */
async function starterFirstFrame(
  bound: number,
): Promise<{ ended: unknown; sent: Array<unknown> }> {
  const { fake, connection } = open(bound);
  const mc = await connection;
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    {
      setup: Number.POSITIVE_INFINITY,
      request: Number.POSITIVE_INFINITY,
    },
  );
  const round = starter.identifyIntersection(mc, SET).then(
    () => undefined,
    (err: unknown) => err,
  );
  // A round that sent its setup waits for the partner, which never answers.
  const ended = await Promise.race([
    round,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
  ]);
  await mc.close();
  starter.dispose();
  return { ended, sent: fake.send.mock.calls.map(([data]) => data) };
}

test("the check charges chunks at the size the pinned PeerJS splits at", () => {
  expect(util.chunkedMTU).toBe(PEERJS_CHUNK_MTU);
});

test("the browser channel states the receive bound it applies", async () => {
  expect((await open().connection).outboundWebRtcFrameBound?.()).toBe(
    MAX_WEBRTC_FRAME_BYTES,
  );
  expect((await open(4096).connection).outboundWebRtcFrameBound?.()).toBe(4096);
});

test("a set over the bound is handed to PeerJS in parts within the bound, holding the whole set", async () => {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(SET);
  engine.dispose();
  const charge = webrtcFrameReceiveCharge(
    binaryPackByteStringLength(PSI_SET_PART_HEADER_BYTES + setup.byteLength),
  );

  for (const [bound, partCount] of [
    [charge, 1],
    [charge - 1, 2],
  ]) {
    const { ended, sent } = await starterFirstFrame(bound);
    expect(ended).toBe("waiting");
    expect(sent).toHaveLength(partCount);
    const parts = sent as Array<Uint8Array>;
    for (const part of parts)
      expect(
        webrtcFrameReceiveCharge(binaryPackByteStringLength(part.byteLength)),
      ).toBeLessThanOrEqual(bound);
    const setBytes = parts.reduce(
      (sum, part) => sum + part.byteLength - PSI_SET_PART_HEADER_BYTES,
      0,
    );
    expect(setBytes).toBe(setup.byteLength);
  }
});

test("a refusal over the partner's stated ceiling is shown as its own alert, with no retry", () => {
  const own = failureFor(
    "exchange",
    setOverLimitError({
      kind: "set-over-limit",
      stage: "after-terms",
      limit: "partner-ceiling",
      valueCount: 9_000_000,
      limitValues: 8_388_608,
      scope: "first-key",
    }),
  );
  expect(own.category).toBe("config");
  expect(own.title).toBe("Your file is too large for your partner to receive");
  expect(own.message).toBe(
    "Too large for your partner: the first linkage key gives you at least " +
      "9,000,000 values to send, over the 8,388,608 your partner can " +
      "receive in one PSI set, so the exchange stopped before any linkage " +
      "key was sent and told your partner. Split the input into smaller " +
      "files and run one exchange for each, or ask your partner to run the " +
      "exchange with the command-line application.",
  );
  expect(own.reportedCause).toBeUndefined();
});

test("a refusal over the per-set maximum is shown as the same alert, with no retry", () => {
  const failure = failureFor(
    "exchange",
    new RoundSetLimitError(
      "The set holds 20000000 values, over the 15339166 one message file " +
        "holds. Split the input into smaller files and run one exchange for " +
        "each.",
      "over-set-maximum",
    ),
  );
  expect(failure.category).toBe("config");
  expect(failure.title).toBe("Your file is too large to send");
  expect(failure.message).toContain("over the 15339166 one message file");
  expect(failure.reportedCause).toBeUndefined();
});

test("a first round the check cannot count is shown as its own alert, with no retry", () => {
  const failure = failureFor(
    "exchange",
    setOverLimitError(
      { kind: "set-over-limit", stage: "after-terms", limit: "uncounted" },
      { cause: new RangeError("Map maximum size exceeded") },
    ),
  );
  expect(failure.category).toBe("config");
  expect(failure.title).toBe(
    "The values built from your file could not be counted",
  );
  expect(failure.message).toBe(
    "Alcove could not count the values the first linkage key gives you to " +
      "send, so it cannot confirm your partner can receive them, and the " +
      "exchange stopped before any linkage key was sent and told your " +
      "partner. Split the input into smaller files and run one exchange " +
      "for each.\ncaused by: Map maximum size exceeded",
  );
  expect(failure.message).not.toMatch(/try again|temporary/i);
  expect(failure.reportedCause).toBeUndefined();
});
