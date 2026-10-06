#!/usr/bin/env node
// Error Alert role check; scripts/run-checks.mjs lists it.
//
// WHAT IS HELD. A red (error) Mantine `<Alert>` under apps/web/src sets a role
// a screen reader announces: `role="alert"` or `role="status"` written at the
// call site, or `role={alertRoleFor(color)}` (apps/web/src/theme.ts) where the
// color is chosen at runtime. A red Alert that sets no role takes the theme's
// polite default rather than the interrupting `alert` an error is given, and
// one set to `presentation`, `none` or `note` is not announced at all. An
// Alert whose color is an expression rather than a literal may be red, so it
// is held the same way, and its `alertRoleFor` argument must be its own color
// expression.
//
// THE DOCUMENTED EXCEPTIONS are QUIET_ERROR_ALERTS below: a red Alert that is
// visible only because a separate live region already announces its text, or
// a standing note beside a control whose own status line announces the block.
// Each entry names the site by file, enclosing component and title, and states
// where the announcement is made; an entry no site matches fails, so the list
// cannot outlive the code it excuses.
//
// HOW AN ALERT IS FOUND: every JSX element whose tag is the bare identifier
// `Alert`, read with the TypeScript parser, so an Alert in a comment or a string
// is not a finding. Its `color` and `role` attributes are read as written; a
// spread attribute could hold either, so an Alert with one fails unless it sets
// both after it by name.
//
// WHAT IT DOES NOT COVER: an Alert rendered under another name (an import
// alias, a wrapper component whose own `color` prop is forwarded), a color
// that becomes red through a theme variant rather than the `color` prop, and
// any tree but apps/web/src.

import ts from "typescript";
import { fileURLToPath } from "node:url";

import {
  descendants,
  exportsFunction,
  parseFile,
  parseSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

/** The tree every scanned source is taken from. */
export const WEB_SOURCE_DIR = "apps/web/src";

/** Where the runtime-color role helper is declared, held by the vacuity guard. */
export const ROLE_HELPER = {
  name: "alertRoleFor",
  file: "apps/web/src/theme.ts",
};

/** The role values a screen reader announces as a live region. */
const ANNOUNCED_ROLES = new Set(["alert", "status"]);

/**
 * The red Alerts that are not live regions by design, each keyed by file,
 * enclosing component and the source text of its `title` attribute, with where
 * its text is announced instead.
 */
export const QUIET_ERROR_ALERTS = [
  {
    file: "apps/web/src/exchange/AcceptorColumnsStep.tsx",
    component: "AcceptorColumnsStep",
    title: "{verdict.title}",
    reason:
      "the deferred polite region below the verdict voices it, so a verdict present on mount is still announced",
  },
  {
    file: "apps/web/src/exchange/AcceptorColumnsStep.tsx",
    component: "AcceptorColumnsStep",
    title: "{declarationConflict.title}",
    reason:
      "a standing note beside the marks; the launch button's blocked-reason line announces the block",
  },
  {
    file: "apps/web/src/exchange/AcceptorColumnsStep.tsx",
    component: "AcceptorColumnsStep",
    title: "{overlongAlert.title}",
    reason:
      "a standing note above the grid; the launch button's blocked-reason line announces the block",
  },
  {
    file: "apps/web/src/components/FieldCoverage.tsx",
    component: "FieldCoverage",
    title: "(none)",
    reason:
      "the host editor's coverage live region announces once for every field card",
  },
  {
    file: "apps/web/src/console/SftpAuthoringForm.tsx",
    component: "HostKeyProbe",
    title: '"Could not read the fingerprint"',
    reason: "the probe's stable status region announces the failure",
  },
  {
    file: "apps/web/src/console/MountedConfigurationCard.tsx",
    component: "MountedConfigurationCard",
    title: "{REFUSED_TITLE}",
    reason: "the card's status region announces the refusal",
  },
];

/** The name of the function or component `node` sits in, or `(module)`. */
function enclosingComponent(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name) return up.name.text;
    if (
      (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) &&
      ts.isVariableDeclaration(up.parent) &&
      ts.isIdentifier(up.parent.name)
    )
      return up.parent.name.text;
  }
  return "(module)";
}

/** The expression an attribute's initializer holds, unwrapped from `{...}`. */
function attributeExpression(attribute) {
  const { initializer } = attribute;
  if (!initializer) return undefined;
  if (ts.isJsxExpression(initializer)) return initializer.expression;
  return initializer;
}

/** The text of a string literal, `"red"` or `{"red"}`, or undefined. */
function literalText(expression) {
  if (!expression) return undefined;
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return expression.text;
  return undefined;
}

/**
 * Every `<Alert>` in `sourceFile` that may be red, as `{line, component, title,
 * problem}` records in source order. `problem` is undefined where the Alert
 * sets an announced role, and otherwise states what it sets instead.
 */
export function errorAlerts(sourceFile) {
  const found = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node))
      continue;
    if (!ts.isIdentifier(node.tagName) || node.tagName.text !== "Alert")
      continue;
    let color;
    let role;
    let title;
    let spreadUnresolved = false;
    for (const attribute of node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        spreadUnresolved = true;
        color = undefined;
        role = undefined;
        continue;
      }
      if (!ts.isIdentifier(attribute.name)) continue;
      const name = attribute.name.text;
      if (name === "color") color = attribute;
      else if (name === "role") role = attribute;
      else if (name === "title")
        title = attribute.initializer?.getText(sourceFile).replace(/\s+/g, " ");
    }
    if (spreadUnresolved && (color === undefined || role === undefined)) {
      found.push(
        record(
          sourceFile,
          node,
          title,
          "spreads props, so its color and role cannot be read",
        ),
      );
      continue;
    }
    const colorExpression = color && attributeExpression(color);
    const colorLiteral = literalText(colorExpression);
    if (
      color === undefined ||
      (colorLiteral !== undefined && colorLiteral !== "red")
    )
      continue;
    found.push(
      record(
        sourceFile,
        node,
        title,
        roleProblem(
          sourceFile,
          role,
          colorLiteral === undefined ? colorExpression : undefined,
        ),
      ),
    );
  }
  return found;
}

/**
 * What is wrong with a may-be-red Alert's `role` attribute, or undefined when it
 * is announced. `runtimeColor` is the color expression when it is not a
 * literal, which an `alertRoleFor` call must take as its argument.
 */
function roleProblem(sourceFile, role, runtimeColor) {
  if (role === undefined) return "sets no role";
  const expression = attributeExpression(role);
  const literal = literalText(expression);
  if (literal !== undefined)
    return ANNOUNCED_ROLES.has(literal) ? undefined : `sets role="${literal}"`;
  if (
    expression &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === ROLE_HELPER.name &&
    expression.arguments.length === 1
  ) {
    const argument = expression.arguments[0].getText(sourceFile);
    if (
      runtimeColor === undefined ||
      argument === runtimeColor.getText(sourceFile)
    )
      return undefined;
    return `passes ${argument} to ${ROLE_HELPER.name} but its color is ${runtimeColor.getText(sourceFile)}`;
  }
  return `sets role=${role.initializer?.getText(sourceFile) ?? "(empty)"}`;
}

function record(sourceFile, node, title, problem) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    line: line + 1,
    component: enclosingComponent(node),
    title: title ?? "(none)",
    problem,
  };
}

/**
 * The failures for the Alerts found across `files` (`{file, alerts}` pairs),
 * with each {@link QUIET_ERROR_ALERTS} entry excusing its one site, and an
 * entry that matches no site reported as stale.
 */
export function alertRoleFailures(scanned, exceptions = QUIET_ERROR_ALERTS) {
  const failures = [];
  const used = new Set();
  for (const { file, alerts } of scanned)
    for (const { line, component, title, problem } of alerts) {
      if (problem === undefined) continue;
      const excused = exceptions.findIndex(
        (entry) =>
          entry.file === file &&
          entry.component === component &&
          entry.title === title,
      );
      if (excused !== -1) {
        used.add(excused);
        continue;
      }
      failures.push(
        `${file}:${line}: the red Alert titled ${title} in ${component} ${problem} -- an error Alert is announced, so set role="alert" (role={${ROLE_HELPER.name}(color)} where the color is chosen at runtime); if a separate live region already announces its text, add the site to QUIET_ERROR_ALERTS in scripts/check-alert-roles.mjs with where.`,
      );
    }
  exceptions.forEach(({ file, component, title }, index) => {
    if (!used.has(index))
      failures.push(
        `QUIET_ERROR_ALERTS names ${file} ${component} ${title}, but no unannounced red Alert there has that title -- it moved, was renamed, or now sets an announced role; update or delete the entry in scripts/check-alert-roles.mjs.`,
      );
  });
  return failures;
}

/** Scan source text as one file, for a fixture. */
export function errorAlertsInSource(fileName, text) {
  return errorAlerts(parseSource(fileName, text));
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = [];
  if (!exportsFunction(parseFile(ROLE_HELPER.file), ROLE_HELPER.name))
    failures.push(
      `${ROLE_HELPER.file}: no longer exports ${ROLE_HELPER.name} -- it moved or was renamed, and this check accepts a call to it by name; update scripts/check-alert-roles.mjs to follow it.`,
    );
  const files = sourceModules(WEB_SOURCE_DIR).filter((file) =>
    file.endsWith(".tsx"),
  );
  const scanned = files.map((file) => ({
    file,
    alerts: errorAlerts(parseFile(file)),
  }));
  const total = scanned.reduce((sum, { alerts }) => sum + alerts.length, 0);
  if (total === 0)
    failures.push(
      `No red Alert was found under ${WEB_SOURCE_DIR} -- with none found this check holds nothing, so the scan has stopped recognizing them; update scripts/check-alert-roles.mjs.`,
    );
  failures.push(...alertRoleFailures(scanned));
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `Error Alert role check passed: ${total} red or runtime-color Alert(s) across ${files.length} scanned file(s), ${QUIET_ERROR_ALERTS.length} documented quiet site(s).`,
  );
}
