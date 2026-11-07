import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { MAX_AEAD_FRAME_BYTES } from "../../src/connection/encryptedMessageConnection";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { PartnerProtocolRefusalError } from "../../src/errors";
import { linkViaSinglePassPSI } from "../../src/psi/link";
import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  WorkerPsiEngine,
  servePsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerRequest,
} from "../../src/psi/psiWorkerEngine";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { fanOutFreeBounds } from "../utils/singlePassBounds";

const psiLibrary = await PSI();

// Fixed keys, so each party's frames are the same bytes on every run.
const STARTER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const JOINER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 64 - i);

const STARTER_DATA = [["Alice", "Bob", "Carol", "David", "Elizabeth"]];
const JOINER_DATA = [["Carol", "Elizabeth", "Henry"]];

/** One request a worker engine posted: its method and the buffers it moved. */
interface Post {
  method: PsiWorkerRequest["body"]["method"];
  transferred: Array<number>;
}

// A worker engine whose worker is an in-process engine on this thread, each
// request delivered as postMessage delivers it: structured-cloned, with the
// listed buffers transferred, so a transferred buffer is detached here.
function inThreadWorkerEngine(
  role: "starter" | "joiner",
  posts: Array<Post>,
): WorkerPsiEngine {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    role,
    role,
    "identifier-revealing",
    { secretKey: role === "starter" ? STARTER_KEY : JOINER_KEY },
  );
  let deliver: (response: unknown) => void = () => undefined;
  const serve = servePsiEngine(engine, (response) => {
    queueMicrotask(() => deliver(structuredClone(response)));
  });
  const handle: PsiWorkerHandle = {
    postMessage: (request, transfer) => {
      const moved = [...(transfer ?? [])];
      posts.push({
        method: request.body.method,
        transferred: moved.map((buffer) => buffer.byteLength),
      });
      serve(structuredClone(request, { transfer: moved }));
    },
    setHandlers: ({ onMessage }) => {
      deliver = onMessage as (response: unknown) => void;
    },
    terminate: () => undefined,
  };
  return new WorkerPsiEngine(handle);
}

function participant(
  role: "starter" | "joiner",
  engine: WorkerPsiEngine,
): PSIParticipant {
  return new PSIParticipant(
    role,
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    engine,
  );
}

function asFileSync(conn: MessageConnection): MessageConnection {
  return Object.assign(conn, {
    outboundFileSyncFrameBound: () => MAX_FRAME_SIZE_BYTES,
    frameCeilingBytes: () => MAX_AEAD_FRAME_BYTES,
  });
}

// `conn`, with the SHA-256 of each frame it sends recorded as it is sent.
function recordingSends(
  conn: MessageConnection,
  digests: Array<string>,
): MessageConnection {
  const send = conn.send.bind(conn);
  conn.send = (data: unknown) => {
    const bytes =
      data instanceof Uint8Array
        ? data
        : new TextEncoder().encode(JSON.stringify(data));
    digests.push(createHash("sha256").update(bytes).digest("hex"));
    return send(data);
  };
  return conn;
}

async function runPair(fileSync: boolean) {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterPosts: Array<Post> = [];
  const joinerPosts: Array<Post> = [];
  const starterSent: Array<string> = [];
  const joinerSent: Array<string> = [];
  const wrap = (conn: MessageConnection, sent: Array<string>) =>
    recordingSends(fileSync ? asFileSync(conn) : conn, sent);
  const [starterTable, joinerTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      participant("starter", inThreadWorkerEngine("starter", starterPosts)),
      wrap(starterConn, starterSent),
      STARTER_DATA,
      fanOutFreeBounds(1, JOINER_DATA[0]!.length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      participant("joiner", inThreadWorkerEngine("joiner", joinerPosts)),
      wrap(joinerConn, joinerSent),
      JOINER_DATA,
      fanOutFreeBounds(1, STARTER_DATA[0]!.length),
      false,
      -1,
    ),
  ]);
  return {
    starterTable,
    joinerTable,
    starterPosts,
    joinerPosts,
    starterSent,
    joinerSent,
  };
}

test("over file-sync, each party's frames for a fixed input are the pinned bytes", async () => {
  const run = await runPair(true);
  expect(run.joinerTable).toEqual([
    [0, 1],
    [2, 4],
  ]);
  expect(run.starterTable).toEqual([
    [2, 4],
    [0, 1],
  ]);
  expect(run.joinerSent).toEqual([
    "513706dfcd8f06f3fce42608476fe87cf5340b4c21308d072fb47c3d9dbdda70",
    "c75949b1009059256c2882aa4f7fe4a46a11c7a8211619cbf855e31e0ccd7038",
  ]);
  expect(run.starterSent).toEqual([
    "80acbcfda0a9cf928d27227ec4864c2cf538b78428c6cf139c605445b204fcbb",
  ]);
});

test("over file-sync, the request and the reply move to the worker, the reply's setup in pieces", async () => {
  const run = await runPair(true);
  const request = run.starterPosts.find(
    (post) => post.method === "processClientRequest",
  );
  expect(request?.transferred).toHaveLength(1);
  expect(request!.transferred[0]).toBeGreaterThan(0);
  const joinerFrames = run.joinerPosts.filter(
    (post) => post.method !== "createClientRequest",
  );
  expect(joinerFrames.map((post) => post.method)).toEqual([
    "receiveServerSetupPiece",
    "completeServerSetup",
    "computeAssociationTable",
  ]);
  expect(joinerFrames[0]!.transferred).toHaveLength(1);
  expect(joinerFrames[2]!.transferred).toHaveLength(1);
});

test("outside file-sync, no frame moves and the reply's setup goes whole", async () => {
  const run = await runPair(false);
  for (const post of [...run.starterPosts, ...run.joinerPosts])
    expect(post.transferred).toEqual([]);
  expect(run.joinerPosts.map((post) => post.method)).toContain(
    "receiveServerSetup",
  );
});

/** A reply's setup and response, as views of one buffer. */
interface Reply {
  frame: Uint8Array;
  setup: Uint8Array;
  response: Uint8Array;
}

// The starter's setup and its response to the joiner's request, as views of
// one buffer, the layout the reply's decode leaves them in.
async function replyFor(joiner: PSIParticipant): Promise<Reply> {
  const request = await joiner.createClientRequest(JOINER_DATA[0]!);
  const starter = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "starter",
    "identifier-revealing",
    { secretKey: STARTER_KEY },
  );
  const { setup } = await starter.createServerSetup(STARTER_DATA[0]!);
  const response = await starter.processClientRequest(request);
  const frame = new Uint8Array(setup.length + response.length);
  frame.set(setup);
  frame.set(response, setup.length);
  return {
    frame,
    setup: frame.subarray(0, setup.length),
    response: frame.subarray(setup.length),
  };
}

function joinerWith(
  posts: Array<Post>,
  elementBounds = UNBOUNDED_PSI_ELEMENTS,
): PSIParticipant {
  return new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    elementBounds,
    inThreadWorkerEngine("joiner", posts),
  );
}

test("a handed-over setup goes in pieces of the given size, each moved, and matches as the whole setup does", async () => {
  const whole = joinerWith([]);
  const wholeReply = await replyFor(whole);
  const expected = await whole.computeValueMatches(
    wholeReply.setup,
    wholeReply.response,
  );

  const posts: Array<Post> = [];
  const joiner = joinerWith(posts);
  const reply = await replyFor(joiner);
  const setupBytes = reply.setup.byteLength;
  const matches = await joiner.computeValueMatches(
    reply.setup,
    reply.response,
    { transfer: true, setupPieceBytes: 64 },
  );
  expect(matches).toEqual(expected);
  const pieces = posts.filter(
    (post) => post.method === "receiveServerSetupPiece",
  );
  expect(pieces).toHaveLength(Math.ceil(setupBytes / 64));
  expect(pieces.map((post) => post.transferred[0])).toEqual(
    Array.from({ length: pieces.length }, (_, i) =>
      Math.min(64, setupBytes - i * 64),
    ),
  );
  expect(reply.frame.byteLength).toBe(0);
});

// The whole setup and the hand-off on the same reply, rewritten by
// `deviate`: each one's failure, the engine calls it posted, and whether the
// reply's buffer is still held here.
async function refusals(
  deviate: (reply: Reply) => void,
  elementBounds = UNBOUNDED_PSI_ELEMENTS,
) {
  const outcome = async (handOff: boolean) => {
    const posts: Array<Post> = [];
    const joiner = joinerWith(posts, elementBounds);
    const reply = await replyFor(joiner);
    deviate(reply);
    const frameBytes = reply.frame.byteLength;
    const error: unknown = await joiner
      .computeValueMatches(
        reply.setup,
        reply.response,
        handOff ? { transfer: true, setupPieceBytes: 64 } : undefined,
      )
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    return {
      error,
      methods: posts.map((post) => post.method),
      frameKept: reply.frame.byteLength === frameBytes,
    };
  };
  return { whole: await outcome(false), handedOver: await outcome(true) };
}

function expectSameRefusal(whole: unknown, handedOver: unknown): void {
  expect(whole).toBeInstanceOf(PartnerProtocolRefusalError);
  expect(handedOver).toBeInstanceOf(PartnerProtocolRefusalError);
  expect((handedOver as Error).message).toBe((whole as Error).message);
}

test("a setup over its element bound is refused as the whole setup is, before any piece reaches the engine", async () => {
  const { whole, handedOver } = await refusals(() => undefined, {
    setup: 2,
    request: Number.POSITIVE_INFINITY,
  });
  expectSameRefusal(whole.error, handedOver.error);
  expect(handedOver.methods).toEqual(["createClientRequest"]);
  expect(handedOver.frameKept).toBe(true);
});

test("a setup the engine refuses is refused as the whole setup is, and the pieces taken are freed", async () => {
  // The last element repeats the one before it, so the setup's elements are
  // not strictly ascending: each element is 33 bytes behind a 2-byte prefix.
  const { whole, handedOver } = await refusals((reply) => {
    const last = reply.setup.length - 33;
    reply.setup.copyWithin(last, last - 35, last - 2);
  });
  expectSameRefusal(whole.error, handedOver.error);
  expect(handedOver.methods).toContain("receiveServerSetupPiece");
  expect(handedOver.methods.at(-1)).toBe("discardServerSetup");
  expect(handedOver.methods).not.toContain("computeAssociationTable");
});

test("a response longer than the request is refused as it is without the hand-off, before it is moved", async () => {
  const { whole, handedOver } = await refusals((reply) => {
    const longer = new Uint8Array(reply.frame.length + 33);
    longer.set(reply.frame);
    const setupBytes = reply.setup.length;
    reply.frame = longer;
    reply.setup = longer.subarray(0, setupBytes);
    reply.response = longer.subarray(setupBytes);
  });
  expectSameRefusal(whole.error, handedOver.error);
  expect(handedOver.methods).not.toContain("computeAssociationTable");
  expect(handedOver.frameKept).toBe(true);
});

test("a request over its element bound is refused as it is without the hand-off, before it is moved", async () => {
  const joiner = new InProcessPsiEngine(
    psiLibrary,
    "joiner",
    "joiner",
    "identifier-revealing",
    { secretKey: JOINER_KEY },
  );
  const outcome = async (handOff: boolean) => {
    const posts: Array<Post> = [];
    const starter = new PSIParticipant(
      "starter",
      psiLibrary,
      { role: "starter", verbose: -1 },
      { setup: Number.POSITIVE_INFINITY, request: 2 },
      inThreadWorkerEngine("starter", posts),
    );
    const request = await joiner.createClientRequest(JOINER_DATA[0]!);
    const requestBytes = request.byteLength;
    const error: unknown = await starter
      .processClientRequest(request, handOff ? { transfer: true } : undefined)
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    return {
      error,
      methods: posts.map((post) => post.method),
      requestKept: request.byteLength === requestBytes,
    };
  };
  const whole = await outcome(false);
  const handedOver = await outcome(true);
  expectSameRefusal(whole.error, handedOver.error);
  expect(handedOver.methods).toEqual([]);
  expect(handedOver.requestKept).toBe(true);
});
