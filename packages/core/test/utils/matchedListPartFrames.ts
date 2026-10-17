// Builders and readers for the frames a matched-record list is sent in, so a
// test that hand-crafts or rewrites one of those lists works on the JSON body
// it means rather than on the part header (docs/spec/PROTOCOL.md, "A list of
// matched records is sent in parts").

import { MATCHED_LIST_PART_HEADER_BYTES } from "../../src/psi/matchedListParts";
import {
  receiveRoundGrouping,
  receiveRoundIndexList,
  sendRoundGrouping,
  sendRoundIndexList,
} from "../../src/psi/roundTableParts";

import type { MessageConnection } from "../../src/connection/messageConnection";

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
 * `conn` with every inbound frame passed through `deviate` as
 * {@link deviateListBody} does, except that a cascade round's position-naming
 * lists -- the one-part lists arriving right after a PSI set part -- are read
 * together and handed over as the one frame they make up: the association
 * table `[partnerHalf, localHalf]` on the starter and the original-index list
 * on the joiner, each with the sender's grouping beside it where one is
 * present. What `deviate` returns is split back into the lists in the same
 * reading.
 *
 * @param party - The role receiving: the starter reads the association table,
 *   the joiner the original-index list.
 * @param grouped - Whether the round sends a grouping list after its index
 *   lists.
 */
export function roundFramesInbound(
  conn: MessageConnection,
  party: "starter" | "joiner",
  grouped: boolean,
  deviate: (frame: unknown) => unknown,
): MessageConnection {
  const queued: Array<unknown> = [];
  let afterPsiSetPart = false;
  const indexLists = party === "starter" ? 2 : 1;
  const readOnePartBody = (frame: unknown): unknown => {
    const read = readPartFrame(frame);
    if (read === undefined || read.header.count !== 1)
      throw new Error("roundFramesInbound reads one-part lists only");
    return read.body;
  };
  const receive = async (timeoutMs?: number): Promise<unknown> => {
    if (queued.length > 0) return queued.shift();
    const frame = await conn.receive(timeoutMs);
    const read = readPartFrame(frame);
    if (frame instanceof Uint8Array && read === undefined) {
      afterPsiSetPart = true;
      return deviate(frame);
    }
    if (read === undefined || !afterPsiSetPart)
      return deviateListBody(frame, deviate);
    afterPsiSetPart = false;
    const lists = [readOnePartBody(frame)];
    for (let i = 1; i < indexLists + (grouped ? 1 : 0); i++)
      lists.push(readOnePartBody(await conn.receive(timeoutMs)));
    const grouping = grouped ? lists[indexLists] : null;
    const indices = lists.slice(0, indexLists);
    const whole =
      party === "starter"
        ? grouping === null
          ? indices
          : [...indices, grouping]
        : grouping === null
          ? indices[0]
          : [indices[0], grouping];
    const deviated = deviate(whole);
    let bodies: Array<unknown>;
    if (party === "starter") {
      const table = deviated as Array<unknown>;
      bodies = [table[0], table[1]];
      if (grouped) bodies.push(table.length > 2 ? table[2] : null);
    } else {
      const twoPart =
        Array.isArray(deviated) &&
        deviated.length === 2 &&
        Array.isArray(deviated[0]);
      bodies = [twoPart ? deviated[0] : deviated];
      if (grouped) bodies.push(twoPart ? deviated[1] : null);
    }
    for (const body of bodies) queued.push(partFrame(body));
    return queued.shift();
  };
  return {
    send: (data) => conn.send(data),
    receive,
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}

/**
 * A cascade round's association table as a hand-played starter receives it,
 * `[joinerPositions, starterSlots]`, its grouping list read and dropped.
 */
export async function receiveHandPlayedRoundTable(
  conn: MessageConnection,
): Promise<[Array<number>, Array<number>]> {
  const read = () =>
    receiveRoundIndexList(
      conn,
      "",
      "association table",
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
    );
  const joinerPositions = await read();
  const starterSlots = await read();
  await receiveRoundGrouping(conn, "", "grouping", Number.MAX_SAFE_INTEGER, {
    maxPositionsPerRecord: 2 ** 31,
    partnerRecordCount: 2 ** 31,
    ownerLists: true,
  });
  return [joinerPositions, starterSlots];
}

/**
 * Sends a cascade round's original-index list as a hand-played starter does,
 * its grouping omitted.
 */
export async function sendHandPlayedOriginalIndexList(
  conn: MessageConnection,
  list: ReadonlyArray<number>,
): Promise<void> {
  await sendRoundIndexList(conn, list);
  await sendRoundGrouping(conn, undefined);
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
