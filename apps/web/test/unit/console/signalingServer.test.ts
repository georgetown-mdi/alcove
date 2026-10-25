import { describe, expect, test } from "vitest";

import { endpointFromConnection, sanitizeForDisplay } from "@alcove/core";

import {
  CONNECTION_TUNING_DEFAULT,
  WEBRTC_CONNECTION_TUNING,
  connectionTuningOptions,
  connectionTuningProblems,
  connectionTuningSummary,
} from "@console/connectionTuningModel";
import {
  ENROLL_RELAY_TOKEN_STEP,
  RELAY_OWNER_ENROLLMENT_NOTICE,
} from "@console/mountedConfiguration";
import {
  NO_RELAY_SUMMARY,
  OWN_WEBSOCKET_RELAY_FIELD_DESCRIPTION,
  REGISTRAR_WITHOUT_RELAY,
  acceptedSignalingServer,
  ownRelayDraft,
  ownRelayEnrollmentNotice,
  ownRelayFromDraft,
  ownRelaySummary,
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

const OWN_RELAY = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  relayRegistrar: {
    url: "https://registrar.example.org",
    exchangeId: "q3-linkage-7f2c",
  },
};

const WEBSOCKET_RELAY = "wss://wsrelay.example.org/relay";

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

  test("mints an endpoint with its host, port and path and no relay where none is set", () => {
    expect(webrtcEndpointForSignalingServer(HOSTED)).toStrictEqual({
      channel: "webrtc",
      host: "signal.example.org",
      port: 8443,
      path: "/api/",
    });
  });

  test("mints an endpoint naming its relay's turn urls and not its registrar", () => {
    const endpoint = webrtcEndpointForSignalingServer({
      ...HOSTED,
      ownRelay: OWN_RELAY,
    });
    expect(endpoint).toStrictEqual({
      channel: "webrtc",
      host: "signal.example.org",
      port: 8443,
      path: "/api/",
      relay: { turn: OWN_RELAY.turn },
    });
    expect(JSON.stringify(endpoint)).not.toContain("registrar");
  });

  test("mints an endpoint naming its WebSocket relay with the registrar's exchange id, as alcove invite does", () => {
    const ownRelay = { ...OWN_RELAY, websocket: WEBSOCKET_RELAY };
    const endpoint = webrtcEndpointForSignalingServer({ ...HOSTED, ownRelay });
    expect(endpoint.relay).toStrictEqual({
      turn: OWN_RELAY.turn,
      websocket: WEBSOCKET_RELAY,
      websocketExchangeId: OWN_RELAY.relayRegistrar.exchangeId,
    });
    const invited = endpointFromConnection({
      channel: "webrtc",
      server: { host: HOSTED.host, path: HOSTED.path },
      turn: OWN_RELAY.turn.map((url) => ({ url })),
      relayRegistrar: OWN_RELAY.relayRegistrar,
      websocketRelay: WEBSOCKET_RELAY,
    });
    if (invited.channel !== "webrtc") throw new Error("expected webrtc");
    expect(endpoint.relay).toStrictEqual(invited.relay);
    expect(JSON.stringify(endpoint)).not.toContain("registrar.example.org");
    expect(
      webrtcEndpointForSignalingServer({
        ...HOSTED,
        ownRelay: { websocket: WEBSOCKET_RELAY },
      }).relay,
    ).toStrictEqual({ websocket: WEBSOCKET_RELAY });
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
      { ...HOSTED, ownRelay: OWN_RELAY },
    ])
      expect(sameSignalingServer(HOSTED, other)).toBe(false);
    const relayed = { ...HOSTED, ownRelay: OWN_RELAY };
    expect(sameSignalingServer(relayed, structuredClone(relayed))).toBe(true);
    for (const ownRelay of [
      { turn: ["turn:other.example.org"] },
      { turn: OWN_RELAY.turn },
      {
        ...OWN_RELAY,
        relayRegistrar: { ...OWN_RELAY.relayRegistrar, exchangeId: "other" },
      },
      { ...OWN_RELAY, websocket: WEBSOCKET_RELAY },
    ])
      expect(sameSignalingServer(relayed, { ...HOSTED, ownRelay })).toBe(false);
    const websocketOnly = {
      ...HOSTED,
      ownRelay: { websocket: WEBSOCKET_RELAY },
    };
    expect(
      sameSignalingServer(websocketOnly, structuredClone(websocketOnly)),
    ).toBe(true);
    expect(
      sameSignalingServer(websocketOnly, {
        ...HOSTED,
        ownRelay: { websocket: "wss://other.example.org/relay" },
      }),
    ).toBe(false);
  });
});

describe("the relay set for the console's own invitations", () => {
  const draft = (
    turn: string,
    registrarUrl = "",
    exchangeId = "",
    websocket = "",
  ) => ownRelayFromDraft({ turn, websocket, registrarUrl, exchangeId });

  test("is none where every field is empty", () => {
    expect(draft("  \n", "", "", "  ")).toEqual({
      ok: true,
      ownRelay: undefined,
    });
  });

  test("takes a WebSocket relay url under core's rule, with or without turn urls", () => {
    expect(draft("", "", "", ` ${WEBSOCKET_RELAY} `)).toEqual({
      ok: true,
      ownRelay: { websocket: WEBSOCKET_RELAY },
    });
    expect(
      draft(
        OWN_RELAY.turn[0],
        OWN_RELAY.relayRegistrar.url,
        OWN_RELAY.relayRegistrar.exchangeId,
        WEBSOCKET_RELAY,
      ),
    ).toEqual({
      ok: true,
      ownRelay: { ...OWN_RELAY, websocket: WEBSOCKET_RELAY },
    });
  });

  test.each([
    ["a ws:// url", "ws://wsrelay.example.org/relay", /must be a wss:\/\//],
    [
      "a user before the host",
      "wss://county:secret@wsrelay.example.org/relay",
      /names a user/,
    ],
    ["a query", "wss://wsrelay.example.org/relay?k=1", /query or fragment/],
  ])(
    "refuses a WebSocket relay url with %s on its own field, in a sentence",
    (_, url, rule) => {
      const read = draft(OWN_RELAY.turn[0], "", "", url);
      if (read.ok) throw new Error("expected a refusal");
      expect(read.turnProblems).toEqual([]);
      expect(read.websocketProblems).toHaveLength(1);
      expect(read.websocketProblems[0]).toMatch(/^The WebSocket relay url /);
      expect(read.websocketProblems[0]).toMatch(/\.$/);
      expect(read.websocketProblems[0]).toMatch(rule);
      expect(read.websocketProblems[0]).not.toContain("secret");
    },
  );

  test("asks for a turn url before a registrar beside a WebSocket relay alone, as core's relay_registrar rule does", () => {
    const read = draft(
      "",
      OWN_RELAY.relayRegistrar.url,
      OWN_RELAY.relayRegistrar.exchangeId,
      WEBSOCKET_RELAY,
    );
    if (read.ok) throw new Error("expected a refusal");
    expect(read.turnProblems).toEqual([REGISTRAR_WITHOUT_RELAY]);
    expect(read.websocketProblems).toEqual([]);
  });

  test("takes one url per line under each scheme core's turn rule admits", () => {
    expect(
      draft(
        "turn:relay.example.org\n\n turns:relay.example.org:443?transport=tcp \nturn:relay.example.org:3478?transport=udp",
      ),
    ).toEqual({
      ok: true,
      ownRelay: {
        turn: [
          "turn:relay.example.org",
          "turns:relay.example.org:443?transport=tcp",
          "turn:relay.example.org:3478?transport=udp",
        ],
      },
    });
  });

  test.each([
    ["a stun url", "stun:relay.example.org:3478", /must begin with turn:/],
    ["an https url", "https://relay.example.org/", /must begin with turn:/],
    [
      "a user and password before the host",
      "turn:county:secret@relay.example.org",
      /names a user before its host/,
    ],
    [
      "a credential in the query",
      "turn:relay.example.org?credential=secret",
      /no query parameter other than transport/,
    ],
  ])("refuses %s by line, without repeating it", (_, line, rule) => {
    const read = draft(`turn:ok.example.org\n${line}`);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.turnProblems).toHaveLength(1);
    expect(read.turnProblems[0]).toMatch(/^Line 2: /);
    expect(read.turnProblems[0]).toMatch(rule);
    expect(read.turnProblems[0]).not.toContain("secret");
  });

  test("refuses more urls than an invitation names", () => {
    const read = draft(
      Array.from({ length: 9 }, (_, i) => `turn:r${i}.example.org`).join("\n"),
    );
    expect(read.ok).toBe(false);
  });

  test("takes a registrar under core's rule, only beside a turn url", () => {
    expect(
      draft(
        OWN_RELAY.turn[0],
        OWN_RELAY.relayRegistrar.url,
        OWN_RELAY.relayRegistrar.exchangeId,
      ),
    ).toEqual({ ok: true, ownRelay: OWN_RELAY });
    const alone = draft("", OWN_RELAY.relayRegistrar.url, "q3");
    if (alone.ok) throw new Error("expected a refusal");
    expect(alone.turnProblems).toEqual([REGISTRAR_WITHOUT_RELAY]);
    const insecure = draft(OWN_RELAY.turn[0], "http://registrar.test", "q3");
    if (insecure.ok) throw new Error("expected a refusal");
    expect(insecure.registrarUrlProblems.join(" ")).toMatch(/https/);
    const badId = draft(OWN_RELAY.turn[0], OWN_RELAY.relayRegistrar.url, "-x");
    if (badId.ok) throw new Error("expected a refusal");
    expect(badId.exchangeIdProblems.join(" ")).toMatch(/names neither party/);
  });

  test("fills the fields from the relay it holds", () => {
    for (const relay of [
      OWN_RELAY,
      { ...OWN_RELAY, websocket: WEBSOCKET_RELAY },
      { websocket: WEBSOCKET_RELAY },
    ])
      expect(ownRelayFromDraft(ownRelayDraft(relay))).toEqual({
        ok: true,
        ownRelay: relay,
      });
    expect(ownRelayDraft(undefined)).toEqual({
      turn: "",
      websocket: "",
      registrarUrl: "",
      exchangeId: "",
    });
  });

  test("is shown on the form as one line naming its urls and registrar, escaped", () => {
    expect(NO_RELAY_SUMMARY).toBe(
      "Relay: none. A network that blocks direct connections on either side stops the exchange.",
    );
    expect(ownRelaySummary({ turn: OWN_RELAY.turn })).toBe(
      "Relay: turns:relay.example.org:443?transport=tcp.",
    );
    expect(ownRelaySummary({ websocket: WEBSOCKET_RELAY })).toBe(
      `Relay: ${WEBSOCKET_RELAY}.`,
    );
    expect(ownRelaySummary(OWN_RELAY)).toBe(
      "Relay: turns:relay.example.org:443?transport=tcp. Registrar: " +
        "https://registrar.example.org, exchange id q3-linkage-7f2c.",
    );
    const controlled = "wss://wsrelay.example.org/\u001b[31mrelay";
    const line = ownRelaySummary({ websocket: controlled });
    expect(line).toBe(`Relay: ${sanitizeForDisplay(controlled)}.`);
    expect(line).not.toContain("\u001b");
  });

  test("states the step that enrolls the exchange's key before the run", () => {
    expect(ownRelayEnrollmentNotice(undefined)).toBeUndefined();
    const enroll = ownRelayEnrollmentNotice(OWN_RELAY);
    expect(enroll).toContain("alcove enroll-relay");
    expect(enroll).toContain("Before your partner connects");
    expect(enroll).toContain(ENROLL_RELAY_TOKEN_STEP);
    const noRegistrar = ownRelayEnrollmentNotice({ turn: OWN_RELAY.turn });
    expect(noRegistrar).toContain("relay's owner");
    expect(noRegistrar).toContain("registrar");
  });

  test("offers no registrar to a WebSocket relay alone, which core admits only beside a turn url", () => {
    expect(ownRelayEnrollmentNotice({ websocket: WEBSOCKET_RELAY })).toBe(
      RELAY_OWNER_ENROLLMENT_NOTICE,
    );
  });

  test("describes the WebSocket relay field", () => {
    expect(OWN_WEBSOCKET_RELAY_FIELD_DESCRIPTION).toBe(
      "A relay for networks that block connections through a TURN relay. " +
        "The run connects to it as it starts, so its operator learns your " +
        "network address, and the exchange passes through it, encrypted, " +
        "only when no other connection opens. The invitation names it for " +
        "your partner. One wss:// url, for example " +
        "wss://relay.example.org/relay",
    );
  });

  test("is read off the console's answer, and a malformed one is no server", () => {
    expect(
      signalingServerProjectionOf({
        configured: true,
        ...HOSTED,
        ownRelay: OWN_RELAY,
      }),
    ).toEqual({ ...HOSTED, ownRelay: OWN_RELAY });
    expect(
      signalingServerProjectionOf({
        configured: true,
        ...HOSTED,
        ownRelay: { websocket: WEBSOCKET_RELAY },
      }),
    ).toEqual({ ...HOSTED, ownRelay: { websocket: WEBSOCKET_RELAY } });
    for (const ownRelay of [
      { turn: ["https://relay.example.org/"] },
      { turn: [] },
      {},
      { websocket: "ws://wsrelay.example.org/relay" },
      {
        websocket: WEBSOCKET_RELAY,
        relayRegistrar: OWN_RELAY.relayRegistrar,
      },
      { ...OWN_RELAY, credential: "x" },
    ])
      expect(
        signalingServerProjectionOf({ configured: true, ...HOSTED, ownRelay }),
      ).toBeNull();
  });

  test("is sent with the address", async () => {
    let sent: unknown;
    await putSignalingServer(
      "wss://signal.example.org:8443/api/",
      (_, init) => {
        sent = JSON.parse(String(init?.body));
        return answering(200, { configured: true, ...HOSTED })(
          "/api/jobs/webrtc",
        );
      },
      { ownRelay: OWN_RELAY },
    );
    expect(sent).toEqual({
      address: "wss://signal.example.org:8443/api/",
      ownRelay: OWN_RELAY,
    });
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

  // With no port field, the address the console builds would parse with the
  // host's port as its own; the bare-authority rule `alcove accept` applies
  // refuses it first.
  test("is none where the invitation's host holds a port and the endpoint states none", () => {
    for (const host of ["h.example:99", "h.example:443", "[::1"])
      expect(
        acceptedSignalingServer(
          { channel: "webrtc", host, path: "/api/" },
          null,
        ),
      ).toBe(undefined);
  });

  test("is the invitation's server where its host is a bracketed IPv6 literal", () => {
    for (const port of [8443, undefined])
      expect(
        acceptedSignalingServer(
          {
            channel: "webrtc",
            host: "[2001:db8::1]",
            ...(port !== undefined ? { port } : {}),
            path: "/api/",
          },
          null,
        ),
      ).toEqual({
        address: `wss://[2001:db8::1]${port !== undefined ? `:${port}` : ""}/api/`,
        signalingServer: {
          host: "[2001:db8::1]",
          ...(port !== undefined ? { port } : {}),
          path: "/api/",
        },
      });
  });

  test("is set on the console with the invitation's relay, and named to the create", async () => {
    const accepted = acceptedSignalingServer(
      { ...ENDPOINT, relay: RELAY },
      null,
    );
    if (accepted === undefined) throw new Error("no accepted server");
    let sent: unknown;
    const transport = await acceptorWebrtcTransport(
      accepted,
      undefined,
      (_, init) => {
        sent = JSON.parse(String(init?.body));
        return answering(200, { configured: true, ...HOSTED })(
          "/api/jobs/webrtc",
        );
      },
    );
    expect(sent).toEqual({
      address: "wss://signal.example.org:8443/api/",
      invitationRelay: RELAY,
    });
    expect(transport).toEqual({
      channel: "webrtc",
      signalingServer: accepted.signalingServer,
    });
  });

  test("names the review's allowed relays to the create, and not to the console's server setting", async () => {
    const accepted = acceptedSignalingServer(
      { ...ENDPOINT, relay: RELAY },
      null,
    );
    if (accepted === undefined) throw new Error("no accepted server");
    let sent: unknown;
    const transport = await acceptorWebrtcTransport(
      accepted,
      ["relay.example.org"],
      (_, init) => {
        sent = JSON.parse(String(init?.body));
        return answering(200, { configured: true, ...HOSTED })(
          "/api/jobs/webrtc",
        );
      },
    );
    expect(sent).toEqual({
      address: "wss://signal.example.org:8443/api/",
      invitationRelay: RELAY,
    });
    expect(transport).toEqual({
      channel: "webrtc",
      signalingServer: accepted.signalingServer,
      allowedRelays: ["relay.example.org"],
    });
  });

  test("stops the run, refused only where the console refuses the address", async () => {
    const accepted = acceptedSignalingServer(ENDPOINT, null);
    if (accepted === undefined) throw new Error("no accepted server");
    await expect(
      acceptorWebrtcTransport(
        accepted,
        undefined,
        answering(400, { error: "That address is refused. Type another." }),
      ),
    ).rejects.toMatchObject({
      name: "AcceptedSignalingServerUnsetError",
      refused: true,
      message: "That address is refused. Type another.",
    });
    for (const status of [409, 500])
      await expect(
        acceptorWebrtcTransport(
          accepted,
          undefined,
          answering(status, undefined),
        ),
      ).rejects.toMatchObject({
        name: "AcceptedSignalingServerUnsetError",
        refused: false,
      });
  });
});
