/**
 * The client key an SFTP exchange saved in this browser authenticates to its
 * server with: an ECDSA P-256 pair generated when the exchange is saved, kept
 * beside the record in {@link MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME} under the
 * record's `id`, and removed with it by `deleteManagedExchange`. The private
 * key is generated not extractable, and IndexedDB keeps a `CryptoKey` by
 * structured clone with that flag, so it can sign from this browser profile
 * and cannot be read out of it. Spec: docs/spec/CREDENTIAL_STORAGE.md, Browser
 * SFTP client key.
 */

import { UsageError } from "@alcove/core";

import {
  NonExtractableEcdsaP256KeyPair,
  generateNonExtractableEcdsaP256CryptoKeyPair,
} from "../transport/browserSsh/nonExtractableEcdsaKey";

import {
  MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  requestPersistentStorage,
  runTransaction,
} from "./managedExchangeStore";
import { buildManagedExchangeRecord } from "./managedExchangeRecord";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "./managedExchangeRecord";

/** A saved SFTP exchange and the public half of its client key. */
export interface SavedManagedSftpExchange {
  record: ManagedExchangeRecord;
  /** The line the server's administrator adds to the account's
   * `authorized_keys` ({@link managedSftpAuthorizedKeysLine}). */
  authorizedKeysLine: string;
}

/**
 * The `authorized_keys` comment naming the exchange `id`. It states the
 * record's random id and never its label, which is the operator's free text.
 */
export function managedSftpClientKeyComment(id: string): string {
  return `alcove-exchange-${id}`;
}

/**
 * Save a new SFTP exchange with a client key generated for it, the record and
 * the key in one strict-durability transaction so neither is stored without
 * the other. Returns the record and the key's `authorized_keys` line, for the
 * page to show the operator to pass to the server's administrator.
 *
 * @throws {UsageError} where the document does not connect to an SFTP server.
 * @throws {ZodError} if the fields do not form a valid record.
 */
export async function createManagedSftpExchange(
  fields: NewManagedExchange,
): Promise<SavedManagedSftpExchange> {
  if (fields.exchangeFile.connection.channel !== "sftp")
    throw new UsageError(
      "this exchange does not connect to an SFTP server, so it takes no " +
        "client key",
    );
  const record = buildManagedExchangeRecord(fields);
  const pair = await generateNonExtractableEcdsaP256CryptoKeyPair();
  const key = await NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(pair);
  const authorizedKeysLine = await key.authorizedKeysLine(
    managedSftpClientKeyComment(record.id),
  );
  void requestPersistentStorage();
  await runTransaction(
    [MANAGED_EXCHANGE_STORE_NAME, MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME],
    "readwrite",
    ({ store }) => {
      store(MANAGED_EXCHANGE_STORE_NAME).add(record);
      store(MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME).add(
        { privateKey: pair.privateKey, publicKey: pair.publicKey },
        record.id,
      );
      return () => undefined;
    },
  );
  return { record, authorizedKeysLine };
}

/** Whether `value` is a `CryptoKey` of `type`. */
function isCryptoKeyOfType(value: unknown, type: KeyType): value is CryptoKey {
  return value instanceof CryptoKey && value.type === type;
}

/**
 * The stored client key of the exchange `id`, or `undefined` where none is
 * stored. It signs through WebCrypto, and no method of it returns the private
 * key.
 *
 * @throws {Error} where the stored value is not a P-256 key pair whose private
 *   key is not extractable.
 */
export async function getManagedSftpClientKey(
  id: string,
): Promise<NonExtractableEcdsaP256KeyPair | undefined> {
  const raw = await runTransaction(
    MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
    "readonly",
    ({ store }) => {
      const read = store(MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME).get(id);
      return (): unknown => read.result;
    },
  );
  if (raw === undefined) return undefined;
  const { privateKey, publicKey } = (raw ?? {}) as Record<string, unknown>;
  if (
    !isCryptoKeyOfType(privateKey, "private") ||
    !isCryptoKeyOfType(publicKey, "public")
  )
    throw new Error("The saved SFTP client key is not a key pair.");
  const key = await NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair({
    privateKey,
    publicKey,
  });
  key.comment = managedSftpClientKeyComment(id);
  return key;
}

/**
 * The `authorized_keys` line of the exchange `id`'s client key --
 * `ecdsa-sha2-nistp256`, the base64 public-key blob, and
 * {@link managedSftpClientKeyComment} -- or `undefined` where none is stored.
 *
 * @throws {Error} as {@link getManagedSftpClientKey} does.
 */
export async function managedSftpAuthorizedKeysLine(
  id: string,
): Promise<string | undefined> {
  const key = await getManagedSftpClientKey(id);
  return await key?.authorizedKeysLine(managedSftpClientKeyComment(id));
}
