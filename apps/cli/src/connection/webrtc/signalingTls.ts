import { isIP } from "node:net";
import { connect } from "node:tls";

import type { BrokerLocation } from "./brokerClient";
import type { TLSSocket } from "node:tls";

/**
 * Why a TLS signaling socket would not come up, answered after it failed. Node's
 * `WebSocket` reports a failed `wss://` handshake as an empty `TypeError`, so
 * this handshakes with the endpoint once more, verification on and nothing
 * written, and reports what the certificate check said. `tls.connect` reads no
 * proxy environment, so a proxied run is told no check was made:
 * docs/CLI.md#when-a-webrtc-exchange-does-not-connect.
 */

/**
 * Ceiling on the diagnostic handshake, so a server that accepts and then says
 * nothing cannot hold the report open.
 */
export const SIGNALING_TLS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Answers what the certificate check said about a signaling endpoint: the
 * verification failure's code, or `undefined` when the certificate was not the
 * problem. `signal` releases the handshake, answering `undefined` at once.
 */
export type SignalingCertificateProbe = (
  location: BrokerLocation,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/**
 * What a failed signaling dial is told about the endpoint's certificate;
 * `undefined` adds nothing to the failure the caller already has.
 */
export type SignalingCertificateAnswer =
  /** The certificate did not verify, under this verification failure code. */
  | { kind: "verification-failed"; code: string }
  /** No check was made: the dial this run makes is not the one a check makes. */
  | { kind: "not-checked-proxied" }
  | undefined;

/** The one value `NODE_USE_ENV_PROXY` opts in with. */
const ENVIRONMENT_PROXY_OPT_IN = "1";

/**
 * The variables Node reads the proxy for a `wss://` dial from. Every spelling
 * here and above is driven against a real proxy in
 * test/integration/webrtc/signalingCertificate.test.ts.
 */
const PROXY_ENVIRONMENT_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

/**
 * Whether `token` is the Node flag turning environment proxying on, the flag
 * turning it off, or neither. Node treats an underscore as a hyphen, drops a
 * double quote and ignores `=` onward, so `--use-env-proxy=false` turns it on.
 */
function environmentProxyingFlag(token: string): boolean | undefined {
  const name = token.replaceAll('"', "").split("=")[0]?.replaceAll("_", "-");
  if (name === "--use-env-proxy") return true;
  if (name === "--no-use-env-proxy") return false;
  return undefined;
}

/**
 * The Node flags this run started under, in the order Node applies them:
 * `NODE_OPTIONS` first, then the command line. A space is the only
 * `NODE_OPTIONS` separator; a tab or newline stops the process before it runs.
 */
function nodeFlags(): Array<string> {
  return [...(process.env.NODE_OPTIONS ?? "").split(" "), ...process.execArgv];
}

/**
 * Whether this run has the environment proxying configured that a `wss://`
 * dial follows and {@link probeSignalingCertificate} does not, from
 * `NODE_USE_ENV_PROXY` or the last `--use-env-proxy` flag. It answers for the
 * run and ignores `NO_PROXY`. Node reads these at startup, so a later
 * `process.env` write changes this answer but not the dial.
 */
export function environmentProxyingConfigured(): boolean {
  let optedIn = process.env.NODE_USE_ENV_PROXY === ENVIRONMENT_PROXY_OPT_IN;
  for (const token of nodeFlags()) {
    const flag = environmentProxyingFlag(token);
    if (flag !== undefined) optedIn = flag;
  }
  if (!optedIn) return false;
  return PROXY_ENVIRONMENT_VARIABLES.some(
    (variable) => (process.env[variable] ?? "") !== "",
  );
}

/**
 * The host to hand `tls.connect`: the URL parser's, so it matches the
 * signaling socket's dial including IDNA normalization, with an IPv6 literal's
 * brackets removed, since `tls.connect` would look "[::1]" up as a name.
 */
function dialedHost(location: BrokerLocation): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(`wss://${location.host}`);
  } catch {
    return undefined;
  }
  const { hostname } = parsed;
  return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
}

/** Read `authorizationError`, which Node sets as a code string or an Error. */
function verificationFailureCode(socket: TLSSocket): string | undefined {
  const failure: unknown = socket.authorizationError;
  if (typeof failure === "string") return failure === "" ? undefined : failure;
  if (failure instanceof Error) {
    const code = (failure as { code?: unknown }).code;
    return typeof code === "string" ? code : failure.message;
  }
  return undefined;
}

/**
 * Handshake with `location` once and report the certificate verification
 * failure, if that is what stopped it. Never rejects: every other outcome is
 * `undefined`.
 */
export const probeSignalingCertificate: SignalingCertificateProbe = (
  location,
  signal,
) =>
  new Promise<string | undefined>((resolve) => {
    const host = dialedHost(location);
    if (!location.secure || host === undefined || signal?.aborted === true) {
      resolve(undefined);
      return;
    }
    // Send the same SNI the `WebSocket` dial sends, so the answer is about the
    // same certificate; `tls.connect` sends none unless told, and throws on an
    // IP literal (RFC 6066).
    const port = location.port;
    let socket: TLSSocket;
    try {
      socket =
        isIP(host) === 0
          ? connect({ host, port, servername: host })
          : connect({ host, port });
    } catch {
      resolve(undefined);
      return;
    }
    // The socket stays referenced, or a run whose last handle is this handshake
    // exits before the failure is reported; an interrupt destroys it instead.
    const timer = setTimeout(
      () => settle(undefined),
      SIGNALING_TLS_PROBE_TIMEOUT_MS,
    );
    timer.unref();
    function settle(code: string | undefined): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(code);
    }
    function onAbort(): void {
      settle(undefined);
    }
    signal?.addEventListener("abort", onAbort);
    socket.on("secureConnect", () => settle(undefined));
    socket.on("error", () => settle(verificationFailureCode(socket)));
  });

/**
 * What to tell a failed signaling dial to `location` about the endpoint's
 * certificate, the one place this is decided. A `ws://` dial is told nothing;
 * a proxied run is told no check was made, since the probe would not reach
 * the endpoint its dial did.
 */
export async function askSignalingCertificate(
  location: BrokerLocation,
  probe: SignalingCertificateProbe,
  signal?: AbortSignal,
): Promise<SignalingCertificateAnswer> {
  if (!location.secure) return undefined;
  if (environmentProxyingConfigured()) return { kind: "not-checked-proxied" };
  const code = await probe(location, signal);
  return code === undefined ? undefined : { kind: "verification-failed", code };
}
