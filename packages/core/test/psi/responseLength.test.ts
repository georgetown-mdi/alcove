import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { ConnectionError, PartnerProtocolRefusalError } from "../../src/errors";
import {
  encodeSinglePassReply,
  encodeSinglePassReplyTail,
  linkViaSinglePassPSI,
  singlePassReplyParts,
} from "../../src/psi/link";
import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { PSI_SET_PART_HEADER_BYTES } from "../../src/psi/psiSetParts";
import { sortAssociationTable } from "../../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { asOnePsiSetPart } from "../utils/psiSetPart";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import { makeParticipant } from "../utils/support";

const psiLibrary = await PSI();

// What a partner does to the response it sends: leave out its last half, send
// none of it, add one element, or send it as the library built it.
type Change = "shorter" | "empty" | "longer" | "unchanged";

function changedResponse(response: Uint8Array, change: Change): Uint8Array {
  if (change === "unchanged") return response;
  const message = psiLibrary.response.deserializeBinary(response);
  const elements = message.getEncryptedElementsList() as Array<Uint8Array>;
  const kept =
    change === "shorter"
      ? elements.slice(0, elements.length - Math.floor(elements.length / 2))
      : change === "empty"
        ? []
        : [...elements, elements[elements.length - 1]!];
  message.setEncryptedElementsList(kept);
  return message.serializeBinary();
}

// The element count a shorter or empty response of `requested` elements has.
function changedCount(change: "shorter" | "empty", requested: number): number {
  return change === "empty" ? 0 : requested - Math.floor(requested / 2);
}

function shortRefusal(id: string, sent: number, requested: number): string {
  return (
    `${id} protocol error: inbound PSI response has ${sent} encrypted ` +
    `element(s), not the ${requested} of the request this party sent`
  );
}

// `conn` with the PSI set that arrives as its `n`th inbound frame, one part,
// passed through `change`.
function changingNthSet(
  conn: MessageConnection,
  n: number,
  change: Change,
): MessageConnection {
  let count = 0;
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) => {
      const frame = await conn.receive(timeoutMs);
      count += 1;
      if (count !== n) return frame;
      const set = (frame as Uint8Array).subarray(PSI_SET_PART_HEADER_BYTES);
      return asOnePsiSetPart(changedResponse(set, change));
    },
    close: () => conn.close(),
  };
}

// Rejects with what `run` rejected with after closing `conn`, which ends the
// partner's wait as the run's abort would.
function closingOnRefusal<T>(run: Promise<T>, conn: MessageConnection) {
  return run.catch(async (error: unknown) => {
    await conn.close();
    throw error;
  });
}

const REFUSED = [
  ["shorter than the request", "shorter"],
  ["with no elements", "empty"],
] as const;

describe("a cascade round", () => {
  const starterSet = ["Alice", "Bob", "Carol", "David", "Elizabeth"];
  const joinerSet = ["Carol", "Elizabeth", "Henry", "Ivan"];

  function round(change: Change) {
    const [starterConn, joinerConn] = createMessagePipe();
    const starter = makeParticipant(psiLibrary, "starter");
    const joiner = makeParticipant(psiLibrary, "joiner");
    // The joiner reads the setup, sends its request, then reads the response.
    return Promise.allSettled([
      starter.identifyIntersection(starterConn, starterSet),
      closingOnRefusal(
        joiner.identifyIntersection(
          changingNthSet(joinerConn, 2, change),
          joinerSet,
        ),
        joinerConn,
      ),
    ]);
  }

  test.for(REFUSED)(
    "refuses a response %s, and neither party has a result",
    async ([, change]) => {
      const [starter, joiner] = await round(change);
      expect(joiner.status).toBe("rejected");
      const refusal = (joiner as PromiseRejectedResult).reason as Error;
      expect(refusal).toBeInstanceOf(PartnerProtocolRefusalError);
      expect(refusal.message).toBe(
        shortRefusal(
          "client",
          changedCount(change, joinerSet.length),
          joinerSet.length,
        ),
      );
      expect(starter.status).toBe("rejected");
      expect((starter as PromiseRejectedResult).reason).toBeInstanceOf(
        ConnectionError,
      );
    },
  );

  test("refuses a longer response", async () => {
    const [, joiner] = await round("longer");
    const refusal = (joiner as PromiseRejectedResult).reason as Error;
    expect(refusal).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(refusal.message).toMatch(
      /^client protocol error: inbound PSI response declares \d+ bytes, over the \d+ bytes of the request this party sent$/,
    );
  });

  test("matches a response of the request's length", async () => {
    const [starter, joiner] = await round("unchanged");
    expect(starter.status).toBe("fulfilled");
    expect(joiner.status).toBe("fulfilled");
    const joinerTable = sortAssociationTable(
      (joiner as PromiseFulfilledResult<[number[], number[]]>).value,
    );
    expect(joinerTable).toStrictEqual([
      [0, 1],
      [2, 4],
    ]);
  });
});

describe("a count-only round", () => {
  const senderSet = ["Alice", "Bob", "Carol", "David", "Elizabeth"];
  const receiverSet = ["Carol", "Elizabeth", "Henry", "Ivan"];
  const declared = {
    senderRecords: senderSet.length,
    receiverRecords: receiverSet.length,
  };

  const countOnlyParticipant = (role: "starter" | "joiner") =>
    new PSIParticipant(
      role === "starter" ? "server" : "client",
      psiLibrary,
      { role, verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      new InProcessPsiEngine(psiLibrary, role, role, "count-only-permuted"),
    );

  async function round(change: Change) {
    const [senderConn, receiverConn] = createMessagePipe();
    const sender = countOnlyParticipant("starter");
    const receiver = countOnlyParticipant("joiner");
    // The receiver reads the setup and the index table, sends its request,
    // then reads the response.
    const outcomes = await Promise.allSettled([
      sender.countPermutedRound(senderConn, senderSet, declared),
      receiver.countPermutedRound(
        changingNthSet(receiverConn, 3, change),
        receiverSet,
        declared,
      ),
    ]);
    return { receiver, outcomes };
  }

  test.for(REFUSED)(
    "refuses a response %s, and the receiver has no count",
    async ([, change]) => {
      const { receiver, outcomes } = await round(change);
      const [, receiverOutcome] = outcomes;
      expect(receiverOutcome.status).toBe("rejected");
      const refusal = (receiverOutcome as PromiseRejectedResult)
        .reason as Error;
      expect(refusal).toBeInstanceOf(PartnerProtocolRefusalError);
      expect(refusal.message).toBe(
        shortRefusal(
          "client",
          changedCount(change, receiverSet.length),
          receiverSet.length,
        ),
      );
      await expect(receiver.finishPermutedCount(1)).rejects.toThrow(
        "the count was asked for after 0 of the exchange's 1 count-only rounds",
      );
    },
  );

  test("refuses a longer response", async () => {
    const { outcomes } = await round("longer");
    const refusal = (outcomes[1] as PromiseRejectedResult).reason as Error;
    expect(refusal).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(refusal.message).toMatch(
      /^client protocol error: inbound PSI response declares \d+ bytes, over the \d+ bytes of the request this party sent$/,
    );
  });

  test("counts a response of the request's length", async () => {
    const { receiver, outcomes } = await round("unchanged");
    expect(outcomes.map(({ status }) => status)).toStrictEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(await receiver.finishPermutedCount(1)).toBe(2);
  });
});

// The sets of the single-pass measurement: 30 receiver values, 20 of them the
// sender's.
const senderSet = Array.from({ length: 40 }, (_, i) => `v${i}`);
const receiverSet = Array.from({ length: 30 }, (_, i) => `v${2 * i}`);

// Every frame of a single-pass reply in parts within this bound is short
// enough that the response is sent in several parts.
const LOWERED_FRAME_BOUND = 300;

describe.each([
  ["in one frame", undefined],
  ["in parts", LOWERED_FRAME_BOUND],
] as const)("a single-pass reply %s", (_layout, frameBound) => {
  // A receiver run whose partner sends a conforming reply but for `change`,
  // its index table naming no value.
  async function receiverAgainst(change: Change): Promise<unknown> {
    const [senderConn, receiverConn] = createMessagePipe();
    const receiver =
      frameBound === undefined
        ? receiverConn
        : Object.assign(receiverConn, {
            outboundWebRtcFrameBound: () => frameBound,
          });
    const run = linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      makeParticipant(psiLibrary, "joiner"),
      receiver,
      [receiverSet],
      fanOutFreeBounds(1, senderSet.length),
      false,
      -1,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const request = await receiveRequest(senderConn);
    const sender = makeParticipant(psiLibrary, "starter");
    const { setup } = await sender.createServerSetup(senderSet);
    const response = changedResponse(
      await sender.processClientRequest(request),
      change,
    );
    const noValues = Array.from({ length: senderSet.length }, () => -1);
    if (frameBound === undefined)
      await senderConn.send(
        encodeSinglePassReply(setup, response, senderSet.length, noValues),
      );
    else
      for (const part of singlePassReplyParts(
        setup,
        response,
        encodeSinglePassReplyTail(senderSet.length, noValues),
        200,
      ))
        await senderConn.send(part);
    sender.dispose();
    return run;
  }

  // The request, in one frame or joined from its parts.
  async function receiveRequest(conn: MessageConnection): Promise<Uint8Array> {
    if (frameBound === undefined) return (await conn.receive()) as Uint8Array;
    const payloads: Array<Uint8Array> = [];
    for (;;) {
      const part = (await conn.receive()) as Uint8Array;
      const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
      payloads.push(part.subarray(PSI_SET_PART_HEADER_BYTES));
      if (view.getUint32(0) === view.getUint32(4) - 1) break;
    }
    const request = new Uint8Array(
      payloads.reduce((total, payload) => total + payload.byteLength, 0),
    );
    let at = 0;
    for (const payload of payloads) {
      request.set(payload, at);
      at += payload.byteLength;
    }
    return request;
  }

  test.for(REFUSED)("refuses a response %s", async ([, change]) => {
    const error = await receiverAgainst(change);
    expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((error as Error).message).toBe(
      shortRefusal(
        "client",
        changedCount(change, receiverSet.length),
        receiverSet.length,
      ),
    );
  });

  test("refuses a longer response", async () => {
    const error = await receiverAgainst("longer");
    expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((error as Error).message).toMatch(
      frameBound === undefined
        ? /^client protocol error: inbound PSI response is \d+ bytes, over the \d+ bytes of the request this party sent$/
        : /^client protocol error: inbound PSI response declares \d+ bytes, over the \d+ bytes of the request this party sent$/,
    );
  });

  test("matches a response of the request's length", async () => {
    expect(await receiverAgainst("unchanged")).toBeUndefined();
  });
});
