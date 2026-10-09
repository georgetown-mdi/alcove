import {
  ConnectionError,
  MAX_SIGNALING_DISCOVERY_BYTES,
  SIGNALING_DISCOVERY_PATH,
  UsageError,
  readBoundedJsonBody,
  signalingServerFromDiscoveryDocument,
} from "@alcove/core";

import { webAppOrigin } from "./connectionFromUrl";

/** How long the read of a web app's published coordination server may take. */
export const SIGNALING_DISCOVERY_TIMEOUT_MS = 15_000;

/** What a refusal tells the operator to give instead of the web app's address. */
const INSTEAD =
  "Give the coordination server itself as a wss://<server>/api/ URL, or " +
  "author `channel: webrtc` in alcove.yaml and run 'alcove exchange'.";

function notPublished(origin: string, detail: string): UsageError {
  return new UsageError(
    `${origin} does not publish the address of its coordination server at ` +
      `${SIGNALING_DISCOVERY_PATH} (${detail}). ${INSTEAD}`,
  );
}

function unreachable(
  origin: string,
  detail: string,
  options?: ErrorOptions,
): ConnectionError {
  return new ConnectionError(
    `could not read the coordination server address ${origin} publishes at ` +
      `${SIGNALING_DISCOVERY_PATH} (${detail}). Check the address and the ` +
      `network and try again. ${INSTEAD}`,
    "transport",
    options,
  );
}

/** Options for {@link resolveWebAppSignalingServer}. */
export interface ResolveWebAppSignalingServerOptions {
  /** The fetch implementation; `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to {@link SIGNALING_DISCOVERY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The coordination server the web app at `address` publishes at
 * {@link SIGNALING_DISCOVERY_PATH} on its own origin, as the `ws:`/`wss:` URL
 * an online invite dials. No redirect is followed, the body is read under
 * {@link MAX_SIGNALING_DISCOVERY_BYTES}, and the server's scheme must match the
 * address's (`wss:` for `https:`, `ws:` for `http:`), as the web app requires
 * of its own setting.
 *
 * @throws {UsageError} when the address is not a bare web app address, or the
 *   app answers with no usable document (exit 64).
 * @throws {ConnectionError} (`transport`) when the app cannot be reached, does
 *   not answer in time, or answers 408, 429 or 5xx (exit 69).
 */
export async function resolveWebAppSignalingServer(
  address: URL,
  options: ResolveWebAppSignalingServerOptions = {},
): Promise<URL> {
  const origin = webAppOrigin(address);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SIGNALING_DISCOVERY_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => unreachable(origin, `no answer within ${timeoutMs}ms`);

  let response: Response;
  try {
    response = await fetchImpl(new URL(SIGNALING_DISCOVERY_PATH, origin), {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw timedOut();
    throw unreachable(origin, "the request failed", { cause });
  }

  const status = response.status;
  if (!(status >= 200 && status < 300)) {
    await response.body?.cancel().catch(() => undefined);
    if (status === 408 || status === 429 || status >= 500)
      throw unreachable(origin, `it answered HTTP ${status}`);
    if (response.type === "opaqueredirect" || (status >= 300 && status < 400))
      throw notPublished(
        origin,
        `it answered with a redirect (HTTP ${status}), which is not followed`,
      );
    throw notPublished(origin, `it answered HTTP ${status}`);
  }

  const body = await readBoundedJsonBody(
    response,
    MAX_SIGNALING_DISCOVERY_BYTES,
    { signal },
  );
  if (signal.aborted) throw timedOut();
  if (body.kind === "too-large")
    throw notPublished(
      origin,
      `the answer is larger than ${MAX_SIGNALING_DISCOVERY_BYTES} bytes`,
    );
  const server =
    body.kind === "parsed"
      ? signalingServerFromDiscoveryDocument(body.value)
      : undefined;
  if (server === undefined)
    throw notPublished(
      origin,
      "the answer is not a document naming a ws:// or wss:// server",
    );
  const expected = address.protocol === "https:" ? "wss:" : "ws:";
  if (server.protocol !== expected)
    throw notPublished(
      origin,
      `it names a ${server.protocol}// server, and an ${address.protocol}// ` +
        `address needs a ${expected}// one`,
    );
  return server;
}
