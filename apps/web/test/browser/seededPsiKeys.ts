import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// The keys a test-only PSI worker generates in place of fresh ones, so a test
// can build one engine under the same key and compare its bytes with a
// pool's. Imported by ./seededKeyPsiCrypto.worker.ts and the test alone.

/** The key every seeded starter (server) engine masks under. */
export const SEEDED_STARTER_KEY = new Uint8Array(32).fill(0x37);

/** The key every seeded joiner (client) engine masks under. */
export const SEEDED_JOINER_KEY = new Uint8Array(32).fill(0x52);

/** `library` with each side's new key replaced by its seeded key. */
export function withSeededKeys(library: PSILibrary): PSILibrary {
  const server = library.server!;
  const client = library.client!;
  return {
    ...library,
    server: {
      ...server,
      createWithNewKey: (reveal?: boolean) =>
        server.createFromKey(Uint8Array.from(SEEDED_STARTER_KEY), reveal),
    },
    client: {
      ...client,
      createWithNewKey: (reveal?: boolean) =>
        client.createFromKey(Uint8Array.from(SEEDED_JOINER_KEY), reveal),
    },
  };
}
