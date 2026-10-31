import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import { InvitationTermDivergenceError, PeerAbortError } from "../src/errors";
import type { NextSecretInputs } from "../src/nextSecret";
import { randomBytes } from "../src/utils/crypto";
import { getLogger } from "../src/utils/logger";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { HandshakeRole } from "../src/types";

// `onTermsExchanged` runs once this side's terms exchange has completed, after
// its rotation store and the checks that follow the terms exchange, and never
// on a run the terms exchange or one of those checks refused, or that failed
// inside the terms exchange. A throw from it sends the partner an abort.

const psiLibrary = await PSI();

afterEach(() => vi.restoreAllMocks());

const terms = (
  identity: string,
  linkageStrategy: LinkageTerms["linkageStrategy"] = "cascade",
): LinkageTerms => ({
  version: "1.0.0",
  identity,
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy,
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
});

const rows = ["Alice", "Carol", "Henry"].map((first_name) => ({ first_name }));

async function runPair(options: {
  responderStrategy?: LinkageTerms["linkageStrategy"];
  responderStoreFails?: boolean;
  responderExpectsPartnerDeduplicate?: boolean;
  hookThrows?: { role: HandshakeRole; error: Error };
}) {
  const inputs: NextSecretInputs = {
    sessionKey: randomBytes(32),
    keyAgreementOutput: randomBytes(32),
    initiatorValue: randomBytes(32),
    expires: undefined,
  };
  const events: string[] = [];
  const [rawI, rawR] = createMessagePipe();
  // Each side's sends past its own store are recorded, to order them against
  // that side's hook.
  const recordingSends = (
    role: HandshakeRole,
    raw: MessageConnection,
  ): MessageConnection => ({
    send: async (data) => {
      if (events.includes(`${role} stored`)) events.push(`${role} sent`);
      await raw.send(data);
    },
    receive: (t) => raw.receive(t),
    close: () => raw.close(),
  });
  const run = (
    role: HandshakeRole,
    conn: MessageConnection,
    linkageTerms: LinkageTerms,
  ) => {
    const prepared = prepareForExchange(
      { linkageTerms },
      linkageTerms.identity,
      rows,
      ["first_name"],
    );
    if (role === "responder")
      prepared.expectedPartnerDeduplicate =
        options.responderExpectsPartnerDeduplicate;
    return runExchange(recordingSends(role, conn), role, prepared, {
      psiLibrary,
      rotation: {
        inputs,
        store: () => {
          if (role === "responder" && options.responderStoreFails === true)
            throw new Error("the store failed");
          events.push(`${role} stored`);
        },
      },
      onTermsExchanged: () => {
        events.push(`${role} terms exchanged`);
        if (options.hookThrows?.role === role) throw options.hookThrows.error;
      },
      onPayloadReceiveFilled: () => {
        events.push(`${role} receive list recorded`);
      },
    });
  };
  const outcomes = await Promise.allSettled([
    run("initiator", rawI, terms("Initiator Co")),
    run(
      "responder",
      rawR,
      terms("Responder Co", options.responderStrategy ?? "cascade"),
    ),
  ]);
  await rawI.close();
  await rawR.close();
  return { outcomes, events };
}

test("a completed run calls onTermsExchanged once on each side, after its store, before the fill is recorded and before it sends anything more", async () => {
  vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
  const { outcomes, events } = await runPair({});
  expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
  for (const role of ["initiator", "responder"] as const) {
    const at = (event: string) => events.indexOf(`${role} ${event}`);
    expect(events.filter((e) => e === `${role} terms exchanged`)).toHaveLength(
      1,
    );
    expect(at("stored")).toBeGreaterThanOrEqual(0);
    expect(at("stored")).toBeLessThan(at("terms exchanged"));
    // The caller records the fill into what its step wrote.
    expect(at("terms exchanged")).toBeLessThan(at("receive list recorded"));
  }
  // The responder stores as the last step of its terms exchange, so its hook
  // runs before its first frame past it.
  expect(events.indexOf("responder terms exchanged")).toBeLessThan(
    events.indexOf("responder sent"),
  );
});

test("a run the terms exchange refused calls onTermsExchanged on neither side", async () => {
  vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
  const { outcomes, events } = await runPair({
    responderStrategy: "single-pass",
  });
  expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
  expect(events).toEqual([]);
});

test("a side refused at the deduplicate check after the terms exchange does not call onTermsExchanged", async () => {
  vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
  const { outcomes, events } = await runPair({
    responderExpectsPartnerDeduplicate: true,
  });
  expect(outcomes[1].status).toBe("rejected");
  expect(
    outcomes[1].status === "rejected" && outcomes[1].reason,
  ).toBeInstanceOf(InvitationTermDivergenceError);
  expect(events).toContain("responder stored");
  expect(events).not.toContain("responder terms exchanged");
  expect(events).not.toContain("responder receive list recorded");
});

test("a responder whose store fails does not call onTermsExchanged", async () => {
  vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
  const { outcomes, events } = await runPair({ responderStoreFails: true });
  expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
  expect(events).not.toContain("responder terms exchanged");
});

test.each(["initiator", "responder"] as const)(
  "an onTermsExchanged that throws on the %s ends that run with its error and the partner's on an abort",
  async (role) => {
    vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
    const error = new Error("the step after the terms exchange failed");
    const { outcomes } = await runPair({ hookThrows: { role, error } });
    const [thrower, partner] =
      role === "initiator" ? outcomes : [outcomes[1], outcomes[0]];
    expect(thrower).toEqual({ status: "rejected", reason: error });
    expect(partner.status).toBe("rejected");
    expect(partner.status === "rejected" && partner.reason).toBeInstanceOf(
      PeerAbortError,
    );
  },
);
