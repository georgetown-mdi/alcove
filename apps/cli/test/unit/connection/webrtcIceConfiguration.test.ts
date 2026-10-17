import { expect, test } from "vitest";
import { parseIceServers } from "werift";

import { UsageError, mintRunRelayCredential } from "@alcove/core";

import {
  NO_ICE_SERVERS_WARNING,
  relaysLeftOutWarning,
  PLAINTEXT_SIGNALING_WARNING,
  WERIFT_BUILT_IN_STUN_URI,
  brokerLocationFromConnection,
  buildPeerConfiguration,
  iceServersFromConnection,
  relayCredentialForRun,
  relayCredentialNotice,
  relayCredentialAttemptNotice,
  turnEntryNeedsSecretMessage,
} from "../../../src/connection/webrtc/weriftPeer";

// --- config -> ICE server list ----------------------------------------------

test("configured STUN URIs become a single ICE server entry", () => {
  expect(
    iceServersFromConnection({
      stun: ["stun:stun.example:3478", "stuns:stun.example:5349"],
    }),
  ).toEqual([{ urls: ["stun:stun.example:3478", "stuns:stun.example:5349"] }]);
});

test("each TURN server becomes its own credentialed entry", () => {
  expect(
    iceServersFromConnection({
      turn: [
        {
          url: "turn:relay.example:3478",
          username: "alcove",
          credential: "secret-one",
        },
        {
          url: "turns:relay.example:443?transport=tcp",
          username: "alcove",
          credential: "secret-two",
          credentialType: "hmac-sha1",
        },
      ],
    }),
  ).toEqual([
    {
      urls: "turn:relay.example:3478",
      username: "alcove",
      credential: "secret-one",
    },
    {
      urls: "turns:relay.example:443?transport=tcp",
      username: "alcove",
      credential: "secret-two",
    },
  ]);
});

// --- the invitation's relay -------------------------------------------------

const OWN_TURN = [
  {
    url: "turns:own.example:443?transport=tcp",
    username: "operator",
    credential: "own-secret",
  },
];
const INVITATION_RELAY = {
  turn: [
    "turns:partner.example:443?transport=tcp",
    "turn:partner.example:3478",
  ],
  stun: ["stun:partner.example:3478"],
};
const RUN_CREDENTIAL = {
  username: "1767229200:alcove",
  credential: "bWludGVk",
  expiresAt: new Date("2026-01-01T01:00:00Z"),
};

test("the invitation's relay is listed after the connection's own, the run's credential presented to its urls", () => {
  expect(
    iceServersFromConnection(
      {
        stun: ["stun:own.example:3478"],
        turn: OWN_TURN,
        invitationRelay: INVITATION_RELAY,
      },
      RUN_CREDENTIAL,
    ),
  ).toEqual([
    { urls: ["stun:own.example:3478", ...INVITATION_RELAY.stun] },
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
    ...INVITATION_RELAY.turn.map((url) => ({
      urls: url,
      username: RUN_CREDENTIAL.username,
      credential: RUN_CREDENTIAL.credential,
    })),
  ]);
});

test("a connection keeps its own TURN where the invitation's relay names none", () => {
  expect(
    iceServersFromConnection({
      turn: OWN_TURN,
      invitationRelay: { stun: INVITATION_RELAY.stun },
    }),
  ).toEqual([
    { urls: INVITATION_RELAY.stun },
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("the invitation's TURN urls with no minted credential is a fault, not an unauthenticated entry", () => {
  expect(() =>
    iceServersFromConnection({ invitationRelay: INVITATION_RELAY }),
  ).toThrow(/no relay credential was minted/);
});

test("a run mints a credential only when it lists a TURN url that takes one", async () => {
  const secret = "A".repeat(43);
  const now = new Date("2026-01-01T00:00:00Z");
  const minted = await relayCredentialForRun(
    { invitationRelay: INVITATION_RELAY },
    secret,
    now,
  );
  expect(minted).toEqual(await mintRunRelayCredential(secret, now));
  expect(
    await relayCredentialForRun(
      { turn: OWN_TURN, invitationRelay: INVITATION_RELAY },
      secret,
      now,
    ),
  ).toEqual(minted);
  expect(
    await relayCredentialForRun(
      { turn: OWN_TURN, invitationRelay: { stun: INVITATION_RELAY.stun } },
      secret,
      now,
    ),
  ).toBeUndefined();
  expect(
    await relayCredentialForRun({ turn: OWN_TURN }, secret, now),
  ).toBeUndefined();
  expect(
    await relayCredentialForRun(
      { invitationRelay: INVITATION_RELAY },
      undefined,
      now,
    ),
  ).toBeUndefined();
});

// --- an own turn entry with no username or credential -----------------------

// Bytes 0x00..0x1f, base64url-encoded.
const FIXED_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
// Computed outside this code, by OpenSSL 3.0, under the relay key HKDF-derived
// from FIXED_SECRET (packages/core/test/relayCredential.test.ts):
//   printf '%s' 1767229200:alcove \
//     | openssl dgst -sha1 -hmac <FIXED_RELAY_KEY> -binary | openssl base64
const FIXED_RUN_CREDENTIAL = "2G+e9Dny8I6qYzO6gHfnNmkIiYI=";
const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
const URL_ONLY_TURN = [{ url: "turns:minted.example:443?transport=tcp" }];

test("an own turn entry with no username or credential is presented the credential minted from the shared secret", async () => {
  const minted = await relayCredentialForRun(
    { turn: URL_ONLY_TURN },
    FIXED_SECRET,
    FIXED_NOW,
  );
  expect(minted).toEqual({
    username: "1767229200:alcove",
    credential: FIXED_RUN_CREDENTIAL,
    expiresAt: new Date("2026-01-01T01:00:00Z"),
  });
  expect(
    iceServersFromConnection({ turn: [...URL_ONLY_TURN, ...OWN_TURN] }, minted),
  ).toEqual([
    {
      urls: URL_ONLY_TURN[0].url,
      username: "1767229200:alcove",
      credential: FIXED_RUN_CREDENTIAL,
    },
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("a static turn entry is presented its own credential even when the run mints one", () => {
  expect(iceServersFromConnection({ turn: OWN_TURN }, RUN_CREDENTIAL)).toEqual([
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("the invitation's TURN urls follow an own url-only entry, one minted credential presented to every one", async () => {
  const connection = {
    turn: URL_ONLY_TURN,
    invitationRelay: { turn: INVITATION_RELAY.turn },
  };
  const minted = await relayCredentialForRun(
    connection,
    FIXED_SECRET,
    FIXED_NOW,
  );
  expect(minted?.credential).toBe(FIXED_RUN_CREDENTIAL);
  expect(iceServersFromConnection(connection, minted)).toEqual(
    [URL_ONLY_TURN[0].url, ...INVITATION_RELAY.turn].map((url) => ({
      urls: url,
      username: "1767229200:alcove",
      credential: FIXED_RUN_CREDENTIAL,
    })),
  );
});

test("a url the invitation and an own entry both name is listed once, with the own entry's credential", () => {
  expect(
    iceServersFromConnection(
      { turn: OWN_TURN, invitationRelay: { turn: [OWN_TURN[0].url] } },
      RUN_CREDENTIAL,
    ),
  ).toEqual([
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("an own url-only entry with no shared secret is refused even beside the invitation's relay", async () => {
  await expect(
    relayCredentialForRun(
      { turn: URL_ONLY_TURN, invitationRelay: INVITATION_RELAY },
      undefined,
      FIXED_NOW,
    ),
  ).rejects.toThrow(turnEntryNeedsSecretMessage(URL_ONLY_TURN[0].url));
});

test("an own url-only turn entry with no shared secret is refused naming the entry", async () => {
  const run = relayCredentialForRun(
    { turn: [...OWN_TURN, ...URL_ONLY_TURN] },
    undefined,
    FIXED_NOW,
  );
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(
    turnEntryNeedsSecretMessage(URL_ONLY_TURN[0].url),
  );
  expect(turnEntryNeedsSecretMessage(URL_ONLY_TURN[0].url)).toContain(
    "turns:minted.example:443?transport=tcp",
  );
});

test("an own url-only turn entry with no minted credential is a fault, not an unauthenticated entry", () => {
  expect(() => iceServersFromConnection({ turn: URL_ONLY_TURN })).toThrow(
    /no relay credential was minted/,
  );
});

const NOTICE_CREDENTIAL_FACTS =
  "the run's relay credential is derived from the exchange's shared " +
  "secret, valid for 60 minutes, and expires at 2026-01-01T01:00:00.000Z. ";

test("the notice states the credential's facts, then the one relay it is presented to", () => {
  expect(relayCredentialNotice({ turn: URL_ONLY_TURN }, RUN_CREDENTIAL)).toBe(
    NOTICE_CREDENTIAL_FACTS +
      "The run presents it to, and allocates its relay on, your own TURN " +
      "server at turns:minted.example:443?transport=tcp.",
  );
});

test("the notice with an own url-only entry first names the invitation's urls as not contacted", () => {
  expect(
    relayCredentialNotice(
      { turn: URL_ONLY_TURN, invitationRelay: INVITATION_RELAY },
      RUN_CREDENTIAL,
    ),
  ).toBe(
    NOTICE_CREDENTIAL_FACTS +
      "The run presents it to, and allocates its relay on, your own TURN " +
      "server at turns:minted.example:443?transport=tcp. The other urls " +
      "listed, turns:partner.example:443?transport=tcp, " +
      "turn:partner.example:3478, are configured to take the credential, " +
      "and the run does not contact them.",
  );
});

test("the notice with the invitation's urls first presents the credential to the first only", () => {
  const notice = relayCredentialNotice(
    { invitationRelay: INVITATION_RELAY },
    RUN_CREDENTIAL,
  );
  expect(notice).toBe(
    NOTICE_CREDENTIAL_FACTS +
      "The run presents it to, and allocates its relay on, the first TURN " +
      "server your partner's invitation named, at " +
      "turns:partner.example:443?transport=tcp. The other urls listed, " +
      "turn:partner.example:3478, are configured to take the credential, " +
      "and the run does not contact them.",
  );
  expect(notice.match(/presents it to/g)).toHaveLength(1);
});

test("the notice with an own static entry first says the minted credential reaches no relay", () => {
  const notice = relayCredentialNotice(
    {
      turn: [...OWN_TURN, ...URL_ONLY_TURN],
      invitationRelay: INVITATION_RELAY,
    },
    RUN_CREDENTIAL,
  );
  expect(notice).toBe(
    NOTICE_CREDENTIAL_FACTS +
      "The minted credential reaches no relay in this run: the run " +
      "allocates its relay on your own TURN server at " +
      "turns:own.example:443?transport=tcp and presents that entry's own " +
      "credential instead. The other urls listed, " +
      "turns:minted.example:443?transport=tcp, " +
      "turns:partner.example:443?transport=tcp, turn:partner.example:3478, " +
      "are configured to take the minted credential, and the run does not " +
      "contact them.",
  );
  expect(notice).not.toContain("presents it to");
});

test("the notice names an invitation url escaped, as the allocating relay and as one not contacted", () => {
  expect(
    relayCredentialNotice(
      {
        invitationRelay: {
          turn: [
            "turns:partner.example:443\u001b[2J",
            "turn:other.example:3478\u001b[2J",
          ],
        },
      },
      RUN_CREDENTIAL,
    ),
  ).toBe(
    NOTICE_CREDENTIAL_FACTS +
      "The run presents it to, and allocates its relay on, the first TURN " +
      "server your partner's invitation named, at " +
      "turns:partner.example:443\\x1b[2J. The other urls listed, " +
      "turn:other.example:3478\\x1b[2J, are configured to take the " +
      "credential, and the run does not contact them.",
  );
});

test("a later attempt's credential notice names the wait and the new expiry", () => {
  expect(
    relayCredentialAttemptNotice(RUN_CREDENTIAL, {
      kind: "partner-not-connected",
      waitedMs: 30 * 60_000 + 7,
    }),
  ).toBe(
    "the exchange partner has not connected within 30 minutes, so a new " +
      "connection attempt starts with a new relay credential that expires " +
      "at 2026-01-01T01:00:00.000Z",
  );
  expect(
    relayCredentialAttemptNotice(RUN_CREDENTIAL, {
      kind: "partner-not-connected",
      waitedMs: 60 * 60_000,
    }),
  ).toMatch(/^the exchange partner has not connected within 1 hour,/);
});

test("a wait under a minute is stated in seconds, never as zero", () => {
  const within = (waitedMs: number): string =>
    relayCredentialAttemptNotice(RUN_CREDENTIAL, {
      kind: "partner-not-connected",
      waitedMs,
    });
  expect(within(20_400)).toMatch(/ within 20 seconds, /);
  expect(within(59_999)).toMatch(/ within 59 seconds, /);
  expect(within(60_000)).toMatch(/ within 1 minute, /);
  expect(within(400)).toMatch(/ within 1 second, /);
  expect(within(0)).toMatch(/ within 1 second, /);
});

test("an attempt that follows a lost coordination server connection says so", () => {
  expect(
    relayCredentialAttemptNotice(RUN_CREDENTIAL, { kind: "signaling-dropped" }),
  ).toBe(
    "the connection to the coordination server was lost, so a new " +
      "connection attempt starts with a new relay credential that expires " +
      "at 2026-01-01T01:00:00.000Z",
  );
});

test("an attempt that follows an unopened data channel says so", () => {
  expect(
    relayCredentialAttemptNotice(RUN_CREDENTIAL, {
      kind: "channel-not-opened",
    }),
  ).toBe(
    "the connection to the exchange partner did not open, so a new " +
      "connection attempt starts with a new relay credential that expires " +
      "at 2026-01-01T01:00:00.000Z",
  );
});

test("an attempt that meets a partner's new connection says so rather than naming the wait", () => {
  expect(
    relayCredentialAttemptNotice(RUN_CREDENTIAL, {
      kind: "partner-reconnected",
    }),
  ).toBe(
    "the exchange partner started a new connection, so a new connection " +
      "attempt starts to meet it with a new relay credential that expires " +
      "at 2026-01-01T01:00:00.000Z",
  );
});

test("a connection with neither STUN nor TURN resolves to no servers", () => {
  expect(iceServersFromConnection({})).toEqual([]);
  expect(iceServersFromConnection({ stun: [], turn: [] })).toEqual([]);
});

test("an ice_provision block is refused rather than silently ignored", () => {
  // Ignoring it would fall back to the built-in default -- a downgrade the
  // operator did not choose, on the one field that says they chose otherwise.
  expect(() =>
    iceServersFromConnection({ iceProvision: { host: "ice.example" } }),
  ).toThrow(UsageError);
  expect(() =>
    iceServersFromConnection({ iceProvision: { host: "ice.example" } }),
  ).toThrow(/ice_provision/);
});

// --- the configuration the peer connection is built with --------------------

test("a configured list is passed through verbatim, with no warning", () => {
  const warnings: Array<string> = [];
  const iceServers = [
    { urls: ["stun:stun.example:3478"] },
    { urls: "turn:relay.example:3478", username: "u", credential: "c" },
  ];
  expect(buildPeerConfiguration(iceServers, (m) => warnings.push(m))).toEqual({
    iceServers,
  });
  expect(warnings).toEqual([]);
});

test.each([
  ["no list at all", undefined],
  ["an empty list", []],
])("%s warns and leaves the built-in default selected", (_label, servers) => {
  const warnings: Array<string> = [];
  const configuration = buildPeerConfiguration(servers, (m) =>
    warnings.push(m),
  );
  // An empty list is NOT passed through: to werift an empty `iceServers` and an
  // absent one both mean "use the built-in default", so omitting it keeps the
  // two from looking different when they are not.
  expect(configuration).toEqual({});
  expect(warnings).toEqual([NO_ICE_SERVERS_WARNING]);
});

test("the warning names the default, what it discloses, and how to override", () => {
  // An operator reading one line has to be able to act on it, so this pins the
  // content rather than merely that something was logged. The endpoint it names
  // is the measured one -- what werift actually falls back to is held by the
  // integration suite, and this holds the warning to that value.
  expect(NO_ICE_SERVERS_WARNING).toContain(WERIFT_BUILT_IN_STUN_URI);
  expect(NO_ICE_SERVERS_WARNING).toContain("public address");
  expect(NO_ICE_SERVERS_WARNING).toContain("`stun`");
  expect(NO_ICE_SERVERS_WARNING).toContain("`turn`");
  expect(NO_ICE_SERVERS_WARNING).toContain("unreachable");
  // And it must not overstate the disclosure: connection metadata, not content.
  expect(NO_ICE_SERVERS_WARNING).toContain("no exchange content is");
});

test.each([
  ["no list at all", undefined],
  ["an empty list", []],
])(
  "%s after allowed_relays emptied the TURN list warns once, naming the setting",
  (_label, servers) => {
    const warnings: Array<string> = [];
    const leftOut = [
      "turn:relay-a.example.org",
      "turns:relay-b.example.org:443",
    ];
    const configuration = buildPeerConfiguration(
      servers,
      (m) => warnings.push(m),
      leftOut,
    );
    expect(configuration).toEqual({});
    expect(warnings).toEqual([relaysLeftOutWarning(leftOut, true)]);
    expect(warnings[0]).not.toBe(NO_ICE_SERVERS_WARNING);
    expect(warnings[0]).not.toContain(NO_ICE_SERVERS_WARNING);
    expect(warnings[0]).toContain(
      `With no \`stun\` url listed, the built-in default (${WERIFT_BUILT_IN_STUN_URI}) ` +
        "will be used to discover this host's public address. That address, " +
        "and the fact of a session, are disclosed to that server; no " +
        "exchange content is. Set `stun` on the connection to use your own " +
        "server instead.",
    );
    expect(warnings[0]).not.toContain("(or `turn`)");
    expect(warnings[0]).toContain("connection.allowed_relays");
    for (const url of leftOut) expect(warnings[0]).toContain(url);
    expect(warnings[0]).toContain("continues without a relay");
    expect(warnings[0]).toContain("Add the host of a relay");
    expect(warnings[0]).toContain("remove the setting");
  },
);

test("the allowed_relays warning escapes the urls it lists", () => {
  expect(relaysLeftOutWarning(["turn:relay.example.org\x1b[2J"])).toContain(
    "turn:relay.example.org\\x1b[2J",
  );
});

test("an emptied TURN list beside a stun url warns once, without the built-in default's disclosure", () => {
  const warnings: Array<string> = [];
  const iceServers = [{ urls: ["stun:stun.example:3478"] }];
  const leftOut = ["turn:relay.example.org"];
  expect(
    buildPeerConfiguration(iceServers, (m) => warnings.push(m), leftOut),
  ).toEqual({ iceServers });
  expect(warnings).toEqual([relaysLeftOutWarning(leftOut)]);
  expect(warnings[0]).toContain("connection.allowed_relays");
  expect(warnings[0]).not.toContain(WERIFT_BUILT_IN_STUN_URI);
  expect(warnings[0]).not.toContain("public address");
});

test("a list that keeps a TURN url warns nothing though allowed_relays left another out", () => {
  const warnings: Array<string> = [];
  const iceServers = [
    { urls: ["stun:stun.example:3478"] },
    { urls: "turn:relay.example:3478", username: "u", credential: "c" },
  ];
  expect(
    buildPeerConfiguration(iceServers, (m) => warnings.push(m), [
      "turn:relay.example.org",
    ]),
  ).toEqual({ iceServers });
  expect(warnings).toEqual([]);
});

// --- what werift takes from the list ----------------------------------------

test("werift's parser keeps the first TURN url and the first STUN url of the list a run passes it", () => {
  const configuration = buildPeerConfiguration(
    iceServersFromConnection(
      {
        stun: ["stun:own-first.example:3478", "stun:own-second.example:3478"],
        turn: [
          {
            url: "turn:own-first.example:3478",
            username: "first-user",
            credential: "first-secret",
          },
          {
            url: "turn:own-second.example:3478",
            username: "second-user",
            credential: "second-secret",
          },
        ],
        invitationRelay: {
          turn: ["turn:partner-first.example:3478"],
          stun: ["stun:partner-first.example:3478"],
        },
      },
      RUN_CREDENTIAL,
    ),
  );
  expect(configuration.iceServers).toHaveLength(4);

  const options = parseIceServers(configuration.iceServers ?? []);

  expect(options).toEqual({
    stunServer: ["own-first.example", 3478],
    turnServer: ["own-first.example", 3478],
    turnUsername: "first-user",
    turnPassword: "first-secret",
  });
});

test("werift's parser takes the invitation's first TURN url when the connection names no TURN of its own", () => {
  const configuration = buildPeerConfiguration(
    iceServersFromConnection(
      {
        invitationRelay: {
          turn: [
            "turn:partner-first.example:3478",
            "turn:partner-second.example:3478",
          ],
          stun: [
            "stun:partner-first.example:3478",
            "stun:partner-second.example:3478",
          ],
        },
      },
      RUN_CREDENTIAL,
    ),
  );

  expect(parseIceServers(configuration.iceServers ?? [])).toEqual({
    stunServer: ["partner-first.example", 3478],
    turnServer: ["partner-first.example", 3478],
    turnUsername: RUN_CREDENTIAL.username,
    turnPassword: RUN_CREDENTIAL.credential,
  });
});

// --- plaintext signaling ----------------------------------------------------

test("a plaintext broker warns and still resolves to a dialable location", () => {
  const warnings: Array<string> = [];
  const location = brokerLocationFromConnection(
    { host: "127.0.0.1", port: 9000, secure: false },
    (message) => warnings.push(message),
  );
  // Warn and guide: plaintext is the operator's own choice, and a broker on the
  // same machine is what it is for, so the location is still returned whole.
  expect(location).toEqual({
    host: "127.0.0.1",
    port: 9000,
    path: "/",
    key: "peerjs",
    secure: false,
  });
  expect(warnings).toEqual([PLAINTEXT_SIGNALING_WARNING]);
});

test.each([
  ["secure: true", true],
  ["an omitted secure", undefined],
])("%s resolves to TLS with no warning", (_label, secure) => {
  const warnings: Array<string> = [];
  const location = brokerLocationFromConnection(
    { host: "peers.example.org", ...(secure !== undefined && { secure }) },
    (message) => warnings.push(message),
  );
  expect(location.secure).toBe(true);
  expect(warnings).toEqual([]);
});

test("a connection refused for shape warns about nothing", () => {
  // The refusal is the whole outcome: nothing will be dialed, so a warning about
  // the socket's scheme would only compete with the line the operator acts on.
  const warnings: Array<string> = [];
  expect(() =>
    brokerLocationFromConnection(
      { host: "broker.example@attacker.example", secure: false },
      (message) => warnings.push(message),
    ),
  ).toThrow(UsageError);
  expect(warnings).toEqual([]);
});

test("the warning names what is disclosed, the remedy, and the legitimate use", () => {
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("`secure: false`");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("ws:");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("rendezvous ids");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("session descriptions");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("candidate addresses");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("TLS");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("the default");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("same machine");
  // And it must not overstate the disclosure: the parties authenticate each
  // other over the data channel, which a plaintext signaling path does not reach.
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("No exchange content");
});
