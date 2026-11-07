// The one test of whether a transport-delivered value is binary, used by every
// receive path that admits a frame as bytes: core's PeerJS framing and the
// encryption layer here, and the web app's PeerJS wrap
// (apps/web/src/psi/transport/boundedReassembly.ts).
//
// A brand check rather than `instanceof`: BinaryPack's `unpack` assigns a map's
// `__proto__` key as the decoded object's prototype, so a peer can send a plain
// object that inherits from a real `Uint8Array` or `ArrayBuffer` without being
// one, and reading `byteLength` or `length` through that inheritance throws.

/** The prototypes a binary value inherits from: an `ArrayBuffer`'s, every
 * typed array's shared one, and a `DataView`'s. */
const BINARY_PROTOTYPES: ReadonlySet<unknown> = new Set<unknown>([
  ArrayBuffer.prototype,
  Object.getPrototypeOf(Uint8Array.prototype),
  DataView.prototype,
]);

/**
 * The byte length of a genuine typed-array view or `ArrayBuffer`, or
 * `undefined` for any other value, including an object that only inherits
 * from one.
 */
export function binaryByteLength(value: unknown): number | undefined {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const length: unknown = Reflect.get(
      ArrayBuffer.prototype,
      "byteLength",
      value,
    );
    return typeof length === "number" ? length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `Uint8Array` over the bytes of a genuine typed-array view or
 * `ArrayBuffer`, without copying, or `undefined` for any other value
 * ({@link binaryByteLength}). The result is always a plain `Uint8Array`, never
 * the value itself, so a Node `Buffer` (whose `slice` returns a view, not a
 * copy) is not handed on as one.
 */
export function binaryBytes(
  value: unknown,
): Uint8Array<ArrayBuffer> | undefined {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer as ArrayBuffer,
      value.byteOffset,
      value.byteLength,
    );
  if (binaryByteLength(value) === undefined) return undefined;
  return new Uint8Array(value as ArrayBuffer);
}

/**
 * Whether `value` is an object whose prototype chain holds a binary prototype
 * while it is not itself binary ({@link binaryByteLength}): the shape a
 * decoded map with a `__proto__` key takes.
 */
export function inheritsFromBinaryWithoutBeingBinary(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (binaryByteLength(value) !== undefined) return false;
  for (
    let prototype: unknown = Object.getPrototypeOf(value);
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype as object)
  ) {
    if (BINARY_PROTOTYPES.has(prototype)) return true;
  }
  return false;
}
