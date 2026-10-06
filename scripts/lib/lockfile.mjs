// Reading the `packages` map of an npm lockfile, shared by the checks that
// hold the committed package-lock.json or an installed tree against it.

const NM = "node_modules/";

/**
 * The directory name a lockfile entry installs under: "@openmined/psi.js" from
 * "node_modules/@openmined/psi.js", "leaf" from
 * "node_modules/has-nested/node_modules/leaf". A key holding no node_modules
 * segment -- the root, a workspace -- is returned as it is.
 */
export const installedAs = (path) =>
  path.includes(NM) ? path.slice(path.lastIndexOf(NM) + NM.length) : path;

/**
 * The package a copy installed under `installedName` holds. npm writes the
 * `name` field only where it disagrees with the directory, which is what an
 * alias does.
 */
export const packageIdentity = (installedName, entry) =>
  typeof entry?.name === "string" ? entry.name : installedName;
