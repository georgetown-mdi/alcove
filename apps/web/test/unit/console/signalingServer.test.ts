import { describe, expect, test } from "vitest";

import {
  CONNECTION_TUNING_DEFAULT,
  WEBRTC_CONNECTION_TUNING,
  connectionTuningOptions,
  connectionTuningProblems,
  connectionTuningSummary,
} from "@console/connectionTuningModel";
import {
  acceptedSignalingServer,
  sameSignalingServer,
  signalingServerAddress,
  signalingServerReachProblem,
  webrtcEndpointForSignalingServer,
} from "@console/signalingServerModel";
import {
  fetchSignalingServer,
  putSignalingServer,
  signalingServerProjectionOf,
} from "@psi/jobClient/signalingServerClient";
import { acceptorWebrtcTransport } from "@exchange/useAcceptorExchange";

import type { SignalingServerProjection } from "@jobContract/signalingServer";
import type { WebRTCEndpoint } from "@alcove/core";

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

describe("sameSignalingServer", () => {
  test("is the same server only at the same address through the same web app", () => {
    expect(sameSignalingServer(HOSTED, { ...HOSTED, warnings: ["x"] })).toBe(
      true,
    );
    for (const other of [
      { ...HOSTED, host: "elsewhere.example.org" },
      { ...HOSTED, port: undefined },
      { ...HOSTED, path: "/" },
      { ...HOSTED, secure: false },
      { ...HOSTED, webAppOrigin: undefined },
    ])
      expect(sameSignalingServer(HOSTED, other)).toBe(false);
  });
});

describe("the coordination server a console accept dials", () => {
  const ENDPOINT: WebRTCEndpoint = {
    channel: "webrtc",
    host: "Signal.Example.org",
    port: 8443,
    path: "/api/",
  };
  const RELAY = { turn: ["turn:relay.example.org:3478"] };
  const LOCAL_WS: SignalingServerProjection = {
    host: "127.0.0.1",
    port: 9000,
    path: "/api/",
    secure: false,
    warnings: [],
  };

  test("is the invitation's server over wss://, as the console parses it", () => {
    expect(acceptedSignalingServer(ENDPOINT, null)).toEqual({
      address: "wss://signal.example.org:8443/api/",
      signalingServer: {
        host: "signal.example.org",
        port: 8443,
        path: "/api/",
      },
    });
  });

  test("takes the path / where the invitation states none, and names its relay", () => {
    expect(
      acceptedSignalingServer(
        { channel: "webrtc", host: "signal.example.org", relay: RELAY },
        null,
      ),
    ).toEqual({
      address: "wss://signal.example.org/",
      signalingServer: { host: "signal.example.org", path: "/", relay: RELAY },
    });
  });

  test("is reached over ws:// only where the console holds that same server at ws://", () => {
    const local: WebRTCEndpoint = {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 9000,
      path: "/api/",
    };
    expect(acceptedSignalingServer(local, LOCAL_WS)?.address).toBe(
      "ws://127.0.0.1:9000/api/",
    );
    for (const held of [
      { ...LOCAL_WS, port: 9001 },
      { ...LOCAL_WS, path: "/" },
      { ...LOCAL_WS, host: "127.0.0.2" },
      { ...LOCAL_WS, secure: true },
    ])
      expect(acceptedSignalingServer(local, held)?.address).toBe(
        "wss://127.0.0.1:9000/api/",
      );
  });

  test("is none where the invitation's path holds a query, fragment or escape", () => {
    for (const path of ["/api/?key=x", "/api/#x", "/a%2Fb/"])
      expect(acceptedSignalingServer({ ...ENDPOINT, path }, null)).toBe(
        undefined,
      );
  });

  test("is none where parsing the invitation's path writes an escape into it", () => {
    for (const path of ["/a b/", "/café/", "/{z}/"])
      expect(acceptedSignalingServer({ ...ENDPOINT, path }, null)).toBe(
        undefined,
      );
  });

  test("is none where the invitation's host or path would move the address", () => {
    for (const endpoint of [
      { ...ENDPOINT, host: "h.example/evil" },
      { ...ENDPOINT, host: "h.example\\x" },
      { ...ENDPOINT, host: "h.example:99" },
      { ...ENDPOINT, path: "a" },
    ])
      expect(acceptedSignalingServer(endpoint, null)).toBe(undefined);
  });

  test("is set on the console with the invitation's relay, and named to the create", async () => {
    const accepted = acceptedSignalingServer(
      { ...ENDPOINT, relay: RELAY },
      null,
    );
    if (accepted === undefined) throw new Error("no accepted server");
    let sent: unknown;
    const transport = await acceptorWebrtcTransport(accepted, (_, init) => {
      sent = JSON.parse(String(init?.body));
      return answering(200, { configured: true, ...HOSTED })(
        "/api/jobs/webrtc",
      );
    });
    expect(sent).toEqual({
      address: "wss://signal.example.org:8443/api/",
      invitationRelay: RELAY,
    });
    expect(transport).toEqual({
      channel: "webrtc",
      signalingServer: accepted.signalingServer,
    });
  });

  test("stops the run, refused only where the console refuses the address", async () => {
    const accepted = acceptedSignalingServer(ENDPOINT, null);
    if (accepted === undefined) throw new Error("no accepted server");
    await expect(
      acceptorWebrtcTransport(
        accepted,
        answering(400, { error: "That address is refused. Type another." }),
      ),
    ).rejects.toMatchObject({
      name: "AcceptedSignalingServerUnsetError",
      refused: true,
      message: "That address is refused. Type another.",
    });
    for (const status of [409, 500])
      await expect(
        acceptorWebrtcTransport(accepted, answering(status, undefined)),
      ).rejects.toMatchObject({
        name: "AcceptedSignalingServerUnsetError",
        refused: false,
      });
  });
});
