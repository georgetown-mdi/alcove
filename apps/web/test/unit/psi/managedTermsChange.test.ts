import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  TermsChangeRefusedError,
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  validateCompatibility,
} from "@alcove/core";

import {
  ManagedTermsChangeTakenOnError,
  ManagedTermsProposalNotStoredError,
  TERMS_CHANGE_DECLINED_REASON,
  TERMS_CHANGE_NOT_KEPT_REASON,
  TERMS_CHANGE_UNATTENDED_REASON,
  applyManagedTermsProposal,
  declineManagedTermsProposal,
  managedTermsChangeHandler,
  managedTermsProposalDelta,
  managedTermsProposalFor,
} from "@psi/managed/managedTermsProposal";
import {
  applyManagedExchangeTermsChange,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchangeTermsProposal,
  getManagedLocalState,
  recordManagedExchangeTermsProposal,
} from "@psi/managed/managedLocalState";
import { parseManagedLocalState } from "@psi/managed/managedLocalStateShape";
import { persistManagedExchangeTermsChange } from "@psi/managed/managedExchangeStore";
import { rerunFailureLastRun } from "@psi/managed/managedRun";

import type * as ManagedExchangeStore from "@psi/managed/managedExchangeStore";
import type { LinkageTerms, Metadata, TermsChange } from "@alcove/core";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedExchangeStore>()),
  persistManagedExchangeTermsChange: vi.fn(() => Promise.resolve()),
}));
vi.mock("@psi/managed/managedLocalState", () => ({
  recordManagedExchangeTermsProposal: vi.fn(() => Promise.resolve()),
  clearManagedExchangeTermsProposal: vi.fn(() => Promise.resolve()),
  getManagedLocalState: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@psi/managed/managedExchangeLock", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withManagedExchangeLock: (_id: string, work: () => Promise<unknown>) =>
    work(),
}));

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const OWN_METADATA: Metadata = [
  ...inferMetadata(LINKAGE_COLUMNS, []),
  { name: "zip", type: "other", role: "payload", isPayload: true },
];

// Agency A invited Agency B, which receives `notes`; A's metadata has since
// added `county`.
const aTerms: LinkageTerms = {
  ...getDefaultLinkageTerms("Agency A", inferMetadata(LINKAGE_COLUMNS, [])),
  payload: { send: [{ name: "notes" }] },
};
const partnerTerms: LinkageTerms = {
  ...aTerms,
  deduplicate: true,
  payload: { send: [{ name: "notes" }, { name: "county" }] },
};

function acceptorRecord(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms: deriveAcceptedLinkageTerms(aTerms, "Agency B"),
      metadata: OWN_METADATA,
      expectedPayloadColumns: ["notes"],
      expectedPartnerDeduplicate: false,
      outboundPayloadConsent: { status: "pending" },
    }),
    side: "acceptor",
    sharedSecret: generateSharedSecret(),
  });
}

function changeFor(record: ManagedExchangeRecord, continuable = true) {
  const local = record.exchangeFile.linkageTerms;
  return {
    delta: validateCompatibility(local, partnerTerms).delta,
    partnerTerms,
    adoptedTerms: deriveAcceptedLinkageTerms(partnerTerms, "Agency B"),
    continuable,
  } satisfies TermsChange;
}

const received = (record: ManagedExchangeRecord) =>
  record.exchangeFile.linkageTerms.payload?.receive?.map(({ name }) => name);

describe("recording a partner's changed terms in the stored exchange", () => {
  test("an attended run takes the terms on and leaves this party's own records", () => {
    const record = acceptorRecord();
    const change = changeFor(record);
    const written = applyManagedExchangeTermsChange(record, {
      scope: "run",
      adoptedTerms: change.adoptedTerms,
      partnerTerms,
    });
    expect(written.exchangeFile.linkageTerms).toEqual(change.adoptedTerms);
    expect(written.exchangeFile.expectedPayloadColumns).toEqual([
      "notes",
      "county",
    ]);
    expect(written.exchangeFile.expectedPartnerDeduplicate).toBe(false);
    expect(written.exchangeFile.outboundPayloadConsent).toEqual({
      status: "pending",
    });
    expect(written.sharedSecret).toBe(record.sharedSecret);
    expect(written.exchangeFile.connection).toEqual(
      record.exchangeFile.connection,
    );
  });

  test("an apply takes the terms on as alcove apply does, and answers a refused run", () => {
    const record: ManagedExchangeRecord = {
      ...acceptorRecord(),
      lastRun: {
        at: "2026-09-28T09:00:00.000Z",
        outcome: "failed",
        failureKind: "terms-change",
      },
    };
    const written = applyManagedExchangeTermsChange(record, {
      scope: "apply",
      partnerTerms,
    });
    expect(received(written)).toEqual(["notes", "county"]);
    expect(written.exchangeFile.linkageTerms.identity).toBe("Agency B");
    expect(written.exchangeFile.linkageTerms.deduplicate).toBe(
      record.exchangeFile.linkageTerms.deduplicate,
    );
    expect(written.exchangeFile.expectedPayloadColumns).toEqual([
      "notes",
      "county",
    ]);
    expect(written.exchangeFile.expectedPartnerDeduplicate).toBe(true);
    expect(written.lastRun).toBeUndefined();
  });

  test("an apply leaves a pending outbound consent and the disclosed set as stored", () => {
    const base = acceptorRecord();
    const record: ManagedExchangeRecord = {
      ...base,
      exchangeFile: { ...base.exchangeFile, disclosedPayloadColumns: [] },
    };
    const sharing: LinkageTerms = {
      ...partnerTerms,
      output: { ...partnerTerms.output, shareWithPartner: true },
    };
    const written = applyManagedExchangeTermsChange(record, {
      scope: "apply",
      partnerTerms: sharing,
    });
    expect(written.exchangeFile.linkageTerms.output.shareWithPartner).toBe(
      true,
    );
    expect(written.exchangeFile.outboundPayloadConsent).toEqual({
      status: "pending",
    });
    expect(written.exchangeFile.disclosedPayloadColumns).toEqual([]);
  });

  test("an apply writes no outbound consent where none was stored", () => {
    const base = acceptorRecord();
    const { outboundPayloadConsent: _pending, ...withoutConsent } =
      base.exchangeFile;
    const written = applyManagedExchangeTermsChange(
      { ...base, exchangeFile: withoutConsent },
      {
        scope: "apply",
        partnerTerms: {
          ...partnerTerms,
          output: { ...partnerTerms.output, shareWithPartner: true },
        },
      },
    );
    expect(written.exchangeFile).not.toHaveProperty("outboundPayloadConsent");
    expect(written.exchangeFile).not.toHaveProperty("disclosedPayloadColumns");
  });

  test("an apply keeps a run outcome that was not a refused terms change", () => {
    const lastRun = {
      at: "2026-09-28T09:00:00.000Z",
      outcome: "succeeded",
    } as const;
    const written = applyManagedExchangeTermsChange(
      { ...acceptorRecord(), lastRun },
      { scope: "apply", partnerTerms },
    );
    expect(written.lastRun).toEqual(lastRun);
  });

  test("the input record is not changed", () => {
    const record = acceptorRecord();
    const before = structuredClone(record);
    applyManagedExchangeTermsChange(record, { scope: "apply", partnerTerms });
    expect(record).toEqual(before);
  });
});

describe("the kept proposal", () => {
  test("round-trips the local sibling store's validation and gives back core's delta", () => {
    const change = changeFor(acceptorRecord());
    const proposal = managedTermsProposalFor(
      change,
      new Date("2026-09-29T12:00:00.000Z"),
    );
    const parsed = parseManagedLocalState({ termsProposal: proposal });
    expect(parsed.termsProposal?.proposedAt).toBe("2026-09-29T12:00:00.000Z");
    expect(managedTermsProposalDelta(parsed.termsProposal!)).toEqual(
      change.delta,
    );
  });

  test("one that does not validate is dropped and the markers beside it load", () => {
    const proposal = managedTermsProposalFor(
      changeFor(acceptorRecord()),
      new Date(),
    );
    const markers = {
      backup: { backedUpAt: "2026-09-01T00:00:00.000Z" },
      spent: { spentAt: "2026-09-02T00:00:00.000Z" },
      imported: { importedAt: "2026-08-31T00:00:00.000Z" },
    };
    for (const termsProposal of [
      { ...proposal, smuggled: true },
      { ...proposal, partnerTerms: { linkageKeys: "not terms" } },
      "not a proposal",
    ])
      expect(parseManagedLocalState({ ...markers, termsProposal })).toEqual(
        markers,
      );
  });

  test("an unknown member beside it still refuses the entry", () => {
    expect(() =>
      parseManagedLocalState({
        backup: { backedUpAt: "2026-09-01T00:00:00.000Z" },
        smuggled: true,
      }),
    ).toThrow();
  });
});

describe("applying the stored proposal", () => {
  const persist = vi.mocked(persistManagedExchangeTermsChange);
  const clear = vi.mocked(clearManagedExchangeTermsProposal);
  const read = vi.mocked(getManagedLocalState);
  const stored = managedTermsProposalFor(
    changeFor(acceptorRecord()),
    new Date("2026-09-29T02:00:00.000Z"),
  );
  beforeEach(() => {
    persist.mockClear();
    clear.mockClear();
    read.mockReset();
  });

  test("applies the partner terms the store holds", async () => {
    read.mockResolvedValue({ termsProposal: stored });
    await applyManagedTermsProposal("id", stored.proposedAt);
    expect(persist).toHaveBeenCalledWith("id", {
      scope: "apply",
      partnerTerms: stored.partnerTerms,
    });
    expect(clear).toHaveBeenCalledWith("id");
  });

  test("declining drops the proposal and writes nothing to the stored exchange", async () => {
    await declineManagedTermsProposal("id");
    expect(clear).toHaveBeenCalledWith("id");
    expect(persist).not.toHaveBeenCalled();
  });

  test("refuses and writes nothing when no proposal is stored", async () => {
    read.mockResolvedValue({});
    await expect(
      applyManagedTermsProposal("id", stored.proposedAt),
    ).rejects.toBeInstanceOf(ManagedTermsProposalNotStoredError);
    expect(persist).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  test("refuses and writes nothing when another proposal replaced the one shown", async () => {
    read.mockResolvedValue({
      termsProposal: { ...stored, proposedAt: "2026-09-30T02:00:00.000Z" },
    });
    await expect(
      applyManagedTermsProposal("id", stored.proposedAt),
    ).rejects.toBeInstanceOf(ManagedTermsProposalNotStoredError);
    expect(persist).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("the run's answer to a partner terms change", () => {
  const persist = vi.mocked(persistManagedExchangeTermsChange);
  const keep = vi.mocked(recordManagedExchangeTermsProposal);
  const clear = vi.mocked(clearManagedExchangeTermsProposal);
  beforeEach(() => {
    persist.mockClear();
    keep.mockClear();
    clear.mockClear();
  });

  test("attended, accepting writes the terms the run continues under", async () => {
    const change = changeFor(acceptorRecord());
    const takenOn = vi.fn();
    await managedTermsChangeHandler(
      "id",
      () => Promise.resolve(true),
      takenOn,
    )(change);
    expect(persist).toHaveBeenCalledWith("id", {
      scope: "run",
      adoptedTerms: change.adoptedTerms,
      partnerTerms,
    });
    expect(takenOn).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith("id");
    expect(keep).not.toHaveBeenCalled();
  });

  test("attended, accepting a change the run cannot continue under applies it", async () => {
    const change = changeFor(acceptorRecord(), false);
    await managedTermsChangeHandler("id", () => Promise.resolve(true))(change);
    expect(persist).toHaveBeenCalledWith("id", {
      scope: "apply",
      partnerTerms,
    });
  });

  test("attended, declining refuses and writes nothing", async () => {
    const change = changeFor(acceptorRecord());
    const refusal = managedTermsChangeHandler("id", () =>
      Promise.resolve(false),
    )(change);
    await expect(refusal).rejects.toBeInstanceOf(TermsChangeRefusedError);
    await expect(refusal).rejects.toThrow(TERMS_CHANGE_DECLINED_REASON);
    expect(persist).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });

  test("unattended, the change is kept for the next visit and the run refused", async () => {
    const change = changeFor(acceptorRecord());
    const at = new Date("2026-09-29T02:00:00.000Z");
    await expect(
      managedTermsChangeHandler("id", undefined, undefined, () => at)(change),
    ).rejects.toBeInstanceOf(TermsChangeRefusedError);
    expect(keep).toHaveBeenCalledWith(
      "id",
      managedTermsProposalFor(change, at),
    );
    expect(persist).not.toHaveBeenCalled();
  });

  test("unattended, a change the store does not keep still refuses as a terms change, naming the store failure", async () => {
    keep.mockRejectedValueOnce(new Error("the quota is exhausted"));
    const refusal = managedTermsChangeHandler(
      "id",
      undefined,
    )(changeFor(acceptorRecord()));
    await expect(refusal).rejects.toBeInstanceOf(TermsChangeRefusedError);
    await expect(refusal).rejects.toThrow(TERMS_CHANGE_UNATTENDED_REASON);
    await expect(refusal).rejects.toThrow(
      `${TERMS_CHANGE_NOT_KEPT_REASON}: the quota is exhausted`,
    );
  });
});

describe("the run's bookkeeping", () => {
  const at = Date.parse("2026-09-29T02:00:00.000Z");

  test("records a refused terms change as its own kind", () => {
    const refusal = new TermsChangeRefusedError("x", {
      received: { added: ["county"], removed: [] },
      sent: undefined,
      partnerDeduplicate: undefined,
      otherTerms: [],
    });
    expect(rerunFailureLastRun(refusal, at, false, true)).toMatchObject({
      outcome: "failed",
      failureKind: "terms-change",
    });
  });

  test("records nothing for a change the operator took on", () => {
    expect(
      rerunFailureLastRun(
        new ManagedTermsChangeTakenOnError({ cause: undefined }),
        at,
        false,
        true,
      ),
    ).toBeUndefined();
  });
});
