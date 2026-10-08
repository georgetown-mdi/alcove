// Replaces PeerJS's recursive BinaryPack encode step with core's iterative
// encoder, so a large matched set cannot overflow the sender's stack after the
// PSI compute. Chunking and buffering stay with PeerJS. See
// docs/spec/WEBRTC_TRANSPORT.md#outbound-encoding.

import { encodeBinaryPackValue } from "@alcove/core";

import type { DataConnection } from "peerjs";

/**
 * The private PeerJS `DataConnection` internals this override replaces and
 * calls; {@link assertIterativePackingSupported} checks they exist.
 */
interface PackingDataConnection {
  _send: (data: unknown, chunked: boolean) => void;
  _sendChunks: (packed: ArrayBuffer) => void;
  _bufferedSend: (packed: ArrayBuffer) => void;
  chunker: { chunkedMTU: number };
}

/**
 * Asserts `conn` exposes the PeerJS internals
 * {@link packOutboundFramesIteratively} replaces and calls, so a `peerjs`
 * upgrade that moves them fails before any listener is attached instead of
 * leaving the recursive packer in place. `_send_blob` is not probed: the
 * replacement drops it and the encoder refuses a `Blob`. See
 * docs/spec/DEPENDENCY_PINS.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack.
 */
export function assertIterativePackingSupported(conn: DataConnection): void {
  const probe = conn as unknown as {
    _send?: unknown;
    _sendChunks?: unknown;
    _bufferedSend?: unknown;
    chunker?: { chunkedMTU?: unknown };
  };
  if (
    typeof probe._send !== "function" ||
    typeof probe._sendChunks !== "function" ||
    typeof probe._bufferedSend !== "function" ||
    typeof probe.chunker?.chunkedMTU !== "number"
  ) {
    throw new Error(
      "PeerJS data connection does not expose the expected send internals " +
        "(_send/_sendChunks/_bufferedSend/chunker.chunkedMTU); outbound frames " +
        "cannot be packed without recursion. Re-verify against the installed " +
        "peerjs version.",
    );
  }
}

/**
 * Replaces `conn`'s BinaryPack encode step with core's iterative encoder,
 * keeping the original's routing: a chunk or a frame within the chunker's MTU
 * goes to `_bufferedSend`, anything larger to `_sendChunks`.
 *
 * @param conn  The PeerJS data connection; install before the first send.
 * @throws If the PeerJS internals are not as expected, or, at send time, if a
 *   frame contains a value kind the wire does not support.
 */
export function packOutboundFramesIteratively(conn: DataConnection): void {
  assertIterativePackingSupported(conn);
  const internals = conn as unknown as PackingDataConnection;

  internals._send = (data: unknown, chunked: boolean): void => {
    const packed = encodeBinaryPackValue(data);
    if (!chunked && packed.byteLength > internals.chunker.chunkedMTU) {
      internals._sendChunks(packed);
      return;
    }
    internals._bufferedSend(packed);
  };
}
