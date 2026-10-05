import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import repoConfig from "../eslint.config.mjs";
import { withoutTypeAwareLayer } from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the `node:` import ban in apps/web/eslint.config.js: a file in the
// browser bundle may not import a Node built-in, and the server-only files under
// src/ (serverOnlySrcFiles there) may. Flat config replaces a rule's options
// rather than merging them, so the ban rides in three blocks' options and the
// server-only files take theirs back in two blocks of their own; the cases below
// hold both directions, and that the server-only blocks keep the other import
// bans. Linted through the repo-root config with the type-aware layer stripped,
// as the sibling eslint-*.test.mjs files do.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** no-restricted-imports messages reported for `source` linted as `file`. */
async function importHits(file, source) {
  const filePath = resolve(repoRoot, file);
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${file}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

const NODE_PATH_IMPORT = 'import { posix } from "node:path";\n\nvoid posix;\n';

// One client file from each block that holds the ban: above the products, below
// them, and the linkage-compare chokepoint, which has a block of its own.
const CLIENT_FILES = [
  "apps/web/src/recurring/scheduledRunCommand.ts",
  "apps/web/src/exchange/Lobby.tsx",
  "apps/web/src/psi/runOutputs.ts",
  "apps/web/src/components/AppPage.tsx",
  "apps/web/src/psi/linkageComparison.ts",
];

const SERVER_ONLY_FILES = [
  "apps/web/src/jobs/workdir.ts",
  "apps/web/src/routes/api/jobs/config.ts",
  "apps/web/src/server.ts",
  "apps/web/src/utils/serverConfig.ts",
];

describe("web node: import ban", () => {
  it("refuses the hand-off panel's node:path import, naming the import", async () => {
    const hits = await importHits(
      "apps/web/src/recurring/scheduledRunCommand.ts",
      NODE_PATH_IMPORT,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/^'node:path' import is restricted/);
    expect(hits[0].message).toMatch(/browser bundle/);
  });

  it.each(CLIENT_FILES)("refuses a node: import in %s", async (file) => {
    expect(await importHits(file, NODE_PATH_IMPORT)).toHaveLength(1);
    expect(
      await importHits(file, 'export { readFileSync } from "node:fs";\n'),
    ).toHaveLength(1);
  });

  it("allows a type-only node: import in a client file", async () => {
    expect(
      await importHits(
        "apps/web/src/exchange/Lobby.tsx",
        'import type { AddressInfo } from "node:net";\n\nexport type A = AddressInfo;\n',
      ),
    ).toHaveLength(0);
  });

  it.each(SERVER_ONLY_FILES)(
    "allows a node: import in the server-only %s",
    async (file) => {
      expect(await importHits(file, NODE_PATH_IMPORT)).toHaveLength(0);
    },
  );

  it.each(SERVER_ONLY_FILES)(
    "keeps the other import bans on the server-only %s",
    async (file) => {
      const hits = await importHits(
        file,
        'import { encodeForComparison } from "@alcove/core";\n\nvoid encodeForComparison;\n',
      );
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toMatch(/linkageComparison/);
    },
  );

  it("keeps the layer-direction ban on a server-only file below the products", async () => {
    const hits = await importHits(
      "apps/web/src/jobs/workdir.ts",
      'import { Lobby } from "@exchange/Lobby";\n\nvoid Lobby;\n',
    );
    expect(hits).toHaveLength(1);
  });
});
