import { describe, expect, test } from "vitest";

// The equal-count role tie on file-sync and SFTP, broken on the two parties'
// agreed-terms identity names before the handshake role, which follows arrival
// order there (docs/spec/PROTOCOL.md, Role resolution and work minimization).

import PSI from "@openmined/psi.js";

import {
  breaksRoleTieOnIdentity,
  resolveRole,
  type RoleTieIdentities,
} from "../src/protocolSetup";
import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { PartnerProtocolRefusalError } from "../src/errors";
import type {
  LinkageStrategy,
  LinkageTerms,
  Output,
} from "../src/config/linkageTermsSchema";
import type { HandshakeRole, PsiRole } from "../src/types";

const psiLibrary = await PSI();

const BOTH: Output = { expectsOutput: true, shareWithPartner: true };
const HANDSHAKE_ROLES: ReadonlyArray<HandshakeRole> = [
  "initiator",
  "responder",
];
const otherHandshakeRole = (role: HandshakeRole): HandshakeRole =>
  role === "initiator" ? "responder" : "initiator";

/** Both parties' roles, party a in `aHandshake`, each naming itself as given. */
function resolveBoth(
  aHandshake: HandshakeRole,
  aIdentity: string | undefined,
  bIdentity: string | undefined,
  counts: { a: number; b: number } = { a: 100, b: 100 },
): { a: PsiRole; b: PsiRole } {
  const tie = (
    local: string | undefined,
    partner: string | undefined,
  ): RoleTieIdentities => ({ local, partner });
  return {
    a: resolveRole(
      aHandshake,
      BOTH,
      BOTH,
      counts.a,
      counts.b,
      tie(aIdentity, bIdentity),
    ),
    b: resolveRole(
      otherHandshakeRole(aHandshake),
      BOTH,
      BOTH,
      counts.b,
      counts.a,
      tie(bIdentity, aIdentity),
    ),
  };
}

describe("resolveRole at equal declared counts", () => {
  test.each(HANDSHAKE_ROLES)(
    "distinct names make the party whose name sorts first the receiver, party a the %s",
    (aHandshake) => {
      expect(resolveBoth(aHandshake, "A Co", "B Co")).toEqual({
        a: "receiver",
        b: "sender",
      });
      expect(resolveBoth(aHandshake, "B Co", "A Co")).toEqual({
        a: "sender",
        b: "receiver",
      });
    },
  );

  test("names compare by UTF-16 code unit, not by locale", () => {
    // A locale collation puts "a" before "B"; code-unit order puts "B" (0x42)
    // before "a" (0x61), on every machine.
    for (const aHandshake of HANDSHAKE_ROLES)
      expect(resolveBoth(aHandshake, "a co", "B Co")).toEqual({
        a: "sender",
        b: "receiver",
      });
  });

  test.each(HANDSHAKE_ROLES)(
    "equal or absent names leave the tie with the initiator, party a the %s",
    (aHandshake) => {
      const initiatorReceives = {
        a: aHandshake === "initiator" ? "receiver" : "sender",
        b: aHandshake === "initiator" ? "sender" : "receiver",
      };
      for (const [aIdentity, bIdentity] of [
        ["Same Co", "Same Co"],
        [undefined, undefined],
        ["A Co", undefined],
        [undefined, "A Co"],
      ] as const)
        expect(resolveBoth(aHandshake, aIdentity, bIdentity)).toEqual(
          initiatorReceives,
        );
    },
  );

  test("without the names the tie goes to the initiator, whatever the names would say", () => {
    expect(resolveRole("initiator", BOTH, BOTH, 100, 100)).toBe("receiver");
    expect(resolveRole("responder", BOTH, BOTH, 100, 100)).toBe("sender");
  });
});

describe("resolveRole away from the tie", () => {
  test.each(HANDSHAKE_ROLES)(
    "unequal counts make the smaller party the receiver whatever the names, party a the %s",
    (aHandshake) => {
      expect(
        resolveBoth(aHandshake, "B Co", "A Co", { a: 99, b: 100 }),
      ).toEqual({ a: "receiver", b: "sender" });
      expect(
        resolveBoth(aHandshake, "A Co", "B Co", { a: 100, b: 99 }),
      ).toEqual({ a: "sender", b: "receiver" });
    },
  );

  test("one-sided output makes the party expecting output the receiver whatever the names", () => {
    const none: Output = { expectsOutput: false, shareWithPartner: false };
    const names = { local: "B Co", partner: "A Co" };
    expect(resolveRole("responder", BOTH, none, 100, 100, names)).toBe(
      "receiver",
    );
    expect(resolveRole("initiator", none, BOTH, 100, 100, names)).toBe(
      "sender",
    );
  });
});

test("the names break the tie on file-sync and SFTP, and not on WebRTC", () => {
  expect(breaksRoleTieOnIdentity("sftp")).toBe(true);
  expect(breaksRoleTieOnIdentity("filedrop")).toBe(true);
  expect(breaksRoleTieOnIdentity("webrtc")).toBe(false);
});

// --- Driven end to end --------------------------------------------------------

function surnameTerms(strategy: LinkageStrategy): LinkageTerms {
  return {
    version: "1.0.0",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: strategy,
    output: BOTH,
    deduplicate: false,
    linkageFields: [{ name: "last_name", type: "last_name" }],
    linkageKeys: [
      {
        name: "surname parts",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: " " } }],
          },
        ],
      },
    ],
  };
}

// One six-pair cycle over three records a side, whose two largest pairings
// differ in every pair, so each role assignment keeps a different table
// (roleSwapDeterminism.test.ts). Equal counts, so the run reaches the tie.
const CYCLE_A = ["Papa-Uniform", "Sierra-Tango", "Quebec-Romeo"];
const CYCLE_B = ["Romeo-Sierra", "Papa-Quebec", "Tango-Uniform"];

interface Party {
  readonly identity: string;
  readonly rows: ReadonlyArray<string>;
  /** Whether this party's build breaks the tie on the names. */
  readonly breaksTie: boolean;
}

function prepare(strategy: LinkageStrategy, party: Party) {
  return prepareForExchange(
    { linkageTerms: { ...surnameTerms(strategy), identity: party.identity } },
    party.identity,
    party.rows.map((last_name) => ({ last_name })),
    ["last_name"],
  );
}

/** Run the exchange with `initiator` arriving second, so initiating. */
async function exchange(
  strategy: LinkageStrategy,
  initiator: Party,
  responder: Party,
): Promise<{ initiator: ExchangeResult; responder: ExchangeResult }> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const [initiated, responded] = await Promise.all([
    runExchange(initiatorConn, "initiator", prepare(strategy, initiator), {
      psiLibrary,
      breakRoleTieOnIdentity: initiator.breaksTie,
    }),
    runExchange(responderConn, "responder", prepare(strategy, responder), {
      psiLibrary,
      breakRoleTieOnIdentity: responder.breaksTie,
    }),
  ]);
  return { initiator: initiated, responder: responded };
}

const pairsOf = (result: ExchangeResult): Array<[number, number]> => {
  const table = result.associationTable;
  expect(table).toBeDefined();
  return table![0].map((local, i) => [local, table![1][i]]);
};

describe.each<LinkageStrategy>(["cascade", "single-pass"])(
  "under %s, at equal counts",
  (strategy) => {
    test("distinct names give the same receiver and the same table whichever party arrives first", async () => {
      const a: Party = { identity: "A Co", rows: CYCLE_A, breaksTie: true };
      const b: Party = { identity: "B Co", rows: CYCLE_B, breaksTie: true };
      const aInitiates = await exchange(strategy, a, b);
      const bInitiates = await exchange(strategy, b, a);
      expect(aInitiates.initiator.resolvedRole).toBe("receiver");
      expect(aInitiates.responder.resolvedRole).toBe("sender");
      expect(bInitiates.responder.resolvedRole).toBe("receiver");
      expect(bInitiates.initiator.resolvedRole).toBe("sender");
      expect(pairsOf(bInitiates.responder)).toEqual(
        pairsOf(aInitiates.initiator),
      );
      expect(pairsOf(aInitiates.initiator)).toHaveLength(3);
    });

    test("equal names leave the receiver with whichever party initiates", async () => {
      const a: Party = { identity: "Same Co", rows: CYCLE_A, breaksTie: true };
      const b: Party = { identity: "Same Co", rows: CYCLE_B, breaksTie: true };
      for (const [first, second] of [
        [a, b],
        [b, a],
      ]) {
        const run = await exchange(strategy, first, second);
        expect(run.initiator.resolvedRole).toBe("receiver");
        expect(run.responder.resolvedRole).toBe("sender");
      }
    });

    test("parties not breaking the tie on the names leave it with the initiator", async () => {
      const a: Party = { identity: "A Co", rows: CYCLE_A, breaksTie: false };
      const b: Party = { identity: "B Co", rows: CYCLE_B, breaksTie: false };
      const run = await exchange(strategy, b, a);
      expect(run.initiator.resolvedRole).toBe("receiver");
      expect(run.responder.resolvedRole).toBe("sender");
    });
  },
);

// --- A build with the rule against one without it ------------------------------

/**
 * A party on a build with the rule against one without it, the names ordered
 * against arrival so the two resolve the same role. Each party's resolved role
 * is read where the run reports it, and each run's outcome a window after both
 * have; a run still waiting then is closed and reported as `waiting`.
 */
async function mixedExchange(
  strategy: LinkageStrategy,
  withRule: HandshakeRole,
): Promise<{
  roles: [PsiRole | undefined, PsiRole | undefined];
  outcomes: [unknown, unknown];
}> {
  // The party with the rule initiates under a name sorting second, or responds
  // under one sorting first: either way its name contradicts its arrival.
  const initiator: Party = {
    identity: "B Co",
    rows: CYCLE_A,
    breaksTie: withRule === "initiator",
  };
  const responder: Party = {
    identity: "A Co",
    rows: CYCLE_B,
    breaksTie: withRule === "responder",
  };
  const roles: [PsiRole | undefined, PsiRole | undefined] = [
    undefined,
    undefined,
  ];
  const [initiatorConn, responderConn] = createMessagePipe();
  const run = (index: 0 | 1, party: Party, role: HandshakeRole) =>
    runExchange(
      index === 0 ? initiatorConn : responderConn,
      role,
      prepare(strategy, party),
      {
        psiLibrary,
        breakRoleTieOnIdentity: party.breaksTie,
        onProtocolConfirmed: (_terms, resolvedRole) => {
          roles[index] = resolvedRole;
        },
      },
    ).then(
      () => "completed",
      (err: unknown) =>
        err instanceof PartnerProtocolRefusalError
          ? `refused: ${err.message}`
          : err,
    );
  const settled: [unknown, unknown] = ["waiting", "waiting"];
  const runs = [
    run(0, initiator, "initiator").then((r) => (settled[0] = r)),
    run(1, responder, "responder").then((r) => (settled[1] = r)),
  ];
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const outcomes: [unknown, unknown] = [settled[0], settled[1]];
  initiatorConn.close();
  responderConn.close();
  await Promise.all(runs);
  return { roles, outcomes };
}

const CASCADE_BOTH_SENDERS =
  "refused: server protocol error: malformed inbound PSI request frame";
const SINGLE_PASS_BOTH_RECEIVERS =
  "refused: protocol error: single-pass reply truncated reading setup";

describe("a build with the rule against one without it, names against arrival", () => {
  test("both resolve the sender: the cascade refuses the first request, single-pass waits", async () => {
    const cascade = await mixedExchange("cascade", "initiator");
    expect(cascade.roles).toEqual(["sender", "sender"]);
    expect(cascade.outcomes).toEqual([
      CASCADE_BOTH_SENDERS,
      CASCADE_BOTH_SENDERS,
    ]);
    const singlePass = await mixedExchange("single-pass", "initiator");
    expect(singlePass.roles).toEqual(["sender", "sender"]);
    expect(singlePass.outcomes).toEqual(["waiting", "waiting"]);
  });

  test("both resolve the receiver: the cascade waits, single-pass refuses the reply", async () => {
    const cascade = await mixedExchange("cascade", "responder");
    expect(cascade.roles).toEqual(["receiver", "receiver"]);
    expect(cascade.outcomes).toEqual(["waiting", "waiting"]);
    const singlePass = await mixedExchange("single-pass", "responder");
    expect(singlePass.roles).toEqual(["receiver", "receiver"]);
    expect(singlePass.outcomes).toEqual([
      SINGLE_PASS_BOTH_RECEIVERS,
      SINGLE_PASS_BOTH_RECEIVERS,
    ]);
  });
});
