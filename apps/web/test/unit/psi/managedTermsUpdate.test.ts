import { describe, expect, test } from "vitest";

import {
  PLACEHOLDER_IDENTITY,
  UsageError,
  decodeTermsUpdate,
  disclosedColumnNames,
  inferMetadata,
} from "@alcove/core";

import { managedExchangeLockName } from "@psi/managed/managedExchangeLock";

import {
  ManagedTermsUpdateRefusedError,
  makeManagedTermsUpdate,
  managedTermsUpdateRefusal,
} from "@psi/managed/managedTermsUpdate";
import {
  applyManagedExchangeSentColumns,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";

import {
  CLI_TERMS_UPDATE,
  CLI_TERMS_UPDATE_LINKAGE_COLUMNS,
  CLI_TERMS_UPDATE_SECRET,
} from "../../utils/cliTermsUpdateFixture";

import type { LinkageTerms, Metadata } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

const CONNECTION = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
} as const;

/** The linkage columns, plus `notes` sent and `county` held back. */
const OWN_METADATA: Metadata = [
  ...inferMetadata(CLI_TERMS_UPDATE_LINKAGE_COLUMNS, []),
  { name: "notes", type: "other", role: "payload", isPayload: true },
  { name: "county", type: "other", role: "ignored", isPayload: false },
];

/** Agency A's terms as the command line's configuration stated them. */
async function agencyATerms(): Promise<LinkageTerms> {
  const { linkageTerms } = await decodeTermsUpdate(
    CLI_TERMS_UPDATE,
    CLI_TERMS_UPDATE_SECRET,
  );
  const { payload: _payload, ...written } = linkageTerms;
  return written;
}

function inviterRecord(
  linkageTerms: LinkageTerms,
  metadata: Metadata | null = OWN_METADATA,
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: CONNECTION,
      linkageTerms,
      ...(metadata !== null ? { metadata } : {}),
    }),
    side: "inviter",
    sharedSecret: CLI_TERMS_UPDATE_SECRET,
  });
}

describe("choosing the columns a saved exchange sends", () => {
  test("sends the chosen columns and states them in the terms", async () => {
    const record = inviterRecord(await agencyATerms());
    const edited = applyManagedExchangeSentColumns(record, ["county"]);

    const metadata = edited.exchangeFile.metadata ?? [];
    expect(disclosedColumnNames(metadata)).toEqual(["county"]);
    expect(edited.exchangeFile.linkageTerms.payload?.send).toEqual([
      { name: "county" },
    ]);
    expect(metadata.filter((column) => column.role === "linkage")).toEqual(
      OWN_METADATA.filter((column) => column.role === "linkage"),
    );
    expect(edited.sharedSecret).toBe(record.sharedSecret);
    expect(edited.exchangeFile.connection).toEqual(
      record.exchangeFile.connection,
    );
  });

  test("refuses a column used to match, and one the exchange does not declare", async () => {
    const record = inviterRecord(await agencyATerms());
    expect(() => applyManagedExchangeSentColumns(record, ["ssn"])).toThrow(
      UsageError,
    );
    expect(() => applyManagedExchangeSentColumns(record, ["zip"])).toThrow(
      UsageError,
    );
  });

  test("offers no choice where the partner gets no result, or no columns are declared", async () => {
    const terms = await agencyATerms();
    expect(() =>
      applyManagedExchangeSentColumns(
        inviterRecord({
          ...terms,
          output: { expectsOutput: true, shareWithPartner: false },
        }),
        [],
      ),
    ).toThrow(UsageError);
    expect(() =>
      applyManagedExchangeSentColumns(inviterRecord(terms, null), []),
    ).toThrow(UsageError);
  });
});

describe("making a terms update from a saved exchange", () => {
  test("makes the update alcove update printed for the same terms and columns", async () => {
    const record = runnableManagedExchangeOrRefuse(
      applyManagedExchangeSentColumns(inviterRecord(await agencyATerms()), [
        "notes",
        "county",
      ]),
    );
    expect(await makeManagedTermsUpdate(record)).toBe(CLI_TERMS_UPDATE);
  });
});

describe("refusing a terms update", () => {
  const NOW = Date.parse("2026-09-29T00:00:00Z");

  async function runnableRecord(
    overrides: Partial<ManagedExchangeRecord> = {},
  ): Promise<RunnableManagedExchangeRecord> {
    return {
      ...runnableManagedExchangeOrRefuse(inviterRecord(await agencyATerms())),
      ...overrides,
    };
  }

  async function withIdentity(
    identity: string | undefined,
  ): Promise<RunnableManagedExchangeRecord> {
    const record = await runnableRecord();
    const { identity: _identity, ...terms } = record.exchangeFile.linkageTerms;
    return {
      ...record,
      exchangeFile: {
        ...record.exchangeFile,
        linkageTerms: identity === undefined ? terms : { ...terms, identity },
      },
    };
  }

  async function refusalOfMake(
    record: RunnableManagedExchangeRecord,
  ): Promise<string> {
    const error: unknown = await makeManagedTermsUpdate(record).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ManagedTermsUpdateRefusedError);
    return (error as ManagedTermsUpdateRefusedError).refusal;
  }

  test("refuses nothing for a named exchange with a live secret and no run", async () => {
    const record = await runnableRecord({
      expires: "2026-10-29T00:00:00.000Z",
    });
    expect(managedTermsUpdateRefusal(record, NOW, false)).toBeNull();
  });

  test("refuses once the secret has lapsed", async () => {
    const record = await runnableRecord({
      expires: "2026-09-01T00:00:00.000Z",
    });
    expect(managedTermsUpdateRefusal(record, NOW, false)).toBe("lapsed");
    expect(
      managedTermsUpdateRefusal(
        record,
        Date.parse("2026-08-29T00:00:00Z"),
        false,
      ),
    ).toBeNull();
  });

  test("refuses terms naming no identity, a blank one, or the placeholder", async () => {
    for (const identity of [undefined, " ", PLACEHOLDER_IDENTITY])
      expect(
        managedTermsUpdateRefusal(await withIdentity(identity), NOW, false),
      ).toBe("no-identity");
  });

  test("refuses while a run is in flight", async () => {
    const record = await runnableRecord({
      expires: "2026-10-29T00:00:00.000Z",
    });
    expect(managedTermsUpdateRefusal(record, NOW, true)).toBe("run-in-flight");
  });

  test("make refuses under a lapsed secret at the time of the call", async () => {
    expect(
      await refusalOfMake(
        await runnableRecord({ expires: "2000-01-01T00:00:00.000Z" }),
      ),
    ).toBe("lapsed");
  });

  test("make refuses terms naming no identity, a blank one, or the placeholder", async () => {
    for (const identity of [undefined, " ", PLACEHOLDER_IDENTITY])
      expect(await refusalOfMake(await withIdentity(identity))).toBe(
        "no-identity",
      );
  });

  test("make refuses while the run lock is held", async () => {
    const record = await runnableRecord();
    await navigator.locks.request(
      managedExchangeLockName(record.id),
      async () => {
        expect(await refusalOfMake(record)).toBe("run-in-flight");
      },
    );
    await expect(makeManagedTermsUpdate(record)).resolves.toEqual(
      expect.any(String),
    );
  });
});
