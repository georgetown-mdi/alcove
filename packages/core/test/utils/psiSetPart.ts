import { psiSetParts } from "../../src/psi/psiSetParts";

/**
 * A PSI set's bytes framed as the one part a round sends them in, for a test
 * that hands a participant a set frame directly. An `ArrayBuffer` stays one,
 * as the browser transport delivers it; anything that is not bytes is
 * returned unchanged.
 */
export function asOnePsiSetPart(frame: unknown): unknown {
  const onePart = (set: Uint8Array): Uint8Array => {
    const [part] = psiSetParts(set, Math.max(1, set.byteLength));
    return part;
  };
  if (frame instanceof ArrayBuffer)
    return onePart(new Uint8Array(frame)).buffer;
  if (frame instanceof Uint8Array) return onePart(frame);
  return frame;
}
