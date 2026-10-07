import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_PSI_DECODE_ELEMENTS } from "../src/connection/frameSize";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  PeerAbortError,
  RoundCapacityError,
  RoundSetLimitError,
  UsageError,
} from "../src/errors";
import {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  partnerRoundValues,
  runExchange,
} from "../src/exchange";
import { roundOneSetOverPartnerCeilingMessage } from "../src/exchange/firstRoundCapacity";
import {
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
import type { PreparedExchange, RunExchangeOptions } from "../src/exchange";
import { prepared } from "./utils/support";

// The checks a party makes once the terms are exchanged and before any PSI set
// moves: its own capacity against the partner's round (docs/spec/FILE_SYNC.md,
// "The partner's round"), and its own first round against the receive ceiling
// the partner stated (docs/spec/PROTOCOL.md, "The receive ceiling").

const psiLibrary = await PSI();

// Under a swapped key the PSI receiver assembles both orders of the pair and
// the sender the authored order alone (docs/notes/one-sided-fuzzy-expansion.md).
const swappedKey = {
  name: "FN + LN",
  elements: [{ field: "firstName" }, { field: "lastName" }],
  swap: ["firstName", "lastName"] as [string, string],
};

function preparedRows(
  identity: string,
  rowCount: number,
  linkageStrategy: LinkageStrategy = "cascade",
  swapped = false,
  sharedRows = 0,
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
        linkageStrategy,
        linkageFields: [
          { name: "firstName", type: "first_name" },
          { name: "lastName", type: "last_name" },
        ],
        ...(swapped ? { linkageKeys: [swappedKey] } : {}),
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
  swapped?: boolean;
  options?: Partial<RunExchangeOptions>;
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
        params.swapped,
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
        params.swapped,
        params.partnerSharedRows,
      ),
      { psiLibrary },
    ),
  ]);
  return { local: outcomes[0], partner: outcomes[1], sent, partnerSent };
}

test("the partner's round is its record count times the widest key's declared width", () => {
  const keys = {
    linkageKeys: [{ name: "a", elements: [{ field: "a" }] }, swappedKey],
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

  test("a swapped key whose elements both declare split_on, 10 rows of 30 by 15 tokens", () => {
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
      30,
      15,
      10,
    );
    expect(sender).toBe(4_500);
    expect(weighed).toBe(8_000);
    expect(sender).toBeLessThanOrEqual(weighed);
    expect(receiver).toBeLessThanOrEqual(weighed);
  });

  test("a swapped key whose fields the partner's own cleaning splits, 10 rows of 6 by 6 tokens", () => {
    const key: LinkageKey = {
      name: "FN + LN",
      elements: [{ field: "firstName" }, { field: "lastName" }],
      swap: ["firstName", "lastName"],
    };
    const { sender, receiver, weighed } = realizedAndWeighed(
      key,
      split,
      6,
      6,
      10,
    );
    expect(sender).toBe(360);
    expect(weighed).toBe(400);
    expect(sender).toBeLessThanOrEqual(weighed);
    expect(receiver).toBeLessThanOrEqual(weighed);
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
    partnerRoundValues(MAX_PSI_DECODE_ELEMENTS, { linkageKeys: [swappedKey] }),
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
  expect((refusal as RoundSetLimitError).alcoveRecoveryHintEmitted).toBe(true);
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

test("a single-pass exchange is left to its dataset ceiling", async () => {
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 1,
    strategy: "single-pass",
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a sender partner is weighed at the declared width", async () => {
  // The partner has more records, so it resolves to the PSI sender.
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 24,
    swapped: true,
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([24]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a receiver partner counts its first round in both orders of a swapped key", async () => {
  // The partner has fewer records, so it resolves to the PSI receiver, which
  // assembles both orders of the pair: 5 records send 10 values.
  const { partner } = await runPair({
    localRows: 12,
    partnerRows: 5,
    ceiling: 9,
    swapped: true,
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
