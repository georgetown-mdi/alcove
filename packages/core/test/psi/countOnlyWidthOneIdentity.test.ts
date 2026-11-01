import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { createMessagePipe } from "../../src/connection/messageConnection";
import type { CountOnlyRoundWidths } from "../../src/psi/countOnlyRounds";
import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine, type PsiEngine } from "../../src/psi/psiEngine";
import {
  servePsiWorker,
  WorkerPsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import {
  ShardedPsiEngine,
  shardHelperMode,
} from "../../src/psi/shardedPsiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";

// A count-only exchange whose every round has width 1 in both roles sends the
// frames and reaches the count the construction with one element per record
// sends and reaches (docs/spec/PROTOCOL.md, PSI-C, Candidate sets under
// count-only). The digests below are of that construction's frames, taken
// from the engines with no width under fixed keys and a seeded platform
// generator; a frame or a random draw the block layout adds at width 1
// changes them.

const wasm = await PSI();

const SERVER_KEY = psiTestKey(3);
const CLIENT_KEY = psiTestKey(5);

afterEach(() => vi.restoreAllMocks());

// The platform generator replaced by a fixed xorshift stream, so `pi` and
// `sigma` are the same on every run.
function seedPlatformGenerator(seed: number): void {
  let state = seed >>> 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      const bytes = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      for (let index = 0; index < bytes.length; index += 1) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        bytes[index] = state & 0xff;
      }
      return array;
    },
  );
}

// Two rounds' sets, one element per record: receiver 0 matches sender 0 on
// both keys, receiver 1 sender 1 on the first, receiver 2 sender 1 on the
// second; every other element is a value no other set holds.
const SENDER_RECORDS = 40;
const RECEIVER_RECORDS = 52;
function roundSets(round: number): {
  sender: Array<string>;
  receiver: Array<string>;
} {
  const sender = Array.from(
    { length: SENDER_RECORDS },
    (_, record) => `${String(round)}:s-${String(record)}`,
  );
  const receiver = Array.from(
    { length: RECEIVER_RECORDS },
    (_, record) => `${String(round)}:r-${String(record)}`,
  );
  sender[0] = receiver[0] = `${String(round)}:both`;
  if (round === 0) sender[1] = receiver[1] = "0:first";
  else sender[1] = receiver[2] = "1:second";
  return { sender, receiver };
}

type Library = PSILibrary;
type Role = "starter" | "joiner";
type EngineFactory = (library: Library, role: Role) => PsiEngine;

function keyed(library: Library): Library {
  return fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY);
}

const inProcess: EngineFactory = (library, role) =>
  new InProcessPsiEngine(keyed(library), role, role, "count-only-permuted");

function workerEngine(
  library: Library,
  role: Role,
  mode: "count-only-permuted" | "identifier-revealing",
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    keyed(library),
    { role, id: role, mode },
    (response) => deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
}

const workerBacked: EngineFactory = (library, role) =>
  workerEngine(library, role, "count-only-permuted");

const sharded: EngineFactory = (library, role) =>
  new ShardedPsiEngine(
    library,
    role,
    "count-only-permuted",
    inProcess(library, role),
    [1, 2].map(() =>
      workerEngine(library, role, shardHelperMode("count-only-permuted")),
    ),
    { minShardElements: 16 },
  );

function recording(
  conn: MessageConnection,
  sent: Array<string>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(
        data instanceof Uint8Array
          ? Buffer.from(data).toString("hex")
          : JSON.stringify(data),
      );
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

const digest = (frames: ReadonlyArray<string>): string =>
  createHash("sha256").update(frames.join("\n")).digest("hex");

// Two rounds between participants over a message pipe, every frame each
// party sends recorded; `widths` is passed to each round when given.
async function exchange(
  create: EngineFactory,
  widths?: CountOnlyRoundWidths,
): Promise<{
  count: number;
  senderFrames: string;
  receiverFrames: string;
}> {
  seedPlatformGenerator(0x5eed_0001);
  const [senderEnd, receiverEnd] = createMessagePipe();
  const senderSent: Array<string> = [];
  const receiverSent: Array<string> = [];
  const senderConn = recording(senderEnd, senderSent);
  const receiverConn = recording(receiverEnd, receiverSent);
  const sender = new PSIParticipant(
    "server",
    wasm,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    create(wasm, "starter"),
  );
  const receiver = new PSIParticipant(
    "client",
    wasm,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    create(wasm, "joiner"),
  );
  const declared = {
    receiverRecords: RECEIVER_RECORDS,
    senderRecords: SENDER_RECORDS,
  };
  try {
    for (let round = 0; round < 2; round += 1) {
      const sets = roundSets(round);
      await Promise.all([
        sender.countPermutedRound(senderConn, sets.sender, declared, widths),
        receiver.countPermutedRound(
          receiverConn,
          sets.receiver,
          declared,
          widths,
        ),
      ]);
    }
    const count = await receiver.finishPermutedCount(2);
    vi.restoreAllMocks();
    return {
      count,
      senderFrames: digest(senderSent),
      receiverFrames: digest(receiverSent),
    };
  } finally {
    sender.dispose();
    receiver.dispose();
  }
}

const ONE_ELEMENT_PER_RECORD_DIGESTS = {
  count: 2,
  senderFrames:
    "9808e9dc1949c8ddc94274ea3a9c5b78ba204597a732d8cb1840c146ddd40c3b",
  receiverFrames:
    "81d47f33cc558320f05203b7b1986e5b8ffcd5027f163a67e9dda567422c3fdd",
};

describe("a count-only exchange whose rounds all have width 1", () => {
  test.for(
    (
      [
        ["in-process", inProcess],
        ["worker-backed", workerBacked],
        ["sharded", sharded],
      ] as const
    ).flatMap(([name, create]) => [
      [name, "no widths", create, undefined] as const,
      [
        name,
        "widths of 1",
        create,
        { receiverWidth: 1, senderWidth: 1 },
      ] as const,
    ]),
  )(
    "sends the frames and reaches the count of the construction with one element per record, %s, given %s",
    async ([, , create, widths]) => {
      expect(await exchange(create, widths)).toStrictEqual(
        ONE_ELEMENT_PER_RECORD_DIGESTS,
      );
    },
  );

  test("draws from the platform generator only what that construction drew", async () => {
    const draws: Array<number> = [];
    const original = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array !== null) draws.push(array.byteLength);
        original(array as unknown as Uint8Array<ArrayBuffer>);
        return array;
      },
    );
    const sender = inProcess(wasm, "starter");
    const receiver = inProcess(wasm, "joiner");
    try {
      for (let round = 0; round < 2; round += 1) {
        const sets = roundSets(round);
        const { setup, indexTable } = await sender.createPermutedSetup(
          sets.sender,
          1,
        );
        await receiver.receiveServerSetup(setup);
        await receiver.receiveIndexTable(indexTable, 1);
        await receiver.matchPermutedRound(
          await sender.processClientRequest(
            await receiver.createClientRequest(sets.receiver, 1),
            RECEIVER_RECORDS,
            1,
          ),
        );
      }
      expect(await receiver.finishPermutedCount()).toBe(2);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
    // `sigma`, then `pi`, each one draw of the permutation's word buffer.
    expect(draws).toStrictEqual([16_384, 16_384]);
  });
});
