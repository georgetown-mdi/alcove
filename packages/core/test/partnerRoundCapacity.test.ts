import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_PSI_DECODE_ELEMENTS } from "../src/connection/frameSize";
import { createMessagePipe } from "../src/connection/messageConnection";
import { PeerAbortError, RoundCapacityError } from "../src/errors";
import {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  partnerRoundValues,
  prepareForExchange,
  runExchange,
} from "../src/exchange";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { LinkageStrategy } from "../src/config/linkageTermsSchema";
import type { PreparedExchange, RunExchangeOptions } from "../src/exchange";

// The capacity check a party makes on its partner's round once the terms are
// exchanged and before any PSI set moves (docs/spec/PROTOCOL.md, "What a
// browser tab can match"; docs/spec/FILE_SYNC.md, "The partner's round").

const psiLibrary = await PSI();

// Under a swapped key the PSI receiver assembles both orders of the pair and
// the sender the authored order alone (docs/notes/one-sided-fuzzy-expansion.md).
const swappedKey = {
  name: "FN + LN",
  elements: [{ field: "firstName" }, { field: "lastName" }],
  swap: ["firstName", "lastName"] as [string, string],
};

function prepared(
  identity: string,
  rowCount: number,
  linkageStrategy: LinkageStrategy = "cascade",
  swapped = false,
): PreparedExchange {
  const name = (i: number) =>
    `zq${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`;
  return prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy,
        identity,
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [
          { name: "firstName", type: "first_name" },
          { name: "lastName", type: "last_name" },
        ],
        linkageKeys: swapped
          ? [swappedKey]
          : [{ name: "firstName", elements: [{ field: "firstName" }] }],
      },
    },
    identity,
    Array.from({ length: rowCount }, (_unused, i) => ({
      first_name: name(i),
      last_name: `${name(i)}x`,
    })),
    ["first_name", "last_name"],
  );
}

// `conn` stating `ceiling` as its ceiling on a partner's set, as the browser's
// connection does, and recording every frame this party sends.
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
  ceiling?: number;
  strategy?: LinkageStrategy;
  swapped?: boolean;
  options?: Partial<RunExchangeOptions>;
}) {
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const outcomes = await Promise.allSettled([
    runExchange(
      withCeiling(local, params.ceiling, sent),
      "initiator",
      prepared("Local Co", params.localRows, params.strategy, params.swapped),
      { psiLibrary, ...params.options },
    ),
    runExchange(
      partner,
      "responder",
      prepared(
        "Partner Co",
        params.partnerRows,
        params.strategy,
        params.swapped,
      ),
      { psiLibrary },
    ),
  ]);
  return { local: outcomes[0], partner: outcomes[1], sent };
}

test("the partner's round is its record count times the widest key's width in the partner's role", () => {
  const keys = {
    linkageKeys: [{ name: "a", elements: [{ field: "a" }] }, swappedKey],
  };
  expect(partnerRoundValues(1_000, keys, true)).toBe(2_000);
  expect(partnerRoundValues(1_000, keys, false)).toBe(1_000);
  expect(
    partnerRoundValues(1_000, { linkageKeys: [keys.linkageKeys[0]] }, true),
  ).toBe(1_000);
});

test("the partner's round is held to the per-set maximum no sender exceeds", () => {
  const oneKey = {
    linkageKeys: [{ name: "a", elements: [{ field: "a" }] }],
  };
  expect(partnerRoundValues(MAX_PSI_DECODE_ELEMENTS, oneKey, true)).toBe(
    MAX_PSI_DECODE_ELEMENTS,
  );
  expect(partnerRoundValues(MAX_PSI_DECODE_ELEMENTS + 1, oneKey, true)).toBe(
    MAX_PSI_DECODE_ELEMENTS,
  );
  expect(
    partnerRoundValues(
      MAX_PSI_DECODE_ELEMENTS,
      { linkageKeys: [swappedKey] },
      true,
    ),
  ).toBe(MAX_PSI_DECODE_ELEMENTS);
});

test("a partner round over the connection's ceiling is refused as this party's capacity, before any set moves", async () => {
  const { local, partner, sent } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 11,
  });
  expect(local.status).toBe("rejected");
  const refusal = (local as PromiseRejectedResult).reason as Error;
  expect(refusal).toBeInstanceOf(RoundCapacityError);
  expect((refusal as RoundCapacityError).alcoveRecoveryHintEmitted).toBe(true);
  expect(refusal.message).toContain(
    "your partner's set for one linkage key can hold up to 12 values, over " +
      "the 11 a browser exchange can match",
  );
  expect(binaryFrames(sent)).toEqual([]);
  expect(sent.at(-1)).toEqual({
    decision: "abort",
    abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
  });
  expect(partner.status).toBe("rejected");
  expect((partner as PromiseRejectedResult).reason).toBeInstanceOf(
    PeerAbortError,
  );
});

test("a partner round at the connection's ceiling runs to completion", async () => {
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 12,
  });
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("the caller's capacity check is handed the partner's round, and its throw aborts the run", async () => {
  const seen: Array<number> = [];
  const failure = new RoundCapacityError("not enough memory for that round");
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

test("a sender partner is weighed without the width only the receiver applies", async () => {
  // The partner has more records, so it resolves to the PSI sender and builds
  // the authored order alone: its round is its record count, not twice it.
  const seen: Array<number> = [];
  const { local, partner } = await runPair({
    localRows: 5,
    partnerRows: 12,
    ceiling: 12,
    swapped: true,
    options: { checkPartnerRoundCapacity: (values) => void seen.push(values) },
  });
  expect(seen).toEqual([12]);
  expect(local.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
});

test("a receiver partner is weighed at the width it applies", async () => {
  const { local } = await runPair({
    localRows: 12,
    partnerRows: 5,
    ceiling: 9,
    swapped: true,
  });
  expect(local.status).toBe("rejected");
  expect(((local as PromiseRejectedResult).reason as Error).message).toContain(
    "can hold up to 10 values, over the 9 a browser exchange can match",
  );
});

test("a failure of the capacity check other than a capacity refusal propagates and sends no abort", async () => {
  const failure = new Error("the memory figures could not be read");
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const partnerRun = runExchange(
    partner,
    "responder",
    prepared("Partner Co", 12),
    { psiLibrary },
  );
  const localOutcome = await runExchange(
    withCeiling(local, undefined, sent),
    "initiator",
    prepared("Local Co", 5),
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
