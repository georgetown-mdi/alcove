import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import type { PSIParticipant } from "../../src/psi/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  withholdsSenderAssociationTable,
  exchangeMappedElements,
  mappedElementEntryBytes,
  mappedElementSource,
  receiveResolvedTable,
  resolvedTableSource,
  sendResolvedTable,
  returnedElementSource,
  encodeInt32LE,
  decodeInt32LE,
  encodeSinglePassReply,
  decodeSinglePassReply,
  getDistinctValuesAndIndices,
  type LinkageCardinality,
  type SinglePassSessionBounds,
} from "../../src/psi/link";
import { MAX_WEBRTC_FRAME_BYTES } from "../../src/connection/binaryPackBounds";
import {
  binaryPackByteStringLength,
  webrtcFrameExceedsBound,
} from "../../src/connection/webrtcOutboundBound";
import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../../src/fanOutFunctions";
import { type LinkageStrategy } from "../../src/config/linkageTermsSchema";
import {
  candidateSetIsImplementedForStrategy,
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY,
} from "../../src/linkageTermsPolicy";
import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_FRAME_SIZE_BYTES,
} from "../../src/connection/frameSize";
import {
  failureCauseOf,
  singlePassOverLimitRemedy,
} from "../../src/failureCause";
import { formatCount } from "../../src/utils/formatCount";
import {
  singlePassCeilingBreach,
  singlePassDatasetExceedsCap,
  singlePassReplyByteCap,
  singlePassRequestByteCap,
} from "../../src/psi/singlePassSizing";
import { MAX_AEAD_FRAME_BYTES } from "../../src/connection/encryptedMessageConnection";

import {
  createMessagePipe,
  fromEventConnection,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import {
  MESSAGE_TYPE_OBJECT,
  serializeFileSyncMessage,
} from "../../src/connection/fileSyncFraming";
import { makeConnectedConn } from "../utils/fileSyncConnectionFixture";
import type { AssociationTable } from "../../src/types";
import {
  InternalConsistencyError,
  ProtocolRefusalError,
  UsageError,
  ConnectionError,
  RoundSetLimitError,
  statesItsOwnNextStep,
  PeerAbortError,
} from "../../src/errors";
import {
  ABORT_REASONS_AFTER_TERMS,
  MAX_ABORT_FRAME_AFTER_TERMS_BYTES,
  decisionOnlyAbortFrame,
  PSI_SET_REFUSED_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
} from "../../src/partnerAbortFrame";
import { sortAssociationTable } from "../../src/testing";
import { ISSUES_URL } from "../../src/projectLinks";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import { partFrame, readPartFrame } from "../utils/matchedListPartFrames";
import { sendMatchedList } from "../../src/psi/matchedListParts";
import {
  MAPPED_ELEMENT_LAYOUT,
  RESOLVED_TABLE_LAYOUT,
  RETURNED_ELEMENT_LAYOUT,
  receiveWordList,
} from "../../src/psi/uint32ListParts";
import { mirrorCardinality } from "../utils/candidateSetBounds";
import { makeMockClient, makeParticipant } from "../utils/support";

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = makeParticipant(psiLibrary, "starter");

const client = makeParticipant(psiLibrary, "joiner");

const serverData = [
  ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
  ["1", "2", "1", "1", "1", "1", "1"],
];

const clientData = [
  ["Carol", "Elizabeth", "Henry"],
  ["3", "3", "2"],
];

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      fanOutFreeBounds(serverData.length, clientData[0].length),
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      fanOutFreeBounds(clientData.length, serverData[0].length),
      -1,
    ),
  ]);
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test("server and client yield identical results", () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("results are correct", () => {
  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
});

// A deduplicating cardinality keeps the "many" side's within-dataset duplicate
// values in the round, so it changes the table only where such a value MATCHES.
// This dataset has one (the server's repeated "1" under the second key) and the
// client holds no "1", so the deduplicating run reproduces the one-to-one table
// exactly -- the property that keeps the widening confined to matched groups.
// The many-to-one matching itself is exercised in linkManyToOne.test.ts.
test("a deduplicating cardinality leaves an unmatched duplicate group's table unchanged", async () => {
  const [mServerConn, mClientConn] = createMessagePipe();
  const mServer = makeParticipant(psiLibrary, "starter");
  const mClient = makeParticipant(psiLibrary, "joiner");

  let [mServerResult, mClientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "many-to-one" },
      mServer,
      mServerConn,
      serverData,
      fanOutFreeBounds(serverData.length, clientData[0].length),
      -1,
    ),
    // The partner's view of the same exchange is the mirror label.
    linkViaPSI(
      { cardinality: "one-to-many" },
      mClient,
      mClientConn,
      clientData,
      fanOutFreeBounds(clientData.length, serverData[0].length),
      -1,
    ),
  ]);

  mServerResult = sortAssociationTable(mServerResult);
  mClientResult = sortAssociationTable(mClientResult, true);

  expect(mServerResult).toStrictEqual(serverResult);
  expect(mClientResult).toStrictEqual(clientResult);
});

// many-to-many applies the "many" side's rules to both parties, so a matched value
// stands for a group on each side and contributes the two groups' product. Both
// strategies pair that, over the same rows; linkManyToMany.test.ts holds each
// strategy's behavior at length.
test("many-to-many pairs in the cascade", async () => {
  const bothSided = [["E1", "E1"]];
  const [starterConn, joinerConn] = createMessagePipe();
  const [starter, joiner] = await Promise.all([
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant(psiLibrary, "starter"),
      starterConn,
      bothSided,
      fanOutFreeBounds(bothSided.length, 2),
      -1,
    ),
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant(psiLibrary, "joiner"),
      joinerConn,
      bothSided,
      fanOutFreeBounds(bothSided.length, 2),
      -1,
    ),
  ]);
  // Both of each party's rows hold the one value, so every one of the four pairs
  // between the two groups is in the table, on both parties alike.
  expect(starter).toStrictEqual([
    [0, 0, 1, 1],
    [0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual(starter);
});

// --- linkViaSinglePassPSI: parity with the cascade ----------------------------
// Single-pass batches every key into one exchange and has the receiver
// reconstruct the cascade locally; it must produce the byte-identical association
// table linkViaPSI would for the same inputs. Run both roles over a fresh pipe and
// compare against the cascade results computed above.
test("single-pass yields the byte-identical association table as the cascade", async () => {
  const [spServerConn, spClientConn] = createMessagePipe();
  const spServer = makeParticipant(psiLibrary, "starter");
  const spClient = makeParticipant(psiLibrary, "joiner");

  let [spServerResult, spClientResult] = await Promise.all([
    // partnerRecordCount: the server's partner is the client (3 rows) and vice
    // versa (the server has 7 rows).
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spServer,
      spServerConn,
      serverData,
      fanOutFreeBounds(serverData.length, clientData[0].length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spClient,
      spClientConn,
      clientData,
      fanOutFreeBounds(clientData.length, serverData[0].length),
      false,
      -1,
    ),
  ]);

  spServerResult = sortAssociationTable(spServerResult);
  spClientResult = sortAssociationTable(spClientResult, true);

  // Identical to the cascade, on both sides.
  expect(spServerResult).toStrictEqual(serverResult);
  expect(spClientResult).toStrictEqual(clientResult);

  // Internally consistent: each party's locals are the other's partners.
  expect(spServerResult[0]).toStrictEqual(spClientResult[1]);
  expect(spServerResult[1]).toStrictEqual(spClientResult[0]);
});

// --- linkViaSinglePassPSI: survivor-relative (contention) uniqueness ----------
// Uniqueness is evaluated over the records still unmatched at each round, not the
// full dataset, so a value duplicated across the whole data becomes matchable once
// an earlier key claims its twin. Here the sender's "Z" is duplicated (rows 0, 1),
// but row 0 matches on key 1, leaving "Z" unique among key 2's survivors so row 1
// matches too. A reconstruction that used full-dataset uniqueness would drop "Z"
// and miss row 1; the expected table pins the survivor-relative behavior.
test("single-pass reproduces the cascade's survivor-relative uniqueness", async () => {
  const senderData = [
    ["A", "B"],
    ["Z", "Z"],
  ];
  const receiverData = [
    ["A", undefined],
    [undefined, "Z"],
  ];

  // Both parties have two rows, so each side's partner count is 2; the link
  // adapter folds that in for single-pass and is a no-op for the cascade, which
  // takes no partner count.
  const run = async (
    link: (
      protocol: { cardinality: "one-to-one" },
      participant: PSIParticipant,
      conn: MessageConnection,
      data: Array<Array<string | undefined>>,
    ) => Promise<AssociationTable>,
  ) => {
    const [senderConn, receiverConn] = createMessagePipe();
    const sender = makeParticipant(psiLibrary, "starter");
    const receiver = makeParticipant(psiLibrary, "joiner");
    const [senderResult, receiverResult] = await Promise.all([
      link({ cardinality: "one-to-one" }, sender, senderConn, senderData),
      link({ cardinality: "one-to-one" }, receiver, receiverConn, receiverData),
    ]);
    return [
      sortAssociationTable(senderResult),
      sortAssociationTable(receiverResult, true),
    ];
  };

  const [cascadeSender, cascadeReceiver] = await run((protocol, p, c, d) =>
    linkViaPSI(protocol, p, c, d, fanOutFreeBounds(d.length, 2), -1),
  );
  // Both sender rows match -- reachable only under survivor-relative uniqueness.
  expect(cascadeSender).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);

  const [singlePassSender, singlePassReceiver] = await run(
    (protocol, p, c, d) =>
      linkViaSinglePassPSI(
        protocol,
        p,
        c,
        d,
        fanOutFreeBounds(d.length, 2),
        false,
        -1,
      ),
  );
  expect(singlePassSender).toStrictEqual(cascadeSender);
  expect(singlePassReceiver).toStrictEqual(cascadeReceiver);
});

// --- the cascade: which candidate sets reach a round -------------------------
// Key realization holds every candidate a record realizes (buildKeyStrings).
// One reading decides whether a round consumes one: an allowlist over the
// strategies whose resolution is written. A strategy outside it refuses the
// record where it would consume it rather than narrowing to one candidate or
// dropping it, either of which matches on less than the terms declare.

test("the allowlist is what decides, one entry per strategy", () => {
  expect(CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY).toStrictEqual({
    cascade: true,
    "single-pass": true,
  });
  for (const strategy of Object.keys(
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY,
  ) as Array<LinkageStrategy>)
    expect(candidateSetIsImplementedForStrategy(strategy)).toBe(
      CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY[strategy],
    );
});

test("the cascade resolves a candidate set, and its entry is what decides", async () => {
  // The round reads the table rather than naming a strategy, so closing the
  // cascade's entry returns the fail-closed refusal a strategy with no written
  // resolution meets. The resolution behind the open entry is exercised at
  // length in cascadeCandidateSets.test.ts.
  const withCandidateSet: Array<Array<string | Set<string> | undefined>> = [
    [new Set(["B", "C"])],
  ];
  const link = async (): Promise<AssociationTable> => {
    const [starterConn, joinerConn] = createMessagePipe();
    const [starterTable] = await Promise.all([
      linkViaPSI(
        { cardinality: "one-to-one" },
        makeParticipant(psiLibrary, "starter"),
        starterConn,
        withCandidateSet,
        fanOutFreeBounds(1, 1),
        -1,
      ),
      linkViaPSI(
        { cardinality: "one-to-one" },
        makeParticipant(psiLibrary, "joiner"),
        joinerConn,
        [["C"]],
        fanOutFreeBounds(1, 1),
        -1,
      ),
    ]);
    return starterTable;
  };

  expect(await link()).toStrictEqual([[0], [0]]);

  const shipped = CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade;
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = false;
  try {
    await expect(link()).rejects.toThrow(UsageError);
  } finally {
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = shipped;
  }
});

test("single-pass refuses a candidate set wider than its declaration admits", async () => {
  // The sibling refusal on the strategy that DOES match a candidate set: the slot
  // bound the partner's element bounds, read gate, and decode all rest on comes
  // from this party's advertised effective key count, so a row realizing more
  // candidates than that advertisement accounts for is refused as the table is
  // built rather than shipped under a bound it exceeds. Here the declaration is
  // the plain key count -- the fan-out-free advertisement -- and the row holds
  // two candidates.
  const withCandidateSet: Array<Array<string | Set<string> | undefined>> = [
    ["A", new Set(["B", "C"])],
  ];
  const [conn] = createMessagePipe();
  const participant = makeParticipant(psiLibrary, "starter");
  const run = () =>
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      participant,
      conn,
      withCandidateSet,
      fanOutFreeBounds(1, 1),
      false,
      -1,
    );
  await expect(run()).rejects.toThrow(UsageError);
  await expect(run()).rejects.toThrow(/fan-out/);
});

test("a single-candidate row is unaffected by that refusal", async () => {
  // The sibling that keeps the refusal from swallowing ordinary rows: a realized
  // singleton reaches a strategy as a bare string, and "" is a real value.
  const senderData = [["A", ""]];
  const receiverData = [["A", ""]];
  const [senderConn, receiverConn] = createMessagePipe();
  const sender = makeParticipant(psiLibrary, "starter");
  const receiver = makeParticipant(psiLibrary, "joiner");
  const [senderResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      sender,
      senderConn,
      senderData,
      fanOutFreeBounds(senderData.length, 2),
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      receiver,
      receiverConn,
      receiverData,
      fanOutFreeBounds(receiverData.length, 2),
      -1,
    ),
  ]);
  expect(sortAssociationTable(senderResult)).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

// --- linkViaSinglePassPSI: withholding the sender's table from a blind helper --
// A non-receiving helper (expectsOutput false) disclosing no payload needs nothing
// back, so the receiver suppresses message 3 (the sender's association-table half)
// ENTIRELY and the sender skips awaiting it. Both parties derive the same decision
// from authenticated session state (withholdsSenderAssociationTable), so the
// suppress and the skip stay in lockstep and neither hangs.

test("withholdsSenderAssociationTable withholds only for a non-receiving, no-payload sender", () => {
  // The gating predicate both parties evaluate, exercised directly on all three
  // cases. Because it is a pure function of the resolved sender's output
  // entitlement and its payload-intent flag -- state both parties hold identically
  // -- the receiver (deciding to suppress) and the sender (deciding to skip) always
  // reach the same verdict, whichever side calls it.
  // Entitled to output: always deliver, regardless of payload intent.
  expect(withholdsSenderAssociationTable(true, false)).toBe(false);
  expect(withholdsSenderAssociationTable(true, true)).toBe(false);
  // No output but discloses payload: still delivered -- it needs its matched rows.
  expect(withholdsSenderAssociationTable(false, true)).toBe(false);
  // No output AND no payload: the one closeable case -- withhold.
  expect(withholdsSenderAssociationTable(false, false)).toBe(true);
});

// Run a single-pass exchange over a fresh pipe, capturing every frame the SENDER
// (starter) receives AND every frame the RECEIVER (joiner) sends, so a test can
// assert -- from both ends -- whether message 3 (the resolved table) ever
// crosses the wire. Capturing the receiver's OUTBOUND is what catches a
// regression that sends an empty table instead of suppressing the frame: the
// sender's inbound alone would miss it, since a withholding sender never awaits
// that frame.
const isResolvedTable = (frame: unknown): boolean =>
  readPartFrame(frame)?.layout === RESOLVED_TABLE_LAYOUT;

async function runSinglePassCapturingFrames(
  senderSet: Array<string>,
  receiverSet: Array<string>,
  withhold: boolean,
  senderCardinality: LinkageCardinality = "one-to-one",
): Promise<{
  senderResult: AssociationTable;
  receiverResult: AssociationTable;
  senderInbound: Array<unknown>;
  receiverOutbound: Array<unknown>;
}> {
  const [sConn, cConn] = createMessagePipe();
  const senderInbound: Array<unknown> = [];
  const receiverOutbound: Array<unknown> = [];
  const capturingSenderConn: MessageConnection = {
    send: (m: unknown) => sConn.send(m),
    receive: async (timeoutMs?: number) => {
      const frame = await sConn.receive(timeoutMs);
      senderInbound.push(frame);
      return frame;
    },
    close: () => sConn.close(),
  };
  const capturingReceiverConn: MessageConnection = {
    send: (m: unknown) => {
      receiverOutbound.push(m);
      return cConn.send(m);
    },
    receive: (timeoutMs?: number) => cConn.receive(timeoutMs),
    close: () => cConn.close(),
    setInboundFrameCap: cConn.setInboundFrameCap?.bind(cConn),
  };
  const sp = makeParticipant(psiLibrary, "starter");
  const cp = makeParticipant(psiLibrary, "joiner");
  const [senderResult, receiverResult] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: senderCardinality },
      sp,
      capturingSenderConn,
      [senderSet],
      fanOutFreeBounds(1, receiverSet.length),
      withhold,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: mirrorCardinality(senderCardinality) },
      cp,
      capturingReceiverConn,
      [receiverSet],
      fanOutFreeBounds(1, senderSet.length),
      withhold,
      -1,
    ),
  ]);
  return { senderResult, receiverResult, senderInbound, receiverOutbound };
}

test("single-pass withholding keeps a blind helper's table off the wire; the receiver is unaffected", async () => {
  const senderSet = ["A", "B", "C"];
  const receiverSet = ["B", "C", "D"];
  const base = await runSinglePassCapturingFrames(
    senderSet,
    receiverSet,
    false,
  );
  const held = await runSinglePassCapturingFrames(senderSet, receiverSet, true);

  // Withholding changes only the helper's blindness, never the receiver's own
  // resolved table: the receiver computes the identical result either way.
  expect(held.receiverResult).toStrictEqual(base.receiverResult);
  expect(base.receiverResult[0]).toHaveLength(2); // B, C overlap

  // Baseline (deliver): the helper receives its table -- two inbound frames, the
  // request then the resolved table -- and learns its two matches. The
  // receiver sent that table frame.
  expect(base.senderResult[0]).toHaveLength(2);
  expect(base.senderInbound).toHaveLength(2);
  expect(base.senderInbound.some(isResolvedTable)).toBe(true);
  expect(base.receiverOutbound.some(isResolvedTable)).toBe(true);

  // Withheld: the helper is blind -- it returns an empty table and its
  // process never receives message 3. Its only inbound frame is the receiver's
  // request (a Uint8Array); no association-table frame ever reaches it. The run
  // completed (Promise.all resolved), proving neither side hung on the skipped frame.
  expect(held.senderResult).toStrictEqual([[], []]);
  expect(held.senderInbound).toHaveLength(1);
  expect(held.senderInbound[0]).toBeInstanceOf(Uint8Array);
  expect(held.senderInbound.some(isResolvedTable)).toBe(false);

  // Enforced from the RECEIVER's side too: it never SENT any association-table
  // frame -- not even an empty [[], []]. An "optimization" that emitted an empty
  // table instead of suppressing the frame (the count-leaking regression the design
  // forbids) would send a table here and fail this assertion, which the sender's
  // inbound alone -- a withholding sender never awaits the frame -- would not catch.
  expect(held.receiverOutbound.some(isResolvedTable)).toBe(false);
});

test("a deduplicating cardinality does not move the withholding rule", async () => {
  // The rule reads the sender's output entitlement and payload intent, neither of
  // which the multiplicity touches -- and only one of the two deduplicating
  // arrangements can reach the withheld path at all. A "many" party must be
  // entitled to output (the linkage-terms schema refines it), so it is never a
  // non-receiving helper; a "one" party may be one, and role resolution then makes
  // it the SENDER, since the party entitled to output becomes the receiver. That
  // is the arrangement below: the helper stays blind while the "many" receiver
  // resolves the whole pairing, including the helper's own uniqueness rule.
  expect(withholdsSenderAssociationTable(true, false)).toBe(false);
  const held = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["B", "B", "C"],
    true,
    "one-to-many",
  );
  // The receiver's two "B" rows group onto the helper's single one, which is the
  // widening -- and the helper learns none of it: no table frame is sent, and it
  // returns the empty table.
  expect(held.receiverResult).toStrictEqual([
    [0, 1, 2],
    [1, 1, 2],
  ]);
  expect(held.senderResult).toStrictEqual([[], []]);
  expect(held.senderInbound).toHaveLength(1);
  expect(held.senderInbound[0]).toBeInstanceOf(Uint8Array);
  expect(held.receiverOutbound.some(isResolvedTable)).toBe(false);

  // Delivering it instead hands the helper the repeating half the widening
  // produces, which is the disclosure the withholding closes.
  const delivered = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["B", "B", "C"],
    false,
    "one-to-many",
  );
  expect(delivered.senderResult).toStrictEqual([
    [1, 1, 2],
    [0, 1, 2],
  ]);
});

test("single-pass withholding does not leak the match count by frame presence or size", async () => {
  // Empty-versus-populated indistinguishability: whether the intersection is
  // populated or empty, the blind helper observes the SAME inbound traffic -- one
  // request frame, no table frame -- so the match count cannot be read off the wire
  // it sees. Suppressing the frame entirely (rather than sending an empty table) is
  // what closes that channel: an empty-versus-populated table would leak the count
  // by its presence and size.
  // Both receivers hold the same number of distinct values (3), so the only thing
  // that differs between the two runs is the intersection size (2 vs 0).
  const populated = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["B", "C", "D"], // 2 matches
    true,
  );
  const empty = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["X", "Y", "Z"], // 0 matches
    true,
  );
  expect(populated.senderInbound).toHaveLength(1);
  expect(empty.senderInbound).toHaveLength(1);
  expect(populated.senderInbound.every((f) => f instanceof Uint8Array)).toBe(
    true,
  );
  expect(empty.senderInbound.every((f) => f instanceof Uint8Array)).toBe(true);
  // Not just presence: the sole inbound frame (the receiver's request) is
  // byte-identical in LENGTH across the two runs -- its size tracks the receiver's
  // distinct-value count, held constant here, never the match count. So neither the
  // presence nor the size of what the helper receives encodes the intersection size.
  expect((populated.senderInbound[0] as Uint8Array).byteLength).toBe(
    (empty.senderInbound[0] as Uint8Array).byteLength,
  );
  // The differing match counts (2 vs 0) are computed only by the receiver; the
  // helper stays blind to both.
  expect(populated.receiverResult[0]).toHaveLength(2);
  expect(empty.receiverResult[0]).toHaveLength(0);
  expect(populated.senderResult).toStrictEqual([[], []]);
  expect(empty.senderResult).toStrictEqual([[], []]);
});

// --- exchangeMappedElements: the joiner sends its list before any refusal ---
// A partner list refused at a part, on its header or on its body, is refused
// only after the joiner's own list is sent, so the partner is not left
// waiting for it.
test.each([
  [
    "a part whose body is not the length its counts state",
    partFrame([{ theirIndex: 0, iteration: 0 }]).subarray(0, -4),
    "part 0 is not the length its entry counts state",
  ],
  [
    "a part declaring more entries than admitted",
    partFrame([{ theirIndex: 0, iteration: 0 }], { entries: 5 }),
    "declares 5 entries, over the 4 this party admits",
  ],
  [
    "a part longer than its entries can be",
    partFrame([{ theirIndex: [0, 1, 2], iteration: 0 }]),
    "part 0 is over the 36 bytes this party admits for it",
  ],
])(
  "the joiner sends its own list before refusing %s",
  async (_label, frame, detail) => {
    const [joinerConn, partnerConn] = createMessagePipe();
    await partnerConn.send(frame);
    const own = [{ theirIndex: 1, iteration: 0 }];
    const outcome = await exchangeMappedElements(
      "client",
      joinerConn,
      { info: () => {}, debug: () => {} },
      false,
      mappedElementSource(own),
      () =>
        receiveWordList(
          joinerConn,
          "client",
          "mapped-element list",
          { entries: 4, entryBytes: mappedElementEntryBytes(1) },
          [MAPPED_ELEMENT_LAYOUT],
        ),
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as Error).message).toBe(
      `client protocol error: inbound mapped-element list ${detail}`,
    );
    expect(readPartFrame(await partnerConn.receive(1000))?.body).toEqual(own);
  },
);

// The per-entry byte bound a mapped-element list's parts are held to is the
// bytes the widest entry an honest party writes takes, so no honest part is
// refused.
test.each([
  [0, { theirIndex: 9, iteration: 0 }],
  [1, { theirIndex: 999, iteration: 11 }],
  [3, { theirIndex: [997, 998, 999], iteration: 1 }],
  [20, { theirIndex: Array<number>(20).fill(0), iteration: 0 }],
] as Array<
  [number, { theirIndex: number | Array<number>; iteration: number }]
>)(
  "mappedElementEntryBytes(%i) is the bytes the widest such entry takes",
  (positions, widest) => {
    const source = mappedElementSource([widest]);
    expect(mappedElementEntryBytes(positions)).toBe(source.entryBytes(0));
  },
);

test("each mapped-element list round-trips, a list of positions and an empty list included", async () => {
  const first = [
    { theirIndex: 4, iteration: 0 },
    { theirIndex: [1, 2, 3], iteration: 1 },
  ];
  const returned = [
    { theirIndex: 7, iteration: 0 },
    { theirIndex: 2, iteration: 1 },
  ];
  const [a, b] = createMessagePipe();
  const bound = { entries: 2, entryBytes: mappedElementEntryBytes(3) };
  await sendMatchedList(a, mappedElementSource(first));
  await sendMatchedList(a, mappedElementSource([]));
  await sendMatchedList(a, returnedElementSource(returned));
  const read = await receiveWordList(b, "", "list", bound, [
    MAPPED_ELEMENT_LAYOUT,
  ]);
  expect([...read.columns[0]]).toEqual([0, 1]);
  expect([...read.counts]).toEqual([1, 3]);
  expect([...read.values]).toEqual([4, 1, 2, 3]);
  const empty = await receiveWordList(b, "", "list", bound, [
    MAPPED_ELEMENT_LAYOUT,
  ]);
  expect(empty.entries).toBe(0);
  const back = await receiveWordList(b, "", "list", bound, [
    RETURNED_ELEMENT_LAYOUT,
  ]);
  expect(back.columns).toHaveLength(1);
  expect([...back.columns[0]]).toEqual([7, 2]);
});

test("one mapped-element list is not read as the other", async () => {
  const [a, b] = createMessagePipe();
  await sendMatchedList(
    a,
    returnedElementSource([{ theirIndex: 0, iteration: 0 }]),
  );
  await expect(
    receiveWordList(b, "client", "mapped-element list", { entries: 1 }, [
      MAPPED_ELEMENT_LAYOUT,
    ]),
  ).rejects.toThrow(
    "client protocol error: inbound mapped-element list part 0 is not a " +
      "list of the kind awaited",
  );
});

test("a legitimately large mapped-element list of position lists round-trips", async () => {
  const n = 200_000;
  const list = Array.from({ length: n }, (_, i) => ({
    theirIndex: i % 2 === 0 ? i : [i, i + 1],
    iteration: 0,
  }));
  const [a, b] = createMessagePipe();
  await sendMatchedList(a, mappedElementSource(list));
  const read = await receiveWordList(
    b,
    "",
    "list",
    { entries: n, entryBytes: mappedElementEntryBytes(2) },
    [MAPPED_ELEMENT_LAYOUT],
  );
  expect(read.entries).toBe(n);
  expect(read.values).toHaveLength(n + n / 2);
});

test("the resolved table round-trips, and an empty one too", async () => {
  const [a, b] = createMessagePipe();
  await sendMatchedList(
    a,
    resolvedTableSource([
      [0, 2],
      [5, 1],
    ]),
  );
  await sendMatchedList(a, resolvedTableSource([[], []]));
  const bound = { entries: 2 };
  const read = await receiveWordList(b, "", "table", bound, [
    RESOLVED_TABLE_LAYOUT,
  ]);
  expect([...read.columns[0]]).toEqual([0, 2]);
  expect([...read.columns[1]]).toEqual([5, 1]);
  const empty = await receiveWordList(b, "", "table", bound, [
    RESOLVED_TABLE_LAYOUT,
  ]);
  expect(empty.entries).toBe(0);
});

test("the resolved table's parts are held, in all, to one frame's bound", async () => {
  // A part of n pairs is 16 + 8 + 8n bytes: two of one pair each fill a
  // 64-byte frame bound exactly, and two of two pairs each pass it.
  const deliverParts = async (perPart: number) => {
    const [a, b] = createMessagePipe();
    const entries = 2 * perPart;
    for (let index = 0; index < 2; index++) {
      const rows = Array.from({ length: perPart }, (_, k) => k + index);
      await a.send(
        partFrame(
          [rows, rows],
          { index, count: 2, entries },
          RESOLVED_TABLE_LAYOUT,
        ),
      );
    }
    const conn: MessageConnection = {
      send: (data) => b.send(data),
      receive: (timeoutMs?: number) => b.receive(timeoutMs),
      close: () => b.close(),
      outboundWebRtcFrameBound: () => 64,
    };
    return receiveResolvedTable(conn, "sender", entries);
  };
  expect(await deliverParts(1)).toEqual([
    [0, 1],
    [0, 1],
  ]);
  const err = await deliverParts(2).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as Error).message).toBe(
    "sender protocol error: inbound resolved association table part 1 is " +
      "over the 24 bytes this party admits for it",
  );
});

test("the resolved table is sent only if its parts total within one frame's bound", async () => {
  const sendAt64 = async (pairs: number) => {
    const sent: Array<unknown> = [];
    const conn: MessageConnection = {
      send: (data) => {
        sent.push(data);
        return Promise.resolve();
      },
      receive: () => Promise.reject(new Error("unused")),
      close: () => Promise.resolve(),
      outboundWebRtcFrameBound: () => 64,
    };
    const column = Array.from({ length: pairs }, (_, k) => k);
    const outcome = await sendResolvedTable(conn, [column, column]).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { sent, outcome };
  };
  // A part of n pairs is 16 + 8 + 8n bytes, so four pairs fit in one part
  // of 56 bytes; five need two parts of 88 bytes in all.
  const fits = await sendAt64(4);
  expect(fits.outcome).toBeUndefined();
  expect(fits.sent).toHaveLength(1);
  const over = await sendAt64(5);
  expect(over.sent).toStrictEqual([
    { decision: "abort", abortReasons: [PSI_SET_REFUSED_ABORT_REASON] },
  ]);
  expect(over.outcome).toBeInstanceOf(UsageError);
  expect((over.outcome as Error).message).toBe(
    "This exchange found 5 matches, more than the 4 it can send, so it " +
      "stopped and told your partner.",
  );
  expect(failureCauseOf(over.outcome)).toStrictEqual({
    kind: "matches-over-limit",
    list: "resolved",
    matchCount: 5,
    limitMatches: 4,
  });
});

// --- single-pass reply codec and the receiver's frame-length tie --------------
// Message 2 -- setup, response, record count, and the distinct-value index table
// -- is one binary frame; these pin the codec round-trip and the fail-closed
// gates that guard it (the channel-hardening controls).
test("encodeInt32LE / decodeInt32LE round-trip, and a non-aligned frame is rejected", () => {
  const values = [-1, 0, 1, 7, 2_000_000_000];
  expect(Array.from(decodeInt32LE(encodeInt32LE(values)))).toEqual(values);
  // A length that is not a whole number of int32s is a clean error, not a silent
  // truncation -- the decode guard for the partner-supplied index table.
  expect(() => decodeInt32LE(new Uint8Array(3))).toThrow(/int32/);
  expect(() => decodeInt32LE(new Uint8Array(3))).toThrow(ProtocolRefusalError);
});

test("encodeSinglePassReply / decodeSinglePassReply round-trip, and a truncated frame is rejected", () => {
  const setup = new Uint8Array([10, 20, 30]);
  const response = new Uint8Array([40, 50]);
  const indices = [-1, 0, 7, 2_000_000_000];
  const out = decodeSinglePassReply(
    encodeSinglePassReply(setup, response, 4, indices),
  );
  expect(Array.from(out.setup)).toEqual([10, 20, 30]);
  expect(Array.from(out.response)).toEqual([40, 50]);
  expect(out.numRecords).toBe(4);
  expect(Array.from(out.distinctValueIndices)).toEqual(indices);
  // A frame cut short of a length it declares is a clean protocol error, not a
  // silent under-read.
  const full = encodeSinglePassReply(setup, response, 4, indices);
  expect(() => decodeSinglePassReply(full.subarray(0, 5))).toThrow(/truncated/);
  expect(() => decodeSinglePassReply(full.subarray(0, 5))).toThrow(
    ProtocolRefusalError,
  );
});

// --- single-pass dataset ceiling: derived from exchanged counts ---------------
// A browser party's ceiling is a per-party budget on effectiveKeyCount *
// recordCount -- the value slot count, the distinct-value upper bound -- with
// the read-gate/send-time byte cap derived from the same quantity. These pin
// the deterministic arithmetic both parties compute.
const CEILING = BROWSER_PSI_SET_MAX_ELEMENTS;
const inBrowser = (
  bounds: SinglePassSessionBounds,
): SinglePassSessionBounds => ({
  ...bounds,
  valueSlotCeiling: CEILING,
});

test("singlePassDatasetExceedsCap fires exactly at slots = the budget", () => {
  const fits = Math.floor(CEILING / 1); // one key
  expect(singlePassDatasetExceedsCap(1, fits, CEILING)).toBe(false);
  expect(singlePassDatasetExceedsCap(1, fits + 1, CEILING)).toBe(true);
  // The budget is on slots, so more keys fit proportionally fewer rows.
  const perKey = Math.floor(CEILING / 4);
  expect(singlePassDatasetExceedsCap(4, perKey, CEILING)).toBe(false);
  expect(singlePassDatasetExceedsCap(4, perKey + 1, CEILING)).toBe(true);
  // A key that fans out counts its whole declared width toward the same
  // unchanged budget, so it buys its width with rows: four keys of which one fans
  // out is an effective key count of 23.
  const perSlot = Math.floor(CEILING / 23);
  expect(singlePassDatasetExceedsCap(23, perSlot, CEILING)).toBe(false);
  expect(singlePassDatasetExceedsCap(23, perSlot + 1, CEILING)).toBe(true);
});

test("singlePassCeilingBreach fires when EITHER party is over the budget", () => {
  const fits = CEILING; // one key, exactly at the budget
  const size = (recordCount: number, effectiveKeyCount = 1) => ({
    effectiveKeyCount,
    recordCount,
  });
  expect(singlePassCeilingBreach(size(fits), size(fits), CEILING)).toBe(
    undefined,
  );
  // One over, the other under -> over, attributed to the one over.
  expect(singlePassCeilingBreach(size(fits + 1), size(1), CEILING)).toBe(
    "local",
  );
  expect(singlePassCeilingBreach(size(1), size(fits + 1), CEILING)).toBe(
    "partner",
  );
  // A fan-out on one side alone takes that side over: the same row count against
  // an effective key count of 20 is 20x the slots.
  const perKey = Math.floor(fits / 20);
  expect(
    singlePassCeilingBreach(size(perKey, 20), size(perKey, 20), CEILING),
  ).toBe(undefined);
  expect(
    singlePassCeilingBreach(size(perKey + 1, 20), size(perKey, 20), CEILING),
  ).toBe("local");
});

test("singlePassReplyByteCap weights the sender heavier and charges the ragged table on top", () => {
  // The sender contributes a masked value + an index word per value slot; the
  // receiver a masked value per value slot; plus a fixed overhead. Pinning the
  // exact formula is what makes the cap reproducible across implementations.
  const size = (recordCount: number, effectiveKeyCount: number) => ({
    effectiveKeyCount,
    recordCount,
  });
  expect(singlePassReplyByteCap(2, size(10, 2), size(5, 2))).toBe(
    (40 + 4) * (2 * 10) + 40 * (2 * 5) + 4 * (2 * 10) + 256,
  );
  // The two arguments are NOT interchangeable: the sender includes the index
  // table (+4/slot), so swapping the sender and receiver sizes changes the
  // value. This is why both parties must agree on which size is the sender's --
  // the role mapping in linkViaSinglePassPSI feeds (sender, receiver) in the
  // same order on both sides, so they compute the identical cap from swapped
  // local inputs (own vs partner size).
  expect(singlePassReplyByteCap(3, size(100, 3), size(200, 3))).not.toBe(
    singlePassReplyByteCap(3, size(200, 3), size(100, 3)),
  );
  // The ragged table's per-cell count prefix is charged on every exchange, on the
  // sender's cells alone: a party whose own standardization fans out ships that
  // layout while the agreed terms show no width at all, so no function of those
  // terms can tell in advance which layout a legitimate sender will ship. The
  // receiver's own width adds nothing beyond its slots, since it ships no index
  // table.
  expect(singlePassReplyByteCap(1, size(10, 20), size(5, 1))).toBe(
    (40 + 4) * (20 * 10) + 40 * (1 * 5) + 4 * (1 * 10) + 256,
  );
  expect(singlePassReplyByteCap(1, size(10, 1), size(5, 20))).toBe(
    (40 + 4) * (1 * 10) + 40 * (20 * 5) + 4 * (1 * 10) + 256,
  );
  // At the same slot budget, a narrow sender's cap exceeds a wider one's: its
  // slots are spread over more records, so its cells cost the same while its
  // count prefixes cost more.
  const slots = 3_000_000;
  const atCeiling = singlePassReplyByteCap(
    1,
    { effectiveKeyCount: 1, recordCount: slots },
    { effectiveKeyCount: 1, recordCount: slots },
  );
  const atFanOutCeiling = singlePassReplyByteCap(
    1,
    {
      effectiveKeyCount: FAN_OUT_CANDIDATES_PER_ELEMENT,
      recordCount: slots / FAN_OUT_CANDIDATES_PER_ELEMENT,
    },
    { effectiveKeyCount: 1, recordCount: slots },
  );
  expect(atFanOutCeiling).toBeLessThan(atCeiling);
});

test("a reply a browser party's ceiling admits can pass one frame, so it is sent in parts", () => {
  const party = { effectiveKeyCount: 1, recordCount: CEILING };
  const replyCap = singlePassReplyByteCap(1, party, party);
  expect(replyCap).toBeGreaterThan(MAX_WEBRTC_FRAME_BYTES);
  expect(webrtcFrameExceedsBound(binaryPackByteStringLength(replyCap))).toBe(
    true,
  );
});

test("the single-pass receiver read gate is bounded to the derived reply cap", async () => {
  // The receiver tightens its transport read gate to singlePassReplyByteCap
  // before reading the reply (setInboundFrameCap), then clears it. A fake
  // MessageConnection records the cap set/cleared around the reply receive.
  const setCalls: Array<number | undefined> = [];
  let resolveReceive: ((v: unknown) => void) | undefined;
  const receiver = makeParticipant(psiLibrary, "joiner");
  const keyCount = 1;
  const localRows = 3;
  const partnerRows = 2;
  const fake: MessageConnection = {
    send: async () => {},
    receive: () =>
      new Promise((resolve) => {
        resolveReceive = resolve;
      }),
    close: async () => {},
    setInboundFrameCap: (maxBytes) => setCalls.push(maxBytes),
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    fake,
    [["a", "b", "c"]],
    fanOutFreeBounds(keyCount, partnerRows),
    false,
    -1,
  );
  // Let the receiver send its request and park on receive(); then deliver a reply
  // declaring partnerRows sender records but a mismatched index table, so decode
  // fails fast after the gate is exercised.
  await new Promise((r) => setTimeout(r, 0));
  const senderSize = { effectiveKeyCount: keyCount, recordCount: partnerRows };
  const receiverSize = { effectiveKeyCount: keyCount, recordCount: localRows };
  // Before masking, the response term is the request cap; once the request
  // is built, the request itself: three distinct values. Each gate is the
  // message file around the reply, with its 10-byte header.
  expect(setCalls.slice(0, 2)).toEqual([
    singlePassReplyByteCap(
      keyCount,
      senderSize,
      receiverSize,
      singlePassRequestByteCap(receiverSize),
    ) + 10,
    singlePassReplyByteCap(keyCount, senderSize, receiverSize, 3 * 35 + 2) + 10,
  ]);
  resolveReceive?.(
    encodeSinglePassReply(new Uint8Array(), new Uint8Array(), partnerRows, [0]),
  );
  await expect(run).rejects.toThrow();
  // The cap was cleared (undefined) after the read, so a later frame uses the
  // default gate.
  expect(setCalls[setCalls.length - 1]).toBeUndefined();
});

test("a single-pass reply queued before the request is sent is held to the derived cap", async () => {
  // The peer's reply is already waiting when the receiver starts, so the read
  // gate has to be tightened before the request goes out, and a transport that
  // does not apply the gate still meets the length check after the read.
  const events: Array<string> = [];
  const keyCount = 1;
  const localRows = 3;
  const partnerRows = 2;
  const receiverSize = { effectiveKeyCount: keyCount, recordCount: localRows };
  // Three distinct values fill the request cap, so the cap set before the
  // request is built and the one set after it agree.
  const replyCap = singlePassReplyByteCap(
    keyCount,
    { effectiveKeyCount: keyCount, recordCount: partnerRows },
    receiverSize,
    singlePassRequestByteCap(receiverSize),
  );
  const receiver = makeParticipant(psiLibrary, "joiner");
  const fake: MessageConnection = {
    send: async () => {
      events.push("send");
    },
    receive: async () => new Uint8Array(replyCap + 1),
    close: async () => {},
    setInboundFrameCap: (maxBytes) => {
      events.push(`cap:${String(maxBytes)}`);
    },
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    fake,
    [["a", "b", "c"]],
    fanOutFreeBounds(keyCount, partnerRows),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    `client protocol error: the single-pass reply is ${replyCap + 1} byte(s), ` +
      `above the ${replyCap} byte(s) both parties derive from their declared sizes`,
  );
  expect(events).toEqual([
    `cap:${replyCap + 10}`,
    `cap:${replyCap + 10}`,
    "send",
    "cap:undefined",
  ]);
});

test("the single-pass sender refuses a built reply above the derived cap", async () => {
  // The sender-side half of the same cap: before sending, it measures the reply it built
  // against singlePassReplyByteCap -- the same bound the receiver tightens its read gate
  // to -- so an over-cap frame never reaches a partner that would reject it. The
  // diagnosis is the builder-versus-derivation one, not the over-ceiling guidance: the
  // ceiling gate has already passed, so no dataset either operator controls stopped the
  // send, and the dataset remedies are withheld.
  //
  // Driven by a setup larger than the per-value figure the cap weighs it at.
  // Production reaches this safety check only on such an inconsistency between
  // the reply builder and the shared derivation.
  const keyCount = 1;
  const localRows = 1;
  const partnerRows = 1;
  const [conn, peer] = createMessagePipe();
  const sender = makeParticipant(psiLibrary, "starter");
  const partner = makeParticipant(psiLibrary, "joiner");
  vi.spyOn(sender, "createServerSetup").mockResolvedValue({
    setup: new Uint8Array(1_000),
    permutation: [0],
  });
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    sender,
    conn,
    [["a"]],
    fanOutFreeBounds(keyCount, partnerRows),
    false,
    -1,
  );
  const request = await partner.createClientRequest(["a"]);
  await peer.send(request);
  const error = await run.catch((e: unknown) => e);
  // The class the message's remedy implies: an internal fault to report, which
  // the CLI boundary maps to exit 70 (pinned in apps/cli/test/unit/util/cli.test.ts).
  // Not a UsageError, whose exit 64 would send the operator to an input the
  // ceiling gate has already cleared.
  expect(error).toBeInstanceOf(InternalConsistencyError);
  expect(error).not.toBeInstanceOf(UsageError);
  // The message ends in its own report-it step, so the instance is tagged and
  // the CLI adds no second one.
  expect(statesItsOwnNextStep(error, { ownOnly: true })).toBe(true);
  const message = (error as InternalConsistencyError).message;
  const replyCap = singlePassReplyByteCap(
    keyCount,
    { effectiveKeyCount: keyCount, recordCount: localRows },
    { effectiveKeyCount: keyCount, recordCount: partnerRows },
    request.byteLength,
  );
  // The size it names is the frame it actually built, and it is over the cap the
  // two parties derive -- the pair of numbers the message exists to report.
  const replyBytes = Number(
    /built a reply of (\d+) byte\(s\)/.exec(message)?.[1],
  );
  expect(replyBytes).toBeGreaterThan(replyCap);
  expect(message).toBe(
    `server: single-pass built a reply of ${replyBytes} byte(s), above the ` +
      `${replyCap} byte(s) both parties derive from their declared sizes, ` +
      "though both datasets are within the single-pass limit. Report it " +
      `at ${ISSUES_URL} with this message.`,
  );
  // The over-ceiling diagnosis and its dataset remedies stay out: neither operator
  // can move this by shrinking a dataset.
  expect(message).not.toMatch(/Reduce the record count/);
  expect(message).not.toMatch(/single-pass ceiling of/);
});

test("the single-pass sender holds the request to the cap the counts derive, before re-encrypting it", async () => {
  // Five slots put the request cap above the abort frame the gate admits.
  const partnerRows = 5;
  const requestCap = singlePassRequestByteCap({
    effectiveKeyCount: 1,
    recordCount: partnerRows,
  });
  expect(requestCap).toBe(35 * partnerRows + 2);
  expect(requestCap).toBeGreaterThan(MAX_ABORT_FRAME_AFTER_TERMS_BYTES);
  const events: Array<string> = [];
  const partner = makeParticipant(psiLibrary, "joiner");
  const overCap = await partner.createClientRequest([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
  const sender = makeParticipant(psiLibrary, "starter");
  const processed = vi.spyOn(sender, "processClientRequest");
  const createServerSetup = sender.createServerSetup.bind(sender);
  vi.spyOn(sender, "createServerSetup").mockImplementation((values) => {
    events.push("setup");
    return createServerSetup(values);
  });
  const fake: MessageConnection = {
    send: async () => {},
    receive: async () => {
      events.push("receive");
      return overCap;
    },
    close: async () => {},
    setInboundFrameCap: (maxBytes) => {
      events.push(`cap:${String(maxBytes)}`);
    },
    outboundFrameOverheadBytes: () => 30,
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    sender,
    fake,
    [["a"]],
    fanOutFreeBounds(1, partnerRows),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    `server protocol error: the single-pass request is ${overCap.byteLength} ` +
      `byte(s), above the ${requestCap} byte(s) both parties derive from ` +
      "their declared sizes",
  );
  // The read gate takes the message file around the request: its header and
  // the encryption envelope. It is set before the setup is masked, since the
  // partner can write its request while the sender masks.
  expect(events).toEqual([
    `cap:${requestCap + 10 + 30}`,
    "setup",
    "receive",
    "cap:undefined",
  ]);
  expect(processed).not.toHaveBeenCalled();
});

const abortFrameJsonBytes = (reason: string): number =>
  Buffer.byteLength(JSON.stringify(decisionOnlyAbortFrame([reason])));

const LONGEST_ABORT_REASON_AFTER_TERMS = ABORT_REASONS_AFTER_TERMS.reduce(
  (longest, reason) =>
    abortFrameJsonBytes(reason) > abortFrameJsonBytes(longest)
      ? reason
      : longest,
);

test("every abort reason past the terms exchange makes a frame within the read gate floor", () => {
  // The floor's figure is the one docs/spec/TRANSPORT_BOUNDS.md states.
  expect(MAX_ABORT_FRAME_AFTER_TERMS_BYTES).toBe(159);
  for (const reason of ABORT_REASONS_AFTER_TERMS)
    expect(abortFrameJsonBytes(reason)).toBeLessThanOrEqual(
      MAX_ABORT_FRAME_AFTER_TERMS_BYTES,
    );
  expect(abortFrameJsonBytes(LONGEST_ABORT_REASON_AFTER_TERMS)).toBe(
    MAX_ABORT_FRAME_AFTER_TERMS_BYTES,
  );
});

// Runs one side of a one-slot single-pass exchange over a real file-sync read
// gate and writes the partner's abort with the longest reason once `ready`
// resolves: the sender's request gate is set, or the receiver's request sent.
async function oneSlotRunEndedByLongestAbort(
  role: "starter" | "joiner",
): Promise<unknown> {
  const peerId = "peer-test";
  const { client, files } = makeMockClient();
  const fileSync = await makeConnectedConn(client, {
    pollingFrequency: 10,
    inactivityTimeoutMs: 2_000,
  });
  fileSync.peerId = peerId;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const setCap = fileSync.setInboundFrameCap.bind(fileSync);
  fileSync.setInboundFrameCap = (maxBytes) => {
    setCap(maxBytes);
    if (role === "starter" && maxBytes !== undefined) markReady();
  };
  const conn = fromEventConnection(fileSync);
  const send = conn.send.bind(conn);
  conn.send = async (data) => {
    await send(data);
    if (role === "joiner") markReady();
  };
  fileSync.start();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, role),
    conn,
    [["a"]],
    fanOutFreeBounds(1, 1),
    false,
    -1,
  );
  await ready;
  const abort = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from(
      JSON.stringify(
        decisionOnlyAbortFrame([LONGEST_ABORT_REASON_AFTER_TERMS]),
      ),
    ),
  );
  expect(abort.length).toBe(10 + MAX_ABORT_FRAME_AFTER_TERMS_BYTES);
  files.set(`/test/${peerId}-${abort.length}.json`, abort);
  const error = await run.catch((e: unknown) => e);
  fileSync.stop();
  await conn.close().catch(() => {});
  return error;
}

test("on a one-slot exchange, the longest partner abort read while the sender waits for the request ends the run as the partner's", async () => {
  // The request cap for one slot is under the largest abort frame, so without
  // the gate's floor the abort is refused as over the read gate.
  expect(
    singlePassRequestByteCap({ effectiveKeyCount: 1, recordCount: 1 }),
  ).toBeLessThan(MAX_ABORT_FRAME_AFTER_TERMS_BYTES);
  const error = await oneSlotRunEndedByLongestAbort("starter");
  expect(error).toBeInstanceOf(PeerAbortError);
});

test("on a one-slot exchange, the longest partner abort read while the receiver waits for the reply ends the run as the partner's", async () => {
  const error = await oneSlotRunEndedByLongestAbort("joiner");
  expect(error).toBeInstanceOf(PeerAbortError);
});

test("a party with more distinct values than one set holds is refused before masking", () => {
  const values = ["a", "b", "c"];
  expect(
    getDistinctValuesAndIndices([values], false, [1], 3).distinctValues,
  ).toEqual(values);
  let refusal: unknown;
  try {
    getDistinctValuesAndIndices([[...values, "d"]], false, [1], 3);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).reason).toBe("over-set-maximum");
  expect((refusal as Error).message).toBe(
    "Too large to send: your records give more than 3 distinct linkage key " +
      "values, the most one single-pass set can hold, so the exchange " +
      "stopped before masking them and told your partner.",
  );
  expect(failureCauseOf(refusal)).toStrictEqual({
    kind: "single-pass-over-limit",
    limit: "distinct-values",
    limitValues: 3,
  });
});

test("single-pass receiver rejects a reply whose index table contradicts its record count", async () => {
  // The receiver ties the distinct-value index table to the reply's declared
  // record count: its length must equal numLinkageKeys * numSenderRecords. A reply
  // that declares a record count its index table does not match is a clean protocol
  // abort, not a wrong reconstruction. Drive the receiver (joiner) against a hostile
  // sender:
  // setup/response are dummies (read but not used before the check).
  const [conn, peer] = createMessagePipe();
  const receiver = makeParticipant(psiLibrary, "joiner");
  // partnerRecordCount 5 matches the reply's declared sender count, so the
  // count-coherence check passes and the index-table-length check is what fires.
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]], // one key
    fanOutFreeBounds(1, 5),
    false,
    -1,
  );
  await peer.receive(); // consume the receiver's encrypted request
  // Declares recordCount 5 (expects 1 * 5 = 5 value indices) but ships only 2.
  await peer.send(
    encodeSinglePassReply(
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      5,
      [0, 1],
    ),
  );
  await expect(run).rejects.toThrow(/index table\s+length does not match/);
});

test("single-pass receiver rejects a reply whose sender count contradicts the exchanged count", async () => {
  // The reply packs the sender's own record count; the receiver ties it to the
  // count the sender exchanged over the authenticated channel (partnerRecordCount).
  // A reply that declares a different count is a clean protocol abort -- before any
  // allocation -- rather than a trusted-frame read.
  const [conn, peer] = createMessagePipe();
  const receiver = makeParticipant(psiLibrary, "joiner");
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]], // one key, two local rows
    fanOutFreeBounds(1, 3), // the sender exchanged 3 records
    false,
    -1,
  );
  await peer.receive(); // consume the receiver's encrypted request
  // Declares 4 sender records (with a matching 4-entry index table), not the 3
  // the sender exchanged.
  await peer.send(
    encodeSinglePassReply(
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      4,
      [0, 1, 2, 3],
    ),
  );
  await expect(run).rejects.toThrow(/declares 4 sender record/);
});

// A single-pass refusal's message followed by the remedy every app states for
// its cause.
async function singlePassRefusal(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UsageError);
  const cause = failureCauseOf(error);
  if (cause?.kind !== "single-pass-over-limit")
    throw new Error("the refusal holds no single-pass cause");
  return `${(error as Error).message} ${singlePassOverLimitRemedy(cause)}`;
}

test("single-pass aborts symmetrically when the exchange exceeds the ceiling", async () => {
  // Both parties compute the over-ceiling verdict from the exchanged counts alone,
  // before any single-pass frame moves, and both abort -- with guidance that does
  // not recommend cascade. Drive a tiny local dataset against a partner whose own
  // declared width times record count exceeds the budget. The class is asserted
  // with the guidance: every remedy the message offers is a configuration change,
  // so the CLI must exit 64 rather than treat the refusal as a transport fault.
  //
  // The cause here is the PARTNER's declaration, so the diagnosis attributes it
  // there and states the product the gate weighed on that side. Both halves matter
  // to an unattended run's operator: pointed at their own configuration they would
  // find nothing to change, and the neighbouring arithmetic -- the agreed key
  // count against the two record counts -- is not what the gate multiplies, so its
  // product can sit under the ceiling an exchange exceeds.
  const [conn, peer] = createMessagePipe();
  const receiver = makeParticipant(psiLibrary, "joiner");
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]],
    inBrowser(fanOutFreeBounds(1, CEILING + 1)), // partner alone is over
    false,
    -1,
  );
  const text = await singlePassRefusal(run);
  expect(text).toContain("This exchange is too large for single-pass linkage");
  expect(text).toContain(
    "your partner declared 1 effective linkage key across " +
      `${formatCount(CEILING + 1)} records, which is ` +
      `${formatCount(CEILING + 1)} value slots, above the single-pass limit ` +
      `of ${formatCount(CEILING)} value slots per party in an exchange with ` +
      "a browser",
  );
  // This party's own size is named as being within the ceiling, and it is not
  // offered the local dataset remedies: nothing it can change under these terms
  // moves the limit the partner's declaration reached. The scope is stated too --
  // the linkage keys are an agreed term, so a re-agreed narrower set is a change
  // this message does not speak to.
  expect(text).toContain(
    "while your own 2 value slots are within it. Ask your partner to reduce " +
      "their record count or split their dataset.",
  );
  expect(text).not.toMatch(/Reduce the record count/);
  expect(text).not.toMatch(/cascade/);
  // The abort happened before any frame was exchanged: the peer saw nothing.
  void peer;
});

test("single-pass aborts symmetrically from the starter side too", async () => {
  // Mirror of the joiner case, proving the verdict is role-symmetric. The over-ceiling
  // gate runs before the role branch, so the starter (PSI sender) reaches it from the
  // same exchanged counts. The same large partnerRecordCount lands in
  // receiverRecordCount for a starter (vs senderRecordCount for a joiner), yet both
  // compute the identical over-cap verdict and abort before any frame moves. The
  // attribution is a function of which party declared the over-ceiling size, not of
  // which PSI role it drew, so this side names the partner too.
  const [conn, peer] = createMessagePipe();
  const sender = makeParticipant(psiLibrary, "starter");
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    sender,
    conn,
    [["a", "b"]],
    inBrowser(fanOutFreeBounds(1, CEILING + 1)), // partner alone is over
    false,
    -1,
  );
  const text = await singlePassRefusal(run);
  expect(text).toContain("This exchange is too large for single-pass linkage");
  expect(text).toContain(
    "your partner declared 1 effective linkage key across " +
      `${formatCount(CEILING + 1)} records`,
  );
  expect(text).not.toMatch(/Reduce the record count/);
  expect(text).not.toMatch(/cascade/);
  // The starter aborted before receiving the request: the peer saw nothing.
  void peer;
});

test("a run whose own declared size is over the ceiling keeps the local diagnosis", async () => {
  // The other orientation: this party's own width times its own row count is what
  // reaches the budget, and the partner is comfortably inside it. The guidance is
  // the local one -- the operator's own keys, records, batching, and the fan-out
  // it declared -- with no attribution to the partner, so an operator whose own
  // dataset stops the run is sent to the configuration that can lift it.
  const localRecords = Math.floor(CEILING / FAN_OUT_CANDIDATES_PER_ELEMENT) + 1;
  const [conn, peer] = createMessagePipe();
  const receiver = makeParticipant(psiLibrary, "joiner");
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [Array.from({ length: localRecords }, (_, i) => `value-${i}`)],
    {
      partnerRecordCount: 1,
      // One key fanning out over this party's own standardization: the width its
      // advertisement claims, and what multiplies its rows into the budget.
      keyWidths: [FAN_OUT_CANDIDATES_PER_ELEMENT],
      localFanOutFactor: 1,
      valueSlotCeiling: CEILING,
    },
    false,
    -1,
  );
  const text = await singlePassRefusal(run);
  expect(text).toContain("This dataset is too large for single-pass linkage");
  expect(text).toContain(
    `you declared ${FAN_OUT_CANDIDATES_PER_ELEMENT} effective linkage keys ` +
      `across ${formatCount(localRecords)} records, which is ` +
      `${formatCount(FAN_OUT_CANDIDATES_PER_ELEMENT * localRecords)} value slots`,
  );
  // The keys are an agreed term, so the remedy states narrowing them as a
  // renegotiation rather than as an edit this operator could make alone.
  expect(text).toContain(
    "agree on new terms with fewer linkage keys with your partner",
  );
  expect(text).not.toMatch(/Reduce the number of linkage keys/);
  expect(text).toContain(
    "Removing a step that splits values or expands a key also lowers the count",
  );
  expect(text).not.toMatch(/your partner declared/);
  expect(text).not.toMatch(/cascade/);
  void peer;
});

// --- Single-pass over file-sync: no budget, and frames held to one message ---

// A pipe end stating what an encrypted file-sync connection states, with
// `frameCeiling` for the AEAD's limit on one frame. The pipe itself states
// nothing, as a WebRTC connection does.
function asFileSync(
  conn: MessageConnection,
  frameCeiling = MAX_AEAD_FRAME_BYTES,
) {
  return Object.assign(conn, {
    outboundFileSyncFrameBound: () => MAX_FRAME_SIZE_BYTES,
    frameCeilingBytes: () => frameCeiling,
  });
}

test("a file-sync receiver past a browser party's ceiling passes the gate and sends its request", async () => {
  const [conn, peer] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    asFileSync(conn),
    [["a", "b"]],
    fanOutFreeBounds(1, CEILING + 1),
    false,
    -1,
  );
  const settled = run.catch((error: unknown) => error);
  expect(await peer.receive()).toBeInstanceOf(Uint8Array);
  await peer.close();
  await conn.close();
  await settled;
});

test("a file-sync request too large for one message stops there, naming its size, and tells the partner", async () => {
  const [conn, peer] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    asFileSync(conn, 64),
    [["a", "b"]],
    fanOutFreeBounds(1, 2),
    false,
    -1,
  );
  const text = await singlePassRefusal(run);
  expect(text).toMatch(
    /The single-pass request came to [\d,]+ bytes, above the 64 bytes one encrypted message can hold/,
  );
  expect(text).toContain("Reduce the record count or split the dataset");
  expect(text).not.toMatch(/per party in an exchange with a browser/);
  expect(await peer.receive()).toEqual({
    decision: "abort",
    abortReasons: [PSI_SET_TOO_LARGE_ABORT_REASON],
  });
});

test("a file-sync reply too large for one message stops before it is written, and the partner reads an abort in its place", async () => {
  const [senderConn, receiverConn] = createMessagePipe();
  const sender = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "starter"),
    asFileSync(senderConn, 300),
    [["a", "b", "c", "d", "e", "f", "g", "h"]],
    fanOutFreeBounds(1, 2),
    false,
    -1,
  );
  const receiver = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    receiverConn,
    [["a", "b"]],
    fanOutFreeBounds(1, 8),
    false,
    -1,
  );
  const text = await singlePassRefusal(sender);
  expect(text).toMatch(
    /The single-pass reply came to [\d,]+ bytes, above the 300 bytes/,
  );
  expect(text).toContain(
    "To shrink it, either party can reduce its record count or split its dataset into smaller batches",
  );
  expect(text).not.toContain("Reduce the record count");
  await expect(receiver).rejects.toBeInstanceOf(PeerAbortError);
});

test("a WebRTC receiver past a browser party's ceiling passes where no ceiling is agreed, and is held where one is", async () => {
  const [conn, peer] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    conn,
    [["a", "b"]],
    fanOutFreeBounds(1, CEILING + 1),
    false,
    -1,
  );
  const settled = run.catch((error: unknown) => error);
  expect(await peer.receive()).toBeInstanceOf(Uint8Array);
  await peer.close();
  await conn.close();
  await settled;

  const [held] = createMessagePipe();
  await expect(
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      makeParticipant(psiLibrary, "joiner"),
      held,
      [["a", "b"]],
      inBrowser(fanOutFreeBounds(1, CEILING + 1)),
      false,
      -1,
    ),
  ).rejects.toThrow(
    `single-pass limit of ${formatCount(CEILING)} value slots per party`,
  );
});

test("an exchange over the ceiling on both sides names both declarations", async () => {
  // Neither party can lift this one alone, so the diagnosis states both products
  // and gives each side its own remedy -- rather than attributing the whole
  // breach to whichever side it happened to check first.
  const localRecords = CEILING + 1;
  const [conn, peer] = createMessagePipe();
  const receiver = makeParticipant(psiLibrary, "joiner");
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    // Two records, and a declared width that puts them over the budget on
    // their own: the fixture stays small while the arithmetic the gate reads is
    // the one being asserted.
    [["a", "b"]],
    {
      partnerRecordCount: localRecords,
      keyWidths: [CEILING],
      localFanOutFactor: 1,
      valueSlotCeiling: CEILING,
    },
    false,
    -1,
  );
  const text = await singlePassRefusal(run);
  expect(text).toContain("This exchange is too large for single-pass linkage");
  expect(text).toContain(
    `you declared ${formatCount(CEILING)} effective linkage keys across 2 ` +
      `records, which is ${formatCount(CEILING * 2)} value slots, and your ` +
      `partner declared ${formatCount(CEILING)} effective linkage keys ` +
      `across ${formatCount(localRecords)} records, which is ` +
      `${formatCount(CEILING * localRecords)} value slots`,
  );
  expect(text).toContain("Reduce the record count or split the dataset");
  expect(text).not.toMatch(/Reduce the number of linkage keys/);
  expect(text).toContain(
    "Ask your partner to reduce their record count or split their dataset too.",
  );
  expect(text).not.toMatch(/cascade/);
  void peer;
});
