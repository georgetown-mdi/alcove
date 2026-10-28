import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { COUNT_ONLY_CONSTRUCTION } from "../../src/exchange/countOnlyConstruction";

// The count-only construction selector is set only by core's own tests: its
// option key is a symbol no package entry point exports, so the command-line
// and web applications, which import core through those entry points alone,
// cannot select the every-key construction (docs/spec/PROTOCOL.md, PSI-C).

// Each entry point package.json exports, with the source module it is built
// from (rollup.config.ts).
const ENTRY_POINT_SOURCES: Record<string, () => Promise<object>> = {
  ".": () => import("../../src/main"),
  "./testing": () => import("../../src/testing"),
  "./untrusted-text": () => import("../../src/untrustedText"),
  "./websocket-relay": () => import("../../src/websocketRelay"),
};

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };

test("every entry point the package exports is checked", () => {
  expect(Object.keys(manifest.exports).sort()).toEqual(
    Object.keys(ENTRY_POINT_SOURCES).sort(),
  );
});

test.each(Object.keys(ENTRY_POINT_SOURCES))(
  "the %s entry point exports no way to the selector",
  async (entryPoint) => {
    const exported = await ENTRY_POINT_SOURCES[entryPoint]!();
    for (const [name, value] of Object.entries(exported)) {
      expect(value, name).not.toBe(COUNT_ONLY_CONSTRUCTION);
      expect(name).not.toMatch(/countOnlyConstruction|COUNT_ONLY_CONSTRUCTION/);
    }
  },
);
