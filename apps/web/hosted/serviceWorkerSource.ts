import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Readers of the constants `public/serviceWorker.js` declares. The worker is a
// classic script with no exports, so its values are read from its source. Kept
// outside the test tree because the hosted build reads SHELL_ROUTES too, and
// the build and the tests must read the one list the same way.

/** The worker as it ships. */
export const serviceWorkerPath = fileURLToPath(
  new URL("../public/serviceWorker.js", import.meta.url),
);

/** The worker source, for a reader of a constant the classic script declares
 * (its top-level `const`s are lexical, so evaluating it exposes none). */
export function serviceWorkerSource(): string {
  return readFileSync(serviceWorkerPath, "utf8");
}

/** A numeric constant declared at the worker's top level, read from its source
 * so a test cannot assert against a stale copy of the value. */
export function serviceWorkerConstant(name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(
    serviceWorkerSource(),
  );
  if (match === null)
    throw new Error(`serviceWorker.js declares no numeric const ${name}`);
  return Number(match[1]);
}

/** A string constant declared at the worker's top level, read from its source
 * for the same reason as {@link serviceWorkerConstant} -- and, for a value the
 * client half declares its own copy of, so a test can hold the two against each
 * other rather than against a literal. */
export function serviceWorkerString(name: string): string {
  const match = new RegExp(`const ${name} = "([^"]*)";`).exec(
    serviceWorkerSource(),
  );
  if (match === null)
    throw new Error(`serviceWorker.js declares no string const ${name}`);
  return match[1];
}

/** A string-array constant declared at the worker's top level, read from its
 * source for the same reason as {@link serviceWorkerConstant}. Comments inside
 * the array are skipped, and an entry that does not start with `/` throws.
 * @param source - the worker source; the shipped worker when omitted. */
export function serviceWorkerStringArray(
  name: string,
  source: string = serviceWorkerSource(),
): Array<string> {
  const declaration = new RegExp(`const ${name} = \\[`).exec(source);
  if (declaration === null)
    throw new Error(`serviceWorker.js declares no array const ${name}`);
  const entries: Array<string> = [];
  let position = declaration.index + declaration[0].length;
  while (position < source.length && source[position] !== "]") {
    const rest = source.slice(position);
    const skipped = /^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
    const quoted = /^"([^"]*)"/.exec(rest);
    if (quoted !== null) entries.push(quoted[1]);
    position += (skipped ?? quoted)?.[0].length ?? 1;
  }
  const malformed = entries.find((entry) => !entry.startsWith("/"));
  if (malformed !== undefined)
    throw new Error(
      `serviceWorker.js ${name} entry "${malformed}" does not start with "/"`,
    );
  return entries;
}

/** The extensions the worker will store, read from the keys of its
 * `ASSET_CONTENT_TYPES` map in the shipped source. */
export function serviceWorkerStorableExtensions(): Array<string> {
  const block = /const ASSET_CONTENT_TYPES = new Map\(\[([\s\S]*?)\]\);/.exec(
    serviceWorkerSource(),
  );
  if (block === null)
    throw new Error("serviceWorker.js declares no ASSET_CONTENT_TYPES map");
  return [...block[1].matchAll(/\[\s*"([^"]*)"\s*,/g)].map((match) => match[1]);
}
