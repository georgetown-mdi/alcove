/**
 * The HTTPS call a connection's `server.provision` block states. In `start`
 * mode (the default) `alcove exchange` sends it before the run connects, to
 * wake a primary server kept down between exchanges; a 2xx answer means the
 * server now accepts connections, and only the status is read. In `create`
 * mode `alcove invite` sends it to have a new server made, and the 2xx
 * answer's body is that server's address. Every other outcome stops the
 * command, classified so the exit code says whether a retry can help. The
 * contract the endpoint meets: docs/EXCHANGE_REFERENCE.md, "On-demand server
 * provisioning".
 *
 * The body is network content the operator cannot inspect: a start-mode body
 * is cancelled unread, a create-mode body is read under a byte cap and held to
 * a strict schema, and no part of either reaches a message. Neither the path
 * (which may hold a token) nor any credential is composed into a message; the
 * endpoint is named by host and port alone.
 */

import { z } from "zod";

import { ConnectionError } from "../connection/messageConnection.js";
import { InternalConsistencyError, UsageError } from "../errors.js";
import { readBoundedJsonBody } from "../utils/boundedJsonBody.js";
import { enc } from "../utils/crypto.js";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
} from "./invitation.js";
import type {
  ConnectionConfigAwaitingAddress,
  FileDropConnectionConfig,
  ServerProvision,
  ServerProvisionMode,
} from "./connection.js";

/** The port a provisioning endpoint is reached on when `port` is unset. */
export const DEFAULT_PROVISION_PORT = 443;

/**
 * How long the wake call may take before the run stops with a transport
 * failure. Arbitrary working value: long enough for a serverless instance's
 * cold start, short enough that an unattended run does not hang.
 */
export const PROVISION_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The cap on a create-mode answer's body. The widest document
 * {@link ProvisionedServerAddress} admits, every host and path code unit
 * written as a six-byte `\uXXXX` escape, is (256 + 4096) * 6 bytes plus 34 of
 * keys, punctuation and a five-digit port: 26,146 bytes. 32 KiB is the next
 * power of two, its margin whitespace between tokens.
 */
export const MAX_PROVISION_RESPONSE_BYTES = 32 * 1024;

/**
 * The server address a create-mode endpoint answers with. `port` and `path`
 * replace the connection's own when present and leave them when absent.
 */
export interface ProvisionedServerAddress {
  host: string;
  port?: number;
  path?: string;
}

const PROVISIONED_ADDRESS_FIELDS = ["host", "port", "path"] as const;

/** A DNS label: 1-63 characters of letters, digits and hyphens, neither
 * leading nor trailing with a hyphen. */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * A host name (an internationalized one in its `xn--` form) or an IPv4
 * address, both label sequences separated by `.` with no empty label.
 */
function isHostName(host: string): boolean {
  return host.split(".").every((label) => HOST_LABEL_PATTERN.test(label));
}

/**
 * A conservative bare IPv6 literal check: only hex digits, `:` and, in at
 * most one trailing dotted run (an IPv4-mapped tail), a decimal `.`; at
 * least two colons tell it from a host name or IPv4 address. Brackets are
 * refused here -- `hostForAuthority` adds them for the request itself.
 */
function isBareIpv6Address(host: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(host)) return false;
  if ((host.match(/:/g) ?? []).length < 2) return false;
  const dots = host.match(/\./g) ?? [];
  return dots.length === 0 || dots.length === 3;
}

function isHostNameOrIpAddress(host: string): boolean {
  return isHostName(host) || isBareIpv6Address(host);
}

/** A path starting with `/`, holding no code unit below 0x20 or equal to
 * 0x7F, and no whitespace. */
function isSafeProvisionPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  for (let i = 0; i < path.length; i++) {
    const unit = path.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return false;
  }
  return !/\s/.test(path);
}

const ProvisionedServerAddressSchema: z.ZodType<ProvisionedServerAddress> =
  z.strictObject({
    host: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_HOST_LENGTH))
      .refine(isHostNameOrIpAddress),
    port: z.int().min(1).max(65535).optional(),
    path: z
      .string()
      .min(1)
      .check(maxCodeUnits(MAX_ENDPOINT_PATH_LENGTH))
      .refine(isSafeProvisionPath)
      .optional(),
  });

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
  connection: ConnectionConfigAwaitingAddress,
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

/** The mode a block states: `start` when it states none. */
export function provisionModeOf(
  provision: ServerProvision,
): ServerProvisionMode {
  return provision.mode ?? "start";
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
  // Checked before parsing because the URL parser drops a tab, CR or LF
  // anywhere in its input, so `a.com\nevil.com` would reach a.comevil.com.
  if (!isHostNameOrIpAddress(provision.host))
    throw new UsageError(
      "connection.server.provision.host holds a character a host name cannot " +
        "contain; set it to a bare host name (letters, digits, hyphens and " +
        "dots, an internationalized name in its xn-- form) or an IP address.",
    );
  const invalid = () =>
    new UsageError(
      "connection.server.provision.host and path do not form a valid https URL; " +
        "set host to a bare host name and path to a path beginning with /.",
    );
  const authorityHost = hostForAuthority(provision.host);
  let origin: URL;
  try {
    origin = new URL(`https://${authorityHost}:${port}`);
  } catch {
    throw invalid();
  }
  // The parser rewrites some hosts it accepts -- a numeric form such as
  // 0x7f.1 becomes 127.0.0.1 -- so the request goes only to the host as
  // written.
  if (origin.hostname !== authorityHost.toLowerCase())
    throw new UsageError(
      "connection.server.provision.host is not in the form the request would " +
        "use; write an IP address in its standard form (for example " +
        "127.0.0.1, or ::1 for IPv6).",
    );
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
      provisionModeOf(provision) === "create"
        ? `${label} could not create the server (HTTP ${status}); generate ` +
            "the invitation again later."
        : `${label} could not start the server (HTTP ${status}); try the ` +
            "run again later.",
      "transport",
    );
  return new UsageError(
    `${label} refused the request (HTTP ${status}); check the host, port, ` +
      "and path in connection.server.provision.",
  );
}

function timeoutFailure(label: string, timeoutMs: number): ConnectionError {
  return new ConnectionError(
    `${label} did not answer within ${timeoutMs}ms; check that it is ` +
      "reachable and try again.",
    "transport",
  );
}

interface ProvisionAnswer {
  response: Response;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Send the request; resolve to a 2xx answer or reject with its failure. */
async function sendProvisionRequest(
  provision: ServerProvision,
  options: CallProvisionEndpointOptions,
): Promise<ProvisionAnswer> {
  const { url, init } = provisionRequest(provision);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROVISION_REQUEST_TIMEOUT_MS;
  const label = provisionEndpointLabel(provision);
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (isTimeout(err)) throw timeoutFailure(label, timeoutMs);
    throw new ConnectionError(
      `could not reach ${label}; check the host and port in ` +
        "connection.server.provision and the network path to it.",
      "transport",
      { cause: err },
    );
  }
  const failure = failureForStatus(provision, response);
  if (failure !== undefined) {
    await discardBody(response);
    throw failure;
  }
  return { response, signal, timeoutMs };
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
  const { response } = await sendProvisionRequest(provision, options);
  await discardBody(response);
}

/**
 * What is wrong with a refused answer, named by schema field and never by a
 * key the body chose.
 */
function refusedAddressReason(issues: ReadonlyArray<z.core.$ZodIssue>): string {
  for (const issue of issues) {
    const field = issue.path[0];
    if (field === "host" && issue.code === "custom")
      return "its host holds a character a host name cannot contain";
    if (field === "path" && issue.code === "custom")
      return "its path holds a character a path cannot contain";
    if (
      issue.code !== "unrecognized_keys" &&
      PROVISIONED_ADDRESS_FIELDS.some((name) => name === field)
    )
      return `its ${String(field)} is missing, of the wrong type, or out of range`;
  }
  return "it holds a field other than host, port and path";
}

/**
 * Send a create-mode call and resolve to the address of the server the
 * endpoint made. A failed call is classified as {@link callProvisionEndpoint}
 * classifies it. A 2xx answer whose body exceeds
 * {@link MAX_PROVISION_RESPONSE_BYTES}, is not JSON, or does not match
 * {@link ProvisionedServerAddress} with no other key rejects with a
 * {@link UsageError} (exit 64) naming the endpoint and none of the body; one
 * the timeout cuts off mid-body, with a `transport`-kind
 * {@link ConnectionError} (exit 69).
 */
export async function requestProvisionedServerAddress(
  provision: ServerProvision,
  options: CallProvisionEndpointOptions = {},
): Promise<ProvisionedServerAddress> {
  const { response, signal, timeoutMs } = await sendProvisionRequest(
    provision,
    options,
  );
  const label = provisionEndpointLabel(provision);
  const remedy =
    "check that connection.server.provision names an endpoint that creates " +
    "a server and answers with its address.";
  const body = await readBoundedJsonBody(
    response,
    MAX_PROVISION_RESPONSE_BYTES,
    { signal },
  );
  if (body.kind === "too-large")
    throw new UsageError(
      `${label} answered with more than ${MAX_PROVISION_RESPONSE_BYTES} ` +
        `bytes, more than a server address holds; ${remedy}`,
    );
  if (body.kind === "invalid") {
    if (signal.aborted) throw timeoutFailure(label, timeoutMs);
    throw new UsageError(
      `${label} did not answer with a JSON server address; ${remedy}`,
    );
  }
  const parsed = ProvisionedServerAddressSchema.safeParse(body.value);
  if (!parsed.success)
    throw new UsageError(
      `${label} answered with a server address that cannot be used: ` +
        `${refusedAddressReason(parsed.error.issues)}. The answer must be a ` +
        "JSON object holding a host name or IP address of at most " +
        `${MAX_ENDPOINT_HOST_LENGTH} characters and, optionally, a port ` +
        "(1-65535) and a path of at most " +
        `${MAX_ENDPOINT_PATH_LENGTH} characters, and nothing else; ${remedy}`,
    );
  return parsed.data;
}

/**
 * The connection with the address a create-mode endpoint returned in place of
 * its own, or in the place a configuration left empty for it: `host` always,
 * `port` and `path` when the answer states them. The `provision` block is
 * kept, the record the next invitation creates a server from.
 */
export function withProvisionedServerAddress<
  C extends Exclude<ConnectionConfigAwaitingAddress, FileDropConnectionConfig>,
>(connection: C, address: ProvisionedServerAddress): C {
  return {
    ...connection,
    server: {
      ...connection.server,
      host: address.host,
      ...(address.port !== undefined ? { port: address.port } : {}),
      ...(address.path !== undefined ? { path: address.path } : {}),
    },
  };
}
