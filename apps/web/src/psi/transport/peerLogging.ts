/**
 * PeerJS console logging for the web app. PeerJS interpolates peer ids into its
 * logs and errors, and here those ids derive from the invitation secret, so
 * every path that raises verbosity or receives a PeerJS error redacts them. See
 * docs/SECURITY_DESIGN.md#console-and-log-hygiene.
 */

/**
 * PeerJS debug levels, mirroring its `LogLevel` enum: 0 disabled, 1 errors,
 * 2 warnings, 3 everything. PeerJS gates each message on the level before it
 * calls the `logFunction`.
 */
export const PEERJS_ERRORS_ONLY = 1;
const PEERJS_ALL = 3;

/**
 * The PeerJS `debug` level for a session: the configured base, raised to the
 * most verbose level when `diagnostic` is on, which is safe only behind
 * {@link createRedactingLogFunction}. An out-of-range or non-integer base,
 * `NaN` included, falls back to errors-only.
 */
export function resolvePeerDebugLevel(
  baseLevel: number,
  diagnostic: boolean,
): number {
  const base =
    Number.isInteger(baseLevel) && baseLevel >= 0 && baseLevel <= PEERJS_ALL
      ? baseLevel
      : PEERJS_ERRORS_ONLY;
  return diagnostic ? Math.max(base, PEERJS_ALL) : base;
}

type LogSink = Pick<Console, "log" | "warn" | "error">;

const REDACTED = "[redacted-peer-id]";

function redactString(text: string, ids: ReadonlyArray<string>): string {
  let out = text;
  for (const id of ids) {
    if (id) out = out.split(id).join(REDACTED);
  }
  return out;
}

/** Redact ids from one log argument, recursing into arrays and plain objects. */
function redactValue(
  value: unknown,
  ids: ReadonlyArray<string>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactString(value, ids);
  // Collapsed as PeerJS's own printer does, dropping the `.cause` chain.
  if (value instanceof Error)
    return `(${value.name}) ${redactString(value.message, ids)}`;
  if (typeof value !== "object" || value === null) return value;
  // A revisited node gets a placeholder; returning the original would print
  // its ids unredacted.
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, ids, seen));
  // A Map, Set, typed array or Symbol-keyed value comes out empty: dropped, not
  // printed. PeerJS logs only strings, plain objects and Errors.
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = redactValue(item, ids, seen);
  return out;
}

/**
 * Build a PeerJS `logFunction` that redacts `ids` from every message, then
 * prints through PeerJS's own level mapping (3 -> log, 2 -> warn, 1 -> error).
 *
 * @param ids   The session's derived rendezvous ids, local and remote.
 * @param sink  Where redacted output goes; defaults to the real `console`.
 */
export function createRedactingLogFunction(
  ids: ReadonlyArray<string>,
  sink: LogSink = console,
): (logLevel: number, ...rest: Array<unknown>) => void {
  return (logLevel, ...rest) => {
    // A guard shared across arguments would print a repeated node as
    // "[circular]" in place of its redacted content.
    const redacted = rest.map((arg) => {
      try {
        return redactValue(arg, ids, new WeakSet<object>());
      } catch {
        // A throwing getter or a too-deep structure: never print the raw
        // argument or throw back into PeerJS's emit path.
        return "[unredactable]";
      }
    });
    // Level 0 prints nothing; PeerJS does not dispatch at 0.
    if (logLevel >= 3) sink.log("PeerJS:", ...redacted);
    else if (logLevel >= 2) sink.warn("PeerJS WARNING:", ...redacted);
    else if (logLevel >= 1) sink.error("PeerJS ERROR:", ...redacted);
  };
}

/**
 * Redact `ids` out of an `Error`'s `message` and `stack` wherever a PeerJS
 * error reaches app code. Mutates in place to keep the error's identity and
 * `type` discriminant; a fresh redacted error replaces one that refuses the
 * write. Matching is exact-substring, best-effort only.
 */
export function redactErrorIds(
  err: unknown,
  ids: ReadonlyArray<string>,
): unknown {
  if (!(err instanceof Error)) return err;
  try {
    err.message = redactString(err.message, ids);
    // The stack's first line repeats the message.
    if (err.stack !== undefined) err.stack = redactString(err.stack, ids);
    return err;
  } catch {
    // A read-only `message`: the original's stack and cause are dropped rather
    // than let an id through.
    const redacted = new Error(redactString(err.message, ids));
    redacted.name = err.name;
    return redacted;
  }
}
