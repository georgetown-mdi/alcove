import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";
import type { Arguments } from "yargs";
import { FileSyncConnection, INACTIVITY_TIMEOUT_KEY } from "@alcove/core";

import { applyConnectionOverrides } from "../../../src/config";
import { LocalFSClient } from "../../../src/connection/localFSClient";
import {
  INACTIVITY_TIMEOUT_FLAG,
  INACTIVITY_TIMEOUT_GUIDANCE,
  inactivityTimeoutGuidance,
} from "../../../src/connection/timeoutGuidance";
import {
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
} from "../../../src/optionDefinitions";

const occurrences = (text: string, key: string): number =>
  text.split(key).length - 1;

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("the guidance names the setting only when the message does not", () => {
  expect(INACTIVITY_TIMEOUT_GUIDANCE).not.toContain(INACTIVITY_TIMEOUT_KEY);
  expect(INACTIVITY_TIMEOUT_GUIDANCE).toContain("raise that limit");
  expect(inactivityTimeoutGuidance(false)).toContain(
    `raise ${INACTIVITY_TIMEOUT_KEY} under connection.options`,
  );
});

test("the guidance names the flag alongside the setting", () => {
  for (const guidance of [
    INACTIVITY_TIMEOUT_GUIDANCE,
    inactivityTimeoutGuidance(false),
  ])
    expect(guidance).toContain(
      "run again with a longer --inactivity-timeout, or raise",
    );
});

test("the flag the guidance names is the one that sets the setting", () => {
  const parsed = parseCommonBootstrapArgs({
    _: [],
    $0: "alcove",
    [INACTIVITY_TIMEOUT_FLAG.replace(/^--/, "")]: "90s",
  } as unknown as Arguments);
  expect(
    applyConnectionOverrides(
      { channel: "filedrop", path: "/mnt/share/drop" },
      connectionOverridesFrom(parsed),
    ).options?.inactivityTimeoutMs,
  ).toBe(90_000);
});

test("a file-sync timeout failure names inactivity_timeout_ms once", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "timeout-guidance-"));
  const client = new LocalFSClient();
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    inactivityTimeoutGuidance: INACTIVITY_TIMEOUT_GUIDANCE,
  });
  await conn.open({
    channel: "filedrop",
    path: directory,
    options: { inactivityTimeoutMs: 50 },
  });
  conn.peerId = "stub-peer";
  client.put = () => new Promise<void>(() => {});
  const failure = await conn.send({ first: true }).then(
    () => undefined,
    (err: unknown) => err,
  );
  const message = String(failure);
  expect(message).toContain(`(the limit ${INACTIVITY_TIMEOUT_KEY} sets)`);
  expect(message).toContain(INACTIVITY_TIMEOUT_GUIDANCE);
  expect(occurrences(message, INACTIVITY_TIMEOUT_KEY)).toBe(1);
  await conn.close();
});
