import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  PROTOCOL_VERSION,
  ProtocolRefusalError,
  createMessagePipe,
  exchangeTerms,
} from "@alcove/core/testing";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  lastRunSchema,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  PARTNER_PROTOCOL_REFUSAL_REMEDY,
  PARTNER_PROTOCOL_REFUSAL_TITLE,
} from "@psi/managed/managedFailureCopy";
import {
  benignRerunOutcome,
  rerunFailureLastRun,
} from "@psi/managed/managedRun";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import {
  lastRunMayHaveSentPayload,
  runHistoryEntries,
} from "@recurring/managedDetailModel";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";
import { failureFor } from "@exchange/useInviterExchange";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { LinkageTerms } from "@alcove/core";

// A run that refused its partner's data as not following the exchange
// protocol: the partner's run sends the same data at every attempt, so the
// one-shot alert offers no retry, and a managed run records a kind of its own
// that the next visit, the notification, the list row, and the run history
// state rather than a connection problem.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

const terms: LinkageTerms = {
  version: "1.0.0",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

/** The refusal the joiner raises at a partner's PSI setup out of order. */
const SETUP_REFUSAL_MESSAGE =
  "client protocol error: PSI server setup is not in strictly ascending element order";

/** The initiator's refusal of a responder message with no record count. */
async function termsMessageRefusal(): Promise<Error> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const initiator = exchangeTerms(initiatorConn, "initiator", terms, 1);
  await responderConn.receive();
  await responderConn.send({
    linkageTerms: terms,
    decision: "proceed",
    protocolVersion: PROTOCOL_VERSION,
  });
  await responderConn.receive();
  return (await initiator.catch((error: unknown) => error)) as Error;
}

/** The initiator's error for the responder's own abort at the terms exchange. */
async function partnerTermsAbort(): Promise<Error> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const initiator = exchangeTerms(initiatorConn, "initiator", terms, 1);
  await responderConn.receive();
  await responderConn.send({
    linkageTerms: terms,
    decision: "abort",
    protocolVersion: PROTOCOL_VERSION,
    abortReasons: ["the operator declined the terms"],
  });
  return (await initiator.catch((error: unknown) => error)) as Error;
}

/** Each refusal as it reaches a surface: bare from the PSI engine, behind the
 * transport wrap the message bridge adds, and from the terms exchange. */
async function refusals(): Promise<Array<[string, Error]>> {
  const setup = new ProtocolRefusalError(SETUP_REFUSAL_MESSAGE);
  return [
    ["a PSI setup", setup],
    [
      "a wrapped PSI setup",
      new ConnectionError("receive failed", "transport", { cause: setup }),
    ],
    ["a terms message", await termsMessageRefusal()],
  ];
}

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

const stamped: ManagedExchangeLastRun = {
  at: RUN_AT,
  outcome: "failed",
  failureKind: "partner-protocol-refusal",
};

const ONE_SHOT_MESSAGE =
  "The exchange stopped because your partner's data did not follow the " +
  "exchange protocol. Running it again stops the same way until your " +
  "partner's run changes. Ask your partner to check that they run a current " +
  "version of Alcove.";

const MANAGED_MESSAGE =
  "The last run stopped because your partner's data did not follow the " +
  "exchange protocol. Running it again stops the same way until your " +
  "partner's run changes. Ask your partner to check that they run a current " +
  "version of Alcove.";

describe("a one-shot exchange that refused its partner's data", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert states the refusal and its step, with no retry",
    async (seat) => {
      for (const [, refusal] of await refusals()) {
        const failure = failureFor(
          "exchange",
          refusal,
          undefined,
          "browser",
          seat,
        );
        expect(failure).toMatchObject({
          category: "config",
          title: PARTNER_PROTOCOL_REFUSAL_TITLE,
          message: ONE_SHOT_MESSAGE,
          settingsCannotResolve: true,
          retry: "withheld",
        });
        expect(failure.message).not.toMatch(/try again/i);
      }
    },
  );

  test("shows what was refused under the label", () => {
    const failure = failureFor(
      "exchange",
      new ProtocolRefusalError(SETUP_REFUSAL_MESSAGE),
    );
    expect(failure.reportedCause).toBe(SETUP_REFUSAL_MESSAGE);
  });

  test("the partner's own abort at the terms exchange keeps the retryable alert", async () => {
    const failure = failureFor("exchange", await partnerTermsAbort());
    expect(failure.category).toBe("exchange");
    expect(failure.retry).toBe("offered");
    expect(failure.title).not.toBe(PARTNER_PROTOCOL_REFUSAL_TITLE);
  });
});

describe("a managed exchange that refused its partner's data", () => {
  test("records the refusal as its own kind, whatever the phase", async () => {
    for (const [, refusal] of await refusals())
      for (const dataExchangeStarted of [false, true]) {
        const lastRun = rerunFailureLastRun(
          refusal,
          Date.parse(RUN_AT),
          false,
          dataExchangeStarted,
        );
        expect(lastRun).toEqual(stamped);
        expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
        expect(benignRerunOutcome(refusal, dataExchangeStarted)).toBe(
          "partner-protocol-refusal",
        );
      }
  });

  test("the partner's own abort at the terms exchange keeps the transport kind", async () => {
    const abort = await partnerTermsAbort();
    expect(rerunFailureLastRun(abort, Date.parse(RUN_AT), false, true)).toEqual(
      { at: RUN_AT, outcome: "failed", failureKind: "transport" },
    );
    expect(benignRerunOutcome(abort, true)).toBeUndefined();
  });

  test("a live launch and the next visit state the refusal and its step, with no retry", () => {
    const refusal = new ProtocolRefusalError(SETUP_REFUSAL_MESSAGE);
    const live = classifyManagedRunFailure(
      refusal,
      { atLaunch: record(), afterRun: record({ lastRun: stamped }) },
      undefined,
      NOW,
      true,
    );
    const recorded = managedRunFailureFromRecord(
      record({ lastRun: stamped }),
      undefined,
      NOW,
    );
    for (const failure of [live, recorded]) {
      if (failure === undefined || failure.kind === "handed-off")
        throw new Error("expected the partner-protocol-refusal alert");
      expect(failure.kind).toBe("partner-protocol-refusal");
      expect(failure.title).toBe(PARTNER_PROTOCOL_REFUSAL_TITLE);
      expect(failure.message).toBe(MANAGED_MESSAGE);
      expect(managedRunRetryable(failure)).toBe(false);
    }
    expect(live.kind !== "handed-off" && live.reportedCause).toBe(
      SETUP_REFUSAL_MESSAGE,
    );
    expect(
      recorded !== undefined &&
        recorded.kind !== "handed-off" &&
        recorded.reportedCause,
    ).toBeUndefined();
  });

  test("an unattended run's notification, list row, and history name the state", () => {
    const stored = record({ lastRun: stamped });
    expect(deriveManagedFailureTier(stored, undefined, NOW)).toBe(
      "partner-protocol-refusal",
    );
    const notice = betweenVisitNotice({
      record: stored,
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("partner-protocol-refusal");
    expect(notice?.title).toBe(PARTNER_PROTOCOL_REFUSAL_TITLE);
    expect(notice?.body).toContain("every later window stops the same way");
    expect(notice?.body.endsWith(PARTNER_PROTOCOL_REFUSAL_REMEDY)).toBe(true);
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run stopped: your partner's data did not follow the exchange protocol \(.*\); ask your partner to check their version of Alcove$/,
    );
    const [entry] = runHistoryEntries({ lastRun: stamped });
    expect(entry.failure).toBe(
      "your partner's data did not follow the exchange protocol",
    );
    // Refused at any point after the handshake, so whether data reached the
    // partner is not ruled out.
    expect(entry.disclosure).not.toMatch(/^Nothing was disclosed/);
    expect(lastRunMayHaveSentPayload({ lastRun: stamped })).toBe(true);
  });

  test("a record an earlier build stamped for the same refusal still loads", () => {
    // The shape an earlier build wrote: the refusal recorded as a connection
    // failure, with no kind of its own. It reads unchanged and keeps the
    // connection state it showed before.
    const earlier = JSON.parse(
      JSON.stringify(
        record({
          schemaVersion: "alcove-managed-exchange/v4",
          lastRun: { at: RUN_AT, outcome: "failed", failureKind: "transport" },
        }),
      ),
    ) as unknown;
    const loaded = parseManagedExchangeRecord(earlier);
    expect(loaded.lastRun).toEqual({
      at: RUN_AT,
      outcome: "failed",
      failureKind: "transport",
    });
    expect(managedRunFailureFromRecord(loaded, undefined, NOW)?.kind).toBe(
      "transport",
    );
  });
});
