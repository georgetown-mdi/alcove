import { describe, expect, test } from "vitest";

import {
  CONNECTION_TUNING_DEFAULT,
  WEBRTC_CONNECTION_TUNING,
  connectionTuningOptions,
  connectionTuningProblems,
  connectionTuningSummary,
} from "@console/connectionTuningModel";
import {
  fetchSignalingServer,
  putSignalingServer,
  signalingServerProjectionOf,
} from "@psi/jobClient/signalingServerClient";
import {
  signalingServerAddress,
  signalingServerReachProblem,
  webrtcEndpointForSignalingServer,
} from "@console/signalingServerModel";

import type { SignalingServerProjection } from "@jobContract/signalingServer";

const HOSTED: SignalingServerProjection = {
  host: "signal.example.org",
  port: 8443,
  path: "/api/",
  secure: true,
  webAppOrigin: "https://app.example.org",
  warnings: [],
};

function answering(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

describe("the coordination server client", () => {
  test("reads a configured server, and none for anything else", async () => {
    expect(
      await fetchSignalingServer(
        answering(200, { configured: true, ...HOSTED }),
      ),
    ).toEqual(HOSTED);
    expect(
      await fetchSignalingServer(answering(200, { configured: false })),
    ).toBeNull();
    expect(await fetchSignalingServer(answering(404, undefined))).toBeNull();
  });

  test.each([
    ["no host", { host: "" }],
    ["a port out of range", { port: 0 }],
    ["a relative path", { path: "api/" }],
    ["a web app that is not an origin", { webAppOrigin: "https://a.test/x" }],
    ["a web app with another scheme", { webAppOrigin: "javascript:alert(1)" }],
  ])("refuses a projection with %s", (_, overrides) => {
    expect(
      signalingServerProjectionOf({
        configured: true,
        ...HOSTED,
        ...overrides,
      }),
    ).toBeNull();
  });

  test("tells a refused address from a superseded or failed request", async () => {
    expect(
      await putSignalingServer(
        "wss://x",
        answering(200, { configured: true, ...HOSTED }),
      ),
    ).toEqual({ kind: "ok", server: HOSTED });
    expect(
      await putSignalingServer(
        "https://x",
        answering(502, { error: "Could not read it. Type it again." }),
      ),
    ).toEqual({
      kind: "refused",
      message: "Could not read it. Type it again.",
    });
    expect(
      await putSignalingServer("wss://x", answering(409, undefined)),
    ).toEqual({ kind: "superseded" });
    expect(
      await putSignalingServer("wss://x", answering(500, undefined)),
    ).toEqual({ kind: "error" });
  });
});

describe("the console's coordination server", () => {
  test("is shown as the address the run dials", () => {
    expect(signalingServerAddress(HOSTED)).toBe(
      "wss://signal.example.org:8443/api/",
    );
    expect(
      signalingServerAddress({
        host: "127.0.0.1",
        path: "/",
        secure: false,
        warnings: [],
      }),
    ).toBe("ws://127.0.0.1/");
  });

  test("mints an endpoint with its host, port and path and no relay", () => {
    expect(webrtcEndpointForSignalingServer(HOSTED)).toStrictEqual({
      channel: "webrtc",
      host: "signal.example.org",
      port: 8443,
      path: "/api/",
    });
  });

  test("names a server a partner elsewhere cannot reach", () => {
    expect(signalingServerReachProblem(HOSTED)).toBeUndefined();
    expect(
      signalingServerReachProblem({ ...HOSTED, host: "127.0.0.1" }),
    ).toContain("on this computer");
    expect(signalingServerReachProblem({ ...HOSTED, host: "[::1]" })).toContain(
      "on this computer",
    );
    expect(
      signalingServerReachProblem({ ...HOSTED, host: "10.0.0.4" }),
    ).toContain("on your local network");
  });
});

describe("a WebRTC run's connection tuning", () => {
  test("has no check interval to state, show, or refuse", () => {
    const draft = {
      ...CONNECTION_TUNING_DEFAULT,
      pollInterval: { magnitude: "0", unit: "s" as const },
      peerTimeout: { magnitude: "2", unit: "m" as const },
    };
    expect(connectionTuningOptions(draft, WEBRTC_CONNECTION_TUNING)).toEqual({
      peerTimeoutMs: 120_000,
    });
    expect(connectionTuningProblems(draft, WEBRTC_CONNECTION_TUNING)).toEqual(
      [],
    );
    expect(
      connectionTuningSummary(
        { ...CONNECTION_TUNING_DEFAULT, pollInterval: draft.pollInterval },
        WEBRTC_CONNECTION_TUNING,
      ),
    ).toBe("Default");
  });
});
