// Read-ahead on file sync: a party reads the next message file only while what
// it holds unreceived, with that file, fits the inbound frame bound, so a
// partner's back-to-back frames wait on disk rather than in memory and none is
// refused (docs/spec/TRANSPORT_BOUNDS.md, Inbound frame-size bound).

import { describe, expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import {
  fromEventConnection,
  isReceiveDeadlineFailure,
} from "../../src/connection/messageConnection";
import { MESSAGE_HEADER_BYTES } from "../../src/connection/fileSyncFraming";
import { makeMockClient } from "../utils/support";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";

const PART_BYTES = 40;
const FILE_BYTES = PART_BYTES + MESSAGE_HEADER_BYTES;
// Two message files: the most this bound lets a party hold unreceived.
const BOUND_BYTES = 2 * FILE_BYTES;

type PartyOptions = Partial<
  ConstructorParameters<typeof FileSyncConnection>[1]
>;

function party(
  id: string,
  files: Map<string, Buffer>,
  opts: PartyOptions,
): FileSyncConnection {
  const conn = new FileSyncConnection(makeMockClient({ files }).client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 10_000),
    verbose: -1,
    ...opts,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = DIR;
  return conn;
}

async function rendezvous(opts: PartyOptions) {
  const files = new Map<string, Buffer>();
  const a = party(ID_A, files, opts);
  const b = party(ID_B, files, opts);
  await Promise.all([a.synchronize(), b.synchronize()]);
  return { a, b };
}

const parts = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, i) => new Uint8Array(PART_BYTES).fill(i));

describe.each([
  ["the lock rendezvous, delete mode", {}],
  ["the lockless rendezvous, delete mode", { locklessRendezvous: true }],
  [
    "retain mode",
    { locklessRendezvous: true, retainFiles: true, timestampInFilename: true },
  ],
])("back-to-back parts after %s", (_mode, opts: PartyOptions) => {
  test("more parts than the bound holds all arrive in order, none refused, and the bytes held unreceived stay at the bound", async () => {
    const { a, b } = await rendezvous(opts);
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b);
    receiver.setInboundFrameCap?.(BOUND_BYTES);
    let received = 0;
    let delivered = 0;
    let mostHeld = 0;
    b.on("data", () => {
      delivered += 1;
      mostHeld = Math.max(mostHeld, delivered - received);
    });
    a.start();
    b.start();

    const sent = parts(8);
    const sending = (async () => {
      for (const part of sent) await sender.send(part);
    })();
    await expect.poll(() => delivered).toBe(2);
    // Twenty poll cycles with nothing received: the third part stays on disk.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toBe(2);

    const got: number[][] = [];
    for (let i = 0; i < sent.length; i++) {
      got.push([...((await receiver.receive()) as Uint8Array)]);
      received += 1;
    }
    await sending;
    expect(got).toEqual(sent.map((part) => [...part]));
    expect(mostHeld * FILE_BYTES).toBe(BOUND_BYTES);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test("a partner that stops sending is still caught by the receive deadline", async () => {
    const { a, b } = await rendezvous(opts);
    const sender = fromEventConnection(a);
    const receiver = fromEventConnection(b, { inactivityTimeoutMs: 200 });
    receiver.setInboundFrameCap?.(BOUND_BYTES);
    a.start();
    b.start();

    const sent = parts(3);
    for (const part of sent) await sender.send(part);
    for (let i = 0; i < sent.length; i++) await receiver.receive();
    const silent = await receiver.receive().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isReceiveDeadlineFailure(silent)).toBe(true);
    await Promise.all([sender.close(), receiver.close()]);
  });
});
