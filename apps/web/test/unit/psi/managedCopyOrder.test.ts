import {
  deriveHistoryVerifier,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  managedCopyOrder,
  orderManagedStoredCopies,
} from "@psi/managed/managedCopyOrder";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedStoredCopy } from "@psi/managed/managedPairRecognition";

function record(
  fields: Partial<NewManagedExchange> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...fields,
  });
}

/** A record whose history retired `retired`, holding a fresh secret. */
async function successorOf(
  retired: string,
  older: ReadonlyArray<string> = [],
): Promise<ManagedExchangeRecord> {
  const verifiers = await Promise.all(
    [retired, ...older].map((secret) => deriveHistoryVerifier(secret)),
  );
  return record({
    rotationHistory: verifiers.map((verifier) => ({ verifier })),
  });
}

describe("managedCopyOrder", () => {
  test("an import whose history holds the stored secret is newer", async () => {
    const stored = record();
    const imported = await successorOf(stored.sharedSecret ?? "");
    expect(await managedCopyOrder(stored, imported)).toBe("import-newer");
  });

  test("a stored copy whose history holds the import's secret makes the import older", async () => {
    const imported = record();
    const stored = await successorOf(generateSharedSecret(), [
      imported.sharedSecret ?? "",
    ]);
    expect(await managedCopyOrder(stored, imported)).toBe("import-older");
  });

  test("neither history deciding orders nothing", async () => {
    const stored = await successorOf(generateSharedSecret());
    expect(await managedCopyOrder(stored, record())).toBeUndefined();
  });

  test("both histories holding the other's secret orders nothing", async () => {
    const storedSecret = generateSharedSecret();
    const importedSecret = generateSharedSecret();
    const stored = {
      sharedSecret: storedSecret,
      rotationHistory: [
        { verifier: await deriveHistoryVerifier(importedSecret) },
      ],
    };
    const imported = {
      sharedSecret: importedSecret,
      rotationHistory: [
        { verifier: await deriveHistoryVerifier(storedSecret) },
      ],
    };
    expect(await managedCopyOrder(stored, imported)).toBeUndefined();
  });

  test("a copy holding no secret orders nothing", async () => {
    const imported = record();
    const stored = await successorOf(imported.sharedSecret ?? "");
    expect(
      await managedCopyOrder({ ...stored, sharedSecret: undefined }, imported),
    ).toBeUndefined();
  });
});

describe("orderManagedStoredCopies", () => {
  test("adds each runnable copy's order and leaves the rest as they were", async () => {
    const imported = record();
    const newerStored = await successorOf(imported.sharedSecret ?? "");
    const unrelated = record();
    const records = new Map<string, ManagedExchangeRecord>([
      ["newer-stored", newerStored],
      ["unrelated", unrelated],
    ]);
    const copies: Array<ManagedStoredCopy> = [
      { id: "newer-stored", label: "A", state: "runs-here" },
      { id: "unrelated", label: "B", state: "runs-here" },
      { id: "configuration", label: "C", state: "configuration-only" },
      { id: "gone", label: "D", state: "runs-here" },
    ];
    const read = (id: string) => {
      if (id === "configuration") throw new Error("not read");
      return Promise.resolve(records.get(id));
    };
    expect(await orderManagedStoredCopies(copies, imported, read)).toEqual([
      {
        id: "newer-stored",
        label: "A",
        state: "runs-here",
        order: "import-older",
      },
      { id: "unrelated", label: "B", state: "runs-here" },
      { id: "configuration", label: "C", state: "configuration-only" },
      { id: "gone", label: "D", state: "runs-here" },
    ]);
  });

  test("a copy whose record cannot be read is returned as it was", async () => {
    const copies: Array<ManagedStoredCopy> = [
      { id: "a", label: "A", state: "runs-here" },
    ];
    expect(
      await orderManagedStoredCopies(copies, record(), () =>
        Promise.reject(new Error("unreadable")),
      ),
    ).toEqual(copies);
  });
});
