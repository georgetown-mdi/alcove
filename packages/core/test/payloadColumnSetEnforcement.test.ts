import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { deriveAcceptedLinkageTerms } from "../src/linkageTermsNegotiation";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";
import {
  assertPayloadMatchesAgreedSend,
  buildOutputTable,
} from "../src/payloadExchange";
import type { PartnerPayload } from "../src/payloadExchange";
import { PSI_SET_PART_HEADER_BYTES } from "../src/psi/psiSetParts";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { Metadata } from "../src/config/metadata";
import type { MessageConnection } from "../src/connection/messageConnection";

// Both parties run the full exchange over an in-process pipe; one party's
// outbound payload frame is rewritten before the other reads it, so the
// receiver sees a column set other than the one the terms agreed.

const psiLibrary = await PSI();

const UNAGREED_COLUMN = "unagreed_column_name";
const UNAGREED_VALUE = "UNAGREED-VALUE";

const baseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter Co",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const linkageOnly: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
];
const withPayload: Metadata = [
  ...linkageOnly,
  { name: "a", type: "other", role: "payload", isPayload: true },
  { name: "b", type: "other", role: "payload", isPayload: true },
];

const inviterRows = [
  { first_name: "Carol", a: "IC-a", b: "IC-b" },
  { first_name: "Elizabeth", a: "IE-a", b: "IE-b" },
  { first_name: "Henry", a: "IH-a", b: "IH-b" },
];
const acceptorRows = [
  { first_name: "Alice", a: "AA-a", b: "AA-b" },
  { first_name: "Carol", a: "AC-a", b: "AC-b" },
  { first_name: "Elizabeth", a: "AE-a", b: "AE-b" },
];
const unmatchedAcceptorRows = [
  { first_name: "Zed", a: "AZ-a", b: "AZ-b" },
  { first_name: "Yolanda", a: "AY-a", b: "AY-b" },
];

interface PayloadBody {
  hasData: boolean;
  columns: string[];
  rowIndices: number[];
  rows: Array<Array<string | null>>;
}

type Rewrite = (body: PayloadBody) => void;

function isPayloadBody(value: unknown): value is PayloadBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { hasData?: unknown }).hasData === true &&
    Array.isArray((value as { columns?: unknown }).columns) &&
    Array.isArray((value as { rows?: unknown }).rows)
  );
}

/** Rewrite the payload frame `conn` sends, leaving every other frame alone. */
function rewritePayloadFrame(
  conn: MessageConnection,
  rewrite: Rewrite,
): MessageConnection {
  const header = PSI_SET_PART_HEADER_BYTES;
  return {
    send: async (data) => {
      if (data instanceof Uint8Array && data.length > header) {
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(data.subarray(header)));
        } catch {
          body = undefined;
        }
        if (isPayloadBody(body)) {
          rewrite(body);
          const json = new TextEncoder().encode(JSON.stringify(body));
          const out = new Uint8Array(header + json.length);
          out.set(data.subarray(0, header));
          out.set(json, header);
          return conn.send(out);
        }
      }
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

const addUnagreedColumn: Rewrite = (body) => {
  body.columns.push(UNAGREED_COLUMN);
  body.rows = body.rows.map((row) => [...row, UNAGREED_VALUE]);
};
const dropColumnB: Rewrite = (body) => {
  const index = body.columns.indexOf("b");
  body.columns.splice(index, 1);
  body.rows = body.rows.map((row) => row.filter((_, i) => i !== index));
};

interface Scenario {
  inviterTerms: LinkageTerms;
  inviterMetadata: Metadata;
  acceptorMetadata: Metadata;
  acceptorRows: Array<Record<string, string>>;
}

/**
 * Run both parties; `tampered` names the party whose outbound payload frame
 * is rewritten.
 */
async function runBoth(
  scenario: Scenario,
  tampered: "inviter" | "acceptor",
  rewrite: Rewrite | undefined,
) {
  const [inviterRaw, acceptorRaw] = createMessagePipe();
  const wrap = (conn: MessageConnection, party: "inviter" | "acceptor") =>
    rewrite !== undefined && party === tampered
      ? rewritePayloadFrame(conn, rewrite)
      : conn;
  const inviterPrepared = prepareForExchange(
    {
      metadata: scenario.inviterMetadata,
      linkageTerms: scenario.inviterTerms,
    },
    "Inviter Co",
    inviterRows,
    scenario.inviterMetadata.map(({ name }) => name),
  );
  const acceptorPrepared = prepareForExchange(
    {
      metadata: scenario.acceptorMetadata,
      linkageTerms: deriveAcceptedLinkageTerms(
        scenario.inviterTerms,
        "Acceptor Co",
      ),
    },
    "Acceptor Co",
    scenario.acceptorRows,
    scenario.acceptorMetadata.map(({ name }) => name),
  );
  const [inviter, acceptor] = await Promise.allSettled([
    runExchange(wrap(inviterRaw, "inviter"), "initiator", inviterPrepared, {
      psiLibrary,
    }).finally(() => inviterRaw.close()),
    runExchange(wrap(acceptorRaw, "acceptor"), "responder", acceptorPrepared, {
      psiLibrary,
    }).finally(() => acceptorRaw.close()),
  ]);
  return { inviter, acceptor, inviterPrepared };
}

function expectRedactedMismatch(result: PromiseSettledResult<unknown>): void {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as unknown;
  expect(reason).toBeInstanceOf(ConnectionError);
  expect((reason as ConnectionError).kind).toBe("protocol");
  const rendered = sanitizeErrorForDisplay(reason);
  expect(rendered).toContain("payload disclosure mismatch");
  expect(rendered).not.toContain(UNAGREED_COLUMN);
  expect(rendered).not.toContain(UNAGREED_VALUE);
  expect(rendered).not.toMatch(/[AI][A-Z]-[ab]/);
}

// The acceptor discloses a and b and the inviter receives them, under a
// declared inviter payload.receive or under none, where the acceptor's
// declared send set alone is what the inviter agreed to.
const acceptorDiscloses = (
  payload: LinkageTerms["payload"],
  rows: Array<Record<string, string>> = acceptorRows,
): Scenario => ({
  inviterTerms: payload === undefined ? baseTerms : { ...baseTerms, payload },
  inviterMetadata: linkageOnly,
  acceptorMetadata: withPayload,
  acceptorRows: rows,
});

describe.each([
  ["a declared payload.receive", { receive: [{ name: "a" }, { name: "b" }] }],
  ["no payload.receive", undefined],
])("a receiving inviter with %s", (_label, payload) => {
  const scenario = acceptorDiscloses(payload);

  test("receives the agreed columns", async () => {
    const { inviter, inviterPrepared } = await runBoth(
      scenario,
      "acceptor",
      undefined,
    );
    if (inviter.status !== "fulfilled") throw inviter.reason;
    const result = inviter.value;
    expect([...(result.partnerPayload?.columns ?? [])].sort()).toEqual([
      "a",
      "b",
    ]);
    const table = buildOutputTable(
      result.associationTable!,
      inviterRows,
      inviterPrepared.metadata,
      result.partnerPayload!,
    );
    expect(table.headers).toEqual(expect.arrayContaining(["a", "b"]));
  });

  test("refuses a column the agreed send set does not list", async () => {
    const { inviter } = await runBoth(scenario, "acceptor", addUnagreedColumn);
    expectRedactedMismatch(inviter);
  });

  test("refuses a payload missing an agreed column", async () => {
    const { inviter } = await runBoth(scenario, "acceptor", dropColumnB);
    expectRedactedMismatch(inviter);
  });
});

test("a run in which no partner row matched receives no payload and completes", async () => {
  const { inviter, acceptor } = await runBoth(
    acceptorDiscloses(undefined, unmatchedAcceptorRows),
    "acceptor",
    undefined,
  );
  expect(inviter.status).toBe("fulfilled");
  expect(acceptor.status).toBe("fulfilled");
});

describe("a receiving acceptor", () => {
  // The inviter discloses a and b and states them as its send set; the
  // acceptor receives the inviter's payload before sending its own.
  const scenario: Scenario = {
    inviterTerms: baseTerms,
    inviterMetadata: withPayload,
    acceptorMetadata: linkageOnly,
    acceptorRows,
  };

  test("receives the agreed columns", async () => {
    const { acceptor } = await runBoth(scenario, "inviter", undefined);
    if (acceptor.status !== "fulfilled") throw acceptor.reason;
    expect([...(acceptor.value.partnerPayload?.columns ?? [])].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  test("refuses a column the agreed send set does not list", async () => {
    const { acceptor } = await runBoth(scenario, "inviter", addUnagreedColumn);
    expectRedactedMismatch(acceptor);
  });

  test("refuses a payload missing an agreed column", async () => {
    const { acceptor } = await runBoth(scenario, "inviter", dropColumnB);
    expectRedactedMismatch(acceptor);
  });
});

describe("assertPayloadMatchesAgreedSend", () => {
  const received = (columns: string[]): PartnerPayload => ({
    columns,
    rowIndices: [0],
    rows: [columns.map(() => "x")],
  });
  const empty: PartnerPayload = { columns: [], rowIndices: [], rows: [] };
  const agreed = [{ name: "a" }, { name: "b" }];

  test("passes the agreed set in any order", () => {
    expect(() =>
      assertPayloadMatchesAgreedSend(received(["b", "a"]), agreed, 1),
    ).not.toThrow();
  });

  test("passes an empty payload when no partner row matched", () => {
    expect(() =>
      assertPayloadMatchesAgreedSend(empty, agreed, 0),
    ).not.toThrow();
  });

  test("refuses an empty payload when partner rows matched", () => {
    expect(() => assertPayloadMatchesAgreedSend(empty, agreed, 1)).toThrow(
      ConnectionError,
    );
  });

  test("refuses a repeated name standing in for an agreed one", () => {
    expect(() =>
      assertPayloadMatchesAgreedSend(received(["a", "a"]), agreed, 1),
    ).toThrow(ConnectionError);
  });

  test("refuses a repeated agreed name beside every agreed one", () => {
    expect(() =>
      assertPayloadMatchesAgreedSend(received(["a", "a", "b"]), agreed, 1),
    ).toThrow(ConnectionError);
  });

  test("refuses any column against an absent send set", () => {
    expect(() =>
      assertPayloadMatchesAgreedSend(received(["a"]), undefined, 1),
    ).toThrow(ConnectionError);
  });
});
