import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  UsageError,
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
} from "@psi/managed/managedExchangeStore";
import {
  createManagedSftpExchange,
  getManagedSftpClientKey,
  managedSftpAuthorizedKeysLine,
  managedSftpClientKeyComment,
} from "@psi/managed/managedSftpClientKey";
import { JsonWebKeyFormatter } from "@microsoft/dev-tunnels-ssh/algorithms/web/jsonWebKeyFormatter";

import { createFakeIndexedDb } from "../../utils/fakeIndexedDb";

import type { FakeIndexedDb } from "../../utils/fakeIndexedDb";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

const PERSONAL_LABEL = "Jane Doe, County Health";

function sftpExchange(): NewManagedExchange {
  return {
    label: PERSONAL_LABEL,
    exchangeFile: assembleExchangeSpec({
      connection: connectionFromLocator({
        channel: "sftp",
        host: "sftp.example.org",
        path: "/exchange",
      }),
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
  };
}

let fake: FakeIndexedDb;

beforeEach(() => {
  fake = createFakeIndexedDb();
  vi.stubGlobal("indexedDB", fake.factory);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function storedKey(id: string): unknown {
  return fake.stored(
    MANAGED_EXCHANGE_DB_NAME,
    MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
    id,
  );
}

/** The fields of an SSH wire-format public-key blob, read as RFC 4251 strings. */
function readSshStrings(blob: Uint8Array): Array<Uint8Array> {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const fields: Array<Uint8Array> = [];
  let at = 0;
  while (at < blob.length) {
    const length = view.getUint32(at);
    fields.push(blob.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  expect(at).toBe(blob.length);
  return fields;
}

/** The P-256 public key an `authorized_keys` line states, imported through
 * WebCrypto, which refuses a point that is not on the curve. */
async function publicKeyOfLine(line: string): Promise<CryptoKey> {
  const [type, base64, ...rest] = line.split(" ");
  expect(type).toBe("ecdsa-sha2-nistp256");
  expect(rest).toHaveLength(1);
  const fields = readSshStrings(new Uint8Array(Buffer.from(base64, "base64")));
  expect(fields).toHaveLength(3);
  const text = new TextDecoder();
  expect(text.decode(fields[0])).toBe("ecdsa-sha2-nistp256");
  expect(text.decode(fields[1])).toBe("nistp256");
  expect(fields[2]).toHaveLength(65);
  expect(fields[2][0]).toBe(4);
  return await crypto.subtle.importKey(
    "raw",
    new Uint8Array(fields[2]),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

describe("createManagedSftpExchange", () => {
  test("stores the record and a non-extractable P-256 key with it, in one transaction", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());

    expect(await getManagedExchange(record.id)).toEqual(record);
    const stored = storedKey(record.id) as CryptoKeyPair;
    expect(stored.privateKey).toBeInstanceOf(CryptoKey);
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.privateKey.usages).toEqual(["sign"]);
    expect(stored.privateKey.algorithm).toEqual({
      name: "ECDSA",
      namedCurve: "P-256",
    });
    expect(stored.publicKey.type).toBe("public");

    const writes = fake.transactions.filter(({ mode }) => mode === "readwrite");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      storeNames: [
        MANAGED_EXCHANGE_STORE_NAME,
        MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
      ],
      options: { durability: "strict" },
      outcome: "complete",
    });
  });

  test("generates a distinct key for each exchange", async () => {
    const first = await createManagedSftpExchange(sftpExchange());
    const second = await createManagedSftpExchange(sftpExchange());
    expect(first.authorizedKeysLine.split(" ")[1]).not.toBe(
      second.authorizedKeysLine.split(" ")[1],
    );
  });

  test("refuses an exchange that does not connect to an SFTP server, and stores nothing", async () => {
    await expect(
      createManagedSftpExchange({
        label: "",
        exchangeFile: assembleExchangeSpec({
          connection: connectionFromLocator({
            channel: "webrtc",
            host: "signaling.example.org",
          }),
          linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        }),
        side: "inviter",
      }),
    ).rejects.toThrow(UsageError);
    expect(fake.transactions).toHaveLength(0);
  });
});

describe("the authorized_keys line", () => {
  test("is a valid P-256 key, of the stored private key, named by the exchange id only", async () => {
    const { record, authorizedKeysLine } =
      await createManagedSftpExchange(sftpExchange());
    expect(authorizedKeysLine).toMatch(
      /^ecdsa-sha2-nistp256 [A-Za-z0-9+/]+={0,2} alcove-exchange-[0-9a-f-]{36}$/,
    );
    expect(authorizedKeysLine.split(" ")[2]).toBe(
      managedSftpClientKeyComment(record.id),
    );
    expect(authorizedKeysLine).not.toContain("Jane");

    const publicKey = await publicKeyOfLine(authorizedKeysLine);
    const data = new TextEncoder().encode("session identifier");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      (storedKey(record.id) as CryptoKeyPair).privateKey,
      data,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        data,
      ),
    ).toBe(true);
  });

  test("a point off the curve does not import", async () => {
    const { authorizedKeysLine } =
      await createManagedSftpExchange(sftpExchange());
    const [type, base64, comment] = authorizedKeysLine.split(" ");
    const blob = Buffer.from(base64, "base64");
    blob[blob.length - 1] ^= 1;
    await expect(
      publicKeyOfLine(`${type} ${blob.toString("base64")} ${comment}`),
    ).rejects.toThrow();
  });
});

describe("the stored key across a reload of the store", () => {
  test("reads back, after the store module is loaded again, as the key the line names", async () => {
    const { record, authorizedKeysLine } =
      await createManagedSftpExchange(sftpExchange());

    vi.resetModules();
    const reloaded = await import("@psi/managed/managedSftpClientKey");
    const key = await reloaded.getManagedSftpClientKey(record.id);
    expect(key).toBeDefined();
    expect(await reloaded.managedSftpAuthorizedKeysLine(record.id)).toBe(
      authorizedKeysLine,
    );

    const data = new TextEncoder().encode("session identifier");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      (storedKey(record.id) as CryptoKeyPair).privateKey,
      data,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        await publicKeyOfLine(authorizedKeysLine),
        signature,
        data,
      ),
    ).toBe(true);
    expect((await key!.sign(data)).length).toBeGreaterThan(0);
  });

  test("an exchange saved without a key reads as having none", async () => {
    await expect(getManagedSftpClientKey("absent")).resolves.toBeUndefined();
    await expect(
      managedSftpAuthorizedKeysLine("absent"),
    ).resolves.toBeUndefined();
  });
});

describe("no path yields the private key", () => {
  test("WebCrypto refuses to export or wrap the stored private key", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    const { privateKey } = storedKey(record.id) as CryptoKeyPair;
    for (const format of ["pkcs8", "jwk", "raw", "spki"] as const)
      await expect(
        crypto.subtle.exportKey(format, privateKey),
      ).rejects.toMatchObject({ name: "InvalidAccessError" });
    const wrapping = await crypto.subtle.generateKey(
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey"],
    );
    for (const format of ["pkcs8", "jwk"] as const)
      await expect(
        crypto.subtle.wrapKey(format, privateKey, wrapping, "AES-KW"),
      ).rejects.toThrow();
  });

  test("the key the store hands out exposes no private key", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    const key = (await getManagedSftpClientKey(record.id))!;

    const parameters = await key.exportParameters();
    expect(parameters).not.toHaveProperty("d");
    expect(() => JsonWebKeyFormatter.formatEC(parameters, true)).toThrow(
      /Missing private key/,
    );
    await expect(key.importParameters({})).rejects.toThrow();
    await expect(key.generate()).rejects.toThrow();

    const copied = structuredClone({ ...key }) as Record<string, unknown>;
    for (const value of Object.values(copied))
      expect(value).not.toBeInstanceOf(CryptoKey);
  });

  test("a stored pair whose private key is extractable is refused, not used", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    const extractable = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const stored = fake.stored(
      MANAGED_EXCHANGE_DB_NAME,
      MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
      record.id,
    ) as Record<string, unknown>;
    stored.privateKey = extractable.privateKey;
    stored.publicKey = extractable.publicKey;
    await expect(getManagedSftpClientKey(record.id)).rejects.toThrow(
      /must not be extractable/,
    );
  });

  test("a stored value that is not a key pair is refused", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    const stored = fake.stored(
      MANAGED_EXCHANGE_DB_NAME,
      MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
      record.id,
    ) as Record<string, unknown>;
    stored.privateKey = stored.publicKey;
    await expect(getManagedSftpClientKey(record.id)).rejects.toThrow(
      /not a key pair/,
    );
  });
});

describe("deleting the exchange", () => {
  test("deletes its key in the same transaction as the record", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    const other = await createManagedSftpExchange(sftpExchange());

    const deleteAt = fake.transactions.length;
    await deleteManagedExchange(record.id);

    expect(fake.transactions.slice(deleteAt)).toHaveLength(1);
    expect(fake.transactions[deleteAt].storeNames).toEqual(
      expect.arrayContaining([
        MANAGED_EXCHANGE_STORE_NAME,
        MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
      ]),
    );
    expect(storedKey(record.id)).toBeUndefined();
    expect(await getManagedSftpClientKey(record.id)).toBeUndefined();
    expect(await getManagedExchange(record.id)).toBeUndefined();
    expect(await getManagedSftpClientKey(other.record.id)).toBeDefined();
  });

  test("clearing every exchange clears every key", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    await clearManagedExchanges();
    expect(storedKey(record.id)).toBeUndefined();
    expect(await listManagedExchanges()).toEqual([]);
  });
});
