import { z } from "zod";

import { UsageError } from "../errors.js";
import {
  decodeUrlComponent,
  redactUrlCredentials,
} from "../utils/urlComponents.js";

// The one reading of an SFTP server URL, host and port shared by the CLI and
// the console. Accepted form and the login-directory prefix:
// docs/CLI.md#configuration.

/** The URL schemes that name an SFTP server. */
export const SFTP_URL_PROTOCOLS: ReadonlyArray<string> = ["sftp:", "ssh:"];

/**
 * A port an SFTP server is dialed on: an integer from 1 to 65535. Port 0 asks
 * the operating system for any free port when listening and names no server
 * when dialing, so it is refused rather than copied into a connection or an
 * invitation endpoint.
 */
export const SftpPortSchema: z.ZodType<number> = z.int().min(1).max(65535);

/** Whether `port` is a port an SFTP server can be dialed on. */
export function isSftpPort(port: number): boolean {
  return SftpPortSchema.safeParse(port).success;
}

/**
 * A conservative bare IPv6 literal check: only hex digits, `:` and, in at
 * most one trailing dotted run (an IPv4-mapped tail), a decimal `.`; at
 * least two colons tell it from a host name or IPv4 address. Brackets are
 * refused here.
 */
export function isBareIpv6Address(host: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(host)) return false;
  if ((host.match(/:/g) ?? []).length < 2) return false;
  const dots = host.match(/\./g) ?? [];
  return dots.length === 0 || dots.length === 3;
}

// Userinfo (`@`), a scheme or path separator (`/`, which also rules out `://`),
// the delimiters a WHATWG hostname setter truncates at or rejects (`#`, `?`,
// `\`), the percent-encoding introducer, whitespace and control characters.
const SFTP_HOST_DISALLOWED_CHAR = /[@/\\#?%\s\x00-\x1f\x7f]/;

const BRACKETED_HOST = /^\[([^[\]]*)\]$/;

/**
 * Whether `host` is a bare SFTP server address: a host name, an IPv4 address,
 * or an IPv6 literal with or without brackets, holding no userinfo, scheme,
 * path, port, URL delimiter, whitespace, or control character. A host that
 * fails this is a URL fragment or login string, never an address an
 * invitation endpoint may state verbatim.
 */
export function isBareSftpHost(host: string): boolean {
  if (host === "" || SFTP_HOST_DISALLOWED_CHAR.test(host)) return false;
  const bracketed = BRACKETED_HOST.exec(host);
  if (bracketed !== null) return isBareIpv6Address(bracketed[1]);
  if (host.includes("[") || host.includes("]")) return false;
  return !host.includes(":") || isBareIpv6Address(host);
}

/**
 * The host as the SSH client dials it: an IPv6 literal without its brackets,
 * any other host unchanged. Node's socket layer resolves a bracketed literal
 * as a name and fails.
 */
export function sftpDialHost(host: string): string {
  const bracketed = BRACKETED_HOST.exec(host);
  return bracketed !== null ? bracketed[1] : host;
}

/** The connection fields an `sftp://` or `ssh://` URL states. */
export interface SftpUrlFields {
  /** Decoded, with an IPv6 literal's brackets removed. */
  host: string;
  port?: number;
  username?: string;
  password?: string;
  /**
   * The remote directory, decoded: absolute for a URL path, relative to the
   * login directory for a path under `/~/`, and unset for a URL with no path
   * (or `/`, or `/~`), which works in the login directory.
   */
  path?: string;
}

// The first path segment that marks the rest of the path as relative to the
// login directory. Matched on the raw (still-encoded) path, so `/%7E/x` names
// an absolute directory literally called `~`.
const LOGIN_DIRECTORY_SEGMENT = "~";

/**
 * Parse an `sftp://[user[:password]@]host[:port][/path]` URL (or the same with
 * `ssh://`) into its connection fields. Host, path, username and password are
 * percent-decoded; a malformed escape in any of them rejects the whole URL. A
 * path under `/~/` is relative to the login directory.
 *
 * @throws {UsageError} when the input is not a URL, not an sftp or ssh URL,
 *   names no host or a host that is not a bare address, names port 0, holds a
 *   query or fragment, or holds a malformed percent-escape. A message naming
 *   the URL names it without its credentials.
 */
export function parseSftpUrl(input: string | URL): SftpUrlFields {
  let url: URL;
  if (typeof input === "string") {
    try {
      url = new URL(input.trim());
    } catch {
      throw new UsageError(
        "could not read the URL; expected sftp://[user@]host[:port][/path]",
      );
    }
  } else url = input;
  if (!SFTP_URL_PROTOCOLS.includes(url.protocol))
    throw new UsageError(
      `expected an sftp:// or ssh:// URL; got: ${redactUrlCredentials(url)}`,
    );
  if (!url.hostname)
    throw new UsageError(
      `sftp URL must include a host (e.g. sftp://host/path); got: ` +
        redactUrlCredentials(url),
    );
  if (url.search !== "" || url.hash !== "")
    throw new UsageError(
      "sftp URL must not include a query (?) or fragment (#); write a ? or # " +
        `in the directory as %3F or %23; got: ${redactUrlCredentials(url)}`,
    );
  const host = sftpDialHost(decodeUrlComponent(url.hostname, url));
  if (!isBareSftpHost(host))
    throw new UsageError(
      "sftp URL host must be a server name or IP address; got: " +
        redactUrlCredentials(url),
    );
  const port = url.port === "" ? undefined : Number(url.port);
  if (port !== undefined && !isSftpPort(port))
    throw new UsageError(
      `sftp URL port must be from 1 to 65535; got: ${redactUrlCredentials(url)}`,
    );
  const path = remoteDirectoryFromUrlPath(url);
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    ...(url.username !== ""
      ? { username: decodeUrlComponent(url.username, url) }
      : {}),
    ...(url.password !== ""
      ? { password: decodeUrlComponent(url.password, url) }
      : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

function remoteDirectoryFromUrlPath(url: URL): string | undefined {
  const raw = url.pathname;
  const loginRelativePrefix = `/${LOGIN_DIRECTORY_SEGMENT}/`;
  if (raw === "" || raw === "/" || raw === `/${LOGIN_DIRECTORY_SEGMENT}`)
    return undefined;
  if (raw.startsWith(loginRelativePrefix)) {
    const relative = raw.slice(loginRelativePrefix.length);
    return relative === "" ? undefined : decodeUrlComponent(relative, url);
  }
  return decodeUrlComponent(raw, url);
}

/** The server locator {@link formatSftpUrl} writes as a URL. */
export interface SftpUrlLocator {
  host: string;
  port?: number;
  /** Absolute, relative to the login directory, or unset (or empty) for the
   * login directory itself. */
  path?: string;
}

// The placeholder host the URL is seeded with, distinguished from a real host so
// a setter no-op (which leaves this value in place) is detectable. `.invalid` is
// a reserved TLD (RFC 6761), so it is never a legitimately authored server.
const SENTINEL_HOST = "host.invalid";

function encodeUrlPathSegments(segments: ReadonlyArray<string>): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function urlPathForRemoteDirectory(path: string): string {
  if (!path.startsWith("/"))
    return `/${LOGIN_DIRECTORY_SEGMENT}/${encodeUrlPathSegments(path.split("/"))}`;
  const [, first, ...rest] = path.split("/");
  const encodedFirst =
    first === LOGIN_DIRECTORY_SEGMENT ? "%7E" : encodeURIComponent(first);
  return rest.length === 0
    ? `/${encodedFirst}`
    : `/${encodedFirst}/${encodeUrlPathSegments(rest)}`;
}

/**
 * Write an SFTP server locator as the `sftp://host[:port][/path]` URL that
 * {@link parseSftpUrl} reads back to the same host, port and directory. The
 * host is set through the WHATWG {@link URL} object, an IPv6 literal bracketed
 * first; each path segment is percent-encoded, and a relative directory is
 * written under `/~/`.
 *
 * @throws {Error} when the host is not a bare address or does not survive the
 *   URL's host parser, the port is outside 1-65535, or the directory has no
 *   URL form that reads back unchanged (a `.` or `..` segment, which URL
 *   parsing removes, or the root `/`, which reads back as the login directory).
 */
export function formatSftpUrl(locator: SftpUrlLocator): string {
  if (!isBareSftpHost(locator.host))
    throw new Error(
      "could not write the sftp host into a URL: it is not a bare server " +
        "address",
    );
  const host = sftpDialHost(locator.host);
  const url = new URL(`sftp://${SENTINEL_HOST}`);
  url.hostname = host.includes(":") ? `[${host}]` : host;
  if (url.hostname === "" || url.hostname === SENTINEL_HOST)
    throw new Error("could not write the sftp host into a URL");
  if (locator.port !== undefined) {
    if (!isSftpPort(locator.port))
      throw new Error("could not write the sftp port into a URL: use 1-65535");
    url.port = String(locator.port);
  }
  const path =
    locator.path === undefined || locator.path === ""
      ? undefined
      : locator.path;
  if (path !== undefined) url.pathname = urlPathForRemoteDirectory(path);
  const readBack = parseSftpUrl(url);
  if (readBack.path !== path || readBack.port !== locator.port)
    throw new Error(
      "could not write the remote directory into an sftp URL that reads " +
        "back unchanged; remove any . or .. segments, or name a directory " +
        "other than /",
    );
  return url.href;
}
