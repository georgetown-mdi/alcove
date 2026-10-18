import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// What the relay reaches of @alcove/core at run time. The relay listens on the
// internet, so the packages in its runtime closure are the packages an
// advisory can force a redeploy of it over. Two halves, since either alone
// can pass while the reach is wide: the relay's source names core only by the
// `./websocket-relay` subpath, and that subpath, as BUILT, reaches no package.
// The eslint ban (eslint.config.mjs, the packages/websocket-relay/src block)
// is what a contributor meets first. scripts/broker-core-reach.test.mjs holds
// the signaling broker to its own subpath the same way.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const sourceDirectory = resolve(here, "../src");
const coreDist = resolve(here, "../../core/dist");

const CORE_SUBPATH = "@alcove/core/websocket-relay";

/** Every module specifier `file` names, type-only imports included. */
function specifiersIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const found: string[] = [];
  const record = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The packages the built module graph rooted at `entry` reaches, following
 * the relative chunk imports rollup emits. */
function builtClosure(entry: string): string[] {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiersIn(file)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        visit(resolve(dirname(file), specifier));
        continue;
      }
      const parts = specifier.split("/");
      packages.add(
        specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0],
      );
    }
  };
  visit(entry);
  return [...packages].sort();
}

describe("the relay's source", () => {
  const files = readdirSync(sourceDirectory, {
    recursive: true,
    encoding: "utf8",
  })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(sourceDirectory, name));

  it("names @alcove/core only by the websocket-relay subpath", () => {
    const named = files.flatMap((file) =>
      specifiersIn(file)
        .filter((specifier) => specifier.startsWith("@alcove/core"))
        .map((specifier) => `${file}: ${specifier}`),
    );
    // A scan that found nothing would pass the check below.
    expect(named.length).toBeGreaterThan(0);
    expect(
      named.filter((entry) => !entry.endsWith(`: ${CORE_SUBPATH}`)),
    ).toEqual([]);
  });
});

describe("the eslint ban", { timeout: 60_000 }, () => {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: join(repoRoot, "eslint.config.mjs"),
  });

  async function restrictedImports(text: string): Promise<string[]> {
    const [result] = await eslint.lintText(text, {
      filePath: join(sourceDirectory, "reachFixture.ts"),
    });
    return result.messages
      .filter((message) => message.ruleId === "no-restricted-imports")
      .map((message) => message.message);
  }

  it.each(["@alcove/core", "@alcove/core/untrusted-text"])(
    "refuses an import of %s in the relay's source",
    async (specifier) => {
      const messages = await restrictedImports(
        `import { parseBoundedJson } from "${specifier}";\nexport const parse = parseBoundedJson;\n`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(CORE_SUBPATH);
    },
  );

  it("admits an import of the subpath", async () => {
    expect(
      await restrictedImports(
        `import { parseBoundedJson } from "${CORE_SUBPATH}";\nexport const parse = parseBoundedJson;\n`,
      ),
    ).toEqual([]);
  });
});

describe("the built @alcove/core/websocket-relay closure", () => {
  it("reaches no package, on either published condition", () => {
    expect(builtClosure(join(coreDist, "websocket-relay.esm.js"))).toEqual([]);
    expect(builtClosure(join(coreDist, "websocket-relay.cjs"))).toEqual([]);
  });

  it("measures something: the package root does reach packages", () => {
    // A walk that resolved nothing would report an empty closure for every
    // entry point.
    expect(builtClosure(join(coreDist, "core.esm.js"))).toEqual(
      expect.arrayContaining(["zod", "papaparse", "yaml"]),
    );
  });
});
