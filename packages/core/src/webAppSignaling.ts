import { ConnectionError, UsageError } from "./errors.js";
import {
  MAX_SIGNALING_DISCOVERY_BYTES,
  SIGNALING_DISCOVERY_PATH,
  signalingServerFromDiscoveryDocument,
} from "./signalingDiscovery.js";
import { readBoundedJsonBody } from "./utils/boundedJsonBody.js";

/** How long the read of a web app's published coordination server may take. */
export const SIGNALING_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * The refusal an `http:`/`https:` URL naming anything past the web app's
 * address gets. The URL is not echoed: a pasted invitation link holds its
 * token in the fragment.
 */
export const WEB_APP_ADDRESS_REFUSED =
  "an http:// or https:// URL must be the web app's own address with no " +
  "path, user, query, or fragment (e.g. https://app.example.org/). Give that " +
  "address, or give the coordination server itself as a ws:// or wss:// URL " +
  "(e.g. wss://peers.example.org/psi).";

/**
 * Whether `url` is a web app's address (`http:` or `https:`), the form
 * {@link resolveWebAppSignalingServer} resolves to the coordination server the
 * app publishes.
 */
export function isWebAppAddress(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * The origin of the web app at `address`.
 *
 * @throws {UsageError} ({@link WEB_APP_ADDRESS_REFUSED}) when the address is
 *   not `http:`/`https:` or names a path other than `/`, a user, a query, or a
 *   fragment.
 */
export function webAppOrigin(address: URL): string {
  if (
    !isWebAppAddress(address) ||
    address.pathname !== "/" ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new UsageError(WEB_APP_ADDRESS_REFUSED);
  return address.origin;
}

function notPublished(
  origin: string,
  detail: string,
  remedy: string,
): UsageError {
  return new UsageError(
    `${origin} does not publish the address of its coordination server at ` +
      `${SIGNALING_DISCOVERY_PATH} (${detail}). ${remedy}`,
  );
}

function unreachable(
  origin: string,
  detail: string,
  remedy: string,
  options?: ErrorOptions,
): ConnectionError {
  return new ConnectionError(
    `could not read the coordination server address ${origin} publishes at ` +
      `${SIGNALING_DISCOVERY_PATH} (${detail}). Check the address and the ` +
      `network and try again. ${remedy}`,
    "transport",
    options,
  );
}

/** Options for {@link resolveWebAppSignalingServer}. */
export interface ResolveWebAppSignalingServerOptions {
  /** The sentence every refusal ends on, naming what to give instead of the
   * web app's address on the caller's own surface. */
  remedy: string;
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
 *   app answers with no usable document.
 * @throws {ConnectionError} (`transport`) when the app cannot be reached, does
 *   not answer in time, answers 408, 429 or 5xx, or the connection fails while
 *   the answer is read.
 */
export async function resolveWebAppSignalingServer(
  address: URL,
  options: ResolveWebAppSignalingServerOptions,
): Promise<URL> {
  const origin = webAppOrigin(address);
  const { remedy } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SIGNALING_DISCOVERY_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () =>
    unreachable(origin, `no answer within ${timeoutMs}ms`, remedy);

  let response: Response;
  try {
    response = await fetchImpl(new URL(SIGNALING_DISCOVERY_PATH, origin), {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw timedOut();
    throw unreachable(origin, "the request failed", remedy, { cause });
  }

  const status = response.status;
  if (!(status >= 200 && status < 300)) {
    await response.body?.cancel().catch(() => undefined);
    if (status === 408 || status === 429 || status >= 500)
      throw unreachable(origin, `it answered HTTP ${status}`, remedy);
    if (response.type === "opaqueredirect" || (status >= 300 && status < 400))
      throw notPublished(
        origin,
        `it answered with a redirect (HTTP ${status}), which is not followed`,
        remedy,
      );
    throw notPublished(origin, `it answered HTTP ${status}`, remedy);
  }

  const body = await readBoundedJsonBody(
    response,
    MAX_SIGNALING_DISCOVERY_BYTES,
    { signal },
  );
  if (signal.aborted) throw timedOut();
  if (body.kind === "invalid" && body.readFailed === true)
    throw unreachable(
      origin,
      "the connection failed while reading the answer",
      remedy,
    );
  if (body.kind === "too-large")
    throw notPublished(
      origin,
      `the answer is larger than ${MAX_SIGNALING_DISCOVERY_BYTES} bytes`,
      remedy,
    );
  const server =
    body.kind === "parsed"
      ? signalingServerFromDiscoveryDocument(body.value)
      : undefined;
  if (server === undefined)
    throw notPublished(
      origin,
      "the answer is not a document naming a ws:// or wss:// server",
      remedy,
    );
  const expected = address.protocol === "https:" ? "wss:" : "ws:";
  if (server.protocol !== expected)
    throw notPublished(
      origin,
      `it names a ${server.protocol}// server, and an ${address.protocol}// ` +
        `address needs a ${expected}// one`,
      remedy,
    );
  return server;
}
