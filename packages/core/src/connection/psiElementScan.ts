// Wire-format element-count scanner for the PSI decode call sites: counts the
// encrypted elements a partner-supplied protobuf frame declares, without
// materializing them, so an over-declared frame is rejected before
// `deserializeBinary` allocates its ~211-byte object per declared entry, or the
// engine's streaming match its fixed slot per setup element -- closing a
// frame-bytes-to-element-count memory amplification that could otherwise
// exhaust memory before a later count could catch it. Raw-protobuf analogue of
// the WebRTC BinaryPack scan (connection/binaryPackBounds.ts).
//
// Reads only the protobuf wire format (varint tags, wire types,
// length-delimited fields), never the @openmined/psi.js message API, so a
// library version bump cannot silently change what it parses. It assumes the
// message structure -- the encrypted-element list sits at the top level on a
// Request/Response and one submessage deep on a ServerSetup -- pinned along
// with the scan/library element-count equivalence by psiElementScan.test.ts;
// re-verify both on an @openmined/psi.js upgrade.
//
// Counts every length-delimited field at the target depth, an upper bound on
// what `deserializeBinary` actually materializes, so it never under-counts.
// An unparseable frame throws and the caller rejects it -- fail closed, since
// a conforming peer serializes the same wire format the scan accepts. The
// frame may be handed over in pieces cut at any byte (a set received in
// parts), and the count and the refusals are the same however it is cut.

/**
 * The three partner-supplied PSI message kinds decoded at the participant
 * call sites.
 * @internal
 */
export type PsiMessageKind = "request" | "response" | "serverSetup";

// encrypted_elements nesting depth per message kind: top level on Request/Response,
// one submessage deep on ServerSetup (the Raw/GCS/Bloom oneof member).
const ELEMENT_DEPTH: Record<PsiMessageKind, number> = {
  request: 0,
  response: 0,
  serverSetup: 1,
};

// The field header being read: its tag varint, then the varint a varint field
// holds or the length a length-delimited field declares.
type HeaderPart = "tag" | "value" | "length";

/**
 * The element-count scan over a frame handed over in pieces cut at any byte,
 * each scanned as it arrives, so a set received in parts is counted without
 * joining it. {@link countDeclaredPsiElements} is this scan over one piece.
 * @internal
 */
export class PsiElementScan {
  private readonly targetDepth: number;
  private readonly ceiling: number;
  private readonly totalBytes: number;
  private count = 0;
  private offset = 0;
  // End offsets of the length-delimited fields the scan descended into,
  // innermost last; the frame's own length bounds the top level.
  private readonly ends: number[] = [];
  private skipTo = 0;
  private reading: HeaderPart | undefined;
  private wireType = 0;
  private varint = 0;
  private shift = 0;

  /**
   * @param totalBytes - The frame's whole length, known before its first
   *   piece (a set's parts declare it), so a field declared past the frame's
   *   end is refused at its header.
   */
  constructor(kind: PsiMessageKind, ceiling: number, totalBytes: number) {
    this.targetDepth = ELEMENT_DEPTH[kind];
    this.ceiling = ceiling;
    this.totalBytes = totalBytes;
  }

  /**
   * Scans the frame's next `piece` and returns the count so far: a value above
   * the ceiling once the frame declares more, after which no later byte is
   * read. Throws on a malformed frame.
   */
  add(piece: Uint8Array): number {
    if (this.count > this.ceiling) return this.count;
    if (piece.byteLength > this.totalBytes - this.offset)
      throw new Error("PSI element scan: bytes past the frame's length");
    const length = piece.byteLength;
    let pos = 0;
    while (pos < length) {
      if (this.offset < this.skipTo) {
        const step = Math.min(this.skipTo - this.offset, length - pos);
        pos += step;
        this.offset += step;
        continue;
      }
      const boundary = this.ends.at(-1) ?? this.totalBytes;
      if (this.reading === undefined) {
        if (this.offset === boundary) {
          this.ends.pop();
          continue;
        }
        this.startHeaderPart("tag");
        this.wireType = piece[pos]! & 0x07;
      } else if (this.offset === boundary) {
        throw new Error("PSI element scan: truncated varint");
      }
      const byte = piece[pos]!;
      pos += 1;
      this.offset += 1;
      this.varint += (byte & 0x7f) * 2 ** this.shift;
      if ((byte & 0x80) !== 0) {
        this.shift += 7;
        if (this.shift > 63)
          throw new Error("PSI element scan: varint too long");
        continue;
      }
      this.headerPartRead(boundary);
      if (this.count > this.ceiling) return this.count;
    }
    return this.count;
  }

  /**
   * Ends the scan once every piece is added and returns the frame's count, or
   * a value above the ceiling as {@link add} does. Throws on a frame that ends
   * inside a field or short of its length.
   */
  end(): number {
    if (this.count > this.ceiling) return this.count;
    if (this.offset !== this.totalBytes)
      throw new Error("PSI element scan: frame ends short of its length");
    if (this.reading !== undefined)
      throw new Error("PSI element scan: truncated varint");
    return this.count;
  }

  private startHeaderPart(part: HeaderPart): void {
    this.reading = part;
    this.varint = 0;
    this.shift = 0;
  }

  private headerPartRead(boundary: number): void {
    const part = this.reading;
    this.reading = undefined;
    if (part === "length") {
      const end = this.offset + this.varint;
      if (end > boundary)
        throw new Error("PSI element scan: field length past end");
      if (this.ends.length === this.targetDepth) {
        this.count += 1;
        this.skipTo = end;
      } else {
        this.ends.push(end);
      }
      return;
    }
    if (part !== "tag") return;
    if (this.wireType === 2) this.startHeaderPart("length");
    else if (this.wireType === 0) this.startHeaderPart("value");
    else if (this.wireType === 1)
      this.skipFixed(8, boundary, "truncated 64-bit field");
    else if (this.wireType === 5)
      this.skipFixed(4, boundary, "truncated 32-bit field");
    else
      throw new Error(
        `PSI element scan: unsupported wire type ${this.wireType}`,
      );
  }

  private skipFixed(bytes: number, boundary: number, refusal: string): void {
    if (this.offset + bytes > boundary)
      throw new Error(`PSI element scan: ${refusal}`);
    this.skipTo = this.offset + bytes;
  }
}

/**
 * The number of encrypted elements the serialized PSI `kind` frame declares, read
 * from the protobuf wire format without materializing the elements. Stops counting
 * once the total exceeds `ceiling` (returns a value > ceiling then), so an
 * adversarially over-declared frame costs O(ceiling), not O(frame). Throws on a
 * malformed frame. See the module header for the safety argument.
 * @internal
 */
export function countDeclaredPsiElements(
  bytes: Uint8Array,
  kind: PsiMessageKind,
  ceiling: number,
): number {
  const scan = new PsiElementScan(kind, ceiling, bytes.byteLength);
  scan.add(bytes);
  return scan.end();
}
