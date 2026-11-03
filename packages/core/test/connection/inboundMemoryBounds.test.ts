import { afterEach, expect, test, vi } from "vitest";

import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { ConnectionError } from "../../src/errors";
import { JSON_RETAINED_BYTES_PER_NODE } from "../../src/utils/boundedJson";

// The memory the runtime reports, held small so each bound trips on a few
// bytes rather than on frames the size of the memory it guards.
const memory = vi.hoisted(() => ({ availableBytes: 0 }));

vi.mock("../../src/utils/availableMemory", () => ({
  availableMemoryBytes: () => memory.availableBytes,
  collectGarbage: () => false,
}));

afterEach(() => {
  memory.availableBytes = 0;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function expectReadAheadRefusal(
  receive: Promise<unknown>,
): Promise<void> {
  const err = await receive.then(
    () => {
      throw new Error("expected a rejection but the receive resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).message).toMatch(
    /need more than the 10 bytes of memory available/,
  );
}

// --- Read-ahead ---------------------------------------------------------------

test("frames queued ahead of a receive are refused past the memory available when the first was queued", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  await sender.send(new Uint8Array(4));
  await flush();
  memory.availableBytes = 1_000;
  await sender.send(new Uint8Array(4));
  await sender.send(new Uint8Array(4));
  await flush();
  // The two frames queued before the refusal are still drained ahead of it.
  expect(await receiver.receive()).toEqual(new Uint8Array(4));
  expect(await receiver.receive()).toEqual(new Uint8Array(4));
  await expectReadAheadRefusal(receiver.receive());
});

test("a frame queued at exactly the memory available is admitted", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  await sender.send(new Uint8Array(4));
  await sender.send(new Uint8Array(6));
  await flush();
  expect(await receiver.receive()).toHaveLength(4);
  expect(await receiver.receive()).toHaveLength(6);
});

test("the first frame queued is admitted whatever its size", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 1;
  await sender.send(new Uint8Array(100));
  await flush();
  expect(await receiver.receive()).toHaveLength(100);
});

test("a frame handed to a parked receive is not queued or counted", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  const parked = receiver.receive();
  await sender.send(new Uint8Array(100));
  expect(await parked).toHaveLength(100);
  await sender.send(new Uint8Array(4));
  await sender.send(new Uint8Array(6));
  await flush();
  expect(await receiver.receive()).toHaveLength(4);
  expect(await receiver.receive()).toHaveLength(6);
});

test("the memory available is read afresh once the queue drains", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  await sender.send(new Uint8Array(8));
  await flush();
  expect(await receiver.receive()).toHaveLength(8);
  memory.availableBytes = 20;
  await sender.send(new Uint8Array(8));
  await sender.send(new Uint8Array(8));
  await flush();
  expect(await receiver.receive()).toHaveLength(8);
  expect(await receiver.receive()).toHaveLength(8);
});

test("an ArrayBuffer frame counts its bytes", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  await sender.send(new ArrayBuffer(8));
  await sender.send(new ArrayBuffer(8));
  await flush();
  expect(await receiver.receive()).toBeInstanceOf(ArrayBuffer);
  await expectReadAheadRefusal(receiver.receive());
});

test("a parsed JSON message counts no bytes", async () => {
  const [sender, receiver] = createMessagePipe();
  memory.availableBytes = 10;
  await sender.send(new Uint8Array(10));
  await sender.send({ kexMsg: "1" });
  await sender.send({ kexMsg: "2" });
  await flush();
  expect(await receiver.receive()).toHaveLength(10);
  expect(await receiver.receive()).toEqual({ kexMsg: "1" });
  expect(await receiver.receive()).toEqual({ kexMsg: "2" });
});

// --- JSON node budget after decryption ----------------------------------------

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

async function encryptedPair(): Promise<
  [EncryptedMessageConnection, EncryptedMessageConnection]
> {
  const [rawA, rawB] = createMessagePipe();
  return Promise.all([
    EncryptedMessageConnection.create(rawA, SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(rawB, SESSION_KEY, "responder"),
  ]);
}

// Ten values: the array, its three empty arrays, the object, and its five
// members' values.
const TEN_VALUES = [[], [], [], { a: 1, b: 2, c: 3, d: 4, e: 5 }];

test("a decrypted JSON message within the node budget is delivered", async () => {
  memory.availableBytes = 10 * JSON_RETAINED_BYTES_PER_NODE;
  const [initiator, responder] = await encryptedPair();
  await initiator.send(TEN_VALUES);
  expect(await responder.receive()).toEqual(TEN_VALUES);
});

test("a decrypted JSON message past the node budget is refused as a security failure", async () => {
  memory.availableBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  const [initiator, responder] = await encryptedPair();
  await initiator.send(TEN_VALUES);
  const err = await responder.receive().then(
    () => {
      throw new Error("expected a rejection but the receive resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as ConnectionError).message).toMatch(
    /structure exceeds the permitted bound/,
  );
});
