// The built-in linkage rule set, read out of its source declarations.
//
// check-zero-setup-keys.mjs holds a property of that set, and needs its fields
// and keys as VALUES rather than as text. Reading them from the source rather
// than from the built package is by design: a check that imported a built dist
// would pass against a stale build -- the one failure mode a guard over source
// content cannot afford.
//
// The set's declaration is the entry point. It is followed to the declarations
// it composes, its fields and its keys, and a failure is reported under the
// declaration it came from so it names what to edit.
//
// The source is parsed with the TypeScript compiler's own parser and each
// declaration's initializer evaluated as a literal, so a comment, a reflow, or
// prettier's line breaking moves nothing here while a value, a key, or an array
// ordering does. An initializer that is not a plain literal -- a spread, a
// computed key, a call other than the freezing wrappers below -- is refused by
// name rather than guessed at: a reader that quietly returned a partial value
// would hand the check a content it would then pass.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

/** The source the built-in rule set is declared in. */
export const RULE_SET_SOURCE =
  "packages/core/src/defaults/builtInLinkageTerms.ts";

/** The declaration composing the built-in rule set. */
export const RULE_SET_DECLARATION = "DEFAULT_LINKAGE_RULE_SET";

/**
 * The calls that return their single argument's value unchanged, and so are
 * read through rather than refused: the freezing the set is declared under.
 * Every other call is refused, since its value is not in the source.
 */
const IDENTITY_CALLS = ["Object.freeze", "frozenThroughContents"];

/**
 * Raised when a declaration's initializer is not a literal this can evaluate.
 * `declaration` names the declaration the failure sits in, filled in by the
 * first reader that knows a name for it.
 */
export class UnreadableDeclaration extends Error {
  constructor(message, declaration) {
    super(message);
    this.declaration = declaration;
  }
}

function describe(node) {
  return ts.SyntaxKind[node.kind] ?? "an expression";
}

/** `Object.freeze` or a bare function name for a call, else undefined. */
function calleeText(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    return `${callee.expression.text}.${callee.name.text}`;
  }
  return undefined;
}

/**
 * `node` with the wrappers that do not change its value removed: the type
 * assertions, the parentheses, and the {@link IDENTITY_CALLS}.
 */
function unwrap(node) {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrap(node.expression);
  }
  const called = calleeText(node);
  if (called !== undefined && IDENTITY_CALLS.includes(called)) {
    if (node.arguments.length !== 1) {
      throw new UnreadableDeclaration(
        `\`${called}\` is called with ${node.arguments.length} arguments rather than the one whose value it returns`,
      );
    }
    return unwrap(node.arguments[0]);
  }
  return node;
}

/** {@link unwrap} with a failure attributed to `declaration` where the caller
 * knows one. */
function unwrapIn(node, declaration) {
  try {
    return unwrap(node);
  } catch (error) {
    if (error instanceof UnreadableDeclaration) {
      error.declaration ??= declaration;
    }
    throw error;
  }
}

/**
 * The top-level declaration `node` names, or undefined where it is not a bare
 * identifier or cannot be unwrapped at all. This is how a reason is given a
 * name inside a `catch`, so it reports no name rather than raising a second
 * failure over the one being handled.
 */
function declarationName(node) {
  let bare;
  try {
    bare = unwrap(node);
  } catch (error) {
    if (error instanceof UnreadableDeclaration) return undefined;
    throw error;
  }
  return ts.isIdentifier(bare) ? bare.text : undefined;
}

/**
 * The value a literal initializer denotes: strings, numbers, booleans, arrays,
 * and object literals of those. An identifier is handed to `readIdentifier`,
 * which the file's own declarations resolve. Anything else raises {@link
 * UnreadableDeclaration} naming the syntax, so a declaration that stopped being
 * a literal fails the checks over it rather than being treated as an empty one.
 */
function literalValue(node, readIdentifier) {
  const bare = unwrap(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)) {
    return bare.text;
  }
  if (ts.isNumericLiteral(bare)) return Number(bare.text);
  if (bare.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (bare.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (bare.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(bare) &&
    bare.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(bare.operand)
  ) {
    return -Number(bare.operand.text);
  }
  if (ts.isIdentifier(bare)) return readIdentifier(bare.text);
  if (ts.isArrayLiteralExpression(bare)) {
    return bare.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new UnreadableDeclaration(
          "an array element is a spread, whose value depends on another binding",
        );
      }
      return literalValue(element, readIdentifier);
    });
  }
  if (ts.isObjectLiteralExpression(bare)) {
    const value = {};
    for (const property of bare.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new UnreadableDeclaration(
          `an object property is ${describe(property)} rather than a plain \`key: value\` assignment`,
        );
      }
      const key = property.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        value[key.text] = literalValue(property.initializer, readIdentifier);
      } else {
        throw new UnreadableDeclaration(
          `an object key is ${describe(key)} rather than an identifier or a string`,
        );
      }
    }
    return value;
  }
  throw new UnreadableDeclaration(
    `its initializer is ${describe(bare)} rather than a literal`,
  );
}

/**
 * The initializer of each top-level `const` a source file declares, by name;
 * `null` where the declaration has none. Only the file's own statements are
 * walked, so a same-named binding inside a function shadows nothing here.
 */
function topLevelConstants(source) {
  const parsed = ts.createSourceFile(
    RULE_SET_SOURCE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constants = new Map();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      constants.set(declaration.name.text, declaration.initializer ?? null);
    }
  }
  return constants;
}

/**
 * Reads a named top-level declaration's value out of `constants`, evaluating it
 * once and remembering it. Every failure is attributed to the innermost
 * declaration that knows its own name, so a set composed from several
 * declarations reports the one to edit rather than the composition.
 */
function constantReader(constants) {
  const values = new Map();
  const reading = new Set();
  const read = (name) => {
    if (values.has(name)) return values.get(name);
    const initializer = constants.get(name);
    if (initializer === undefined) {
      throw new UnreadableDeclaration(
        `${RULE_SET_SOURCE} declares no top-level \`const ${name}\``,
        name,
      );
    }
    if (initializer === null) {
      throw new UnreadableDeclaration("it has no initializer", name);
    }
    if (reading.has(name)) {
      throw new UnreadableDeclaration("its initializer reads itself", name);
    }
    reading.add(name);
    try {
      const value = literalValue(initializer, read);
      values.set(name, value);
      return value;
    } catch (error) {
      if (error instanceof UnreadableDeclaration) {
        error.declaration ??= name;
      }
      throw error;
    } finally {
      reading.delete(name);
    }
  };
  return read;
}

/** The object literal `node` denotes, following an identifier to the
 * declaration that holds it. */
function objectAt(node, constants, where) {
  let bare = unwrap(node);
  const followed = new Set();
  while (ts.isIdentifier(bare)) {
    const name = bare.text;
    if (followed.has(name)) {
      throw new UnreadableDeclaration("its initializer reads itself", name);
    }
    followed.add(name);
    const initializer = constants.get(name);
    if (initializer === undefined) {
      throw new UnreadableDeclaration(
        `${RULE_SET_SOURCE} declares no top-level \`const ${name}\``,
        name,
      );
    }
    if (initializer === null) {
      throw new UnreadableDeclaration("it has no initializer", name);
    }
    bare = unwrapIn(initializer, name);
  }
  if (!ts.isObjectLiteralExpression(bare)) {
    throw new UnreadableDeclaration(
      `${where} is ${describe(bare)} rather than an object literal`,
    );
  }
  const properties = new Map();
  for (const property of bare.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new UnreadableDeclaration(
        `a property of ${where} is ${describe(property)} rather than a plain \`key: value\` assignment`,
      );
    }
    const key = property.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
      throw new UnreadableDeclaration(
        `a key of ${where} is ${describe(key)} rather than an identifier or a string`,
      );
    }
    properties.set(key.text, property.initializer);
  }
  return properties;
}

function propertyAt(properties, key, where) {
  const node = properties.get(key);
  if (node === undefined) {
    throw new UnreadableDeclaration(`${where} declares no \`${key}\``);
  }
  return node;
}

/** Which content property each half of the rule set takes its rules from. */
const HALF_CONTENT = { fieldSet: "linkageFields", keySet: "linkageKeys" };

/**
 * The rule set's two halves, each `{role, name, content}`. A half's `name` is
 * the declaration its content is composed from, or the property path where
 * the content is written inline.
 */
function readRuleSetHalves(constants, read) {
  const initializer = constants.get(RULE_SET_DECLARATION);
  if (initializer === undefined) {
    throw new UnreadableDeclaration(
      `${RULE_SET_SOURCE} declares no top-level \`const ${RULE_SET_DECLARATION}\``,
      RULE_SET_DECLARATION,
    );
  }
  if (initializer === null) {
    throw new UnreadableDeclaration(
      "it has no initializer",
      RULE_SET_DECLARATION,
    );
  }
  const where = `\`${RULE_SET_DECLARATION}\``;
  const entry = objectAt(
    unwrapIn(initializer, RULE_SET_DECLARATION),
    constants,
    where,
  );

  const halves = {};
  for (const [role, contentKey] of Object.entries(HALF_CONTENT)) {
    const node = propertyAt(entry, contentKey, where);
    halves[role] = {
      role,
      name: declarationName(node) ?? `${RULE_SET_DECLARATION}.${contentKey}`,
      content: literalValue(node, read),
    };
  }
  return { declaration: RULE_SET_DECLARATION, ...halves };
}

/**
 * The rule set a source file declares, as `{ruleSet, unreadable}`. `ruleSet`
 * is `{declaration, fieldSet, keySet}`, each half `{role, name, content}`; it
 * is `undefined` where any declaration it composes is unreadable, and the
 * reason is in `unreadable`.
 */
export function readRuleSet(source) {
  const constants = topLevelConstants(source);
  const read = constantReader(constants);
  try {
    return { ruleSet: readRuleSetHalves(constants, read), unreadable: [] };
  } catch (error) {
    if (!(error instanceof UnreadableDeclaration)) throw error;
    return {
      ruleSet: undefined,
      unreadable: [
        {
          declaration: error.declaration ?? RULE_SET_DECLARATION,
          reason: error.message,
        },
      ],
    };
  }
}

/**
 * {@link readRuleSet} over the tree at `root`. A source file the tree does not
 * hold at all -- reachable through a caller's `--root` pointed at a tree
 * missing it -- is unreadable the same way a bad declaration is, under
 * {@link RULE_SET_SOURCE} rather than a declaration name, so a caller's
 * `unreadable`-to-`blocked` mapping covers this failure with no separate catch
 * of its own.
 */
export function readRuleSetFrom(root) {
  let source;
  try {
    source = readFileSync(resolve(root, RULE_SET_SOURCE), "utf8");
  } catch (error) {
    return {
      ruleSet: undefined,
      unreadable: [{ declaration: RULE_SET_SOURCE, reason: error.message }],
    };
  }
  return readRuleSet(source);
}
