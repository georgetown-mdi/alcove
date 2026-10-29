import {
  handshakeRoleForRendezvousRole,
  loadCSVFile,
  prepareForExchange,
  runExchange,
} from "@alcove/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";
import Peer from "peerjs";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import { dialAsAcceptor, listenAsInviter } from "@psi/transport/rendezvous";
import { authenticateExchange } from "@psi/authenticateExchange";
import { boundPeerSignaling } from "@psi/transport/signalingBounds";
import { inviterExchangeDataSpec } from "@psi/authoring/advancedInviteTerms";
import { openOneShotPeerConnection } from "@psi/exchangeLifecycle";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";
import { openRunConnectionWithRelayFallback } from "@psi/transport/relayFallback";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";
import { prepareAcceptorExchange } from "@exchange/acceptorExchange";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes";

import type {
  CSVRow,
  MessageConnection,
  PreparedExchange,
  RendezvousRole,
} from "@alcove/core";
import type { DataConnection } from "peerjs";
import type { GeneratedInvitation } from "@psi/invitation";
import type { MatchedPair } from "./legTypes";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { PeerCloseOutcome } from "@psi/transport/waitForPeerClose";
import type { SignalingAddress } from "@psi/transport/signalingAddress";

/**
 * The browser party of the live WebRTC legs, in either seat, run through the
 * web app's own steps: the accept-path validation, the confirm-columns
 * editor's launch payload, the rendezvous dial or listen, the authentication
 * and the PSI rounds on the WASM engine. The legs differ only in who the
 * partner is -- an `alcove invite` process or a console job.
 */

/** What the browser peer links on. Two rows in common with the CLI party's
 * file (`CLI_PARTY_CSV`), at different offsets on each side, so a party reading
 * its own table back cannot pass by symmetry: the CLI's rows 0 and 1 are this
 * party's 1 and 2. */
export const BROWSER_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Zoe,Adams,2001-03-03\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n";

export const BROWSER_IDENTITY = "Agency B, b@agency-b.example";

/** The pairs each side must resolve: [own row, partner row]. */
export const CLI_PAIRS: Array<MatchedPair> = [
  [0, 1],
  [1, 2],
];
export const BROWSER_PAIRS: Array<MatchedPair> = [
  [1, 0],
  [2, 1],
];

/**
 * What ended the PeerJS connection before the browser party reached its own
 * close, which is what the two close orderings differ by: `none` is this party
 * closing first, `peer-close` is the CLI party having closed first. The other
 * two are the ways a run can reach the same cleared `open` flag with nothing
 * delivered.
 */
export type EndBeforeOwnClose =
  "none" | "peer-close" | "link-failed" | "connection-error";

/**
 * Read that ending off the connection the moment before this party closes.
 * PeerJS clears `open` whenever it ends the connection itself, so an open
 * connection is this party closing first and a cleared one is the CLI party's
 * close sentinel -- unless ICE gave up on the link or a send raised, the two
 * separated here. The remaining way PeerJS ends a connection, a broker-relayed
 * leave, cannot reach this party: it drops its broker socket on the exchange's
 * first frame.
 */
function endBeforeOwnClose(
  conn: DataConnection,
  connectionError: boolean,
): EndBeforeOwnClose {
  if (connectionError) return "connection-error";
  if (conn.open) return "none";
  return conn.peerConnection.connectionState === "failed"
    ? "link-failed"
    : "peer-close";
}

/** What the browser peer's own half of the exchange produced. */
export interface BrowserOutcome {
  /** The partner's declared identity, read off the agreed terms. */
  partnerIdentity: string | undefined;
  /** The matched (own row, partner row) pairs, ascending by own row. */
  pairs: Array<MatchedPair>;
  /** How the clean close's wait for the peer ended, or undefined where there
   * was no wait to take. */
  closeOutcome: PeerCloseOutcome | undefined;
  /** Which close ordering the run took, which the outcome above is read
   * against. */
  endBeforeOwnClose: EndBeforeOwnClose;
  /** How long that wait took: the span from asking for the flushing close --
   * which queues the in-band close sentinel behind the final frame -- to the
   * close returning. */
  closeWaitMs: number;
}

/** The matched pairs an exchange result holds, ordered so two parties' mirrored
 * tables compare directly. */
function matchedPairs(
  associationTable: [Array<number>, Array<number>] | undefined,
): Array<MatchedPair> {
  if (associationTable === undefined) return [];
  const [own, partner] = associationTable;
  return own
    .map((row, index): MatchedPair => [row, partner[index]])
    .sort((a, b) => a[0] - b[0]);
}

/** Read `csv` through the app's own CSV reader, from a File as a seat acquires
 * one, so a divergence here cannot be mistaken for a protocol one. */
export async function readBrowserCsv(
  csv: string,
): Promise<{ rawRows: Array<CSVRow>; columns: Array<string> }> {
  const parsed = await loadCSVFile(
    new File([csv], "input.csv", { type: "text/csv" }),
  );
  return { rawRows: parsed.data, columns: parsed.meta.fields ?? [] };
}

/** Authenticate over an opened connection and run the PSI rounds with the
 * shared-secret rotation, leaving the authenticated connection open for the
 * caller's close. Throws when the run stored no fresh next secret. */
async function authenticateAndRun(params: {
  mc: MessageConnection;
  role: RendezvousRole;
  sharedSecret: string;
  expires: string | undefined;
  prepared: PreparedExchange;
}): Promise<{
  connection: MessageConnection;
  partnerIdentity: string | undefined;
  pairs: Array<MatchedPair>;
}> {
  const handshakeRole = handshakeRoleForRendezvousRole(params.role);
  const { connection, nextSecretInputs } = await authenticateExchange(
    params.mc,
    handshakeRole,
    params.sharedSecret,
    params.expires,
  );
  const psiLibrary = await (PSI() as Promise<PSILibrary>);
  // The rotation every authenticated web run passes (runExchangeLifecycle,
  // managedRunDriver), holding the next secret in memory as a one-shot run does.
  let nextSecret: string | undefined;
  const result = await runExchange(connection, handshakeRole, params.prepared, {
    psiLibrary,
    rotation: {
      inputs: nextSecretInputs,
      store: (stored) => {
        nextSecret = stored;
      },
    },
  });
  if (nextSecret === undefined)
    throw new Error("the exchange completed without a next shared secret");
  if (nextSecret === params.sharedSecret)
    throw new Error("the next shared secret repeats the invitation's");
  return {
    connection,
    partnerIdentity: result.partnerTerms.identity,
    pairs: matchedPairs(result.associationTable),
  };
}

/** Authenticate over an opened connection, run the PSI rounds, and close
 * cleanly, measuring the close. */
async function runOverConnection(params: {
  peer: Peer;
  conn: DataConnection;
  role: RendezvousRole;
  sharedSecret: string;
  expires: string | undefined;
  prepared: PreparedExchange;
}): Promise<BrowserOutcome> {
  const { peer, conn, role, sharedSecret, expires, prepared } = params;
  // The lifecycle's own early broker drop: once a frame has arrived the
  // rendezvous is over, and the close below happens with no broker socket left
  // (apps/web/src/psi/exchangeLifecycle.ts).
  conn.once("data", () => peer.disconnect());

  let connectionError = false;
  conn.on("error", () => {
    connectionError = true;
  });

  let closeOutcome: PeerCloseOutcome | undefined;
  const mc = await openPeerMessageConnection(conn, {
    onCloseOutcome: (outcome) => {
      closeOutcome = outcome;
    },
  });
  const { connection, partnerIdentity, pairs } = await authenticateAndRun({
    mc,
    role,
    sharedSecret,
    expires,
    prepared,
  });

  const ending = endBeforeOwnClose(conn, connectionError);
  // The measurement: a flushing close queues the in-band close sentinel behind
  // the final frame and then waits for the peer to close the channel, so this
  // span is what a browser operator waits after their result is on screen.
  const closeStartedAt = performance.now();
  await connection.close();
  const closeWaitMs = Math.round(performance.now() - closeStartedAt);
  peer.disconnect();

  return {
    partnerIdentity,
    pairs,
    closeOutcome,
    endBeforeOwnClose: ending,
    closeWaitMs,
  };
}

/** Accept `invitation` as the browser acceptor does: the app's own accept-path
 * validation (checksum, expiry, an endpoint this build can drive, and the
 * terms' fail-closed checks), then the confirm-columns editor's launch
 * payload. */
async function acceptInBrowser(invitation: string) {
  const accepted = await prepareAcceptedInvitation(invitation, {
    profile: "hosted",
  });
  const { endpoint, token } = accepted;
  if (endpoint.channel !== "webrtc")
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the partner minted a ` +
        `${endpoint.channel} endpoint, not a webrtc one`,
    );

  const { rawRows, columns } = await readBrowserCsv(BROWSER_CSV);
  const { edits } = acceptorLaunchPayload(
    acceptorColumnsEditorState(
      acceptorInitialColumnsState(columns),
      token.linkageTerms,
      rawRows,
    ),
  );
  const prepared = prepareAcceptorExchange({
    linkageTerms: token.linkageTerms,
    acceptorName: BROWSER_IDENTITY,
    edits,
    rawRows,
    columns,
    // The value an accept with no control of its own derives.
    deduplicate: false,
  });
  return { token, endpoint, prepared };
}

/** Run the browser peer's whole acceptor half: accept the invitation, dial the
 * broker the invitation names, authenticate, run the PSI rounds, and close
 * cleanly. */
export async function runBrowserAcceptor(
  invitation: string,
): Promise<BrowserOutcome> {
  const { token, endpoint, prepared } = await acceptInBrowser(invitation);
  // The app's own dial, against the endpoint the partner minted.
  const [peer, conn] = await dialAsAcceptor(token.sharedSecret, endpoint);
  return await runOverConnection({
    peer,
    conn,
    role: "acceptor",
    sharedSecret: token.sharedSecret,
    expires: token.expires,
    prepared,
  });
}

/** One relay socket the browser acceptor opened. */
export interface RecordedRelaySocket {
  socket: WebSocket;
  /** The code of each close this side called on it, `undefined` for a close
   * with no code. */
  closeCodes: Array<number | undefined>;
  /** Its `readyState` when the run connection opened. */
  readyStateAtRunOpen: number | undefined;
}

/**
 * What the browser acceptor's relay sockets were sent and closed with.
 *
 * Each close this side calls is recorded and held back until
 * `releaseCloses`, so the CLI party's socket is the first of the pairing to
 * close at the relay: the relay closes a party's socket when its partner's
 * closes, which would otherwise hide whether the CLI party closed its own.
 */
export interface RelaySocketRecord {
  opened: Array<RecordedRelaySocket>;
  /** The `type` of each text frame sent: the relay protocol's hello and
   * start. */
  sentTypes: Array<string>;
  /** Send every close held back, and stop holding them. */
  releaseCloses: () => void;
}

/** A relay case acceptor whose run connection has opened, before the key
 * exchange. */
export interface OpenedRelayCaseAcceptor {
  /** The WebSocket relay urls the run listed. */
  listedRelays: Array<string>;
  /** The run notices, the one stating which path carries the exchange
   * among them. */
  notices: Array<string>;
  sockets: RelaySocketRecord;
  /** Authenticate, run the PSI rounds, close and release. */
  exchange: () => Promise<{
    partnerIdentity: string | undefined;
    pairs: Array<MatchedPair>;
  }>;
}

/** The relay client's socket factory, recording each socket it opens and
 * what it sends, and recording and holding back each close. */
function recordingSocketFactory(): {
  record: RelaySocketRecord;
  createSocket: (url: string) => WebSocket;
} {
  let held: Array<() => void> | undefined = [];
  const record: RelaySocketRecord = {
    opened: [],
    sentTypes: [],
    releaseCloses: () => {
      const closes = held ?? [];
      held = undefined;
      for (const close of closes) close();
    },
  };
  const createSocket = (url: string): WebSocket => {
    const socket = new WebSocket(url);
    const recorded: RecordedRelaySocket = {
      socket,
      closeCodes: [],
      readyStateAtRunOpen: undefined,
    };
    record.opened.push(recorded);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data === "string")
        record.sentTypes.push((JSON.parse(data) as { type: string }).type);
      send(data);
    };
    const close = socket.close.bind(socket);
    socket.close = (code, reason) => {
      recorded.closeCodes.push(code);
      if (held === undefined) close(code, reason);
      else held.push(() => close(code, reason));
    };
    return socket;
  };
  return { record, createSocket };
}

/**
 * Accept `invitation` and open the run connection as the app's acceptor
 * does: the run's relay plan, from the invitation's relay with no relay of
 * this browser's own and no default relay in the build, raced against the
 * app's WebRTC dial by its relay fallback. The relay client's socket factory
 * is the one piece of the harness's: it records each socket and holds back
 * its closes ({@link RelaySocketRecord}).
 */
export async function openRelayCaseAcceptor(
  invitation: string,
): Promise<OpenedRelayCaseAcceptor> {
  const { token, endpoint, prepared } = await acceptInBrowser(invitation);
  const notices: Array<string> = [];
  const onRunNotice = (notice: string): void => {
    notices.push(notice);
  };
  const relayPlan = await relayPlanForRun(
    token.sharedSecret,
    endpoint.relay,
    undefined,
    {
      readOwn: () => ({ kind: "none" }),
      build: () => ({ kind: "none" }),
      onRunNotice,
    },
  );
  const { record: sockets, createSocket } = recordingSocketFactory();
  const signal = new AbortController().signal;
  const run = await openRunConnectionWithRelayFallback(
    {
      role: "acceptor",
      sharedSecret: token.sharedSecret,
      relays: relayPlan.websocketRelays,
      signal,
      onCloseOutcome: () => {},
      onRunNotice,
      openWebRtc: async ({ signal: webRtcSignal, onPathFailed }) => {
        const [peer, conn] = await dialAsAcceptor(
          token.sharedSecret,
          endpoint,
          { signal: webRtcSignal, ...relayPlan, onPathFailed },
        );
        return openOneShotPeerConnection(peer, conn, {
          signal: webRtcSignal,
          onCloseOutcome: () => {},
          onPathFailed,
        });
      },
    },
    { createSocket },
  );
  for (const recorded of sockets.opened)
    recorded.readyStateAtRunOpen = recorded.socket.readyState;
  return {
    listedRelays: relayPlan.websocketRelays.map((relay) => relay.url),
    notices,
    sockets,
    exchange: async () => {
      try {
        const { connection, partnerIdentity, pairs } = await authenticateAndRun(
          {
            mc: run.connection,
            role: "acceptor",
            sharedSecret: token.sharedSecret,
            expires: token.expires,
            prepared,
          },
        );
        await connection.close();
        return { partnerIdentity, pairs };
      } finally {
        run.release();
      }
    },
  };
}

/**
 * A browser inviter that has registered at the broker and is waiting for its
 * partner: `run` takes the partner's connection and completes the exchange.
 */
export interface ListeningBrowserInviter {
  run: () => Promise<BrowserOutcome>;
  /** Leave the broker, for a run that never reached {@link run}. */
  destroy: () => void;
}

/** How long the browser inviter waits for its partner to connect, sized as
 * the partner's own budget is. */
const BROWSER_INVITER_WAIT_MS = 240_000;

/**
 * Register the browser inviter of `minted` at `signaling` through the app's
 * own listen, and resolve once registered.
 *
 * The app registers at its own build's signaling address, which on this test
 * page is the page's origin rather than the broker. The PeerJS constructor is
 * the one seam that differs: it is handed the broker's location in place of
 * that address, and the app's signaling bounds are installed on it as the
 * app's own constructor installs them.
 */
export async function listenAsBrowserInviter(
  minted: GeneratedInvitation,
  signaling: SignalingAddress,
): Promise<ListeningBrowserInviter> {
  const prepared = prepareForExchange(
    inviterExchangeDataSpec(minted.linkageTerms, {
      metadata: minted.metadata,
      standardization: minted.standardization,
      includeOwnColumns: minted.includeOwnColumns,
    }),
    BROWSER_IDENTITY,
    minted.rawRows,
    minted.columns,
  );
  const endpoint = {
    channel: "webrtc" as const,
    host: signaling.host,
    port: signaling.port ?? (signaling.secure ? 443 : 80),
    path: signaling.path,
  };
  const peer = await listenAsInviter(minted.sharedSecret, endpoint, {
    peerFactory: (id, options) =>
      boundPeerSignaling(
        new Peer(id, {
          ...options,
          host: signaling.host,
          port: signaling.port ?? (signaling.secure ? 443 : 80),
          path: signaling.path,
          secure: signaling.secure,
        }),
      ),
  });
  return {
    run: async () => {
      const conn = await waitForIncomingConnection(peer, {
        timeoutMs: BROWSER_INVITER_WAIT_MS,
      });
      return await runOverConnection({
        peer,
        conn,
        role: "inviter",
        sharedSecret: minted.sharedSecret,
        expires: minted.expires,
        prepared,
      });
    },
    destroy: () => peer.destroy(),
  };
}
