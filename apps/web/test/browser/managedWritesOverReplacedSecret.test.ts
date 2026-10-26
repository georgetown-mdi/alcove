/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import {
  ConnectionError,
  decodeTermsUpdate,
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateCompatibility } from "@alcove/core/testing";

import {
  ManagedExchangeSecretChangedError,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listReadableManagedExchanges,
  persistManagedExchangeRotation,
  persistManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedTermsUpdateNotAppliedError,
  applyManagedTermsUpdate,
  readManagedTermsUpdate,
} from "@psi/managed/managedTermsUpdate";
import {
  applyManagedTermsProposal,
  managedTermsProposalFor,
} from "@psi/managed/managedTermsProposal";
import {
  backUpUnattendedRun,
  browserFolderBackupDeps,
} from "@psi/managed/managedScheduleRuntime";
import {
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  getManagedLocalState,
  listReadableManagedLocalState,
  markManagedExchangeImported,
  recordManagedExchangeTermsProposal,
} from "@psi/managed/managedLocalState";
import { awaitManagedExchangeLockTurn } from "@psi/managed/managedExchangeLock";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import {
  CLI_TERMS_UPDATE,
  CLI_TERMS_UPDATE_LINKAGE_COLUMNS,
  CLI_TERMS_UPDATE_SECRET,
} from "../utils/cliTermsUpdateFixture";
import { expectConsole } from "./expectedConsole";

import type * as ManagedExchangeStore from "@psi/managed/managedExchangeStore";
import type * as ManagedLocalStateModule from "@psi/managed/managedLocalState";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";

// The writes that compare the stored secret with one they read earlier, on
// the real store: a terms write whose read a run's rotation overtakes, and a
// run's writes after it released its lock, which a re-invite overtakes. A
// write lands in the gap through the hooks below, each the real store's write
// with one landing made just before or after it.

const landing = vi.hoisted(() => ({
  /** Made once, just after the next record read returns. */
  afterRecordRead: undefined as (() => Promise<void>) | undefined,
  /** Made once, just after the next local-state read returns. */
  afterLocalStateRead: undefined as (() => Promise<void>) | undefined,
  /** Made once, just before the next run outcome stamp made after a run
   * released its lock: the one stating the secret it is held to. */
  beforePostLockStamp: undefined as (() => Promise<void>) | undefined,
  /** Made once, just before the next schedule advance carrying a standing
   * condition. */
  beforeEvidenceAdvance: undefined as (() => Promise<void>) | undefined,
}));

/** Take the landing in `key`, leaving none behind. */
function takeLanding(key: keyof typeof landing) {
  const made = landing[key];
  landing[key] = undefined;
  return made;
}

vi.mock("@psi/managed/managedExchangeStore", async () => {
  const actual = await vi.importActual<typeof ManagedExchangeStore>(
    "@psi/managed/managedExchangeStore",
  );
  return {
    ...actual,
    getManagedExchange: async (id: string) => {
      const read = await actual.getManagedExchange(id);
      await takeLanding("afterRecordRead")?.();
      return read;
    },
    recordManagedExchangeLastRun: async (
      ...args: Parameters<typeof actual.recordManagedExchangeLastRun>
    ) => {
      if (args[3] !== undefined) await takeLanding("beforePostLockStamp")?.();
      return await actual.recordManagedExchangeLastRun(...args);
    },
    persistManagedExchangeScheduleAdvance: async (
      ...args: Parameters<typeof actual.persistManagedExchangeScheduleAdvance>
    ) => {
      if (args[1].standingCondition !== undefined)
        await takeLanding("beforeEvidenceAdvance")?.();
      return await actual.persistManagedExchangeScheduleAdvance(...args);
    },
  };
});

vi.mock("@psi/managed/managedLocalState", async () => {
  const actual = await vi.importActual<typeof ManagedLocalStateModule>(
    "@psi/managed/managedLocalState",
  );
  return {
    ...actual,
    getManagedLocalState: async (id: string) => {
      const read = await actual.getManagedLocalState(id);
      await takeLanding("afterLocalStateRead")?.();
      return read;
    },
  };
});

/** What the store holds for `id`: the record and its local-state entry. */
async function storedState(id: string) {
  return {
    record: await getManagedExchange(id),
    local: await getManagedLocalState(id),
  };
}

beforeEach(async () => {
  for (const key of Object.keys(landing) as Array<keyof typeof landing>)
    landing[key] = undefined;
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("a terms write a run's rotation overtakes between its read and its write", () => {
  /** Agency B, which accepted Agency A's terms while A sent only `notes`,
   * holding a proposal and the import markers in its local-state entry. */
  async function storedAgencyB(): Promise<RunnableManagedExchangeRecord> {
    const { linkageTerms } = await decodeTermsUpdate(
      CLI_TERMS_UPDATE,
      CLI_TERMS_UPDATE_SECRET,
    );
    const record = runnableManagedExchangeOrRefuse(
      await createManagedExchange({
        label: "Riverbend quarterly",
        exchangeFile: composeManagedExchangeFile({
          connection: {
            channel: "webrtc",
            host: "signaling.example.org",
            port: 3000,
            path: "/api/",
          },
          linkageTerms: deriveAcceptedLinkageTerms(
            { ...linkageTerms, payload: { send: [{ name: "notes" }] } },
            "Agency B",
          ),
          metadata: inferMetadata(CLI_TERMS_UPDATE_LINKAGE_COLUMNS, []),
          expectedPartnerDeduplicate: false,
        }),
        side: "acceptor",
        sharedSecret: CLI_TERMS_UPDATE_SECRET,
      }),
    );
    await markManagedExchangeImported(record.id, new Date().toISOString());
    return record;
  }

  /** A run's rotation of `record`, recording what the store holds after it. */
  function rotationOf(record: RunnableManagedExchangeRecord) {
    const after: { state?: Awaited<ReturnType<typeof storedState>> } = {};
    const land = async () => {
      await persistManagedExchangeRotation(record.id, record.sharedSecret, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      });
      after.state = await storedState(record.id);
    };
    return { land, after };
  }

  test("the terms update's Accept is refused as partnership, and writes nothing", async () => {
    const record = await storedAgencyB();
    const reading = await readManagedTermsUpdate(record, CLI_TERMS_UPDATE);
    const rotation = rotationOf(record);
    landing.afterRecordRead = rotation.land;

    const refused = await applyManagedTermsUpdate(record.id, reading).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(ManagedTermsUpdateNotAppliedError);
    expect((refused as ManagedTermsUpdateNotAppliedError).refusal).toBe(
      "partnership",
    );
    expect(rotation.after.state?.record?.sharedSecret).not.toBe(
      record.sharedSecret,
    );
    expect(await storedState(record.id)).toEqual(rotation.after.state);
  });

  test("the kept proposal's Apply is refused over the replaced secret, and writes nothing", async () => {
    const record = await storedAgencyB();
    const { linkageTerms: partnerTerms } = await decodeTermsUpdate(
      CLI_TERMS_UPDATE,
      CLI_TERMS_UPDATE_SECRET,
    );
    const proposal = managedTermsProposalFor(
      {
        delta: validateCompatibility(
          record.exchangeFile.linkageTerms,
          partnerTerms,
        ).delta,
        partnerTerms,
      },
      new Date(),
    );
    await recordManagedExchangeTermsProposal(record.id, proposal);
    const rotation = rotationOf(record);
    // After both reads, so the write's own compare is what refuses.
    landing.afterLocalStateRead = rotation.land;

    await expect(
      applyManagedTermsProposal(record.id, proposal.proposedAt),
    ).rejects.toBeInstanceOf(ManagedExchangeSecretChangedError);

    expect(rotation.after.state?.record?.sharedSecret).not.toBe(
      record.sharedSecret,
    );
    expect(await storedState(record.id)).toEqual(rotation.after.state);
  });
});

describe("a run's writes after it released its lock, a re-invite landing first", () => {
  const linkageTerms = getDefaultLinkageTerms("County Health Dept");

  async function workingFolder(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(
      `replaced-secret-${crypto.randomUUID()}`,
      { create: true },
    );
  }

  async function inviterRecord(
    overrides: Partial<NewManagedExchange> = {},
  ): Promise<ManagedExchangeRecord> {
    return await createManagedExchange({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
      ...overrides,
    });
  }

  async function scheduledRecord(): Promise<ManagedExchangeRecord> {
    const openedAt = new Date().toISOString();
    return await inviterRecord({
      workingDirectoryHandle: await workingFolder(),
      schedule: {
        anchor: openedAt,
        intervalDays: 7,
        windowSeconds: 60 * 60,
        nextWindow: openedAt,
        consecutiveMisses: 0,
      },
    });
  }

  /** A re-invite of `id`, recording the record it leaves. */
  function reinviteOf(id: string) {
    const after: { record?: ManagedExchangeRecord } = {};
    const land = async () => {
      after.record = (await reinviteManagedExchange(id, {})).record;
    };
    return { land, after };
  }

  /** A handshake that fails closed before the marker: its outcome stamp,
   * made after the lock released, raises the `auth` standing condition. */
  const failClosed = () =>
    Promise.reject(
      new ConnectionError("could not verify the partner", "security"),
    );

  /** A tick whose every attempt fails closed. */
  function failingTickSeams(): ManagedScheduleTickSeams {
    return {
      now: Date.now,
      listRecords: listReadableManagedExchanges,
      readRecord: getManagedExchange,
      awaitLockTurn: awaitManagedExchangeLockTurn,
      listLocalState: listReadableManagedLocalState,
      persistAdvance: persistManagedExchangeScheduleAdvance,
      delay: () => Promise.resolve(),
      stopped: () => false,
      runAttempt: (scheduled) =>
        runManagedRerun(
          scheduled.record,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: failClosed,
            dataExchange: () => Promise.resolve("exchanged"),
          },
          {
            lock: { ifAvailable: true },
            stop: new AbortController(),
            onDataExchangeStart: scheduled.onDataExchangeStart,
          },
        ).then(() => undefined),
    };
  }

  test("the failure stamp sets neither last run nor standing condition over the re-invite's secret", async () => {
    const record = await inviterRecord();
    const reinvite = reinviteOf(record.id);
    landing.beforePostLockStamp = reinvite.land;

    const error = await runManagedRerun(record, {
      acquireInput: () => Promise.resolve(undefined),
      handshake: failClosed,
      dataExchange: () => Promise.resolve("exchanged"),
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(reinvite.after.record?.sharedSecret).not.toBe(record.sharedSecret);
    expect(await getManagedExchange(record.id)).toEqual(reinvite.after.record);
  });

  test("a scheduled window's stamp and its own write set no last run, standing condition or window evidence over the re-invite's secret", async () => {
    const record = await scheduledRecord();
    const reinvite = reinviteOf(record.id);
    landing.beforePostLockStamp = reinvite.land;

    const [entry] = await tickManagedSchedules(failingTickSeams());

    expect(entry).toMatchObject({ attempts: 1, disposition: "failed" });
    const stored = await getManagedExchange(record.id);
    expect(Date.parse(stored!.schedule!.nextWindow)).toBeGreaterThan(
      Date.parse(record.schedule!.nextWindow),
    );
    expect(stored).toEqual({
      ...reinvite.after.record,
      schedule: stored?.schedule,
    });
  });

  test("a scheduled window's own write carrying the attempt's standing condition sets none over the re-invite's secret", async () => {
    const record = await scheduledRecord();
    const reinvite = reinviteOf(record.id);
    landing.beforeEvidenceAdvance = reinvite.land;

    const [entry] = await tickManagedSchedules(failingTickSeams());

    expect(entry).toMatchObject({ attempts: 1, disposition: "failed" });
    expect(reinvite.after.record).toBeDefined();
    const stored = await getManagedExchange(record.id);
    expect(stored).toEqual({
      ...reinvite.after.record,
      schedule: stored?.schedule,
    });
    expect(stored?.schedule).not.toEqual(reinvite.after.record?.schedule);
  });

  test("a schedule advance's last run and standing condition over a secret a re-invite replaced are not written, and the plan still advances", async () => {
    const record = await scheduledRecord();
    const schedule = record.schedule!;
    const reinvited = (await reinviteManagedExchange(record.id, {})).record;
    const advancedTo = new Date(
      Date.parse(schedule.nextWindow) + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const at = new Date().toISOString();

    const advanced = await persistManagedExchangeScheduleAdvance(record.id, {
      schedule: { ...schedule, nextWindow: advancedTo },
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: { at, outcome: "failed", failureKind: "auth" },
      standingCondition: { since: at, kind: "auth" },
      evidenceSharedSecret: record.sharedSecret,
    });

    expect(advanced.schedule?.nextWindow).toBe(advancedTo);
    expect(await getManagedExchange(record.id)).toEqual({
      ...reinvited,
      schedule: advanced.schedule,
    });
  });

  test("a scheduled run's backup is not taken of the record a re-invite left", async () => {
    const record = await scheduledRecord();
    const folder = record.workingDirectoryHandle!;
    const result = await runManagedRerun(record, {
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight) => {
        await markRotationInFlight();
        return { rotatedSecret: generateSharedSecret(), handshake: "carried" };
      },
      dataExchange: () => Promise.resolve("exchanged"),
    });
    const reinvited = (await reinviteManagedExchange(record.id, {})).record;
    const localBefore = await getManagedLocalState(record.id);
    expectConsole(
      "warn",
      /not backed up into its working folder: the secret changed after the run stored it/,
    );

    const backup = await backUpUnattendedRun(
      record.id,
      browserFolderBackupDeps(),
      undefined,
      result.rotatedSecret,
    );

    expect(backup.kind).toBe("secret-changed");
    const names: Array<string> = [];
    for await (const name of folder.keys()) names.push(name);
    expect(names).toEqual([]);
    expect(await getManagedLocalState(record.id)).toEqual(localBefore);
    expect(await getManagedExchange(record.id)).toEqual(reinvited);
  });
});
