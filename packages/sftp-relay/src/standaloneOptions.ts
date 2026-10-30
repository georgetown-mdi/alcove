import type { SftpRelayTarget } from "./relay.ts";

// The standalone runner's settings, kept apart from standalone.ts, which
// listens at import time, so a test can resolve them without a process.

/** Bind address when `--host` names none: loopback. */
export const DEFAULT_SFTP_RELAY_HOST = "127.0.0.1";

/** Port when `--port` names none: an ephemeral one, which the ready line
 * reports. */
export const DEFAULT_SFTP_RELAY_PORT = 0;

const MAX_PORT = 65_535;

const SINGLE_FLAGS = ["host", "port", "target"] as const;
const REPEATED_FLAG = "allowed-origin";

type SingleFlag = (typeof SINGLE_FLAGS)[number];

/**
 * A setting the runner cannot act on. The message composes the offending
 * value raw; the runner escapes it where it writes it.
 */
export class SftpRelayOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SftpRelayOptionError";
  }
}

/** Where the runner listens, where it forwards, and whose pages it serves. */
export interface SftpRelayRunnerOptions {
  /** Address passed to `listen`. */
  host: string;
  /** Port passed to `listen`; `0` yields an ephemeral one. */
  port: number;
  /** The one TCP endpoint every connection is forwarded to. */
  target: SftpRelayTarget;
  /** The `Origin` values an upgrade must match one of exactly. */
  allowedOrigins: string[];
}

function isSingleFlag(name: string): name is SingleFlag {
  return (SINGLE_FLAGS as ReadonlyArray<string>).includes(name);
}

function parsePort(raw: string, source: string, minimum: number): number {
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isNaN(port) || port < minimum || port > MAX_PORT) {
    throw new SftpRelayOptionError(
      `${source} must be a whole number from ${minimum} to ${MAX_PORT}; got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/**
 * Read a target written `host:port`, an IPv6 address in brackets
 * (`[2001:db8::5]:22`).
 *
 * @throws {SftpRelayOptionError} on any other form.
 */
export function parseTarget(raw: string): SftpRelayTarget {
  const match =
    /^\[([0-9A-Fa-f:.]+)\]:(\d+)$/.exec(raw) ??
    /^([A-Za-z0-9.-]+):(\d+)$/.exec(raw);
  if (match === null) {
    throw new SftpRelayOptionError(
      `--target must be host:port, an IPv6 address in brackets; got ${JSON.stringify(raw)}`,
    );
  }
  return { host: match[1], port: parsePort(match[2], "--target's port", 1) };
}

/**
 * Read an allowed origin, which must be written as a browser sends it: an
 * `http` or `https` scheme, a lowercase host, a port only where it is not
 * the scheme's default, and no path.
 *
 * @throws {SftpRelayOptionError} on any other form.
 */
export function parseAllowedOrigin(raw: string): string {
  let origin: string | undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") {
      origin = url.origin;
    }
  } catch {
    origin = undefined;
  }
  if (origin !== raw) {
    throw new SftpRelayOptionError(
      `--allowed-origin must be an origin as a browser sends it: an http or https scheme and a host, with a port only if it is not the default, and no path or trailing slash; got ${JSON.stringify(raw)}` +
        (origin === undefined ? "" : `; did you mean ${origin}?`),
    );
  }
  return origin;
}

/**
 * Resolve the runner's settings from an argument vector
 * (`process.argv.slice(2)`): `--host`, `--port` and `--target` at most once
 * each, `--target` required, and `--allowed-origin` at least once.
 *
 * @throws {SftpRelayOptionError} on an unknown, repeated, valueless or
 *   missing flag, or a value of the wrong form.
 */
export function resolveSftpRelayOptions(
  argv: ReadonlyArray<string>,
): SftpRelayRunnerOptions {
  const flags = new Map<SingleFlag, string>();
  const allowedOrigins: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.startsWith("--") ? token.slice(2) : "";
    if (name !== REPEATED_FLAG && !isSingleFlag(name)) {
      throw new SftpRelayOptionError(`Unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new SftpRelayOptionError(`--${name} requires a value`);
    }
    index += 1;
    if (name === REPEATED_FLAG) {
      allowedOrigins.push(parseAllowedOrigin(value));
      continue;
    }
    if (flags.has(name)) {
      throw new SftpRelayOptionError(`--${name} may be given only once`);
    }
    flags.set(name, value.trim());
  }

  const rawTarget = flags.get("target");
  if (rawTarget === undefined) {
    throw new SftpRelayOptionError(
      "--target is required: the SFTP server's host:port",
    );
  }
  if (allowedOrigins.length === 0) {
    throw new SftpRelayOptionError(
      "--allowed-origin is required: the origin of the web application whose pages may use the relay",
    );
  }
  const rawPort = flags.get("port");
  return {
    host: flags.get("host") ?? DEFAULT_SFTP_RELAY_HOST,
    port:
      rawPort === undefined
        ? DEFAULT_SFTP_RELAY_PORT
        : parsePort(rawPort, "--port", 0),
    target: parseTarget(rawTarget),
    allowedOrigins,
  };
}
