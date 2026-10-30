import { describe, expect, test } from "vitest";

import { authenticateConnection } from "../src/auth";
import type { HandshakeSecretKind } from "../src/auth";
import { exchangeTerms } from "../src/protocolSetup";
import type { TermsRotation } from "../src/protocolSetup";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import { randomBytes, toBase64Url } from "../src/utils/crypto";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { HandshakeRole } from "../src/types";

// The heal of a one-sided rotation: every cut point of the store order
// (docs/notes/rotation-hardening.md, "What it does to the one-sided rotation")
// leaves each side rotated or holding a previous secret the next run accepts,
// whichever side initiates that run. Each side keeps its secrets as an app
// does: the initiator's store keeps the secret its handshake used as the
// previous one, the responder's keeps none, and the initiator drops the
// previous one when the responder's first frame after the terms exchange
// arrives (here, when the run completes).

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

interface Party {
  name: string;
  current: string;
  previous?: string;
}

/** Where a run stops, by the frame or store it is cut at. */
type Cut =
  | "terms message 2 lost"
  | "terms message 2 holds no readable value"
  | "proceed lost"
  | "the responder's store fails"
  | "the responder's first frame lost"
  | "none";

interface RunOutcome {
  completed: boolean;
  used: Record<"initiator" | "responder", HandshakeSecretKind | undefined>;
}

/** `conn` whose send of a frame `cut` matches closes the connection instead,
 * or sends the frame `rewrite` returns. */
function cutting(
  conn: MessageConnection,
  cut: (frame: Record<string, unknown>) => boolean,
  rewrite?: (frame: Record<string, unknown>) => Record<string, unknown>,
): MessageConnection {
  return {
    send: async (data) => {
      const frame = data as Record<string, unknown>;
      if (cut(frame)) {
        await conn.close();
        throw new Error("the run was cut here");
      }
      await conn.send(rewrite === undefined ? frame : rewrite(frame));
    },
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

const isTermsReply = (frame: Record<string, unknown>) =>
  frame.decision === "proceed" && "linkageTerms" in frame;
const isProceed = (frame: Record<string, unknown>) =>
  frame.decision === "proceed" && !("linkageTerms" in frame);
const never = () => false;

async function run(
  initiator: Party,
  responder: Party,
  cut: Cut = "none",
): Promise<RunOutcome> {
  const [rawI, rawR] = createMessagePipe();
  const connI = cut === "proceed lost" ? cutting(rawI, isProceed) : rawI;
  const connR =
    cut === "terms message 2 lost"
      ? cutting(rawR, isTermsReply)
      : cut === "terms message 2 holds no readable value"
        ? cutting(rawR, never, (frame) =>
            isTermsReply(frame) ? { ...frame, responderValue: "" } : frame,
          )
        : rawR;
  const used: RunOutcome["used"] = {
    initiator: undefined,
    responder: undefined,
  };

  const side = async (
    party: Party,
    role: HandshakeRole,
    conn: MessageConnection,
  ): Promise<void> => {
    const auth = await authenticateConnection(
      conn,
      { sharedSecret: party.current },
      role,
      true,
      {
        ...(party.previous !== undefined && {
          previous: { sharedSecret: party.previous },
        }),
        history: [],
      },
    );
    used[role] = auth.secretUsed.local;
    const usedSecret =
      auth.secretUsed.local === "previous" ? party.previous! : party.current;
    const rotation: TermsRotation = {
      inputs: auth.nextSecretInputs,
      store: (nextSecret) => {
        if (role === "responder" && cut === "the responder's store fails")
          throw new Error("the store failed");
        party.current = nextSecret;
        if (role === "initiator") party.previous = usedSecret;
        else delete party.previous;
      },
    };
    await exchangeTerms(
      conn,
      role,
      terms,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      rotation,
    );
  };

  const outcomes = await Promise.allSettled([
    side(initiator, "initiator", connI),
    side(responder, "responder", connR),
  ]);
  const completed = outcomes.every((o) => o.status === "fulfilled");
  if (completed && cut !== "the responder's first frame lost")
    delete initiator.previous;
  await rawI.close();
  await rawR.close();
  return { completed, used };
}

function pair(): [Party, Party] {
  const x = toBase64Url(randomBytes(32));
  return [
    { name: "A", current: x },
    { name: "B", current: x },
  ];
}

// What the note's cut-point table says each side holds after the cut, with A
// the cut run's initiator holding X before it.
const CUT_ROWS: ReadonlyArray<{
  cut: Cut;
  initiatorRotated: boolean;
  initiatorKeepsX: boolean;
  responderRotated: boolean;
}> = [
  {
    cut: "terms message 2 lost",
    initiatorRotated: false,
    initiatorKeepsX: false,
    responderRotated: false,
  },
  {
    cut: "terms message 2 holds no readable value",
    initiatorRotated: false,
    initiatorKeepsX: false,
    responderRotated: false,
  },
  {
    cut: "proceed lost",
    initiatorRotated: true,
    initiatorKeepsX: true,
    responderRotated: false,
  },
  {
    cut: "the responder's store fails",
    initiatorRotated: true,
    initiatorKeepsX: true,
    responderRotated: false,
  },
  {
    cut: "the responder's first frame lost",
    initiatorRotated: true,
    initiatorKeepsX: true,
    responderRotated: true,
  },
  {
    cut: "none",
    initiatorRotated: true,
    initiatorKeepsX: false,
    responderRotated: true,
  },
];

describe("a run cut at each point of the store order", () => {
  for (const row of CUT_ROWS) {
    for (const nextInitiator of ["A", "B"] as const) {
      test(`${row.cut}, then a run initiated by ${nextInitiator === "A" ? "the cut run's initiator" : "the cut run's responder"}: both end on one secret`, async () => {
        const [a, b] = pair();
        const x = a.current;
        const cutRun = await run(a, b, row.cut);
        expect(cutRun.completed).toBe(
          row.cut === "none" || row.cut === "the responder's first frame lost",
        );
        expect(a.current !== x).toBe(row.initiatorRotated);
        expect(a.previous === x).toBe(row.initiatorKeepsX);
        expect(b.current !== x).toBe(row.responderRotated);
        expect(b.previous).toBeUndefined();

        const [i, r] = nextInitiator === "A" ? [a, b] : [b, a];
        const next = await run(i, r);
        expect(next.completed).toBe(true);
        expect(a.current).toBe(b.current);
        expect(a.previous).toBeUndefined();
        expect(b.previous).toBeUndefined();
        // Only a run between different current secrets is a heal, and the
        // side that used its previous secret is the cut run's initiator.
        const healed = row.initiatorRotated && !row.responderRotated;
        const aUsed =
          nextInitiator === "A" ? next.used.initiator : next.used.responder;
        const bUsed =
          nextInitiator === "A" ? next.used.responder : next.used.initiator;
        expect(aUsed).toBe(healed ? "previous" : "current");
        expect(bUsed).toBe("current");
      });
    }
  }
});

describe("a heal run that is itself cut", () => {
  test("the formerly ahead side, as the heal run's responder, keeps its secrets, and the run after it finds X again", async () => {
    const [a, b] = pair();
    const x = a.current;
    await run(a, b, "proceed lost");
    const aheadUnshared = a.current;
    expect(a.previous).toBe(x);

    // B initiates the heal under X and is cut after its own store.
    await run(b, a, "proceed lost");
    expect(b.previous).toBe(x);
    expect(a.current).toBe(aheadUnshared);
    expect(a.previous).toBe(x);
    expect(b.current).not.toBe(a.current);

    for (const [i, r] of [
      [a, b],
      [b, a],
    ] as const) {
      const [first, second] = [{ ...i }, { ...r }];
      const next = await run(first, second);
      expect(next.completed).toBe(true);
      expect(next.used).toEqual({
        initiator: "previous",
        responder: "previous",
      });
      expect(first.current).toBe(second.current);
    }
  });

  test("a sequence of runs each cut after the initiator's store never leaves the two without a common secret", async () => {
    const [a, b] = pair();
    for (let round = 0; round < 6; round += 1) {
      const [i, r] = round % 2 === 0 ? [a, b] : [b, a];
      await run(
        i,
        r,
        round % 3 === 2 ? "the responder's store fails" : "proceed lost",
      );
      const common = [a.current, a.previous].filter(
        (s) => s !== undefined && (s === b.current || s === b.previous),
      );
      expect(common.length).toBeGreaterThan(0);
    }
    const finish = await run(a, b);
    expect(finish.completed).toBe(true);
    expect(a.current).toBe(b.current);
  });
});
