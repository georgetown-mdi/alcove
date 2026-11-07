// The PeerJS-coupled half of the WebRTC data-channel inbound bound
// (docs/spec/TRANSPORT_BOUNDS.md): it wraps this connection class's reassembly
// and unpack internals to enforce the bounds at the points PeerJS leaves
// unbounded. The transport-agnostic half -- the fixed bound constants and the
// BinaryPack structural pre-scan they parameterize -- lives in `@alcove/core`
// (connection/binaryPackBounds.ts), so every WebRTC transport enforces one
// implementation of them.

import { unpack } from "peerjs-js-binarypack";

import {
  ConnectionError,
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  admitsBinaryOnlyFrame,
  asConnectionError,
  binaryByteLength,
  binaryBytes,
  describeFrameStructureRefusal,
  inheritsFromBinaryWithoutBeingBinary,
  nonBinaryFrameError,
  scanFrameStructure,
} from "@alcove/core";

import type { DataConnection } from "peerjs";

/**
 * One slice of a chunked PeerJS frame, as the PeerJS chunker produces it
 * (`__peerData` is the message id shared by every chunk of one frame, `n` the
 * chunk index, `total` the chunk count, `data` the slice bytes). Every field
 * is peer-chosen, so `_handleChunk` receives an `unknown` and
 * {@link describeMalformedChunk} establishes this shape before anything is
 * charged or stored.
 */
interface PeerChunk {
  __peerData: number;
  n: number;
  total: number;
  data: ArrayBufferView | ArrayBuffer;
}

/** A message handed to PeerJS's `_handleDataMessage`, the sole point at which an
 * inbound (or reassembled) frame is `unpack`ed, and which this guard replaces.
 * `data` is what the data channel delivered: binary for a PeerJS sender, but a
 * data channel types each message on its own, so a peer can send text on it too. */
interface PeerDataMessage {
  data: unknown;
}

/**
 * The PeerJS `DataConnection` internals this guard wraps. PeerJS reassembles
 * a chunked binary frame in `_handleChunk` (accumulating slices into
 * `_chunkedData` keyed by message id, deleting the entry on completion), and
 * `unpack`s every frame -- unchunked, or the reassembled buffer on completion
 * -- in `_handleDataMessage`, which the guard replaces with its own decode and
 * dispatch ({@link dispatchDecodedFrame}). None is part of the public
 * `DataConnection` type, so this is a documented dependency assumption;
 * {@link assertChunkReassemblySupported} checks all three exist, so a
 * `peerjs` upgrade that renames or restructures them fails loud.
 */
interface ChunkedDataConnection {
  _handleChunk: (chunk: unknown) => void;
  _handleDataMessage: (message: PeerDataMessage) => void;
  _chunkedData: Record<number, { count: number } | undefined>;
}

/** A chunk index or count that indexes a real slice: a non-negative safe integer. */
function isChunkOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Returns the {@link PeerChunk} and its slice's byte length, or what is wrong
 * with the envelope. The same rule the CLI's receive dispatch applies
 * (`classifyInboundValue`, packages/core/src/connection/peerjsWire.ts), so
 * both parties refuse the same envelopes. PeerJS stores
 * `new Uint8Array(data)`, which for a number or numeric string allocates that
 * many bytes, so a non-binary `data` must never reach it.
 */
function readChunkEnvelope(
  received: unknown,
): { chunk: PeerChunk; byteLength: number } | { malformed: string } {
  if (typeof received !== "object" || received === null)
    return { malformed: "it is not an object" };
  const {
    __peerData: id,
    n,
    total,
    data,
  } = received as Record<string, unknown>;
  if (!Number.isSafeInteger(id))
    return { malformed: "its chunk message id is not an integer" };
  if (!isChunkOrdinal(total) || total < 1)
    return { malformed: "its chunk count is not a positive integer" };
  if (!isChunkOrdinal(n) || n >= total)
    return { malformed: "its chunk index is outside the declared count" };
  const byteLength = binaryByteLength(data);
  if (byteLength === undefined)
    return { malformed: "its chunk payload is not binary" };
  if (byteLength === 0) return { malformed: "its chunk payload is empty" };
  return { chunk: received as PeerChunk, byteLength };
}

/** A datagram no PeerJS binary sender emits, or one whose BinaryPack body the
 * unpacker throws on: the same refusal, in the same words, as the CLI's receive
 * path (`malformedFrameError`, packages/core/src/connection/peerjsWire.ts). */
function malformedDatagramError(detail: string): ConnectionError {
  return new ConnectionError(
    `the peer sent a malformed WebRTC frame: ${detail}`,
    "protocol",
  );
}

/** A chunk stream no PeerJS sender produces: the same refusal, in the same
 * words, as the CLI's reassembler (`reassemblyProtocolError`,
 * packages/core/src/connection/webrtcInboundBounds.ts). */
function chunkStreamError(detail: string): ConnectionError {
  return new ConnectionError(
    `the peer sent an invalid WebRTC chunk stream: ${detail}`,
    "protocol",
  );
}

/**
 * The refusal of one decoded frame before it is routed, or `undefined` to
 * route it, in the CLI's reassembler's words for each: a value inheriting from
 * binary data without being binary, a reassembled frame that is itself an
 * envelope, and, once binary frames are required, a frame to deliver that is
 * not binary.
 */
function decodedFrameRefusal(
  decoded: unknown,
  reassembled: boolean,
  binaryFramesRequired: boolean,
): ConnectionError | undefined {
  if (inheritsFromBinaryWithoutBeingBinary(decoded))
    return malformedDatagramError(
      "it decodes to an object that inherits from binary data but is not binary",
    );
  const peerData: unknown =
    typeof decoded === "object" && decoded !== null
      ? (decoded as { __peerData?: unknown }).__peerData
      : undefined;
  if (peerData) {
    return reassembled
      ? chunkStreamError(
          "its chunks reassemble into another envelope rather than a frame",
        )
      : undefined;
  }
  if (binaryFramesRequired && binaryByteLength(decoded) === undefined)
    return nonBinaryFrameError();
  return undefined;
}

/**
 * Routes one decoded frame as PeerJS's `_handleDataMessage` does after its
 * `unpack`: a truthy `__peerData` is the in-band close sentinel or a chunk
 * envelope, and anything else is delivered to the `data` listeners with
 * `receivedBytes`, the length of the frame it was unpacked from, as a second
 * argument. A frame that decodes to `null` or `undefined` is delivered too, as
 * the CLI's receive dispatch delivers it (`classifyInboundValue`,
 * packages/core/src/connection/peerjsWire.ts), where PeerJS itself throws.
 */
function dispatchDecodedFrame(
  conn: DataConnection,
  internals: ChunkedDataConnection,
  decoded: unknown,
  receivedBytes: number,
): void {
  const peerData: unknown =
    typeof decoded === "object" && decoded !== null
      ? (decoded as { __peerData?: unknown }).__peerData
      : undefined;
  if (peerData) {
    if ((peerData as { type?: unknown }).type === "close") {
      conn.close();
      return;
    }
    internals._handleChunk(decoded);
    return;
  }
  // PeerJS types its `data` event with one argument; eventemitter3 passes
  // every argument to the listeners.
  (conn.emit as (event: "data", data: unknown, bytes: number) => boolean).call(
    conn,
    "data",
    decoded,
    receivedBytes,
  );
}

/** A terminal refusal, shared by every enforcement point: `predicate` says what
 * the frame did, so the message names the rule that fired rather than one
 * standing in for the rest. Kind `protocol`: a refused frame is the peer
 * violating the message contract (the same class as core's inbound-buffer
 * overflow), never benign, since every bound sits far above any legitimate frame.
 * It holds no peer-controlled bytes (only the fixed limits), so it needs no
 * redaction. */
function frameRefusalError(predicate: string): ConnectionError {
  return new ConnectionError(`inbound WebRTC frame ${predicate}`, "protocol");
}

/**
 * The delivered-frame half of the inbound byte bound: returns the terminal
 * {@link frameRefusalError} if `data` is a binary frame larger than
 * `maxBytes`, otherwise `undefined`. Runs at the stable `data` event -- a
 * safety check, at the public layer, for the reassembly guard at the fragile
 * internal layer, refusing an over-cap `Uint8Array` regardless of how PeerJS
 * chunked it. A parsed object/array returns `undefined`: the reassembly
 * bounds govern it before delivery and core's count/structure bounds after.
 * Binary is core's brand check (`binaryByteLength`), so an object that only
 * inherits from binary data is not measured as one.
 */
export function checkDeliveredFrameBound(
  data: unknown,
  maxBytes: number = MAX_WEBRTC_FRAME_BYTES,
): ConnectionError | undefined {
  const size = binaryByteLength(data);
  return size !== undefined && size > maxBytes
    ? frameRefusalError(`exceeds its ${maxBytes}-byte size limit`)
    : undefined;
}

/**
 * Asserts `conn` exposes the PeerJS internals {@link boundChunkReassembly}
 * wraps. Encodes the dependency assumption as a runtime check, not a
 * comment: a `peerjs` upgrade that renames or restructures the chunk
 * reassembly or the unpack chokepoint must fail loud (the live browser
 * exchange test installs the guard on every exchange) rather than silently
 * run with no inbound bound. Called before any listener is attached, so a
 * broken assumption fails cleanly with nothing to tear down.
 */
export function assertChunkReassemblySupported(conn: DataConnection): void {
  const probe = conn as unknown as {
    _handleChunk?: unknown;
    _handleDataMessage?: unknown;
    _chunkedData?: unknown;
  };
  if (
    typeof probe._handleChunk !== "function" ||
    typeof probe._handleDataMessage !== "function" ||
    !probe._chunkedData ||
    typeof probe._chunkedData !== "object"
  ) {
    throw new Error(
      "PeerJS data connection does not expose the expected reassembly/unpack " +
        "internals (_handleChunk/_handleDataMessage/_chunkedData); the inbound " +
        "frame bound cannot be installed. Re-verify against the installed peerjs " +
        "version.",
    );
  }
}

/**
 * Wraps `conn`'s PeerJS reassembly and unpack so an inbound frame cannot
 * exhaust memory, the primary inbound bound for the WebRTC transport. PeerJS
 * itself caps none of wire bytes, deserialized structure size, retained
 * chunk count, or concurrent reassemblies, and evicts no never-completed
 * partial; this wrap adds all of those before delegating, each fail-closed
 * via `fail`, so the offending chunk is never stored and the offending frame
 * is never unpacked:
 *
 * - The chunk envelope's shape, its declared chunk count against
 *   `maxChunks`, and one count and distinct indexes per frame (in
 *   `_handleChunk`, before any other bound charges it).
 * - Wire bytes across all in-flight reassemblies: `maxFrameBytes` (in
 *   `_handleChunk`).
 * - Retained chunks per reassembly: at most the declared count, so
 *   `maxChunks`, each charged at least `minChunkResidentBytes` against the
 *   byte cap.
 * - Concurrent incomplete reassemblies: `maxConcurrentReassemblies`; a new id
 *   beyond the cap silently evicts the oldest partial (the lockstep protocol
 *   never has a legitimate second partial, so eviction only drops
 *   adversarial data).
 * - The deserialized structure's shape, in `_handleDataMessage` (both an
 *   unchunked frame and a completed reassembly flow through it): one walk of
 *   the frame's BinaryPack bytes enforces the nesting depth, the per-string
 *   cap, the byte-backed-elements check, the cumulative element rule and the
 *   map-key rule before it is unpacked.
 * - The datagram itself, in `_handleDataMessage` before the scan: a text or
 *   empty datagram is refused, and so is one over `maxFrameBytes` and a frame
 *   BinaryPack's unpack throws on, each in the words the CLI's receive path
 *   uses.
 * - The decoded frame, before it is routed: a value inheriting from binary
 *   data without being binary, and a reassembled frame that is itself an
 *   envelope, each in the CLI reassembler's words.
 * - Once the returned `requireBinaryFrames` is called, a frame that is not
 *   binary, refused on its wire bytes before the scan as the CLI reassembler
 *   refuses it (`BoundedInboundFrames.requireBinaryFrames`).
 *
 * A throw while handling a decoded frame -- from a `data` listener or from
 * PeerJS's close -- also fails the connection, with that error behind a
 * `transport` wrap, so it keeps its own class and is never reported as a frame
 * the peer sent.
 *
 * @param conn   The PeerJS data connection (open or not yet open).
 * @param fail   Latches a terminal failure (the connection's `controls.fail`).
 * @param options  Per-bound overrides defaulting to the fixed core constants;
 *                 set only by tests, never an operator-facing setting.
 * @returns `requireBinaryFrames`, which the connection's hook of that name
 *   calls (see `MessageConnection.requireBinaryFrames`).
 * @throws If the PeerJS internals are not as expected (a broken upgrade
 *   assumption).
 */
export function boundChunkReassembly(
  conn: DataConnection,
  fail: (error: ConnectionError) => void,
  options?: {
    maxFrameBytes?: number;
    maxConcurrentReassemblies?: number;
    maxReassemblyDepth?: number;
    maxChunks?: number;
    minChunkResidentBytes?: number;
    maxStringBytes?: number;
  },
): { requireBinaryFrames: () => void } {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  const maxConcurrent =
    options?.maxConcurrentReassemblies ?? MAX_CONCURRENT_REASSEMBLIES;
  const maxDepth = options?.maxReassemblyDepth ?? MAX_WEBRTC_REASSEMBLY_DEPTH;
  const maxChunks = options?.maxChunks ?? MAX_CHUNKS_PER_REASSEMBLY;
  const minChunkBytes =
    options?.minChunkResidentBytes ?? MIN_CHUNK_RESIDENT_BYTES;
  const maxStringBytes = options?.maxStringBytes ?? MAX_WEBRTC_STRING_BYTES;

  assertChunkReassemblySupported(conn);
  const internals = conn as unknown as ChunkedDataConnection;
  const originalHandleChunk = internals._handleChunk.bind(internals);

  // Per-id accumulated state, in arrival order (Map preserves insertion order,
  // so the first key is the oldest partial to evict).
  const inFlight = new Map<
    number,
    { bytes: number; total: number; ordinals: Set<number> }
  >();
  let bytesInFlight = 0;
  // Latched once a bound fails the connection: it is terminal, so every later
  // chunk and frame is dropped without bookkeeping, reassembly, or unpack.
  let failed = false;
  let reassembling = false;
  let binaryFramesRequired = false;

  // Terminal, so every partial is released here: nothing reassembles after it.
  const failClosed = (error: ConnectionError): void => {
    if (failed) return;
    failed = true;
    for (const id of inFlight.keys()) delete internals._chunkedData[id];
    inFlight.clear();
    bytesInFlight = 0;
    fail(error);
  };

  const evictOldest = (): void => {
    const oldest = inFlight.keys().next().value;
    if (oldest === undefined) return;
    bytesInFlight -= inFlight.get(oldest)?.bytes ?? 0;
    inFlight.delete(oldest);
    delete internals._chunkedData[oldest];
  };

  // Bounds the chunk ACCUMULATION (before completion): envelope shape, declared
  // and retained chunk count, wire bytes, and concurrent reassemblies, evicting
  // the oldest partial past the cap.
  const handleChunk = (received: unknown): void => {
    const envelope = readChunkEnvelope(received);
    if ("malformed" in envelope) {
      failClosed(
        frameRefusalError(
          `has a malformed chunk envelope: ${envelope.malformed}`,
        ),
      );
      return;
    }
    const { chunk } = envelope;
    if (chunk.total > maxChunks) {
      failClosed(
        frameRefusalError(`exceeds its ${maxChunks}-chunk reassembly limit`),
      );
      return;
    }
    const id = chunk.__peerData;
    const bytes = Math.max(envelope.byteLength, minChunkBytes);
    const entry = inFlight.get(id);
    // PeerJS keeps the first chunk's count and completes on the number of
    // chunks received, so a second count or a repeated index would complete a
    // frame with a hole or a missing tail.
    if (entry !== undefined && entry.total !== chunk.total) {
      failClosed(
        frameRefusalError("declares two different chunk counts for one frame"),
      );
      return;
    }
    if (entry?.ordinals.has(chunk.n) === true) {
      failClosed(frameRefusalError("repeats a chunk index it already sent"));
      return;
    }

    if (entry === undefined) {
      while (inFlight.size >= maxConcurrent) evictOldest();
    }
    // Negated so a non-finite charge or running total refuses rather than
    // comparing false and admitting the chunk.
    if (!(Number.isFinite(bytes) && bytesInFlight + bytes <= maxFrameBytes)) {
      failClosed(
        frameRefusalError(`exceeds its ${maxFrameBytes}-byte size limit`),
      );
      return;
    }

    bytesInFlight += bytes;
    const ordinals = entry?.ordinals ?? new Set<number>();
    ordinals.add(chunk.n);
    inFlight.set(id, {
      bytes: (entry?.bytes ?? 0) + bytes,
      total: chunk.total,
      ordinals,
    });

    // PeerJS hands a completed frame back to `_handleDataMessage` from inside
    // this call, which is how the replacement below tells it from a datagram.
    reassembling = true;
    try {
      originalHandleChunk(chunk);
    } finally {
      reassembling = false;
    }

    // PeerJS deletes the `_chunkedData` entry when the frame completes; mirror
    // that here so a completed frame's bytes are released from the running total.
    if (internals._chunkedData[id] === undefined) {
      bytesInFlight -= inFlight.get(id)?.bytes ?? 0;
      inFlight.delete(id);
    }
  };

  // A throw in the checks above or in PeerJS's own reassembly fails the
  // connection rather than leaving it open to handle the next chunk.
  internals._handleChunk = (received: unknown): void => {
    if (failed) return;
    try {
      handleChunk(received);
    } catch {
      failClosed(frameRefusalError("could not be reassembled"));
    }
  };

  // Bounds the DESERIALIZED structure at the unpack chokepoint, which both an
  // unchunked frame (direct call) and a completed reassembly (recursive call from
  // `_handleChunk`) flow through. Scanning here, before the unpack, covers a
  // tiny unchunked frame that never reaches `_handleChunk` at all.
  // A text or empty datagram is refused before the scan: BinaryPack decodes
  // either to the number 0, which would reach the application as a frame.
  internals._handleDataMessage = (message: PeerDataMessage): void => {
    if (failed) return;
    const reassembled = reassembling;
    const bytes = binaryBytes(message.data);
    if (bytes === undefined) {
      failClosed(malformedDatagramError("it is not a binary datagram"));
      return;
    }
    if (bytes.byteLength === 0) {
      failClosed(malformedDatagramError("it is an empty datagram"));
      return;
    }
    if (bytes.byteLength > maxFrameBytes) {
      failClosed(
        frameRefusalError(`exceeds its ${maxFrameBytes}-byte size limit`),
      );
      return;
    }
    if (
      binaryFramesRequired &&
      !admitsBinaryOnlyFrame(bytes, reassembled ? "reassembled" : "datagram")
    ) {
      failClosed(nonBinaryFrameError());
      return;
    }
    const refusal = scanFrameStructure(bytes, maxDepth, maxStringBytes);
    if (refusal !== undefined) {
      failClosed(frameRefusalError(describeFrameStructureRefusal(refusal)));
      return;
    }
    // PeerJS calls this from the data channel's message handler, where a throw
    // would be dropped and leave the connection waiting.
    let decoded: unknown;
    try {
      decoded = unpack(message.data as ArrayBuffer);
    } catch {
      failClosed(
        malformedDatagramError("its BinaryPack body could not be decoded"),
      );
      return;
    }
    const decodedRefusal = decodedFrameRefusal(
      decoded,
      reassembled,
      binaryFramesRequired,
    );
    if (decodedRefusal !== undefined) {
      failClosed(decodedRefusal);
      return;
    }
    try {
      dispatchDecodedFrame(conn, internals, decoded, bytes.byteLength);
    } catch (error) {
      failClosed(asConnectionError(error, "transport"));
    }
  };

  return {
    requireBinaryFrames: () => {
      binaryFramesRequired = true;
    },
  };
}
