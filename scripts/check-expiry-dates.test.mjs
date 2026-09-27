import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  datedEntries,
  expiringBefore,
  expiryViolations,
  isCalendarDate,
} from "./check-expiry-dates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-expiry-dates.mjs");
const TODAY = "2026-10-01";

const trees = [];
afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

function checkEntry(script, expiresOn) {
  return expiresOn === undefined
    ? { script, description: "d" }
    : { script, expiresOn, description: "d" };
}

// A tree holding a run-checks.mjs with `checks` as CHECKS and a settings.json
// registering one hook whose file has `hookExpiry` as its date line, or none.
function fixtureTree({ checks, hookExpiry }) {
  const root = mkdtempSync(resolve(tmpdir(), "check-expiry-dates-"));
  trees.push(root);
  mkdirSync(resolve(root, "scripts"));
  mkdirSync(resolve(root, ".claude/hooks"), { recursive: true });
  writeFileSync(
    resolve(root, "scripts/run-checks.mjs"),
    [
      `export const CHECKS = ${JSON.stringify(checks)};`,
      `export const OUT_OF_CHECK_ALL = [${JSON.stringify(checkEntry("check:off", "2026-12-31"))}];`,
      `export const SEPARATE_WORKFLOW_STEPS = [{ command: "npm run audit", expiresOn: "2026-12-31", reason: "r" }];`,
    ].join("\n"),
  );
  writeFileSync(
    resolve(root, ".claude/settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/block-thing.mjs"',
              },
            ],
          },
        ],
      },
    }),
  );
  writeFileSync(
    resolve(root, ".claude/hooks/block-thing.mjs"),
    [
      "#!/usr/bin/env node",
      "// A hook.",
      "",
      ...(hookExpiry === undefined
        ? []
        : [`export const EXPIRES_ON = "${hookExpiry}";`]),
      "",
    ].join("\n"),
  );
  return root;
}

function runCheck(root, ...extra) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--root", root, "--today", TODAY, ...extra],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("the check, driven against a fixture tree", () => {
  it("passes when every entry and hook is dated on or after today", () => {
    const root = fixtureTree({
      checks: [
        checkEntry("check:a", TODAY),
        checkEntry("check:b", "2027-01-01"),
      ],
      hookExpiry: "2026-12-31",
    });
    const result = runCheck(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuses a check entry with no date, naming it", () => {
    const root = fixtureTree({
      checks: [
        checkEntry("check:a", "2026-12-31"),
        checkEntry("check:undated"),
      ],
      hookExpiry: "2026-12-31",
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CHECKS entry check:undated: states no expiry date.",
    );
    expect(result.stderr).not.toContain("check:a");
  });

  it("refuses a check entry whose date has passed, naming it", () => {
    const root = fixtureTree({
      checks: [checkEntry("check:stale", "2026-09-30")],
      hookExpiry: "2026-12-31",
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CHECKS entry check:stale: expired on 2026-09-30.",
    );
  });

  it("refuses a registered hook with no date, naming its file", () => {
    const root = fixtureTree({
      checks: [checkEntry("check:a", "2026-12-31")],
      hookExpiry: undefined,
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".claude/hooks/block-thing.mjs: states no expiry date.",
    );
  });

  it("refuses a registered hook whose date has passed, naming its file", () => {
    const root = fixtureTree({
      checks: [checkEntry("check:a", "2026-12-31")],
      hookExpiry: "2026-01-01",
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".claude/hooks/block-thing.mjs: expired on 2026-01-01.",
    );
  });

  it("lists the entries expiring before a date without failing", () => {
    const root = fixtureTree({
      checks: [
        checkEntry("check:soon", "2026-11-01"),
        checkEntry("check:late", "2027-06-30"),
      ],
      hookExpiry: "2026-10-15",
    });
    const result = runCheck(root, "--expiring-before", "2027-01-01");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check:soon");
    expect(result.stdout).toContain("block-thing.mjs");
    expect(result.stdout).toContain("check:off");
    expect(result.stdout).not.toContain("check:late");
  });

  it("refuses a malformed date flag", () => {
    const root = fixtureTree({ checks: [], hookExpiry: "2026-12-31" });
    expect(runCheck(root, "--expiring-before", "soon").status).toBe(2);
  });
});

describe("the date rules", () => {
  it("passes an entry on its expiry date and fails it the day after", () => {
    const entries = [{ name: "e", expiresOn: "2026-12-31" }];
    expect(expiryViolations(entries, "2026-12-31")).toEqual([]);
    expect(expiryViolations(entries, "2027-01-01")).toEqual([
      "e: expired on 2026-12-31.",
    ]);
  });

  it("refuses a date that is not a calendar date", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-12-31")).toBe(true);
    expect(
      expiryViolations([{ name: "e", expiresOn: "2026-02-30" }], TODAY),
    ).toEqual([
      'e: expiry date "2026-02-30" is not a YYYY-MM-DD calendar date.',
    ]);
  });

  it("orders the entries due before a date soonest first", () => {
    const due = expiringBefore(
      [
        { name: "b", expiresOn: "2026-12-01" },
        { name: "a", expiresOn: "2026-11-01" },
        { name: "c", expiresOn: "2027-02-01" },
      ],
      "2027-01-01",
    );
    expect(due.map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});

describe("this repository", () => {
  it("dates every run-checks entry and every registered hook", async () => {
    const entries = await datedEntries(repoRoot);
    expect(
      entries.some((entry) => entry.name.startsWith(".claude/hooks/")),
    ).toBe(true);
    expect(expiryViolations(entries, "2026-01-01")).toEqual([]);
  });
});
