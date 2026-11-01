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
 * `side` field"). Both sides reach the signaling server the record saved from
 * the invitation -- the document's `connection.server` host, port and path --
 * after the validation a fresh invitation's endpoint gets
 * ({@link managedSignalingEndpoint}): the inviter registers there and the
 * acceptor dials it, so two parties on different deployments keep reaching
 * each other, and a change to this browser's coordination server setting
 * moves no saved exchange until the inviter re-invites, which stores the
 * server its invitation names. The stored connection block is read for four
 * things: its `channel` discriminant, to reject a non-webrtc record before any
 * connection, the saved signaling server, the `invitationRelay` an acceptor's
 * record keeps from the invitation it accepted, and the record's own
 * `allowedRelays`.
 *
 * The two rendezvous functions are injected (defaulting to the real
 * {@link listenAsInviter} / {@link dialAsAcceptor}) so the dispatch and the
 * per-run peer-id derivation are unit-testable without a real broker.
 */

import { WebRTCEndpointSchema, offerablePrevious } from "@alcove/core";

import {
  BROKER_REGISTRATION_TIMEOUT_MS,
  dialAsAcceptor,
  listenAsInviter,
} from "../transport/rendezvous";
import { PartnerNoShowError } from "../transport/waitForConnection";
import { refusedSignalingEndpointField } from "../transport/signalingAddress";
import { relayPlanForRun } from "../transport/runRelayPlan";

import { managedAllowedRelays } from "./managedExchangeRecord";

import type { DefaultRelayDependencies } from "../transport/defaultRelay";
import type { RunRelayPlan } from "../transport/runRelayPlan";
import type { WebRtcPathFailure } from "../transport/relayFallback";

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
  "side" | "sharedSecret" | "exchangeFile" | "label" | "relayRegistrar"
>;

/**
 * The previous secret a run of `record` also waits for its partner under: the
 * record's, on the acceptor, the only side that can be ahead over WebRTC,
 * where the key exchange would offer it at `now` (core's `offerablePrevious`).
 * `undefined` otherwise, so a run holding none, or holding one as the
 * inviter, waits under the current secret alone. The key exchange decides
 * again with its own clock, so one that expires during the wait fails the
 * authentication.
 */
export function managedRendezvousPreviousSecret(
  record: Pick<
    RunnableManagedExchangeRecord,
    "side" | "sharedSecret" | "previousSharedSecret" | "previousExpires"
  >,
  now: number,
): string | undefined {
  const previous = record.previousSharedSecret;
  if (record.side !== "acceptor" || previous === undefined) return undefined;
  return offerablePrevious(
    {
      sharedSecret: previous,
      ...(record.previousExpires !== undefined && {
        expires: record.previousExpires,
      }),
    },
    record.sharedSecret,
    now,
  )?.sharedSecret;
}

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
 * Raised when the signaling server a record saved fails the validation a
 * fresh invitation's endpoint gets, before any connection. The same record
 * refuses identically at every run, so it is not retried. The message names
 * the exchange by its label, the operator's own text; it names the refused
 * field by class and never echoes the stored value.
 */
export class ManagedSignalingEndpointRefusedError extends Error {
  /** The label of the exchange whose saved address was refused. */
  readonly label: string;
  /** What is wrong with the saved address, as a predicate of it ("is not a
   * complete host, port and path"), fixed text naming no stored value. */
  readonly reason: string;
  /** The sentence naming the exchange and the refused address, ending in a
   * full stop; the message continues it with the remedy. */
  readonly refusal: string;
  /** The side of the record whose saved address was refused, which decides
   * the remedy: an acceptor accepts a new invitation from its partner, and an
   * inviter re-invites, which names this browser's current coordination
   * server. */
  readonly side: ManagedRendezvousRecord["side"];
  constructor(
    label: string,
    reason: string,
    side: ManagedRendezvousRecord["side"],
  ) {
    const name =
      label.trim() === ""
        ? "This saved exchange"
        : `The saved exchange "${label}"`;
    const refusal = `${name} cannot run: the coordination server address it saved ${reason}.`;
    super(
      `${refusal} ${
        side === "acceptor"
          ? "Ask your partner for a new invitation and accept it."
          : "Re-invite your partner with the same terms to name this browser's current coordination server. If relay settings cannot read your coordination server, set it again or clear it there first."
      }`,
    );
    this.name = "ManagedSignalingEndpointRefusedError";
    this.label = label;
    this.reason = reason;
    this.refusal = refusal;
    this.side = side;
  }
}

/**
 * The signaling endpoint a re-run reaches: the host, port and path its
 * record's `connection.server` saved from the invitation, put through the
 * invitation endpoint's own schema ({@link WebRTCEndpointSchema}) and the
 * host and path refusals a fresh accept's dial applies
 * ({@link refusedSignalingEndpointField}). An acceptor dials it and an
 * inviter registers at it; the port and scheme defaults are each flow's own,
 * as on a fresh run. No other source is read: not the page's location, not
 * this deployment's setting, not this browser's coordination server setting.
 *
 * @throws {Error} if the record is not a webrtc exchange
 *                 ({@link assertManagedRerunDispatchable}).
 * @throws {ManagedSignalingEndpointRefusedError} if the saved address fails
 *                 either check.
 */
export function managedSignalingEndpoint(
  record: Pick<ManagedRendezvousRecord, "side" | "exchangeFile" | "label">,
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
      "is not a complete host, port, and path",
      record.side,
    );
  const endpoint: WebRTCEndpoint = parsed.data;
  const refused = refusedSignalingEndpointField(endpoint);
  if (refused !== undefined)
    throw new ManagedSignalingEndpointRefusedError(
      record.label,
      refused === "host"
        ? "names a host that is not a host name or IP address alone (an IPv6 address in square brackets), so this app does not connect to it"
        : `names a ${refused} that could move the connection to another server`,
      record.side,
    );
  return endpoint;
}

/**
 * Check, before any connection, that `record` can begin its rendezvous: a
 * webrtc exchange with a saved signaling address that passes
 * {@link managedSignalingEndpoint}. A caller that contacts anything before
 * {@link beginManagedRendezvous} runs this first, so a record that will
 * refuse refuses before that contact.
 *
 * @throws {Error} as {@link managedSignalingEndpoint} does.
 */
export function assertManagedRendezvousPossible(
  record: Pick<ManagedRendezvousRecord, "side" | "exchangeFile" | "label">,
): void {
  managedSignalingEndpoint(record);
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
 * The relays a managed run lists ({@link relayPlanForRun}): this browser's own
 * setting and the stored connection's `invitationRelay`, read at the start of
 * each run, and the build's default relay once this run's key is enrolled
 * there, right before it connects, each only where the stored connection's
 * `allowedRelays` keep it. A failed enrollment is reported through
 * `onRunNotice` as it happens, and the run goes on without the default relay.
 * With `previousSharedSecret` ({@link managedRendezvousPreviousSecret}), the
 * default relay's enrollment and each WebSocket relay dialed under the derived
 * id are made under that secret too. Refuses, before any contact, a record
 * whose rendezvous cannot begin ({@link assertManagedRendezvousPossible}).
 */
export async function managedRunRelayPlan(
  record: ManagedRendezvousRecord,
  options: {
    signal?: AbortSignal;
    defaultRelay?: DefaultRelayDependencies;
    onRunNotice?: (message: string) => void;
    previousSharedSecret?: string;
  } = {},
): Promise<RunRelayPlan> {
  assertManagedRendezvousPossible(record);
  const { sharedSecret, exchangeFile } = record;
  const connection = exchangeFile.connection;
  return relayPlanForRun(
    sharedSecret,
    connection.channel === "webrtc" ? connection.invitationRelay : undefined,
    managedAllowedRelays(exchangeFile),
    {
      ...options.defaultRelay,
      ...(record.relayRegistrar !== undefined
        ? { ownRelayExchangeId: record.relayRegistrar.exchangeId }
        : {}),
      ...(options.previousSharedSecret !== undefined
        ? { previousSharedSecret: options.previousSharedSecret }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onRunNotice !== undefined
        ? { onRunNotice: options.onRunNotice }
        : {}),
    },
  );
}

/**
 * Begin the side-dispatched rendezvous. Returns the inviter's registered peer
 * (the caller awaits the inbound channel) or the acceptor's opened `[peer, conn]`
 * pair. The record's `sharedSecret` is its CURRENT secret, so the derived
 * rendezvous id is fresh for this run. The inviter registers at, and the
 * acceptor dials, the endpoint {@link managedSignalingEndpoint} reads off the
 * record, refusing before any flow runs when it fails. `signal` cancels the
 * listen/dial; `flows`
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
 * Both flows gather against `relayPlan`, the run's {@link managedRunRelayPlan},
 * and report a failure of the path to the partner to `onPathFailed`.
 *
 * An acceptor given `previousSharedSecret`
 * ({@link managedRendezvousPreviousSecret}) dials under both secrets at once
 * ({@link dialUnderBothSecrets}), where a partner that did not save the last
 * rotation waits (docs/spec/PROTOCOL.md, "WebRTC rendezvous peer-id
 * derivation"); the relay credential is minted from the current secret on
 * both. The inviter ignores it.
 */
export async function beginManagedRendezvous(
  record: ManagedRendezvousRecord,
  options: {
    relayPlan: RunRelayPlan;
    signal?: AbortSignal;
    flows?: ManagedRendezvousFlows;
    peerWaitTimeoutMs?: number;
    onPathFailed?: (failure: WebRtcPathFailure) => void;
    previousSharedSecret?: string;
  },
): Promise<ManagedRendezvousAcquisition> {
  const flows = options.flows ?? defaultFlows;
  const { signal, relayPlan, onPathFailed } = options;
  const { side, sharedSecret, exchangeFile } = record;
  assertManagedRerunDispatchable(exchangeFile);
  const endpoint = managedSignalingEndpoint(record);
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
  if (side === "inviter") {
    const peer = await flows.listenAsInviter(sharedSecret, endpoint, {
      signal,
      ...relayPlan,
      ...registrationBound,
      onPathFailed,
    });
    return { side: "inviter", peer };
  }
  const dial = (secret: string, dialSignal: AbortSignal | undefined) =>
    flows.dialAsAcceptor(secret, endpoint, {
      signal: dialSignal,
      ...relayPlan,
      relaySecret: sharedSecret,
      ...registrationBound,
      onPathFailed,
      ...(peerWaitTimeoutMs !== undefined
        ? { totalTimeoutMs: peerWaitTimeoutMs }
        : {}),
    });
  const previous = options.previousSharedSecret;
  const [peer, conn] =
    previous === undefined || previous === sharedSecret
      ? await dial(sharedSecret, signal)
      : await dialUnderBothSecrets(dial, [sharedSecret, previous], signal);
  return { side: "acceptor", peer, conn };
}

/**
 * The acceptor's dial while its record holds a previous secret: one dial under
 * each secret, each registering under the acceptor id its secret derives and
 * dialing the inviter id beside it, since an inviter takes a connection only
 * from the acceptor id of the secret it holds. The first channel to open is
 * the run's, and the other dial is stopped and its peer destroyed. A dial that
 * ends with no partner leaves the outcome to the other, which ends at the same
 * deadline unless it met the partner; any other failure ends both.
 */
async function dialUnderBothSecrets(
  dial: (
    secret: string,
    signal: AbortSignal,
  ) => Promise<[Peer, DataConnection]>,
  secrets: readonly [string, string],
  signal: AbortSignal | undefined,
): Promise<[Peer, DataConnection]> {
  type Outcome = { pair: [Peer, DataConnection] } | { error: unknown };
  const legs = secrets.map((secret) => {
    const ended = new AbortController();
    const endLeg = () => ended.abort(signal?.reason);
    if (signal?.aborted === true) endLeg();
    else signal?.addEventListener("abort", endLeg, { once: true });
    const opened: Promise<Outcome> = dial(secret, ended.signal)
      .then(
        (pair): Outcome => ({ pair }),
        (error: unknown): Outcome => ({ error }),
      )
      .finally(() => signal?.removeEventListener("abort", endLeg));
    return { ended, opened };
  });
  const first = await Promise.race(
    legs.map((leg, index) =>
      leg.opened.then((outcome) => ({ index, outcome })),
    ),
  );
  const other = legs[1 - first.index];
  if (
    "error" in first.outcome &&
    first.outcome.error instanceof PartnerNoShowError
  ) {
    const last = await other.opened;
    if ("error" in last) throw last.error;
    return last.pair;
  }
  other.ended.abort();
  const late = await other.opened;
  if ("pair" in late) late.pair[0].destroy();
  if ("error" in first.outcome) throw first.outcome.error;
  return first.outcome.pair;
}
