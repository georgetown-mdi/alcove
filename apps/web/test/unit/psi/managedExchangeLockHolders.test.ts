import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";

import { describe, expect, test } from "vitest";

import { chosenCopyImportReason } from "@recurring/managedImportFailure";

/**
 * Which writes take a managed exchange's run+rotate lock, as a check over the
 * app source rather than a claim in prose: a run, and the import replace
 * that writes a chosen copy over. Every other write runs unlocked and, where
 * it replaces the secret, compares the one it read inside its own
 * transaction. The import refusal that reads the lock names a run as its
 * holder, which is accurate only while this list holds.
 */

const WEB_SOURCE_ROOT = new URL("../../../src/", import.meta.url);

function webSourceFiles(within = ""): Array<string> {
  return readdirSync(new URL(within, WEB_SOURCE_ROOT), {
    withFileTypes: true,
  }).flatMap((entry) =>
    entry.isDirectory()
      ? webSourceFiles(`${within}${entry.name}/`)
      : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        ? [`${within}${entry.name}`]
        : [],
  );
}

/** The name of the function declared or assigned at `node`, if any. */
function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name !== undefined
  )
    return node.name.getText();
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) ||
      ts.isPropertyAssignment(node.parent))
  )
    return node.parent.name.getText();
  return undefined;
}

/** The outermost named function enclosing `node`, or `(module)`. */
function outermostFunction(node: ts.Node): string {
  let outermost = "(module)";
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent)
    outermost = functionName(at) ?? outermost;
  return outermost;
}

/** Every use of `symbol` in the app source outside `declaredIn`, as
 * `file: outermost function`, a plain import aside. A renamed import or a use
 * that is not a call is listed as one, so it fails the exact list. */
function lockSites(symbol: string, declaredIn: string): Array<string> {
  return webSourceFiles()
    .filter((file) => file !== declaredIn)
    .flatMap((file) => {
      const source = readFileSync(new URL(file, WEB_SOURCE_ROOT), "utf8");
      if (!source.includes(symbol)) return [];
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const sites: Array<string> = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === symbol) {
          const parent = node.parent;
          if (ts.isImportSpecifier(parent)) {
            if (parent.propertyName !== undefined)
              sites.push(`${file}: import renamed to ${parent.name.text}`);
          } else {
            const called =
              ts.isCallExpression(parent) && parent.expression === node;
            sites.push(
              `${file}: ${outermostFunction(node)}${called ? "" : " (not a call)"}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      return sites;
    });
}

describe("the run+rotate lock's holders", () => {
  test("only a run and the import replace take it", () => {
    expect(
      lockSites(
        "withManagedExchangeLock",
        "psi/managed/managedExchangeLock.ts",
      ).sort(),
    ).toEqual([
      "psi/managed/managedExchangeRun.ts: runManagedExchange",
      "psi/managed/managedExchangeStore.ts: replaceManagedExchangeFromImport",
    ]);
  });

  test("the import refusal that reads it names a run as its holder", () => {
    expect(chosenCopyImportReason("run-in-flight", "backup")).toMatch(
      /^That exchange is running right now - in this browser, in another tab, or on its schedule - so nothing was imported/,
    );
  });
});
