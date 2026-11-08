import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
  singlePassReplyByteCap,
  singlePassRequestByteCap,
} from "../src/connection/frameSize";
import { sendAbort, sendLocalFaultAbort } from "../src/protocolSetup";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundPsiFramePeakBytes,
} from "../src/connection/inboundFrameMemory";
import { InProcessPsiEngine } from "../src/psi/psiEngine";
import { psiSetPartPayloadBytes } from "../src/psi/psiSetParts";
import {
  PeerAbortError,
  RoundCapacityError,
  RoundSetLimitError,
  UsageError,
  statesItsOwnNextStep,
} from "../src/errors";
import {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  partnerRoundValues,
  runExchange,
} from "../src/exchange";
import {
  assertFirstRoundWithinSetMaximum,
  roundOneSetOverMaximumAfterTermsMessage,
  roundOneSetOverPartnerCeilingMessage,
} from "../src/exchange/firstRoundCapacity";
import {
  LOCAL_FAULT_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
} from "../src/partnerAbortFrame";

import {
  buildKeyStrings,
  localFanOutFactor,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { CSVRow } from "../src/file";
import type {
  LinkageKey,
  LinkageStrategy,
} from "../src/config/linkageTermsSchema";
import type {
  PreparedExchange,
  RunExchangeOptions,
  SinglePassPartnerSize,
} from "../src/exchange";
import type { Algorithm } from "../src/types";
import { prepared } from "./utils/support";

// The checks a party makes once the terms are exchanged and before any PSI set
// moves: its own capacity against the partner's round (docs/spec/FILE_SYNC.md,
// "The partner's round"), and its own first round against the receive ceiling
// the partner stated (docs/spec/PROTOCOL.md, "The receive ceiling").

// The per-set maximum, lowered for one describe block so a handful of
// records reaches it; every other test runs at the real maximum.
const setMaximum = vi.hoisted(() => ({
  lowered: undefined as number | undefined,
}));
vi.mock("../src/connection/frameSize", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/connection/frameSize")>();
  return {
    ...actual,
    get MAX_PSI_DECODE_ELEMENTS() {
      return setMaximum.lowered ?? actual.MAX_PSI_DECODE_ELEMENTS;
    },
  };
});
afterEach(() => {
  setMaximum.lowered = undefined;
});

const psiLibrary = await PSI();

// A key of width 2 on the PSI receiver and 1 on the sender: the receiver alone
// builds the one transposition of a two-character slice of the last name
// (docs/notes/one-sided-fuzzy-expansion.md). Every row below gives that slice
// two different characters, so the receiver realizes both.
const receiverWidensKey = {
  name: "LN slice + FN",
  elements: [
    {
      field: "lastName",
      transform: [{ function: "substring", params: { start: 3, length: 2 } }],
      generateFuzzyComparisons: "transpositions" as const,
    },
    { field: "firstName" },
  ],
};

function preparedRows(
  identity: string,
  rowCount: number,
  linkageStrategy: LinkageStrategy = "cascade",
  widened = false,
  sharedRows = 0,
  algorithm: Algorithm = "psi",
): PreparedExchange {
  // The last `sharedRows` rows repeat the ones before them, so the round
  // drops each such value and sends `rowCount - 2 * sharedRows`.
  const name = (row: number) => {
    const i = row < rowCount - sharedRows ? row : row - sharedRows;
    return `zq${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`;
  };
  return prepared(
    identity,
    Array.from({ length: rowCount }, (_unused, i) => ({
      first_name: name(i),
      last_name: `${name(i)}x`,
    })),
    {
      terms: {
        algorithm,
        linkageStrategy,
        linkageFields: [
          { name: "firstName", type: "first_name" },
          { name: "lastName", type: "last_name" },
        ],
        ...(widened ? { linkageKeys: [receiverWidensKey] } : {}),
      },
      columns: ["first_name", "last_name"],
    },
  );
}

// `conn` stating `ceiling` as its receive ceiling, as the browser's connection
// does, and recording every frame this party sends.
function withCeiling(
  conn: MessageConnection,
  ceiling: number | undefined,
  sent: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    inboundPsiSetElementCeiling: () => ceiling,
  };
}

const binaryFrames = (frames: Array<unknown>): Array<unknown> =>
  frames.filter((frame) => frame instanceof Uint8Array);

async function runPair(params: {
  localRows: number;
  partnerRows: number;
  partnerSharedRows?: number;
  ceiling?: number;
  strategy?: LinkageStrategy;
  widened?: boolean;
  options?: Partial<RunExchangeOptions>;
  /** Both parties' algorithm. */
  algorithm?: Algorithm;
}) {
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const partnerSent: Array<unknown> = [];
  const outcomes = await Promise.allSettled([
    runExchange(
      withCeiling(local, params.ceiling, sent),
      "initiator",
      preparedRows(
        "Local Co",
        params.localRows,
        params.strategy,
        params.widened,
        0,
        params.algorithm,
      ),
      { psiLibrary, ...params.options },
    ),
    runExchange(
      withCeiling(partner, undefined, partnerSent),
      "responder",
      preparedRows(
        "Partner Co",
        params.partnerRows,
        params.strategy,
        params.widened,
        params.partnerSharedRows,
        params.algorithm,
      ),
      { psiLibrary },
    ),
  ]);
  return { local: outcomes[0], partner: outcomes[1], sent, partnerSent };
}

test("the partner's round is its record count times the widest key's declared width", () => {
  const keys = {
    linkageKeys: [{ name: "a", elements: [{ field: "a" }] }, receiverWidensKey],
  };
  expect(partnerRoundValues(1_000, keys)).toBe(2_000);
  expect(
    partnerRoundValues(1_000, { linkageKeys: [keys.linkageKeys[0]] }),
  ).toBe(1_000);
});

describe("the partner's round is not under what a partner's key read realizes", () => {
  const split = [{ function: "split_on", params: { delimiter: " " } }];
  const tokens = (prefix: string, count: number): string =>
    Array.from({ length: count }, (_unused, i) => `${prefix}t${i}`).join(" ");

  // Realizes `key` over `rows` rows of a first name of `firstTokens` tokens and
  // a last name of `lastTokens`, cleaned by `localSteps`, in each PSI role,
  // against the partner's round for the count those rows declare.
  function realizedAndWeighed(
    key: LinkageKey,
    localSteps: Array<{ function: string; params: { delimiter: string } }>,
    firstTokens: number,
    lastTokens: number,
    rows: number,
  ) {
    const raw = Array.from({ length: rows }, (_unused, r) => ({
      first_name: tokens(`f${r}`, firstTokens),
      last_name: tokens(`l${r}`, lastTokens),
    }));
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("firstName", "first_name", localSteps, raw),
        new StandardizedField("lastName", "last_name", localSteps, raw),
      ],
      [key],
    );
    const realized = (isReceiver: boolean): number => {
      let total = 0;
      for (let row = 0; row < rows; row++)
        total += buildKeyStrings(key, dataset, row, isReceiver)?.size ?? 0;
      return total;
    };
    return {
      sender: realized(false),
      receiver: realized(true),
      weighed: partnerRoundValues(
        rows * localFanOutFactor(dataset.declaresFanOut),
        { linkageKeys: [key] },
      ),
    };
  }

  // A swap adds no value slot, so each role realizes the same count, up to
  // the width the elements alone declare.
  test("a swapped key whose elements both declare split_on, 10 rows of 20 by 20 tokens", () => {
    const key: LinkageKey = {
      name: "FN + LN",
      elements: [
        { field: "firstName", transform: split },
        { field: "lastName", transform: split },
      ],
      swap: ["firstName", "lastName"],
    };
    const { sender, receiver, weighed } = realizedAndWeighed(
      key,
      [],
      20,
      20,
      10,
    );
    expect(sender).toBe(4_000);
    expect(receiver).toBe(sender);
    expect(weighed).toBe(4_000);
  });

  test("a swapped key whose fields the partner's own cleaning splits, 10 rows of 4 by 5 tokens", () => {
    const key: LinkageKey = {
      name: "FN + LN",
      elements: [{ field: "firstName" }, { field: "lastName" }],
      swap: ["firstName", "lastName"],
    };
    const { sender, receiver, weighed } = realizedAndWeighed(
      key,
      split,
      4,
      5,
      10,
    );
    expect(sender).toBe(200);
    expect(receiver).toBe(sender);
    expect(weighed).toBe(200);
  });
});

test("the partner's round is held to the per-set maximum no sender exceeds", () => {
  const oneKey = {
    linkageKeys: [{ name: "a", elements: [{ field: "a" }] }],
  };
  expect(partnerRoundValues(MAX_PSI_DECODE_ELEMENTS, oneKey)).toBe(
    MAX_PSI_DECODE_ELEMENTS,
  );
  expect(partnerRoundValues(MAX_PSI_DECODE_ELEMENTS + 1, oneKey)).toBe(
    MAX_PSI_DECODE_ELEMENTS,
  );
  expect(
    partnerRoundValues(MAX_PSI_DECODE_ELEMENTS, {
      linkageKeys: [receiverWidensKey],
    }),
  ).toBe(MAX_PSI_DECODE_ELEMENTS);
});

test("a sender partner over this party's stated ceiling refuses its first round before either party sends a set", async () => {
  const { local, partner, sent, partnerSent } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 11,
  });
  expect(partner.status).toBe("rejected");
  const refusal = (partner as PromiseRejectedResult).reason as Error;
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("over-partner-ceiling");
  expect(statesItsOwnNextStep(refusal, { ownOnly: true })).toBe(true);
  expect(refusal.message).toBe(roundOneSetOverPartnerCeilingMessage(12, 11));
  expect(binaryFrames(partnerSent)).toEqual([]);
  expect(partnerSent.at(-1)).toEqual({
    decision: "abort",
    abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON],
  });
  expect(binaryFrames(sent)).toEqual([]);
  expect(local.status).toBe("rejected");
  const abort = (local as PromiseRejectedResult).reason as PeerAbortError;
  expect(abort).toBeInstanceOf(PeerAbortError);
  expect(abort.partnerReason).toBe(PSI_SET_TOO_LARGE_ABORT_REASON);
});

// `exchange` with every row of its dataset throwing `failure` when read, so the
// first-round count raises it.
function withThrowingRows(
  exchange: PreparedExchange,
  failure: Error,
): PreparedExchange {
  const rows = new Proxy<Array<CSVRow>>([], {
    get: (target, prop, receiver) => {
      if (prop === "length") return exchange.rowCount;
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) throw failure;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return {
    ...exchange,
    dataset: new StandardizedDataset(
      [
        new StandardizedField("firstName", "first_name", [], rows),
        new StandardizedField("lastName", "last_name", [], rows),
      ],
      exchange.linkageTerms.linkageKeys,
    ),
  };
}

test("a first round refused for other than its size sends the partner a fixed abort and throws the refusal", async () => {
  const refusal = new UsageError("a refusal the round would raise");
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const partnerSent: Array<unknown> = [];
  const [localOutcome, partnerOutcome] = await Promise.allSettled([
    runExchange(
      withCeiling(local, 11, sent),
      "initiator",
      preparedRows("Local Co", 5),
      { psiLibrary },
    ),
    runExchange(
      withCeiling(partner, undefined, partnerSent),
      "responder",
      withThrowingRows(preparedRows("Partner Co", 12), refusal),
      { psiLibrary },
    ),
  ]);
  expect(partnerOutcome.status).toBe("rejected");
  expect((partnerOutcome as PromiseRejectedResult).reason).toBe(refusal);
  expect(binaryFrames(partnerSent)).toEqual([]);
  expect(partnerSent.at(-1)).toEqual({
    decision: "abort",
    abortReasons: [PSI_SET_REFUSED_ABORT_REASON],
  });
  expect(localOutcome.status).toBe("rejected");
  const abort = (localOutcome as PromiseRejectedResult)
    .reason as PeerAbortError;
  expect(abort).toBeInstanceOf(PeerAbortError);
  expect(abort.partnerReason).toBe(PSI_SET_REFUSED_ABORT_REASON);
});

test("a first round this party could not count sends the partner the refused abort, not the too-large one", async () => {
  const failure = new Error("a row could not be read");
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const partnerSent: Array<unknown> = [];
  const [localOutcome, partnerOutcome] = await Promise.allSettled([
    runExchange(
      withCeiling(local, 11, sent),
      "initiator",
      preparedRows("Local Co", 5),
      { psiLibrary },
    ),
    runExchange(
      withCeiling(partner, undefined, partnerSent),
      "responder",
      withThrowingRows(preparedRows("Partner Co", 12), failure),
      { psiLibrary },
    ),
  ]);
  expect(partnerOutcome.status).toBe("rejected");
  const refusal = (partnerOutcome as PromiseRejectedResult).reason as Error;
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("uncounted");
  expect(binaryFrames(partnerSent)).toEqual([]);
  expect(partnerSent.at(-1)).toEqual({
    decision: "abort",
    abortReasons: [PSI_SET_REFUSED_ABORT_REASON],
  });
  expect(localOutcome.status).toBe("rejected");
  const abort = (localOutcome as PromiseRejectedResult)
    .reason as PeerAbortError;
  expect(abort).toBeInstanceOf(PeerAbortError);
  expect(abort.partnerReason).toBe(PSI_SET_REFUSED_ABORT_REASON);
});

test("a receiver partner over this party's stated ceiling refuses its first round after this party sent its setup", async () => {
  // The partner has fewer records, so it resolves to the PSI receiver; this
  // party, the sender, sends its setup without waiting on the partner's check.
  const { local, partner, sent, partnerSent } = await runPair({
    localRows: 12,
    partnerRows: 5,
    ceiling: 4,
  });
  expect((partner as PromiseRejectedResult).reason).toBeInstanceOf(
    RoundSetLimitError,
  );
  expect(binaryFrames(partnerSent)).toEqual([]);
  expect(binaryFrames(sent)).toHaveLength(1);
  const abort = (local as PromiseRejectedResult).reason as PeerAbortError;
  expect(abort).toBeInstanceOf(PeerAbortError);
  expect(abort.partnerReason).toBe(PSI_SET_TOO_LARGE_ABORT_REASON);
});

test("a partner first round at this party's stated ceiling runs to completion", async () => {
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 12,
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a partner whose records exceed this party's ceiling but whose first round is within it runs to completion", async () => {
  // 12 records, 4 of them repeating others: the round sends the 4 values only
  // one record holds and drops the shared ones.
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    partnerSharedRows: 4,
    ceiling: 4,
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("the caller's capacity check is handed the partner's round, and its throw aborts the run", async () => {
  const seen: Array<number> = [];
  const failure = new RoundCapacityError(
    "not enough memory for that round",
    "terms-exchange",
  );
  const { local, partner, sent } = await runPair({
    localRows: 5,
    partnerRows: 12,
    options: {
      checkPartnerRoundCapacity: (values) => {
        seen.push(values);
        throw failure;
      },
    },
  });
  expect(seen).toEqual([12]);
  expect((local as PromiseRejectedResult).reason).toBe(failure);
  expect(binaryFrames(sent)).toEqual([]);
  expect(sent.at(-1)).toEqual({
    decision: "abort",
    abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
  });
  expect((partner as PromiseRejectedResult).reason).toBeInstanceOf(
    PeerAbortError,
  );
});

test("a capacity check that passes leaves the run as it was", async () => {
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([12]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a single-pass exchange is left to its value-slot ceiling, not weighed as a round", async () => {
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 12,
    strategy: "single-pass",
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a single-pass exchange over the value-slot ceiling gets the ceiling refusal ahead of a failing memory check", async () => {
  const check = vi.fn(() => {
    throw new RoundCapacityError("cannot fit", "terms-exchange");
  });
  const { local, partner, sent, partnerSent } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 10,
    strategy: "single-pass",
    options: { checkSinglePassPartnerSize: check },
  });
  expect(check).not.toHaveBeenCalled();
  for (const outcome of [local, partner]) {
    const reason = (outcome as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(UsageError);
    expect(String(reason)).toMatch(/too large for single-pass linkage/);
  }
  expect(String((local as PromiseRejectedResult).reason)).toContain(
    "single-pass limit of 10 value slot(s) per party",
  );
  expect(binaryFrames(sent)).toEqual([]);
  expect(binaryFrames(partnerSent)).toEqual([]);
});

test("a sender partner is weighed at the declared width", async () => {
  // The partner has more records, so it resolves to the PSI sender.
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 24,
    widened: true,
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([24]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a receiver partner counts its first round at the width it realizes", async () => {
  // The partner has fewer records, so it resolves to the PSI receiver, which
  // builds two values per record: 5 records send 10 values.
  const { partner } = await runPair({
    localRows: 12,
    partnerRows: 5,
    ceiling: 9,
    widened: true,
  });
  expect(partner.status).toBe("rejected");
  expect(((partner as PromiseRejectedResult).reason as Error).message).toBe(
    roundOneSetOverPartnerCeilingMessage(10, 9),
  );
});

test("a failure of the capacity check other than a capacity refusal propagates and sends no abort", async () => {
  const failure = new Error("the memory figures could not be read");
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const partnerRun = runExchange(
    partner,
    "responder",
    preparedRows("Partner Co", 12),
    { psiLibrary },
  );
  const localOutcome = await runExchange(
    withCeiling(local, undefined, sent),
    "initiator",
    preparedRows("Local Co", 5),
    {
      psiLibrary,
      checkPartnerRoundCapacity: () => {
        throw failure;
      },
    },
  ).catch((err: unknown) => err);
  local.close();
  await partnerRun.catch(() => undefined);
  expect(localOutcome).toBe(failure);
  expect(sent).not.toContainEqual(
    expect.objectContaining({ decision: "abort" }),
  );
});

describe("single-pass over file-sync, at the terms exchange", () => {
  const fileSync = (conn: MessageConnection): MessageConnection =>
    Object.assign(conn, {
      outboundFileSyncFrameBound: () => MAX_FRAME_SIZE_BYTES,
    });

  async function runSinglePass(
    localFileSync: boolean,
    check: RunExchangeOptions["checkSinglePassPartnerSize"],
    strategy: LinkageStrategy = "single-pass",
    [localRows, partnerRows] = [5, 12],
    localOptions: Partial<RunExchangeOptions> = {},
  ) {
    const [local, partner] = createMessagePipe();
    const sent: Array<unknown> = [];
    const wrap = (conn: MessageConnection, frames: Array<unknown>) => {
      const wrapped = withCeiling(conn, undefined, frames);
      return localFileSync ? fileSync(wrapped) : wrapped;
    };
    const outcomes = await Promise.allSettled([
      runExchange(
        wrap(local, sent),
        "initiator",
        preparedRows("Local Co", localRows, strategy),
        {
          psiLibrary,
          checkSinglePassPartnerSize: check,
          ...localOptions,
        },
      ),
      runExchange(
        wrap(partner, []),
        "responder",
        preparedRows("Partner Co", partnerRows, strategy),
        {
          psiLibrary,
        },
      ),
    ]);
    return { local: outcomes[0], partner: outcomes[1], sent };
  }

  test("the check is handed the declared sizes, and a run it passes proceeds", async () => {
    const seen: Array<SinglePassPartnerSize> = [];
    const { local, partner } = await runSinglePass(true, (size) => {
      seen.push(size);
    });
    expect(local.status).toBe("fulfilled");
    expect(partner.status).toBe("fulfilled");
    // The larger party sends, so this party receives and is handed its table
    // and the reply's bound.
    const sender = { effectiveKeyCount: 1, recordCount: 12 };
    const receiver = { effectiveKeyCount: 1, recordCount: 5 };
    expect(seen).toEqual([
      {
        partnerValueSlots: 12,
        localValueSlots: 5,
        partnerRecordCount: 12,
        irreducibleReplyBytes: 48,
        inboundFrameBytes: singlePassReplyByteCap(
          1,
          sender,
          receiver,
          singlePassRequestByteCap(receiver),
        ),
        inboundFrameUse: "stream",
      },
    ]);
  });

  test("a sending party is handed the bound of the request it decodes", async () => {
    const seen: Array<SinglePassPartnerSize> = [];
    const { local } = await runSinglePass(
      true,
      (size) => {
        seen.push(size);
      },
      "single-pass",
      [12, 5],
    );
    expect(local.status).toBe("fulfilled");
    expect(seen).toEqual([
      {
        partnerValueSlots: 5,
        localValueSlots: 12,
        partnerRecordCount: 5,
        irreducibleReplyBytes: 0,
        inboundFrameBytes: singlePassRequestByteCap({
          effectiveKeyCount: 1,
          recordCount: 5,
        }),
        inboundFrameUse: "decode",
      },
    ]);
  });

  describe("a sending party weighs the request with its masking", () => {
    const requestBytes = singlePassRequestByteCap({
      effectiveKeyCount: 1,
      recordCount: 5,
    });
    const needBytes =
      requestBytes +
      requestBytes * INBOUND_FRAME_MEMORY_MULTIPLES.handedOverRequest;

    // A check refusing what `availableBytes` cannot hold, at core's charge
    // for the frame, and an engine factory that records what the run asked of
    // the engine.
    async function sendAgainst(availableBytes: number) {
      const calls: Array<string> = [];
      const psiEngineFactory: RunExchangeOptions["psiEngineFactory"] = (
        role,
        id,
        mode,
      ) => {
        calls.push("factory");
        const engine = new InProcessPsiEngine(psiLibrary, role, id, mode);
        const processClientRequest = engine.processClientRequest.bind(engine);
        engine.processClientRequest = (...args) => {
          calls.push("processClientRequest");
          return processClientRequest(...args);
        };
        return engine;
      };
      const outcome = await runSinglePass(
        true,
        (size) => {
          if (
            inboundPsiFramePeakBytes(
              size.inboundFrameBytes,
              size.inboundFrameUse,
              false,
              undefined,
            ) > availableBytes
          )
            throw new RoundCapacityError("cannot fit", "terms-exchange");
        },
        "single-pass",
        [12, 5],
        { psiEngineFactory },
      );
      return { ...outcome, calls };
    }

    test("a request whose masking fits proceeds to the engine", async () => {
      expect(needBytes).toBeGreaterThan(
        requestBytes * (1 + INBOUND_FRAME_MEMORY_MULTIPLES.psiDecode),
      );
      const { local, calls } = await sendAgainst(needBytes);
      expect(local.status).toBe("fulfilled");
      expect(calls).toContain("processClientRequest");
    });

    test("a request whose masking does not fit is refused before the engine is called", async () => {
      const { local, sent, calls } = await sendAgainst(needBytes - 1);
      expect((local as PromiseRejectedResult).reason).toBeInstanceOf(
        RoundCapacityError,
      );
      expect(calls).toEqual([]);
      expect(binaryFrames(sent)).toEqual([]);
      expect(sent.at(-1)).toEqual({
        decision: "abort",
        abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
      });
    });
  });

  test("a capacity refusal stops the run before any set moves and tells the partner", async () => {
    const failure = new RoundCapacityError("cannot fit", "terms-exchange");
    const { local, partner, sent } = await runSinglePass(true, () => {
      throw failure;
    });
    expect((local as PromiseRejectedResult).reason).toBe(failure);
    expect(binaryFrames(sent)).toEqual([]);
    expect(sent.at(-1)).toEqual({
      decision: "abort",
      abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
    });
    expect((partner as PromiseRejectedResult).reason).toBeInstanceOf(
      PeerAbortError,
    );
  });

  test("a connection stating no file-sync bound is checked too, with the part size and the message this party sends", async () => {
    const seen: Array<SinglePassPartnerSize> = [];
    const { local } = await runSinglePass(false, (size) => {
      seen.push(size);
    });
    expect(local.status).toBe("fulfilled");
    const sender = { effectiveKeyCount: 1, recordCount: 12 };
    const receiver = { effectiveKeyCount: 1, recordCount: 5 };
    const [conn] = createMessagePipe();
    expect(seen).toEqual([
      {
        partnerValueSlots: 12,
        localValueSlots: 5,
        partnerRecordCount: 12,
        irreducibleReplyBytes: 48,
        inboundFrameBytes: singlePassReplyByteCap(
          1,
          sender,
          receiver,
          singlePassRequestByteCap(receiver),
        ),
        inboundFrameUse: "stream",
        webRtc: {
          partBytes: psiSetPartPayloadBytes(conn),
          outboundFrameBytes: singlePassRequestByteCap(receiver),
          inboundInParts: false,
        },
      },
    ]);
  });

  test("a capacity refusal over WebRTC stops the run before any set moves and tells the partner", async () => {
    const failure = new RoundCapacityError("cannot fit", "terms-exchange");
    const { local, partner, sent } = await runSinglePass(false, () => {
      throw failure;
    });
    expect((local as PromiseRejectedResult).reason).toBe(failure);
    expect(binaryFrames(sent)).toEqual([]);
    expect(sent.at(-1)).toEqual({
      decision: "abort",
      abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
    });
    expect((partner as PromiseRejectedResult).reason).toBeInstanceOf(
      PeerAbortError,
    );
  });

  test("a cascade over file-sync is not checked here", async () => {
    const check = vi.fn();
    await runSinglePass(true, check, "cascade");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("a single-pass party's own distinct values", () => {
  async function runWithOwnValuesCheck(
    check: RunExchangeOptions["checkSinglePassOwnValues"],
  ) {
    const [local, partner] = createMessagePipe();
    const sent: Array<unknown> = [];
    const partnerRun = runExchange(
      partner,
      "responder",
      preparedRows("Partner Co", 12, "single-pass"),
      { psiLibrary },
    );
    const [localOutcome] = await Promise.allSettled([
      runExchange(
        withCeiling(local, undefined, sent),
        "initiator",
        preparedRows("Local Co", 5, "single-pass"),
        { psiLibrary, checkSinglePassOwnValues: check },
      ),
    ]);
    // A refusing party's front end tells the partner; here the pipe closes.
    await local.close();
    await partnerRun.catch(() => undefined);
    return { local: localOutcome, sent };
  }

  test("are counted to the check before any is masked", async () => {
    const counts: Array<number> = [];
    const { local } = await runWithOwnValuesCheck((count) => {
      counts.push(count);
    });
    expect(local.status).toBe("fulfilled");
    expect(counts).toEqual([5]);
  });

  test("a refusal there stops the run before this party sends a frame", async () => {
    const refusal = new Error("not enough heap");
    const { local, sent } = await runWithOwnValuesCheck(() => {
      throw refusal;
    });
    expect((local as PromiseRejectedResult).reason).toBe(refusal);
    expect(binaryFrames(sent)).toEqual([]);
  });
});

describe("the abort frame a local fault sends", () => {
  const FAULT_WAIT_MS = 5_000;

  test("the partner reads it in place of the frame it awaits", async () => {
    const [local, partner] = createMessagePipe();
    await sendLocalFaultAbort(local, FAULT_WAIT_MS);
    expect(await partner.receive()).toEqual({
      decision: "abort",
      abortReasons: [LOCAL_FAULT_ABORT_REASON],
    });
  });

  test("a run's own refusal already told the partner, so a second is not sent", async () => {
    const [local] = createMessagePipe();
    const sent: Array<unknown> = [];
    const conn = withCeiling(local, undefined, sent);
    await sendAbort(conn, [PARTNER_SET_OVER_CAPACITY_ABORT_REASON]);
    await sendLocalFaultAbort(conn, FAULT_WAIT_MS);
    expect(sent).toHaveLength(1);
  });

  test("a write that cannot finish does not hold up the run's end", async () => {
    const conn: MessageConnection = {
      send: () => new Promise<void>(() => {}),
      receive: () => new Promise<never>(() => {}),
      close: async () => {},
    };
    await expect(sendLocalFaultAbort(conn, 1)).resolves.toBeUndefined();
  });
});

describe("in a count-only exchange", () => {
  // Every round's set holds one value per record (docs/spec/PROTOCOL.md,
  // PSI-C), so a party is weighed at its record count however many of its
  // records share a value.
  const countOnly = { algorithm: "psi-c" as const };

  test("the partner's round is its record count", () => {
    const terms = preparedRows("Partner Co", 12, "cascade", false, 4, "psi-c");
    expect(partnerRoundValues(12, terms.linkageTerms)).toBe(12);
  });

  test("a sender partner over this party's ceiling is refused for its record count, before either party sends a set", async () => {
    // 12 records, 8 of them sharing 4 values: a cascade round would send the
    // 4 values only one record holds, a count-only round 12.
    const { local, partner, sent, partnerSent } = await runPair({
      localRows: 5,
      partnerRows: 12,
      partnerSharedRows: 4,
      ceiling: 11,
      ...countOnly,
    });
    const refusal = (partner as PromiseRejectedResult).reason as Error;
    expect(refusal).toBeInstanceOf(RoundSetLimitError);
    expect((refusal as RoundSetLimitError).reason).toBe("over-partner-ceiling");
    expect(statesItsOwnNextStep(refusal, { ownOnly: true })).toBe(true);
    expect(refusal.message).toBe(
      roundOneSetOverPartnerCeilingMessage(12, 11, "every-key"),
    );
    expect(refusal.message).toMatch(
      /^Too large for your partner: a count-only exchange sends 12 values for every linkage key, over the 11 your partner can receive in one PSI set,/,
    );
    expect(binaryFrames(partnerSent)).toEqual([]);
    expect(binaryFrames(sent)).toEqual([]);
    expect(partnerSent.at(-1)).toEqual({
      decision: "abort",
      abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON],
    });
    expect(
      ((local as PromiseRejectedResult).reason as PeerAbortError).partnerReason,
    ).toBe(PSI_SET_TOO_LARGE_ABORT_REASON);
  });

  test("a receiver partner over this party's ceiling is refused for its record count", async () => {
    // The partner has fewer records, so it resolves to the PSI receiver.
    const { partner, partnerSent } = await runPair({
      localRows: 12,
      partnerRows: 5,
      partnerSharedRows: 1,
      ceiling: 4,
      ...countOnly,
    });
    expect(((partner as PromiseRejectedResult).reason as Error).message).toBe(
      roundOneSetOverPartnerCeilingMessage(5, 4, "every-key"),
    );
    expect(binaryFrames(partnerSent)).toEqual([]);
  });

  test("a partner at this party's ceiling runs to completion", async () => {
    const { local, partner } = await runPair({
      localRows: 5,
      partnerRows: 12,
      partnerSharedRows: 4,
      ceiling: 12,
      ...countOnly,
    });
    expect(local.status).toBe("fulfilled");
    expect(partner.status).toBe("fulfilled");
  });

  test("the caller's capacity check is handed the partner's record count", async () => {
    const seen: Array<number> = [];
    const { local, partner } = await runPair({
      localRows: 5,
      partnerRows: 12,
      partnerSharedRows: 4,
      ...countOnly,
      options: {
        checkPartnerRoundCapacity: (values) => void seen.push(values),
      },
    });
    expect(seen).toEqual([12]);
    expect(local.status).toBe("fulfilled");
    expect(partner.status).toBe("fulfilled");
  });

  describe("against a partner stating the per-set maximum, with a receiver-widened second key", () => {
    // The second key has width 2 on the receiver and 1 on the sender, so 5
    // records send 10 values as the receiver and 5 as the sender, against a
    // maximum of 6.
    const maximum = 6;
    const preparedTwoKeys = (identity: string, rowCount: number) =>
      prepared(
        identity,
        Array.from({ length: rowCount }, (_unused, i) => ({
          first_name: `zq${String.fromCharCode(97 + i)}`,
          last_name: `zq${String.fromCharCode(97 + i)}x`,
        })),
        {
          terms: {
            algorithm: "psi-c",
            linkageStrategy: "cascade",
            linkageFields: [
              { name: "firstName", type: "first_name" },
              { name: "lastName", type: "last_name" },
            ],
            linkageKeys: [
              { name: "FN", elements: [{ field: "firstName" }] },
              receiverWidensKey,
            ],
          },
          columns: ["first_name", "last_name"],
        },
      );

    async function runTwoKeys(
      localRows: number,
      partnerRows: number,
      partnerCeiling?: number,
    ) {
      setMaximum.lowered = maximum;
      const [local, partner] = createMessagePipe();
      const sent: Array<unknown> = [];
      const localPrepared = preparedTwoKeys("Local Co", localRows);
      const outcomes = await Promise.allSettled([
        runExchange(
          withCeiling(local, undefined, sent),
          "initiator",
          localPrepared,
          {
            psiLibrary,
          },
        ),
        runExchange(
          withCeiling(partner, partnerCeiling, []),
          "responder",
          preparedTwoKeys("Partner Co", partnerRows),
          {
            psiLibrary,
          },
        ),
      ]);
      return { localPrepared, local: outcomes[0], partner: outcomes[1], sent };
    }

    test("a party resolved as the receiver over the maximum is refused before its first round's set is sent", async () => {
      // The partner has more records, so this party resolves to the receiver.
      const { localPrepared, local, partner, sent } = await runTwoKeys(5, 6);
      // Before contact the sender role fits, so the party is not refused.
      await expect(
        assertFirstRoundWithinSetMaximum(localPrepared, { maxValues: maximum }),
      ).resolves.toBeUndefined();
      const refusal = (local as PromiseRejectedResult).reason as Error;
      expect(refusal).toBeInstanceOf(RoundSetLimitError);
      expect((refusal as RoundSetLimitError).reason).toBe("over-set-maximum");
      expect(statesItsOwnNextStep(refusal, { ownOnly: true })).toBe(true);
      expect(refusal.message).toBe(
        roundOneSetOverMaximumAfterTermsMessage(10, maximum, "widest-key"),
      );
      expect(binaryFrames(sent)).toEqual([]);
      expect(sent.at(-1)).toEqual({
        decision: "abort",
        abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON],
      });
      expect(
        ((partner as PromiseRejectedResult).reason as PeerAbortError)
          .partnerReason,
      ).toBe(PSI_SET_TOO_LARGE_ABORT_REASON);
    });

    test("a count over the maximum is refused for the maximum, whatever lower ceiling the partner states", async () => {
      const { local, sent } = await runTwoKeys(5, 6, 4);
      const refusal = (local as PromiseRejectedResult).reason as Error;
      expect(refusal).toBeInstanceOf(RoundSetLimitError);
      expect((refusal as RoundSetLimitError).reason).toBe("over-set-maximum");
      expect(refusal.message).toBe(
        roundOneSetOverMaximumAfterTermsMessage(10, maximum, "widest-key"),
      );
      expect(binaryFrames(sent)).toEqual([]);
    });

    test("the same records resolved as the sender run to completion", async () => {
      // The partner has fewer records, so this party resolves to the sender;
      // the partner's 3 records send 6 values as the receiver.
      const { local, partner } = await runTwoKeys(5, 3);
      expect(local.status).toBe("fulfilled");
      expect(partner.status).toBe("fulfilled");
    });
  });
});
