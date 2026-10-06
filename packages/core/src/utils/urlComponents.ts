import { UsageError } from "../errors.js";

/**
 * Render a URL as a string with any embedded credentials (the userinfo
 * component) removed, for echoing in a user-facing message. `URL.href`
 * preserves an embedded password, which must never reach the terminal, logs,
 * or shell history; the username is dropped too and only the locator remains.
 */
export function redactUrlCredentials(url: URL): string {
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  return safe.href;
}

/**
 * Decode a percent-encoded URL component (host, path, username, or password)
 * to the literal value the SFTP layer expects: the WHATWG `URL` parser keeps
 * these percent-encoded, but ssh2 and ssh2-sftp-client consume them verbatim.
 * The decode is all or nothing: a malformed escape (e.g. a lone `%`) is a
 * {@link UsageError} naming the URL through {@link redactUrlCredentials},
 * since the offending component may be the password. Operator-facing
 * behavior: docs/CLI.md#configuration.
 */
export function decodeUrlComponent(value: string, url: URL): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UsageError(
      `malformed percent-encoding in URL: ${redactUrlCredentials(url)}`,
    );
  }
}
