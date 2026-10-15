import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withCapturedLogs } from "@alcove/core/testing";

import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import { LocalFSClient } from "../../../src/connection/localFSClient";
import { preparedFor } from "../../support";

// Writing without renaming on the filedrop channel: the switch is in core's
// connection, so a shared folder reached through LocalFSClient follows it
// with no transport change. Two whole runProtocol parties over one real
// folder complete an exchange while LocalFSClient.rename refuses every call,
// and no write targets a temporary name.

const PEER_TIMEOUT_MS = 30_000;

const ROWS_A = [{ first_name: "Bob" }, { first_name: "Carol" }];
const ROWS_B = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-filedrop-no-rename-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

test("a filedrop exchange writing without renaming completes with no rename and no temporary name", async () => {
  const renames: string[] = [];
  vi.spyOn(LocalFSClient.prototype, "rename").mockImplementation(
    async (fromPath: string) => {
      renames.push(fromPath);
      throw Object.assign(new Error("rename refused"), { code: "ENOENT" });
    },
  );
  const written: string[] = [];
  const put = LocalFSClient.prototype.put;
  vi.spyOn(LocalFSClient.prototype, "put").mockImplementation(function (
    this: LocalFSClient,
    ...args: Parameters<LocalFSClient["put"]>
  ) {
    written.push(path.basename(args[1]));
    return put.apply(this, args);
  });

  const shared = path.join(work, "shared");
  await fsp.mkdir(shared);
  const connection: ProtocolConnectionConfig = {
    channel: "filedrop",
    path: shared,
    options: {
      pollIntervalMs: 50,
      peerTimeoutMs: PEER_TIMEOUT_MS,
      inactivityTimeoutMs: PEER_TIMEOUT_MS,
      writeWithoutRenaming: true,
    },
  };
  const outA = path.join(work, "a");
  const outB = path.join(work, "b");

  await withCapturedLogs(async () => {
    await Promise.all([
      runProtocol({
        connection,
        auth: null,
        prepared: preparedFor("PartyA", ROWS_A),
        output: outA,
        verbosity: -1,
        loggerName: "filedrop-no-rename-a",
      }),
      runProtocol({
        connection,
        auth: null,
        prepared: preparedFor("PartyB", ROWS_B),
        output: outB,
        verbosity: -1,
        loggerName: "filedrop-no-rename-b",
      }),
    ]);
  });

  expect(renames).toEqual([]);
  expect(written.length).toBeGreaterThan(0);
  expect(written.filter((name) => name.startsWith("temp-"))).toEqual([]);
  for (const out of [outA, outB])
    expect(
      (await fsp.readdir(out)).some((n) => n.startsWith("alcove-results-")),
    ).toBe(true);
  expect(await fsp.readdir(shared)).toEqual([]);
}, 120_000);
