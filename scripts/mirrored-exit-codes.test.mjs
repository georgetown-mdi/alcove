import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseFile, parseSource } from "./lib/typeScriptSources.mjs";

// The console declares some of the CLI's exit codes itself rather than
// importing them -- the CLI is a separate workspace it drives as a subprocess --
// so nothing in the module graph holds each pair together. Each side's suite
// pins only its OWN copy against the literal, so a coherent change to one
// workspace leaves both suites green while the server acts on a value the CLI
// no longer exits with. This check reads both declarations of every constant in
// MIRRORS out of source and fails when they diverge.
//
// docs/spec/SERVER_JOB_API.md cites it rather than asserting the alignment in
// prose.
//
// What it reads is a TOP-LEVEL `export const <name> = <numeric literal>` in each
// module, parsed with the TypeScript compiler API. Every other shape -- a
// missing or duplicated declaration, one that is not exported or not `const`, an
// initializer written as an expression, an `as const`, or an import of the other
// side's value -- is reported as a shape this check cannot read rather than
// passed over.
//
// What it decides is EQUALITY of each pair's declared values, not that either is
// the right one: a change that moved both to the same new number passes here.
// The value itself is pinned against the exit-code contract by each side's own
// suite.
//
// It reaches the rows of MIRRORS and nothing else. A new mirrored exit code is
// held only once it has a row. The server module's other cross-workspace
// mirror, the CLI's fd-3 event vocabulary, is a type rather than a value and is
// not read here.

const SELF = "scripts/mirrored-exit-codes.test.mjs";

/** The declaring module of the console's copy of a row naming no other. */
const SERVER_MODULE = "apps/web/src/jobs/cliDriver.ts";

/**
 * Each mirrored constant: the name both sides export, the CLI module declaring
 * it, the console module declaring it where that is not SERVER_MODULE, and
 * what the console gets wrong when its copy diverges.
 */
const MIRRORS = [
  {
    constant: "PERSISTENCE_LOSS_EXIT_CODE",
    cliModule: "packages/cli-contract/src/exitCodes.ts",
    consequence:
      "a run that completed its exchange and lost a local write is " +
      "classified as an ordinary failure -- which tells a supervisor to " +
      "re-run it, re-sending this party's data for an exchange that already " +
      "happened",
  },
  {
    constant: "INTERNAL_FAULT_EXIT_CODE",
    cliModule: "packages/cli-contract/src/exitCodes.ts",
    consequence:
      "a run that stopped on an internal fault without reporting it gets the " +
      "retryable terminal synthesized for a broken event stream, offering a " +
      "Try again that reaches the same fault",
  },
  {
    constant: "PARTNER_REFUSED_EXIT_CODE",
    cliModule: "packages/cli-contract/src/exitCodes.ts",
    serverModule: "apps/web/src/psi/jobClient/serverJobExchangeDriver.ts",
    consequence:
      "a run the partner or the agreed terms refused is shown as a failure " +
      "worth retrying, and a refusal it is not is shown as the partner's",
  },
];

/**
 * What a module declares for `constant`: `{file, value}` for a shape this
 * check reads, `{file, unreadable}` for one it does not.
 */
function readDeclaration(sourceFile, constant) {
  const file = sourceFile.fileName;
  const found = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === constant
      )
        found.push({ statement, declaration });
  }
  if (found.length !== 1)
    return {
      file,
      unreadable: `${found.length} top-level declaration(s) of ${constant}, not one`,
    };
  const [{ statement, declaration }] = found;
  if (
    !statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  )
    return { file, unreadable: `${constant} is declared without \`export\`` };
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0)
    return { file, unreadable: `${constant} is declared without \`const\`` };
  const { initializer } = declaration;
  if (initializer === undefined || !ts.isNumericLiteral(initializer))
    return {
      file,
      unreadable:
        `${constant} is initialized by ` +
        `${initializer === undefined ? "nothing" : ts.SyntaxKind[initializer.kind]} ` +
        `rather than a numeric literal`,
    };
  return { file, value: Number(initializer.text) };
}

/** Read `constant` out of each module, in the order the modules are given. */
function readDeclarations(constant, files, parse = parseFile) {
  return files.map((file) => readDeclaration(parse(file), constant));
}

/**
 * How the readable declarations disagree, one entry per module, or nothing when
 * they all hold the same value.
 */
function divergence(readings) {
  const read = readings.filter((reading) => reading.value !== undefined);
  const values = new Set(read.map((reading) => reading.value));
  return values.size > 1
    ? read.map((reading) => `${reading.file} declares ${reading.value}`)
    : [];
}

/** Parse each synthetic source under its own name. */
function readSynthetic(constant, sources) {
  return readDeclarations(constant, Object.keys(sources), (file) =>
    parseSource(file, sources[file]),
  );
}

describe.each(MIRRORS)(
  "the console's $constant tracks the CLI's",
  ({ constant, cliModule, serverModule = SERVER_MODULE, consequence }) => {
    const readings = readDeclarations(constant, [cliModule, serverModule]);

    it("reads a declaration it understands out of each module", () => {
      const unreadable = readings
        .filter((reading) => reading.unreadable !== undefined)
        .map((reading) => `${reading.file}: ${reading.unreadable}`);
      expect(
        unreadable,
        `${unreadable.length} declaration(s) of ${constant} are shapes this ` +
          `check cannot read, so it cannot say whether the pair agrees. ` +
          `Declare it as an exported top-level \`const\` with a numeric ` +
          `literal, or teach ${SELF} the new idiom.`,
      ).toEqual([]);
    });

    it("holds the two declared values equal", () => {
      const divergent = divergence(readings);
      expect(
        divergent,
        `${cliModule} and ${serverModule} declare different values for ` +
          `${constant}, so ${consequence}. Carry the change to both.`,
      ).toEqual([]);
    });
  },
);

describe("the mirrored exit-code check", () => {
  it("reports a server copy the CLI has moved away from", () => {
    // The defect this check exists for, pinned against sources of its own: the
    // shape both workspaces' own suites pass, because each pins only its own
    // copy.
    const constant = "INTERNAL_FAULT_EXIT_CODE";
    const moved = readSynthetic(constant, {
      "cli.ts": `export const ${constant} = 71;`,
      "server.ts": `export const ${constant} = 70;`,
    });
    expect(divergence(moved)).toEqual([
      "cli.ts declares 71",
      "server.ts declares 70",
    ]);
  });

  it("passes a pair that agrees", () => {
    const constant = "PERSISTENCE_LOSS_EXIT_CODE";
    const agreed = readSynthetic(constant, {
      "cli.ts": `export const ${constant} = 73;`,
      "server.ts": `export const OTHER = 1;\nexport const ${constant} = 73;`,
    });
    expect(divergence(agreed)).toEqual([]);
  });

  it("refuses a declaration shape it cannot read rather than passing it", () => {
    const constant = "PERSISTENCE_LOSS_EXIT_CODE";
    const sources = {
      "imported.ts": `import { ${constant} } from "@alcove/cli";`,
      "unexported.ts": `const ${constant} = 73;`,
      "reassignable.ts": `export let ${constant} = 73;`,
      "computed.ts": `export const ${constant} = EX_CANTCREAT;`,
      "asserted.ts": `export const ${constant} = 73 as const;`,
      "duplicated.ts": `export const ${constant} = 73;\nexport const ${constant} = 73;`,
    };
    expect(
      readSynthetic(constant, sources)
        .filter((reading) => reading.unreadable !== undefined)
        .map((reading) => reading.file),
    ).toEqual(Object.keys(sources));
  });

  it("reads each row's constant by its own name, not another row's", () => {
    const [first, second] = MIRRORS.map((row) => row.constant);
    const readings = readSynthetic(second, {
      "other-row-only.ts": `export const ${first} = 73;`,
    });
    expect(readings[0].unreadable).toBe(
      `0 top-level declaration(s) of ${second}, not one`,
    );
  });
});
