import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vitest";

import {
  colorSchemeScriptElement,
  colorSchemeScriptSource,
} from "../../src/utils/colorSchemeScript";
import consoleConfig from "../../vite.console.config";

import type { Plugin, UserConfig } from "vite";

/** The scheme the script sets on a document whose system setting is
 * `systemScheme` and whose storage read returns `stored`, or throws. */
function schemeSetBy(
  systemScheme: "light" | "dark",
  stored: string | null | Error,
): string | undefined {
  const attributes = new Map<string, string>();
  runInNewContext(colorSchemeScriptSource, {
    window: {
      localStorage: {
        getItem: () => {
          if (stored instanceof Error) throw stored;
          return stored;
        },
      },
      matchMedia: (query: string) => ({
        matches:
          query === "(prefers-color-scheme: dark)" && systemScheme === "dark",
      }),
    },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
      },
    },
  });
  return attributes.get("data-mantine-color-scheme");
}

describe("the pre-paint color-scheme script", () => {
  test.each(["light", "dark"] as const)(
    "follows a %s system setting with nothing stored",
    (scheme) => {
      expect(schemeSetBy(scheme, null)).toBe(scheme);
    },
  );

  test("follows the system setting when the storage read throws", () => {
    expect(schemeSetBy("dark", new Error("SecurityError"))).toBe("dark");
  });

  test("takes a stored scheme over the system setting", () => {
    expect(schemeSetBy("dark", "light")).toBe("light");
    expect(schemeSetBy("light", "auto")).toBe("light");
  });
});

describe("the console build's document", () => {
  test("holds the color-scheme script in its head", async () => {
    const resolved = (
      consoleConfig as (env: {
        command: "build";
        mode: string;
        isSsrBuild: boolean;
      }) => UserConfig
    )({ command: "build", mode: "production", isSsrBuild: false });
    const plugin = (resolved.plugins ?? [])
      .flat()
      .find(
        (entry): entry is Plugin =>
          typeof entry === "object" &&
          entry !== null &&
          "name" in entry &&
          entry.name === "alcove-console-color-scheme-script",
      );
    const transform = plugin?.transformIndexHtml as
      ((html: string) => string | Promise<string>) | undefined;
    expect(transform).toBeTypeOf("function");

    const template = readFileSync(
      new URL("../../index.html", import.meta.url),
      "utf8",
    );
    const html = await transform!(template);
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain(colorSchemeScriptElement);
  });
});
