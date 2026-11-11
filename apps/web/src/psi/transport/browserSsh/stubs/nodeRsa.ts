// The browser bundle's `node-rsa`, aliased in by apps/web/vite.config.ts. The
// SSH library requires it, undeclared, only on its Node code path, which a
// browser never takes; a bundler still has to resolve the specifier.

/** Throws: the browser build does not include `node-rsa`. */
export default function NodeRsa(): never {
  throw new Error("node-rsa is not included in the browser build.");
}
