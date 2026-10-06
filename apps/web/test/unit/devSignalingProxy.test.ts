import { afterEach, describe, expect, test, vi } from "vitest";

import { DEV_SIGNALING_PORT_ENV } from "../../src/utils/devSignalingPort";
import { devSignalingProxy } from "../../vite.config";

describe("devSignalingProxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("forwards /api/ to the broker when serving for development", () => {
    vi.stubEnv(DEV_SIGNALING_PORT_ENV, "4321");
    expect(devSignalingProxy({ command: "serve", isPreview: false })).toEqual({
      "/api/": { target: "http://127.0.0.1:4321", ws: true },
    });
  });

  test.each([
    { command: "serve", isPreview: true },
    { command: "build", isPreview: false },
  ] as const)("installs no proxy for %j", (configEnv) => {
    vi.stubEnv(DEV_SIGNALING_PORT_ENV, "4321");
    expect(devSignalingProxy(configEnv)).toEqual({});
  });
});
