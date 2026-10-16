// The control-file names with no byte count (`<id>-hello.json`,
// `<id>-joining.json`, `<id>-abort.json`) are not in the protocol grammar: a
// file named that way is foreign, so it neither ends a run nor is swept, and a
// run whose folder holds only such names at entry ends at the peer timeout.

import { describe, expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import { isPeerWaitTimeout } from "../../src/errors";
import { LOCK_HELLO_BODY } from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

const SELF = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const PEER = "00000000-0000-4000-8000-000000000001";
const EARLIER_NAMES = [
  `${PEER}-hello.json`,
  `${PEER}-joining.json`,
  `${PEER}-abort.json`,
];

async function runToTimeout(
  sweepExchangeFiles: boolean,
  locklessRendezvous: boolean,
  present: Map<string, Buffer>,
): Promise<unknown> {
  const { client } = makeMockClient({ files: present });
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 100),
    verbose: -1,
    sweepExchangeFiles,
    locklessRendezvous,
  });
  conn.id = SELF;
  conn.connected = true;
  conn.path = "/test";
  return conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("a control file name with no byte count", () => {
  for (const name of EARLIER_NAMES) {
    for (const locklessRendezvous of [false, true]) {
      for (const sweepExchangeFiles of [false, true]) {
        test(
          `${name} present at entry is ignored (sweep ${sweepExchangeFiles}, ` +
            `lockless ${locklessRendezvous}): the run ends at the peer timeout`,
          async () => {
            const files = new Map([[`/test/${name}`, LOCK_HELLO_BODY]]);
            const err = await runToTimeout(
              sweepExchangeFiles,
              locklessRendezvous,
              files,
            );
            expect(isPeerWaitTimeout(err)).toBe(true);
            expect(files.has(`/test/${name}`)).toBe(true);
          },
        );
      }
    }
  }
});
