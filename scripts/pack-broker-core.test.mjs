import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  BROKER_CORE_ENTRY,
  MANIFEST_NAME,
  brokerCoreFiles,
  moduleSpecifiers,
  packBrokerCore,
} from "./pack-broker-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const coreDist = join(repoRoot, "packages/core/dist");

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "pack-broker-core-"));
  roots.push(root);
  return root;
}

/** A dist directory holding `files`, each name to its source text. */
function distOf(files) {
  const dist = join(scratch(), "dist");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), text);
  }
  return dist;
}

describe("moduleSpecifiers", () => {
  it("reads static imports, re-exports and literal dynamic imports", () => {
    expect(
      moduleSpecifiers(
        [
          "import { a } from './a.esm.js';",
          "export { b as c } from './b.esm.js';",
          "export * from './d.esm.js';",
          "const e = await import('./e.esm.js');",
          "import 'node:crypto';",
        ].join("\n"),
      ),
    ).toEqual([
      "./a.esm.js",
      "./b.esm.js",
      "./d.esm.js",
      "./e.esm.js",
      "node:crypto",
    ]);
  });
});

describe("brokerCoreFiles", () => {
  it("follows chunk imports transitively, each file once, and skips builtins", () => {
    const dist = distOf({
      [BROKER_CORE_ENTRY]:
        "export { a } from './shared2.esm.js';\nimport './sub/deep.esm.js';\n",
      "shared2.esm.js":
        "import { createHash } from 'node:crypto';\nexport * from './sub/deep.esm.js';\nexport const a = createHash;\n",
      "sub/deep.esm.js": "import '../shared2.esm.js';\nexport const d = 1;\n",
      "core.esm.js": "import 'zod';\n",
    });
    expect(brokerCoreFiles(dist)).toEqual([
      "shared2.esm.js",
      "sub/deep.esm.js",
      BROKER_CORE_ENTRY,
    ]);
  });

  it("refuses a package import anywhere in the closure", () => {
    const dist = distOf({
      [BROKER_CORE_ENTRY]: "export * from './shared2.esm.js';\n",
      "shared2.esm.js": "import { z } from 'zod';\nexport const s = z;\n",
    });
    expect(() => brokerCoreFiles(dist)).toThrow(/imports "zod"/);
  });

  it("refuses an import resolving outside the dist directory", () => {
    const dist = distOf({
      [BROKER_CORE_ENTRY]: "export * from '../src/x.js';\n",
    });
    expect(() => brokerCoreFiles(dist)).toThrow(/resolves outside/);
  });

  it("refuses a chunk the entry imports that is missing", () => {
    const dist = distOf({
      [BROKER_CORE_ENTRY]: "export * from './gone.esm.js';\n",
    });
    expect(() => brokerCoreFiles(dist)).toThrow(
      /gone\.esm\.js, imported by untrusted-text\.esm\.js, is not a file/,
    );
  });

  it("refuses a dist directory without the entry", () => {
    expect(() => brokerCoreFiles(distOf({}))).toThrow(
      /npm run build -w packages\/core/,
    );
  });

  it("finds the entry and at least one chunk in the real build", () => {
    const files = brokerCoreFiles(coreDist);
    expect(files).toContain(BROKER_CORE_ENTRY);
    expect(files.length).toBeGreaterThan(1);
  });
});

describe("packBrokerCore", () => {
  const dist = distOf({
    [BROKER_CORE_ENTRY]: "export * from './shared2.esm.js';\n",
    "shared2.esm.js": "export const s = 1;\n",
    "core.esm.js": "export const unrelated = 1;\n",
  });

  it("copies the closure alone, with a manifest sha256sum accepts", () => {
    const out = join(scratch(), "out");
    expect(packBrokerCore(dist, out)).toEqual([
      "shared2.esm.js",
      BROKER_CORE_ENTRY,
      MANIFEST_NAME,
    ]);
    expect(readdirSync(out).sort()).toEqual(
      [MANIFEST_NAME, "shared2.esm.js", BROKER_CORE_ENTRY].sort(),
    );
    expect(
      execFileSync("sha256sum", ["-c", MANIFEST_NAME], {
        cwd: out,
        encoding: "utf8",
      }),
    ).toBe(`shared2.esm.js: OK\n${BROKER_CORE_ENTRY}: OK\n`);
  });

  it("writes a manifest sha256sum rejects once a file changes", () => {
    const out = join(scratch(), "out");
    packBrokerCore(dist, out);
    writeFileSync(join(out, "shared2.esm.js"), "export const s = 2;\n");
    expect(() =>
      execFileSync("sha256sum", ["--quiet", "-c", MANIFEST_NAME], {
        cwd: out,
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("refuses an output directory that already exists", () => {
    const out = scratch();
    expect(() => packBrokerCore(dist, out)).toThrow(/EEXIST/);
  });

  it("refuses a closure holding the manifest's own name", () => {
    const clash = distOf({
      [BROKER_CORE_ENTRY]: `export * from './${MANIFEST_NAME}';\n`,
      [MANIFEST_NAME]: "export const s = 1;\n",
    });
    expect(() => packBrokerCore(clash, join(scratch(), "out"))).toThrow(
      /manifest's own name/,
    );
  });

  it("names each file on stdout when run as a command, the manifest last", () => {
    const out = join(scratch(), "out");
    const printed = execFileSync(
      process.execPath,
      [join(here, "pack-broker-core.mjs"), dist, out],
      { encoding: "utf8" },
    );
    expect(printed).toBe(
      `shared2.esm.js\n${BROKER_CORE_ENTRY}\n${MANIFEST_NAME}\n`,
    );
    expect(readFileSync(join(out, MANIFEST_NAME), "utf8")).toMatch(
      /^[0-9a-f]{64} {2}shared2\.esm\.js\n[0-9a-f]{64} {2}untrusted-text\.esm\.js\n$/,
    );
  });

  it("exits 1 with a message when the build is missing", () => {
    let failure;
    try {
      execFileSync(
        process.execPath,
        [
          join(here, "pack-broker-core.mjs"),
          distOf({}),
          join(scratch(), "out"),
        ],
        { stdio: "pipe" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toMatch(/^pack-broker-core: /);
  });
});
