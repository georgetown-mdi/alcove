import type * as ClientConfigModule from "@utils/clientConfig";

/** The exports of `@utils/clientConfig`, as the real module types them. */
export type ClientConfigExports = typeof ClientConfigModule;

/**
 * A `vi.mock` factory body for `@utils/clientConfig`: the real module with
 * `overrides` laid over it, so every export the real module has stays present
 * and each override is checked against the real export's type.
 *
 * Pulled in with a dynamic import from inside the mock body --
 * `vi.mock("@utils/clientConfig", async (importOriginal) => (await
 * import("../utils/clientConfigMock")).clientConfigMock(importOriginal, {...}))`
 * -- since Vitest hoists `vi.mock` above a top-level import.
 */
export async function clientConfigMock(
  importOriginal: () => Promise<ClientConfigExports>,
  overrides: Partial<ClientConfigExports> = {},
): Promise<ClientConfigExports> {
  return { ...(await importOriginal()), ...overrides };
}

/**
 * {@link clientConfigMock} as a console build: the console profile, no
 * signaling server setting, and no release version.
 */
export function consoleClientConfigMock(
  importOriginal: () => Promise<ClientConfigExports>,
): Promise<ClientConfigExports> {
  return clientConfigMock(importOriginal, {
    deploymentProfile: () => "console",
    isConsoleBuild: () => true,
    signalingServerSetting: () => undefined,
    alcoveVersion: () => undefined,
  });
}
