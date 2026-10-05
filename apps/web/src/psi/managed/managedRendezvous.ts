/**
 * The side-dispatched rendezvous for a managed (recurring) exchange re-run: the
 * record's local `side` field selects which flow runs -- `listenAsInviter` (the
 * inviter listens on its derived id) or `dialAsAcceptor` (the acceptor dials the
 * inviter's derived id) -- and the record's CURRENT `sharedSecret` is passed in,
 * so each flow derives its rendezvous peer id fresh from that secret under the
 * side-selected label (`deriveRendezvousPeerId` inside each). Nothing derived is
 * read from storage: passing the current secret is what makes "derived fresh,
 * never stored" hold by construction (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "Derived, never stored").
 *
 * The dispatch is on the local `side` field, never the document's
 * `connection.role` (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local
 * `side` field"). The inviter registers at its own deployment's signaling
 * address (`ownSignalingAddress`, inside `listenAsInviter`). The acceptor dials
 * the signaling server its record saved from the invitation it accepted -- the
 * document's `connection.server` host, port and path -- after the validation a
 * fresh invitation's endpoint gets ({@link managedAcceptorSignalingEndpoint}),
 * so two parties on different deployments keep reaching each other. The stored
 * connection block is read for three things: its `channel` discriminant, to
 * reject a non-webrtc record before any connection, the acceptor's saved
 * signaling server, and the `invitationRelay` an acceptor's record keeps from
 * the invitation it accepted.
 *
 * The two rendezvous functions are injected (defaulting to the real
 * {@link listenAsInviter} / {@link dialAsAcceptor}) so the dispatch and the
 * per-run peer-id derivation are unit-testable without a real broker.
 */

import { WebRTCEndpointSchema } from "@alcove/core";

import {
  BROKER_REGISTRATION_TIMEOUT_MS,
  dialAsAcceptor,
  listenAsInviter,
} from "../transport/rendezvous";
import { refusedSignalingEndpointField } from "../transport/signalingAddress";
import { relayForRun } from "../transport/ownRelaySetting";

import type { ExchangeSpec, WebRTCEndpoint } from "@alcove/core";
import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { RunnableManagedExchangeRecord } from "./managedExchangeRecord";

/** The two rendezvous flows the re-run dispatches between, injectable so the
 * side dispatch and the per-run peer-id derivation are testable without a broker.
 * The defaults are the real {@link listenAsInviter} / {@link dialAsAcceptor}. */
export interface ManagedRendezvousFlows {
  listenAsInviter: typeof listenAsInviter;
  dialAsAcceptor: typeof dialAsAcceptor;
}

const defaultFlows: ManagedRendezvousFlows = {
  listenAsInviter,
  dialAsAcceptor,
};

/** The fields of a stored record the rendezvous reads. */
export type ManagedRendezvousRecord = Pick<
  RunnableManagedExchangeRecord,
  "side" | "sharedSecret" | "exchangeFile" | "label"
>;

/**
 * Reject a stored record whose exchange is not the webrtc channel: only a webrtc
 * exchange is coordinated live from the browser, so any other channel cannot
 * re-run here and fails before any connection.
 */
export function assertManagedRerunDispatchable(
  exchangeFile: ExchangeSpec,
): void {
  const channel = exchangeFile.connection.channel;
  if (channel !== "webrtc")
    throw new Error(
      "managed re-run requires a webrtc exchange; stored connection channel is " +
        channel,
    );
}

/**
 * Raised when the signaling server an acceptor's record saved fails the
 * validation a fresh invitation's endpoint gets, before any connection. The
 * same record refuses identically at every run, so it is not retried. The
 * message names the exchange by its label, the operator's own text; it names
 * the refused field by class and never echoes the stored value.
 */
export class ManagedSignalingEndpointRefusedError extends Error {
  /** The label of the exchange whose saved address was refused. */
  readonly label: string;
  constructor(label: string, reason: string) {
    const name =
      label.trim() === ""
        ? "This saved exchange"
        : `The saved exchange "${label}"`;
    super(
      `${name} cannot run: the signaling server address it saved ${reason}. ` +
        "Ask your partner for a new invitation and accept it.",
    );
    this.name = "ManagedSignalingEndpointRefusedError";
    this.label = label;
  }
}

/**
 * The signaling endpoint an acceptor's re-run dials: the host, port and path its
 * record's `connection.server` saved from the accepted invitation, put through
 * the invitation endpoint's own schema ({@link WebRTCEndpointSchema}) and the
 * host and path refusals a fresh accept's dial applies
 * ({@link refusedSignalingEndpointField}). The port and scheme defaults are the
 * dial's own, applied by {@link dialAsAcceptor} as on a fresh accept. No other
 * source is read: not the page's location, not this deployment's setting.
 *
 * @throws {Error} if the record is not a webrtc exchange
 *                 ({@link assertManagedRerunDispatchable}).
 * @throws {ManagedSignalingEndpointRefusedError} if the saved address fails
 *                 either check.
 */
export function managedAcceptorSignalingEndpoint(
  record: Pick<ManagedRendezvousRecord, "exchangeFile" | "label">,
): WebRTCEndpoint {
  assertManagedRerunDispatchable(record.exchangeFile);
  const connection = record.exchangeFile.connection;
  const server: { host?: string; port?: number; path?: string } =
    connection.channel === "webrtc" ? connection.server : {};
  const parsed = WebRTCEndpointSchema.safeParse({
    channel: "webrtc",
    host: server.host,
    ...(server.port !== undefined ? { port: server.port } : {}),
    ...(server.path !== undefined ? { path: server.path } : {}),
  });
  if (!parsed.success)
    throw new ManagedSignalingEndpointRefusedError(
      record.label,
      "is not a complete host, port and path",
    );
  const endpoint: WebRTCEndpoint = parsed.data;
  const refused = refusedSignalingEndpointField(endpoint);
  if (refused !== undefined)
    throw new ManagedSignalingEndpointRefusedError(
      record.label,
      `names a ${refused} that could move the connection to another server`,
    );
  return endpoint;
}

/**
 * Check, before any connection, that `record` can begin its rendezvous: a
 * webrtc exchange and, on the acceptor side, a saved signaling address that
 * passes {@link managedAcceptorSignalingEndpoint}. A caller that contacts
 * anything before {@link beginManagedRendezvous} runs this first, so a record
 * that will refuse refuses before that contact.
 *
 * @throws {Error} as {@link managedAcceptorSignalingEndpoint} does.
 */
export function assertManagedRendezvousPossible(
  record: Pick<ManagedRendezvousRecord, "side" | "exchangeFile" | "label">,
): void {
  if (record.side === "acceptor") managedAcceptorSignalingEndpoint(record);
  else assertManagedRerunDispatchable(record.exchangeFile);
}

/**
 * Acquired rendezvous, discriminated by side: the inviter returns its registered
 * peer with no channel yet (the caller awaits the acceptor's inbound connection);
 * the acceptor returns both the peer and the opened channel.
 */
type ManagedRendezvousAcquisition =
  | { side: "inviter"; peer: Peer }
  | { side: "acceptor"; peer: Peer; conn: DataConnection };

/**
 * Begin the side-dispatched rendezvous. Returns the inviter's registered peer
 * (the caller awaits the inbound channel) or the acceptor's opened `[peer, conn]`
 * pair. The record's `sharedSecret` is its CURRENT secret, so the derived
 * rendezvous id is fresh for this run. The acceptor dials the endpoint
 * {@link managedAcceptorSignalingEndpoint} reads off the record, refusing
 * before any flow runs when it fails. `signal` cancels the listen/dial; `flows`
 * injects the rendezvous functions for tests.
 *
 * `peerWaitTimeoutMs` overrides the ACCEPTOR's no-show budget: how long its dial
 * keeps retrying an inviter that has not registered. The inviter half of the
 * same budget is not this function's -- it returns its registered peer before
 * the inbound wait begins, and the caller bounds that wait itself (see
 * {@link ./managedRunDriver.ts}). It also caps both sides' broker registration
 * at the smaller of itself and {@link BROKER_REGISTRATION_TIMEOUT_MS}, so a
 * scheduled attempt near its window's close cannot sit on a silent signaling
 * server past that close. Absent, both flows keep their shared defaults.
 *
 * Both flows gather against the relay {@link relayForRun} selects from the
 * stored connection's `invitationRelay` and this browser's own setting, read at
 * the start of each run.
 */
export async function beginManagedRendezvous(
  record: ManagedRendezvousRecord,
  options: {
    signal?: AbortSignal;
    flows?: ManagedRendezvousFlows;
    peerWaitTimeoutMs?: number;
  } = {},
): Promise<ManagedRendezvousAcquisition> {
  const flows = options.flows ?? defaultFlows;
  const signal = options.signal;
  const { side, sharedSecret, exchangeFile } = record;
  assertManagedRerunDispatchable(exchangeFile);
  const endpoint =
    side === "acceptor" ? managedAcceptorSignalingEndpoint(record) : undefined;
  const connection = exchangeFile.connection;
  const relay = relayForRun(
    connection.channel === "webrtc" ? connection.invitationRelay : undefined,
  );
  const peerWaitTimeoutMs = options.peerWaitTimeoutMs;
  const registrationBound =
    peerWaitTimeoutMs !== undefined
      ? {
          registrationTimeoutMs: Math.min(
            BROKER_REGISTRATION_TIMEOUT_MS,
            peerWaitTimeoutMs,
          ),
        }
      : {};
  if (endpoint === undefined) {
    const peer = await flows.listenAsInviter(sharedSecret, {
      signal,
      relay,
      ...registrationBound,
    });
    return { side: "inviter", peer };
  }
  const [peer, conn] = await flows.dialAsAcceptor(sharedSecret, endpoint, {
    signal,
    relay,
    ...registrationBound,
    ...(peerWaitTimeoutMs !== undefined
      ? { totalTimeoutMs: peerWaitTimeoutMs }
      : {}),
  });
  return { side: "acceptor", peer, conn };
}
