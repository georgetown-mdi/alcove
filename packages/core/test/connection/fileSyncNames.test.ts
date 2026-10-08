import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  ABORT_SUFFIX,
  HELLO_SUFFIX,
  JOINING_SUFFIX,
  parseTimestampedMessageNNN,
  peerIdFromControlName,
} from "../../src/connection/fileSyncNames";
import { messageFilename } from "../../src/connection/fileSyncMessageLoop";

describe("peerIdFromControlName", () => {
  test("recovers the id ahead of each control suffix", () => {
    expect(peerIdFromControlName("alice-hello.json", HELLO_SUFFIX)).toBe(
      "alice",
    );
    expect(peerIdFromControlName("bob-joining.json", JOINING_SUFFIX)).toBe(
      "bob",
    );
    expect(peerIdFromControlName("carol-abort.json", ABORT_SUFFIX)).toBe(
      "carol",
    );
  });

  test("keeps an id that holds dashes and digits whole", () => {
    expect(peerIdFromControlName("site-7-a1b2-hello.json", HELLO_SUFFIX)).toBe(
      "site-7-a1b2",
    );
  });

  test("is undefined for a bare suffix, never the empty id", () => {
    expect(peerIdFromControlName("-hello.json", HELLO_SUFFIX)).toBeUndefined();
    expect(
      peerIdFromControlName("-joining.json", JOINING_SUFFIX),
    ).toBeUndefined();
    expect(peerIdFromControlName("-abort.json", ABORT_SUFFIX)).toBeUndefined();
  });

  test("is undefined for a name ending in another suffix", () => {
    expect(
      peerIdFromControlName("alice-hello.json", JOINING_SUFFIX),
    ).toBeUndefined();
    expect(
      peerIdFromControlName("alice-100.json", HELLO_SUFFIX),
    ).toBeUndefined();
    expect(
      peerIdFromControlName("alice-hello.json.tmp", HELLO_SUFFIX),
    ).toBeUndefined();
  });
});

describe("parseTimestampedMessageNNN", () => {
  test("reads the counter of a timestamped message name", () => {
    const name = messageFilename({
      id: "peer",
      timestampInFilename: true,
      byteCount: 42,
      seq: 7,
      ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(parseTimestampedMessageNNN(name)).toBe(7);
  });

  test("misreads a digit id segment of an untimestamped name as a counter", () => {
    const name = messageFilename({
      id: "site-12",
      timestampInFilename: false,
      byteCount: 42,
      seq: 0,
      ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(name).toBe("site-12-42.json");
    expect(parseTimestampedMessageNNN(name)).toBe(12);
  });
});

const CORE_SRC = fileURLToPath(new URL("../../src", import.meta.url));

function coreSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return coreSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Every call of `callee` in core's source, with the conditions of the `if`
 * statements whose then-branch encloses it. */
function callSites(
  callee: string,
): Array<{ file: string; guardedBy: string[] }> {
  const sites: Array<{ file: string; guardedBy: string[] }> = [];
  for (const file of coreSourceFiles(CORE_SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes(callee)) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === callee
      ) {
        const guardedBy: string[] = [];
        for (let child: ts.Node = node; child.parent; child = child.parent)
          if (
            ts.isIfStatement(child.parent) &&
            child.parent.thenStatement === child
          )
            guardedBy.push(child.parent.expression.getText(source));
        sites.push({ file: relative(CORE_SRC, file), guardedBy });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

test("the counter is read at one call site, inside the retain-mode branch", () => {
  expect(callSites("parseTimestampedMessageNNN")).toEqual([
    {
      file: join("connection", "fileSyncMessageLoop.ts"),
      guardedBy: expect.arrayContaining([
        "deps.options().retainFiles",
      ]) as unknown as string[],
    },
  ]);
});
