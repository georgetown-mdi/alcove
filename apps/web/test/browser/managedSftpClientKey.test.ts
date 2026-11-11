/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_RESULTS_STORE_NAME,
  MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  deleteManagedExchange,
  getManagedExchange,
  openManagedExchangeDatabase,
} from "@psi/managed/managedExchangeStore";
import {
  createManagedSftpExchange,
  getManagedSftpClientKey,
  managedSftpAuthorizedKeysLine,
} from "@psi/managed/managedSftpClientKey";
import { buildManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import { connectBrowserSsh } from "@psi/transport/browserSsh/browserSshClient";

import type {
  SshTarget,
  SshTargetOptions,
} from "../devServer/sshTargetCommands";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

/**
 * An SFTP exchange's client key in Chromium's IndexedDB, where the store
 * keeps the `CryptoKey` by structured clone, and its `authorized_keys` line
 * against a real OpenSSH sshd through the SFTP relay
 * (test/devServer/sshTargetCommands.ts).
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    sshTargetAvailable: () => Promise<boolean>;
    startSshTarget: (options: SshTargetOptions) => Promise<SshTarget>;
    authorizeSshKey: (id: number, line: string) => Promise<void>;
    stopSshTarget: (id: number) => Promise<void>;
  }
}

// Without an sshd this skips, and the run's prerequisite gate
// (test/requireTestPrerequisites.ts) names it, failing the run in CI.
const sshTest = test.skipIf(!(await commands.sshTargetAvailable()));

function sftpExchange(): NewManagedExchange {
  return {
    label: "",
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

/** The value stored under `id` in the key store, read on its own connection. */
async function rawStoredKey(id: string): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const read = db
        .transaction(MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME, "readonly")
        .objectStore(MANAGED_EXCHANGE_SFTP_KEY_STORE_NAME)
        .get(id);
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
  } finally {
    db.close();
  }
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MANAGED_EXCHANGE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const started: Array<number> = [];

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((id) => commands.stopSshTarget(id)));
  await clearManagedExchanges();
});

describe("the key in IndexedDB", () => {
  test("is stored as a CryptoKey that stays non-extractable and signs after a read back", async () => {
    const { record, authorizedKeysLine } =
      await createManagedSftpExchange(sftpExchange());

    const stored = (await rawStoredKey(record.id)) as CryptoKeyPair;
    expect(stored.privateKey).toBeInstanceOf(CryptoKey);
    expect(stored.privateKey.extractable).toBe(false);
    for (const format of ["pkcs8", "jwk", "raw"] as const)
      await expect(
        crypto.subtle.exportKey(format, stored.privateKey),
      ).rejects.toMatchObject({ name: "InvalidAccessError" });

    const key = await getManagedSftpClientKey(record.id);
    expect(key).toBeDefined();
    expect(await managedSftpAuthorizedKeysLine(record.id)).toBe(
      authorizedKeysLine,
    );
    const data = new TextEncoder().encode("session identifier");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      stored.privateKey,
      data,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        stored.publicKey,
        signature,
        data,
      ),
    ).toBe(true);
  });

  test("goes when the exchange is deleted", async () => {
    const { record } = await createManagedSftpExchange(sftpExchange());
    await deleteManagedExchange(record.id);
    expect(await rawStoredKey(record.id)).toBeUndefined();
    expect(await getManagedSftpClientKey(record.id)).toBeUndefined();
  });

  test("a database an earlier build created gains the key store and keeps its records", async () => {
    await deleteDatabase();
    const earlier = buildManagedExchangeRecord(sftpExchange());
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(MANAGED_EXCHANGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(MANAGED_EXCHANGE_STORE_NAME, {
          keyPath: "id",
        }).add(earlier);
        db.createObjectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME);
        db.createObjectStore(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME);
        db.createObjectStore(MANAGED_EXCHANGE_RESULTS_STORE_NAME);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    expect(await getManagedExchange(earlier.id)).toEqual(earlier);
    const { record } = await createManagedSftpExchange(sftpExchange());
    expect(await getManagedSftpClientKey(record.id)).toBeDefined();
  });
});

sshTest(
  "OpenSSH accepts the saved line and the key read back from the store authenticates",
  async () => {
    const target = await commands.startSshTarget({ origin: location.origin });
    started.push(target.id);
    const { record, authorizedKeysLine } =
      await createManagedSftpExchange(sftpExchange());
    await commands.authorizeSshKey(target.id, authorizedKeysLine);

    const key = await getManagedSftpClientKey(record.id);
    expect(key).toBeDefined();
    const session = await connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key: key!,
      onHostKey: () => true,
    });
    await session.close();
  },
);
