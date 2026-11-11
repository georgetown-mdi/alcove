// The browser bundle's `diffie-hellman`, aliased in by apps/web/vite.config.ts.
// The SSH library requires the package when it loads and calls it only for a
// negotiated finite-field key exchange, which the client never offers; so this
// loads cleanly and every entry throws the client's named error.

import { BrowserSshUnsupportedKeyExchangeError } from "../browserSshErrors";

function unsupported(entry: string): never {
  throw new BrowserSshUnsupportedKeyExchangeError(entry);
}

/** Throws {@link BrowserSshUnsupportedKeyExchangeError}. */
export function getDiffieHellman(_group: string): never {
  return unsupported("getDiffieHellman");
}

/** Throws {@link BrowserSshUnsupportedKeyExchangeError}. */
export function createDiffieHellman(..._args: Array<unknown>): never {
  return unsupported("createDiffieHellman");
}

/** Throws {@link BrowserSshUnsupportedKeyExchangeError}. */
export const DiffieHellmanGroup = getDiffieHellman;
/** Throws {@link BrowserSshUnsupportedKeyExchangeError}. */
export const createDiffieHellmanGroup = getDiffieHellman;
/** Throws {@link BrowserSshUnsupportedKeyExchangeError}. */
export const DiffieHellman = createDiffieHellman;
