import { afterEach, describe, expect, test, vi } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { managedRunRelayPlan } from "@psi/managed/managedRendezvous";

const DEFAULT_TURN = "turns:turn.example.org:443?transport=tcp";

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    {
      defaultRelayBuild: () => ({
        kind: "opt-in",
        relay: {
          turnUrl: "turns:turn.example.org:443?transport=tcp",
          registrarUrl: "https://turn.example.org",
        },
      }),
    },
  ),
);

// A saved exchange's run uses the relay server the build offers switched off
// by the exchange's own switch, never this browser's.

function record(defaultRelayOn?: true) {
  return {
    side: "acceptor" as const,
    sharedSecret: generateSharedSecret(),
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    ...(defaultRelayOn !== undefined ? { defaultRelayOn } : {}),
  };
}

const enrolled = {
  enroll: () => Promise.resolve({ kind: "enrolled" as const, lapsesAt: null }),
};

describe("a saved exchange's default relay switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("lists the build's relay where the exchange turns it on, whatever this browser's switch says", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const plan = await managedRunRelayPlan(record(true), {
      defaultRelay: enrolled,
    });
    expect(plan.relay?.turn).toEqual([DEFAULT_TURN]);
    expect(plan.defaultRelayOff).toBeUndefined();
  });

  test("leaves it off where the exchange does, though this browser's switch is on", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "alcove-default-relay-on" ? "1" : null,
    });
    const plan = await managedRunRelayPlan(record(), {
      defaultRelay: enrolled,
    });
    expect(plan.relay).toBeUndefined();
    expect(plan.defaultRelayOff).toBe(true);
  });
});
