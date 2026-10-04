// Builders and readers for the frames a matched-record list is sent in, so a
// test that hand-crafts or rewrites one of those lists works on the JSON body
// it means rather than on the part header (docs/spec/PROTOCOL.md, "A list of
// matched records is sent in parts").

import { MATCHED_LIST_PART_HEADER_BYTES } from "../../src/psi/matchedListParts";

/** One part's header fields. */
export interface PartHeader {
  readonly index: number;
  readonly count: number;
  readonly entries: number;
}

/**
 * A part frame holding `body`'s JSON under the stated header; the header
 * defaults to the only part of a list of `entriesOf(body)` entries.
 */
export function partFrame(
  body: unknown,
  header: Partial<PartHeader> = {},
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const frame = new Uint8Array(MATCHED_LIST_PART_HEADER_BYTES + json.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, header.index ?? 0);
  view.setUint32(4, header.count ?? 1);
  view.setBigUint64(8, BigInt(header.entries ?? entriesOf(body)));
  frame.set(json, MATCHED_LIST_PART_HEADER_BYTES);
  return frame;
}

/**
 * The entries a list body holds as a part counts them: an array's elements,
 * or a payload message's rows.
 */
export function entriesOf(body: unknown): number {
  if (Array.isArray(body)) return body.length;
  const rows = (body as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * The header and parsed JSON body of a part frame, or undefined for a frame
 * that is not one: not binary, or a body that is not JSON (a PSI set part).
 */
export function readPartFrame(
  frame: unknown,
): { header: PartHeader; body: unknown } | undefined {
  if (
    !(frame instanceof Uint8Array) ||
    frame.byteLength <= MATCHED_LIST_PART_HEADER_BYTES
  )
    return undefined;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        frame.subarray(MATCHED_LIST_PART_HEADER_BYTES),
      ),
    );
  } catch {
    return undefined;
  }
  return {
    header: {
      index: view.getUint32(0),
      count: view.getUint32(4),
      entries: Number(view.getBigUint64(8)),
    },
    body,
  };
}

/**
 * Passes a frame through `deviate` as a deviation written against JSON frames
 * reads it: a single-part list frame's body is handed over and the result sent
 * as the only part of a list of its own entries, and any other frame is handed
 * over as it arrived.
 */
export function deviateListBody(
  frame: unknown,
  deviate: (frame: unknown) => unknown,
): unknown {
  const read = readPartFrame(frame);
  if (read === undefined || read.header.count !== 1) return deviate(frame);
  return partFrame(deviate(read.body));
}

/**
 * The payload message a part frame holds, or undefined for any other frame:
 * the body of a part whose JSON is an object stating `hasData`.
 */
export function payloadPartBody(
  frame: unknown,
): { hasData: boolean; rows?: Array<Array<string | null>> } | undefined {
  const body = readPartFrame(frame)?.body;
  return typeof body === "object" && body !== null && "hasData" in body
    ? (body as { hasData: boolean })
    : undefined;
}
