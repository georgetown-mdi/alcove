import {
  EncryptedMessageConnection,
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  prepareForExchange,
  runExchange,
} from "@alcove/core";
import { boundedInboundFramesWithBounds } from "@alcove/core/testing";

import { openWebRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";

import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { RefusingStunServer } from "./refusingStunServer";
import type {
  BoundedInboundFrames,
  ExchangeResult,
  LinkageTerms,
  MessageConnection,
  Metadata,
} from "@alcove/core";

/**
 * A whole exchange between two CLI parties over real werift peers, each
 * receiving through an inbound queue of a lowered byte capacity: the transport
 * of matchTableParts.test.ts, the AEAD wrap over a fixed session key, and
 * `runExchange` on both sides as `runProtocol` calls it after authentication.
 */

const SESSION_KEY = new Uint8Array(32).fill(0x31) as Uint8Array<ArrayBuffer>;

export interface QueueRun {
  algorithm: "psi" | "psi-c";
  /** Rows on each side; three quarters of each side's are shared. */
  rows: number;
  /** A second key, which matches an eighth of the shared rows in round 2. */
  twoKeys: boolean;
  payload: boolean;
  /** Both sides' data-channel receive bound. */
  frameBytes: number;
  /** Both sides' inbound queue byte capacity. */
  queueByteCapacity: number;
  inviterPacing?: Pacing;
  acceptorPacing?: Pacing;
}

export interface Pacing {
  /** The side waits this long after each frame it sends. */
  afterSendMs?: number;
  /** The side waits this long after each frame it receives. */
  afterReceiveMs?: number;
  /**
   * The side starts each read only once every frame either side sent has
   * arrived and its partner is waiting on a read of its own or has finished,
   * so a run the partner sends ahead is queued whole before any of it is read.
   */
  readWhenPartnerWaits?: boolean;
}

// One side's transport traffic, counted below the AEAD wrap.
interface Traffic {
  sent: number;
  arrived: number;
  pendingReads: number;
  settled: boolean;
}

const newTraffic = (): Traffic => ({
  sent: 0,
  arrived: 0,
  pendingReads: 0,
  settled: false,
});

export interface QueueRunOutcome {
  inviter: PromiseSettledResult<ExchangeResult>;
  acceptor: PromiseSettledResult<ExchangeResult>;
  /** Every frame each side sent above the AEAD wrap, in order. */
  inviterSent: Array<unknown>;
  acceptorSent: Array<unknown>;
}

// A name no two rows share: the base-26 spelling of `i`.
function distinctName(i: number): string {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `zq${out}`;
}

function inviterTerms(run: QueueRun): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Inviter Co",
    date: "2026-01-01",
    algorithm: run.algorithm,
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      ...(run.twoKeys ? [{ name: "lastName", type: "last_name" }] : []),
    ],
    linkageKeys: [
      { name: "FN", elements: [{ field: "firstName" }] },
      ...(run.twoKeys
        ? [{ name: "LN", elements: [{ field: "lastName" }] }]
        : []),
    ],
  } as LinkageTerms;
}

/** The note column of row `i` on `side`, which the partner receives. */
export function noteOf(side: "inviter" | "acceptor", i: number): string {
  return `note-${String(i).padStart(8, "0")}-${side}`;
}

/**
 * The inviter's rows are 0 to `rows - 1`, the acceptor's start a quarter of
 * the way in. With two keys the first eighth of the shared rows differ on the
 * first name on the acceptor's side, so they match in round 2 on the last.
 */
export function rowOffset(run: QueueRun, side: "inviter" | "acceptor"): number {
  return side === "inviter" ? 0 : run.rows / 4;
}

function prepared(run: QueueRun, side: "inviter" | "acceptor") {
  const from = rowOffset(run, side);
  const data = Array.from({ length: run.rows }, (_, k) => {
    const i = from + k;
    const differsOnFirst =
      side === "acceptor" && run.twoKeys && i < run.rows / 4 + run.rows / 8;
    const row: Record<string, string> = {
      first_name: differsOnFirst ? `${distinctName(i)}q` : distinctName(i),
    };
    if (run.twoKeys) row.last_name = `${distinctName(i)}x`;
    if (run.payload) row.note = noteOf(side, i);
    return row;
  });
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
  ];
  if (run.twoKeys)
    metadata.push({
      name: "last_name",
      type: "last_name",
      role: "linkage",
      isPayload: false,
    });
  if (run.payload)
    metadata.push({
      name: "note",
      type: "other",
      role: "payload",
      isPayload: true,
    });
  const identity = side === "inviter" ? "Inviter Co" : "Acceptor Co";
  const terms =
    side === "inviter"
      ? inviterTerms(run)
      : deriveAcceptedLinkageTerms(inviterTerms(run), identity);
  return prepareForExchange(
    { metadata, linkageTerms: terms },
    identity,
    data,
    Object.keys(data[0]),
  );
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// `conn` with its `send` and `receive` replaced, every other member bound to it.
function wrapped(
  conn: MessageConnection,
  send: (data: unknown) => Promise<void>,
  receive: (timeoutMs?: number) => Promise<unknown>,
): MessageConnection {
  return new Proxy(conn, {
    get: (target, prop) => {
      if (prop === "send") return send;
      if (prop === "receive") return receive;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: Array<unknown>) => unknown).bind(target)
        : value;
    },
  });
}

// The transport connection `conn`, counting its sends and pending reads into
// `traffic`.
function counted(conn: MessageConnection, traffic: Traffic): MessageConnection {
  return wrapped(
    conn,
    (data) => {
      traffic.sent += 1;
      return conn.send(data);
    },
    async (timeoutMs) => {
      traffic.pendingReads += 1;
      try {
        return await conn.receive(timeoutMs);
      } finally {
        traffic.pendingReads -= 1;
      }
    },
  );
}

// Resolves once every frame each side sent has arrived and `partner` is
// blocked on a transport read or has finished. The read is the transport's,
// below the AEAD wrap: a partner decrypting the frame it just read is still
// pending a read one layer up.
async function untilPartnerWaits(
  own: Traffic,
  partner: Traffic,
): Promise<void> {
  while (
    !partner.settled &&
    !(
      own.sent === partner.arrived &&
      partner.sent === own.arrived &&
      partner.pendingReads > 0
    )
  )
    await pause(5);
}

// `conn`, recording each frame sent into `sent`, pausing after each send and
// receive as `pacing` sets, and running `beforeRead` ahead of each read when
// `pacing` sets `readWhenPartnerWaits`.
function paced(
  conn: MessageConnection,
  pacing: Pacing | undefined,
  sent: Array<unknown>,
  beforeRead: () => Promise<void>,
): MessageConnection {
  return wrapped(
    conn,
    async (data) => {
      sent.push(data);
      await conn.send(data);
      if (pacing?.afterSendMs) await pause(pacing.afterSendMs);
    },
    async (timeoutMs) => {
      if (pacing?.readWhenPartnerWaits) await beforeRead();
      const value = await conn.receive(timeoutMs);
      if (pacing?.afterReceiveMs) await pause(pacing.afterReceiveMs);
      return value;
    },
  );
}

// An inbound reassembler at `frameBytes` that counts each frame it completes
// into `traffic`.
function countingInboundFrames(
  frameBytes: number,
  traffic: Traffic,
): BoundedInboundFrames {
  const bounds = boundedInboundFramesWithBounds({ maxFrameBytes: frameBytes });
  const accept = bounds.accept.bind(bounds);
  bounds.accept = (bytes) => {
    const outcome = accept(bytes);
    if (outcome.kind === "frame") traffic.arrived += 1;
    return outcome;
  };
  return bounds;
}

export async function runOverQueue(
  run: QueueRun,
  broker: BrokerProcess,
  stunServer: RefusingStunServer,
  psiLibrary: Parameters<typeof runExchange>[3]["psiLibrary"],
  openConnections: Array<MessageConnection>,
): Promise<QueueRunOutcome> {
  const common = {
    location: {
      host: "127.0.0.1",
      port: broker.port,
      path: broker.path,
      key: broker.key,
      secure: false,
    },
    sharedSecret: generateSharedSecret(),
    iceServers: stunServer.iceServers,
    rendezvousTimeoutMs: 60_000,
    channelOpenTimeoutMs: 30_000,
    closeFlushTimeoutMs: 10_000,
    inboundQueueByteCapacity: run.queueByteCapacity,
  };
  const inviterTraffic = newTraffic();
  const acceptorTraffic = newTraffic();
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({
      ...common,
      role: "inviter",
      inboundFrames: () =>
        countingInboundFrames(run.frameBytes, inviterTraffic),
    }),
    openWebRtcMessageConnection({
      ...common,
      role: "acceptor",
      inboundFrames: () =>
        countingInboundFrames(run.frameBytes, acceptorTraffic),
    }),
  ]);
  openConnections.push(inviter, acceptor);
  const [inviterConn, acceptorConn] = await Promise.all([
    EncryptedMessageConnection.create(
      counted(inviter, inviterTraffic),
      SESSION_KEY,
      "initiator",
    ),
    EncryptedMessageConnection.create(
      counted(acceptor, acceptorTraffic),
      SESSION_KEY,
      "responder",
    ),
  ]);
  const options = { psiLibrary, verbosity: -1 };
  const inviterSent: Array<unknown> = [];
  const acceptorSent: Array<unknown> = [];
  const settle = (traffic: Traffic) => () => {
    traffic.settled = true;
  };
  const [inviterResult, acceptorResult] = await Promise.allSettled([
    runExchange(
      paced(inviterConn, run.inviterPacing, inviterSent, () =>
        untilPartnerWaits(inviterTraffic, acceptorTraffic),
      ),
      "initiator",
      prepared(run, "inviter"),
      options,
    ).finally(settle(inviterTraffic)),
    runExchange(
      paced(acceptorConn, run.acceptorPacing, acceptorSent, () =>
        untilPartnerWaits(acceptorTraffic, inviterTraffic),
      ),
      "responder",
      prepared(run, "acceptor"),
      options,
    ).finally(settle(acceptorTraffic)),
  ]);
  return {
    inviter: inviterResult,
    acceptor: acceptorResult,
    inviterSent,
    acceptorSent,
  };
}

/**
 * The part counts of the runs of parts among `sent`'s binary frames, in
 * order: each run opens at a part of index 0 and holds the count its header
 * states (docs/spec/PROTOCOL.md, The part header). Only for a sender whose
 * every binary frame is a part.
 */
export function partRuns(sent: Array<unknown>): Array<number> {
  const runs: Array<number> = [];
  let expected = 0;
  let count = 0;
  for (const frame of sent) {
    if (!(frame instanceof Uint8Array)) continue;
    const view = new DataView(frame.buffer, frame.byteOffset, 8);
    const index = view.getUint32(0);
    const stated = view.getUint32(4);
    if (expected === 0) {
      if (index !== 0) throw new Error(`a run opened at part ${index}`);
      count = stated;
      runs.push(count);
    } else if (index !== count - expected || stated !== count)
      throw new Error(`part ${index} of ${stated} inside a run of ${count}`);
    expected = expected === 0 ? count - 1 : expected - 1;
  }
  return runs;
}
