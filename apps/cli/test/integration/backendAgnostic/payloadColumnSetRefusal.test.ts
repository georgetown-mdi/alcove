import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  ConnectionError,
  prepareForExchange,
  sanitizeErrorForDisplay,
} from "@alcove/core";
import type { LinkageTerms, Metadata, PreparedExchange } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import type { EventStreamEmitter } from "../../../src/eventStream";
import { saveKeyFile } from "../../../src/keyFile";
import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";

// Two CLI parties run a real file-drop exchange. The sending party's metadata
// is switched once the PSI round begins, after both parties agreed terms
// under the original columns, so the payload it sends names a different
// column set than its agreed `payload.send`. The receiving party's run ends
// on a protocol refusal whose message names no column.

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const UNAGREED_COLUMN = "unagreed_column_name";

const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const linkageColumn: Metadata[number] = {
  name: "first_name",
  type: "first_name",
  role: "linkage",
  isPayload: false,
};
const payloadColumn = (name: string): Metadata[number] => ({
  name,
  type: "other",
  role: "payload",
  isPayload: true,
});
const agreedMetadata: Metadata = [
  linkageColumn,
  payloadColumn("a"),
  payloadColumn("b"),
];

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-payload-set-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/**
 * An event-stream emitter that records nothing and calls `onStage` for each
 * stage the run enters.
 */
function stageWatcher(onStage: (id: string) => void): EventStreamEmitter {
  return new Proxy({} as EventStreamEmitter, {
    get: (_target, property) =>
      property === "stage"
        ? (id: string) => onStage(id)
        : () => {
            /* ignored */
          },
  });
}

/**
 * The sending party's preparation, whose metadata reads as `sentMetadata`
 * once the run reaches its first PSI stage.
 */
function switchingSender(sentMetadata: Metadata): {
  prepared: PreparedExchange;
  eventStream: EventStreamEmitter;
} {
  const prepared = prepareForExchange(
    {
      metadata: agreedMetadata,
      linkageTerms: { ...baseTerms, identity: "Sender" },
    },
    "Sender",
    [{ first_name: "Bob", a: "1", b: "2", [UNAGREED_COLUMN]: "3" }],
    ["first_name", "a", "b", UNAGREED_COLUMN],
  );
  let switched = false;
  const original = prepared.metadata;
  Object.defineProperty(prepared, "metadata", {
    get: () => (switched ? sentMetadata : original),
  });
  return {
    prepared,
    eventStream: stageWatcher((id) => {
      if (id.startsWith("stage ")) switched = true;
    }),
  };
}

function receiver(): PreparedExchange {
  return prepareForExchange(
    {
      metadata: [linkageColumn],
      linkageTerms: { ...baseTerms, identity: "Receiver" },
    },
    "Receiver",
    [{ first_name: "Bob" }],
    ["first_name"],
  );
}

async function runWithSentMetadata(
  sentMetadata: Metadata,
): Promise<PromiseSettledResult<unknown>> {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const keySender = path.join(work, "sender.key");
  const keyReceiver = path.join(work, "receiver.key");
  saveKeyFile(keySender, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyReceiver, { sharedSecret: INITIAL_SECRET });
  const connection = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: {
      pollIntervalMs: 1,
      peerTimeoutMs: 20_000,
      inactivityTimeoutMs: 20_000,
    },
  });
  const sender = switchingSender(sentMetadata);
  const [settled] = await withCapturedLogs(
    () =>
      Promise.allSettled([
        runProtocol({
          connection: connection(),
          auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keyReceiver },
          prepared: receiver(),
          output: path.join(work, "receiver-out"),
          verbosity: -1,
          loggerName: "payload-set-receiver",
        }),
        runProtocol({
          connection: connection(),
          auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keySender },
          prepared: sender.prepared,
          output: path.join(work, "sender-out"),
          verbosity: -1,
          loggerName: "payload-set-sender",
          fileSyncRuntime: { eventStream: sender.eventStream },
        }),
      ]),
    () => true,
  );
  return settled[0];
}

function expectRedactedRefusal(result: PromiseSettledResult<unknown>): void {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as unknown;
  expect(reason).toBeInstanceOf(ConnectionError);
  expect((reason as ConnectionError).kind).toBe("protocol");
  const rendered = sanitizeErrorForDisplay(reason);
  expect(rendered).toContain("payload disclosure mismatch");
  expect(rendered).not.toContain(UNAGREED_COLUMN);
}

test("a payload naming a column outside the agreed send set ends the receiving run", async () => {
  expectRedactedRefusal(
    await runWithSentMetadata([
      ...agreedMetadata,
      payloadColumn(UNAGREED_COLUMN),
    ]),
  );
}, 30_000);

test("a payload missing an agreed column ends the receiving run", async () => {
  expectRedactedRefusal(
    await runWithSentMetadata([linkageColumn, payloadColumn("a")]),
  );
}, 30_000);

test("the agreed columns complete the receiving run", async () => {
  const result = await runWithSentMetadata(agreedMetadata);
  expect(result.status).toBe("fulfilled");
}, 30_000);
