import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { referencedCredentialPaths } from "@jobs/referencedCredentialFiles";
import { trackScratchDirs } from "../../utils/jobFixtures";

import type { ExchangeSpec } from "@alcove/core";

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  removeScratchDirs();
});

/** Only the fields the helper reads; the rest of a document is irrelevant to
 * it. */
function openedDocument(fields: {
  password?: string;
  privateKey?: string;
  identityFile?: string;
}): ExchangeSpec {
  return {
    connection: {
      channel: "sftp",
      server: {
        host: "sftp.partner.example",
        ...(fields.password !== undefined ? { password: fields.password } : {}),
        ...(fields.privateKey !== undefined
          ? { privateKey: fields.privateKey }
          : {}),
      },
    },
    ...(fields.identityFile !== undefined
      ? { signing: { mode: "certificate", identityFile: fields.identityFile } }
      : {}),
  } as unknown as ExchangeSpec;
}

describe("referencedCredentialPaths", () => {
  test("collects the authored connection's and the opened configuration's credential files", () => {
    const dataRoot = scratchDir("data");
    for (const name of ["authored-pw", "opened-key", "identity.json"])
      fs.writeFileSync(path.join(dataRoot, name), "x");
    const paths = referencedCredentialPaths(
      dataRoot,
      {
        host: "sftp.partner.example",
        password: `@${path.join(dataRoot, "authored-pw")}`,
        hostKeyFingerprint: "SHA256:unused",
      },
      openedDocument({
        privateKey: "@opened-key",
        identityFile: "identity.json",
      }),
    );
    expect([...paths].sort()).toEqual(
      ["authored-pw", "identity.json", "opened-key"].map((name) =>
        fs.realpathSync(path.join(dataRoot, name)),
      ),
    );
  });

  test("an inline value or a reference naming no file adds nothing", () => {
    const dataRoot = scratchDir("data");
    const paths = referencedCredentialPaths(
      dataRoot,
      undefined,
      openedDocument({ password: "not-a-reference", privateKey: "@absent" }),
    );
    expect(paths.size).toBe(0);
  });
});
