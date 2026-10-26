import { createHash, randomBytes, randomFillSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { EncryptedMessageConnection } from "@alcove/core";

import { openWebSocketRelayMessageConnection } from "../../src/connection/webrtc/websocketRelayConnection";
import { startWebSocketRelayProcess } from "../signaling/websocketRelayProcess";

import { GB, hostDescription } from "./completionRun";
import { stressMemory } from "./stressMemory";

import type { MessageConnection, RendezvousRole } from "@alcove/core";

import type { WebSocketRelayProcess } from "../signaling/websocketRelayProcess";

// One round of the largest measured exchange's size, sent one way through the
// repository's WebSocket relay between two of the CLI's relay connections,
// each wrapped in the AEAD envelope as an exchange wraps it. The relay runs as
// its standalone process at its production limits, its 2,000,000-byte-a-second
// pairing rate included, on loopback without TLS. Logs the transfer's wall time
// and the relay's resident set: idle before the parties dial, its peak from
// then on, sampled every 200 ms, and the process's own peak.
//
// The round is 539,000,000 bytes, a round's larger direction at 7,700,000
// records a side (docs/notes/webrtc-relay-deployment.md, Quotas against one
// exchange), sent in the frames the relay's load spike sent: as many of
// 267,532,651 bytes as fit, then the rest (docs/notes/web-websocket-transport.md,
// The spikes, S3). At the pairing rate it takes at least 270 s.
//
// The environment variables:
//
// - ALCOVE_STRESS_RELAY_ROUND_BYTES lowers the round's size, and
//   ALCOVE_STRESS_RELAY_FRAME_BYTES the frames'.
// - ALCOVE_STRESS_RELAY_LOG_DIR, a directory the test creates, keeps the
//   relay's memory sampled every 200 ms (memory-relay.log,
//   peakMemoryReport.mjs) and a summary of the run (websocket-relay-round.json).

const ROUND_BYTES = Number(
  process.env.ALCOVE_STRESS_RELAY_ROUND_BYTES ?? 539_000_000,
);
const FRAME_BYTES = Number(
  process.env.ALCOVE_STRESS_RELAY_FRAME_BYTES ?? 267_532_651,
);
const LOG_DIR = process.env.ALCOVE_STRESS_RELAY_LOG_DIR;
const PAIRING_BYTES_PER_SECOND = 2_000_000;
const EXCHANGE_ID = "stress-round";

// The parties' copies of the largest frame -- the sender's plaintext, its
// envelope and the chunks cut from it, the receiver's chunks, the reassembled
// envelope and its plaintext -- with room to spare: an arbitrary working
// figure, not a measured one.
const NEED_BYTES = 8 * Math.min(FRAME_BYTES, ROUND_BYTES) + 512 * 2 ** 20;

// Three times the time the pairing rate sets, and never under ten minutes.
const RUN_TIMEOUT_MS = Math.max(
  600_000,
  Math.ceil((3 * 1000 * ROUND_BYTES) / PAIRING_BYTES_PER_SECOND),
);

const PEAK_MEMORY_REPORT = fileURLToPath(
  new URL("./peakMemoryReport.mjs", import.meta.url),
);

/** The frame sizes the round is sent in. */
function frameSizes(total: number): number[] {
  const sizes: number[] = [];
  for (let left = total; left > 0; left -= FRAME_BYTES) {
    sizes.push(Math.min(left, FRAME_BYTES));
  }
  return sizes;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`received a ${typeof value}, not bytes`);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface MemorySample {
  rss: number;
}

function readSamples(path: string): MemorySample[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MemorySample);
}

/** The first sample the relay takes once it is listening, and its index. */
async function idleSample(
  path: string,
): Promise<{ rssBytes: number; index: number }> {
  const before = readSamples(path).length;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const samples = readSamples(path);
    if (samples.length > before) {
      return { rssBytes: samples[before].rss, index: before };
    }
    if (Date.now() > deadline) {
      throw new Error(`the relay wrote no memory sample to ${path} in 5 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openParty(
  relay: WebSocketRelayProcess,
  relayKey: string,
  role: RendezvousRole,
): Promise<MessageConnection> {
  return openWebSocketRelayMessageConnection({
    url: relay.url,
    exchangeId: EXCHANGE_ID,
    relayKey,
    role,
  });
}

test(
  `a round of ${ROUND_BYTES} bytes crosses the WebSocket relay intact`,
  { timeout: RUN_TIMEOUT_MS + 120_000 },
  async (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes < NEED_BYTES,
      `a round of ${ROUND_BYTES} bytes needs about ` +
        `${(NEED_BYTES / GB).toFixed(1)} GB; this host's ${memory.measure} ` +
        `is ${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const root = mkdtempSync(join(tmpdir(), "alcove-relay-round-"));
    if (LOG_DIR !== undefined) mkdirSync(LOG_DIR, { recursive: true });
    const peakFile = join(root, "peak-rss");
    const sampleFile = join(LOG_DIR ?? root, "memory-relay.log");
    rmSync(sampleFile, { force: true });
    const relayKey = randomBytes(32).toString("hex");
    const relay = await startWebSocketRelayProcess(
      { [EXCHANGE_ID]: relayKey },
      {
        NODE_OPTIONS: `--import=${PEAK_MEMORY_REPORT}`,
        ALCOVE_STRESS_PEAK_RSS_FILE: peakFile,
        ALCOVE_STRESS_MEMORY_SAMPLE_FILE: sampleFile,
      },
    );
    let relayStopped = false;
    try {
      const idle = await idleSample(sampleFile);
      const [inviter, acceptor] = await Promise.all([
        openParty(relay, relayKey, "inviter"),
        openParty(relay, relayKey, "acceptor"),
      ]);
      const sessionKey = new Uint8Array(randomBytes(32));
      const [sender, receiver] = await Promise.all([
        EncryptedMessageConnection.create(inviter, sessionKey, "initiator"),
        EncryptedMessageConnection.create(acceptor, sessionKey, "responder"),
      ]);

      const sizes = frameSizes(ROUND_BYTES);
      const sent: string[] = [];
      const startedAt = performance.now();
      const sending = (async () => {
        for (const size of sizes) {
          const frame = randomFillSync(new Uint8Array(size));
          sent.push(digest(frame));
          await sender.send(frame);
        }
      })();
      const received: Array<{ bytes: number; sha256: string }> = [];
      for (let index = 0; index < sizes.length; index += 1) {
        const frame = bytesOf(await receiver.receive());
        received.push({ bytes: frame.byteLength, sha256: digest(frame) });
      }
      const transferMs = Math.round(performance.now() - startedAt);
      await sending;
      await Promise.all([sender.close(), receiver.close()]);

      await relay.stop();
      relayStopped = true;
      const fromIdle = readSamples(sampleFile).slice(idle.index);
      const summary = {
        roundBytes: ROUND_BYTES,
        frameBytes: sizes,
        transferMs,
        relayIdleRssBytes: idle.rssBytes,
        relayPeakRssBytesFromIdle: Math.max(...fromIdle.map(({ rss }) => rss)),
        relayRssSamplesFromIdle: fromIdle.length,
        // The process's own peak, its start under the TypeScript loader included.
        relayPeakRssBytes: Number(readFileSync(peakFile, "utf8")),
        host: hostDescription(),
      };
      console.log(JSON.stringify(summary));
      if (LOG_DIR !== undefined) {
        writeFileSync(
          join(LOG_DIR, "websocket-relay-round.json"),
          JSON.stringify(summary, null, 2) + "\n",
        );
      }

      expect(received).toEqual(
        sizes.map((bytes, index) => ({ bytes, sha256: sent[index] })),
      );
    } finally {
      if (!relayStopped) await relay.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
