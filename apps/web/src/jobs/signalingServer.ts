import { z } from "zod";

import {
  ConnectionError,
  MAX_SIGNALING_SERVER_URL_LENGTH,
  UsageError,
  maxCodeUnits,
  publishedSignalingServerURL,
  resolveWebAppSignalingServer,
} from "@alcove/core";

import { JobApiConfigError } from "./gate";

/**
 * The coordination server the operator authored for a webrtc job: where the
 * run dials, as its `connection.server` states it, plus the web app the
 * address was resolved through. Contract: docs/spec/SERVER_JOB_API.md, "The
 * coordination server".
 */
export interface AuthoredSignalingServer {
  host: string;
  /** Absent for the scheme's default port. */
  port?: number;
  /** The server's mount, ending in `/`. */
  path: string;
  secure: boolean;
  webAppOrigin?: string;
}

/**
 * Thrown when the web app the operator named cannot be reached, or does not
 * answer usably in time. The message is core's, ending on what to type
 * instead; the route answers it with a `502`.
 */
export class SignalingServerUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignalingServerUnreachableError";
  }
}

/** Options for {@link resolveAuthoredSignalingServer}. */
export interface ResolveAuthoredSignalingServerOptions {
  /** The fetch the web app's published file is read with. */
  fetch?: typeof globalThis.fetch;
  /** How long that read may take. */
  timeoutMs?: number;
}

const BODY_REFUSED =
  "The request body must be an object whose only field is address, a string " +
  `of at most ${MAX_SIGNALING_SERVER_URL_LENGTH} characters.`;

const TYPE_INSTEAD =
  "Type the coordination server's wss:// address or the web app's https:// " +
  "address.";

/** The refusal of an address that is not a URL with one of the four schemes. */
export const SIGNALING_ADDRESS_SCHEME_REFUSED =
  "The address is not a ws://, wss://, http:// or https:// URL. " +
  TYPE_INSTEAD;

/** The refusal of an address stating a user name or password. It never echoes
 * the address, which would repeat the password. */
export const SIGNALING_ADDRESS_CREDENTIALS_REFUSED =
  "The address contains a user name or password, which a coordination " +
  "server address cannot hold. Type the address without them.";

const SERVER_SHAPE_REFUSED =
  "A coordination server address must name a host and an optional port and " +
  "path, with no query, fragment or percent-escape. Correct the address.";

const PORT_REFUSED =
  "The address names port 0, which cannot be dialed. Type a port from 1 to " +
  "65535.";

const WEB_APP_SHAPE_REFUSED =
  "A web app address must end at its host and port, with no path, query or " +
  "fragment. Type the web app's own address, or the coordination server's " +
  "wss:// address.";

const WEB_APP_REMEDY =
  "Type the coordination server's own wss:// address instead.";

/** The advisory a `ws:` server gets: the operator may choose it, and it is
 * what a broker on this machine uses. */
export const SIGNALING_UNENCRYPTED_WARNING =
  "This coordination server is reached over ws://, which is not encrypted, " +
  "so the network between this console and the server can read the " +
  "rendezvous ids and both parties' network addresses. Use a wss:// address " +
  "unless the server runs on this machine.";

const authorBodySchema = z.strictObject({
  address: z.string().check(maxCodeUnits(MAX_SIGNALING_SERVER_URL_LENGTH)),
});

/** Core's resolver message as a sentence: it starts with the origin or a
 * lowercase verb, the CLI's form. */
function asSentence(message: string, origin: string): string {
  return message.startsWith(origin)
    ? message
    : message.charAt(0).toUpperCase() + message.slice(1);
}

/** The server a web app address names, through the file it publishes. */
async function serverPublishedBy(
  address: URL,
  text: string,
  options: ResolveAuthoredSignalingServerOptions,
): Promise<URL> {
  if (address.pathname !== "/" || /[?#]/.test(text))
    throw new JobApiConfigError(WEB_APP_SHAPE_REFUSED);
  try {
    return await resolveWebAppSignalingServer(address, {
      remedy: WEB_APP_REMEDY,
      ...options,
    });
  } catch (error) {
    if (error instanceof UsageError)
      throw new JobApiConfigError(asSentence(error.message, address.origin));
    if (error instanceof ConnectionError)
      throw new SignalingServerUnreachableError(
        asSentence(error.message, address.origin),
        { cause: error },
      );
    throw error;
  }
}

/**
 * Validate a `PUT /api/jobs/webrtc` body and resolve the coordination server
 * it names: a `ws:`/`wss:` address held to core's
 * {@link publishedSignalingServerURL}, the rule the web app's build applies
 * to the server it publishes, or an `http:`/`https:` web app address resolved
 * through the server that app publishes. A `ws:` server is admitted with
 * {@link SIGNALING_UNENCRYPTED_WARNING}.
 *
 * @throws {JobApiConfigError} when the body or address is refused, or the web
 *   app publishes no usable server.
 * @throws {SignalingServerUnreachableError} when the web app cannot be read.
 */
export async function resolveAuthoredSignalingServer(
  rawBody: unknown,
  options: ResolveAuthoredSignalingServerOptions = {},
): Promise<{ server: AuthoredSignalingServer; warnings: Array<string> }> {
  const body = authorBodySchema.safeParse(rawBody);
  if (!body.success) throw new JobApiConfigError(BODY_REFUSED);
  const text = body.data.address.trim();
  let address: URL;
  try {
    address = new URL(text);
  } catch {
    throw new JobApiConfigError(SIGNALING_ADDRESS_SCHEME_REFUSED);
  }
  if (address.username !== "" || address.password !== "")
    throw new JobApiConfigError(SIGNALING_ADDRESS_CREDENTIALS_REFUSED);

  let dialed: URL | undefined;
  let webAppOrigin: string | undefined;
  if (address.protocol === "ws:" || address.protocol === "wss:") {
    dialed = publishedSignalingServerURL(text);
    if (dialed === undefined) throw new JobApiConfigError(SERVER_SHAPE_REFUSED);
  } else if (address.protocol === "http:" || address.protocol === "https:") {
    dialed = await serverPublishedBy(address, text, options);
    webAppOrigin = address.origin;
  } else throw new JobApiConfigError(SIGNALING_ADDRESS_SCHEME_REFUSED);

  if (dialed.port === "0") throw new JobApiConfigError(PORT_REFUSED);
  const secure = dialed.protocol === "wss:";
  const server: AuthoredSignalingServer = {
    host: dialed.hostname,
    ...(dialed.port !== "" ? { port: Number(dialed.port) } : {}),
    path: dialed.pathname,
    secure,
    ...(webAppOrigin !== undefined ? { webAppOrigin } : {}),
  };
  return { server, warnings: secure ? [] : [SIGNALING_UNENCRYPTED_WARNING] };
}
