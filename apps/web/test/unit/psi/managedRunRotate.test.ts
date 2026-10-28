import { describe, expect, test } from "vitest";
import { generateSharedSecret } from "@alcove/core";

import {
  RotationPersistError,
  failedRun,
  rotationWriteBack,
  storageFailureRun,
  storeRotatedSecret,
  succeededRun,
} from "@psi/managed/managedRunRotate";

import type { RotationWriteBack } from "@psi/managed/managedRunRotate";

// The pure ordering and decision half of the run+rotate critical section, tested
// in Node without a database or a real Web Lock: the rotation write core's terms
// exchange awaits (with the persist and lock boundaries faked), the `expires` restamp from the
// max-age policy, and the `lastRun` bookkeeping. The strict-durability transaction,
// the single-writer lock, and the no-steal property are the platform half, tested
// against real Chromium in test/browser/managedExchangeRun.test.ts.

// A fixed rotation instant and a day in ms, so the expected restamp is a plain
// arithmetic check rather than a re-derivation of the function under test.
const ROTATION_AT = Date.parse("2026-07-14T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

describe("rotationWriteBack: the expires restamp", () => {
  test("with no policy, clears any standing bound (expires: null)", () => {
    const secret = generateSharedSecret();
    const writeBack = rotationWriteBack(secret, undefined, ROTATION_AT);
    expect(writeBack).toEqual({ sharedSecret: secret, expires: null });
  });

  test("with a policy, restamps expires to now + tokenMaxAgeDays days", () => {
    const secret = generateSharedSecret();
    const writeBack = rotationWriteBack(secret, 90, ROTATION_AT);
    expect(writeBack.sharedSecret).toBe(secret);
    expect(writeBack.expires).toBe(
      new Date(ROTATION_AT + 90 * MS_PER_DAY).toISOString(),
    );
  });

  test("rejects a non-positive-integer age (a schema-bypassing caller)", () => {
    const secret = generateSharedSecret();
    expect(() => rotationWriteBack(secret, 0, ROTATION_AT)).toThrow(RangeError);
    expect(() => rotationWriteBack(secret, -1, ROTATION_AT)).toThrow(
      RangeError,
    );
    expect(() => rotationWriteBack(secret, 1.5, ROTATION_AT)).toThrow(
      RangeError,
    );
  });

  test("rejects an age whose computed expiry overflows the date range", () => {
    const secret = generateSharedSecret();
    // Far beyond year 9999 from the epoch.
    expect(() => rotationWriteBack(secret, 100_000_000, ROTATION_AT)).toThrow(
      RangeError,
    );
  });
});

describe("lastRun bookkeeping builders", () => {
  test("succeededRun records a green outcome with no failureKind", () => {
    expect(succeededRun(ROTATION_AT)).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "succeeded",
    });
  });

  test("storageFailureRun records a benign-tier storage failure", () => {
    // The `storage` kind is what steers the next handshake failure to the benign
    // Tier-1 framing rather than the attack framing.
    expect(storageFailureRun(ROTATION_AT)).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "failed",
      failureKind: "storage",
    });
  });

  test("failedRun records the runner-classified outcomes", () => {
    expect(failedRun(ROTATION_AT, "desynced", "auth")).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "desynced",
      failureKind: "auth",
    });
  });
});

describe("storeRotatedSecret: the write the terms exchange awaits", () => {
  test("persists the next secret's write-back and resolves only once it commits", async () => {
    const order: Array<string> = [];
    const nextSecret = generateSharedSecret();
    let commit: () => void = () => {};
    const stored = storeRotatedSecret(
      {
        persist: () => {
          order.push("persist");
          return new Promise<void>((resolve) => {
            commit = resolve;
          });
        },
        tokenMaxAgeDays: undefined,
        now: () => ROTATION_AT,
      },
      nextSecret,
    ).then((secret) => {
      order.push("resolved");
      return secret;
    });
    await Promise.resolve();
    expect(order).toEqual(["persist"]);
    commit();
    expect(await stored).toBe(nextSecret);
    expect(order).toEqual(["persist", "resolved"]);
  });

  test("the persist receives the restamped write-back when a policy is set", async () => {
    const seen: Array<RotationWriteBack> = [];
    const nextSecret = generateSharedSecret();
    await storeRotatedSecret(
      {
        persist: (writeBack) => {
          seen.push(writeBack);
          return Promise.resolve();
        },
        tokenMaxAgeDays: 30,
        now: () => ROTATION_AT,
      },
      nextSecret,
    );
    expect(seen).toEqual([
      {
        sharedSecret: nextSecret,
        expires: new Date(ROTATION_AT + 30 * MS_PER_DAY).toISOString(),
      },
    ]);
  });

  test("a persist failure raises the storage bookkeeping with its cause", async () => {
    const error: unknown = await storeRotatedSecret(
      {
        persist: () => Promise.reject(new Error("quota exceeded")),
        tokenMaxAgeDays: undefined,
        now: () => ROTATION_AT,
      },
      generateSharedSecret(),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RotationPersistError);
    expect((error as RotationPersistError).lastRun).toEqual(
      storageFailureRun(ROTATION_AT),
    );
    expect((error as RotationPersistError).cause).toBeInstanceOf(Error);
  });
});
