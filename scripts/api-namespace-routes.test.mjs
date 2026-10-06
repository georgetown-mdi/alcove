import { posix } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REGENERATE_COMMAND } from "./check-routetree-fresh.mjs";
import {
  filesUnder,
  parseFile,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// The web app's router serves no route under /api. Job handlers live only in
// the console server's route table, and the console server refuses the rest of
// the namespace ahead of it (apps/web/src/utils/apiNamespace.ts), so a page
// route under /api would never render on the console, and on the hosted static
// site it would answer as an ordinary page under the path the broker and the
// job API are known by. This is that obligation as a check.
//
// It reads the ROUTER'S OWN ACCOUNT of what it serves:
// the entries come from the generated route tree
// (apps/web/src/routeTree.gen.ts), whose FileRoutesByFullPath names every path
// the router resolves to and the module that answers it. Nothing here maps a
// file name to a path -- a route's path comes from its name as much as its
// directory (api.telemetry.ts, a `_`-prefixed pathless layout, a parenthesized
// group), and every rule for reading one is the generator's, so a copy of that
// rule here would decide a name the generator decides differently.
//
// The generated tree is a checked-in build product, so this check is only as
// current as it is; scripts/check-routetree-fresh.mjs is what holds it to what
// the pinned generator produces. Independent of that, an arm below holds the
// modules the tree names against the route tree on disk in both directions, so
// a route file added or removed without the regeneration is reported here
// rather than read past.
//
// public/ is read too. The hosted build copies it into the static site as it
// stands, so an asset under public/api would answer there under the namespace.
// None may exist.

const SELF = "scripts/api-namespace-routes.test.mjs";

// The refusal, the console entry that installs it, the router's account of the
// routes it serves, the tree those routes are written in, and the public
// assets, all repository-relative.
const GUARD_MODULE = "apps/web/src/utils/apiNamespace.ts";
const SERVER_ENTRY = "apps/web/server/console/app.ts";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const ROUTES_ROOT = "apps/web/src/routes";
const PUBLIC_DIR = "apps/web/public";

/** The wrapper the console entry installs. */
const GUARD = "withApiGuard";

/** The interface in the generated route tree that names every path the router
 * serves, mapped to the route that answers it. */
const SERVED_PATHS = "FileRoutesByFullPath";

/** The path the routes tree is served under, held against the refusal's own
 * constant so the two cannot name different namespaces. */
const API_PATH_ROOT = "/api";
const API_PATH_ROOT_CONSTANT = "API_PATH_ROOT";

/**
 * The string `name` is declared with in `sourceFile`, or null for any other
 * shape.
 */
function stringConstant(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== name) continue;
      const value = declaration.initializer;
      return value !== undefined && ts.isStringLiteral(value)
        ? value.text
        : null;
    }
  }
  return null;
}

/** Whether `sourceFile` imports `name` from a specifier whose tail is `tail`. */
function importsFrom(sourceFile, name, tail) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.endsWith(tail)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === name) return true;
  }
  return false;
}

/** Whether `path` is `prefix` itself or a path under it, by whole segments. */
function isUnderPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The route modules the routes tree holds, by their extensionless path, so a
 * specifier the generated tree writes without one names the file it was read
 * from. */
const modulesByStem = new Map(
  sourceModules(ROUTES_ROOT).map((file) => [file.replace(/\.tsx?$/, ""), file]),
);

/**
 * Every name the generated route tree imports, mapped to the module it comes
 * from, repository-relative and extensionless.
 */
function importedRoutes(sourceFile) {
  const base = posix.dirname(ROUTE_TREE);
  const byName = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      byName.set(element.name.text, posix.join(base, specifier.text));
  }
  return byName;
}

/**
 * Every name the generated route tree derives from another by a call on it --
 * `X.update(...)`, `X._addFileChildren(...)` -- mapped to that other name, so a
 * served path naming the derived one is read back to the module it was built
 * from.
 */
function derivedRoutes(sourceFile) {
  const byName = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const value = declaration.initializer;
      if (value === undefined || !ts.isCallExpression(value)) continue;
      const callee = value.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      if (!ts.isIdentifier(callee.expression)) continue;
      byName.set(declaration.name.text, callee.expression.text);
    }
  }
  return byName;
}

/**
 * Every path the router serves, as `{path, route}` pairs read from
 * {@link SERVED_PATHS}, or null when that interface is absent or holds a member
 * written in any shape other than a quoted path typed `typeof <route>` -- the
 * only one this check reads, so a generator that writes another fails the rot
 * guard rather than shrinking the enumeration.
 */
function servedPaths(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (statement.name.text !== SERVED_PATHS) continue;
    const served = [];
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member)) return null;
      if (!ts.isStringLiteral(member.name)) return null;
      const type = member.type;
      if (type === undefined || !ts.isTypeQueryNode(type)) return null;
      if (!ts.isIdentifier(type.exprName)) return null;
      served.push({ path: member.name.text, route: type.exprName.text });
    }
    return served;
  }
  return null;
}

const treeSource = parseFile(ROUTE_TREE);
const imported = importedRoutes(treeSource);
const derived = derivedRoutes(treeSource);
const served = servedPaths(treeSource) ?? [];

/**
 * The route module `route` is built from, repository-relative, or null when the
 * generated tree does not read back to one this checkout holds.
 */
function moduleOf(route) {
  const seen = new Set();
  let current = route;
  while (!imported.has(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    const next = derived.get(current);
    if (next === undefined) return null;
    current = next;
  }
  return modulesByStem.get(imported.get(current)) ?? null;
}

/**
 * Every served path under the namespace with the module that answers it, or
 * with no module named where the generated tree does not read back to one.
 */
function namespaceRoutes() {
  return served
    .filter(({ path }) => isUnderPrefix(path, API_PATH_ROOT))
    .map(({ path, route }) => {
      const module = moduleOf(route);
      return module === null ? path : `${path} (${module})`;
    });
}

const guardSource = parseFile(GUARD_MODULE);

describe("the router serves no route under /api", () => {
  it("reads the routes the router serves", () => {
    // A rot guard: a renamed guard, or a generated route tree this check no
    // longer reads, would otherwise empty the enumeration and make the
    // assertion below vacuous. The tree's served paths may not be empty.
    expect(
      stringConstant(guardSource, API_PATH_ROOT_CONSTANT),
      `${GUARD_MODULE} refuses under a namespace root other than ` +
        `"${API_PATH_ROOT}", so the routes tree this check reads is no longer ` +
        `the tree the refusal decides over.`,
    ).toBe(API_PATH_ROOT);
    expect(
      servedPaths(treeSource),
      `${ROUTE_TREE} no longer declares ${SERVED_PATHS} as quoted paths typed ` +
        `\`typeof <route>\`, which is the only shape this check reads, so the ` +
        `paths the router serves cannot be enumerated from it. Teach ${SELF} ` +
        `the new one.`,
    ).not.toBeNull();
    expect(served.length).toBeGreaterThan(0);
    expect(
      importsFrom(parseFile(SERVER_ENTRY), GUARD, "apiNamespace"),
      `${SERVER_ENTRY} no longer installs ${GUARD}, so nothing on the ` +
        `console server refuses the ${API_PATH_ROOT} namespace.`,
    ).toBe(true);
  });

  it("reads a route tree that names the route files on disk", () => {
    // The enumeration above is only as current as this generated file, so the
    // two are held against each other in both directions rather than this
    // check reading past a route the tree does not yet name.
    const named = new Set(
      [...imported.values()].filter((stem) => isUnderPrefix(stem, ROUTES_ROOT)),
    );
    const drifted = [
      ...[...named]
        .filter((stem) => !modulesByStem.has(stem))
        .map((stem) => `${stem}: named by ${ROUTE_TREE}, absent from disk`),
      ...[...modulesByStem.values()]
        .filter((file) => !named.has(file.replace(/\.tsx?$/, "")))
        .map((file) => `${file}: on disk, unnamed by ${ROUTE_TREE}`),
    ].sort();
    expect(
      drifted,
      `${drifted.length} route module(s) differ between ${ROUTES_ROOT} and ` +
        `${ROUTE_TREE}, so the served paths this check reads are not this ` +
        `checkout's. Regenerate the route tree and commit it:\n\n  ` +
        `${REGENERATE_COMMAND}`,
    ).toEqual([]);
  });

  it("serves nothing under /api from the public asset tree", () => {
    const assets = filesUnder(PUBLIC_DIR).filter(
      (path) => posix.relative(PUBLIC_DIR, path).split("/")[0] === "api",
    );
    expect(
      assets,
      `${assets.length} static asset(s) sit under ${PUBLIC_DIR}/api, which ` +
        `the hosted build copies into the static site, so each answers there ` +
        `under ${API_PATH_ROOT}. Serve it from a path outside ` +
        `${API_PATH_ROOT}.`,
    ).toEqual([]);
  });

  it("holds no route under /api", () => {
    const routes = namespaceRoutes();
    expect(
      routes,
      `${routes.length} route(s) in ${ROUTE_TREE} sit under ` +
        `${API_PATH_ROOT}, which the console server refuses ahead of the ` +
        `page and the hosted site serves as an ordinary page. Serve the page ` +
        `from a path outside ${API_PATH_ROOT}; a job handler belongs under ` +
        `apps/web/server/console/routes.`,
    ).toEqual([]);
  });
});
