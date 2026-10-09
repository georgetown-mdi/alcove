import { resolveWebAppSignalingServer as resolveInCore } from "@alcove/core";

/** What a refusal tells the operator to give instead of the web app's address. */
const INSTEAD =
  "Give the coordination server itself as a wss://<server>/api/ URL, or " +
  "author `channel: webrtc` in alcove.yaml and run 'alcove exchange'.";

/** Options for {@link resolveWebAppSignalingServer}. */
export interface ResolveWebAppSignalingServerOptions {
  /** The fetch implementation; `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to core's `SIGNALING_DISCOVERY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Core's resolution of the coordination server a web app publishes, its
 * refusals ending on what to give `alcove invite` instead.
 *
 * @throws {UsageError} when the address is not a bare web app address, or the
 *   app answers with no usable document (exit 64).
 * @throws {ConnectionError} (`transport`) when the app cannot be reached or
 *   does not answer usably in time (exit 69).
 */
export function resolveWebAppSignalingServer(
  address: URL,
  options: ResolveWebAppSignalingServerOptions = {},
): Promise<URL> {
  return resolveInCore(address, { ...options, remedy: INSTEAD });
}
