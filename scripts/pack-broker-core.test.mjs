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
  BROKER_CORE_ENTRIES,
  MANIFEST_NAME,
  SIGNALING_BROKER_ENTRY,
  WEBSOCKET_RELAY_ENTRY,
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
      [SIGNALING_BROKER_ENTRY]:
        "export { a } from './shared2.esm.js';\nimport './sub/deep.esm.js';\n",
      "shared2.esm.js":
        "import { createHash } from 'node:crypto';\nexport * from './sub/deep.esm.js';\nexport const a = createHash;\n",
      "sub/deep.esm.js": "import '../shared2.esm.js';\nexport const d = 1;\n",
      "core.esm.js": "import 'zod';\n",
    });
    expect(brokerCoreFiles(dist, [SIGNALING_BROKER_ENTRY])).toEqual([
      "shared2.esm.js",
      "sub/deep.esm.js",
      SIGNALING_BROKER_ENTRY,
    ]);
  });

  it("follows the signaling broker's and the WebSocket relay's entries by default, a shared chunk once", () => {
    expect(BROKER_CORE_ENTRIES).toEqual([
      SIGNALING_BROKER_ENTRY,
      WEBSOCKET_RELAY_ENTRY,
    ]);
    const dist = distOf({
      [SIGNALING_BROKER_ENTRY]: "export * from './shared2.esm.js';\n",
      [WEBSOCKET_RELAY_ENTRY]:
        "export * from './shared2.esm.js';\nexport * from './shared4.esm.js';\n",
      "shared2.esm.js": "export const s = 1;\n",
      "shared4.esm.js": "export const r = 1;\n",
      "core.esm.js": "import 'zod';\n",
    });
    expect(brokerCoreFiles(dist)).toEqual([
      "shared2.esm.js",
      "shared4.esm.js",
      SIGNALING_BROKER_ENTRY,
      WEBSOCKET_RELAY_ENTRY,
    ]);
  });

  it("refuses a package import anywhere in the closure", () => {
    const dist = distOf({
      [SIGNALING_BROKER_ENTRY]: "export * from './shared2.esm.js';\n",
      "shared2.esm.js": "import { z } from 'zod';\nexport const s = z;\n",
    });
    expect(() => brokerCoreFiles(dist, [SIGNALING_BROKER_ENTRY])).toThrow(
      /imports "zod"/,
    );
  });

  it("refuses an import resolving outside the dist directory", () => {
    const dist = distOf({
      [SIGNALING_BROKER_ENTRY]: "export * from '../src/x.js';\n",
    });
    expect(() => brokerCoreFiles(dist, [SIGNALING_BROKER_ENTRY])).toThrow(
      /resolves outside/,
    );
  });

  it("refuses a chunk the entry imports that is missing", () => {
    const dist = distOf({
      [SIGNALING_BROKER_ENTRY]: "export * from './gone.esm.js';\n",
    });
    expect(() => brokerCoreFiles(dist, [SIGNALING_BROKER_ENTRY])).toThrow(
      /gone\.esm\.js, imported by untrusted-text\.esm\.js, is not a file/,
    );
  });

  it("refuses a dist directory without the entry", () => {
    expect(() => brokerCoreFiles(distOf({}))).toThrow(
      /npm run build -w packages\/core/,
    );
  });

  it("refuses a build without the WebSocket relay's entry", () => {
    const dist = distOf({
      [SIGNALING_BROKER_ENTRY]: "export const s = 1;\n",
    });
    expect(() => brokerCoreFiles(dist)).toThrow(
      /^websocket-relay\.esm\.js is not a file under /,
    );
  });

  it("finds both entries and at least one chunk in the real build", () => {
    const files = brokerCoreFiles(coreDist);
    expect(files).toContain(SIGNALING_BROKER_ENTRY);
    expect(files).toContain(WEBSOCKET_RELAY_ENTRY);
    expect(files.length).toBeGreaterThan(2);
  });
});

describe("packBrokerCore", () => {
  const dist = distOf({
    [SIGNALING_BROKER_ENTRY]: "export * from './shared2.esm.js';\n",
    [WEBSOCKET_RELAY_ENTRY]:
      "export * from './shared2.esm.js';\nexport * from './shared4.esm.js';\n",
    "shared2.esm.js": "export const s = 1;\n",
    "shared4.esm.js": "export const r = 1;\n",
    "core.esm.js": "export const unrelated = 1;\n",
  });
  const packed = [
    "shared2.esm.js",
    "shared4.esm.js",
    SIGNALING_BROKER_ENTRY,
    WEBSOCKET_RELAY_ENTRY,
  ];

  it("copies both closures alone, with a manifest sha256sum accepts for every file", () => {
    const out = join(scratch(), "out");
    expect(packBrokerCore(dist, out)).toEqual([...packed, MANIFEST_NAME]);
    expect(readdirSync(out).sort()).toEqual([...packed, MANIFEST_NAME].sort());
    expect(
      execFileSync("sha256sum", ["-c", MANIFEST_NAME], {
        cwd: out,
        encoding: "utf8",
      }),
    ).toBe(packed.map((file) => `${file}: OK\n`).join(""));
  });

  it.each(["shared2.esm.js", "shared4.esm.js", WEBSOCKET_RELAY_ENTRY])(
    "writes a manifest sha256sum rejects once %s changes",
    (file) => {
      const out = join(scratch(), "out");
      packBrokerCore(dist, out);
      writeFileSync(join(out, file), "export const changed = 2;\n");
      expect(() =>
        execFileSync("sha256sum", ["--quiet", "-c", MANIFEST_NAME], {
          cwd: out,
          stdio: "pipe",
        }),
      ).toThrow();
    },
  );

  it("refuses an output directory that already exists", () => {
    const out = scratch();
    expect(() => packBrokerCore(dist, out)).toThrow(/EEXIST/);
  });

  it("refuses a closure holding the manifest's own name", () => {
    const clash = distOf({
      [SIGNALING_BROKER_ENTRY]: `export * from './${MANIFEST_NAME}';\n`,
      [WEBSOCKET_RELAY_ENTRY]: "export const r = 1;\n",
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
    expect(printed).toBe([...packed, MANIFEST_NAME, ""].join("\n"));
    expect(readFileSync(join(out, MANIFEST_NAME), "utf8")).toMatch(
      /^[0-9a-f]{64} {2}shared2\.esm\.js\n[0-9a-f]{64} {2}shared4\.esm\.js\n[0-9a-f]{64} {2}untrusted-text\.esm\.js\n[0-9a-f]{64} {2}websocket-relay\.esm\.js\n$/,
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
