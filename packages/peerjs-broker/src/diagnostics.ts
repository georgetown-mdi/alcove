import {
  displayText,
  redactAndSanitizeForDisplay,
  sanitizeForDisplay,
} from "@alcove/core/untrusted-text";

import type { Displayable } from "@alcove/core/untrusted-text";
import type { EventEmitter } from "node:events";

// The type below is derived from this list, so a source added here cannot
// fall through to `unattributed`.
const SIGNALING_DIAGNOSTIC_SOURCES = [
  "unanswered-upgrade",
  "released-socket",
  "client-socket",
  "client-frame",
  "frame-dispatch",
  "signaling-server",
  "unattributed",
] as const;

/**
 * Which raise site reported a diagnostic on the signaling server's `error`
 * event, since the paths look alike once only the `Error` survives:
 *
 * - `unanswered-upgrade`: a declined upgrade no co-resident listener answered
 *   before the release bound.
 * - `released-socket`: an error caught inside the release window, an ordinary
 *   peer hang-up among them.
 * - `client-socket`: an error on a socket this server serves.
 * - `client-frame`: a registered client's frame that did not parse, or parsed
 *   to something no client id can be stamped onto. Peer-controlled.
 * - `frame-dispatch`: a fault in this server's own `message` listeners on a
 *   frame that did parse. Node's and V8's error text can still quote a short
 *   fragment of the peer's payload.
 * - `signaling-server`: an error the `ws` server raised.
 * - `unattributed`: any other source a raise passed.
 */
export type SignalingDiagnosticSource =
  (typeof SIGNALING_DIAGNOSTIC_SOURCES)[number];

/**
 * Wall-clock window the diagnostics budget is measured over. A clock stepped
 * backwards keeps the window open until it catches up.
 */
export const DIAGNOSTIC_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Diagnostics written per {@link DIAGNOSTIC_RATE_LIMIT_WINDOW_MS}: enough to
 * tell a broker refusing dials from one nobody dials. Shedding is reported.
 */
export const DIAGNOSTICS_PER_RATE_LIMIT_WINDOW = 10;

/**
 * Cap on one diagnostic's detail after escaping. With the budget above it
 * bounds this sink's write volume per window.
 */
export const DIAGNOSTIC_DETAIL_MAX_LENGTH = 256;

/**
 * Where a diagnostic goes, already attributed, escaped, capped and rate
 * limited. Injected by whoever builds the server. Every report is a warning.
 */
export type SignalingDiagnosticSink = (message: Displayable) => void;

/** Read what was raised as text, surviving a throwing `message` getter or
 * `toString`. */
function readErrorText(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string")
      return error.message;
    return String(error);
  } catch {
    return "[unreadable error]";
  }
}

/** Resolve a raise's source to a first-party literal; `emit` is untyped, so
 * anything unknown is `unattributed` rather than dropped. */
function attributionOf(source: unknown): SignalingDiagnosticSource {
  return (
    SIGNALING_DIAGNOSTIC_SOURCES.find((known) => known === source) ??
    "unattributed"
  );
}

/** The shed counts as `source: count`, from resolved sources only, so nothing
 * a peer chose reaches a notice. */
function describeShedBySource(
  shedBySource: ReadonlyMap<SignalingDiagnosticSource, number>,
): Displayable {
  let composed = displayText``;
  for (const [source, count] of shedBySource) {
    const entry = displayText`${sanitizeForDisplay(source)}: ${count}`;
    composed = composed === "" ? entry : displayText`${composed}, ${entry}`;
  }
  return composed;
}

/**
 * A rate-limited writer for one signaling server's diagnostics. The budget is
 * shared across sources, so both notices name which sources lost reports. The
 * window is computed when a diagnostic arrives, so no timer keeps the process
 * alive.
 */
function createSignalingDiagnosticsReporter(
  write: SignalingDiagnosticSink,
): (source: unknown, error: unknown) => void {
  let windowStartedAt = Date.now();
  let writtenInWindow = 0;
  let shedInWindow = 0;
  let shedBySource = new Map<SignalingDiagnosticSource, number>();

  return (rawSource, error) => {
    const source = attributionOf(rawSource);
    const now = Date.now();

    if (now - windowStartedAt >= DIAGNOSTIC_RATE_LIMIT_WINDOW_MS) {
      const shed = shedInWindow;
      const shedDetail = describeShedBySource(shedBySource);
      windowStartedAt = now;
      writtenInWindow = 0;
      shedInWindow = 0;
      shedBySource = new Map();
      // Written only when a later diagnostic arrives: a flood followed by
      // silence leaves its final count unwritten.
      if (shed > 0)
        write(
          displayText`peerjs signaling diagnostics resumed: ${shed} suppressed while rate limited (${shedDetail})`,
        );
    }

    if (writtenInWindow >= DIAGNOSTICS_PER_RATE_LIMIT_WINDOW) {
      shedInWindow += 1;
      shedBySource.set(source, (shedBySource.get(source) ?? 0) + 1);
      // One notice per window; the full breakdown goes in the resumed notice.
      if (shedInWindow === 1)
        write(
          displayText`peerjs signaling diagnostics rate limited: ${DIAGNOSTICS_PER_RATE_LIMIT_WINDOW} written in the last ${DIAGNOSTIC_RATE_LIMIT_WINDOW_MS / 1000} seconds, suppressing the rest of this window; suppressed so far (${describeShedBySource(shedBySource)})`,
        );
      return;
    }

    writtenInWindow += 1;
    // The one escape (CONTRIBUTING.md, Operator-facing escaping): a parse
    // failure quotes the peer's raw bytes.
    const detail = redactAndSanitizeForDisplay(readErrorText(error), {
      maxLength: DIAGNOSTIC_DETAIL_MAX_LENGTH,
    });
    // The peer's detail goes last, so none of it can pass for an earlier field.
    write(
      displayText`peerjs signaling diagnostic [${sanitizeForDisplay(source)}]: ${detail}`,
    );
  };
}

/**
 * Attach the diagnostics sink to a signaling server's `error` event. An
 * `error` with no listener is thrown, ending the process over a peer hang-up,
 * so the listener absorbs every event even when `write` throws.
 */
export function attachSignalingDiagnostics(
  server: EventEmitter,
  write: SignalingDiagnosticSink,
): void {
  const report = createSignalingDiagnosticsReporter(write);
  server.on("error", (error: unknown, source: unknown) => {
    try {
      report(source, error);
    } catch {
      // A failing sink must not turn a released socket into a process exit.
    }
  });
}
