import { TurnUrlSchema, turnUrlRelay } from "./config/connection.js";
import type { TurnProviderEntry } from "./config/connection.js";
import { RELAY_CREDENTIAL_MAX_TTL_SECONDS } from "./relayCredential.js";
import { readBoundedJsonBody } from "./utils/boundedJsonBody.js";

/**
 * The minting of a TURN credential from a relay provider's API under the
 * operator's own account, for a `turn` entry that names a provider
 * (docs/spec/RELAY_CREDENTIALS.md, "Provider-minted credentials"). Nothing here
 * reads a file or holds the token past the call: the caller passes the entry
 * with its token already read, and no outcome repeats it.
 */

/** Each provider as an operator-facing message names it. */
export const TURN_PROVIDER_NAMES: Readonly<
  Record<TurnProviderEntry["provider"], string>
> = { cloudflare: "Cloudflare" };

/** The host Cloudflare's TURN servers answer on, and the one name kept. */
export const CLOUDFLARE_TURN_HOST = "turn.cloudflare.com";

/** The host each provider's minting API answers on. */
export const TURN_PROVIDER_MINT_HOSTS: Readonly<
  Record<TurnProviderEntry["provider"], string>
> = { cloudflare: "rtc.live.cloudflare.com" };

/**
 * The lifetime every mint asks for, in seconds: the one-hour ceiling on any
 * relay credential a run presents.
 */
export const PROVIDER_TURN_CREDENTIAL_TTL_SECONDS =
  RELAY_CREDENTIAL_MAX_TTL_SECONDS;

/** How long a mint waits for the provider's answer. */
export const TURN_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

// The answer lists a few servers with a credential each; far below this.
const MAX_MINT_ANSWER_BYTES = 16 * 1024;

// A minted username or credential longer than this is not one the provider
// documents, and is refused as a malformed answer.
const MAX_MINTED_FIELD_LENGTH = 1024;

/** One TURN server a mint yields: a kept url and the credential minted for it. */
export interface MintedTurnServer {
  url: string;
  username: string;
  credential: string;
}

/**
 * What one mint came to:
 * - `minted`: the provider answered with at least one kept url; `expiresAt`
 *   counts the lifetime asked for from just before the request was sent,
 *   since the answer states none.
 * - `refused`: the provider answered with a status other than 2xx.
 * - `unreachable`: no answer, by `reason`.
 * - `malformed`: a 2xx answer that is not a list of ICE servers, or lists no
 *   `turns:` url on the provider's own host with a credential.
 */
export type TurnProviderMintOutcome =
  | { kind: "minted"; servers: MintedTurnServer[]; expiresAt: Date }
  | { kind: "refused"; status: number }
  | { kind: "unreachable"; reason: "timeout" | "network" | "cancelled" }
  | { kind: "malformed"; problem: "not-ice-servers" | "no-kept-url" };

/** The request a mint sends, built apart from the send so a test can read it. */
export interface TurnProviderMintRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * The minting request for `entry`: a `POST` naming the key id in the path,
 * the token as the bearer, and a body setting the lifetime.
 */
export function turnProviderMintRequest(
  entry: TurnProviderEntry,
  ttlSeconds: number = PROVIDER_TURN_CREDENTIAL_TTL_SECONDS,
): TurnProviderMintRequest {
  return {
    url:
      `https://${TURN_PROVIDER_MINT_HOSTS[entry.provider]}/v1/turn/keys/` +
      `${encodeURIComponent(entry.keyId)}/credentials/generate-ice-servers`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${entry.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: ttlSeconds }),
  };
}

/**
 * Whether a url from the provider's answer is kept: a `turns:` url on the
 * provider's own host, in the grammar a `turn` entry's url takes, so the TLS
 * certificate the relay presents is checked against that name.
 */
export function isKeptProviderTurnUrl(url: string): boolean {
  return (
    url.startsWith("turns:") &&
    TurnUrlSchema.safeParse(url).success &&
    turnUrlRelay(url)?.host === CLOUDFLARE_TURN_HOST
  );
}

function boundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_MINTED_FIELD_LENGTH
  );
}

// Port 443 first: a run allocates on the first url alone, and 443 is the
// port a network that admits only HTTPS lets through.
function port443First(servers: MintedTurnServer[]): MintedTurnServer[] {
  const on443 = (server: MintedTurnServer) =>
    turnUrlRelay(server.url)?.port === 443;
  return [
    ...servers.filter(on443),
    ...servers.filter((server) => !on443(server)),
  ];
}

/**
 * The servers a mint's answer yields: each kept url
 * ({@link isKeptProviderTurnUrl}) with the username and credential of the
 * ICE server listing it, a url listed twice kept once, port 443 first.
 * `iceServers` may be one ICE server or a list. `undefined` for an answer
 * that is not an object holding them.
 */
export function providerTurnServersFromAnswer(
  answer: unknown,
): MintedTurnServer[] | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const iceServers = (answer as Record<string, unknown>)["iceServers"];
  const listed = Array.isArray(iceServers) ? iceServers : [iceServers];
  if (
    listed.length === 0 ||
    listed.some((server) => typeof server !== "object" || server === null)
  )
    return undefined;
  const kept: MintedTurnServer[] = [];
  const seen = new Set<string>();
  for (const server of listed as Array<Record<string, unknown>>) {
    const { urls, username, credential } = server;
    const urlList = Array.isArray(urls) ? urls : [urls];
    if (!boundedString(username) || !boundedString(credential)) continue;
    for (const url of urlList) {
      if (typeof url !== "string" || !isKeptProviderTurnUrl(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      kept.push({ url, username, credential });
    }
  }
  return port443First(kept);
}

/** How a mint is sent: injectable for tests. */
export interface TurnProviderTransport {
  /** The fetch implementation; `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /** {@link TURN_PROVIDER_REQUEST_TIMEOUT_MS} when unset. */
  timeoutMs?: number;
  /** Cancels the mint. */
  signal?: AbortSignal;
  /** The clock the lifetime counts from. */
  now?: () => Date;
}

/**
 * Mint a TURN credential for `entry`. Never throws for a network failure, a
 * status or an answer: each is an outcome kind, and none holds the token,
 * the answer's text or a network error's message. Redirects are not
 * followed, so the token reaches no second host.
 */
export async function mintProviderTurnCredential(
  entry: TurnProviderEntry,
  transport: TurnProviderTransport = {},
): Promise<TurnProviderMintOutcome> {
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const timeoutMs = transport.timeoutMs ?? TURN_PROVIDER_REQUEST_TIMEOUT_MS;
  const now = transport.now ?? (() => new Date());
  const request = turnProviderMintRequest(entry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = transport.signal;
  const onCancel = () => controller.abort();
  if (cancel?.aborted === true) controller.abort();
  else cancel?.addEventListener("abort", onCancel, { once: true });
  const notAnswered = (): TurnProviderMintOutcome => ({
    kind: "unreachable",
    reason:
      cancel?.aborted === true
        ? "cancelled"
        : controller.signal.aborted
          ? "timeout"
          : "network",
  });
  const sentAt = now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return notAnswered();
    }
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "refused", status: response.status };
    }
    const read = await readBoundedJsonBody(response, MAX_MINT_ANSWER_BYTES, {
      signal: controller.signal,
    });
    if (
      read.kind === "invalid" &&
      (read.readFailed || controller.signal.aborted)
    )
      return notAnswered();
    if (read.kind !== "parsed")
      return { kind: "malformed", problem: "not-ice-servers" };
    const servers = providerTurnServersFromAnswer(read.value);
    if (servers === undefined)
      return { kind: "malformed", problem: "not-ice-servers" };
    if (servers.length === 0)
      return { kind: "malformed", problem: "no-kept-url" };
    return {
      kind: "minted",
      servers,
      expiresAt: new Date(
        sentAt.getTime() + PROVIDER_TURN_CREDENTIAL_TTL_SECONDS * 1000,
      ),
    };
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", onCancel);
  }
}
