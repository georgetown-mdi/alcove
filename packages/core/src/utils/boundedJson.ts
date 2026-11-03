import { availableMemoryBytes, collectGarbage } from "./availableMemory";
import { decFatal } from "./crypto";
import { formatCount } from "./formatCount";
import { scanJsonStructure } from "./jsonStructureBound";

// Structural bounds checked on every untrusted JSON body before JSON.parse: an
// object wide enough or an array long enough drives JSON.parse into an engine
// limit that aborts the process, which no try/catch intercepts. Per container:
// members of one object (above the widest legitimate one, the 256-entry
// transform.params), elements of one array (at the engine limit; longer lists are
// sent in parts), and nesting depth. Values and derivation:
// docs/spec/PARSED_INPUT_BOUNDS.md, Application-layer parsed-input bounds.
/** @internal */
export const MAX_JSON_OBJECT_KEYS = 65536;
/** @internal */
export const MAX_JSON_ARRAY_ELEMENTS = 16_777_216;
/** @internal */
export const MAX_JSON_NESTING_DEPTH = 4096;

// The heap a parsed JSON value is charged, in bytes: the whole document's
// values together may not need more than the memory available when it is
// parsed. Measured basis: same reference as above.
/** @internal */
export const JSON_RETAINED_BYTES_PER_NODE = 40;

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
 * Thrown by {@link parseBoundedJson} when the values a document would create
 * need more memory than this process has available: a shortfall of this
 * machine, not a fault in the document. The message states both figures and
 * no input bytes.
 */
export class JsonMemoryBudgetError extends Error {
  readonly neededBytes: number;
  readonly availableBytes: number;

  constructor(neededBytes: number, availableBytes: number) {
    super(
      `not enough free memory to read this JSON: it needs about ` +
        `${formatCount(neededBytes)} bytes and ` +
        `${formatCount(availableBytes)} are available`,
    );
    this.name = "JsonMemoryBudgetError";
    this.neededBytes = neededBytes;
    this.availableBytes = availableBytes;
  }
}

/**
 * What a caller reports when {@link JsonMemoryBudgetError} refuses `what`, a
 * message from the partner: that this machine lacks the memory, the two
 * figures, and the step that clears it.
 */
export function partnerMessageMemoryShortfall(
  what: string,
  err: JsonMemoryBudgetError,
): string {
  return (
    `this machine does not have enough free memory to read ${what}: it ` +
    `needs about ${formatCount(err.neededBytes)} bytes and ` +
    `${formatCount(err.availableBytes)} are available. Free memory on this ` +
    "machine, or raise the container's memory limit, and run the exchange " +
    "again."
  );
}

/**
 * The sole entry point for parsing untrusted JSON (a partner wire frame, a
 * transport-controlled file, an invitation token), enforced by an ESLint rule.
 * Bytes decode UTF-8-fatal; a string is scanned and parsed as is. Throws
 * {@link JsonStructureBoundError} on an out-of-bound structure,
 * {@link JsonMemoryBudgetError} on a document whose values need more memory
 * than is available, or the native error on malformed or invalid-UTF-8 input.
 */
export function parseBoundedJson(input: Uint8Array | string): unknown {
  const values = scanJsonStructure(
    input,
    MAX_JSON_OBJECT_KEYS,
    MAX_JSON_ARRAY_ELEMENTS,
    MAX_JSON_NESTING_DEPTH,
  );
  if (values === "structure") throw new JsonStructureBoundError();
  const neededBytes = values * JSON_RETAINED_BYTES_PER_NODE;
  let available = availableMemoryBytes();
  // Uncollected garbage counts as used memory, so a document over the budget
  // is checked once more after a collection where the runtime allows one.
  if (available !== undefined && neededBytes > available && collectGarbage())
    available = availableMemoryBytes();
  if (available !== undefined && neededBytes > available)
    throw new JsonMemoryBudgetError(neededBytes, available);
  return JSON.parse(typeof input === "string" ? input : decFatal.decode(input));
}
