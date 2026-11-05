import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { declaredRoutes } from "../../hosted/declaredRoutes";
import { rootDocumentHead } from "../../src/utils/documentHead";

// The WCAG 2.1 facts docs/ACCESSIBILITY.md rests on that the browser scans
// cannot see, read from source: they mount into the test runner's own
// document, and a criterion about what the app never does has nothing to scan.

const webRoot = path.resolve(import.meta.dirname, "../..");

/** Every source file under src/, with its path relative to the web app. */
function sourceFiles(directory = path.join(webRoot, "src")): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(tsx?|css)$/.test(entry.name) ? [file] : [];
  });
}

/** The source files under src/ matching `pattern`, relative to the web app. */
function filesMatching(pattern: RegExp): Array<string> {
  return sourceFiles()
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(webRoot, file));
}

describe("page titles (WCAG 2.4.2)", () => {
  test("every route that renders a page declares its own title", () => {
    const untitled = declaredRoutes()
      .filter(({ file }) => {
        const head = /head:\s*\(\)\s*=>[\s\S]*?title:\s*"([^"]+)"/.exec(
          readFileSync(file, "utf8"),
        );
        return head === null || !head[1].includes("Alcove");
      })
      .map(({ path: route }) => route);
    expect(untitled).toEqual([]);
  });
});

describe("document language (WCAG 3.1.1)", () => {
  test.each(["index.html", "hosted/index.html", "src/routes/__root.tsx"])(
    "%s declares the page language as English",
    (file) => {
      expect(readFileSync(path.join(webRoot, file), "utf8")).toMatch(
        /<html lang="en"[\s>]/,
      );
    },
  );
});

describe("zoom (WCAG 1.4.4)", () => {
  test("the viewport setting leaves the page zoomable", () => {
    const viewport = rootDocumentHead.meta.find(
      (entry) => "name" in entry && entry.name === "viewport",
    );
    expect(viewport).toEqual({
      name: "viewport",
      content: "width=device-width, initial-scale=1",
    });
  });
});

describe("what the app does not have", () => {
  test("no audio or video, so the time-based media criteria do not apply (WCAG 1.2, 1.4.2)", () => {
    expect(filesMatching(/<(audio|video)\b|new Audio\(|autoPlay/)).toEqual([]);
  });

  test("no keyboard shortcuts of its own (WCAG 2.1.4)", () => {
    expect(
      filesMatching(
        /\bonKey(Down|Up|Press)\b|["'](keydown|keyup|keypress)["']|useHotkeys|getHotkeyHandler/,
      ),
    ).toEqual([]);
  });

  test("no dialog that Escape does not close (WCAG 2.1.2)", () => {
    expect(filesMatching(/closeOnEscape=\{false\}|trapFocus=\{true\}/)).toEqual(
      [],
    );
  });

  test("no motion or orientation input (WCAG 2.5.4, 1.3.4)", () => {
    expect(
      filesMatching(
        /devicemotion|deviceorientation|DeviceMotionEvent|DeviceOrientationEvent|screen\.orientation|orientation:\s*(portrait|landscape)/,
      ),
    ).toEqual([]);
    expect(
      readFileSync(path.join(webRoot, "public/site.webmanifest"), "utf8"),
    ).not.toMatch(/"orientation"/);
  });
});
