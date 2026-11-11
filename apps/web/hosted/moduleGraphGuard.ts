import type { Plugin } from "vite";

// Packages that read the server's environment and files: in a browser they
// either fail or are stubbed into silently reading nothing.
const SERVER_ONLY_PACKAGES = ["env-schema", "dotenv"];

/**
 * `diffie-hellman` and every package it brings (package-lock.json), the
 * finite-field key exchange the browser SSH client's library requires. Every
 * browser config aliases it to a stub (`browserSshDependencyAliases`,
 * vite.config.ts), so any of these in a browser bundle means the alias is
 * missing.
 */
export const DIFFIE_HELLMAN_CHAIN_PACKAGES = [
  "diffie-hellman",
  "bn.js",
  "miller-rabin",
  "brorand",
  "randombytes",
  "safe-buffer",
];

const MAX_REPORTED_MODULES = 10;

function namesPackage(
  idOrSpecifier: string,
  packages: ReadonlyArray<string>,
): boolean {
  const path = idOrSpecifier.replace(/\\/g, "/");
  return packages.some(
    (name) =>
      path === name ||
      path.startsWith(`${name}/`) ||
      path.includes(`/node_modules/${name}/`),
  );
}

/** Whether a module id or import specifier names a module a browser bundle
 * must not hold: a `node:` builtin, or any module of a server-only
 * configuration package. */
export function isServerOnlyModule(idOrSpecifier: string): boolean {
  return (
    idOrSpecifier.startsWith("node:") ||
    namesPackage(idOrSpecifier, SERVER_ONLY_PACKAGES)
  );
}

/** Whether a module id or import specifier names a package of
 * {@link DIFFIE_HELLMAN_CHAIN_PACKAGES}. */
export function isDiffieHellmanChainModule(idOrSpecifier: string): boolean {
  return namesPackage(idOrSpecifier, DIFFIE_HELLMAN_CHAIN_PACKAGES);
}

const FORBIDDEN = [
  {
    matches: isServerOnlyModule,
    problem: "the browser bundle imports server-only modules",
    remedy:
      "Move each import behind a server-only module the browser code does not import.",
  },
  {
    matches: isDiffieHellmanChainModule,
    problem: "the browser bundle holds the diffie-hellman package chain",
    remedy:
      "Add browserSshDependencyAliases from vite.config.ts to this build's resolve.alias.",
  },
] as const;

function describeReached(reached: Map<string, string>): string {
  const found = [...reached]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, importer]) => `${module} (from ${importer})`);
  const shown = found.slice(0, MAX_REPORTED_MODULES);
  if (found.length > shown.length)
    shown.push(`and ${found.length - shown.length} more`);
  return shown.join(", ");
}

/**
 * Fails the build whose module graph reaches a module
 * {@link isServerOnlyModule} or {@link isDiffieHellmanChainModule} names. It
 * records both the specifiers imports name and the ids they resolve to, since a
 * production browser build replaces every Node builtin with one stub whose id
 * no longer says which builtin it was. It resolves, loads and rewrites
 * nothing, so a guarded build's output is the unguarded build's.
 */
export function clientModuleGraphGuard(): Plugin {
  const reached = FORBIDDEN.map(() => new Map<string, string>());
  return {
    name: "alcove-client-module-graph-guard",
    apply: "build",
    enforce: "pre",
    buildStart() {
      for (const modules of reached) modules.clear();
    },
    resolveId(source, importer) {
      FORBIDDEN.forEach(({ matches }, index) => {
        if (matches(source)) reached[index].set(source, importer ?? "an entry");
      });
      return null;
    },
    buildEnd(error) {
      if (error !== undefined) return;
      const ids = [...this.getModuleIds()];
      const failures: Array<string> = [];
      FORBIDDEN.forEach(({ matches, problem, remedy }, index) => {
        const modules = reached[index];
        // A package's own files are named only when no import specifier was, so
        // one import reports one line rather than every file of the package.
        if (modules.size === 0)
          for (const id of ids)
            if (matches(id)) modules.set(id, "the module graph");
        if (modules.size > 0)
          failures.push(`${problem}: ${describeReached(modules)}. ${remedy}`);
      });
      if (failures.length > 0) this.error(failures.join(" "));
    },
  };
}
