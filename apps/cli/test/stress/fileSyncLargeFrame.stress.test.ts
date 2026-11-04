import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import { FileSyncConnection, fromEventConnection } from "@alcove/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import { stressMemory } from "./stressMemory";

// One frame over 2 GiB written to a synced folder by one file-sync party and
// read whole by the other, through the filedrop client, with the receiver's
// read gate raised to the frame by the cap a single-pass run sets
// (docs/spec/TRANSPORT_BOUNDS.md, Inbound frame-size bound). There is no key
// exchange: the AEAD seals no frame past 2^31 - 18 bytes. Both parties run in
// this process, so it holds the frame twice; ALCOVE_STRESS_LARGE_FRAME_DIR
// names the directory the frame is written in (the system temporary
// directory by default).

const GIB = 2 ** 30;
const FRAME_BYTES = 2 * GIB + 4096;
const NEED_MEMORY_BYTES = 3 * FRAME_BYTES;
const NEED_DISK_BYTES = FRAME_BYTES + GIB;
const TIMEOUT_MS = 20 * 60_000;
const BASE_DIR = process.env.ALCOVE_STRESS_LARGE_FRAME_DIR ?? tmpdir();

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
  "a frame over 2 GiB crosses a synced folder whole",
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

    const dir = mkdtempSync(join(BASE_DIR, "alcove-large-frame-"));
    const parties: FileSyncConnection[] = [];
    try {
      const [sender, receiver] = await Promise.all([
        openParty(dir),
        openParty(dir),
      ]);
      parties.push(sender, receiver);
      const senderMc = fromEventConnection(sender, {
        inactivityTimeoutMs: TIMEOUT_MS,
      });
      const receiverMc = fromEventConnection(receiver, {
        inactivityTimeoutMs: TIMEOUT_MS,
      });

      const pattern = Buffer.alloc(GIB / 1024);
      for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31) & 0xff;
      const frame = Buffer.alloc(FRAME_BYTES).fill(pattern);
      frame.writeUInt32BE(FRAME_BYTES >>> 0, FRAME_BYTES - 4);
      expect(FRAME_BYTES).toBeGreaterThan(2 ** 31);

      // The frame and its message envelope.
      receiverMc.setInboundFrameCap?.(FRAME_BYTES + 64);
      const started = performance.now();
      const received = receiverMc.receive();
      await senderMc.send(frame);
      const wrote = performance.now();
      const read = (await received) as Uint8Array;
      const done = performance.now();
      console.log(
        `${FRAME_BYTES}-byte frame: written in ` +
          `${((wrote - started) / 1000).toFixed(1)} s, read in ` +
          `${((done - wrote) / 1000).toFixed(1)} s`,
      );

      expect(read).toBeInstanceOf(Uint8Array);
      expect(read.byteLength).toBe(FRAME_BYTES);
      expect(
        Buffer.from(read.buffer, read.byteOffset, read.byteLength).equals(
          frame,
        ),
      ).toBe(true);

      await Promise.all([senderMc.close(), receiverMc.close()]);
    } finally {
      await Promise.all(parties.map((party) => party.close().catch(() => {})));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
