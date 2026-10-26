import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The security.txt files (RFC 9116) the web app's build and the project site's
// serve. A hand-set Expires lapses with nothing to report it, so this fails
// RENEW_DAYS ahead of the date; it runs only when CI does, so a stretch with no
// pull request or push can still pass a lapse. Renewing is a new date in both
// files and a deploy of each site.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECURITY_TXT_FILES = [
  "apps/web/public/.well-known/security.txt",
  "docs/.vitepress/public/.well-known/security.txt",
];

const GITHUB_REPORTING =
  "https://github.com/georgetown-mdi/alcove/security/advisories/new";

/** Days ahead of Expires at which the check fails, to leave time to deploy. */
const RENEW_DAYS = 45;

/** RFC 9116, 2.5.5: an Expires less than a year ahead. */
const MAX_DAYS_AHEAD = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The field lines of a security.txt, as [name, value] pairs, comments skipped. */
function fields(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const match = /^([A-Za-z-]+): (.+)$/.exec(line);
      if (!match) throw new Error(`not a security.txt field line: ${line}`);
      return [match[1].toLowerCase(), match[2]];
    });
}

/**
 * Why an Expires value is not acceptable at `now`, or null when it is.
 * @param {string} value
 * @param {Date} now
 */
function expiresProblem(value, now) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    return `Expires ${value} is not an RFC 3339 UTC timestamp`;
  }
  const daysLeft = (Date.parse(value) - now.getTime()) / DAY_MS;
  if (Number.isNaN(daysLeft)) {
    return `Expires ${value} is not a real date`;
  }
  if (daysLeft < RENEW_DAYS) {
    return `Expires ${value} is ${Math.floor(daysLeft)} days away, under the ${RENEW_DAYS} the check allows: set a date under a year ahead in both files and deploy each site`;
  }
  if (daysLeft > MAX_DAYS_AHEAD) {
    return `Expires ${value} is more than a year away, which RFC 9116 advises against`;
  }
  return null;
}

/** The mailto address SECURITY.md names for reports outside GitHub. */
function securityPolicyMailbox() {
  const policy = readFileSync(resolve(repoRoot, "SECURITY.md"), "utf8");
  const addresses = [...policy.matchAll(/\(mailto:([^)\s]+)\)/g)].map(
    (match) => match[1],
  );
  expect(addresses, "SECURITY.md names one mailto address").toHaveLength(1);
  expect(policy).toContain("private vulnerability reporting");
  return addresses[0];
}

describe("expiresProblem", () => {
  const now = new Date("2026-10-26T00:00:00Z");

  it("accepts a date between the renewal window and a year ahead", () => {
    expect(expiresProblem("2027-06-01T00:00:00.000Z", now)).toBeNull();
  });

  it("fails inside the renewal window, before the date lapses", () => {
    expect(expiresProblem("2026-11-30T00:00:00Z", now)).toMatch(
      /days away, under the 45/,
    );
  });

  it("fails a date already past", () => {
    expect(expiresProblem("2026-10-01T00:00:00Z", now)).toMatch(/days away/);
  });

  it("fails a date more than a year ahead", () => {
    expect(expiresProblem("2027-12-01T00:00:00Z", now)).toMatch(
      /more than a year/,
    );
  });

  it("fails a value that is not a UTC timestamp", () => {
    expect(expiresProblem("2027-06-01", now)).toMatch(/not an RFC 3339/);
  });

  it("fails a timestamp with an out-of-range field", () => {
    expect(expiresProblem("2027-13-01T00:00:00Z", now)).toMatch(
      /not a real date/,
    );
    expect(expiresProblem("2027-06-01T25:00:00Z", now)).toMatch(
      /not a real date/,
    );
  });
});

describe("the served security.txt files", () => {
  const texts = SECURITY_TXT_FILES.map((path) =>
    readFileSync(resolve(repoRoot, path), "utf8"),
  );

  it("are the same file on every site", () => {
    for (const text of texts.slice(1)) expect(text).toBe(texts[0]);
  });

  it("name the contacts SECURITY.md names, GitHub's private reporting first", () => {
    const contacts = fields(texts[0])
      .filter(([name]) => name === "contact")
      .map(([, value]) => value);
    expect(contacts).toEqual([
      GITHUB_REPORTING,
      `mailto:${securityPolicyMailbox()}`,
    ]);
  });

  it("have one Expires, not yet inside the renewal window", () => {
    const expires = fields(texts[0]).filter(([name]) => name === "expires");
    expect(expires).toHaveLength(1);
    expect(expiresProblem(expires[0][1], new Date())).toBeNull();
  });
});
