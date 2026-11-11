import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  UsageError,
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  applyManagedExchangeHostKeyPin,
  buildManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeHostKeyPin,
} from "@psi/managed/managedExchangeStore";

import { createFakeIndexedDb } from "../../utils/fakeIndexedDb";

import type { ConnectionConfig } from "@alcove/core";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

const CURRENT = `SHA256:${"C".repeat(42)}A`;
const ROTATED = `SHA256:${"R".repeat(42)}E`;

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function sftpRecord(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "",
    exchangeFile: assembleExchangeSpec({
      connection: connectionFromLocator({
        channel: "sftp",
        host: "sftp.example.org",
        path: "/exchange",
      }),
      linkageTerms,
    }),
  });
}

function pinsOf(record: ManagedExchangeRecord | undefined): unknown {
  const connection: ConnectionConfig | undefined =
    record?.exchangeFile.connection;
  return connection?.channel === "sftp"
    ? connection.server.hostKeyFingerprint
    : undefined;
}

describe("applyManagedExchangeHostKeyPin", () => {
  test("pins a first key, adds a rotated one beside it, and repeats nothing", () => {
    const record = sftpRecord();
    const pinned = applyManagedExchangeHostKeyPin(record, CURRENT);
    expect(pinsOf(pinned)).toBe(CURRENT);
    expect(pinsOf(record)).toBeUndefined();

    const rotated = applyManagedExchangeHostKeyPin(pinned, ROTATED);
    expect(pinsOf(rotated)).toEqual([CURRENT, ROTATED]);
    expect(applyManagedExchangeHostKeyPin(rotated, CURRENT)).toBe(rotated);
  });

  test("refuses a text that is not a host-key fingerprint", () => {
    expect(() =>
      applyManagedExchangeHostKeyPin(sftpRecord(), "C".repeat(42) + "A"),
    ).toThrow(UsageError);
  });

  test("refuses an exchange that does not connect to an SFTP server", () => {
    const webrtc = buildManagedExchangeRecord({
      label: "",
      exchangeFile: assembleExchangeSpec({
        connection: connectionFromLocator({
          channel: "webrtc",
          host: "signaling.example.org",
        }),
        linkageTerms,
      }),
      side: "inviter",
    });
    expect(() => applyManagedExchangeHostKeyPin(webrtc, CURRENT)).toThrow(
      /does not connect to an SFTP server/,
    );
  });
});

describe("persistManagedExchangeHostKeyPin", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", createFakeIndexedDb().factory);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stores the pin with the exchange, where a later read finds it", async () => {
    const { label, exchangeFile } = sftpRecord();
    const created = await createManagedExchange({ label, exchangeFile });
    await persistManagedExchangeHostKeyPin(created.id, CURRENT);
    expect(pinsOf(await getManagedExchange(created.id))).toBe(CURRENT);
    await persistManagedExchangeHostKeyPin(created.id, ROTATED);
    expect(pinsOf(await getManagedExchange(created.id))).toEqual([
      CURRENT,
      ROTATED,
    ]);
  });
});
