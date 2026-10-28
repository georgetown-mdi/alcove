import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { resolveCountOnlyRun } from "../../src/exchange";
import { COUNT_ONLY_CONSTRUCTION } from "../../src/exchange/countOnlyConstruction";
import {
  assertKeyConditionsAdmitted,
  countOnlyEveryKeyConditionRefusal,
} from "../../src/linkageKeyCondition";
import { countOnlyEveryKeyShapeViolation } from "../../src/linkageTermsPolicy";

// The count-only construction selector is set only by core's own tests: its
// option key is a symbol no package entry point exports, so the command-line
// and web applications, which import core through those entry points alone,
// cannot select the every-key construction (docs/spec/PROTOCOL.md, PSI-C).
// Nor do they export a helper that applies the every-key rules or takes the
// construction as a plain argument.
const EVERY_KEY_HELPERS: unknown[] = [
  assertKeyConditionsAdmitted,
  countOnlyEveryKeyConditionRefusal,
  countOnlyEveryKeyShapeViolation,
  resolveCountOnlyRun,
];

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
  "the %s entry point exports neither the selector nor an every-key helper",
  async (entryPoint) => {
    const exported = await ENTRY_POINT_SOURCES[entryPoint]!();
    for (const [name, value] of Object.entries(exported)) {
      expect(value, name).not.toBe(COUNT_ONLY_CONSTRUCTION);
      expect(EVERY_KEY_HELPERS, name).not.toContain(value);
      expect(name).not.toMatch(/countOnlyConstruction|COUNT_ONLY_CONSTRUCTION/);
    }
  },
);
