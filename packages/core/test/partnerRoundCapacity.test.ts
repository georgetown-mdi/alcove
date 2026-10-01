import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

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

function prepared(
  identity: string,
  rowCount: number,
  linkageStrategy: LinkageStrategy = "cascade",
): PreparedExchange {
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
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          { name: "firstName", elements: [{ field: "firstName" }] },
        ],
      },
    },
    identity,
    Array.from({ length: rowCount }, (_unused, i) => ({
      first_name: `zq${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`,
    })),
    ["first_name"],
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
  options?: Partial<RunExchangeOptions>;
}) {
  const [local, partner] = createMessagePipe();
  const sent: Array<unknown> = [];
  const outcomes = await Promise.allSettled([
    runExchange(
      withCeiling(local, params.ceiling, sent),
      "initiator",
      prepared("Local Co", params.localRows, params.strategy),
      { psiLibrary, ...params.options },
    ),
    runExchange(
      partner,
      "responder",
      prepared("Partner Co", params.partnerRows, params.strategy),
      { psiLibrary },
    ),
  ]);
  return { local: outcomes[0], partner: outcomes[1], sent };
}

test("the partner's round is its record count times the widest key's declared width", () => {
  const keys = {
    linkageKeys: [
      { name: "a", elements: [{ field: "a" }] },
      {
        name: "ab",
        elements: [{ field: "a" }, { field: "b" }],
        swap: ["a", "b"] as [string, string],
      },
    ],
  };
  expect(partnerRoundValues(1_000, keys)).toBe(2_000);
  expect(
    partnerRoundValues(1_000, { linkageKeys: [keys.linkageKeys[0]] }),
  ).toBe(1_000);
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
