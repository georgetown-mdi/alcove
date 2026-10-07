// One file-sync exchange of the lists naming matched records, run in its own
// process so its peak resident set is its own: `matchedListParts.stress.test.ts`
// spawns it once per case and reads the one JSON line it prints. Both parties
// run here, each on a FileSyncConnection over one in-memory directory under the
// channel's AEAD envelope, so every part is a message file the receiver's read
// gate holds to MAX_FRAME_SIZE_BYTES.
//
// Usage: node --max-old-space-size=<MiB> --import tsx matchedListParts.probe.ts <case> <entries>

import { performance } from "node:perf_hooks";

import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import {
  fromEventConnection,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { exchangePayloads } from "../../src/payloadExchange";
import {
  associationAndIterationArray,
  exchangeMappedElements,
  mappedElementArray,
  mappedElementEntryBytes,
} from "../../src/psi/link";
import { makeRendezvousPair } from "../utils/fileSyncConnectionFixture";

import type { FileSyncConnection } from "../../src/connection/fileSyncConnection";

export const PROBE_CASES = ["mappedElements", "payload"] as const;
export type ProbeCase = (typeof PROBE_CASES)[number];

export interface ProbeResult {
  readonly probe: ProbeCase;
  readonly entries: number;
  readonly holds: boolean;
  readonly error?: string;
  readonly partsSent: number;
  readonly largestFileBytes: number;
  readonly elapsedMs: number;
  readonly maxRssMiB: number;
}

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;
const quiet = { info: () => undefined, debug: () => undefined };

// A payload cell wide enough that the payload takes more than one part.
const CELL = "x".repeat(24);

interface Pair {
  readonly a: MessageConnection;
  readonly b: MessageConnection;
  readonly partsSent: () => number;
  readonly largestFileBytes: () => number;
  readonly stop: () => void;
}

async function filesyncPair(): Promise<Pair> {
  const { connA, connB, files } = makeRendezvousPair(
    "00000000-0000-4000-8000-000000000000",
    {},
    "ffffffff-ffff-4fff-bfff-ffffffffffff",
    {},
    { timeToLiveMs: 3_600_000, pollingFrequency: 5 },
  );
  await Promise.all([connA.synchronize(), connB.synchronize()]);
  let largest = 0;
  const set = files.set.bind(files);
  files.set = (name, body) => {
    if (body.length > largest) largest = body.length;
    return set(name, body);
  };
  let sent = 0;
  const counted = (conn: FileSyncConnection): MessageConnection => {
    const raw = fromEventConnection(conn);
    conn.start();
    return {
      send: (data) => {
        if (data instanceof Uint8Array) sent += 1;
        return raw.send(data);
      },
      receive: (timeoutMs?: number) => raw.receive(timeoutMs),
      close: () => raw.close(),
      outboundFileSyncFrameBound: raw.outboundFileSyncFrameBound?.bind(raw),
      setInboundFrameCap: raw.setInboundFrameCap?.bind(raw),
    };
  };
  const [a, b] = await Promise.all([
    EncryptedMessageConnection.create(counted(connA), SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(counted(connB), SESSION_KEY, "responder"),
  ]);
  return {
    a,
    b,
    partsSent: () => sent,
    largestFileBytes: () => largest,
    stop: () => {
      connA.stop();
      connB.stop();
    },
  };
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

async function mappedElements(pair: Pair, entries: number): Promise<void> {
  const list = Array.from({ length: entries }, (_, i) => ({
    theirIndex: i,
    iteration: i & 1,
  }));
  const bound = { entries, entryBytes: mappedElementEntryBytes(entries, 1, 2) };
  const [atA, atB] = await Promise.all([
    exchangeMappedElements(
      "a",
      pair.a,
      quiet,
      true,
      list,
      "list",
      bound,
      mappedElementArray,
    ),
    exchangeMappedElements(
      "b",
      pair.b,
      quiet,
      false,
      list,
      "list",
      bound,
      mappedElementArray,
    ),
  ]);
  for (const received of [atA, atB]) {
    check(received.length === entries, "a mapped-element list came back short");
    check(
      received[entries - 1].theirIndex === entries - 1,
      "the last entry moved",
    );
  }
  const [backAtA, backAtB] = await Promise.all([
    exchangeMappedElements(
      "a",
      pair.a,
      quiet,
      true,
      list,
      "returned list",
      bound,
      associationAndIterationArray,
    ),
    exchangeMappedElements(
      "b",
      pair.b,
      quiet,
      false,
      list,
      "returned list",
      bound,
      associationAndIterationArray,
    ),
  ]);
  for (const received of [backAtA, backAtB])
    check(received.length === entries, "a returned list came back short");
}

async function payload(pair: Pair, entries: number): Promise<void> {
  const rowIndices = Array.from({ length: entries }, (_, i) => i);
  const rows = rowIndices.map((): Array<string | null> => [CELL]);
  const local = { hasData: true as const, columns: ["note"], rowIndices, rows };
  const [, atB] = await Promise.all([
    exchangePayloads(pair.a, "initiator", local, entries),
    exchangePayloads(pair.b, "responder", { hasData: false }, entries),
  ]);
  check(atB.rows.length === entries, "the payload came back short");
  check(
    atB.rowIndices[entries - 1] === entries - 1,
    "the last row index moved",
  );
}

async function main(): Promise<void> {
  const [probe, entriesArg] = process.argv.slice(2) as [ProbeCase, string];
  const entries = Number(entriesArg);
  const started = performance.now();
  const pair = await filesyncPair();
  let error: string | undefined;
  try {
    await (probe === "mappedElements" ? mappedElements : payload)(
      pair,
      entries,
    );
  } catch (caught) {
    error =
      caught instanceof Error
        ? (caught.stack ?? caught.message)
        : String(caught);
  } finally {
    pair.stop();
  }
  const result: ProbeResult = {
    probe,
    entries,
    holds:
      error === undefined && pair.largestFileBytes() <= MAX_FRAME_SIZE_BYTES,
    ...(error === undefined ? {} : { error }),
    partsSent: pair.partsSent(),
    largestFileBytes: pair.largestFileBytes(),
    elapsedMs: Math.round(performance.now() - started),
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

void main();
