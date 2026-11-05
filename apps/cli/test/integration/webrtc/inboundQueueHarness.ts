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
}

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

// `conn`, recording each frame sent into `sent` and pausing after each send
// and receive as `pacing` sets.
function paced(
  conn: MessageConnection,
  pacing: Pacing | undefined,
  sent: Array<unknown>,
): MessageConnection {
  return new Proxy(conn, {
    get: (target, prop) => {
      if (prop === "send")
        return async (data: unknown) => {
          sent.push(data);
          await target.send(data);
          if (pacing?.afterSendMs) await pause(pacing.afterSendMs);
        };
      if (prop === "receive")
        return async (timeoutMs?: number) => {
          const value = await target.receive(timeoutMs);
          if (pacing?.afterReceiveMs) await pause(pacing.afterReceiveMs);
          return value;
        };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: Array<unknown>) => unknown).bind(target)
        : value;
    },
  });
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
    inboundFrames: () =>
      boundedInboundFramesWithBounds({ maxFrameBytes: run.frameBytes }),
    inboundQueueByteCapacity: run.queueByteCapacity,
  };
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({ ...common, role: "inviter" }),
    openWebRtcMessageConnection({ ...common, role: "acceptor" }),
  ]);
  openConnections.push(inviter, acceptor);
  const [inviterConn, acceptorConn] = await Promise.all([
    EncryptedMessageConnection.create(inviter, SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(acceptor, SESSION_KEY, "responder"),
  ]);
  const options = { psiLibrary, verbosity: -1 };
  const inviterSent: Array<unknown> = [];
  const acceptorSent: Array<unknown> = [];
  const [inviterResult, acceptorResult] = await Promise.allSettled([
    runExchange(
      paced(inviterConn, run.inviterPacing, inviterSent),
      "initiator",
      prepared(run, "inviter"),
      options,
    ),
    runExchange(
      paced(acceptorConn, run.acceptorPacing, acceptorSent),
      "responder",
      prepared(run, "acceptor"),
      options,
    ),
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
