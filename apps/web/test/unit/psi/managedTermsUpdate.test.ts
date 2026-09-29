import { describe, expect, test } from "vitest";

import {
  UsageError,
  decodeTermsUpdate,
  disclosedColumnNames,
  inferMetadata,
} from "@alcove/core";

import {
  applyManagedExchangeSentColumns,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  makeManagedTermsUpdate,
  managedTermsUpdateWithheld,
} from "@psi/managed/managedTermsUpdate";

import {
  CLI_TERMS_UPDATE,
  CLI_TERMS_UPDATE_LINKAGE_COLUMNS,
  CLI_TERMS_UPDATE_SECRET,
} from "../../utils/cliTermsUpdateFixture";

import type { LinkageTerms, Metadata } from "@alcove/core";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

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

  test("is withheld once the secret has lapsed", async () => {
    const record: ManagedExchangeRecord = {
      ...inviterRecord(await agencyATerms()),
      expires: "2026-09-01T00:00:00.000Z",
    };
    expect(
      managedTermsUpdateWithheld(record, Date.parse("2026-09-29T00:00:00Z")),
    ).toBe("lapsed");
    expect(
      managedTermsUpdateWithheld(record, Date.parse("2026-08-29T00:00:00Z")),
    ).toBeUndefined();
  });
});
