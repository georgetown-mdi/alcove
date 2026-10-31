import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rollup } from "rollup";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { coreUpstream, missingNotices } from "./check-bundle-notices.mjs";
import {
  NOTICES_FILE,
  bundleNotices,
  bundleNoticesFile,
  noticeComment,
  packageDirOf,
} from "./lib/bundleNotices.mjs";

const MIT_TEXT = "Copyright (c) Fixture Author\n\n    Permission is granted.";
const ISC_TEXT = "ISC licence of the scoped fixture";
const WORKER_TEXT = "Licence of a package only a worker inlines";

let root;

const put = (path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const pkg = (dir, name, files) => {
  put(
    `${dir}/package.json`,
    JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
  );
  // A function, which Rolldown cannot fold into its caller and drop the
  // module from the chunk's record.
  put(
    `${dir}/index.js`,
    `export function ${name.replace(/\W/g, "_")}() { return "${name}"; }\n`,
  );
  for (const [file, text] of Object.entries(files)) put(`${dir}/${file}`, text);
};

const chunkOf = async (entry, plugins) => {
  const bundle = await rollup({ input: join(root, entry), plugins });
  const { output } = await bundle.generate({ format: "es" });
  await bundle.close();
  return { path: join(root, "out.js"), ...output[0] };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bundle-notices-"));
  pkg("node_modules/licensed", "licensed", { LICENSE: MIT_TEXT });
  pkg("node_modules/@scope/pkg", "@scope/pkg", { "LICENSE-ISC": ISC_TEXT });
  pkg("node_modules/bare", "bare", {});
  put(
    "two.js",
    [
      'import { licensed } from "./node_modules/licensed/index.js";',
      'import { _scope_pkg } from "./node_modules/@scope/pkg/index.js";',
      "console.log(licensed, _scope_pkg);",
    ].join("\n"),
  );
  put(
    "bare.js",
    'import { bare } from "./node_modules/bare/index.js"; console.log(bare);',
  );
  // A built file whose own build inlined `licensed` and wrote its comment,
  // with a stand-in text so only a read of the installed package yields the
  // real one.
  put(
    "dist/lib.js",
    `${noticeComment([{ name: "licensed", version: "1.0.0", license: "MIT", texts: ["stand-in"] }])}\nexport function lib() { return 2; }\n`,
  );
  put("viaDist.js", 'import { lib } from "./dist/lib.js"; console.log(lib);');
  pkg("node_modules/workeronly", "workeronly", { LICENSE: WORKER_TEXT });
  pkg("node_modules/react-remove-scroll-bar", "react-remove-scroll-bar", {});
  put(
    "web/index.html",
    '<!doctype html><script type="module" src="./main.js"></script>',
  );
  put(
    "web/main.js",
    [
      'import { lib } from "../dist/lib.js";',
      'import { react_remove_scroll_bar } from "../node_modules/react-remove-scroll-bar/index.js";',
      "console.log(lib, react_remove_scroll_bar);",
      'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
    ].join("\n"),
  );
  put(
    "web/worker.js",
    'import { workeronly } from "../node_modules/workeronly/index.js"; console.log(workeronly);',
  );
});

/** The client build of the web/ fixture with the file plugins; its notices
 * file's text. */
async function clientNotices() {
  const notices = bundleNoticesFile();
  const result = await build({
    configFile: false,
    root: join(root, "web"),
    logLevel: "silent",
    plugins: [notices.client],
    worker: { plugins: () => [notices.worker] },
    build: { write: false },
  });
  const file = [result]
    .flat()
    .flatMap(({ output }) => output)
    .find((f) => f.fileName === NOTICES_FILE);
  return Buffer.from(file.source).toString("utf8");
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("packageDirOf", () => {
  it("names the innermost package, scoped or not, under a virtual prefix and query", () => {
    expect(packageDirOf("/r/node_modules/a/node_modules/b/lib/x.js")).toBe(
      "/r/node_modules/a/node_modules/b",
    );
    expect(packageDirOf("\0/r/node_modules/@s/p/x.js?commonjs-proxy")).toBe(
      "/r/node_modules/@s/p",
    );
    expect(packageDirOf("/r/src/x.js")).toBeNull();
  });
});

describe("bundleNotices", () => {
  it("heads a chunk with the license text of each package it inlines", async () => {
    const chunk = await chunkOf("two.js", [bundleNotices()]);
    expect(chunk.code).toContain(MIT_TEXT);
    expect(chunk.code).toContain(ISC_TEXT);
    expect(chunk.code).toContain('Bundled packages: ["@scope/pkg","licensed"]');
    expect(missingNotices([chunk])).toEqual([]);
  });

  it("carries what a built file it inlines lists in its own comment", async () => {
    const chunk = await chunkOf("viaDist.js", [bundleNotices()]);
    expect(chunk.code).toContain(MIT_TEXT);
  });

  it("fails the build for an inlined package that ships no license file", async () => {
    await expect(chunkOf("bare.js", [bundleNotices()])).rejects.toThrow(
      /bare@1\.0\.0 .* ships no license file/,
    );
  });

  it("writes nothing for a chunk that inlines no package", () => {
    expect(noticeComment([])).toBe("");
  });
});

describe("missingNotices", () => {
  it("names each package a chunk inlines without its license text", async () => {
    const chunk = await chunkOf("two.js", []);
    const gaps = missingNotices([chunk]);
    expect(gaps).toHaveLength(2);
    expect(gaps.join("\n")).toMatch(
      /inlines licensed 1\.0\.0 .* without its license text/,
    );
    expect(gaps.join("\n")).toMatch(/inlines @scope\/pkg 1\.0\.0/);
  });

  it("names a package an upstream build inlined into a module of the chunk", async () => {
    const chunk = await chunkOf("viaDist.js", []);
    const upstream = new Map([
      [join(root, "dist/lib.js"), [join(root, "node_modules/licensed")]],
    ]);
    const stripped = { ...chunk, code: "export const lib = 2;" };
    expect(missingNotices([stripped], upstream)).toEqual([
      expect.stringMatching(/inlines licensed 1\.0\.0/),
    ]);
  });

  it("names a package a client chunk inlines once per notices file that lacks it", async () => {
    const chunk = await chunkOf("two.js", []);
    const noticesPath = join(root, NOTICES_FILE);
    const entry = (path) => ({ ...chunk, path, code: ISC_TEXT, noticesPath });
    const gaps = missingNotices([entry(chunk.path), entry(join(root, "b.js"))]);
    expect(gaps).toEqual([
      expect.stringMatching(
        new RegExp(
          `${NOTICES_FILE}: lacks the license text of licensed 1\\.0\\.0 .*, which .*out\\.js inlines`,
        ),
      ),
    ]);
  });
});

describe("bundleNoticesFile", () => {
  it("writes one file with the notices of the page, its workers, and what a built file it inlines lists", async () => {
    const text = await clientNotices();
    expect(text).toContain(MIT_TEXT);
    expect(text).toContain(WORKER_TEXT);
    expect(text).toContain(
      "react-remove-scroll-bar ships no license file. Its package.json declares the MIT license.",
    );
    expect(text).toContain(
      'Bundled packages: ["licensed","react-remove-scroll-bar","workeronly"]',
    );
  });
});

describe("coreUpstream", () => {
  it("names a file missing from core's dist instead of throwing", () => {
    const missing = join(root, "dist/absent.esm.js");
    expect(coreUpstream([{ path: missing, moduleIds: [] }])).toEqual({
      missing,
    });
  });

  it("maps each present file's real path to what its build inlined", () => {
    const path = join(root, "dist/lib.js");
    const id = join(root, "node_modules/licensed/index.js");
    expect(coreUpstream([{ path, moduleIds: [id] }]).upstream).toEqual(
      new Map([[path, [join(root, "node_modules/licensed")]]]),
    );
  });
});
