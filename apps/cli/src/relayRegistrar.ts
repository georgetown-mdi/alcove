// The CLI's calls to a relay registrar (infra/relay/README.md, The registrar):
// which registrar a run registers at, one registration request and how its
// answer is classified, and the enrollment `alcove enroll-relay` makes with
// the relay-owner token. Nothing here stores the token or a relay key.

import {
  deriveRelayKey,
  hasMintedTurnEntry,
  readBoundedJsonBody,
  selectRunRelay,
} from "@alcove/core";
import type { ConnectionConfig, RelayRegistrar } from "@alcove/core";

/** How long one registrar request may take before it counts as unanswered. */
export const RELAY_REGISTRAR_REQUEST_TIMEOUT_MS = 15_000;

// The registrar's answers are small JSON objects; its request bodies are capped
// at 1024 bytes and an answer holds less.
const MAX_REGISTRAR_ANSWER_BYTES = 4096;

// How much of the registrar's own `error` text a message repeats.
const MAX_REGISTRAR_REASON_LENGTH = 300;

/**
 * The registrar a run registers its rotated relay key at: the connection's
 * `relay_registrar`, when the run relays through this party's own `turn`
 * entries and one of them has its credential minted from the shared secret.
 * `undefined` otherwise -- a run relaying through the relay a partner's
 * invitation named registers nothing, since the party supplying a relay is
 * the one that registers at it.
 */
export function relayRegistrarForRun(
  connection: ConnectionConfig,
): RelayRegistrar | undefined {
  if (connection.channel !== "webrtc") return undefined;
  const registrar = connection.relayRegistrar;
  if (registrar === undefined) return undefined;
  const { turn } = selectRunRelay(connection);
  if (turn?.source !== "own" || !hasMintedTurnEntry(turn.servers))
    return undefined;
  return registrar;
}

/** The registrar and exchange a message names. */
export function relayRegistrarLabel(registrar: RelayRegistrar): string {
  return (
    `the relay registrar at ${new URL(registrar.url).origin} ` +
    `(exchange ${registrar.exchangeId})`
  );
}

function registrarRequestUrl(registrar: RelayRegistrar): string {
  return `${new URL(registrar.url).origin}/exchanges/${registrar.exchangeId}`;
}

/** The body of a registration: the key and the lapse the row takes. */
export function relayRegistrationBody(
  key: string,
  maxAgeDays: number | null,
): string {
  return JSON.stringify({ key, maxAgeDays });
}

/** How the registrar answered one registration. */
export type RelayRegistrarAnswer =
  /** The registrar holds the key: 200. */
  | {
      kind: "registered";
      maxAgeDays: number | null | undefined;
      lapsesAt: string | null | undefined;
    }
  /** A proof outside the registrar's clock window: 401 with `serverTime`. */
  | { kind: "clock-skew"; serverTimeSeconds: number; reason?: string }
  /**
   * The credential does not hold for the exchange: any other 401, or a 409
   * (the registrar holds another key, or none, for the exchange).
   */
  | { kind: "refused"; status: number; reason?: string }
  /** A request the registrar will not take as sent: a redirect or other 4xx. */
  | { kind: "rejected"; status: number; reason?: string }
  /** No answer, or one a later attempt may not repeat: 408, 429, or 5xx. */
  | { kind: "unavailable"; status?: number; reason: string };

/** How a registrar request is sent: injectable for tests. */
export interface RelayRegistrarTransport {
  /** The fetch implementation; `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /** The per-request timeout; {@link RELAY_REGISTRAR_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

interface RegistrarAnswerBody {
  error?: string;
  serverTime?: number;
  maxAgeDays?: number | null;
  lapsesAt?: string | null;
}

async function readAnswerBody(
  response: Response,
  signal: AbortSignal,
): Promise<RegistrarAnswerBody> {
  let read: Awaited<ReturnType<typeof readBoundedJsonBody>>;
  try {
    read = await readBoundedJsonBody(response, MAX_REGISTRAR_ANSWER_BYTES, {
      signal,
    });
  } catch {
    return {};
  }
  if (read.kind !== "parsed") return {};
  const value = read.value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const fields = value as Record<string, unknown>;
  const body: RegistrarAnswerBody = {};
  if (typeof fields["error"] === "string")
    body.error = fields["error"].slice(0, MAX_REGISTRAR_REASON_LENGTH);
  if (
    typeof fields["serverTime"] === "number" &&
    Number.isSafeInteger(fields["serverTime"]) &&
    fields["serverTime"] >= 0
  )
    body.serverTime = fields["serverTime"];
  const maxAgeDays = fields["maxAgeDays"];
  if (maxAgeDays === null || Number.isSafeInteger(maxAgeDays))
    body.maxAgeDays = maxAgeDays as number | null;
  const lapsesAt = fields["lapsesAt"];
  if (lapsesAt === null || typeof lapsesAt === "string")
    body.lapsesAt = lapsesAt;
  return body;
}

/**
 * Send one registration -- `POST` to enroll, `PUT` to rotate or renew -- and
 * classify the answer. Never throws for a network failure or a status: each
 * is an answer kind. Redirects are not followed, so the credential reaches no
 * second host.
 */
export async function sendRelayRegistration(
  request: {
    registrar: RelayRegistrar;
    method: "POST" | "PUT";
    body: string;
    authorization: string;
  },
  transport: RelayRegistrarTransport = {},
): Promise<RelayRegistrarAnswer> {
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const timeoutMs = transport.timeoutMs ?? RELAY_REGISTRAR_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(registrarRequestUrl(request.registrar), {
      method: request.method,
      redirect: "manual",
      headers: {
        Authorization: request.authorization,
        "Content-Type": "application/json",
      },
      body: request.body,
      signal,
    });
  } catch (err) {
    return {
      kind: "unavailable",
      reason:
        err instanceof Error && err.name === "TimeoutError"
          ? `no answer within ${timeoutMs} ms`
          : `it could not be reached (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const status = response.status;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    return {
      kind: "rejected",
      status,
      reason: "it answered with a redirect, which is not followed",
    };
  }
  const body = await readAnswerBody(response, signal);
  if (status >= 200 && status < 300)
    return {
      kind: "registered",
      maxAgeDays: body.maxAgeDays,
      lapsesAt: body.lapsesAt,
    };
  if (status === 401 && body.serverTime !== undefined)
    return {
      kind: "clock-skew",
      serverTimeSeconds: body.serverTime,
      ...(body.error !== undefined && { reason: body.error }),
    };
  if (status === 401 || status === 409)
    return {
      kind: "refused",
      status,
      ...(body.error !== undefined && { reason: body.error }),
    };
  if (status === 408 || status === 429 || status >= 500)
    return {
      kind: "unavailable",
      status,
      reason: body.error ?? "the registrar did not take the request",
    };
  return {
    kind: "rejected",
    status,
    ...(body.error !== undefined && { reason: body.error }),
  };
}

/** The final answer to a registration, after its retries. */
export type RelayRegistrationOutcome = Exclude<
  RelayRegistrarAnswer,
  { kind: "clock-skew" }
>;

/** The line a run states once the registrar holds a key it registered. */
export function relayRegistrationNotice(
  registrar: RelayRegistrar,
  outcome: Extract<RelayRegistrationOutcome, { kind: "registered" }>,
): string {
  const lapse =
    typeof outcome.lapsesAt === "string"
      ? `; the registration lapses at ${outcome.lapsesAt} unless a run renews it`
      : outcome.lapsesAt === null
        ? "; the registration does not lapse"
        : "";
  return (
    `${relayRegistrarLabel(registrar)} holds the relay key derived from ` +
    `this exchange's current shared secret${lapse}.`
  );
}

/**
 * Enroll the exchange at the registrar with the relay-owner token: register
 * the relay key derived from `sharedSecret`. `replace` sends the operator's
 * recovery route -- the token on `PUT`, which registers the key whatever key
 * the registrar holds -- in place of the create-only `POST`. The token is
 * sent in this one request and kept nowhere.
 */
export async function enrollRelayKey(
  params: {
    registrar: RelayRegistrar;
    sharedSecret: string;
    maxAgeDays: number | null;
    ownerToken: string;
    replace: boolean;
  },
  transport: RelayRegistrarTransport = {},
): Promise<RelayRegistrationOutcome> {
  const body = relayRegistrationBody(
    await deriveRelayKey(params.sharedSecret),
    params.maxAgeDays,
  );
  const answer = await sendRelayRegistration(
    {
      registrar: params.registrar,
      method: params.replace ? "PUT" : "POST",
      body,
      authorization: `Bearer ${params.ownerToken}`,
    },
    transport,
  );
  if (answer.kind === "clock-skew")
    return { kind: "refused", status: 401, reason: answer.reason };
  return answer;
}
