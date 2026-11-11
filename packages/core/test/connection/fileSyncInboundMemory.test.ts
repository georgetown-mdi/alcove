// The file-sync read gate weighs each partner message file against the memory
// the process has before it reads the file: the files read and not yet
// received, and this one with its decryption (docs/spec/FILE_SYNC_MEMORY.md, Memory an
// inbound frame takes).

import { describe, expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import { fromEventConnection } from "../../src/connection/messageConnection";
import { MESSAGE_HEADER_BYTES } from "../../src/connection/fileSyncFraming";
import {
  CHUNKED_OPEN_PEAK_BYTES,
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundPsiFramePeakBytes,
} from "../../src/connection/inboundFrameMemory";
import {
  CHUNKED_ENVELOPE_VERSION,
  SINGLE_CALL_ENVELOPE_VERSION,
} from "../../src/connection/encryptedMessageConnection";
import { ConnectionError, UsageError } from "../../src/errors";
import { makeMockClient } from "../utils/support";

import type { InboundFrameMemoryCheck } from "../../src/connection/fileSyncMessageLoop";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";

const PART_BYTES = 40;
const FILE_BYTES = PART_BYTES + MESSAGE_HEADER_BYTES;

function party(
  id: string,
  files: Map<string, Buffer>,
  inboundFrameMemoryCheck?: InboundFrameMemoryCheck,
): FileSyncConnection {
  const conn = new FileSyncConnection(makeMockClient({ files }).client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 10_000),
    verbose: -1,
    ...(inboundFrameMemoryCheck !== undefined && { inboundFrameMemoryCheck }),
  });
  conn.id = id;
  conn.connected = true;
  conn.path = DIR;
  return conn;
}

async function rendezvous(check: InboundFrameMemoryCheck) {
  const files = new Map<string, Buffer>();
  const a = party(ID_A, files);
  const b = party(ID_B, files, check);
  await Promise.all([a.synchronize(), b.synchronize()]);
  return { a, b, files };
}

const parts = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, i) => new Uint8Array(PART_BYTES).fill(i));

describe("the memory check before each message file is read", () => {
  test("each file is weighed with the files read and not yet received", async () => {
    const calls: Array<[number, number]> = [];
    const { a, b } = await rendezvous((frameBytes, needBytes) => {
      calls.push([frameBytes, needBytes]);
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    a.start();
    b.start();
    for (const part of parts(3)) await sender.send(part);
    await expect.poll(() => calls.length).toBe(3);
    expect(calls).toEqual([
      [FILE_BYTES, FILE_BYTES],
      [FILE_BYTES, 2 * FILE_BYTES],
      [FILE_BYTES, 3 * FILE_BYTES],
    ]);
    for (let i = 0; i < 3; i++) await receiver.receive();
    await Promise.all([sender.close(), receiver.close()]);
  });

  test("an encrypted file read before an envelope version is negotiated is weighed at the aeadOpen multiple", async () => {
    const calls: Array<[number, number]> = [];
    const { a, b } = await rendezvous((frameBytes, needBytes) => {
      calls.push([frameBytes, needBytes]);
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    b.requireBinaryFrames();
    a.start();
    b.start();
    await sender.send(parts(1)[0]);
    await receiver.receive();
    expect(calls).toEqual([
      [FILE_BYTES, FILE_BYTES * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen],
    ]);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test("under envelope version 1 an encrypted file is weighed at the aeadOpen multiple", async () => {
    const calls: Array<[number, number]> = [];
    const { a, b } = await rendezvous((frameBytes, needBytes) => {
      calls.push([frameBytes, needBytes]);
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    b.useEnvelopeVersion(SINGLE_CALL_ENVELOPE_VERSION);
    b.requireBinaryFrames();
    a.start();
    b.start();
    await sender.send(parts(1)[0]);
    await receiver.receive();
    expect(calls).toEqual([
      [FILE_BYTES, FILE_BYTES * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen],
    ]);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test("under envelope version 2 an encrypted file is weighed at its bytes and the measured open peak", async () => {
    const calls: Array<[number, number]> = [];
    const { a, b } = await rendezvous((frameBytes, needBytes) => {
      calls.push([frameBytes, needBytes]);
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    b.useEnvelopeVersion(CHUNKED_ENVELOPE_VERSION);
    b.requireBinaryFrames();
    a.start();
    b.start();
    await sender.send(parts(1)[0]);
    await receiver.receive();
    expect(calls).toEqual([[FILE_BYTES, FILE_BYTES + CHUNKED_OPEN_PEAK_BYTES]]);
    await Promise.all([sender.close(), receiver.close()]);
  });

  // The single-pass check at the terms exchange charges the partner's frame
  // through inboundPsiFramePeakBytes; for a streamed frame its read is the
  // larger term, so the two checks charge one file the same.
  test.each([
    ["1", SINGLE_CALL_ENVELOPE_VERSION],
    ["2", CHUNKED_ENVELOPE_VERSION],
  ])(
    "under envelope version %s the read gate charges what the terms-exchange check charges",
    async (_version, envelopeVersion) => {
      const calls: Array<[number, number]> = [];
      const { a, b } = await rendezvous((frameBytes, needBytes) => {
        calls.push([frameBytes, needBytes]);
      });
      const sender = fromEventConnection(a);
      const receiver = fromEventConnection(b);
      b.useEnvelopeVersion(envelopeVersion);
      b.requireBinaryFrames();
      a.start();
      b.start();
      await sender.send(parts(1)[0]);
      await receiver.receive();
      expect(calls).toEqual([
        [
          FILE_BYTES,
          inboundPsiFramePeakBytes(FILE_BYTES, "stream", true, envelopeVersion),
        ],
      ]);
      await Promise.all([sender.close(), receiver.close()]);
    },
  );

  test("a version-2 file the aeadOpen multiple would refuse is read", async () => {
    // The smallest frames where the two charges part: above a third of the
    // chunked open's measured peak.
    const frame = new Uint8Array(Math.ceil(CHUNKED_OPEN_PEAK_BYTES / 3)).fill(
      7,
    );
    const fileBytes = frame.length + MESSAGE_HEADER_BYTES;
    const availableBytes = fileBytes + CHUNKED_OPEN_PEAK_BYTES;
    expect(fileBytes * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen).toBeGreaterThan(
      availableBytes,
    );
    const refusals: number[] = [];
    const { a, b } = await rendezvous((_frameBytes, needBytes) => {
      if (needBytes > availableBytes) {
        refusals.push(needBytes);
        throw new UsageError("not enough memory");
      }
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    b.useEnvelopeVersion(CHUNKED_ENVELOPE_VERSION);
    b.requireBinaryFrames();
    a.start();
    b.start();
    await sender.send(frame);
    const received = await receiver.receive();
    expect(refusals).toEqual([]);
    expect((received as Uint8Array).length).toBe(frame.length);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test("a refusal leaves the file unread and ends the receive with it", async () => {
    const refusal = new UsageError("not enough memory");
    const { a, b, files } = await rendezvous(() => {
      throw refusal;
    });
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    a.start();
    b.start();
    // Never consumed, so the send does not finish.
    void sender.send(parts(1)[0]).catch(() => undefined);
    const failure = await receiver.receive().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).cause).toBe(refusal);
    expect(
      [...files.keys()].filter((name) => name.includes(`${ID_A}-`)),
    ).toHaveLength(1);
    await receiver.close();
    a.stop();
  });
});
