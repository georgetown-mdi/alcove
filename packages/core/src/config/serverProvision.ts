/**
 * The wake call a connection's `server.provision` block states: one HTTPS
 * request, sent before the run connects, that starts a primary server kept
 * down between exchanges. A 2xx answer means the server now accepts
 * connections; every other outcome stops the run, classified so the exit code
 * says whether a retry can help. The contract the endpoint meets:
 * docs/EXCHANGE_REFERENCE.md, "On-demand server provisioning".
 *
 * Only the status is read. The body is network content the operator cannot
 * inspect, so it is cancelled unread and no part of it reaches a message.
 * Neither the path (which may hold a token) nor any credential is composed into
 * a message; the endpoint is named by host and port alone.
 */

import { ConnectionError } from "../connection/messageConnection.js";
import { InternalConsistencyError, UsageError } from "../errors.js";
import { enc } from "../utils/crypto.js";
import type { ConnectionConfig, ServerProvision } from "./connection.js";

/** The port a provisioning endpoint is reached on when `port` is unset. */
export const DEFAULT_PROVISION_PORT = 443;

/**
 * How long the wake call may take before the run stops with a transport
 * failure. Arbitrary working value: long enough for a serverless instance's
 * cold start, short enough that an unattended run does not hang.
 */
export const PROVISION_REQUEST_TIMEOUT_MS = 120_000;

/** The request a provisioning block describes, before a signal is attached. */
export interface ProvisionRequest {
  url: URL;
  init: RequestInit & { method: "POST"; redirect: "manual"; headers: Headers };
}

/** Options for {@link callProvisionEndpoint}. */
export interface CallProvisionEndpointOptions {
  /** The fetch implementation; `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to {@link PROVISION_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The `server.provision` block of a connection, or `undefined` when it states
 * none or its channel has no primary server.
 */
export function serverProvisionOf(
  connection: ConnectionConfig,
): ServerProvision | undefined {
  switch (connection.channel) {
    case "sftp":
    case "webrtc":
      return connection.server.provision;
    case "filedrop":
      return undefined;
    default: {
      const unreachable: never = connection;
      throw new InternalConsistencyError(
        `unhandled channel ${(unreachable as { channel: string }).channel}`,
      );
    }
  }
}

function hostForAuthority(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * How messages name the endpoint: `the provisioning endpoint at host:port`,
 * never its path.
 */
export function provisionEndpointLabel(provision: ServerProvision): string {
  const port = provision.port ?? DEFAULT_PROVISION_PORT;
  return `the provisioning endpoint at ${hostForAuthority(provision.host)}:${port}`;
}

function base64OfUtf8(value: string): string {
  let binary = "";
  for (const byte of enc.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function provisionUrl(provision: ServerProvision): URL {
  const port = provision.port ?? DEFAULT_PROVISION_PORT;
  const invalid = () =>
    new UsageError(
      "connection.server.provision.host and path do not form a valid https URL; " +
        "set host to a bare host name and path to a path beginning with /.",
    );
  let origin: URL;
  try {
    origin = new URL(`https://${hostForAuthority(provision.host)}:${port}`);
  } catch {
    throw invalid();
  }
  // A host holding `/`, `@`, `?` or `#` parses as some other URL part, which
  // would move the request (and its credential) to a different host.
  if (
    origin.pathname !== "/" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== ""
  )
    throw invalid();
  const rawPath = provision.path ?? "/";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  let url: URL;
  try {
    url = new URL(origin.origin + path);
  } catch {
    throw invalid();
  }
  if (url.origin !== origin.origin) throw invalid();
  return url;
}

function provisionHeaders(provision: ServerProvision): Headers {
  const auth = provision.auth;
  const headers = new Headers({ accept: "application/json" });
  if (auth?.bearer !== undefined) {
    if (!/^[\x21-\x7e]+$/.test(auth.bearer))
      throw new UsageError(
        "connection.server.provision.auth.bearer is empty or holds a space, " +
          "line break, or non-ASCII character, which an HTTP header cannot " +
          "send; check the file it names.",
      );
    headers.set("authorization", `Bearer ${auth.bearer}`);
  } else if (auth?.username !== undefined && auth.password !== undefined) {
    if (auth.username.includes(":"))
      throw new UsageError(
        "connection.server.provision.auth.username holds a colon, which HTTP " +
          "Basic authentication cannot send; use a username without one.",
      );
    headers.set(
      "authorization",
      `Basic ${base64OfUtf8(`${auth.username}:${auth.password}`)}`,
    );
  }
  return headers;
}

/**
 * The request {@link callProvisionEndpoint} sends: a POST with an empty body to
 * `https://host:port/path`, redirects not followed so the credential never
 * reaches a second host. Throws a {@link UsageError} naming the field when the
 * block cannot form one.
 */
export function provisionRequest(provision: ServerProvision): ProvisionRequest {
  return {
    url: provisionUrl(provision),
    init: {
      method: "POST",
      redirect: "manual",
      headers: provisionHeaders(provision),
    },
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already read; a body that fails to close changes nothing.
  }
}

/**
 * The failure a non-2xx answer means: a server-side or rate-limit status is a
 * transport failure a later retry can clear; a refused credential, a redirect,
 * or any other client-error status is a configuration the operator corrects.
 */
function failureForStatus(
  provision: ServerProvision,
  response: Response,
): Error | undefined {
  const label = provisionEndpointLabel(provision);
  const status = response.status;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400))
    return new UsageError(
      `${label} answered with a redirect (HTTP ${status}), which is not ` +
        "followed; set connection.server.provision to the address it " +
        "redirects to.",
    );
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403)
    return new UsageError(
      `${label} refused the credentials in connection.server.provision.auth ` +
        `(HTTP ${status}); check the token or password the configuration names.`,
    );
  if (status === 408 || status === 429 || status >= 500)
    return new ConnectionError(
      `${label} could not start the server (HTTP ${status}); try the run ` +
        "again later.",
      "transport",
    );
  return new UsageError(
    `${label} refused the request (HTTP ${status}); check the host, port, ` +
      "and path in connection.server.provision.",
  );
}

/**
 * Send the wake call and resolve once the endpoint answers 2xx. Rejects with a
 * `transport`-kind {@link ConnectionError} (exit 69) on a network or TLS
 * failure, a timeout, or a 408, 429, or 5xx answer, and with a
 * {@link UsageError} (exit 64) on any other answer or on a block that cannot
 * form a request.
 */
export async function callProvisionEndpoint(
  provision: ServerProvision,
  options: CallProvisionEndpointOptions = {},
): Promise<void> {
  const { url, init } = provisionRequest(provision);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROVISION_REQUEST_TIMEOUT_MS;
  const label = provisionEndpointLabel(provision);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeout(err))
      throw new ConnectionError(
        `${label} did not answer within ${Math.ceil(timeoutMs / 1000)} ` +
          "seconds; check that it is reachable and try the run again.",
        "transport",
      );
    throw new ConnectionError(
      `could not reach ${label}; check the host and port in ` +
        "connection.server.provision and the network path to it.",
      "transport",
      { cause: err },
    );
  }
  const failure = failureForStatus(provision, response);
  await discardBody(response);
  if (failure !== undefined) throw failure;
}
