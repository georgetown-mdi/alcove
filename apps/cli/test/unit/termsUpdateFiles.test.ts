import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getLogger, UsageError } from "@alcove/core";

import {
  readPartnershipConfig,
  readPartnershipSecret,
} from "../../src/termsUpdateFiles";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-terms-update-files-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readPartnershipConfig refuses a configuration it cannot read as a usage error", () => {
  // A directory where the configuration should be is there but cannot be read:
  // the operator's path to fix, not a transport failure to retry.
  const configPath = path.join(dir, "alcove.yaml");
  fs.mkdirSync(configPath);
  expect(() => readPartnershipConfig(configPath)).toThrow(UsageError);
  expect(() => readPartnershipConfig(configPath)).toThrow(
    /config file .*alcove\.yaml could not be read/,
  );
});

test("readPartnershipSecret warns nothing for a key file with unread fields and a loose mode", () => {
  const keyPath = path.join(dir, ".alcove.key");
  const secret = "A".repeat(43);
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ sharedSecret: secret, expiry: 1 }),
    {
      mode: 0o644,
    },
  );
  fs.chmodSync(keyPath, 0o644);
  const warn = vi
    .spyOn(getLogger("key-file"), "warn")
    .mockImplementation(() => {});
  try {
    expect(readPartnershipSecret(keyPath)).toBe(secret);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
