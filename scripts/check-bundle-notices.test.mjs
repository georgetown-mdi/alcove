import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rollup } from "rollup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { missingNotices } from "./check-bundle-notices.mjs";
import {
  bundleNotices,
  noticeComment,
  packageDirOf,
} from "./lib/bundleNotices.mjs";

const MIT_TEXT = "Copyright (c) Fixture Author\n\n    Permission is granted.";
const ISC_TEXT = "ISC licence of the scoped fixture";

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
  put(`${dir}/index.js`, `export const ${name.replace(/\W/g, "_")} = 1;\n`);
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
    `${noticeComment([{ name: "licensed", version: "1.0.0", license: "MIT", texts: ["stand-in"] }])}\nexport const lib = 2;\n`,
  );
  put("viaDist.js", 'import { lib } from "./dist/lib.js"; console.log(lib);');
});

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
});
