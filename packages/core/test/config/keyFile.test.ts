import { describe, expect, test } from "vitest";

import { KeyFileSchema, serializeKeyFile } from "../../src/config/keyFile";

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("KeyFileSchema", () => {
  test("reads every field a key file holds", () => {
    const file = {
      sharedSecret: SECRET,
      expires: "2030-01-01T00:00:00.000Z",
      rotationInFlightSince: "2026-03-01T12:00:00.000Z",
      relayRegistrationPendingSince: "2026-03-01T12:00:01.000Z",
    };
    expect(KeyFileSchema.parse(file)).toEqual(file);
  });

  test("admits a field it does not know and drops it", () => {
    const result = KeyFileSchema.safeParse({
      sharedSecret: SECRET,
      fieldFromALaterBuild: "2026-03-01T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ sharedSecret: SECRET });
  });

  test("refuses a malformed known field without echoing its value", () => {
    const nearMiss = SECRET.slice(0, 42);
    const result = KeyFileSchema.safeParse({ sharedSecret: nearMiss });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(nearMiss);
  });

  test("refuses a missing secret and a malformed instant", () => {
    expect(KeyFileSchema.safeParse({}).success).toBe(false);
    expect(
      KeyFileSchema.safeParse({ sharedSecret: SECRET, expires: "tomorrow" })
        .success,
    ).toBe(false);
  });
});

describe("serializeKeyFile", () => {
  test("writes pretty-printed JSON with a trailing newline", () => {
    expect(
      serializeKeyFile({
        sharedSecret: SECRET,
        expires: "2030-01-01T00:00:00.000Z",
      }),
    ).toBe(
      "{\n" +
        `  "sharedSecret": "${SECRET}",\n` +
        '  "expires": "2030-01-01T00:00:00.000Z"\n' +
        "}\n",
    );
  });

  test("keeps the caller's field order and omits an undefined field", () => {
    expect(
      serializeKeyFile({
        sharedSecret: SECRET,
        expires: undefined,
        relayRegistrationPendingSince: "2026-03-01T12:00:01.000Z",
        rotationInFlightSince: "2026-03-01T12:00:00.000Z",
      }),
    ).toBe(
      "{\n" +
        `  "sharedSecret": "${SECRET}",\n` +
        '  "relayRegistrationPendingSince": "2026-03-01T12:00:01.000Z",\n' +
        '  "rotationInFlightSince": "2026-03-01T12:00:00.000Z"\n' +
        "}\n",
    );
  });

  test("writes only the key file's own fields", () => {
    const withExtra = {
      sharedSecret: SECRET,
      fieldFromALaterBuild: "x",
    };
    expect(serializeKeyFile(withExtra)).toBe(
      `{\n  "sharedSecret": "${SECRET}"\n}\n`,
    );
  });
});
