import { describe, expect, test } from "vitest";

import {
  BROWSER_PSI_SHARD_CAP,
  browserPsiShardCount,
  browserRunsOnMacOs,
} from "../../../src/psi/workers/psiShardPolicy.js";

import type { BrowserPsiShardEnvironment } from "../../../src/psi/workers/psiShardPolicy.js";

// The browser PSI run shards on every platform except macOS, where it runs one
// worker. The user-agent strings are the shapes each browser sends.

const MAC_CHROME = {
  platform: "MacIntel",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  userAgentData: { platform: "macOS" },
};
const MAC_SAFARI = {
  platform: "MacIntel",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
};
const MAC_FIREFOX = {
  platform: "MacIntel",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
};
const WINDOWS_CHROME = {
  platform: "Win32",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  userAgentData: { platform: "Windows" },
};
const LINUX_FIREFOX = {
  platform: "Linux x86_64",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
};
const CHROMEOS_CHROME = {
  platform: "Linux x86_64",
  userAgent:
    "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  userAgentData: { platform: "Chrome OS" },
};

describe("the macOS platform check", () => {
  test.for([
    ["Chrome", MAC_CHROME],
    ["Safari", MAC_SAFARI],
    ["Firefox", MAC_FIREFOX],
  ] as const)("%s on macOS runs one worker", ([, browser]) => {
    expect(browserRunsOnMacOs(browser)).toBe(true);
    expect(browserPsiShardCount({ ...browser, hardwareConcurrency: 10 })).toBe(
      1,
    );
  });

  test.for([
    ["Chrome on Windows", WINDOWS_CHROME],
    ["Firefox on Linux", LINUX_FIREFOX],
    ["Chrome on ChromeOS", CHROMEOS_CHROME],
  ] as const)("%s shards", ([, browser]) => {
    expect(browserRunsOnMacOs(browser)).toBe(false);
    expect(browserPsiShardCount({ ...browser, hardwareConcurrency: 10 })).toBe(
      BROWSER_PSI_SHARD_CAP,
    );
  });

  test.for([
    ["the client-hints platform", { userAgentData: { platform: "macOS" } }],
    ["the legacy platform", { platform: "MacIntel" }],
    [
      "the user agent",
      { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    ],
  ] as const)("a Mac named by %s alone counts as macOS", ([, reports]) => {
    const windows: BrowserPsiShardEnvironment = {
      platform: WINDOWS_CHROME.platform,
      userAgent: WINDOWS_CHROME.userAgent,
    };
    expect(browserRunsOnMacOs(windows)).toBe(false);
    expect(browserRunsOnMacOs({ ...windows, ...reports })).toBe(true);
  });
});

describe("the shard count", () => {
  test.for([
    [1, 1],
    [2, 2],
    [3, 3],
    [BROWSER_PSI_SHARD_CAP, BROWSER_PSI_SHARD_CAP],
    [64, BROWSER_PSI_SHARD_CAP],
  ])("%i logical cores run %i workers", ([cores, shards]) => {
    expect(
      browserPsiShardCount({ ...LINUX_FIREFOX, hardwareConcurrency: cores }),
    ).toBe(shards);
  });

  test.for([undefined, 0, -2, 2.5, Number.NaN])(
    "a core count of %s runs one worker",
    (cores) => {
      expect(
        browserPsiShardCount({ ...LINUX_FIREFOX, hardwareConcurrency: cores }),
      ).toBe(1);
    },
  );
});
