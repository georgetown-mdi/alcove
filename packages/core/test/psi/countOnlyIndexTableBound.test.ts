import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { MAX_WEBRTC_FRAME_BYTES } from "../../src/connection/binaryPackBounds";
import { AEAD_ENVELOPE_OVERHEAD_BYTES } from "../../src/connection/encryptedMessageConnection";
import { fileSyncMessageFileBytes } from "../../src/connection/fileSyncOutboundBound";
import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
} from "../../src/connection/frameSize";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import {
  binaryPackByteStringLength,
  webrtcFrameExceedsBound,
} from "../../src/connection/webrtcOutboundBound";
import { RoundCapacityError, RoundSetLimitError } from "../../src/errors";
import { assertFirstRoundWithinSetMaximum } from "../../src/exchange/firstRoundCapacity";
import { encodeIndexTable } from "../../src/psi/countOnlyPermutation";
import { linkViaCountOnlyPSI } from "../../src/psi/link";
import { PSIParticipant, type PsiSetCeilings } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { prepared } from "../utils/support";

// A count-only round's index table goes in one frame of 4 * n_S bytes, not in
// parts (docs/spec/PROTOCOL.md, PSI-C, The sender's pseudonyms and the index
// table). The sender sends it only for a setup it held to the per-set maximum
// and the partner's ceiling, and the receiver reads it only after a setup of
// n_S elements within its own ceiling, so no table either party handles has
// more than MAX_PSI_DECODE_ELEMENTS entries. At that size the frame is within
// the per-frame bound each channel's receiver applies.

const wasm = await PSI();

const ENTRY_BYTES = encodeIndexTable(Int32Array.of(2, 0, 1)).byteLength / 3;

test("the start-of-exchange check admits a count-only sender at most the per-set maximum of records", async () => {
  const exchange = prepared("Sender Co", [{ first_name: "ann" }], {
    terms: { algorithm: "psi-c" },
  });
  await expect(
    assertFirstRoundWithinSetMaximum({
      ...exchange,
      rowCount: MAX_PSI_DECODE_ELEMENTS,
    }),
  ).resolves.toBeUndefined();
  await expect(
    assertFirstRoundWithinSetMaximum({
      ...exchange,
      rowCount: MAX_PSI_DECODE_ELEMENTS + 1,
    }),
  ).rejects.toBeInstanceOf(RoundSetLimitError);
});

test("the index table at the per-set maximum fits one frame on either channel", () => {
  expect(ENTRY_BYTES).toBe(4);
  const largestTable = MAX_PSI_DECODE_ELEMENTS * ENTRY_BYTES;
  expect(largestTable).toBe(67_108_864);
  for (const envelope of [0, AEAD_ENVELOPE_OVERHEAD_BYTES]) {
    expect(
      webrtcFrameExceedsBound(
        binaryPackByteStringLength(largestTable + envelope),
        MAX_WEBRTC_FRAME_BYTES,
      ),
    ).toBe(false);
    expect(
      fileSyncMessageFileBytes(largestTable, envelope),
    ).toBeLessThanOrEqual(MAX_FRAME_SIZE_BYTES);
  }
});

function participant(
  role: "starter" | "joiner",
  setCeilings: PsiSetCeilings,
  library: PSILibrary = wasm,
): PSIParticipant {
  const id = role === "starter" ? "server" : "client";
  return new PSIParticipant(
    id,
    library,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    new InProcessPsiEngine(library, role, id, "count-only-permuted"),
    undefined,
    setCeilings,
  );
}

// `conn` recording every frame this party sends and counting those it reads.
function observed(conn: MessageConnection): {
  conn: MessageConnection;
  sent: Array<unknown>;
  read: () => number;
} {
  const sent: Array<unknown> = [];
  let read = 0;
  return {
    sent,
    read: () => read,
    conn: {
      send: (data) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: async (timeoutMs?: number) => {
        const frame = await conn.receive(timeoutMs);
        read += 1;
        return frame;
      },
      close: () => conn.close(),
    },
  };
}

// One count-only round of one key between a sender of `senderRecords` and a
// receiver of 3, under the given ceilings; each party's outcome, settled.
async function oneRound(
  senderRecords: number,
  sender: PsiSetCeilings,
  receiver: PsiSetCeilings,
) {
  const [senderEnd, receiverEnd] = createMessagePipe();
  const senderSide = observed(senderEnd);
  const receiverSide = observed(receiverEnd);
  const declared = { receiverRecords: 3, senderRecords };
  const run = (
    side: ReturnType<typeof observed>,
    party: PSIParticipant,
    values: Array<string>,
  ) =>
    linkViaCountOnlyPSI(party, side.conn, [values], false, 3, declared).catch(
      (error: unknown) => {
        side.conn.close();
        throw error;
      },
    );
  const senderParty = participant("starter", sender);
  const receiverParty = participant("joiner", receiver);
  const [senderOutcome, receiverOutcome] = await Promise.allSettled([
    run(
      senderSide,
      senderParty,
      Array.from({ length: senderRecords }, (_, i) => `s${String(i)}`),
    ),
    run(receiverSide, receiverParty, ["s0", "r1", "r2"]),
  ]);
  senderParty.dispose();
  receiverParty.dispose();
  return { senderOutcome, receiverOutcome, senderSide, receiverSide };
}

const binaryFrames = (frames: Array<unknown>): Array<unknown> =>
  frames.filter((frame) => frame instanceof Uint8Array);

test("a sender over the partner's ceiling sends neither its setup nor its index table", async () => {
  const unlimited = {
    local: MAX_PSI_DECODE_ELEMENTS,
    partner: MAX_PSI_DECODE_ELEMENTS,
  };
  const { senderOutcome, senderSide } = await oneRound(
    4,
    { local: MAX_PSI_DECODE_ELEMENTS, partner: 3 },
    unlimited,
  );
  expect(senderOutcome.status).toBe("rejected");
  expect((senderOutcome as PromiseRejectedResult).reason).toBeInstanceOf(
    RoundSetLimitError,
  );
  expect(binaryFrames(senderSide.sent)).toEqual([]);
});

test("a receiver refuses a setup over its own ceiling before reading the index table", async () => {
  const unlimited = {
    local: MAX_PSI_DECODE_ELEMENTS,
    partner: MAX_PSI_DECODE_ELEMENTS,
  };
  const { receiverOutcome, senderSide, receiverSide } = await oneRound(
    4,
    unlimited,
    { local: 3, partner: MAX_PSI_DECODE_ELEMENTS },
  );
  expect(receiverOutcome.status).toBe("rejected");
  expect((receiverOutcome as PromiseRejectedResult).reason).toBeInstanceOf(
    RoundCapacityError,
  );
  // The sender sent its setup in one part and the table after it; the
  // receiver read the part alone.
  expect(binaryFrames(senderSide.sent)).toHaveLength(2);
  expect((binaryFrames(senderSide.sent)[1] as Uint8Array).byteLength).toBe(
    4 * ENTRY_BYTES,
  );
  expect(receiverSide.read()).toBe(1);
  expect(binaryFrames(receiverSide.sent)).toEqual([]);
});

test("within both ceilings the round runs, and its table has one entry per sender record", async () => {
  const ceilings = { local: 4, partner: 4 };
  const { senderOutcome, receiverOutcome, senderSide } = await oneRound(
    4,
    ceilings,
    ceilings,
  );
  expect(senderOutcome.status).toBe("fulfilled");
  expect(receiverOutcome).toEqual({ status: "fulfilled", value: 1 });
  expect((binaryFrames(senderSide.sent)[1] as Uint8Array).byteLength).toBe(
    4 * ENTRY_BYTES,
  );
});
