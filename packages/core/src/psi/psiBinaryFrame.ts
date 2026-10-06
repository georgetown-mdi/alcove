// The PSI rounds are the only place a party reads a raw byte frame off the
// wire and hands it to the PSI library, which rejects anything that is not a
// byte string with its own decode message and no Alcove framing. Two kinds of
// frame arrive here that the round did not ask for, so both are classified
// before any byte reaches the library:
//
//   - The partner's abort decision, which a refusal firing past the terms
//     exchange best-effort sends (see sendAbort). Those refusals are one-sided,
//     so the party reading the frame is parked on its next round and would
//     otherwise end on a decode message naming nothing it can act on.
//   - Any other frame, which keeps the cause it failed with behind an Alcove
//     protocol error naming the boundary.
import { isPsiLibraryFailure, ConnectionError } from "../errors";
import { throwIfPartnerAbort } from "../partnerAbortFrame";

import type { MessageConnection } from "../connection/messageConnection";

/**
 * Reads the next frame where the protocol expects PSI binary, classifying
 * whatever arrives before it can reach the library's decoder: the frame
 * {@link receiveBinaryFrame} reads, with the frame named "PSI <what>".
 *
 * @param conn - The connection to read from.
 * @param participantId - This party's participant id, prefixed on the message.
 * @param what - The frame this round awaited, named in the message.
 */
export async function receivePsiBinaryFrame(
  conn: MessageConnection,
  participantId: string,
  what: string,
): Promise<Uint8Array> {
  return receiveBinaryFrame(conn, participantId, `PSI ${what}`);
}

/**
 * Reads the next frame where the protocol expects a binary frame.
 *
 * Bytes delivered as an `ArrayBuffer` are viewed as a `Uint8Array`, the one
 * shape everything below reads. Anything else that is not a byte frame is a
 * `protocol` {@link ConnectionError} naming the frame this round awaited. It is
 * not reported as a refusal: a non-conforming peer that sends the wrong frame
 * has not refused anything.
 *
 * @param conn - The connection to read from.
 * @param participantId - This party's participant id, prefixed on the message,
 *   or "" for none.
 * @param what - The frame awaited, named in the message.
 */
export async function receiveBinaryFrame(
  conn: MessageConnection,
  participantId: string,
  what: string,
): Promise<Uint8Array> {
  return asBinaryFrame(await conn.receive(), participantId, what);
}

function asBinaryFrame(
  frame: unknown,
  participantId: string,
  what: string,
): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  // The browser WebRTC transport hands a sent Uint8Array over as an
  // ArrayBuffer, which the element scan beneath reads as a zero-length frame,
  // so it is viewed as bytes here.
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  throwIfPartnerAbort(frame);
  const prefix = participantId === "" ? "" : `${participantId} `;
  throw new ConnectionError(
    `${prefix}protocol error: inbound ${what} is not a binary frame`,
    "protocol",
  );
}

/**
 * Runs a PSI engine operation over a partner's frame, framing a failure the
 * PSI library raised ({@link isPsiLibraryFailure}) as a `protocol`
 * {@link ConnectionError} that names the frame and holds the library's own
 * message as its `cause`.
 *
 * Any other failure is raised unchanged: a refusal the engine names, a fault
 * on this party's own machine, or a step stopped because the connection ended
 * did not come from the partner's frame, and "failed to decode" would
 * misreport it.
 *
 * @param participantId - This party's participant id, prefixed on the message.
 * @param what - The frame being decoded, named in the message.
 * @param decode - The decode to run.
 */
export async function decodePsiBinaryFrame<T>(
  participantId: string,
  what: string,
  decode: () => Promise<T>,
): Promise<T> {
  try {
    return await decode();
  } catch (err) {
    if (!isPsiLibraryFailure(err)) throw err;
    throw new ConnectionError(
      `${participantId} protocol error: inbound PSI ${what} failed to decode`,
      "protocol",
      { cause: err },
    );
  }
}
