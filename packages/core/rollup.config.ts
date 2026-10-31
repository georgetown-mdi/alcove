import { createRequire } from "node:module";
import { defineConfig } from "rollup";

import { dts } from "rollup-plugin-dts";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

import { bundleNotices } from "../../scripts/lib/bundleNotices.mjs";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// Packages bundled into the output rather than kept as peer dependencies.
// @openmined/psi.js is always bundled (WASM, no npm-installable form).
// canonicalize is always bundled: Node 26 `require`s it as a module namespace,
// and the CJS output's default `interop` calls that namespace as the default
// export, so an external build fails with "canonicalize is not a function".
// `interop: "compat"` would fix that for every external; inlining the one
// function is narrower. Measured: docs/spec/DEPENDENCY_PINS.md, "Inlined
// dependencies and their remediation path".
const ALWAYS_BUNDLED = new Set(["@openmined/psi.js", "canonicalize"]);

// Returns an `external` predicate that matches bare package names and their
// subpath exports (e.g. both "yaml" and "yaml/util").
function makeExternal(bundled: Set<string>) {
  const allDeps = Object.keys(pkg.dependencies as Record<string, string>);
  const externalRoots = allDeps.filter((name) => !bundled.has(name));
  return (id: string) =>
    externalRoots.some((dep) => id === dep || id.startsWith(dep + "/"));
}

export default defineConfig([
  // The published entry points build TOGETHER, with code splitting, so a module
  // more than one of them reaches exists once at run time. Built separately they
  // would each hold their own copy of every class they share: the testing entry
  // publishes CsvRowParseError, the untrusted-text entry JsonStructureBoundError
  // and the websocket-relay entry WebSocketRelayProofRefusedError, and a second
  // copy of any of them would fail an `instanceof` against a refusal the main
  // entry threw.
  {
    input: {
      core: "src/main.ts",
      testing: "src/testing.ts",
      "untrusted-text": "src/untrustedText.ts",
      "websocket-relay": "src/websocketRelay.ts",
    },
    external: makeExternal(ALWAYS_BUNDLED),
    // resolve() lets rollup inline the ALWAYS_BUNDLED packages (currently
    // canonicalize) from node_modules; everything else is held external by the
    // `external` predicate above, so only the bundled set is pulled in.
    // tsconfig.rollup.json: see docs/notes/core-dist-cache-buildinfo.md.
    // bundleNotices() heads each chunk with the license text of what it
    // inlines, which the console server and SFTP relay bundles carry onward.
    plugins: [
      resolve(),
      typescript({ tsconfig: "./tsconfig.rollup.json" }),
      bundleNotices(),
    ],
    // `[name]` is the input key above, so the entry names have to stay `core`,
    // `testing`, `untrusted-text` and `websocket-relay`: package.json points
    // main, module, and every `exports` condition at dist/core.*,
    // dist/testing.*, dist/untrusted-text.* and dist/websocket-relay.*. A
    // manifest rename that left these alone is caught by the dist freshness
    // guard, which derives the files it looks for from that exports map
    // (scripts/lib/distFreshness.mjs). The chunk name is
    // fixed rather than hashed so a rebuild overwrites the shared chunk instead
    // of leaving the previous one behind in a published dist.
    output: [
      {
        dir: "dist",
        format: "cjs",
        entryFileNames: "[name].cjs",
        chunkFileNames: "shared.cjs",
      },
      {
        dir: "dist",
        format: "es",
        entryFileNames: "[name].esm.js",
        chunkFileNames: "shared.esm.js",
      },
    ],
  },
  // The main and testing entries' declaration files build TOGETHER for the same
  // reason their JS output does above: a type testing.ts's surface shares with
  // main.ts's -- PreparedExchange and ExchangeResult, whose dataset field holds
  // a StandardizedDataset, a class with a private member -- has to resolve to
  // ONE declaration. Built as two independent dts() passes, each would emit its
  // own private-field-bearing copy of that class, and TypeScript treats two such
  // copies as different types even though the source is identical: a testing.ts
  // fixture typed against one copy would not assign to a main-entry parameter
  // typed against the other. untrusted-text.ts and websocketRelay.ts stay
  // separate passes: neither public surface shares a class with a private
  // member with main.ts's.
  {
    input: {
      index: "src/main.ts",
      testing: "src/testing.ts",
    },
    output: {
      dir: "dist",
      format: "es",
      entryFileNames: "[name].d.ts",
      chunkFileNames: "shared-types.d.ts",
    },
    plugins: [dts()],
  },
  {
    input: "src/untrustedText.ts",
    output: { file: "dist/untrusted-text.d.ts", format: "es" },
    plugins: [dts()],
  },
  {
    input: "src/websocketRelay.ts",
    output: { file: "dist/websocket-relay.d.ts", format: "es" },
    plugins: [dts()],
  },
]);
