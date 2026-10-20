import { describe, expect, test } from "vitest";

import {
  deriveRelayExchangeId,
  deriveRelayKey,
  mintRelayCredential,
  mintRunRelayCredential,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  RUN_RELAY_CREDENTIAL_LABEL,
  runEnrollsAtInvitationRegistrar,
  selectRunRelay,
} from "../src/relayCredential";
import {
  generateSharedSecret,
  RelayRegistrarSchema,
} from "../src/config/connection";

// Bytes 0x00..0x1f, base64url-encoded.
const FIXED_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

// Computed outside this code, by OpenSSL 3.0:
//   openssl kdf -keylen 32 -kdfopt digest:SHA256 \
//     -kdfopt hexkey:000102...1f -kdfopt hexsalt:<64 zeros> \
//     -kdfopt info:alcove-relay-key-v2 HKDF
const FIXED_RELAY_KEY =
  "1d970dcfd9f445a4c83c4ee3b03845209f891b2931e8b7bb2b41a17dd2249a9e";

// Computed by the pipeline infra/relay/mint-credential.sh runs:
//   printf '%s' 1767229200:exchange-1 \
//     | openssl dgst -sha1 -hmac <FIXED_RELAY_KEY> -binary | openssl base64
const FIXED_CREDENTIAL = "FxFt2WeC7Fjrv9QbGtzfwVmZatI=";

const NOW = new Date("2026-01-01T00:00:00Z");

describe("deriveRelayKey", () => {
  test("matches the known-answer key for a fixed secret", async () => {
    expect(await deriveRelayKey(FIXED_SECRET)).toBe(FIXED_RELAY_KEY);
  });

  test("is 32 bytes of lowercase hex, the same for the same secret", async () => {
    const secret = generateSharedSecret();
    const first = await deriveRelayKey(secret);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveRelayKey(secret)).toBe(first);
    expect(await deriveRelayKey(generateSharedSecret())).not.toBe(first);
  });

  test("refuses a value that is not a 32-byte base64url secret", async () => {
    await expect(deriveRelayKey("not-a-secret")).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
    await expect(deriveRelayKey(FIXED_SECRET.slice(1))).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
  });
});

// Computed outside this code, by OpenSSL 3.0, as FIXED_RELAY_KEY with
// -keylen 16 and -kdfopt info:alcove-relay-exchange-id-v2.
const FIXED_RELAY_EXCHANGE_ID = "ef946df1a03b076bd042fa7cf3cea8ed";

describe("deriveRelayExchangeId", () => {
  test("matches the known-answer id for a fixed secret", async () => {
    expect(await deriveRelayExchangeId(FIXED_SECRET)).toBe(
      FIXED_RELAY_EXCHANGE_ID,
    );
  });

  test("is 16 bytes of lowercase hex the registrar takes as an exchange id", async () => {
    const secret = generateSharedSecret();
    const id = await deriveRelayExchangeId(secret);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await deriveRelayExchangeId(secret)).toBe(id);
    expect(id).not.toBe((await deriveRelayKey(secret)).slice(0, 32));
    expect(
      RelayRegistrarSchema.safeParse({
        url: "https://registrar.example.org",
        exchangeId: id,
      }).success,
    ).toBe(true);
  });

  test("refuses a value that is not a 32-byte base64url secret", async () => {
    await expect(deriveRelayExchangeId("not-a-secret")).rejects.toThrow(
      /deriveRelayExchangeId: .*SHARED_SECRET_REGEX/,
    );
  });
});

describe("mintRelayCredential", () => {
  test("matches the relay's own credential arithmetic", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "exchange-1",
      ttlSeconds: 3600,
      now: NOW,
    });
    expect(minted).toEqual({
      username: "1767229200:exchange-1",
      credential: FIXED_CREDENTIAL,
      expiresAt: new Date("2026-01-01T01:00:00Z"),
    });
  });

  test("counts the lifetime from the whole second", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "exchange-1",
      ttlSeconds: 3600,
      now: new Date(NOW.getTime() + 999),
    });
    expect(minted.username).toBe("1767229200:exchange-1");
    expect(minted.credential).toBe(FIXED_CREDENTIAL);
  });

  test("the label is a parameter", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "other",
      ttlSeconds: 60,
      now: NOW,
    });
    expect(minted.username).toBe("1767225660:other");
    expect(minted.credential).not.toBe(FIXED_CREDENTIAL);
  });

  const valid = {
    key: FIXED_RELAY_KEY,
    label: "exchange-1",
    ttlSeconds: 60,
    now: NOW,
  };

  test.each([
    ["a label containing ':'", { label: "a:b" }, /must not contain ':'/],
    ["an empty label", { label: "" }, /must be non-empty/],
    ["an empty key", { key: "" }, /key is empty/],
    ["a fractional ttl", { ttlSeconds: 1.5 }, /whole seconds/],
    ["a zero ttl", { ttlSeconds: 0 }, /whole seconds/],
    [
      "a ttl above the ceiling",
      { ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS + 1 },
      /whole seconds/,
    ],
    ["an invalid date", { now: new Date(Number.NaN) }, /not a valid date/],
  ])("refuses %s", async (_name, override, message) => {
    await expect(
      mintRelayCredential({ ...valid, ...override }),
    ).rejects.toThrow(message);
  });

  test("accepts a ttl at the ceiling", async () => {
    const minted = await mintRelayCredential({
      ...valid,
      ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
    });
    expect(minted.expiresAt).toEqual(new Date("2026-01-01T01:00:00Z"));
  });
});

describe("selectRunRelay", () => {
  const ownStatic = {
    url: "turns:own.example:443?transport=tcp",
    username: "operator",
    credential: "own-secret",
  };
  const ownMinted = { url: "turn:own-minted.example:3478" };
  const ownStun = ["stun:own.example:3478"];
  const invitationRelay = {
    turn: ["turns:partner.example:443?transport=tcp"],
    stun: ["stun:partner.example:3478"],
  };

  test("own relay only: selects exactly the connection's own", () => {
    expect(
      selectRunRelay({ turn: [ownStatic, ownMinted], stun: ownStun }),
    ).toEqual({
      turn: [
        { source: "own", ...ownStatic },
        { source: "own", ...ownMinted },
      ],
      stun: ownStun,
    });
    expect(selectRunRelay({ stun: [] })).toEqual({ stun: [] });
    expect(selectRunRelay({})).toEqual({});
  });

  test("invitation relay only: selects the invitation's urls, each to take the minted credential", () => {
    expect(selectRunRelay({ invitationRelay })).toEqual({
      turn: [{ source: "invitation", url: invitationRelay.turn[0] }],
      stun: invitationRelay.stun,
    });
    expect(
      selectRunRelay({
        invitationRelay: { ...invitationRelay, registrar: "https://r.example" },
      }),
    ).toEqual({
      turn: [{ source: "invitation", url: invitationRelay.turn[0] }],
      stun: invitationRelay.stun,
    });
  });

  test("both: lists the connection's own relay first and the invitation's after it, per kind", () => {
    expect(
      selectRunRelay({
        turn: [ownStatic, ownMinted],
        stun: ownStun,
        invitationRelay,
      }),
    ).toEqual({
      turn: [
        { source: "own", ...ownStatic },
        { source: "own", ...ownMinted },
        { source: "invitation", url: invitationRelay.turn[0] },
      ],
      stun: [...ownStun, ...invitationRelay.stun],
    });
    expect(
      selectRunRelay({
        turn: [ownStatic],
        stun: ownStun,
        invitationRelay: { stun: invitationRelay.stun },
      }),
    ).toEqual({
      turn: [{ source: "own", ...ownStatic }],
      stun: [...ownStun, ...invitationRelay.stun],
    });
    expect(
      selectRunRelay({
        stun: ownStun,
        invitationRelay: { turn: invitationRelay.turn },
      }),
    ).toEqual({
      turn: [{ source: "invitation", url: invitationRelay.turn[0] }],
      stun: ownStun,
    });
  });

  test("the order is the connection's own entries in configuration order, then the invitation's remaining urls in invitation order", () => {
    const secondOwnTurn = { url: "turn:own-second.example:3478" };
    const selected = selectRunRelay({
      turn: [ownStatic, secondOwnTurn],
      stun: ["stun:own-a.example:3478", "stun:own-b.example:3478"],
      invitationRelay: {
        turn: [
          "turn:partner-first.example:3478",
          secondOwnTurn.url,
          "turn:partner-second.example:3478",
        ],
        stun: [
          "stun:partner-first.example:3478",
          "stun:own-a.example:3478",
          "stun:partner-second.example:3478",
        ],
      },
    });
    expect(selected.turn?.map((server) => server.url)).toEqual([
      ownStatic.url,
      secondOwnTurn.url,
      "turn:partner-first.example:3478",
      "turn:partner-second.example:3478",
    ]);
    expect(selected.stun).toEqual([
      "stun:own-a.example:3478",
      "stun:own-b.example:3478",
      "stun:partner-first.example:3478",
      "stun:partner-second.example:3478",
    ]);
  });

  test("a url present in both is listed once, as the connection's own entry", () => {
    expect(
      selectRunRelay({
        turn: [ownStatic],
        stun: ownStun,
        invitationRelay: {
          turn: [ownStatic.url, ownStatic.url, invitationRelay.turn[0]],
          stun: [ownStun[0], invitationRelay.stun[0], invitationRelay.stun[0]],
        },
      }),
    ).toEqual({
      turn: [
        { source: "own", ...ownStatic },
        { source: "invitation", url: invitationRelay.turn[0] },
      ],
      stun: [...ownStun, ...invitationRelay.stun],
    });
    expect(
      selectRunRelay({
        turn: [ownMinted],
        invitationRelay: { turn: [ownMinted.url] },
      }),
    ).toEqual({ turn: [{ source: "own", ...ownMinted }] });
  });
});

describe("runEnrollsAtInvitationRegistrar", () => {
  const invitationTurn = "turns:partner.example:443?transport=tcp";
  const invitationRelay = {
    turn: [invitationTurn],
    registrar: "https://registrar.partner.example",
  };

  test("an own entry with a different url first: no enrollment", () => {
    expect(
      runEnrollsAtInvitationRegistrar({
        turn: [{ url: "turn:own-minted.example:3478" }],
        invitationRelay,
      }),
    ).toBe(false);
  });

  test("no own entry: the run allocates on the invitation's url and enrolls", () => {
    expect(runEnrollsAtInvitationRegistrar({ invitationRelay })).toBe(true);
  });

  test("an own url-only entry naming the invitation's url: enrollment, by the url", () => {
    expect(
      runEnrollsAtInvitationRegistrar({
        turn: [{ url: invitationTurn }],
        invitationRelay,
      }),
    ).toBe(true);
  });

  test("an own entry with a static pair naming the invitation's url: no enrollment", () => {
    expect(
      runEnrollsAtInvitationRegistrar({
        turn: [
          {
            url: invitationTurn,
            username: "operator",
            credential: "own-secret",
          },
        ],
        invitationRelay,
      }),
    ).toBe(false);
  });

  test("an own entry first, the invitation naming a WebSocket relay beside its registrar: no enrollment", () => {
    expect(
      runEnrollsAtInvitationRegistrar({
        turn: [{ url: "turn:own-minted.example:3478" }],
        invitationRelay: {
          ...invitationRelay,
          websocket: "wss://partner.example/relay",
        },
      }),
    ).toBe(false);
  });

  test("an invitation relay naming no registrar: no enrollment", () => {
    expect(
      runEnrollsAtInvitationRegistrar({
        invitationRelay: { turn: [invitationTurn] },
      }),
    ).toBe(false);
  });
});

describe("mintRunRelayCredential", () => {
  test("signs under the key derived from the secret, for the ceiling, with the fixed label", async () => {
    const minted = await mintRunRelayCredential(FIXED_SECRET, NOW);
    expect(minted).toEqual(
      await mintRelayCredential({
        key: FIXED_RELAY_KEY,
        label: RUN_RELAY_CREDENTIAL_LABEL,
        ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
        now: NOW,
      }),
    );
    expect(minted.username).toBe(`1767229200:${RUN_RELAY_CREDENTIAL_LABEL}`);
  });

  test("refuses a value that is not a shared secret", async () => {
    await expect(mintRunRelayCredential("nope", NOW)).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
  });
});
