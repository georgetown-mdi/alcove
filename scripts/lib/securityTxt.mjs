// Reading a security.txt (RFC 9116) and the contacts SECURITY.md names, shared
// by the check on the committed files (scripts/security-txt.test.mjs) and the
// check on a deployed site (scripts/check-served-security-txt.mjs).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const GITHUB_REPORTING =
  "https://github.com/georgetown-mdi/alcove/security/advisories/new";

/** The field lines of a security.txt, as [name, value] pairs, comments skipped. */
export function fields(text) {
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

/** The Contact values of a security.txt, in file order. */
export function contacts(text) {
  return fields(text)
    .filter(([name]) => name === "contact")
    .map(([, value]) => value);
}

/**
 * The Contact lines a security.txt owes SECURITY.md: GitHub's private
 * reporting first, then the one mailto address the policy names.
 */
export function securityPolicyContacts(repoRoot) {
  const policy = readFileSync(resolve(repoRoot, "SECURITY.md"), "utf8");
  const addresses = [...policy.matchAll(/\(mailto:([^)\s]+)\)/g)].map(
    (match) => match[1],
  );
  if (addresses.length !== 1) {
    throw new Error(
      `SECURITY.md names ${addresses.length} mailto addresses, not one`,
    );
  }
  if (!policy.includes("private vulnerability reporting")) {
    throw new Error(
      "SECURITY.md does not name private vulnerability reporting",
    );
  }
  return [GITHUB_REPORTING, `mailto:${addresses[0]}`];
}
