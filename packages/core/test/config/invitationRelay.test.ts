import { ZodError } from "zod";
import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  encodeInvitation,
  relayLocatorFromOwnRelay,
} from "../../src/config/invitation";
import {
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_LOCATOR_URLS,
  parseConnectionConfig,
} from "../../src/config/connection";
import { endpointFromConnection } from "../../src/config/endpointProducer";
import { connectionFromLocator } from "../../src/config/exchangeFile";
import { summarizeInvitation } from "../../src/consent/invitationSummary";

import type { InvitationToken } from "../../src/config/invitation";
import type { WebRTCConnectionConfig } from "../../src/config/connection";
import { encodeRawInvitation } from "../utils/support";

const VALID_SECRET = "A".repeat(43);

const baseTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" as const }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const REGISTRAR = "https://registrar.example.org:8443";
const REGISTRAR_FORM =
  "an https:// url naming only a host and an optional port from 1 to 65535, " +
  "for example https://registrar.example.org";
const PATH_QUERY_OR_FRAGMENT = `has a path, query or fragment; write it as ${REGISTRAR_FORM}`;

const RELAY = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: ["stun:relay.example.org:3478"],
};

function tokenWithEndpoint(endpoint: unknown): InvitationToken {
  return {
    version: "1",
    linkageTerms: baseTerms,
    sharedSecret: VALID_SECRET,
    connectionEndpoint: endpoint as InvitationToken["connectionEndpoint"],
  };
}

describe("the invitation's relay locator", () => {
  test("round-trips through mint and decode", async () => {
    const endpoint = {
      channel: "webrtc",
      host: "signal.example",
      relay: RELAY,
    };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test("a locator naming only one kind of url round-trips", async () => {
    const endpoint = {
      channel: "webrtc",
      host: "signal.example",
      relay: { stun: ["stun:relay.example.org"] },
    };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test("an endpoint with no relay decodes with none", async () => {
    const endpoint = { channel: "webrtc", host: "signal.example" };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
    expect(summarizeInvitation(decoded).relay).toBeUndefined();
  });

  test.each([
    ["a credential", { ...RELAY, credential: "hunter2" }],
    ["a username", { ...RELAY, username: "1767229200:alcove" }],
    ["an unknown key", { ...RELAY, credentialType: "hmac-sha1" }],
  ])(
    "a locator holding %s is refused at decode and at mint",
    async (_, relay) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay,
      });
      await expect(
        decodeInvitation(await encodeRawInvitation(token)),
      ).rejects.toThrow(
        /relay may hold only turn and stun url lists, a websocket url and a registrar url/,
      );
      await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
    },
  );

  test("a turn entry written as a server with a credential is refused, not stripped", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: {
        turn: [
          {
            url: "turns:relay.example.org:443",
            username: "user",
            credential: "secret",
          },
        ],
      },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(ZodError);
  });

  test.each([
    ["an empty locator", {}],
    ["an empty turn list", { turn: [] }],
    ["a turn url naming no host", { turn: ["turn:"] }],
    [
      "a turn url whose transport the ICE layer drops",
      { turn: ["turns:r.example:443?transport=udp"] },
    ],
    ["a stun url under the turn scheme", { stun: ["turn:r.example"] }],
    ["an http url", { turn: ["https://r.example"] }],
    [
      "more urls than the bound",
      {
        stun: Array.from(
          { length: MAX_RELAY_LOCATOR_URLS + 1 },
          () => "stun:r.example",
        ),
      },
    ],
  ])("%s is refused at decode", async (_, relay) => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay,
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(ZodError);
  });

  test("a url of exactly the length bound decodes, and one code unit over is refused", async () => {
    const urlOfLength = (length: number): string =>
      "turn:" + "r".repeat(length - "turn:".length);
    const atBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: [urlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH)] },
    });
    const decoded = await decodeInvitation(await encodeRawInvitation(atBound));
    expect(decoded.connectionEndpoint).toEqual(atBound.connectionEndpoint);
    const overBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: [urlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH + 1)] },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(overBound)),
    ).rejects.toThrow(ZodError);
  });

  test("a url naming a user before its host is refused at decode", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: ["turns:alcove:secret@relay.example.org:443"] },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(/the 1st turn url names a user before its host/);
  });

  test.each([
    ["path", "turns:relay.example.org:443/SECRETPATH", "has a path"],
    ["fragment", "turn:relay.example.org#SECRETFRAG", "has a fragment"],
  ])(
    "a url with a %s is refused at decode without its value",
    async (_, url, refusal) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { turn: [url] },
      });
      const error: unknown = await decodeInvitation(
        await encodeRawInvitation(token),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ZodError);
      const message = (error as ZodError).message;
      expect(message).toContain(refusal);
      expect(message).not.toContain("SECRET");
    },
  );

  test("a relay on a file-sync endpoint is refused", async () => {
    const token = tokenWithEndpoint({
      channel: "sftp",
      host: "sftp.example",
      relay: RELAY,
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(/Remove unexpected field\(s\): relay/);
  });

  test("a locator naming a registrar round-trips through mint and decode", async () => {
    const endpoint = {
      channel: "webrtc",
      host: "signal.example",
      relay: { ...RELAY, registrar: REGISTRAR },
    };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test.each([
    [
      "an http url",
      "http://SECRETHOST.example.org",
      `must be ${REGISTRAR_FORM}`,
    ],
    [
      "a url with a path",
      "https://registrar.example.org/SECRETPATH",
      PATH_QUERY_OR_FRAGMENT,
    ],
    [
      "a url naming a user",
      "https://SECRETUSER@registrar.example.org",
      `names a user; write it as ${REGISTRAR_FORM}`,
    ],
    [
      "text that is no url",
      "SECRET registrar",
      `is not a url; write it as ${REGISTRAR_FORM}`,
    ],
  ])(
    "a registrar that is %s is refused at decode without its value",
    async (_, registrar, refusal) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { ...RELAY, registrar },
      });
      const error: unknown = await decodeInvitation(
        await encodeRawInvitation(token),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ZodError);
      const message = (error as ZodError).message;
      expect(message).toContain(`a relay locator's registrar ${refusal}`);
      expect(message).not.toContain("SECRET");
      await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
    },
  );

  test.each([
    ["a query", "https://hidden-host.example.org?a=1", PATH_QUERY_OR_FRAGMENT],
    ["a bare ?", "https://hidden-host.example.org?", PATH_QUERY_OR_FRAGMENT],
    ["a fragment", "https://hidden-host.example.org#x", PATH_QUERY_OR_FRAGMENT],
    ["a bare #", "https://hidden-host.example.org#", PATH_QUERY_OR_FRAGMENT],
    [
      "an empty query and fragment",
      "https://hidden-host.example.org/?#",
      PATH_QUERY_OR_FRAGMENT,
    ],
    [
      "two trailing slashes",
      "https://hidden-host.example.org//",
      PATH_QUERY_OR_FRAGMENT,
    ],
    [
      "port 0",
      "https://hidden-host.example.org:0",
      `names port 0; write it as ${REGISTRAR_FORM}`,
    ],
  ])(
    "a registrar url with %s is refused at decode and at mint without its value",
    async (_, registrar, refusal) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { ...RELAY, registrar },
      });
      const decodeError: unknown = await decodeInvitation(
        await encodeRawInvitation(token),
      ).catch((caught: unknown) => caught);
      const mintError: unknown = await encodeInvitation(token).catch(
        (caught: unknown) => caught,
      );
      for (const error of [decodeError, mintError]) {
        expect(error).toBeInstanceOf(ZodError);
        const message = (error as ZodError).message;
        expect(message).toContain(`a relay locator's registrar ${refusal}`);
        expect(message).not.toContain("hidden-host");
      }
    },
  );

  test.each([
    ["an explicit port 443", "https://registrar.example.org:443"],
    ["an upper-case host", "https://Registrar.Example.ORG"],
    ["a trailing slash", "https://registrar.example.org/"],
    ["all three", "https://Registrar.example.org:443/"],
  ])(
    "a registrar url with %s is minted and decoded as its origin",
    async (_, registrar) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { ...RELAY, registrar },
      });
      const expected = {
        channel: "webrtc",
        host: "signal.example",
        relay: { ...RELAY, registrar: "https://registrar.example.org" },
      };
      const minted = await decodeInvitation(await encodeInvitation(token));
      expect(minted.connectionEndpoint).toEqual(expected);
      const decoded = await decodeInvitation(await encodeRawInvitation(token));
      expect(decoded.connectionEndpoint).toEqual(expected);
    },
  );

  test.each([["https://registrar.example.org"], [REGISTRAR]])(
    "the registrar url %s, written as its origin, is accepted at mint and at decode",
    async (registrar) => {
      const endpoint = {
        channel: "webrtc",
        host: "signal.example",
        relay: { ...RELAY, registrar },
      };
      const decoded = await decodeInvitation(
        await encodeInvitation(tokenWithEndpoint(endpoint)),
      );
      expect(decoded.connectionEndpoint).toEqual(endpoint);
    },
  );

  test("a registrar of exactly the length bound decodes, and one code unit over is refused", async () => {
    const registrarOfLength = (length: number): string =>
      "https://" + "r".repeat(length - "https://.org".length) + ".org";
    const atBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: {
        turn: RELAY.turn,
        registrar: registrarOfLength(MAX_RELAY_LOCATOR_URL_LENGTH),
      },
    });
    expect(
      (await decodeInvitation(await encodeRawInvitation(atBound)))
        .connectionEndpoint,
    ).toEqual(atBound.connectionEndpoint);
    const overBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: {
        turn: RELAY.turn,
        registrar: registrarOfLength(MAX_RELAY_LOCATOR_URL_LENGTH + 1),
      },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(overBound)),
    ).rejects.toThrow(/registrar is longer than 1024 characters/);
  });

  test("a registrar beside no turn url is refused at decode and at mint", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { stun: RELAY.stun, registrar: REGISTRAR },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(/registrar enrolls the key of its TURN relay/);
    await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
  });

  test("a registrar does not admit a credential beside it", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { ...RELAY, registrar: REGISTRAR, credential: "hunter2" },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(/Remove unexpected field\(s\): credential/);
  });

  test("the consent summary names the relay's registrar, escaped", async () => {
    const summary = summarizeInvitation(
      tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { turn: RELAY.turn, registrar: REGISTRAR },
      }),
    );
    expect(summary.relay).toEqual({
      turn: RELAY.turn,
      stun: [],
      registrar: REGISTRAR,
    });
  });

  test("the consent summary names the relay's urls, escaped", async () => {
    const summary = summarizeInvitation(
      tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { turn: ["turns:relay.example.org\u001b[31m:443"] },
      }),
    );
    expect(summary.relay).toEqual({
      turn: ["turns:relay.example.org\\x1b[31m:443"],
      stun: [],
    });
  });
});

describe("relayLocatorFromOwnRelay", () => {
  test("composes the urls given, and nothing else", () => {
    expect(relayLocatorFromOwnRelay(RELAY)).toEqual(RELAY);
    expect(relayLocatorFromOwnRelay({ turn: RELAY.turn, stun: [] })).toEqual({
      turn: RELAY.turn,
    });
  });

  test("names no relay when there is none", () => {
    expect(relayLocatorFromOwnRelay(undefined)).toBeUndefined();
    expect(relayLocatorFromOwnRelay({ turn: [], stun: [] })).toBeUndefined();
  });
});

describe("the inviter's endpoint", () => {
  const base: WebRTCConnectionConfig = {
    channel: "webrtc",
    server: { host: "signal.example", path: "/" },
  };

  test("composes the relay from url-only turn entries and the stun list", () => {
    const endpoint = endpointFromConnection({
      ...base,
      stun: RELAY.stun,
      turn: [{ url: RELAY.turn[0] }],
    });
    expect(endpoint).toEqual({
      channel: "webrtc",
      host: "signal.example",
      path: "/",
      relay: RELAY,
    });
  });

  test("leaves out a turn entry with a static credential, keeping its url-only sibling and the stun list", () => {
    const endpoint = endpointFromConnection({
      ...base,
      stun: RELAY.stun,
      turn: [
        {
          url: "turns:static.example.org:443?transport=tcp",
          username: "operator",
          credential: "turn-secret",
          credentialType: "password",
        },
        { url: RELAY.turn[0] },
      ],
    });
    expect(endpoint).toEqual({
      channel: "webrtc",
      host: "signal.example",
      path: "/",
      relay: RELAY,
    });
    expect(JSON.stringify(endpoint)).not.toMatch(
      /operator|turn-secret|static\.example\.org|password/,
    );
  });

  test("names no turn url when every turn entry has a static credential", () => {
    const endpoint = endpointFromConnection({
      ...base,
      turn: [
        {
          url: RELAY.turn[0],
          username: "operator",
          credential: "turn-secret",
        },
      ],
    });
    expect(endpoint).not.toHaveProperty("relay");
    expect(
      endpointFromConnection({
        ...base,
        stun: RELAY.stun,
        turn: [
          {
            url: RELAY.turn[0],
            username: "operator",
            credential: "turn-secret",
          },
        ],
      }),
    ).toHaveProperty("relay", { stun: RELAY.stun });
  });

  test("names no relay for a connection with none", () => {
    expect(endpointFromConnection(base)).not.toHaveProperty("relay");
  });

  test("names only the turn entries allowed_relays lists, and every one when it is unset", () => {
    const turn = [
      { url: "turn:left-out.example.org:3478" },
      { url: RELAY.turn[0] },
    ];
    const allowedRelays = ["relay.example.org:443"];
    expect(
      endpointFromConnection({ ...base, turn, allowedRelays }),
    ).toHaveProperty("relay", { turn: RELAY.turn });
    expect(endpointFromConnection({ ...base, turn })).toHaveProperty("relay", {
      turn: ["turn:left-out.example.org:3478", RELAY.turn[0]],
    });
  });
});

describe("the accepting side's connection", () => {
  test("keeps the invitation's relay as invitation_relay, beside its own turn and stun", () => {
    const connection = connectionFromLocator({
      channel: "webrtc",
      host: "signal.example",
      relay: RELAY,
    });
    expect(connection).toEqual({
      channel: "webrtc",
      server: { host: "signal.example" },
      invitationRelay: RELAY,
    });
  });

  test("an invitation with no relay composes the connection it always did", () => {
    expect(
      connectionFromLocator({ channel: "webrtc", host: "signal.example" }),
    ).toEqual({ channel: "webrtc", server: { host: "signal.example" } });
  });

  test("invitation_relay parses from a configuration file, and refuses a credential", () => {
    const parsed = parseConnectionConfig({
      channel: "webrtc",
      server: { host: "signal.example" },
      invitation_relay: RELAY,
    });
    expect(parsed).toMatchObject({ invitationRelay: RELAY });
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { ...RELAY, credential: "x" },
      }),
    ).toThrow(/invitation_relay has no key credential/);
  });

  test("keeps the invitation's registrar on invitation_relay, and parses it back from a configuration file", () => {
    const relay = { ...RELAY, registrar: REGISTRAR };
    expect(
      connectionFromLocator({
        channel: "webrtc",
        host: "signal.example",
        relay,
      }),
    ).toMatchObject({ invitationRelay: relay });
    expect(
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: relay,
      }),
    ).toMatchObject({ invitationRelay: relay });
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { ...relay, registrar: "http://r.example.org" },
      }),
    ).toThrow(/registrar must be an https:\/\/ url/);
    expect(
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { ...relay, registrar: `${REGISTRAR}/` },
      }),
    ).toMatchObject({ invitationRelay: relay });
  });
});

describe("the relay locator's WebSocket relay", () => {
  const WEBSOCKET = "wss://wsrelay.example.org/relay";
  const WEBSOCKET_FORM =
    "a wss:// url naming a host, an optional port from 1 to 65535 and the " +
    "relay's path, for example wss://relay.example.org/relay";

  test.each([
    ["beside turn and stun urls", { ...RELAY, websocket: WEBSOCKET }],
    ["alone", { websocket: WEBSOCKET }],
    [
      "beside a registrar",
      { turn: RELAY.turn, websocket: WEBSOCKET, registrar: REGISTRAR },
    ],
  ])("a locator naming one %s round-trips", async (_, relay) => {
    const endpoint = { channel: "webrtc", host: "signal.example", relay };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test.each([
    [
      "a ws: url",
      "ws://wsrelay.example.org/relay",
      `must be ${WEBSOCKET_FORM}`,
    ],
    [
      "an https url",
      "https://wsrelay.example.org/relay",
      `must be ${WEBSOCKET_FORM}`,
    ],
    [
      "a url with a query",
      `${WEBSOCKET}?token=x`,
      `has a query or fragment; write it as ${WEBSOCKET_FORM}`,
    ],
    [
      "a url with an empty fragment",
      `${WEBSOCKET}#`,
      `has a query or fragment; write it as ${WEBSOCKET_FORM}`,
    ],
    [
      "a url naming port 0",
      "wss://wsrelay.example.org:0/relay",
      `names port 0; write it as ${WEBSOCKET_FORM}`,
    ],
    [
      "text that is not a url",
      "wsrelay",
      `is not a url; write it as ${WEBSOCKET_FORM}`,
    ],
  ])("%s is refused at decode and at mint", async (_, websocket, problem) => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { websocket },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(`a relay locator's websocket url ${problem}`);
    await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
  });

  test("a url naming a user is refused without repeating it", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { websocket: "wss://user:hunter2@wsrelay.example.org/relay" },
    });
    const refusal = decodeInvitation(await encodeRawInvitation(token));
    await expect(refusal).rejects.toThrow(
      `a relay locator's websocket url names a user; write it as ${WEBSOCKET_FORM}`,
    );
    await expect(refusal).rejects.not.toThrow(/hunter2/);
  });

  test("a list of WebSocket relay urls is refused", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { websocket: [WEBSOCKET] },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(ZodError);
  });

  test("a url of exactly the length bound decodes, and one code unit over is refused", async () => {
    const prefix = "wss://wsrelay.example.org/";
    const atBound =
      prefix + "a".repeat(MAX_RELAY_LOCATOR_URL_LENGTH - prefix.length);
    const decoded = await decodeInvitation(
      await encodeInvitation(
        tokenWithEndpoint({
          channel: "webrtc",
          host: "signal.example",
          relay: { websocket: atBound },
        }),
      ),
    );
    expect(decoded.connectionEndpoint).toHaveProperty("relay", {
      websocket: atBound,
    });
    await expect(
      decodeInvitation(
        await encodeRawInvitation(
          tokenWithEndpoint({
            channel: "webrtc",
            host: "signal.example",
            relay: { websocket: `${atBound}a` },
          }),
        ),
      ),
    ).rejects.toThrow(
      `a relay locator's websocket url is longer than ${MAX_RELAY_LOCATOR_URL_LENGTH} characters`,
    );
  });

  test("a locator with an unknown key beside a WebSocket relay is still refused", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { websocket: WEBSOCKET, websocketProof: "x" },
    });
    await expect(
      decodeInvitation(await encodeRawInvitation(token)),
    ).rejects.toThrow(/Remove unexpected field\(s\): websocketProof/);
  });

  test("the consent summary names the WebSocket relay, escaped", () => {
    const summary = summarizeInvitation(
      tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { websocket: "wss://wsrelay.example.org/\u001b[31mrelay" },
      }),
    );
    expect(summary.relay).toEqual({
      turn: [],
      stun: [],
      websocket: "wss://wsrelay.example.org/\\x1b[31mrelay",
    });
  });

  test("relayLocatorFromOwnRelay names the WebSocket relay given", () => {
    expect(relayLocatorFromOwnRelay({ websocket: WEBSOCKET })).toEqual({
      websocket: WEBSOCKET,
    });
    expect(
      relayLocatorFromOwnRelay({ ...RELAY, websocket: WEBSOCKET }),
    ).toEqual({ ...RELAY, websocket: WEBSOCKET });
  });

  test("the inviter's endpoint names its websocket_relay where allowed_relays keeps it", () => {
    const base: WebRTCConnectionConfig = {
      channel: "webrtc",
      server: { host: "signal.example", path: "/" },
      websocketRelay: WEBSOCKET,
    };
    expect(endpointFromConnection(base)).toHaveProperty("relay", {
      websocket: WEBSOCKET,
    });
    expect(
      endpointFromConnection({
        ...base,
        allowedRelays: ["wsrelay.example.org:443"],
      }),
    ).toHaveProperty("relay", { websocket: WEBSOCKET });
    expect(
      endpointFromConnection({
        ...base,
        allowedRelays: ["relay.example.org"],
      }),
    ).not.toHaveProperty("relay");
  });

  test("the accepting side keeps the invitation's WebSocket relay on invitation_relay, and parses it back", () => {
    const relay = { ...RELAY, websocket: WEBSOCKET };
    expect(
      connectionFromLocator({
        channel: "webrtc",
        host: "signal.example",
        relay,
      }),
    ).toMatchObject({ invitationRelay: relay });
    expect(
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: relay,
      }),
    ).toMatchObject({ invitationRelay: relay });
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { websocket: "ws://wsrelay.example.org/relay" },
      }),
    ).toThrow(/a relay locator's websocket url must be a wss:\/\/ url/);
  });
});
