// What the Workflow-script suites (panel-script.test.mjs,
// review-round-script.test.mjs, judgment-call-controversy-script.test.mjs)
// share: the compiled script under test, the two shapes the harness delivers
// arguments in, and the deliveries that resolve no named argument.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** The text of a checked-in file, by its path from the repository root. */
export function readRepoFile(path) {
  return readFileSync(resolve(root, path), "utf8");
}

/**
 * The checked-in script at `scriptPath` compiled into a function of the names
 * the Workflow runtime injects, `args` first. It is a Workflow script body
 * rather than a module: `export const meta` is the one module-only spelling in
 * it, and a top-level `return` is legal in a function body.
 */
export function compileScript(scriptPath, injectedNames) {
  const body = readRepoFile(scriptPath).replace(
    /^export const meta =/m,
    "const meta =",
  );
  return new AsyncFunction(...injectedNames, body);
}

/**
 * The harness may deliver the arguments as JSON text rather than as the object
 * the caller passed, so a suite runs every case under both shapes.
 */
export const SHAPES = [
  { shape: "object", deliver: (args) => args },
  { shape: "string", deliver: (args) => JSON.stringify(args) },
];

/**
 * Every delivery that is not an object of named arguments, and so resolves no
 * field a script needs.
 */
export const UNRESOLVABLE = [[], 42, "text", true, null, undefined];
