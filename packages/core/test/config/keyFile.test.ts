import { describe, expect, test } from "vitest";

import {
  KEY_FILE_REDACTED_FIELD_NAME,
  KEY_FILE_MIGRATIONS,
  KeyFileSchema,
  keyFileSchemaFor,
  keyFileUnreadFieldNames,
  serializeKeyFile,
} from "../../src/config/keyFile";
import type { KeyFile } from "../../src/config/keyFile";
import type { FormatMigrations } from "../../src/config/formatMigration";
import { parseSensitiveJson } from "../../src/sensitiveFile";

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

  test("refuses a field it does not know as written by a newer Alcove, by name", () => {
    const result = KeyFileSchema.safeParse({
      sharedSecret: SECRET,
      fieldFromALaterBuild: "2026-03-01T12:00:00.000Z",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'The key file has the field "fieldFromALaterBuild", which this version ' +
        "of Alcove does not read: it was made by a newer version of Alcove. " +
        "Use the version of Alcove that wrote the key file, or a newer one.",
    );
  });

  test("refuses a field it does not know alone, not beside a field error", () => {
    const result = KeyFileSchema.safeParse({ sharedSecret: "short", extra: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toMatch(
      /^The key file has the field "extra", which this version of Alcove does not read: it was made by a newer version of Alcove\./,
    );
  });

  test("names a secret-shaped unknown field by placeholder, and no value", () => {
    const result = KeyFileSchema.safeParse({
      sharedSecret: SECRET,
      [`x${SECRET}`]: SECRET,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      `"${KEY_FILE_REDACTED_FIELD_NAME}"`,
    );
    expect(JSON.stringify(result.error?.issues)).not.toContain(SECRET);
  });

  test("reads a file stating version 1 or no version, returning the fields alone", () => {
    expect(KeyFileSchema.parse({ version: 1, sharedSecret: SECRET })).toEqual({
      sharedSecret: SECRET,
    });
    expect(KeyFileSchema.parse({ sharedSecret: SECRET })).toEqual({
      sharedSecret: SECRET,
    });
  });

  test("reads back every field the serializer writes", () => {
    const file: KeyFile = {
      sharedSecret: SECRET,
      expires: "2030-01-01T00:00:00.000Z",
      previousSharedSecret: SECRET,
      rotationHistory: [{ verifier: SECRET }],
    };
    expect(KeyFileSchema.parse(JSON.parse(serializeKeyFile(file)))).toEqual(
      file,
    );
  });

  test("refuses a newer version, naming it", () => {
    const result = KeyFileSchema.safeParse({
      version: 2,
      sharedSecret: SECRET,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "The key file is format version 2, made by a newer version of Alcove " +
        "than this one, which reads up to version 1. Use the version of " +
        "Alcove that wrote the key file, or a newer one.",
    );
  });

  test("refuses a newer version by its version alone, beside broken and unknown fields", () => {
    const result = KeyFileSchema.safeParse({
      version: 2,
      sharedSecret: "short",
      newField: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["version"],
      message: expect.stringMatching(/^The key file is format version 2,/),
    });
  });

  test("refuses a __proto__ member by name, at the top level and in a history entry", () => {
    const topLevel = KeyFileSchema.safeParse(
      parseSensitiveJson(
        `{"__proto__":{"newerThing":1},"sharedSecret":"${SECRET}"}`,
        "key file",
      ),
    );
    expect(topLevel.success).toBe(false);
    expect(topLevel.error?.issues[0]?.message).toMatch(
      /^The key file has the field "__proto__", /,
    );

    const nested = KeyFileSchema.safeParse(
      parseSensitiveJson(
        `{"sharedSecret":"${SECRET}","rotationHistory":` +
          `[{"verifier":"${SECRET}","__proto__":{"newerThing":1}}]}`,
        "key file",
      ),
    );
    expect(nested.success).toBe(false);
    expect(nested.error?.issues[0]).toMatchObject({
      path: ["rotationHistory", 0],
      message: expect.stringMatching(
        /^The key file has the field "__proto__", /,
      ),
    });
  });

  test("names a secret-shaped member of a history entry by placeholder, and no value", () => {
    const result = KeyFileSchema.safeParse({
      sharedSecret: SECRET,
      rotationHistory: [{ verifier: SECRET, [SECRET]: 1 }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["rotationHistory", 0],
      message: expect.stringContaining(`"${KEY_FILE_REDACTED_FIELD_NAME}"`),
    });
    expect(JSON.stringify(result.error?.issues)).not.toContain(SECRET);
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

describe("keyFileUnreadFieldNames", () => {
  test("names each field outside those kept, in file order, and no value", () => {
    const file = {
      version: 1,
      expiry: "2030-01-01T00:00:00.000Z",
      sharedSecret: SECRET,
      expires: "2030-01-01T00:00:00.000Z",
      expire: SECRET,
    };
    const names = keyFileUnreadFieldNames(file);
    expect(names).toEqual(["expiry", "expire"]);
    expect(JSON.stringify(names)).not.toContain(SECRET);
    expect(keyFileUnreadFieldNames(file, new Set(["sharedSecret"]))).toEqual([
      "expiry",
      "expires",
      "expire",
    ]);
  });

  test("replaces a field name that contains a secret-shaped run", () => {
    const names = keyFileUnreadFieldNames({
      [SECRET]: "x",
      [`sharedSecret=${SECRET}`]: "x",
      [`${SECRET} `]: "x",
      [SECRET.slice(0, 42)]: "x",
      expiry: "y",
    });
    expect(names).toEqual([
      KEY_FILE_REDACTED_FIELD_NAME,
      KEY_FILE_REDACTED_FIELD_NAME,
      KEY_FILE_REDACTED_FIELD_NAME,
      KEY_FILE_REDACTED_FIELD_NAME,
      "expiry",
    ]);
  });

  test("names nothing for a file holding only known fields", () => {
    expect(
      keyFileUnreadFieldNames({
        sharedSecret: SECRET,
        expires: "2030-01-01T00:00:00.000Z",
        rotationInFlightSince: "2026-03-01T12:00:00.000Z",
        relayRegistrationPendingSince: "2026-03-01T12:00:01.000Z",
      }),
    ).toEqual([]);
  });

  test("names nothing for a document that is not a plain object", () => {
    expect(keyFileUnreadFieldNames(null)).toEqual([]);
    expect(keyFileUnreadFieldNames(["sharedSecret"])).toEqual([]);
    expect(keyFileUnreadFieldNames("expiry")).toEqual([]);
  });
});

describe("serializeKeyFile", () => {
  test("writes pretty-printed JSON with the version first and a trailing newline", () => {
    expect(
      serializeKeyFile({
        version: 7,
        sharedSecret: SECRET,
        expires: "2030-01-01T00:00:00.000Z",
      } as KeyFile),
    ).toBe(
      "{\n" +
        '  "version": 1,\n' +
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
        '  "version": 1,\n' +
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
      `{\n  "version": 1,\n  "sharedSecret": "${SECRET}"\n}\n`,
    );
  });
});

describe("key file migration on read", () => {
  // A made-up version 2 whose step renames a version 1 field.
  const SYNTHETIC: FormatMigrations<number> = {
    ...KEY_FILE_MIGRATIONS,
    current: 2,
    steps: [
      {
        from: 1,
        to: 2,
        migrate: ({ expiresAt, ...rest }) => {
          if (expiresAt === "never")
            throw new Error("expiresAt is not an instant");
          return { ...rest, expires: expiresAt };
        },
      },
    ],
  };
  const schema = keyFileSchemaFor(SYNTHETIC);
  const source =
    `{"version":1,"sharedSecret":"${SECRET}",` +
    `"expiresAt":"2026-06-01T00:00:00.000Z"}`;

  test("reads a previous version migrated in memory, the file's document unchanged", () => {
    const raw = parseSensitiveJson(source, "key file");
    const before = JSON.stringify(raw);
    expect(schema.parse(raw)).toEqual({
      sharedSecret: SECRET,
      expires: "2026-06-01T00:00:00.000Z",
    });
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("writes the current version at the next write", () => {
    const read = schema.parse(parseSensitiveJson(source, "key file"));
    expect(JSON.parse(serializeKeyFile(read, SYNTHETIC))).toEqual({
      version: 2,
      sharedSecret: SECRET,
      expires: "2026-06-01T00:00:00.000Z",
    });
  });

  test("refuses a failed migration naming the cause and no secret, the document unchanged", () => {
    const raw = parseSensitiveJson(
      `{"version":1,"sharedSecret":"${SECRET}","expiresAt":"never"}`,
      "key file",
    );
    const before = JSON.stringify(raw);
    const result = schema.safeParse(raw);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "The key file is format version 1, and this version of Alcove could " +
        "not move it to version 2: expiresAt is not an instant. The file " +
        "was not changed. Use the version of Alcove that wrote the key " +
        "file, or report the failure to the Alcove maintainers.",
    ]);
    expect(JSON.stringify(result.error)).not.toContain(SECRET);
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("refuses an earlier version no step leads from by name, and migrates one a step does", () => {
    const brokenChain = keyFileSchemaFor({
      ...KEY_FILE_MIGRATIONS,
      current: 3,
      steps: [{ from: 2, to: 3, migrate: (document) => document }],
    });
    const raw = { version: 1, sharedSecret: SECRET };
    const before = JSON.stringify(raw);
    const result = brokenChain.safeParse(raw);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "The key file is format version 1, and this version of Alcove could " +
        "not move it to version 3: it has no migration from version 1. The " +
        "file was not changed. Use the version of Alcove that wrote the key " +
        "file, or report the failure to the Alcove maintainers.",
    ]);
    expect(JSON.stringify(raw)).toBe(before);
    expect(brokenChain.parse({ version: 2, sharedSecret: SECRET })).toEqual({
      sharedSecret: SECRET,
    });
  });

  test("still refuses a version above the current one by its version", () => {
    const result = schema.safeParse({ version: 3, sharedSecret: SECRET });
    expect(result.error?.issues[0]?.message).toMatch(
      /^The key file is format version 3, made by a newer version of Alcove/,
    );
  });
});
