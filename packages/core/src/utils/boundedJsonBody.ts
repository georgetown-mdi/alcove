import { parseBoundedJson } from "./boundedJson.js";

/**
 * The byte-capped JSON body read for any fetched or received body whose sender
 * the reader does not control: the web app's job API in both directions, and
 * the CLI's read of a server-provisioning endpoint's answer. The body is
 * streamed under a hard byte cap and parsed through {@link parseBoundedJson},
 * so no caller can buffer an unbounded body or drive `JSON.parse` into the
 * uncatchable engine abort that bound forestalls (see ./boundedJson.ts and
 * docs/spec/CHANNEL_SECURITY.md).
 */

/**
 * The outcome of reading a body under a byte cap:
 * - `too-large`: the body exceeded the cap.
 * - `invalid`: the body was absent, failed part-way through the stream, was not
 *   valid UTF-8, was not valid JSON, or exceeded the structural bound
 *   parseBoundedJson enforces.
 * - `parsed`: the decoded JSON value.
 */
export type BoundedJsonBodyResult =
  | { kind: "too-large" }
  | { kind: "invalid" }
  | { kind: "parsed"; value: unknown };

/** Options for {@link readBoundedJsonBody}. */
export interface ReadBoundedJsonBodyOptions {
  /** Stops the read when it aborts. */
  signal?: AbortSignal;
}

interface AbortRejection {
  rejected: Promise<never>;
  dispose: () => void;
}

function abortRejection(signal: AbortSignal): AbortRejection {
  let onAbort = () => {};
  const rejected = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
  });
  rejected.catch(() => undefined);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    rejected,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Read a `Request` or `Response` body as JSON under a hard byte cap, without
 * trusting `Content-Length` (absent or understated on a chunked message).
 * Streamed via {@link ReadableStream.getReader}; the read stops, and the reader
 * is cancelled, the moment the running byte total exceeds `maxBytes` -- the body
 * is never buffered first. Decodes and parses the accumulated bytes itself,
 * since consuming the stream leaves the message's own `json()` unavailable.
 * Pure over its arguments, so a test can drive it with any `Request` or
 * `Response`.
 *
 * Every failure is a returned refusal, never a raised one: a stream that errors
 * part-way through reads as `invalid`, so a caller's refusal path handles a
 * dropped connection the same way it handles an unparseable body. A read
 * `options.signal` aborts also returns `invalid`, the reader cancelled, whether
 * or not the stream itself reacts to the abort; the caller tells it apart by
 * checking `signal.aborted`.
 */
export async function readBoundedJsonBody(
  message: Request | Response,
  maxBytes: number,
  options: ReadBoundedJsonBodyOptions = {},
): Promise<BoundedJsonBodyResult> {
  const body = message.body;
  if (body === null) return { kind: "invalid" };
  const { signal } = options;
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const abort = signal === undefined ? undefined : abortRejection(signal);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await (abort === undefined
        ? reader.read()
        : Promise.race([reader.read(), abort.rejected]));
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // A cancel that rejects leaves the verdict alone: the cap was already
        // passed, so the refusal is decided before the cancel runs.
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    // Not awaited: a source that ignores the abort may never settle a cancel.
    if (signal?.aborted === true) void reader.cancel().catch(() => undefined);
    return { kind: "invalid" };
  } finally {
    abort?.dispose();
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = parseBoundedJson(merged);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "parsed", value };
}
