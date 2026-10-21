import path from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { rootDocumentHead } from "@utils/documentHead";

const webRoot = path.resolve(import.meta.dirname, "../../..");

/** The `--app-surface` value the block opened by `selector` declares in
 * styles/tokens.css. */
function appSurface(selector: string): string {
  const css = readFileSync(path.join(webRoot, "src/styles/tokens.css"), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no ${selector} block`);
  const block = css.slice(start, css.indexOf("}", start));
  const declared = /--app-surface:\s*([^;]+);/.exec(block);
  if (declared === null)
    throw new Error(`${selector} in tokens.css declares no --app-surface`);
  return declared[1].trim();
}

function themeColors(): Array<{ media?: string; content?: string }> {
  return rootDocumentHead.meta.flatMap((entry) =>
    "name" in entry && entry.name === "theme-color" ? [entry] : [],
  );
}

describe("the root document's theme-color", () => {
  test("names each scheme's --app-surface, the dark entry first", () => {
    expect(themeColors()).toEqual([
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: appSurface(':root[data-mantine-color-scheme="dark"]'),
      },
      { name: "theme-color", content: appSurface(":root") },
    ]);
  });
});
