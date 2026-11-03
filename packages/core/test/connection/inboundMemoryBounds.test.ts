import { afterEach, expect, test, vi } from "vitest";

import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { ConnectionError } from "../../src/errors";
import {
  JSON_RETAINED_BYTES_PER_NODE,
  MAX_JSON_NESTING_DEPTH,
} from "../../src/utils/boundedJson";

// The memory the runtime reports, held small so the budget trips on a few
// values rather than on a message the size of the memory it guards.
const memory = vi.hoisted(() => ({ availableBytes: 0 }));

vi.mock("../../src/utils/availableMemory", () => ({
  availableMemoryBytes: () => memory.availableBytes,
  collectGarbage: () => false,
}));

afterEach(() => {
  memory.availableBytes = 0;
});

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

async function rejectionOf(
  receive: Promise<unknown>,
): Promise<ConnectionError> {
  const err = await receive.then(
    () => {
      throw new Error("expected a rejection but the receive resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  return err as ConnectionError;
}

// Ten values: the array, its three empty arrays, the object, and its five
// members' values.
const TEN_VALUES = [[], [], [], { a: 1, b: 2, c: 3, d: 4, e: 5 }];

test("a decrypted JSON message within the memory budget is delivered", async () => {
  memory.availableBytes = 10 * JSON_RETAINED_BYTES_PER_NODE;
  const [initiator, responder] = await encryptedPair();
  await initiator.send(TEN_VALUES);
  expect(await responder.receive()).toEqual(TEN_VALUES);
});

test("a decrypted JSON message past the memory budget is refused as this machine's shortfall, not a security failure", async () => {
  memory.availableBytes = 9 * JSON_RETAINED_BYTES_PER_NODE;
  const [initiator, responder] = await encryptedPair();
  await initiator.send(TEN_VALUES);
  const err = await rejectionOf(responder.receive());
  expect(err.kind).toBe("usage");
  expect(err.message).toBe(
    "this machine does not have enough free memory to read the partner's " +
      "message: it needs about 400 bytes and 360 are available. Free memory " +
      "on this machine, or raise the container's memory limit, and run the " +
      "exchange again.",
  );
});

test("a decrypted JSON message past a structural bound is still a security failure", async () => {
  memory.availableBytes = 2 ** 40;
  const [initiator, responder] = await encryptedPair();
  let deep: unknown = [];
  for (let i = 0; i < MAX_JSON_NESTING_DEPTH; i++) deep = [deep];
  await initiator.send(deep);
  const err = await rejectionOf(responder.receive());
  expect(err.kind).toBe("security");
  expect(err.message).toMatch(/structure exceeds the permitted bound/);
});
