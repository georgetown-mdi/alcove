/**
 * The address of an SFTP relay (docs/spec/SFTP_RELAY.md): the `wss://` url a
 * browser party dials to reach its partner's SFTP server. An invitation's
 * sftp endpoint may name one, and a browser party may set its own in place of
 * it; both are held to {@link sftpRelayUrlRefusal}
 * (docs/spec/INVITATION_TOKEN.md#the-sftp-relay-url).
 */

import { UsageError } from "../errors.js";

/** Upper bound on an SFTP relay url, in UTF-16 code units. */
export const MAX_SFTP_RELAY_URL_LENGTH = 1024;

/**
 * Characters an SFTP relay url may not hold anywhere: `@`, which turns what
 * precedes it into userinfo and moves the host; `\`, which the URL parser
 * reads as `/` in a `wss:` url, ending the host; `?` and `#`, which end the
 * path; `%`, which a dial decodes; whitespace and control characters, which
 * the parser deletes or rewrites. The signaling host's rule
 * (docs/spec/WEBRTC_TRANSPORT.md#broker-socket) applied to the whole url.
 */
const SFTP_RELAY_URL_REFUSED_CHARACTERS = /[@\\?#%]|\s|\p{Cc}/u;

/** Why {@link sftpRelayUrlRefusal} refused a url. */
export type SftpRelayUrlProblem =
  "tooLong" | "delimiter" | "notUrl" | "notWss" | "portZero" | "notCanonical";

/** The refusal of an SFTP relay url, naming the rule it broke in `problem`. */
export class SftpRelayUrlError extends UsageError {
  readonly problem: SftpRelayUrlProblem;
  constructor(problem: SftpRelayUrlProblem, message: string) {
    super(message);
    this.name = "SftpRelayUrlError";
    this.problem = problem;
  }
}

const SFTP_RELAY_URL_FORM =
  "a wss:// url naming a host, an optional port, and a path, for example " +
  "wss://sftp.example.org/sftp";

/**
 * Why `url` cannot name an SFTP relay, or `undefined` when it can: a `wss:`
 * url of at most {@link MAX_SFTP_RELAY_URL_LENGTH} code units, holding none of
 * the refused characters, with a port other than 0, written as the URL
 * parser's `href` gives it back (an empty path may omit its slash). The
 * message starts with `name`, the field as its reader knows it, and repeats
 * the url only once `@` is ruled out, so no user name or password is shown.
 */
export function sftpRelayUrlRefusal(
  url: string,
  name: string,
): SftpRelayUrlError | undefined {
  if (url.length > MAX_SFTP_RELAY_URL_LENGTH)
    return new SftpRelayUrlError(
      "tooLong",
      `${name} is longer than ${MAX_SFTP_RELAY_URL_LENGTH} characters`,
    );
  if (SFTP_RELAY_URL_REFUSED_CHARACTERS.test(url))
    return new SftpRelayUrlError(
      "delimiter",
      `${name} contains a space, a control character, or one of @ \\ ? # %; ` +
        `write it as ${SFTP_RELAY_URL_FORM}`,
    );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new SftpRelayUrlError(
      "notUrl",
      `${name} is not a url; write it as ${SFTP_RELAY_URL_FORM}`,
    );
  }
  if (parsed.protocol !== "wss:")
    return new SftpRelayUrlError(
      "notWss",
      `${name} must start with wss://; write it as ${SFTP_RELAY_URL_FORM}`,
    );
  if (parsed.port === "0")
    return new SftpRelayUrlError(
      "portZero",
      `${name} names port 0; write it as ${SFTP_RELAY_URL_FORM}`,
    );
  const canonical = parsed.href;
  const omitsEmptyPathSlash =
    parsed.pathname === "/" && `${url}/` === canonical;
  if (url !== canonical && !omitsEmptyPathSlash)
    return new SftpRelayUrlError(
      "notCanonical",
      `${name} is not in canonical form; write it as ${canonical}`,
    );
  return undefined;
}
