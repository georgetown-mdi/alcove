import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The relay opens no connection of its own: it accepts sockets and never
// dials one, so no party can make it reach a TCP target. This holds the
// relay's source to the modules and names that accept, as a safety check over
// what the source spells, not a proof: a name reached some other way is
// outside it. The second case shows each dialing shape it refuses.

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Each module the source may import, and the value names it may take from
 * it; a type-only import is admitted from any of them. */
const ADMITTED_VALUE_IMPORTS: Record<string, ReadonlyArray<string>> = {
  "node:fs": ["statSync"],
  "node:http": ["createServer"],
  "node:net": [],
  "node:stream": [],
  "node:sqlite": ["DatabaseSync"],
  ws: ["WebSocketServer"],
  "@alcove/core/websocket-relay": [
    "checkWebSocketRelayProof",
    "deriveWebSocketRelayProofKey",
    "parseBoundedJson",
    "parseWebSocketRelayProof",
    "redactAndSanitizeForDisplay",
    "RENDEZVOUS_ROLES",
    "WebSocketRelayProofRefusedError",
  ],
  "@alcove/peerjs-broker/standaloneUpgradeBounds": [
    "applyStandaloneUpgradeBounds",
  ],
};

/** Globals that open a connection, refused wherever the source names them. */
const DIALING_GLOBALS = ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"];

function isAdmittedImport(node: ts.ImportDeclaration, module: string): boolean {
  const admitted = ADMITTED_VALUE_IMPORTS[module];
  if (admitted === undefined) return false;
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return true;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.every(
    (element) =>
      element.isTypeOnly ||
      admitted.includes((element.propertyName ?? element.name).text),
  );
}

/** The text of each import, re-export, dynamic import, `require` or dialing
 * global in `text` the relay may not use. */
function refusedIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refused: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        const module = specifier.text;
        const local = module.startsWith("./");
        const admitted =
          ts.isImportDeclaration(node) && isAdmittedImport(node, module);
        if (!local && !admitted) refused.push(node.getText(source));
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      refused.push(node.getText(source));
    }
    if (
      ts.isIdentifier(node) &&
      DIALING_GLOBALS.includes(node.text) &&
      !ts.isTypeReferenceNode(node.parent)
    ) {
      refused.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refused;
}

describe("the relay's source", () => {
  it("imports only what accepts sockets and names nothing that dials one", () => {
    const files = readdirSync(sourceDirectory, {
      recursive: true,
      encoding: "utf8",
    }).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const file = join(sourceDirectory, name);
      expect(refusedIn(file, readFileSync(file, "utf8")), name).toEqual([]);
    }
  });

  it.each([
    'import { request } from "node:http";',
    'import { connect } from "node:net";',
    'import * as http from "node:http";',
    'import { get } from "node:https";',
    'import WebSocket from "ws";',
    'import { WebSocket } from "ws";',
    'export { connect } from "node:net";',
    "await fetch(url);",
    "new WebSocket(url);",
    'const net = await import("node:net");',
    'const net = require("node:net");',
  ])("refuses %s", (shape) => {
    expect(refusedIn("shape.ts", shape)).not.toEqual([]);
  });
});
