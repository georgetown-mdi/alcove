// Key-exchange message 3 failing on file sync: the initiator has already put
// the encryption layer over the connection when the responder's cleartext abort
// arrives, so its transport refuses the abort unparsed as a `security` failure
// and consumes it, and the responder's teardown does not wait out its drain
// (docs/spec/PROTOCOL.md, "A failure of message 3").

import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, test, vi } from "vitest";

import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import {
  FileSyncConnection,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
} from "../../src/connection/fileSyncConnection";
import { ackMarkerName } from "../../src/connection/fileSyncNames";
import {
  fromEventConnection,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { ConnectionError } from "../../src/errors";
import { runKex } from "../../src/kex";
import * as BoundedJson from "../../src/utils/boundedJson";
import { makeMockClient } from "../utils/support";

vi.mock("../../src/utils/boundedJson", async (importOriginal) => {
  const original = await importOriginal<typeof BoundedJson>();
  return { ...original, parseBoundedJson: vi.fn(original.parseBoundedJson) };
});

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";
const PSK = new Uint8Array(32).fill(7);
const ABORT_JSON = Buffer.from('"kexMsg":"abort"');
// Well under the drain the responder's close waits for an unconsumed file.
const CLOSE_WITHIN_MS = 5_000;

type PartyOptions = Partial<
  NonNullable<ConstructorParameters<typeof FileSyncConnection>[1]>
>;

function party(
  id: string,
  files: Map<string, Buffer>,
  opts: PartyOptions,
): FileSyncConnection {
  const conn = new FileSyncConnection(makeMockClient({ files }).client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 100_000),
    verbose: -1,
    ...opts,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = DIR;
  return conn;
}

// Flips the first character of message 3's confirmation tag, so the responder
// fails it and sends the abort.
function corruptMessage3(conn: MessageConnection): void {
  const send = conn.send.bind(conn);
  conn.send = (message: unknown) => {
    const msg = message as { kexMsg?: string; confirm?: string };
    if (msg.kexMsg === "3" && msg.confirm !== undefined)
      return send({
        ...msg,
        confirm: (msg.confirm[0] === "A" ? "B" : "A") + msg.confirm.slice(1),
      });
    return send(message);
  };
}

const parsed = (json: Buffer): boolean =>
  vi
    .mocked(BoundedJson.parseBoundedJson)
    .mock.calls.some(([input]) =>
      Buffer.from(
        typeof input === "string" ? Buffer.from(input) : input,
      ).includes(json),
    );

const MODES: { mode: string; opts: PartyOptions }[] = [
  { mode: "the lock rendezvous, delete mode", opts: {} },
  {
    mode: "the lockless rendezvous, delete mode",
    opts: { locklessRendezvous: true },
  },
  {
    mode: "retain mode",
    opts: {
      locklessRendezvous: true,
      retainFiles: true,
      timestampInFilename: true,
    },
  },
];

describe.each(MODES)("message 3 failing after $mode", ({ opts }) => {
  test("the initiator refuses the abort unparsed as a security failure and consumes it, and the responder's close does not wait out the drain", async () => {
    expect(CLOSE_WITHIN_MS).toBeLessThan(TERMINAL_FRAME_DRAIN_TIMEOUT_MS);
    vi.mocked(BoundedJson.parseBoundedJson).mockClear();
    const files = new Map<string, Buffer>();
    const a = party(ID_A, files, opts);
    const b = party(ID_B, files, opts);
    await Promise.all([a.synchronize(), b.synchronize()]);
    const initiatorConn = fromEventConnection(a, { inactivityTimeoutMs: 3000 });
    const responderConn = fromEventConnection(b, { inactivityTimeoutMs: 3000 });
    a.start();
    b.start();
    corruptMessage3(initiatorConn);

    const initiator = (async () => {
      const keying = await runKex(initiatorConn, "initiator", PSK, true);
      const secure = await EncryptedMessageConnection.create(
        initiatorConn,
        keying,
        "initiator",
      );
      // The refusal can fail the connection before this send completes.
      await secure.send({ terms: 1 });
      await secure.receive();
    })().then(
      () => undefined,
      (err: unknown) => err,
    );
    const responder = runKex(responderConn, "responder", PSK, true).then(
      () => undefined,
      (err: unknown) => err,
    );
    const [initiatorFailure, responderFailure] = await Promise.all([
      initiator,
      responder,
    ]);

    expect(responderFailure).toBeInstanceOf(Error);
    expect(initiatorFailure).toBeInstanceOf(ConnectionError);
    expect((initiatorFailure as ConnectionError).kind).toBe("security");
    expect((initiatorFailure as Error).message).toMatch(
      /unencrypted message on an encrypted channel/,
    );
    // Message 3 went through the spied parse, so the abort's absence counts.
    expect(parsed(Buffer.from('"kexMsg":"3"'))).toBe(true);
    expect(parsed(ABORT_JSON)).toBe(false);

    const abortFiles = [...files.entries()]
      .filter(([, body]) => body.includes(ABORT_JSON))
      .map(([path]) => path.slice(DIR.length + 1));
    if (opts.retainFiles) {
      expect(abortFiles).toHaveLength(1);
      const ack = ackMarkerName(ID_A, abortFiles[0]!.slice(0, -".json".length));
      expect(files.has(`${DIR}/${ack}`)).toBe(true);
    } else {
      expect(abortFiles).toEqual([]);
    }

    const closing = responderConn.close().then(() => "closed");
    const outcome = await Promise.race([
      closing,
      delay(CLOSE_WITHIN_MS).then(() => "still waiting"),
    ]);
    expect(outcome).toBe("closed");
    await initiatorConn.close().catch(() => {});
  });
});
