import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON,
  prepareForExchange,
  runExchange,
} from "../src/exchange";
import { termsStatingDeclaredPayloadSend } from "../src/payloadExchange";
import { computeTermsHash } from "../src/records/exchangeRecord";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/records/signingIdentity";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Payload } from "../src/config/linkageTermsSchema";
import type { ExchangeResult, RunExchangeOptions } from "../src/exchange";

// How a party's terms state its payload send set at the terms exchange, and how
// a party whose terms leave payload.receive unset fills it from what the
// partner states there.

const psiLibrary = await PSI();

const baseTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const sendsNote: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "note", type: "other", role: "payload", isPayload: true },
];
const sendsNothing: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "note", type: "other", role: "payload", isPayload: false },
];

const inviterRows = [
  { first_name: "Carol", note: "i-c" },
  { first_name: "Elizabeth", note: "i-e" },
  { first_name: "Henry", note: "i-h" },
];
const acceptorRows = [
  { first_name: "Alice", note: "a-a" },
  { first_name: "Carol", note: "a-c" },
  { first_name: "Elizabeth", note: "a-e" },
];

interface Party {
  metadata: Metadata;
  payload?: Payload;
  expectedPayloadColumns?: string[];
  // The run options beside the library, given the frames this party has sent
  // so far so a callback can read what had moved when it was called.
  options?: (sent: Array<unknown>) => Partial<RunExchangeOptions>;
}

// Every frame each party sent, and each party's settled outcome.
async function settle(inviter: Party, acceptor: Party) {
  const [connInviter, connAcceptor] = createMessagePipe();
  const inviterSent: Array<unknown> = [];
  const acceptorSent: Array<unknown> = [];
  const capturing = (
    conn: MessageConnection,
    sent: Array<unknown>,
  ): MessageConnection => ({
    send: (m: unknown) => {
      sent.push(m);
      return conn.send(m);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  });
  const prepare = (
    identity: string,
    party: Party,
    rows: typeof inviterRows,
  ) => ({
    ...prepareForExchange(
      {
        metadata: party.metadata,
        linkageTerms: {
          ...baseTerms,
          identity,
          ...(party.payload !== undefined ? { payload: party.payload } : {}),
        },
      },
      identity,
      rows,
      ["first_name", "note"],
    ),
    ...(party.expectedPayloadColumns !== undefined
      ? { expectedPayloadColumns: party.expectedPayloadColumns }
      : {}),
  });
  const [inviterResult, acceptorResult] = await Promise.allSettled([
    runExchange(
      capturing(connInviter, inviterSent),
      "responder",
      prepare("Inviter Co", inviter, inviterRows),
      { psiLibrary, ...inviter.options?.(inviterSent) },
    ),
    runExchange(
      capturing(connAcceptor, acceptorSent),
      "initiator",
      prepare("Acceptor Co", acceptor, acceptorRows),
      { psiLibrary, ...acceptor.options?.(acceptorSent) },
    ),
  ]);
  return { inviterResult, acceptorResult, inviterSent, acceptorSent };
}

const statedTerms = (sent: Array<unknown>): LinkageTerms => {
  const frame = sent.find(
    (m) => typeof m === "object" && m !== null && "linkageTerms" in m,
  ) as { linkageTerms: LinkageTerms };
  return frame.linkageTerms;
};

const fulfilled = (outcome: PromiseSettledResult<ExchangeResult>) => {
  expect(outcome.status).toBe("fulfilled");
  return (outcome as PromiseFulfilledResult<ExchangeResult>).value;
};

test("a party that authors no payload.send states the columns its metadata sends", async () => {
  const { acceptorSent, inviterSent } = await settle(
    { metadata: sendsNothing },
    { metadata: sendsNote },
  );
  expect(statedTerms(acceptorSent).payload?.send).toStrictEqual([
    { name: "note" },
  ]);
  expect(statedTerms(inviterSent).payload?.send).toStrictEqual([]);
});

test("an explicit empty payload.send is kept and sends nothing", async () => {
  const { acceptorSent, inviterResult } = await settle(
    { metadata: sendsNothing },
    { metadata: sendsNothing, payload: { send: [] } },
  );
  expect(statedTerms(acceptorSent).payload).toStrictEqual({ send: [] });
  expect(fulfilled(inviterResult).partnerPayload.columns).toEqual([]);
});

const isTermsOrDecisionFrame = (m: unknown): boolean =>
  typeof m === "object" &&
  m !== null &&
  ("linkageTerms" in m || "decision" in m);

const isBootstrapFrame = (m: unknown): boolean =>
  typeof m === "object" && m !== null && "sharedSecret" in m;

test("an unset receive list is filled from the partner's stated send set before the bootstrap frame", async () => {
  const filled: Array<Array<string>> = [];
  let onlyTermsSentWhenFilled = false;
  const { acceptorResult, acceptorSent } = await settle(
    { metadata: sendsNote, options: () => ({ saveIntent: true }) },
    {
      metadata: sendsNothing,
      options: (sent) => ({
        saveIntent: true,
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
          onlyTermsSentWhenFilled = sent.every(isTermsOrDecisionFrame);
        },
      }),
    },
  );
  expect(filled).toEqual([["note"]]);
  expect(onlyTermsSentWhenFilled).toBe(true);
  expect(acceptorSent.some(isBootstrapFrame)).toBe(true);
  expect(fulfilled(acceptorResult).partnerPayload.columns).toEqual(["note"]);
});

const inviterIdentity = await generateSigningIdentity("Inviter Co");
const acceptorIdentity = await generateSigningIdentity("Acceptor Co");
const elsewhereIdentity = await generateSigningIdentity("Elsewhere Co");
const sessionKey = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>;

test("a run refused at a terms-time check after the terms exchange records no fill", async () => {
  const acceptorFingerprint = await computeCertificateFingerprint(
    acceptorIdentity.certificate,
  );
  const refusals: Array<{
    label: string;
    inviterSigns: typeof inviterIdentity;
    inviterPin: string;
  }> = [
    {
      label: "the partner's certificate is not the pinned one",
      inviterSigns: inviterIdentity,
      inviterPin: await computeCertificateFingerprint(
        elsewhereIdentity.certificate,
      ),
    },
    {
      label: "this party's certificate is bound to another name",
      inviterSigns: elsewhereIdentity,
      inviterPin: acceptorFingerprint,
    },
  ];
  for (const { label, inviterSigns, inviterPin } of refusals) {
    const filled: Array<Array<string>> = [];
    const { inviterResult, inviterSent } = await settle(
      {
        metadata: sendsNothing,
        options: () => ({
          signingIdentity: inviterSigns,
          partnerFingerprint: inviterPin,
          sessionKey,
          onPayloadReceiveFilled: (columns) => {
            filled.push(columns);
          },
        }),
      },
      {
        metadata: sendsNote,
        options: () => ({ signingIdentity: acceptorIdentity, sessionKey }),
      },
    );
    expect(inviterResult.status, label).toBe("rejected");
    expect(filled, label).toEqual([]);
    expect(inviterSent.every(isTermsOrDecisionFrame), label).toBe(true);
  }
});

test("a partner declaring it receives nothing from a party that discloses records no fill", async () => {
  const filled: Array<Array<string>> = [];
  const { inviterResult, inviterSent } = await settle(
    {
      metadata: sendsNote,
      options: () => ({
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
        },
      }),
    },
    { metadata: sendsNothing, payload: { receive: [] } },
  );
  expect(inviterResult.status).toBe("rejected");
  expect(filled).toEqual([]);
  expect(inviterSent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("the filled list is held strictly on the next run", async () => {
  const receive = [{ name: "note" }];
  const filled: Array<Array<string>> = [];
  const again = await settle(
    {
      metadata: sendsNothing,
      payload: { receive },
      options: () => ({
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
        },
      }),
    },
    { metadata: sendsNote },
  );
  expect(filled).toEqual([]);
  expect(fulfilled(again.inviterResult).partnerPayload.columns).toEqual([
    "note",
  ]);

  const changed = await settle(
    { metadata: sendsNothing, payload: { receive } },
    { metadata: sendsNothing },
  );
  for (const outcome of [changed.inviterResult, changed.acceptorResult])
    expect(outcome.status).toBe("rejected");
  const reasons = [changed.inviterResult, changed.acceptorResult].map(
    (outcome) => ((outcome as PromiseRejectedResult).reason as Error).message,
  );
  expect(reasons.some((m) => m.includes("payload mismatch"))).toBe(true);
});

test("a fill that is not recorded stops the run before any round, for both parties", async () => {
  const { inviterResult, acceptorResult, inviterSent, acceptorSent } =
    await settle(
      {
        metadata: sendsNothing,
        options: () => ({
          onPayloadReceiveFilled: () => {
            throw new Error("the configuration could not be written");
          },
        }),
      },
      { metadata: sendsNote },
    );
  expect(inviterResult.status).toBe("rejected");
  expect(
    ((inviterResult as PromiseRejectedResult).reason as Error).message,
  ).toBe("the configuration could not be written");
  expect(acceptorResult.status).toBe("rejected");
  expect(inviterSent).toContainEqual(
    expect.objectContaining({
      abortReasons: [
        "a party could not record the payload columns it receives",
      ],
    }),
  );
  for (const sent of [inviterSent, acceptorSent])
    expect(sent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("no fill without a caller to record it, or under an explicit receive list", async () => {
  const lazy = await settle(
    { metadata: sendsNothing },
    { metadata: sendsNote },
  );
  expect(fulfilled(lazy.inviterResult).partnerPayload.columns).toEqual([
    "note",
  ]);

  const filled: Array<Array<string>> = [];
  const nothing = await settle(
    {
      metadata: sendsNothing,
      payload: { receive: [] },
      options: () => ({
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
        },
      }),
    },
    { metadata: sendsNothing },
  );
  expect(filled).toEqual([]);
  expect(fulfilled(nothing.inviterResult).partnerPayload.columns).toEqual([]);
});

test("the first run's agreed-terms hash is the hash of the resolved terms each post-fill configuration states", async () => {
  const filledBy = { inviter: [] as string[][], acceptor: [] as string[][] };
  const recording = (into: string[][]) => () => ({
    onPayloadReceiveFilled: (columns: string[]) => {
      into.push(columns);
    },
  });
  const { inviterResult, acceptorResult, inviterSent, acceptorSent } =
    await settle(
      { metadata: sendsNothing, options: recording(filledBy.inviter) },
      { metadata: sendsNote, options: recording(filledBy.acceptor) },
    );
  expect(filledBy).toEqual({ inviter: [["note"]], acceptor: [[]] });
  const inviterHash = fulfilled(inviterResult).audit?.record.termsHash;
  const acceptorHash = fulfilled(acceptorResult).audit?.record.termsHash;
  expect(inviterHash).toBeDefined();
  expect(acceptorHash).toBe(inviterHash);

  // Each configuration as the fill left it: receive written, send unset and
  // stated from the metadata, as verify-receipt states it.
  const postFill = (
    identity: string,
    metadata: Metadata,
    receive: string[],
  ): LinkageTerms =>
    termsStatingDeclaredPayloadSend(
      {
        ...baseTerms,
        identity,
        payload: { receive: receive.map((name) => ({ name })) },
      },
      metadata,
    );
  const inviterConfig = postFill("Inviter Co", sendsNothing, ["note"]);
  const acceptorConfig = postFill("Acceptor Co", sendsNote, []);
  expect(await computeTermsHash(inviterConfig, statedTerms(acceptorSent))).toBe(
    inviterHash,
  );
  expect(await computeTermsHash(acceptorConfig, statedTerms(inviterSent))).toBe(
    inviterHash,
  );
  expect(await computeTermsHash(inviterConfig, acceptorConfig)).toBe(
    inviterHash,
  );
});

test("a party holding no receive list is offered the partner's declared send set before the pin and the fill", async () => {
  const offered: Array<Array<string>> = [];
  const filled: Array<Array<string>> = [];
  let onlyTermsSentWhenOffered = false;
  const { inviterResult } = await settle(
    {
      metadata: sendsNothing,
      options: (sent) => ({
        onPayloadReceiveFill: async (columns) => {
          offered.push(columns);
          onlyTermsSentWhenOffered = sent.every(isTermsOrDecisionFrame);
          expect(filled).toEqual([]);
          return { accepted: true };
        },
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
        },
      }),
    },
    { metadata: sendsNote },
  );
  expect(offered).toEqual([["note"]]);
  expect(onlyTermsSentWhenOffered).toBe(true);
  expect(filled).toEqual([["note"]]);
  expect(fulfilled(inviterResult).partnerPayload.columns).toEqual(["note"]);
});

test("a declined send set stops both parties before any round, recording neither the pin nor the fill", async () => {
  const filled: Array<Array<string>> = [];
  const pinned: string[] = [];
  const { inviterResult, acceptorResult, inviterSent, acceptorSent } =
    await settle(
      {
        metadata: sendsNothing,
        options: () => ({
          signingIdentity: inviterIdentity,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) => {
            pinned.push(fingerprint);
          },
          onPayloadReceiveFill: async () => ({
            accepted: false,
            refusal: new Error("the operator declined"),
          }),
          onPayloadReceiveFilled: (columns) => {
            filled.push(columns);
          },
        }),
      },
      {
        metadata: sendsNote,
        options: () => ({ signingIdentity: acceptorIdentity, sessionKey }),
      },
    );
  expect(inviterResult.status).toBe("rejected");
  expect(
    ((inviterResult as PromiseRejectedResult).reason as Error).message,
  ).toBe("the operator declined");
  expect(acceptorResult.status).toBe("rejected");
  expect(filled).toEqual([]);
  expect(pinned).toEqual([]);
  expect(inviterSent).toContainEqual(
    expect.objectContaining({
      abortReasons: [PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON],
    }),
  );
  for (const sent of [inviterSent, acceptorSent])
    expect(sent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("no send set is offered to a party holding a receive list, or from a partner declaring none", async () => {
  const offered: Array<Array<string>> = [];
  const offering = (): Partial<RunExchangeOptions> => ({
    onPayloadReceiveFill: async (columns) => {
      offered.push(columns);
      return { accepted: true };
    },
  });
  const held = await settle(
    {
      metadata: sendsNothing,
      expectedPayloadColumns: ["note"],
      options: offering,
    },
    { metadata: sendsNote },
  );
  expect(fulfilled(held.inviterResult).partnerPayload.columns).toEqual([
    "note",
  ]);
  const stated = await settle(
    {
      metadata: sendsNothing,
      payload: { receive: [{ name: "note" }] },
      options: offering,
    },
    { metadata: sendsNote },
  );
  fulfilled(stated.inviterResult);
  const none = await settle(
    { metadata: sendsNothing, options: offering },
    { metadata: sendsNothing },
  );
  fulfilled(none.inviterResult);
  expect(offered).toEqual([]);
});

test("a confirmation that fails rather than answers is not sent to the partner as a decline", async () => {
  const filled: Array<Array<string>> = [];
  const { inviterResult, acceptorResult, inviterSent } = await settle(
    {
      metadata: sendsNothing,
      options: () => ({
        onPayloadReceiveFill: () =>
          Promise.reject(new Error("the prompt could not be read")),
        onPayloadReceiveFilled: (columns) => {
          filled.push(columns);
        },
      }),
    },
    { metadata: sendsNote },
  );
  expect(
    ((inviterResult as PromiseRejectedResult).reason as Error).message,
  ).toBe("the prompt could not be read");
  expect(acceptorResult.status).toBe("rejected");
  expect(filled).toEqual([]);
  const abortReasons = inviterSent.flatMap((frame) =>
    typeof frame === "object" && frame !== null && "abortReasons" in frame
      ? (frame as { abortReasons: string[] }).abortReasons
      : [],
  );
  expect(abortReasons).toHaveLength(1);
  expect(abortReasons).not.toContain(PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON);
});
