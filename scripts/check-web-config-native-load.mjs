#!/usr/bin/env node
// Web config native-load check: `npm run check:web-config-native-load`, run by
// static_checks.yaml on every pull request. apps/web/vite.config.ts and every
// module it imports must load under Node's strip-only type stripping, which
// refuses TypeScript needing generated code (a parameter property, an `enum`,
// a non-`declare` `namespace`, an `import x = require(...)` alias). Two loaders
// are driven, each in a child process: Vite's `configLoader: "native"` and a
// plain `node` import, both with `command: "serve"` and with NODE_OPTIONS and
// VITEST scrubbed. Each is first driven against a control fixture holding only
// a parameter property, and a control that loads fails the check: the loader
// is no longer strip-only, so nothing is measured.
//
// Measures the installed Vite and the running Node only. Exit 0 clean, 1 when
// either loader refuses the config or a control misbehaves. Rationale and
// limits: docs/notes/repo-check-scripts.md.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHILD_FLAG,
  LOAD_STATUSES,
  loadConfigInChild,
  runChildLoad,
} from "./lib/configLoadHarness.mjs";

/** The config this check guards, relative to the repository root. */
export const WEB_CONFIG = "apps/web/vite.config.ts";

/** Node's refusal of a construct strip-only type stripping cannot erase. */
export const REJECTION_CODE = "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";

async function loadThroughVite(configFile, viteFrom) {
  // Resolve Vite from the web app rather than from this script or from the file
  // being loaded: the workspace copy the web config would really be loaded by is
  // the one to drive, and the control fixture -- which sits outside the
  // repository and so resolves no bare specifier of its own -- has to be driven
  // through that same copy for its refusal to say anything about this one.
  const require = createRequire(pathToFileURL(viteFrom));
  const { loadConfigFromFile } = await import(
    pathToFileURL(require.resolve("vite")).href
  );
  await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configFile,
    dirname(configFile),
    // Silent: the loader's own "failed to load config from ..." line adds
    // nothing to the error this check reports, and would be the first thing a
    // contributor read on an unrelated failure.
    "silent",
    undefined,
    "native",
  );
}

async function loadThroughNode(configFile) {
  await import(pathToFileURL(configFile).href);
}

/**
 * The load paths driven, in the order they run. `label` is how a failure names
 * the leg to a contributor.
 */
export const LOADERS = [
  {
    id: "vite-native",
    label: 'Vite\'s `configLoader: "native"`',
    load: loadThroughVite,
  },
  {
    id: "node-import",
    label: "a plain `node` import",
    load: loadThroughNode,
  },
];

/**
 * Write the control fixture into `directory`: a config whose import graph holds
 * one constructor parameter property and nothing else. Both loaders must refuse
 * it, or they are no longer strip-only and this check measures nothing.
 *
 * The `package.json` pins the module format, so the fixture cannot pick up a
 * `type` from whatever directory the temp root happens to sit under.
 */
export function writeStripOnlyControl(directory) {
  writeFileSync(join(directory, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(directory, "parameterProperty.ts"),
    "export class ParameterProperty {\n" +
      "  constructor(private readonly value: string) {}\n" +
      "}\n",
  );
  const configFile = join(directory, "vite.config.ts");
  writeFileSync(
    configFile,
    'import { ParameterProperty } from "./parameterProperty.ts";\n' +
      "\n" +
      "export default { define: { probe: ParameterProperty.name } };\n",
  );
  return configFile;
}

/**
 * Load `configFile` through the loader named by `loaderId`, in a child `node`
 * process, and report `{ok, code, output}` -- `code` being the `code` property
 * of whatever the load threw, or null on success. `viteFrom` is the file Vite is
 * resolved from (see loadThroughVite); the plain-import loader ignores it.
 */
export function loadInChildProcess(loaderId, configFile, viteFrom) {
  return loadConfigInChild({
    childModule: import.meta.url,
    args: [loaderId, configFile, viteFrom],
  });
}

/**
 * Drive both load paths against the control fixture and then against the web
 * config, and report `{ok, status, message}`.
 *
 * Statuses: `loads` (ok), `missing`, `control-loaded`,
 * `control-failed-otherwise`, `refused`.
 *
 * `load` is injectable so a test can drive the outcomes without spawning.
 */
export function checkWebConfigNativeLoad({
  root,
  load = loadInChildProcess,
} = {}) {
  const configFile = resolve(root, WEB_CONFIG);
  if (!existsSync(configFile)) {
    return {
      ok: false,
      status: LOAD_STATUSES.missing,
      message: `${WEB_CONFIG} is absent, so there is nothing to load.`,
    };
  }

  const controlDirectory = mkdtempSync(join(tmpdir(), "web-config-control-"));
  try {
    const control = writeStripOnlyControl(controlDirectory);
    for (const loader of LOADERS) {
      const result = load(loader.id, control, configFile);
      if (result.ok) {
        return {
          ok: false,
          status: LOAD_STATUSES.controlLoaded,
          message: `${loader.label} loaded a config whose import graph holds a TypeScript parameter property, which strip-only type stripping refuses. That load path is no longer strip-only, so driving ${WEB_CONFIG} through it would prove nothing about the syntax it may contain. This check fails rather than report a measurement it did not make -- re-establish what the leg measures, or retire it, in scripts/check-web-config-native-load.mjs.`,
        };
      }
      if (result.code !== REJECTION_CODE) {
        return {
          ok: false,
          status: LOAD_STATUSES.controlFailedOtherwise,
          message: `${loader.label} refused the control fixture, but with ${result.code ?? "no error code"} rather than ${REJECTION_CODE}, so it is not the strip-only refusal this check is calibrated against and the result below it would be unsound:\n\n${result.output}`,
        };
      }
    }
  } finally {
    rmSync(controlDirectory, { recursive: true, force: true });
  }

  for (const loader of LOADERS) {
    const result = load(loader.id, configFile, configFile);
    if (!result.ok) {
      const cause =
        result.code === REJECTION_CODE
          ? `A TypeScript construct that strip-only type stripping cannot erase -- a constructor parameter property, an \`enum\`, a non-\`declare\` \`namespace\`, an \`import x = require(...)\` alias -- has entered the config's transitive import graph. Rewrite the construct the trace names into erasable syntax: a parameter property becomes a field declaration plus an assignment in the constructor body.`
          : `The load failed for a reason other than ${REJECTION_CODE}, so it is the config or its imports, not their syntax.`;
      return {
        ok: false,
        status: LOAD_STATUSES.refused,
        message: `${WEB_CONFIG} does not load under ${loader.label}. ${cause}\n\n${result.output}`,
      };
    }
  }

  return {
    ok: true,
    status: LOAD_STATUSES.loads,
    message: `${WEB_CONFIG} and everything it imports load under ${LOADERS.map((loader) => loader.label).join(" and ")}.`,
  };
}

// CLI entry: child mode performs one load; otherwise the full check. Neither
// runs on import, so the test can drive the functions above directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === CHILD_FLAG) {
    const [loaderId, configFile, viteFrom] = process.argv.slice(3);
    const loader = LOADERS.find((candidate) => candidate.id === loaderId);
    if (!loader) {
      console.error(`unknown loader ${loaderId}`);
      process.exit(2);
    }
    await runChildLoad(
      () => loader.load(configFile, viteFrom),
      (error) => error?.stack ?? String(error),
    );
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = checkWebConfigNativeLoad({ root });
    if (!result.ok) {
      console.error(`Web config native load check failed: ${result.message}`);
      process.exit(1);
    }
    console.log(`Web config native load check passed: ${result.message}`);
  }
}
