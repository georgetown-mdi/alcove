import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { COMMAND_LINE_EXPORT_RELAY_CASES } from "@alcove/core/testing";

import { loadConfig } from "../../src/commands/exchange";
import { saveKeyFile } from "../../src/keyFile";
import { relayRegistrarForRun } from "../../src/relayRegistrar";
import { relayRegistrarUnusedNotice } from "../../src/relayKeyRotation";

// The CLI half of the set in `@alcove/core/testing`; its module header states the design.

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-cron-export-relay-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test.each(
  Object.values(COMMAND_LINE_EXPORT_RELAY_CASES).map(
    (one) => [one.because, one] as const,
  ),
)("%s", (_because, one) => {
  const configFile = path.join(dir, "alcove.yaml");
  const keyFile = path.join(dir, ".alcove.key");
  fs.writeFileSync(configFile, one.document);
  saveKeyFile(keyFile, { sharedSecret: TOKEN });

  const { connection } = loadConfig({ configFile, keyFile });

  expect(connection.channel).toBe("webrtc");
  expect(relayRegistrarForRun(connection) ?? null).toEqual(one.runRegistrar);
  expect(relayRegistrarUnusedNotice(connection)).toBeUndefined();
});
