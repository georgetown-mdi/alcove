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
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";
import { prepareAcceptorExchange } from "@exchange/acceptorExchange";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes";

import type { CSVRow, PreparedExchange, RendezvousRole } from "@alcove/core";
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
  const handshakeRole = handshakeRoleForRendezvousRole(role);
  await authenticateExchange(mc, handshakeRole, sharedSecret, expires);
  const psiLibrary = await (PSI() as Promise<PSILibrary>);
  const result = await runExchange(mc, handshakeRole, prepared, { psiLibrary });

  const ending = endBeforeOwnClose(conn, connectionError);
  // The measurement: a flushing close queues the in-band close sentinel behind
  // the final frame and then waits for the peer to close the channel, so this
  // span is what a browser operator waits after their result is on screen.
  const closeStartedAt = performance.now();
  await mc.close();
  const closeWaitMs = Math.round(performance.now() - closeStartedAt);
  peer.disconnect();

  return {
    partnerIdentity: result.partnerTerms.identity,
    pairs: matchedPairs(result.associationTable),
    closeOutcome,
    endBeforeOwnClose: ending,
    closeWaitMs,
  };
}

/** Run the browser peer's whole acceptor half: accept the invitation, dial the
 * broker the invitation names, authenticate, run the PSI rounds, and close
 * cleanly. */
export async function runBrowserAcceptor(
  invitation: string,
): Promise<BrowserOutcome> {
  // The app's own accept-path validation: checksum, expiry, an endpoint this
  // build can drive, and the terms' fail-closed checks.
  const accepted = await prepareAcceptedInvitation(invitation, {
    profile: "hosted",
  });
  if (accepted.endpoint.channel !== "webrtc")
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the partner minted a ` +
        `${accepted.endpoint.channel} endpoint, not a webrtc one`,
    );

  const { rawRows, columns } = await readBrowserCsv(BROWSER_CSV);
  const { edits } = acceptorLaunchPayload(
    acceptorColumnsEditorState(
      acceptorInitialColumnsState(columns),
      accepted.token.linkageTerms,
      rawRows,
    ),
  );
  const prepared = prepareAcceptorExchange({
    linkageTerms: accepted.token.linkageTerms,
    acceptorName: BROWSER_IDENTITY,
    edits,
    rawRows,
    columns,
    // The value an accept with no control of its own derives.
    deduplicate: false,
  });

  // The app's own dial, against the endpoint the partner minted.
  const [peer, conn] = await dialAsAcceptor(
    accepted.token.sharedSecret,
    accepted.endpoint,
  );
  return await runOverConnection({
    peer,
    conn,
    role: "acceptor",
    sharedSecret: accepted.token.sharedSecret,
    expires: accepted.token.expires,
    prepared,
  });
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
  const peer = await listenAsInviter(minted.sharedSecret, {
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
