import type { Plugin } from "vite";

// Packages that read the server's environment and files: in a browser they
// either fail or are stubbed into silently reading nothing.
const SERVER_ONLY_PACKAGES = ["env-schema", "dotenv"];

const MAX_REPORTED_MODULES = 10;

/** Whether a module id or import specifier names a module a browser bundle
 * must not hold: a `node:` builtin, or any module of a server-only
 * configuration package. */
export function isServerOnlyModule(idOrSpecifier: string): boolean {
  if (idOrSpecifier.startsWith("node:")) return true;
  const path = idOrSpecifier.replace(/\\/g, "/");
  return SERVER_ONLY_PACKAGES.some(
    (name) =>
      path === name ||
      path.startsWith(`${name}/`) ||
      path.includes(`/node_modules/${name}/`),
  );
}

/**
 * Fails the build whose module graph reaches a module
 * {@link isServerOnlyModule} names. It records both the specifiers imports name
 * and the ids they resolve to, since a production browser build replaces every
 * Node builtin with one stub whose id no longer says which builtin it was. It
 * resolves, loads and rewrites nothing, so a guarded build's output is the
 * unguarded build's.
 */
export function clientModuleGraphGuard(): Plugin {
  const reached = new Map<string, string>();
  return {
    name: "alcove-client-module-graph-guard",
    apply: "build",
    enforce: "pre",
    buildStart() {
      reached.clear();
    },
    resolveId(source, importer) {
      if (isServerOnlyModule(source))
        reached.set(source, importer ?? "an entry");
      return null;
    },
    buildEnd(error) {
      if (error !== undefined) return;
      // A package's own files are named only when no import specifier was, so
      // one import reports one line rather than every file of the package.
      if (reached.size === 0)
        for (const id of this.getModuleIds())
          if (isServerOnlyModule(id)) reached.set(id, "the module graph");
      if (reached.size === 0) return;
      const found = [...reached]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([module, importer]) => `${module} (from ${importer})`);
      const shown = found.slice(0, MAX_REPORTED_MODULES);
      if (found.length > shown.length)
        shown.push(`and ${found.length - shown.length} more`);
      this.error(
        `the browser bundle imports server-only modules: ${shown.join(", ")}. ` +
          "Move each import behind a server-only module the browser code does not import.",
      );
    },
  };
}
