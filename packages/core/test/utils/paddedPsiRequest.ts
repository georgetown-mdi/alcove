import { PSI_ELEMENT_BYTES } from "../../src/connection/psiElementScan";

// A length-delimited field 15 of one element's length, a top-level field the
// PSI request message does not define: the library skips it, a wire scan
// counts it.
const UNKNOWN_FIELD = [
  0x7a,
  PSI_ELEMENT_BYTES,
  ...new Array<number>(PSI_ELEMENT_BYTES).fill(0),
];

/**
 * The request with one unknown top-level field appended. It parses to the
 * request's own elements, while `countDeclaredPsiElements` counts one more,
 * so a request of `n - 1` real elements passes for `n`.
 */
export function withUnknownField(request: Uint8Array): Uint8Array {
  const padded = new Uint8Array(request.length + UNKNOWN_FIELD.length);
  padded.set(request);
  padded.set(UNKNOWN_FIELD, request.length);
  return padded;
}
