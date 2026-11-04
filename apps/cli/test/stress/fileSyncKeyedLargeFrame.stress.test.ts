import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import {
  EncryptedMessageConnection,
  FileSyncConnection,
  fromEventConnection,
} from "@alcove/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import { stressMemory } from "./stressMemory";

// One encrypted frame over 2^31 bytes, past the most one AES-GCM call
// encrypts, written to a synced folder by one file-sync party and read whole
// by the other under envelope version 2, the chunked AEAD envelope
// (docs/spec/CHANNEL_SECURITY.md, "The chunked envelope, version 2"). Both
// parties run in this process, so it holds the frame, its envelope and the
// envelope read back; ALCOVE_STRESS_LARGE_FRAME_DIR names the directory the
// frame is written in (the system temporary directory by default).

const GIB = 2 ** 30;
const FRAME_BYTES = 2 * GIB + 4096;
const NEED_MEMORY_BYTES = 4 * FRAME_BYTES;
const NEED_DISK_BYTES = FRAME_BYTES + GIB;
const TIMEOUT_MS = 20 * 60_000;
const BASE_DIR = process.env.ALCOVE_STRESS_LARGE_FRAME_DIR ?? tmpdir();
const KEYING = {
  sessionKey: new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>,
  negotiated: { kex: 3, protocol: 1, envelope: 2 },
};

async function openParty(path: string): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(new LocalFSClient(), {
    verbose: -1,
    pollingFrequency: 50,
  });
  await conn.open({ channel: "filedrop", path });
  await conn.synchronize();
  conn.start();
  return conn;
}

test(
  "an encrypted frame over 2^31 bytes crosses a synced folder whole",
  { timeout: TIMEOUT_MS },
  async (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes < NEED_MEMORY_BYTES,
      `the run needs ${(NEED_MEMORY_BYTES / GIB).toFixed(1)} GiB; this ` +
        `host's ${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const disk = statfsSync(BASE_DIR);
    const freeDisk = disk.bavail * disk.bsize;
    ctx.skip(
      freeDisk < NEED_DISK_BYTES,
      `the run needs ${(NEED_DISK_BYTES / GIB).toFixed(1)} GiB free in ` +
        `${BASE_DIR}; it has ${(freeDisk / GIB).toFixed(1)} GiB`,
    );

    const dir = mkdtempSync(join(BASE_DIR, "alcove-keyed-large-frame-"));
    const parties: FileSyncConnection[] = [];
    try {
      const [senderParty, receiverParty] = await Promise.all([
        openParty(dir),
        openParty(dir),
      ]);
      parties.push(senderParty, receiverParty);
      const [sender, receiver] = await Promise.all([
        EncryptedMessageConnection.create(
          fromEventConnection(senderParty, {
            inactivityTimeoutMs: TIMEOUT_MS,
          }),
          KEYING,
          "initiator",
        ),
        EncryptedMessageConnection.create(
          fromEventConnection(receiverParty, {
            inactivityTimeoutMs: TIMEOUT_MS,
          }),
          KEYING,
          "responder",
        ),
      ]);
      expect(sender.frameCeilingBytes()).toBeUndefined();

      const pattern = Buffer.alloc(GIB / 1024);
      for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31) & 0xff;
      const frame = Buffer.alloc(FRAME_BYTES).fill(pattern);
      frame.writeUInt32BE(FRAME_BYTES >>> 0, FRAME_BYTES - 4);
      expect(FRAME_BYTES).toBeGreaterThan(2 ** 31);

      // The frame, its encryption envelope, and its message file header.
      receiver.setInboundFrameCap(
        FRAME_BYTES + sender.outboundFrameOverheadBytes(FRAME_BYTES) + 64,
      );
      const started = performance.now();
      const received = receiver.receive();
      await sender.send(frame);
      const wrote = performance.now();
      const read = (await received) as Uint8Array;
      const done = performance.now();
      console.log(
        `${FRAME_BYTES}-byte encrypted frame: encrypted and written in ` +
          `${((wrote - started) / 1000).toFixed(1)} s, read and decrypted in ` +
          `${((done - wrote) / 1000).toFixed(1)} s, peak RSS ` +
          `${(process.resourceUsage().maxRSS / 2 ** 20).toFixed(2)} GiB`,
      );

      expect(read).toBeInstanceOf(Uint8Array);
      expect(read.byteLength).toBe(FRAME_BYTES);
      expect(
        Buffer.from(read.buffer, read.byteOffset, read.byteLength).equals(
          frame,
        ),
      ).toBe(true);

      await Promise.all([sender.close(), receiver.close()]);
    } finally {
      await Promise.all(parties.map((party) => party.close().catch(() => {})));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
