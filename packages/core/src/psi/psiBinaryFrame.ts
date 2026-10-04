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
import { ConnectionError } from "../connection/messageConnection";
import { isNamedDiagnosis, PeerAbortError } from "../errors";
import { isPartnerAbortFrame } from "../protocolSetup";

import type { MessageConnection } from "../connection/messageConnection";

/**
 * The reason a party puts on the abort it sends the partner in place of a set
 * of its own over `MAX_PSI_DECODE_ELEMENTS` or the partner's stated
 * receive ceiling. A first round the party could not count sends
 * `PSI_SET_REFUSED_ABORT_REASON` instead. A fixed literal, like every abort
 * reason (see `sendAbort`).
 */
export const PSI_SET_TOO_LARGE_ABORT_REASON = "a PSI set is too large to send";

/**
 * The reason a party puts on the abort it sends the partner when its first
 * round, checked against the partner's stated receive ceiling after the terms
 * exchange, refused for any cause other than its size. It states only that
 * the party refused to send its set.
 */
export const PSI_SET_REFUSED_ABORT_REASON =
  "a PSI set was refused before sending";

/**
 * The abort reason a party sends when the partner's set for a linkage key is
 * larger than this party can process: at the terms exchange
 * (`checkPartnerRoundCapacity` in exchange.ts) or at the first part of the set
 * (`receivePsiSet`). A fixed literal, as every abort reason must be (see
 * `sendAbort`).
 */
export const PARTNER_SET_OVER_CAPACITY_ABORT_REASON =
  "the partner cannot process a set as large as the one you send for a " +
  "linkage key";

const ROUND_ABORT_REASONS: ReadonlyArray<string> = [
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
];

// The one fixed round abort reason an abort frame states, as this build's own
// constant, or undefined for any other frame: the frame's text is never kept.
function roundAbortReasonOf(frame: unknown): string | undefined {
  const reasons = (frame as { abortReasons?: unknown }).abortReasons;
  if (!Array.isArray(reasons) || reasons.length !== 1) return undefined;
  return ROUND_ABORT_REASONS.find((reason) => reason === reasons[0]);
}

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
 * A partner's abort decision raises {@link PeerAbortError}: the partner ended
 * the exchange and holds the reason locally. The abort's reasons are
 * partner-written text, compared only against the fixed reasons a round sends;
 * the error's `partnerReason` holds this build's own constant where one
 * matches, so the error holds no partner byte.
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
  if (isPartnerAbortFrame(frame))
    throw new PeerAbortError(undefined, roundAbortReasonOf(frame));
  const prefix = participantId === "" ? "" : `${participantId} `;
  throw new ConnectionError(
    `${prefix}protocol error: inbound ${what} is not a binary frame`,
    "protocol",
  );
}

/**
 * Runs a PSI library decode, framing what it throws as a `protocol`
 * {@link ConnectionError} that names the frame and holds the library's own
 * decode message as its `cause`.
 *
 * Two failures keep their own message as the top line instead, because
 * "failed to decode" would misreport them:
 *
 * - An error that is already a {@link ConnectionError}, which is classified.
 * - An error the PSI engine raised itself, which {@link isNamedDiagnosis}
 *   recognizes by tag because its message states the condition --
 *   a precondition this party broke, which is a local fault and not the
 *   partner's frame at all, or the reveal-flag divergence between the two
 *   parties' rounds, named so it is read as the disagreement it is.
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
    if (err instanceof ConnectionError) throw err;
    if (isNamedDiagnosis(err)) throw err;
    throw new ConnectionError(
      `${participantId} protocol error: inbound PSI ${what} failed to decode`,
      "protocol",
      { cause: err },
    );
  }
}
