// The browser bundle's `node-rsa`, aliased in by apps/web/vite.config.ts. The
// SSH library requires it, undeclared, only on its Node code path, which a
// browser never takes; a bundler still has to resolve the specifier.

import { BrowserSshVerifyOnlyError } from "../browserSshErrors";

/** Throws {@link BrowserSshVerifyOnlyError}. */
export default function NodeRsa(): never {
  throw new BrowserSshVerifyOnlyError("node-rsa");
}
