import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  OUT_OF_SYNC_TOKENS_DOC_URL,
  RELAY_CHECK_DOC_URL,
  SHARED_FOLDER_CHECK_DOC_URL,
  WINDOWS_TROUBLESHOOTING_URL,
  windowsTroubleshootingSection,
} from "../../src/docLinks";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** The headings of a Markdown file in the repository, `#` markers dropped. */
function headingsOf(relativePath: string): string[] {
  return fs
    .readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#{1,6} /, "").trim());
}

describe("the CLI's documentation links are full URLs", () => {
  test.each([
    [
      OUT_OF_SYNC_TOKENS_DOC_URL,
      "https://data-bridge.org/docs/CLI#out-of-sync-tokens",
      "Out-of-sync tokens",
    ],
    [
      SHARED_FOLDER_CHECK_DOC_URL,
      "https://data-bridge.org/docs/CLI#checking-a-network-shared-folder",
      "Checking a network shared folder",
    ],
    [
      RELAY_CHECK_DOC_URL,
      "https://data-bridge.org/docs/CLI#checking-the-relay-of-a-webrtc-exchange",
      "Checking the relay of a WebRTC exchange",
    ],
  ])("%s names a section docs/CLI.md has", (url, expected, heading) => {
    expect(url).toBe(expected);
    expect(headingsOf("docs/CLI.md")).toContain(heading);
  });

  test("the troubleshooting page is linked where the repository holds it", () => {
    expect(WINDOWS_TROUBLESHOOTING_URL).toBe(
      "https://github.com/georgetown-mdi/alcove/blob/main/support/" +
        "windows-network-filedrop/troubleshooting.md",
    );
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          "support/windows-network-filedrop/troubleshooting.md",
        ),
      ),
    ).toBe(true);
  });
});

describe("each troubleshooting section the doctor names exists", () => {
  // Read from the doctor's sources, so a section added there is checked
  // without a list here to keep in step.
  const doctorDir = path.join(REPO_ROOT, "apps/cli/src/doctor");
  const named = fs
    .readdirSync(doctorDir)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) =>
      [
        ...fs
          .readFileSync(path.join(doctorDir, name), "utf8")
          .matchAll(/windowsTroubleshootingSection\(\s*"([^"]+)"/g),
      ].map((match) => match[1]),
    );
  const headings = headingsOf(
    "support/windows-network-filedrop/troubleshooting.md",
  );

  test("the doctor names at least one", () => {
    expect(named.length).toBeGreaterThan(0);
  });

  test.each([...new Set(named)])("'%s' is a heading of the page", (heading) => {
    expect(headings).toContain(heading);
  });

  test("a pointer ends in the URL, so no punctuation sticks to it", () => {
    expect(windowsTroubleshootingSection("Synced folders")).toBe(
      "'Synced folders' on the troubleshooting page, " +
        "https://github.com/georgetown-mdi/alcove/blob/main/support/" +
        "windows-network-filedrop/troubleshooting.md",
    );
  });
});
