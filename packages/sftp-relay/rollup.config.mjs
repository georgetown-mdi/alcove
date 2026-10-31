import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import ts from "typescript";

import { bundleNotices } from "../../scripts/lib/bundleNotices.mjs";

// The image's one file: the standalone runner with every module it reaches,
// `ws` and the workspace sources included, so the runtime stage ships no
// node_modules, and the license text of each package it inlines at its head.
// Each TypeScript module is transpiled on its own, as tsx and vitest do; `npm
// run typecheck` is what checks the types.
const transpileTypeScript = {
  name: "transpile-typescript",
  transform(code, id) {
    if (!id.endsWith(".ts")) return null;
    const { outputText } = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        allowImportingTsExtensions: true,
      },
    });
    return { code: outputText, map: null };
  },
};

export default {
  input: "src/standalone.ts",
  output: { file: "dist/sftp-relay.mjs", format: "es" },
  plugins: [
    transpileTypeScript,
    nodeResolve({ preferBuiltins: true, exportConditions: ["node"] }),
    commonjs(),
    bundleNotices(),
  ],
};
