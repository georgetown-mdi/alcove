import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { serviceWorkerString } from "../../hosted/serviceWorkerSource";

const PINNED_CACHE_VERSION = "v2";

const TAKEOVER_CLAIM =
  "`CACHE_VERSION` is the same across deployments, so the takeover purges no cache from under that code";

const PARAGRAPH_LEAD = "- **The one exception to the holds.**";

const REVISIT = `Revisit docs/spec/MANAGED_EXCHANGE_SCHEDULE.md, the paragraph "The one exception to the holds": its claim that the takeover purges no cache rests on CACHE_VERSION being the same across deployments. Update the paragraph with the change, then update this test.`;

/** The paragraph starting at {@link PARAGRAPH_LEAD}, on one line. */
function exceptionParagraph(): string {
  const spec = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../docs/spec/MANAGED_EXCHANGE_SCHEDULE.md",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const start = spec.indexOf(PARAGRAPH_LEAD);
  expect(start, `${REVISIT} The paragraph was not found.`).toBeGreaterThan(-1);
  const end = spec.indexOf("\n- ", start + 1);
  return spec
    .slice(start, end === -1 ? undefined : end)
    .replace(/\s+/g, " ")
    .trim();
}

describe("the service worker's CACHE_VERSION and the takeover exception", () => {
  test("is the value the spec's takeover exception was written against", () => {
    expect(
      serviceWorkerString("CACHE_VERSION"),
      `CACHE_VERSION in apps/web/public/serviceWorker.js changed from ${PINNED_CACHE_VERSION}. ${REVISIT}`,
    ).toBe(PINNED_CACHE_VERSION);
  });

  test("the spec's exception paragraph still states that the takeover purges no cache", () => {
    expect(exceptionParagraph(), REVISIT).toContain(TAKEOVER_CLAIM);
  });
});
