#!/usr/bin/env node
// Failure display-sink check: `npm run check:run-failure-sink`, run by
// static_checks.yaml. A failed run's `message` and `reportedCause` are cause
// chains laid out line by line, and each renders through exactly one component
// in apps/web/src/exchange/RunSurface.tsx; an inline render elsewhere collapses
// the chain onto one line.
//
// Fails when a `.message` or `.reportedCause` read off a binding annotated with
// one of FAILURE_TYPES sits inside a JSX expression container anywhere but the
// same-named attribute of that piece's sink. A read taken as a condition (an
// equality operand, a `!` operand, a conditional's test, the left of `&&`) is
// not a render; `??` and `||` are. Also fails when a tracked type or a sink is
// not declared where this file names it, or no render goes through a sink.
//
// Reads every source under apps/web/src with a TypeScript parse, no type
// checker: a binding is a name annotated with a tracked type, matched by name
// within one file. A read reaching JSX through a local, a helper, or a
// container built outside JSX is not seen, so this catches the habitual inline
// span and is not a proof. Exit 0 clean, 1 on a finding. Binding rules and limits:
// docs/notes/repo-check-scripts.md.

import ts from "typescript";
import { fileURLToPath } from "node:url";

import {
  descendants,
  exportsFunction,
  parseFile,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

/** The tree every scanned source is taken from. */
export const WEB_SOURCE_DIR = "apps/web/src";

/**
 * The failure types the sinks below are the one render path for, each with the
 * file declaring it, held by the vacuity guard. A name absent from this list
 * binds nothing in the walk and so is held to nothing.
 */
export const FAILURE_TYPES = /** @type {const} */ ([
  { name: "RunFailure", file: "apps/web/src/exchange/useInviterExchange.ts" },
  {
    name: "ManagedRunFailureAlert",
    file: "apps/web/src/recurring/managedRunLaunchModel.ts",
  },
  { name: "FailureText", file: "apps/web/src/exchange/RunSurface.tsx" },
]);

const FAILURE_TYPE_NAMES = new Set(FAILURE_TYPES.map(({ name }) => name));

/** Where every sink below is declared, held by the vacuity guards. */
export const SINK_COMPONENT_FILE = "apps/web/src/exchange/RunSurface.tsx";

/**
 * The sink each piece of a failure's operator-facing text renders through,
 * keyed by the property it is read off. A sink takes its piece as the prop of
 * that same name, so the allowed position is `<Sink property={...} />` and
 * nothing else.
 */
export const TEXT_SINKS = /** @type {const} */ ([
  { property: "message", component: "FailureMessage" },
  { property: "reportedCause", component: "FailureReportedCause" },
]);

/**
 * The declaration `node` annotates, with the property key path from that
 * declaration's type down to `node` -- empty when the annotation is the
 * declaration's own type. `declaration` is undefined for a member of a named
 * type, which annotates no declaration of its own.
 */
function annotatedDeclaration(node) {
  const keys = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertySignature(current) || ts.isPropertyDeclaration(current)) {
      if (!ts.isIdentifier(current.name) && !ts.isStringLiteral(current.name))
        return undefined;
      keys.unshift(current.name.text);
      continue;
    }
    if (ts.isParameter(current) || ts.isVariableDeclaration(current))
      return { declaration: current, keys };
    // A function boundary ends the walk: a type reference in a return type or a
    // nested signature names nothing the body binds.
    if (ts.isFunctionLike(current)) return undefined;
  }
  return keys.length > 0 ? { declaration: undefined, keys } : undefined;
}

/**
 * The local name an object binding `pattern` gives the value at property path
 * `keys`, as a one-element array -- none when the path reaches no plain name,
 * because it is destructured further, taken by a rest element, or left
 * unbound.
 */
function destructuredNames(pattern, [key, ...rest]) {
  for (const element of pattern.elements) {
    const bound = element.propertyName ?? element.name;
    if (element.dotDotDotToken || !ts.isIdentifier(bound) || bound.text !== key)
      continue;
    if (rest.length > 0)
      return ts.isObjectBindingPattern(element.name)
        ? destructuredNames(element.name, rest)
        : [];
    return ts.isIdentifier(element.name) ? [element.name.text] : [];
  }
  return [];
}

/**
 * The names an annotation binds its value under, by the walk the module header
 * describes: the local a destructuring introduces for an annotated member, and
 * otherwise the declaration's own identifier or the member's key.
 */
function boundNames({ declaration, keys }) {
  if (!declaration) return keys.slice(-1);
  const { name } = declaration;
  if (keys.length > 0)
    return ts.isObjectBindingPattern(name)
      ? destructuredNames(name, keys)
      : keys.slice(-1);
  if (ts.isIdentifier(name)) return [name.text];
  // The `useState<RunFailure>()` shape: the state value is the array pattern's
  // first element, the second being its setter.
  if (ts.isArrayBindingPattern(name)) {
    const [first] = name.elements;
    if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name))
      return [first.name.text];
  }
  return [];
}

/**
 * Every name `sourceFile` annotates as one of {@link FAILURE_TYPES}, by the
 * walk the module header describes. Sorted, so a failure report reads the same
 * on every run.
 */
export function failureBindingNames(sourceFile) {
  const names = new Set();
  for (const node of descendants(sourceFile)) {
    if (
      !ts.isTypeReferenceNode(node) ||
      !ts.isIdentifier(node.typeName) ||
      !FAILURE_TYPE_NAMES.has(node.typeName.text)
    )
      continue;
    const annotation = annotatedDeclaration(node);
    if (annotation) for (const name of boundNames(annotation)) names.add(name);
  }
  return [...names].sort();
}

/**
 * The name of the element whose `property`-named attribute `container` is the
 * value of, or undefined when the container sits in any other JSX position -- a
 * child, or another attribute.
 */
function propElementName(container, property) {
  const attribute = container.parent;
  if (!attribute || !ts.isJsxAttribute(attribute)) return undefined;
  if (!ts.isIdentifier(attribute.name)) return undefined;
  if (attribute.name.text !== property) return undefined;
  const opening = attribute.parent?.parent;
  if (
    !opening ||
    !(ts.isJsxSelfClosingElement(opening) || ts.isJsxOpeningElement(opening)) ||
    !ts.isIdentifier(opening.tagName)
  )
    return undefined;
  return opening.tagName.text;
}

/** The comparisons whose operands are read for a verdict rather than for their
 * value, so a piece read into one reaches the operator through neither side. */
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Whether `node` is read as a condition and not as a value: an operand of an
 * equality comparison, the operand of a `!`, a conditional expression's test,
 * or the left side of a `&&`, which yields that side only where it is falsy and
 * so renders nothing the operator reads. A `??` or a `||` is neither: each
 * yields the left side's own value. Whatever the guarded branch renders is a
 * read of its own.
 */
function readAsCondition(node) {
  const { parent } = node;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) {
    if (EQUALITY_OPERATORS.has(parent.operatorToken.kind)) return true;
    if (parent.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
      return false;
    // A `&&` hands its RIGHT side on as the whole expression's value, so that
    // side is a condition only where the expression it yields to is one --
    // which is the chained guard, `{a && failure.reportedCause && <Sink />}`.
    return parent.left === node || readAsCondition(parent);
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  return (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  );
}

/**
 * Every JSX render of a failure's operator-facing text in `sourceFile`, as
 * `{line, text, property, throughSink}` records in source order. `throughSink`
 * is true for the one allowed position -- the property's own attribute of its
 * own sink in {@link TEXT_SINKS} -- and false for every other container.
 */
export function failureTextRenders(sourceFile) {
  const names = new Set(failureBindingNames(sourceFile));
  if (names.size === 0) return [];
  const found = [];
  for (const node of descendants(sourceFile)) {
    if (
      !ts.isPropertyAccessExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !names.has(node.expression.text)
    )
      continue;
    const sink = TEXT_SINKS.find(
      (candidate) => candidate.property === node.name.text,
    );
    if (!sink || readAsCondition(node)) continue;
    let container;
    for (let up = node.parent; up; up = up.parent) {
      if (ts.isJsxExpression(up)) {
        container = up;
        break;
      }
    }
    if (!container) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    found.push({
      line: line + 1,
      text: node.getText(),
      property: sink.property,
      throughSink: propElementName(container, sink.property) === sink.component,
    });
  }
  return found;
}

/** True when `sourceFile` declares a type named `name`. */
export function declaresType(sourceFile, name) {
  return descendants(sourceFile).some(
    (node) =>
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === name,
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = [];

  for (const { name, file } of FAILURE_TYPES)
    if (!declaresType(parseFile(file), name))
      failures.push(
        `${file}: no longer declares ${name} -- it moved or was renamed, and this check scans for that name; update scripts/check-run-failure-sink.mjs to follow it.`,
      );
  const sinkSource = parseFile(SINK_COMPONENT_FILE);
  for (const { component } of TEXT_SINKS)
    if (!exportsFunction(sinkSource, component))
      failures.push(
        `${SINK_COMPONENT_FILE}: no longer exports ${component} -- the sink moved or was renamed, and this check names it; update scripts/check-run-failure-sink.mjs to follow it.`,
      );

  const files = sourceModules(WEB_SOURCE_DIR);
  const throughSink = new Map(TEXT_SINKS.map(({ property }) => [property, 0]));
  for (const file of files) {
    const sourceFile = parseFile(file);
    for (const {
      line,
      text,
      property,
      throughSink: allowed,
    } of failureTextRenders(sourceFile)) {
      if (allowed) {
        throughSink.set(property, throughSink.get(property) + 1);
        continue;
      }
      const { component } = TEXT_SINKS.find(
        (sink) => sink.property === property,
      );
      failures.push(
        `${file}:${line}: renders \`${text}\` outside the ${component} sink (${SINK_COMPONENT_FILE}) -- a failure's ${property} is a cause chain laid out by that component alone, on the renderer's own newlines and on the escaped line-break markers a value's text holds; render it as <${component} ${property}={...} /> instead of styling a span here.`,
      );
    }
  }

  for (const { property, component } of TEXT_SINKS)
    if (throughSink.get(property) === 0)
      failures.push(
        `No render through the ${component} sink was found under ${WEB_SOURCE_DIR} -- with nothing going through it this check protects nothing for a failure's ${property}, so either the sink's callers moved out of this scan's reach or the binding walk stopped recognizing them; update scripts/check-run-failure-sink.mjs to follow them.`,
      );

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  const counts = TEXT_SINKS.map(
    ({ property, component }) =>
      `${throughSink.get(property)} of ${property} through ${component}`,
  ).join(", ");
  console.log(
    `Failure display-sink check passed: ${counts}, across ${files.length} scanned file(s), with no render outside a sink.`,
  );
}
