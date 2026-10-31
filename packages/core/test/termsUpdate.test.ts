import { describe, expect, test } from "vitest";

import { generateSharedSecret } from "../src/config/connection";
import type { FormatVersionPolicy } from "../src/config/formatVersion";
import {
  MAX_ENCODED_TERMS_UPDATE_LENGTH,
  TermsUpdateRefusedError,
  decodeTermsUpdate,
  encodeTermsUpdate,
  termsUpdateFor,
  termsUpdatePartnership,
} from "../src/config/termsUpdate";
import { inferMetadata } from "../src/config/metadata";
import type { Metadata } from "../src/config/metadata";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import {
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  toBase64Url,
} from "../src/utils/crypto";

const terms = getDefaultLinkageTerms("Agency A");

// A later version adding the terms' `identity`, whose absence an older reader
// takes as "Agency A".
const IDENTITY_AT_VERSION_2: FormatVersionPolicy = {
  current: 2,
  features: [
    {
      path: ["linkageTerms", "identity"],
      name: "linkageTerms.identity",
      version: 2,
      oldDefault: "Agency A",
    },
  ],
};

async function refusal(
  encoded: string,
  secret: string,
): Promise<TermsUpdateRefusedError> {
  try {
    await decodeTermsUpdate(encoded, secret);
  } catch (err) {
    expect(err).toBeInstanceOf(TermsUpdateRefusedError);
    return err as TermsUpdateRefusedError;
  }
  throw new Error("the terms update was not refused");
}

function body(encoded: string): Record<string, unknown> {
  const [bodyPart] = encoded.split(".");
  return JSON.parse(
    new TextDecoder().decode(fromBase64Url(bodyPart as string)),
  ) as Record<string, unknown>;
}

function reencode(content: unknown, mac: string): string {
  return `${toBase64Url(
    new TextEncoder().encode(JSON.stringify(content)),
  )}.${mac}`;
}

async function authenticated(
  content: unknown,
  secret: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const macKey = await hkdfDerive(
    fromBase64Url(secret),
    "alcove-terms-update-v2:mac",
    32,
  );
  return `${toBase64Url(bytes)}.${toBase64Url(await hmacSha256(macKey, bytes))}`;
}

describe("terms update", () => {
  test("round-trips the terms under the secret it was made with", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    expect(await decodeTermsUpdate(encoded, secret)).toEqual({
      linkageTerms: terms,
    });
  });

  test("holds no shared secret, credential, or connection endpoint", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    expect(Object.keys(content).sort()).toEqual([
      "kind",
      "linkageTerms",
      "partnership",
      "version",
    ]);
    expect(encoded).not.toContain(secret);
    expect(JSON.stringify(content)).not.toContain(secret);
    expect(content["partnership"]).toBe(await termsUpdatePartnership(secret));
  });

  test("the partnership identifier differs between secrets and is stable for one", async () => {
    const secret = generateSharedSecret();
    expect(await termsUpdatePartnership(secret)).toBe(
      await termsUpdatePartnership(secret),
    );
    expect(await termsUpdatePartnership(secret)).not.toBe(
      await termsUpdatePartnership(generateSharedSecret()),
    );
  });

  test("an update made under another secret is refused by the partnership check", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms },
      generateSharedSecret(),
    );
    const err = await refusal(encoded, generateSharedSecret());
    expect(err.check).toBe("partnership");
  });

  test("an altered body is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    content["linkageTerms"] = { ...terms, identity: "Someone Else" };
    const err = await refusal(
      reencode(content, encoded.split(".")[1] as string),
      secret,
    );
    expect(err.check).toBe("authentication");
  });

  test("an altered MAC is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const [bodyPart, macPart] = encoded.split(".") as [string, string];
    const mac = fromBase64Url(macPart);
    mac[0] = (mac[0] as number) ^ 1;
    const err = await refusal(`${bodyPart}.${toBase64Url(mac)}`, secret);
    expect(err.check).toBe("authentication");
  });

  test("a body naming this partnership under a forged MAC is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    content["linkageTerms"] = { ...terms, algorithm: "psi-c" };
    const err = await refusal(
      reencode(content, toBase64Url(new Uint8Array(32))),
      secret,
    );
    expect(err.check).toBe("authentication");
  });

  test.each([
    ["no separator", "abcdef"],
    ["two separators", "a.b.c"],
    ["a non-base64url body", "a*b.AAAA"],
    ["a short MAC", `${toBase64Url(new TextEncoder().encode("{}"))}.AAAA`],
    ["an oversized string", "A".repeat(MAX_ENCODED_TERMS_UPDATE_LENGTH + 1)],
  ])("%s is refused by the format check", async (_label, encoded) => {
    const err = await refusal(encoded, generateSharedSecret());
    expect(err.check).toBe("format");
  });

  test("a padded update is refused by the format check", async () => {
    // The 32-byte MAC is 43 unpadded characters, so padding adds one "=";
    // the padded body and MAC still decode to the authentic bytes.
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const [bodyPart, macPart] = encoded.split(".") as [string, string];
    const pad = (part: string): string =>
      part + "=".repeat((4 - (part.length % 4)) % 4);
    const paddedForms = [`${bodyPart}.${pad(macPart)}`];
    if (pad(bodyPart) !== bodyPart)
      paddedForms.push(`${pad(bodyPart)}.${macPart}`);
    for (const padded of paddedForms) {
      const err = await refusal(padded, secret);
      expect(err.check).toBe("format");
      expect(err.message).toMatch(/"=" padding/);
    }
  });

  test("an authenticated body with a field outside the format is refused by the format check", async () => {
    // A body only the secret's holder could have authenticated, holding a
    // field a terms update may not: the schema refuses it after the MAC check.
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = { ...body(encoded), sharedSecret: secret };
    const err = await refusal(await authenticated(content, secret), secret);
    expect(err.check).toBe("format");
  });

  test("an authenticated update on a newer format version says it needs a newer Alcove", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = { ...body(encoded), version: "2", addedLater: true };
    const err = await refusal(await authenticated(content, secret), secret);
    expect(err.check).toBe("format");
    expect(err.message).toBe(
      "This terms update is format version 2, made by a newer version of " +
        "Alcove than this one, which reads up to version 1. Update Alcove, " +
        "then try the terms update again.",
    );
  });

  test("an authenticated body with an unknown member is refused as made by a newer Alcove, by name", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = { ...body(encoded), addedLater: 1 };
    const err = await refusal(await authenticated(content, secret), secret);
    expect(err.check).toBe("format");
    expect(err.message).toBe(
      'This terms update has the field "addedLater", which this version of ' +
        "Alcove does not read: it was made by a newer version of Alcove. " +
        "Update Alcove, then try the terms update again.",
    );
  });

  test("an unknown member of the terms is refused by name, as the body spells it", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    content["linkageTerms"] = {
      ...(content["linkageTerms"] as object),
      linkage_rule_set: { name: "baseline-pii" },
    };
    const err = await refusal(await authenticated(content, secret), secret);
    expect(err.check).toBe("format");
    expect(err.message).toContain('has the field "linkage_rule_set"');
  });

  test("an unknown member of the about block is skipped, the MAC checked over the bytes as sent", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms, about: { label: "October change" } },
      secret,
    );
    const content = {
      ...body(encoded),
      about: { label: "October change", fromALaterBuild: [1] },
    };
    // Spaced JSON, which no Alcove writer emits, verifies only if the MAC is
    // computed over the received bytes rather than a re-serialization.
    const bytes = new TextEncoder().encode(JSON.stringify(content, null, 1));
    const macKey = await hkdfDerive(
      fromBase64Url(secret),
      "alcove-terms-update-v2:mac",
      32,
    );
    const spaced = `${toBase64Url(bytes)}.${toBase64Url(
      await hmacSha256(macKey, bytes),
    )}`;
    expect(await decodeTermsUpdate(spaced, secret)).toEqual({
      linkageTerms: terms,
    });
  });

  test("an update using no newer field is written at version 1 and read by this build", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms },
      secret,
      IDENTITY_AT_VERSION_2,
    );
    expect(body(encoded)["version"]).toBe("1");
    const { identity: _omitted, ...withoutIdentity } = terms;
    expect(await decodeTermsUpdate(encoded, secret)).toEqual({
      linkageTerms: withoutIdentity,
    });
  });

  test("an update using a newer field is written at that field's version", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate(
      { linkageTerms: { ...terms, identity: "Agency B" } },
      secret,
      IDENTITY_AT_VERSION_2,
    );
    expect(body(encoded)["version"]).toBe("2");
    expect(
      (await decodeTermsUpdate(encoded, secret, IDENTITY_AT_VERSION_2))
        .linkageTerms.identity,
    ).toBe("Agency B");
    const err = await refusal(encoded, secret);
    expect(err.message).toMatch(/^This terms update is format version 2,/);
  });

  test("a declared version below what the fields need is refused naming the field and the version", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    await expect(
      decodeTermsUpdate(encoded, secret, IDENTITY_AT_VERSION_2),
    ).rejects.toThrow(
      "This terms update declares format version 1, but its field " +
        '"linkageTerms.identity" needs version 2. Set version to 2, or ' +
        "remove the field.",
    );
  });

  test("an unauthenticated update on a newer format version is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = { ...body(encoded), version: "2" };
    const err = await refusal(
      reencode(content, toBase64Url(new Uint8Array(32))),
      secret,
    );
    expect(err.check).toBe("authentication");
    expect(err.message).not.toMatch(/newer version/);
  });

  test.each([
    ["an older version", { version: "0" }],
    ["a non-decimal version", { version: "2a" }],
    ["a numeric version", { version: 2 }],
    ["another kind", { kind: "invitation", version: "2" }],
  ])(
    "an authenticated body with %s is not an Alcove terms update",
    async (_label, change) => {
      const secret = generateSharedSecret();
      const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
      const content = { ...body(encoded), ...change };
      const err = await refusal(await authenticated(content, secret), secret);
      expect(err.check).toBe("format");
      expect(err.message).toBe(
        "this is not an Alcove terms update: its content does not match " +
          "the terms update format",
      );
    },
  );
});

describe("termsUpdateFor", () => {
  const metadata: Metadata = [
    ...inferMetadata(["first_name", "last_name", "dob", "ssn"], []),
    { name: "notes", type: "other", role: "payload", isPayload: true },
    { name: "county", type: "other", role: "ignored", isPayload: false },
  ];

  test("states payload.send from the metadata", () => {
    const update = termsUpdateFor(terms, metadata);
    expect(update).toEqual({
      linkageTerms: {
        ...terms,
        payload: { ...terms.payload, send: [{ name: "notes" }] },
      },
    });
  });

  test("takes the terms as written without metadata", () => {
    expect(termsUpdateFor(terms, undefined)).toEqual({ linkageTerms: terms });
  });
});
