import { join, relative } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  PRE_RUN_TRUST_FOOTER,
  partnerResultOf,
  settledTrustFooter,
} from "@exchange/trustFooter";

const srcRoot = fileURLToPath(new URL("../../../src", import.meta.url));

// The directories holding the app's screens, where a copy of the footer text
// would be written; the protocol, job and utility code renders no screen.
const screenDirectories = [
  "components",
  "console",
  "exchange",
  "recurring",
  "routes",
];

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function filesContainingEach(
  fragments: ReadonlyArray<string>,
): Array<Array<string>> {
  const sources = screenDirectories
    .flatMap((directory) => sourceFiles(join(srcRoot, directory)))
    .map((path) => ({
      path: relative(srcRoot, path),
      text: readFileSync(path, "utf8"),
    }));
  return fragments.map((fragment) =>
    sources
      .filter((source) => source.text.includes(fragment))
      .map((source) => source.path),
  );
}

describe("the privacy footer", () => {
  test("states the pre-run assurance, pointing at the send row", () => {
    expect(PRE_RUN_TRUST_FOOTER).toBe(
      "The fields you match on are encrypted before they leave your machine. " +
        'Your partner gets only the columns listed under "You will send", and ' +
        "only for records you both hold.",
    );
  });

  test("states what the partner's results show, by what the terms give it", () => {
    expect(settledTrustFooter(true, "matched")).toBe(
      "Your partner's results show only the records you have in common and " +
        "the columns you sent for them.",
    );
    expect(settledTrustFooter(true, "count-only")).toBe(
      "Your partner's results show only how many records you have in common.",
    );
    expect(settledTrustFooter(true, "none")).toBe(
      "Your partner gets no results.",
    );
  });

  test("a browser run leads with the this-browser sentence", () => {
    expect(settledTrustFooter(false, "none")).toBe(
      "Data was encrypted locally in your browser before being sent to your " +
        "partner. Your partner gets no results.",
    );
  });

  test("reads the partner's result from its entitlement and the algorithm", () => {
    expect(partnerResultOf({ partnerReceives: true, countOnly: false })).toBe(
      "matched",
    );
    expect(partnerResultOf({ partnerReceives: true, countOnly: true })).toBe(
      "count-only",
    );
    expect(partnerResultOf({ partnerReceives: false, countOnly: false })).toBe(
      "none",
    );
    expect(partnerResultOf({ partnerReceives: false, countOnly: true })).toBe(
      "none",
    );
  });

  test("its text is written in one source file", () => {
    const fragments = [
      "The fields you match on are encrypted before",
      "Data was encrypted locally in your browser",
      "Your partner's results show only",
      "Your partner gets no results",
    ];
    for (const files of filesContainingEach(fragments))
      expect(files).toEqual(["exchange/trustFooter.ts"]);
  });
});
