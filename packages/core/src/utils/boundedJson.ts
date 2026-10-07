import { decFatal } from "./crypto";
import { exceedsJsonStructureBound } from "./jsonStructureBound";

// Structural bounds checked on every untrusted JSON body before JSON.parse: an
// object wide enough or an array long enough drives JSON.parse into an engine
// limit that aborts the process, which no try/catch intercepts. Per container:
// members of one object (above the widest legitimate one, the 256-entry
// transform.params), elements of one array (at the engine limit; longer lists are
// sent in parts), and nesting depth. Values and derivation:
// docs/spec/CHANNEL_SECURITY.md, Application-layer parsed-input bounds.
/** @internal */
export const MAX_JSON_OBJECT_KEYS = 65536;
/** @internal */
export const MAX_JSON_ARRAY_ELEMENTS = 16_777_216;
/** @internal */
export const MAX_JSON_NESTING_DEPTH = 4096;

/**
 * Thrown by {@link parseBoundedJson} when the input's structure exceeds a bound,
 * distinct from the `SyntaxError`/`TypeError` of a malformed or invalid-UTF-8
 * body. The message is fixed text with no input bytes.
 */
export class JsonStructureBoundError extends Error {
  constructor() {
    super("JSON payload structure exceeds the permitted bound");
    this.name = "JsonStructureBoundError";
  }
}

/**
 * The sole entry point for parsing untrusted JSON (a partner wire frame, a
 * transport-controlled file, an invitation token), enforced by an ESLint rule.
 * Bytes decode UTF-8-fatal; a string is scanned and parsed as is. Throws
 * {@link JsonStructureBoundError} on an out-of-bound structure, or the native
 * error on malformed or invalid-UTF-8 input.
 */
export function parseBoundedJson(input: Uint8Array | string): unknown {
  if (
    exceedsJsonStructureBound(
      input,
      MAX_JSON_OBJECT_KEYS,
      MAX_JSON_ARRAY_ELEMENTS,
      MAX_JSON_NESTING_DEPTH,
    )
  ) {
    throw new JsonStructureBoundError();
  }
  return JSON.parse(typeof input === "string" ? input : decFatal.decode(input));
}
