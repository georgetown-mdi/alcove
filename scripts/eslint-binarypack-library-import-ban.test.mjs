import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import repoConfig from "../eslint.config.mjs";
import { withoutTypeAwareLayer } from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the peerjs-js-binarypack import ban in the repo-root
// eslint.config.mjs: core's BinaryPack encoder and structural pre-scan never
// import the library their differential suites compare them against
// (docs/spec/DEPENDENCY_PINS.md). A ban that stops matching keeps reporting
// zero problems, indistinguishable from clean source, so each case is linted
// through the real repo config against the two guarded paths, with the
// type-aware layer stripped so no TypeScript program is built.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

const GUARDED_FILES = [
  resolve(repoRoot, "packages/core/src/connection/binaryPackEncode.ts"),
  resolve(repoRoot, "packages/core/src/connection/binaryPackBounds.ts"),
];

// Core's PeerJS framing unpacks with the library, so the ban must not reach it.
const UNGUARDED_FILE = resolve(
  repoRoot,
  "packages/core/src/connection/peerjsWire.ts",
);

const LINT_TIMEOUT_MS = 30_000;

/** The no-restricted-imports messages `source` draws linted as `filePath`. A
 * source that does not parse throws rather than counting as zero problems. */
async function importBanMessages(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

async function binaryPackHits(filePath, source) {
  return (await importBanMessages(filePath, source)).filter((message) =>
    message.includes("Do not import peerjs-js-binarypack here"),
  );
}

const FLAGGED = [
  ["a named value import", 'import { pack } from "peerjs-js-binarypack";'],
  ["a namespace import", 'import * as binaryPack from "peerjs-js-binarypack";'],
  [
    "a type-only import",
    'import type { Packable } from "peerjs-js-binarypack";',
  ],
  [
    "a subpath import",
    'import { Packer } from "peerjs-js-binarypack/dist/binarypack.mjs";',
  ],
  ["a named re-export", 'export { unpack } from "peerjs-js-binarypack";'],
  ["an `export *`", 'export * from "peerjs-js-binarypack";'],
];

describe(
  "the peerjs-js-binarypack import ban",
  { timeout: LINT_TIMEOUT_MS },
  () => {
    for (const filePath of GUARDED_FILES) {
      for (const [label, source] of FLAGGED) {
        it(`rejects ${label} in ${relative(repoRoot, filePath)}`, async () => {
          expect(await binaryPackHits(filePath, `${source}\n`)).toHaveLength(1);
        });
      }

      it(`accepts a near-miss specifier in ${relative(repoRoot, filePath)}`, async () => {
        expect(
          await binaryPackHits(
            filePath,
            'import { pack } from "peerjs-js-binarypack-fork";\n',
          ),
        ).toHaveLength(0);
      });

      it(`keeps core's raw YAML parser and app-import bans in ${relative(repoRoot, filePath)}`, async () => {
        const messages = await importBanMessages(
          filePath,
          'import { parse } from "yaml";\nimport { x } from "../../../../apps/cli/src/x";\n',
        );
        expect(messages).toEqual([
          expect.stringContaining("do not import yaml's raw parsers"),
          expect.stringContaining("a package must not import from an app"),
        ]);
      });
    }

    it("does not reach core's PeerJS framing, which unpacks with the library", async () => {
      expect(
        await binaryPackHits(
          UNGUARDED_FILE,
          'import { unpack } from "peerjs-js-binarypack";\n',
        ),
      ).toHaveLength(0);
    });

    it("passes the guarded files as they stand", async () => {
      const results = await eslint.lintFiles(GUARDED_FILES);
      const hits = results.flatMap((result) =>
        result.messages.filter(
          (message) => message.ruleId === "no-restricted-imports",
        ),
      );
      expect(hits).toEqual([]);
    });
  },
);
