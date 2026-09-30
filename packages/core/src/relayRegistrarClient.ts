// The client side of a relay registrar (infra/relay/README.md, The registrar),
// shared by the CLI and the web app: one registration request and how its
// answer is classified, the signed registration of a rotated relay key with its
// retries, and the enrollment made with the relay-owner token. Transport-neutral:
// it needs only `fetch`, which both hosts provide.

import { z } from "zod";

import type { RelayRegistrar } from "./config/connection.js";
import { deriveRelayKey } from "./relayCredential.js";
import { relayRegistrarAuthorization } from "./relayRegistrarProof.js";
import { readBoundedJsonBody } from "./utils/boundedJsonBody.js";
import { enc } from "./utils/crypto.js";

/** How long one registrar request may take before it counts as unanswered. */
export const RELAY_REGISTRAR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The waits between attempts at a registration the registrar did not answer,
 * or answered as unavailable; one attempt more than there are waits.
 */
export const RELAY_REGISTRATION_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000,
];

// The registrar's answers are small JSON objects; its request bodies are capped
// at 1024 bytes and an answer holds less.
const MAX_REGISTRAR_ANSWER_BYTES = 4096;

// How much of the registrar's own `error` text a message repeats.
const MAX_REGISTRAR_REASON_LENGTH = 300;

/** What stands in a message for the credential a request carried. */
export const REMOVED_CREDENTIAL_TEXT = "[credential removed]";

const MALFORMED_LAPSE_REASON =
  "its answer states a lapse time that is not a UTC timestamp, so the " +
  "registration is not taken as confirmed";

// The registrar writes `lapsesAt` as `YYYY-MM-DDTHH:MM:SSZ`
// (infra/relay/README.md, The registrar).
const LAPSES_AT_SCHEMA = z.iso.datetime();

function utf8Base64(value: string): string {
  let binary = "";
  for (const byte of enc.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * `text` with every occurrence of the `Authorization` value a request carried,
 * and of its credential after the scheme, replaced by
 * {@link REMOVED_CREDENTIAL_TEXT}: as sent, URL-encoded, and base64-encoded,
 * so a registrar or proxy that echoes the header repeats no credential.
 */
function withCredentialRemoved(text: string, authorization: string): string {
  const space = authorization.indexOf(" ");
  const values =
    space === -1
      ? [authorization]
      : [authorization, authorization.slice(space + 1)];
  const forms = new Set<string>();
  for (const value of values) {
    const base64 = utf8Base64(value);
    for (const form of [
      value,
      encodeURIComponent(value),
      base64,
      base64.replace(/=+$/, ""),
    ])
      if (form.length > 0) forms.add(form);
  }
  let removed = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length))
    removed = removed.split(form).join(REMOVED_CREDENTIAL_TEXT);
  return removed;
}

/** The registrar and exchange a message names. */
export function relayRegistrarLabel(registrar: RelayRegistrar): string {
  return (
    `the relay registrar at ${new URL(registrar.url).origin} ` +
    `(exchange ${registrar.exchangeId})`
  );
}

function registrarRequestUrl(registrar: RelayRegistrar): string {
  return `${new URL(registrar.url).origin}/exchanges/${encodeURIComponent(registrar.exchangeId)}`;
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
  /** Cancels the request, and a registration's remaining retries. */
  signal?: AbortSignal;
}

/** The reason an `unavailable` outcome states for a cancelled registration. */
export const RELAY_REGISTRATION_CANCELLED_REASON =
  "the registration was cancelled";

// The timeout's signal, or one that also aborts with `cancel`. Built by hand
// rather than with `AbortSignal.any`, which older browsers lack.
function requestSignal(
  timeout: AbortSignal,
  cancel: AbortSignal | undefined,
): { signal: AbortSignal; release: () => void } {
  if (cancel === undefined) return { signal: timeout, release: () => {} };
  const combined = new AbortController();
  const sources = [timeout, cancel];
  const forward = () => {
    const aborted = sources.find((source) => source.aborted);
    combined.abort(aborted?.reason);
  };
  const release = () => {
    for (const source of sources) source.removeEventListener("abort", forward);
  };
  if (sources.some((source) => source.aborted)) forward();
  else
    for (const source of sources)
      source.addEventListener("abort", forward, { once: true });
  return { signal: combined.signal, release };
}

interface RegistrarAnswerBody {
  error?: string;
  serverTime?: number;
  maxAgeDays?: number | null;
  lapsesAt?: string | null;
  /** The answer carried a `lapsesAt` other than `null` or a UTC timestamp. */
  malformedLapse?: true;
}

async function readAnswerBody(
  response: Response,
  signal: AbortSignal,
  authorization: string,
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
    body.error = withCredentialRemoved(fields["error"], authorization).slice(
      0,
      MAX_REGISTRAR_REASON_LENGTH,
    );
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
  if (lapsesAt === null || LAPSES_AT_SCHEMA.safeParse(lapsesAt).success)
    body.lapsesAt = lapsesAt as string | null;
  else if (lapsesAt !== undefined) body.malformedLapse = true;
  return body;
}

/**
 * Send one registration -- `POST` to enroll, `PUT` to rotate or renew -- and
 * classify the answer. Never throws for a network failure or a status: each
 * is an answer kind. Redirects are not followed, so the credential reaches no
 * second host, and no reason repeats the credential. A success whose
 * `lapsesAt` is neither `null` nor a UTC timestamp is `unavailable`, with a
 * fixed reason, and so is a request `transport.signal` cancelled.
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
  const { signal, release } = requestSignal(
    AbortSignal.timeout(timeoutMs),
    transport.signal,
  );
  const cancel = transport.signal;
  try {
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
      if (cancel?.aborted === true)
        return {
          kind: "unavailable",
          reason: RELAY_REGISTRATION_CANCELLED_REASON,
        };
      return {
        kind: "unavailable",
        reason:
          err instanceof Error && err.name === "TimeoutError"
            ? `no answer within ${timeoutMs} ms`
            : `it could not be reached (${withCredentialRemoved(
                err instanceof Error ? err.message : String(err),
                request.authorization,
              )})`,
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
    const body = await readAnswerBody(response, signal, request.authorization);
    if (status >= 200 && status < 300 && body.malformedLapse === true)
      return { kind: "unavailable", status, reason: MALFORMED_LAPSE_REASON };
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
  } finally {
    release();
  }
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

/** The clock and waits a registration runs under: injectable for tests. */
export interface RelayRegistrationEnvironment extends RelayRegistrarTransport {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The waits between attempts; {@link RELAY_REGISTRATION_RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// `sleep(ms)`, ended early once `cancel` aborts.
async function sleepUnlessCancelled(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  cancel: AbortSignal | undefined,
): Promise<void> {
  if (cancel === undefined) return sleep(ms);
  if (cancel.aborted) return;
  let stop = () => {};
  const cancelled = new Promise<void>((resolve) => {
    stop = resolve;
    cancel.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([sleep(ms), cancelled]);
  } finally {
    cancel.removeEventListener("abort", stop);
  }
}

/**
 * Register the relay key derived from `registeredSecret` for the exchange,
 * proving possession of the key derived from `signingSecret` -- the key the
 * registrar holds. A rotation signs with the pre-rotation secret; a renewal
 * registers and signs with the same one. Every registration sends
 * `maxAgeDays`, an integer or `null` for no lapse.
 *
 * An unanswered or unavailable attempt is retried after each of
 * `retryDelaysMs`; a proof outside the registrar's clock window is signed
 * again once at the registrar's own time. A refusal is final: this path holds
 * no relay-owner token and never falls back to one. Once `env.signal` aborts,
 * no further attempt is made and the outcome is `unavailable`.
 */
export async function registerRelayKey(
  registration: {
    registrar: RelayRegistrar;
    signingSecret: string;
    registeredSecret: string;
    maxAgeDays: number | null;
  },
  env: RelayRegistrationEnvironment = {},
): Promise<RelayRegistrationOutcome> {
  const { registrar, maxAgeDays } = registration;
  const now = env.now ?? (() => new Date());
  const sleep = env.sleep ?? defaultSleep;
  const delays = env.retryDelaysMs ?? RELAY_REGISTRATION_RETRY_DELAYS_MS;
  const signingKey = await deriveRelayKey(registration.signingSecret);
  const body = relayRegistrationBody(
    await deriveRelayKey(registration.registeredSecret),
    maxAgeDays,
  );
  let clockOffsetMs = 0;
  let resignedForClock = false;
  let attempt = 0;
  for (;;) {
    if (env.signal?.aborted === true)
      return {
        kind: "unavailable",
        reason: RELAY_REGISTRATION_CANCELLED_REASON,
      };
    const authorization = await relayRegistrarAuthorization({
      relayKey: signingKey,
      method: "PUT",
      exchangeId: registrar.exchangeId,
      body,
      now: new Date(now().getTime() + clockOffsetMs),
    });
    const answer = await sendRelayRegistration(
      { registrar, method: "PUT", body, authorization },
      env,
    );
    if (answer.kind === "clock-skew") {
      if (resignedForClock)
        return {
          kind: "refused",
          status: 401,
          reason:
            answer.reason ??
            "the proof's time is outside the registrar's window",
        };
      resignedForClock = true;
      clockOffsetMs = answer.serverTimeSeconds * 1000 - now().getTime();
      continue;
    }
    if (answer.kind === "unavailable" && attempt < delays.length) {
      await sleepUnlessCancelled(sleep, delays[attempt]!, env.signal);
      attempt++;
      continue;
    }
    return answer;
  }
}
