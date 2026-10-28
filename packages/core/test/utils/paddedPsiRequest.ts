// An empty length-delimited field 15, a top-level field the PSI request
// message does not define: the library skips it, a wire scan counts it.
const EMPTY_UNKNOWN_FIELD = [0x7a, 0x00];

/**
 * The request with one empty unknown top-level field appended. It parses to
 * the request's own elements, while `countDeclaredPsiElements` counts one
 * more, so a request of `n - 1` real elements passes for `n`.
 */
export function withEmptyUnknownField(request: Uint8Array): Uint8Array {
  const padded = new Uint8Array(request.length + EMPTY_UNKNOWN_FIELD.length);
  padded.set(request);
  padded.set(EMPTY_UNKNOWN_FIELD, request.length);
  return padded;
}
