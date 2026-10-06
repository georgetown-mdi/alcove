import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import {
  termsAdoptingPartnerTerms,
  termsReceivingPartnerSend,
  validateCompatibility,
} from "../src/linkageTermsNegotiation";
import {
  TERMS_CHANGE_NOT_ACCEPTED_REASON,
  TermsChangeRefusedError,
  exchangeTerms,
} from "../src/protocolSetup";
import {
  ProtocolRefusalError,
  InvitationTermDivergenceError,
} from "../src/errors";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Payload } from "../src/config/linkageTermsSchema";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { ExchangeResult, RunExchangeOptions } from "../src/exchange";
import type { TermsChange } from "../src/protocolSetup";

// A change to one party's terms between runs, met at the terms exchange: the
// party whose terms changed runs, and its partner takes the change on or
// refuses it before any key or data moves.

const psiLibrary = await PSI();

const baseTerms: LinkageTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const linkage = {
  name: "first_name",
  type: "first_name",
  role: "linkage",
  isPayload: false,
} as const;
const sends = (...names: string[]): Metadata => [
  linkage,
  ...["note", "extra"].map((name) => ({
    name,
    type: "other" as const,
    role: "payload" as const,
    isPayload: names.includes(name),
  })),
];
const columns = (...names: string[]) => names.map((name) => ({ name }));

const rows = (prefix: string) => [
  { first_name: "Carol", note: `${prefix}-note`, extra: `${prefix}-extra` },
  { first_name: "Elizabeth", note: `${prefix}-n2`, extra: `${prefix}-e2` },
  { first_name: `${prefix}-only`, note: "x", extra: "y" },
];

interface Party {
  metadata: Metadata;
  payload?: Payload;
  terms?: Partial<LinkageTerms>;
  expectedPartnerDeduplicate?: boolean;
  onTermsChange?: RunExchangeOptions["onTermsChange"];
}

// The two parties' outcomes and every frame each sent. `changer` initiates
// unless `changerResponds`.
async function settle(changer: Party, partner: Party, changerResponds = false) {
  const [connChanger, connPartner] = createMessagePipe();
  const changerSent: Array<unknown> = [];
  const partnerSent: Array<unknown> = [];
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
  const run = (
    identity: string,
    party: Party,
    conn: MessageConnection,
    role: "initiator" | "responder",
  ) => {
    const prepared = prepareForExchange(
      {
        metadata: party.metadata,
        linkageTerms: {
          ...baseTerms,
          ...party.terms,
          identity,
          ...(party.payload !== undefined ? { payload: party.payload } : {}),
        },
      },
      identity,
      rows(identity),
      ["first_name", "note", "extra"],
    );
    if (party.expectedPartnerDeduplicate !== undefined)
      prepared.expectedPartnerDeduplicate = party.expectedPartnerDeduplicate;
    return runExchange(conn, role, prepared, {
      psiLibrary,
      ...(party.onTermsChange !== undefined
        ? { onTermsChange: party.onTermsChange }
        : {}),
    });
  };
  const [changerResult, partnerResult] = await Promise.allSettled([
    run(
      "Changer Co",
      changer,
      capturing(connChanger, changerSent),
      changerResponds ? "responder" : "initiator",
    ),
    run(
      "Partner Co",
      partner,
      capturing(connPartner, partnerSent),
      changerResponds ? "initiator" : "responder",
    ),
  ]);
  return { changerResult, partnerResult, changerSent, partnerSent };
}

const fulfilled = (outcome: PromiseSettledResult<ExchangeResult>) => {
  expect(outcome.status).toBe("fulfilled");
  return (outcome as PromiseFulfilledResult<ExchangeResult>).value;
};
const rejection = (outcome: PromiseSettledResult<ExchangeResult>): Error => {
  expect(outcome.status).toBe("rejected");
  return (outcome as PromiseRejectedResult).reason as Error;
};

const isTermsOrDecisionFrame = (m: unknown): boolean =>
  typeof m === "object" &&
  m !== null &&
  ("linkageTerms" in m || "decision" in m);

// --- The delta --------------------------------------------------------------

const withPayload = (identity: string, payload: Payload): LinkageTerms => ({
  ...baseTerms,
  identity,
  payload,
});

test("the delta names a column the partner's terms add, in each direction", () => {
  const local = withPayload("Local", {
    send: columns("note"),
    receive: columns("note"),
  });
  const partner = withPayload("Partner", {
    send: columns("note", "extra"),
    receive: columns("note", "extra"),
  });
  const { errors, delta } = validateCompatibility(local, partner);
  expect(delta).toStrictEqual({
    received: { added: ["extra"], removed: [] },
    sent: { added: [], removed: ["extra"] },
    partnerDeduplicate: undefined,
    otherTerms: [],
  });
  expect(errors).toHaveLength(2);
});

test("the delta names a column the partner's terms remove, in each direction", () => {
  const local = withPayload("Local", {
    send: columns("note", "extra"),
    receive: columns("note", "extra"),
  });
  const partner = withPayload("Partner", {
    send: columns("note"),
    receive: columns("note"),
  });
  expect(validateCompatibility(local, partner).delta).toStrictEqual({
    received: { added: [], removed: ["extra"] },
    sent: { added: ["extra"], removed: [] },
    partnerDeduplicate: undefined,
    otherTerms: [],
  });
});

test("the delta names a change to a term other than the payload apart from the columns", () => {
  const agreement = {
    reference: "DUA-1",
    purpose: "research",
    expirationDate: "2099-01-01",
  };
  const local = { ...baseTerms, legalAgreement: agreement };
  const partner = {
    ...baseTerms,
    legalAgreement: { ...agreement, reference: "DUA-2" },
  };
  const { errors, delta } = validateCompatibility(local, partner);
  expect(delta.received).toBeUndefined();
  expect(delta.sent).toBeUndefined();
  expect(delta.otherTerms).toEqual(errors);
  expect(delta.otherTerms).toHaveLength(1);
  expect(delta.otherTerms[0]).toMatch(/legal agreement reference mismatch/);
});

// --- The party whose columns changed ----------------------------------------

test("a party whose metadata sends a column its terms do not state runs, and its terms state the column", async () => {
  const changes: TermsChange[] = [];
  const { changerResult, partnerResult, changerSent } = await settle(
    {
      metadata: sends("note", "extra"),
      payload: { send: columns("note"), receive: columns("note") },
    },
    {
      metadata: sends("note"),
      payload: { send: columns("note"), receive: columns("note") },
      onTermsChange: async (change) => {
        changes.push(change);
      },
    },
  );
  const stated = changerSent.find(
    (m) => typeof m === "object" && m !== null && "linkageTerms" in m,
  ) as { linkageTerms: LinkageTerms };
  expect(stated.linkageTerms.payload?.send).toStrictEqual(
    columns("note", "extra"),
  );
  expect(changes.map((change) => change.delta.received)).toStrictEqual([
    { added: ["extra"], removed: [] },
  ]);
  expect(changes[0]!.continuable).toBe(true);
  expect(changes[0]!.adoptedTerms.payload?.receive).toStrictEqual(
    columns("note", "extra"),
  );
  const partner = fulfilled(partnerResult);
  expect(partner.partnerPayload.columns).toEqual(["note", "extra"]);
  const changer = fulfilled(changerResult);
  expect(changer.audit?.record.termsHash).toBeDefined();
  expect(partner.audit?.record.termsHash).toBe(changer.audit?.record.termsHash);
});

test("a column the changed party no longer sends is taken on the same way", async () => {
  const changes: TermsChange[] = [];
  const { changerResult, partnerResult } = await settle(
    {
      metadata: sends("note"),
      payload: { send: columns("note", "extra"), receive: columns("note") },
    },
    {
      metadata: sends("note"),
      payload: { send: columns("note"), receive: columns("note", "extra") },
      onTermsChange: async (change) => {
        changes.push(change);
      },
    },
  );
  expect(changes.map((change) => change.delta.received)).toStrictEqual([
    { added: [], removed: ["extra"] },
  ]);
  expect(fulfilled(partnerResult).partnerPayload.columns).toEqual(["note"]);
  fulfilled(changerResult);
});

test("a responder whose columns changed runs, and the initiator takes the change on at its decision", async () => {
  const changes: TermsChange[] = [];
  const { changerResult, partnerResult } = await settle(
    { metadata: sends("note", "extra"), payload: { receive: columns("note") } },
    {
      metadata: sends("note"),
      payload: { receive: columns("note") },
      onTermsChange: async (change) => {
        changes.push(change);
      },
    },
    true,
  );
  expect(changes.map((change) => change.delta.received)).toStrictEqual([
    { added: ["extra"], removed: [] },
  ]);
  const partner = fulfilled(partnerResult);
  const changer = fulfilled(changerResult);
  expect(partner.partnerPayload.columns).toEqual(["note", "extra"]);
  expect(partner.audit?.record.termsHash).toBe(changer.audit?.record.termsHash);
});

// --- The partner's decision -------------------------------------------------

test("a partner that declines ends the run before any key or data moves", async () => {
  const declined = new Error("declined by the operator");
  const { changerResult, partnerResult, changerSent, partnerSent } =
    await settle(
      {
        metadata: sends("note", "extra"),
        payload: { receive: columns("note") },
      },
      {
        metadata: sends("note"),
        payload: { receive: columns("note") },
        onTermsChange: () => Promise.reject(declined),
      },
    );
  expect(rejection(partnerResult)).toBe(declined);
  expect(rejection(changerResult)).toBeInstanceOf(ProtocolRefusalError);
  expect(partnerSent).toContainEqual(
    expect.objectContaining({
      decision: "abort",
      abortReasons: [TERMS_CHANGE_NOT_ACCEPTED_REASON],
    }),
  );
  for (const sent of [changerSent, partnerSent])
    expect(sent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("a partner with no way to take a change on refuses it, naming the delta", async () => {
  const { partnerResult, partnerSent } = await settle(
    { metadata: sends("note", "extra"), payload: { receive: columns("note") } },
    { metadata: sends("note"), payload: { receive: columns("note") } },
  );
  const refusal = rejection(partnerResult);
  expect(refusal).toBeInstanceOf(TermsChangeRefusedError);
  expect((refusal as TermsChangeRefusedError).delta.received).toStrictEqual({
    added: ["extra"],
    removed: [],
  });
  expect(partnerSent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("a changed legal agreement is taken on by the responder and the run continues", async () => {
  const agreement = {
    reference: "DUA-1",
    purpose: "research",
    expirationDate: "2099-01-01",
  };
  const changes: TermsChange[] = [];
  const { changerResult, partnerResult } = await settle(
    {
      metadata: sends("note"),
      terms: { legalAgreement: { ...agreement, reference: "DUA-2" } },
    },
    {
      metadata: sends("note"),
      terms: { legalAgreement: agreement },
      onTermsChange: async (change) => {
        changes.push(change);
      },
    },
  );
  expect(changes).toHaveLength(1);
  expect(changes[0]!.continuable).toBe(true);
  expect(changes[0]!.delta.otherTerms[0]).toMatch(
    /legal agreement reference mismatch/,
  );
  const partner = fulfilled(partnerResult);
  const changer = fulfilled(changerResult);
  expect(partner.audit?.record.governance.legalAgreement?.reference).toBe(
    "DUA-2",
  );
  expect(partner.audit?.record.termsHash).toBe(changer.audit?.record.termsHash);
});

test("a change to the linkage keys cannot continue the run it was met in", async () => {
  const changes: TermsChange[] = [];
  const { partnerResult, partnerSent } = await settle(
    {
      metadata: sends("note"),
      terms: {
        linkageKeys: [{ name: "renamed", elements: [{ field: "firstName" }] }],
      },
    },
    {
      metadata: sends("note"),
      onTermsChange: async (change) => {
        changes.push(change);
      },
    },
  );
  expect(changes.map((change) => change.continuable)).toEqual([false]);
  expect(rejection(partnerResult)).toBeInstanceOf(TermsChangeRefusedError);
  expect(partnerSent.every(isTermsOrDecisionFrame)).toBe(true);
});

for (const changerResponds of [false, true])
  for (const changesColumns of [false, true])
    test(`a changed partner deduplicate cannot continue the run it was met in (the changed party ${changerResponds ? "responds" : "initiates"}, ${changesColumns ? "with" : "without"} a column change)`, async () => {
      const changes: TermsChange[] = [];
      const { partnerResult, partnerSent } = await settle(
        {
          metadata: changesColumns ? sends("note", "extra") : sends("note"),
          terms: { deduplicate: true },
        },
        {
          metadata: sends("note"),
          payload: { receive: columns("note") },
          expectedPartnerDeduplicate: false,
          onTermsChange: async (change) => {
            changes.push(change);
          },
        },
        changerResponds,
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]!.continuable).toBe(false);
      expect(changes[0]!.delta.partnerDeduplicate).toStrictEqual({
        expected: false,
        presented: true,
      });
      expect(changes[0]!.delta.received).toStrictEqual(
        changesColumns ? { added: ["extra"], removed: [] } : undefined,
      );
      expect(rejection(partnerResult)).toBeInstanceOf(TermsChangeRefusedError);
      expect(partnerSent.every(isTermsOrDecisionFrame)).toBe(true);
    });

test("with no way to take a change on, a changed partner deduplicate is refused as the invitation binding refuses it", async () => {
  const { partnerResult, partnerSent } = await settle(
    { metadata: sends("note"), terms: { deduplicate: true } },
    {
      metadata: sends("note"),
      payload: { receive: columns("note") },
      expectedPartnerDeduplicate: false,
    },
  );
  expect(rejection(partnerResult)).toBeInstanceOf(
    InvitationTermDivergenceError,
  );
  expect(partnerSent.every(isTermsOrDecisionFrame)).toBe(true);
});

test("a receive list the partner's columns no longer match is met at the terms exchange", async () => {
  const changes: TermsChange[] = [];
  const [connA, connB] = createMessagePipe();
  const partnerPrepared = prepareForExchange(
    {
      metadata: sends("note"),
      linkageTerms: {
        ...baseTerms,
        identity: "P",
        payload: { receive: columns("note") },
      },
    },
    "P",
    rows("P"),
    ["first_name", "note", "extra"],
  );
  const [changer, partner] = await Promise.allSettled([
    runExchange(
      connA,
      "initiator",
      prepareForExchange(
        {
          metadata: sends("note", "extra"),
          linkageTerms: { ...baseTerms, identity: "C" },
        },
        "C",
        rows("C"),
        ["first_name", "note", "extra"],
      ),
      { psiLibrary },
    ),
    runExchange(connB, "responder", partnerPrepared, {
      psiLibrary,
      onTermsChange: async (change) => {
        changes.push(change);
      },
    }),
  ]);
  expect(changes.map((change) => change.delta.received)).toStrictEqual([
    { added: ["extra"], removed: [] },
  ]);
  expect(fulfilled(partner).partnerPayload.columns).toEqual(["note", "extra"]);
  fulfilled(changer);
});

// --- Adopted terms that are not a valid document ----------------------------

test("a partner that shares output and states no payload is adopted as sending nothing", () => {
  const adopted = termsAdoptingPartnerTerms(
    { ...baseTerms, identity: "Local" },
    { ...baseTerms, identity: "Partner" },
  );
  expect(adopted?.payload?.receive).toStrictEqual([]);
});

test("a partner's send set this party's terms cannot receive is refused without offering the change", async () => {
  const local: LinkageTerms = {
    ...baseTerms,
    identity: "Local",
    output: { expectsOutput: false, shareWithPartner: true },
    payload: { receive: [] },
  };
  const partner: LinkageTerms = {
    ...baseTerms,
    identity: "Partner",
    output: { expectsOutput: true, shareWithPartner: false },
    payload: { send: columns("stale_column") },
  };
  expect(termsReceivingPartnerSend(local, partner)).toBeUndefined();

  const changes: TermsChange[] = [];
  const [connLocal, connPartner] = createMessagePipe();
  const [localResult] = await Promise.allSettled([
    exchangeTerms(
      connLocal,
      "initiator",
      local,
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onTermsChange: async (change) => {
          changes.push(change);
          return change.adoptedTerms;
        },
      },
    ),
    exchangeTerms(connPartner, "responder", partner, 3),
  ]);
  expect(changes).toStrictEqual([]);
  expect(localResult.status).toBe("rejected");
  expect((localResult as PromiseRejectedResult).reason).toBeInstanceOf(
    TermsChangeRefusedError,
  );
});
