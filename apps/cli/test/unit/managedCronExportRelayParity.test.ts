import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { COMMAND_LINE_EXPORT_RELAY_CASES } from "@alcove/core/testing";

import { loadConfig } from "../../src/commands/exchange";
import { saveKeyFile } from "../../src/keyFile";
import { relayRegistrarForRun } from "../../src/relayRegistrar";
import { relayRegistrarUnusedNotice } from "../../src/relayKeyRotation";

// The CLI half of the command-line export relay set (`@alcove/core/testing`,
// whose module header states what it holds). `packages/` cannot import
// `apps/`, so driving the set through this app's loader belongs in its own
// test tree; the web half is
// apps/web/test/unit/psi/managedCronExportRelayParity.test.ts, which holds each
// document to what the web app's export writes.

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-cron-export-relay-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test.each(Object.entries(COMMAND_LINE_EXPORT_RELAY_CASES))(
  "the CLI loads the %s export and registers where its run relays",
  (_id, one) => {
    const configFile = path.join(dir, "alcove.yaml");
    const keyFile = path.join(dir, ".alcove.key");
    fs.writeFileSync(configFile, one.document);
    saveKeyFile(keyFile, { sharedSecret: TOKEN });

    const { connection } = loadConfig({ configFile, keyFile });

    expect(connection.channel).toBe("webrtc");
    expect(relayRegistrarForRun(connection) ?? null).toEqual(one.runRegistrar);
    expect(relayRegistrarUnusedNotice(connection)).toBeUndefined();
  },
);
