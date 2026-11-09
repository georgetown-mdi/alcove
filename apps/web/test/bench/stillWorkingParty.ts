import { EncryptedMessageConnection, failureCauseOf } from "@alcove/core";
import { isStillWorkingFrame, stillWorkingLayer } from "@alcove/core/testing";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection";

import { runRound } from "./wrappedRoundParty";

import type { HandshakeRole, MessageConnection, PsiEngine } from "@alcove/core";
import type { RoundOutcome, RoundSide } from "./wrappedRoundParty";
import type { DataConnection } from "peerjs";

// The page side both parties of browserStillWorking.ts share, bundled into each
// of its pages: the web app's data-channel connection with its own timeouts,
// wrapped in core's EncryptedMessageConnection, and one PSI round of core's
// participant through core's still-working layer over it, with the time of
// every frame this party sends and reads under the layer and of every engine
// operation.

/** One frame this party sent or read, at its wall-clock time. */
export interface FrameTime {
  readonly atMs: number;
  readonly stillWorking: boolean;
}

/** One engine operation, at its wall-clock start and end. */
export interface StepTime {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** What one party recorded through its round. */
export interface PartyLog {
  readonly sent: Array<FrameTime>;
  readonly received: Array<FrameTime>;
  readonly steps: Array<StepTime>;
  phaseStartMs?: number;
  phaseEndMs?: number;
}

/** A round's end on one side: its matched pairs, or what it failed with. */
export type PartyResult =
  | { readonly outcome: RoundOutcome }
  | { readonly failure: { readonly message: string; readonly cause?: string } };

/** An empty log. */
export function partyLog(): PartyLog {
  return { sent: [], received: [], steps: [] };
}

/**
 * The web app's connection over `channel` with its default timeouts, wrapped
 * as its handshake wraps it.
 */
export async function wrapAsApp(
  channel: DataConnection,
  sessionKey: ReadonlyArray<number>,
  role: HandshakeRole,
): Promise<MessageConnection> {
  return EncryptedMessageConnection.create(
    await openPeerMessageConnection(channel),
    new Uint8Array(sessionKey),
    role,
  );
}

// `conn` with each frame it sends or reads timed into `log`, every other
// member forwarded bound to `conn`.
function recorded(conn: MessageConnection, log: PartyLog): MessageConnection {
  const send = async (data: unknown): Promise<void> => {
    log.sent.push({
      atMs: Date.now(),
      stillWorking: isStillWorkingFrame(data),
    });
    await conn.send(data);
  };
  const receive = async (timeoutMs?: number): Promise<unknown> => {
    const frame = await conn.receive(timeoutMs);
    log.received.push({
      atMs: Date.now(),
      stillWorking: isStillWorkingFrame(frame),
    });
    return frame;
  };
  return new Proxy(conn, {
    get(target, name, receiver) {
      if (name === "send") return send;
      if (name === "receive") return receive;
      const member: unknown = Reflect.get(target, name, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

/** `inner` with the wall-clock span of each operation it runs added to `log`. */
export function timedEngine(inner: PsiEngine, log: PartyLog): PsiEngine {
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const startMs = Date.now();
    try {
      return await run();
    } finally {
      log.steps.push({ name, startMs, endMs: Date.now() });
    }
  };
  return {
    createServerSetup: (values) =>
      step("createServerSetup", () => inner.createServerSetup(values)),
    processClientRequest: (request) =>
      step("processClientRequest", () => inner.processClientRequest(request)),
    createClientRequest: (values) =>
      step("createClientRequest", () => inner.createClientRequest(values)),
    receiveServerSetup: (setup) =>
      step("receiveServerSetup", () => inner.receiveServerSetup(setup)),
    receiveServerSetupPiece: (piece) =>
      step("receiveServerSetupPiece", () =>
        inner.receiveServerSetupPiece(piece),
      ),
    completeServerSetup: () =>
      step("completeServerSetup", () => inner.completeServerSetup()),
    discardServerSetup: () => inner.discardServerSetup(),
    computeAssociationTable: (response) =>
      step("computeAssociationTable", () =>
        inner.computeAssociationTable(response),
      ),
    createPermutedSetup: (values) => inner.createPermutedSetup(values),
    receiveIndexTable: (table) => inner.receiveIndexTable(table),
    matchPermutedRound: (response) => inner.matchPermutedRound(response),
    finishPermutedCount: () => inner.finishPermutedCount(),
    observeProcessedElements: (report) =>
      inner.observeProcessedElements?.(report),
    stopInFlight: () => inner.stopInFlight?.() ?? false,
    dispose: () => inner.dispose(),
  };
}

/**
 * Runs one PSI round over `conn` through core's still-working layer, as a
 * WebRTC exchange's PSI phase runs it: the layer starts before the round and
 * its phase ends after it. Never rejects: a failure comes back with the cause
 * core's failure-cause catalog gives it, where it has one.
 */
export async function runStillWorkingRound(
  conn: MessageConnection,
  engine: PsiEngine,
  side: RoundSide,
  values: Array<string>,
  log: PartyLog,
): Promise<PartyResult> {
  const layer = stillWorkingLayer(recorded(conn, log));
  if (layer === undefined)
    return {
      failure: { message: "the connection exchanges no still-working frames" },
    };
  log.phaseStartMs = Date.now();
  layer.start();
  try {
    return {
      outcome: await runRound(
        layer.conn,
        timedEngine(engine, log),
        side,
        values,
      ),
    };
  } catch (error) {
    const cause = failureCauseOf(error)?.kind;
    return {
      failure: {
        message: String(error),
        ...(cause === undefined ? {} : { cause }),
      },
    };
  } finally {
    await layer.endPhase();
    log.phaseEndMs = Date.now();
  }
}
