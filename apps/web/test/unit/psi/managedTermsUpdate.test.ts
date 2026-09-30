import { beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

import {
  PLACEHOLDER_IDENTITY,
  UsageError,
  decodeTermsUpdate,
  deriveAcceptedLinkageTerms,
  disclosedColumnNames,
  encodeTermsUpdate,
  generateSharedSecret,
  inferMetadata,
  termsUpdateFor,
  validateCompatibility,
} from "@alcove/core";

import {
  ManagedExchangeLockUnavailableError,
  managedExchangeLockName,
} from "@psi/managed/managedExchangeLock";

import {
  ManagedTermsUpdateNotAppliedError,
  ManagedTermsUpdateRefusedError,
  applyManagedTermsUpdate,
  makeManagedTermsUpdate,
  managedTermsUpdateRefusal,
  readManagedTermsUpdate,
} from "@psi/managed/managedTermsUpdate";
import {
  applyManagedExchangeSentColumns,
  applyManagedExchangeTermsChange,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { clearManagedExchangeTermsProposal } from "@psi/managed/managedLocalState";

import {
  TERMS_UPDATE_NOT_APPLIED_TEXT,
  termsUpdateNotAppliedText,
} from "@recurring/managedTermsUpdateModel";

import {
  CLI_TERMS_UPDATE,
  CLI_TERMS_UPDATE_LINKAGE_COLUMNS,
  CLI_TERMS_UPDATE_SECRET,
} from "../../utils/cliTermsUpdateFixture";

import type * as ManagedExchangeRecordModule from "@psi/managed/managedExchangeRecord";
import type * as ManagedExchangeStore from "@psi/managed/managedExchangeStore";
import type { ExchangeSpec, LinkageTerms, Metadata } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  ManagedTermsChangeWrite,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedTermsUpdateReading } from "@psi/managed/managedTermsUpdate";

/** The stored exchanges, by id, as the bytes the store would hold. */
const storedBytes = vi.hoisted(() => new Map<string, string>());

vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => {
  const records = await import("@psi/managed/managedExchangeRecord");
  const read = (id: string) => {
    const bytes = storedBytes.get(id);
    return bytes === undefined
      ? undefined
      : records.parseManagedExchangeRecord(JSON.parse(bytes));
  };
  return {
    ...(await importOriginal<typeof ManagedExchangeStore>()),
    getManagedExchange: vi.fn((id: string) => Promise.resolve(read(id))),
    persistManagedExchangeTermsChange: vi.fn(
      (id: string, write: ManagedTermsChangeWrite) => {
        const stored = read(id);
        if (stored === undefined) throw new Error(`no exchange ${id}`);
        const next = records.applyManagedExchangeTermsChange(stored, write);
        storedBytes.set(id, JSON.stringify(next));
        return Promise.resolve(next);
      },
    ),
  };
});
vi.mock("@psi/managed/managedExchangeRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedExchangeRecordModule>();
  return {
    ...actual,
    applyManagedExchangeTermsChange: vi.fn(
      actual.applyManagedExchangeTermsChange,
    ),
  };
});
vi.mock("@psi/managed/managedLocalState", () => ({
  clearManagedExchangeTermsProposal: vi.fn(() => Promise.resolve()),
}));

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

describe("applying a partner's terms update", () => {
  /** Agency A's terms before the update: it sent `notes`. */
  async function agencyATermsBefore(): Promise<LinkageTerms> {
    return {
      ...(await agencyATerms()),
      payload: { send: [{ name: "notes" }] },
    };
  }

  /** Agency B, which accepted Agency A's invitation and receives `notes`. */
  async function agencyBRecord(
    sharedSecret = CLI_TERMS_UPDATE_SECRET,
    overrides: Partial<ManagedExchangeRecord> = {},
  ): Promise<RunnableManagedExchangeRecord> {
    const record = runnableManagedExchangeOrRefuse({
      ...buildManagedExchangeRecord({
        label: "Riverbend quarterly",
        exchangeFile: composeManagedExchangeFile({
          connection: CONNECTION,
          linkageTerms: deriveAcceptedLinkageTerms(
            await agencyATermsBefore(),
            "Agency B",
          ),
          metadata: inferMetadata(CLI_TERMS_UPDATE_LINKAGE_COLUMNS, []),
          expectedPartnerDeduplicate: false,
        }),
        side: "acceptor",
        sharedSecret,
      }),
      ...overrides,
    });
    storedBytes.set(record.id, JSON.stringify(record));
    return record;
  }

  function storedRecord(id: string): ManagedExchangeRecord {
    return parseManagedExchangeRecord(
      JSON.parse(storedBytes.get(id) as string),
    );
  }

  async function refusalOf(work: Promise<unknown>): Promise<string> {
    const error: unknown = await work.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ManagedTermsUpdateNotAppliedError);
    return (error as ManagedTermsUpdateNotAppliedError).refusal;
  }

  /** A reading as a page would hold it, for an update read nowhere. */
  function unreadUpdate(encoded: string): ManagedTermsUpdateReading {
    return {
      encoded,
      partnerTerms: OWN_TERMS,
      delta: {
        received: undefined,
        sent: undefined,
        partnerDeduplicate: undefined,
        otherTerms: [],
      },
    };
  }

  let OWN_TERMS: LinkageTerms;

  beforeEach(async () => {
    storedBytes.clear();
    vi.mocked(clearManagedExchangeTermsProposal).mockClear();
    OWN_TERMS = await agencyATerms();
  });

  test("shows and applies an update alcove update printed, and the next run agrees", async () => {
    const record = await agencyBRecord();

    const reading = await readManagedTermsUpdate(
      record,
      `${CLI_TERMS_UPDATE.slice(0, 80)}\n  ${CLI_TERMS_UPDATE.slice(80)}\n`,
    );
    expect(reading.encoded).toBe(CLI_TERMS_UPDATE);
    expect(reading.partnerTerms.identity).toBe("Agency A");
    expect(reading.delta).toEqual({
      received: { added: ["county"], removed: [] },
      sent: undefined,
      partnerDeduplicate: undefined,
      otherTerms: [],
    });

    const applied = await applyManagedTermsUpdate(record.id, reading);
    expect(storedRecord(record.id)).toEqual(applied);
    expect(
      applied.exchangeFile.linkageTerms.payload?.receive?.map(
        ({ name }) => name,
      ),
    ).toEqual(["notes", "county"]);
    expect(applied.exchangeFile.linkageTerms.identity).toBe("Agency B");
    expect(applied.sharedSecret).toBe(record.sharedSecret);
    expect(clearManagedExchangeTermsProposal).toHaveBeenCalledWith(record.id);

    expect(
      validateCompatibility(
        applied.exchangeFile.linkageTerms,
        reading.partnerTerms,
      ).errors,
    ).toEqual([]);
    const again = await readManagedTermsUpdate(
      runnableManagedExchangeOrRefuse(applied),
      CLI_TERMS_UPDATE,
    );
    expect(again.delta).toEqual({
      received: undefined,
      sent: undefined,
      partnerDeduplicate: undefined,
      otherTerms: [],
    });
  });

  test("applies an update made without metadata as alcove apply does", async () => {
    const record = await agencyBRecord();
    const madeWithoutMetadata = termsUpdateFor(
      {
        ...OWN_TERMS,
        payload: { send: [{ name: "notes" }, { name: "county" }] },
      },
      undefined,
    );
    const encoded = await encodeTermsUpdate(
      madeWithoutMetadata,
      CLI_TERMS_UPDATE_SECRET,
    );
    const update = await decodeTermsUpdate(encoded, CLI_TERMS_UPDATE_SECRET);

    const applied = await applyManagedTermsUpdate(
      record.id,
      await readManagedTermsUpdate(record, encoded),
    );
    expect(applied.exchangeFile.linkageTerms).toEqual(
      deriveAcceptedLinkageTerms(
        update.linkageTerms,
        "Agency B",
        record.exchangeFile.linkageTerms.deduplicate,
      ),
    );
    expect(applied.exchangeFile.expectedPartnerDeduplicate).toBe(
      update.linkageTerms.deduplicate,
    );
  });

  /** An update from Agency A stating `terms`, under the exchange's secret. */
  async function updateStating(terms: LinkageTerms): Promise<string> {
    return encodeTermsUpdate(
      termsUpdateFor(terms, undefined),
      CLI_TERMS_UPDATE_SECRET,
    );
  }

  /** Agency B's stored exchange, with its document's own blocks replaced. */
  async function agencyBRecordHolding(
    own: Pick<ExchangeSpec, "metadata" | "standardization">,
  ): Promise<RunnableManagedExchangeRecord> {
    const agencyB = await agencyBRecord();
    const record = runnableManagedExchangeOrRefuse({
      ...agencyB,
      exchangeFile: { ...agencyB.exchangeFile, ...own },
    });
    storedBytes.set(record.id, JSON.stringify(record));
    return record;
  }

  /** Agency B cleans its own first names before matching on them. */
  const FIRST_NAME_STANDARDIZATION = [
    { output: "first_name", input: "first_name" },
  ];

  test.each<{
    rule: string;
    own: () => Pick<ExchangeSpec, "metadata" | "standardization">;
    partnerTerms: () => LinkageTerms;
    cause: RegExp;
  }>([
    {
      rule: "count-only transmitting a column",
      own: () => ({
        metadata: [
          ...inferMetadata(CLI_TERMS_UPDATE_LINKAGE_COLUMNS, []),
          { name: "county", type: "other", role: "payload", isPayload: true },
        ],
      }),
      partnerTerms: () => ({
        ...OWN_TERMS,
        algorithm: "psi-c",
        linkageKeys: OWN_TERMS.linkageKeys.slice(0, 1),
        output: { expectsOutput: false, shareWithPartner: false },
      }),
      cause: /count-only/,
    },
    {
      rule: "standardization not matching the terms",
      own: () => ({ standardization: FIRST_NAME_STANDARDIZATION }),
      partnerTerms: () => ({
        ...OWN_TERMS,
        linkageFields: OWN_TERMS.linkageFields.filter(
          ({ name }) => name !== "first_name",
        ),
        linkageKeys: OWN_TERMS.linkageKeys.slice(0, 1),
      }),
      cause: /standardization output "first_name" does not match/,
    },
  ])(
    "refuses at Check an update a run would refuse ($rule), naming the rule, and writes nothing",
    async ({ own, partnerTerms, cause }) => {
      const record = await agencyBRecordHolding(own());
      const before = storedBytes.get(record.id);
      const update = await updateStating(partnerTerms());

      const error: unknown = await readManagedTermsUpdate(record, update).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ManagedTermsUpdateNotAppliedError);
      const refused = error as ManagedTermsUpdateNotAppliedError;
      expect(refused.refusal).toBe("not-runnable");
      expect(refused.cause).toBeInstanceOf(UsageError);
      const rule = (refused.cause as UsageError).message;
      expect(rule).toMatch(cause);
      expect(termsUpdateNotAppliedText(error)).toBe(
        `${TERMS_UPDATE_NOT_APPLIED_TEXT["not-runnable"]} The rule the terms ` +
          `break: ${rule}`,
      );
      expect(
        await refusalOf(
          applyManagedTermsUpdate(record.id, unreadUpdate(update)),
        ),
      ).toBe("not-runnable");
      expect(storedBytes.get(record.id)).toBe(before);
    },
  );

  test("refuses at Check and at Accept an update whose element transform does not compile, naming the rule, and writes nothing", async () => {
    const record = await agencyBRecord();
    const before = storedBytes.get(record.id);
    const [first, ...rest] = OWN_TERMS.linkageKeys;
    const [element, ...others] = first.elements;
    const update = await updateStating({
      ...OWN_TERMS,
      linkageKeys: [
        {
          ...first,
          elements: [
            { ...element, transform: [{ function: "pad_left", params: {} }] },
            ...others,
          ],
        },
        ...rest,
      ],
    });

    const error: unknown = await readManagedTermsUpdate(record, update).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ManagedTermsUpdateNotAppliedError);
    const refused = error as ManagedTermsUpdateNotAppliedError;
    expect(refused.refusal).toBe("not-runnable");
    expect(refused.cause).toBeInstanceOf(UsageError);
    const rule = (refused.cause as UsageError).message;
    expect(rule).toMatch(/pad_left/);
    expect(termsUpdateNotAppliedText(error)).toBe(
      `${TERMS_UPDATE_NOT_APPLIED_TEXT["not-runnable"]} The rule the terms ` +
        `break: ${rule}`,
    );
    expect(
      await refusalOf(applyManagedTermsUpdate(record.id, unreadUpdate(update))),
    ).toBe("not-runnable");
    expect(storedBytes.get(record.id)).toBe(before);
  });

  test("applies an update a run holding this party's own standardization accepts", async () => {
    const record = await agencyBRecordHolding({
      standardization: FIRST_NAME_STANDARDIZATION,
    });
    const applied = await applyManagedTermsUpdate(
      record.id,
      await readManagedTermsUpdate(record, CLI_TERMS_UPDATE),
    );
    expect(storedRecord(record.id)).toEqual(applied);
    expect(applied.exchangeFile.standardization).toEqual(
      FIRST_NAME_STANDARDIZATION,
    );
    expect(applied.exchangeFile.linkageTerms.identity).toBe("Agency B");
  });

  test("refuses as not applicable where the record cannot hold the terms", async () => {
    const record = await agencyBRecord();
    vi.mocked(applyManagedExchangeTermsChange).mockImplementationOnce(() => {
      throw new ZodError([]);
    });
    expect(
      await refusalOf(readManagedTermsUpdate(record, CLI_TERMS_UPDATE)),
    ).toBe("not-applicable");
  });

  test("passes an unexpected error from the apply write through", async () => {
    const record = await agencyBRecord();
    const defect = new TypeError("a defect in the apply write");
    vi.mocked(applyManagedExchangeTermsChange).mockImplementationOnce(() => {
      throw defect;
    });
    await expect(readManagedTermsUpdate(record, CLI_TERMS_UPDATE)).rejects.toBe(
      defect,
    );
  });

  const tampered = `${CLI_TERMS_UPDATE.slice(0, -2)}${
    CLI_TERMS_UPDATE.endsWith("AA") ? "BB" : "AA"
  }`;

  test.each([
    ["format", "not a terms update"],
    ["format", CLI_TERMS_UPDATE.slice(0, 200)],
    ["authentication", tampered],
  ])(
    "refuses a malformed update (%s) and leaves the record byte-identical",
    async (refusal, pasted) => {
      const record = await agencyBRecord();
      const before = storedBytes.get(record.id);
      expect(await refusalOf(readManagedTermsUpdate(record, pasted))).toBe(
        refusal,
      );
      expect(
        await refusalOf(
          applyManagedTermsUpdate(record.id, unreadUpdate(pasted)),
        ),
      ).toBe(refusal);
      expect(storedBytes.get(record.id)).toBe(before);
    },
  );

  test("refuses an update for a different exchange and leaves the record byte-identical", async () => {
    const record = await agencyBRecord(generateSharedSecret());
    const before = storedBytes.get(record.id);
    expect(
      await refusalOf(readManagedTermsUpdate(record, CLI_TERMS_UPDATE)),
    ).toBe("partnership");
    expect(
      await refusalOf(
        applyManagedTermsUpdate(record.id, unreadUpdate(CLI_TERMS_UPDATE)),
      ),
    ).toBe("partnership");
    expect(storedBytes.get(record.id)).toBe(before);
  });

  test("refuses an update made from this exchange's own terms", async () => {
    const own = runnableManagedExchangeOrRefuse(
      applyManagedExchangeSentColumns(inviterRecord(OWN_TERMS), [
        "notes",
        "county",
      ]),
    );
    storedBytes.set(own.id, JSON.stringify(own));
    const before = storedBytes.get(own.id);
    expect(
      await refusalOf(
        readManagedTermsUpdate(own, await makeManagedTermsUpdate(own)),
      ),
    ).toBe("own-terms");
    expect(
      await refusalOf(
        applyManagedTermsUpdate(own.id, unreadUpdate(CLI_TERMS_UPDATE)),
      ),
    ).toBe("own-terms");
    expect(storedBytes.get(own.id)).toBe(before);
  });

  test("refuses under a lapsed secret", async () => {
    const record = await agencyBRecord(CLI_TERMS_UPDATE_SECRET, {
      expires: "2000-01-01T00:00:00.000Z",
    });
    const before = storedBytes.get(record.id);
    expect(
      await refusalOf(readManagedTermsUpdate(record, CLI_TERMS_UPDATE)),
    ).toBe("lapsed");
    expect(
      await refusalOf(
        applyManagedTermsUpdate(record.id, unreadUpdate(CLI_TERMS_UPDATE)),
      ),
    ).toBe("lapsed");
    expect(storedBytes.get(record.id)).toBe(before);
  });

  test("refuses without waiting while a run is in flight", async () => {
    const record = await agencyBRecord();
    const reading = await readManagedTermsUpdate(record, CLI_TERMS_UPDATE);
    const before = storedBytes.get(record.id);
    await navigator.locks.request(
      managedExchangeLockName(record.id),
      async () => {
        expect(
          await refusalOf(readManagedTermsUpdate(record, CLI_TERMS_UPDATE)),
        ).toBe("run-in-flight");
        await expect(
          applyManagedTermsUpdate(record.id, reading),
        ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
      },
    );
    expect(storedBytes.get(record.id)).toBe(before);
  });

  test("refuses where the stored exchange changed after the update was read", async () => {
    const record = await agencyBRecord();
    const reading = await readManagedTermsUpdate(record, CLI_TERMS_UPDATE);
    const changed = applyManagedExchangeTermsChange(record, {
      scope: "apply",
      partnerTerms: reading.partnerTerms,
    });
    storedBytes.set(record.id, JSON.stringify(changed));
    const before = storedBytes.get(record.id);
    expect(await refusalOf(applyManagedTermsUpdate(record.id, reading))).toBe(
      "changed",
    );
    expect(storedBytes.get(record.id)).toBe(before);
  });
});
