// The client side of a relay registrar (infra/relay/README.md, The registrar),
// shared by the CLI and the web app: one registration request and how its
// answer is classified, the signed registration of a rotated relay key with its
// retries, and the enrollment made with the relay-owner token. Transport-neutral:
// it needs only `fetch`, which both hosts provide.

import { z } from "zod";

import type { RelayRegistrar } from "./config/connection.js";
import {
  RELAY_REGISTRAR_NAME_NOT_RESOLVED_CODES,
  RELAY_REGISTRAR_NO_CONNECTION_CODES,
  type FailureCauseOfKind,
  type RelayRegistrarUnreachableFailure,
} from "./failureCause.js";
import { deriveRelayExchangeId, deriveRelayKey } from "./relayCredential.js";
import { relayRegistrarAuthorization } from "./relayRegistrarProof.js";
import { parseBoundedJson } from "./utils/boundedJson.js";
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

/** What stands in a message for the exchange id a request named. */
export const REMOVED_EXCHANGE_ID_TEXT = "[exchange id removed]";

/** What stands in a message for the relay key a request registered. */
export const REMOVED_RELAY_KEY_TEXT = "[relay key removed]";

const UNREAD_ANSWER_REASON =
  "its answer is not the registrar's answer to a registration (a JSON " +
  "object stating maxAgeDays and lapsesAt), so the registration is not " +
  "taken as confirmed";

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

/** A value a registrar request sent, and what stands for it in a message. */
interface SentValue {
  value: string;
  marker: string;
}

// `value` as the request sent it or a registrar or proxy may repeat it: as is,
// URL-encoded (the request path), JSON-escaped (the body), and base64-encoded
// with and without padding (an echoed header).
function sentForms(value: string): string[] {
  const base64 = utf8Base64(value);
  return [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    base64,
    base64.replace(/=+$/, ""),
  ].filter((form) => form.length > 0);
}

// The `key` a registration body (`relayRegistrationBody`) registers.
function registeredRelayKey(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const key = (parsed as Record<string, unknown>)["key"];
  return typeof key === "string" ? key : undefined;
}

/**
 * The values a registrar request sent that no message repeats: the
 * `Authorization` value and its credential after the scheme, the exchange id
 * in the request path, and the relay key the body registers.
 */
function sentValues(request: {
  registrar: RelayRegistrar;
  body: string;
  authorization?: string;
}): SentValue[] {
  const values: SentValue[] = [];
  const { authorization } = request;
  if (authorization !== undefined) {
    values.push({ value: authorization, marker: REMOVED_CREDENTIAL_TEXT });
    const space = authorization.indexOf(" ");
    if (space !== -1)
      values.push({
        value: authorization.slice(space + 1),
        marker: REMOVED_CREDENTIAL_TEXT,
      });
  }
  values.push({
    value: request.registrar.exchangeId,
    marker: REMOVED_EXCHANGE_ID_TEXT,
  });
  const relayKey = registeredRelayKey(request.body);
  if (relayKey !== undefined)
    values.push({ value: relayKey, marker: REMOVED_RELAY_KEY_TEXT });
  return values;
}

/**
 * `text` with every occurrence of each of `sent`, in each form the request
 * sent it or a registrar may repeat it ({@link sentForms}), replaced by that
 * value's marker. Overlapping occurrences are removed as one span, so no part
 * of either is left. A value a registrar re-encodes some other way is not
 * caught.
 */
function withSentValuesRemoved(
  text: string,
  sent: readonly SentValue[],
): string {
  const spans: Array<{ start: number; end: number; marker: string }> = [];
  for (const { value, marker } of sent)
    for (const form of sentForms(value))
      for (
        let at = text.indexOf(form);
        at !== -1;
        at = text.indexOf(form, at + 1)
      )
        spans.push({ start: at, end: at + form.length, marker });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let removed = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    if (span.start >= cursor)
      removed += text.slice(cursor, span.start) + span.marker;
    cursor = span.end;
  }
  return removed + text.slice(cursor);
}

/** The registrar and exchange a message names. */
export function relayRegistrarLabel(registrar: RelayRegistrar): string {
  return (
    `the relay registrar at ${new URL(registrar.url).origin} ` +
    `(exchange ${registrar.exchangeId})`
  );
}

/**
 * The class of network failure `err` -- what `fetch` rejected with -- names,
 * read from the code on its `cause` or, for a connection tried at several
 * addresses, on each error the cause aggregates; `undefined` when no code is
 * one a {@link RelayRegistrarUnreachableFailure} names.
 */
function unreachableFailure(
  err: unknown,
): RelayRegistrarUnreachableFailure | undefined {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const candidates: unknown[] = [cause];
  const aggregated = (cause as { errors?: unknown } | null)?.errors;
  if (Array.isArray(aggregated)) candidates.push(...aggregated);
  for (const candidate of candidates) {
    const code = (candidate as { code?: unknown } | null)?.code;
    const noConnection = RELAY_REGISTRAR_NO_CONNECTION_CODES.find(
      (known) => known === code,
    );
    if (noConnection !== undefined)
      return { failure: "no-connection", code: noConnection };
    const nameNotResolved = RELAY_REGISTRAR_NAME_NOT_RESOLVED_CODES.find(
      (known) => known === code,
    );
    if (nameNotResolved !== undefined)
      return { failure: "name-not-resolved", code: nameNotResolved };
    if (code === "ECONNRESET") return { failure: "no-answer", code };
  }
  return undefined;
}

/** The host and port a registrar's `https://` url connects to. */
function registrarHostAndPort(registrar: RelayRegistrar): {
  host: string;
  port: number;
} {
  const url = new URL(registrar.url);
  return { host: url.hostname, port: url.port === "" ? 443 : Number(url.port) };
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
  /** The registrar holds the key: a 2xx stating the registration. */
  | {
      kind: "registered";
      maxAgeDays: number | null;
      lapsesAt: string | null;
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
  /**
   * No answer, one a later attempt may not repeat (408, 429, or 5xx), or a
   * 2xx that does not state the registration. `unreachable` is set when the
   * request failed with no answer for a reason it names.
   */
  | {
      kind: "unavailable";
      status?: number;
      reason: string;
      unreachable?: FailureCauseOfKind<"relay-registrar-unreachable">;
    };

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

// A signal aborting with a `TimeoutError` once `ms` pass. Built on `setTimeout`
// rather than `AbortSignal.timeout`, which a test's fake timers do not drive.
function timeoutSignal(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(`no answer within ${ms} ms`, "TimeoutError"),
      ),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

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
  /**
   * The registration the answer states: both fields present, `maxAgeDays` an
   * integer or `null` and `lapsesAt` a UTC timestamp or `null`, as the
   * registrar writes every answer to an enrollment or registration.
   */
  registration?: { maxAgeDays: number | null; lapsesAt: string | null };
  /** The answer carried a `lapsesAt` other than `null` or a UTC timestamp. */
  malformedLapse?: true;
}

async function readAnswerBody(
  response: Response,
  signal: AbortSignal,
  sent: readonly SentValue[],
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
    body.error = withSentValuesRemoved(fields["error"], sent).slice(
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
  const lapsesAt = fields["lapsesAt"];
  const lapseRead =
    lapsesAt === null || LAPSES_AT_SCHEMA.safeParse(lapsesAt).success;
  if (!lapseRead && lapsesAt !== undefined) body.malformedLapse = true;
  if (lapseRead && (maxAgeDays === null || Number.isSafeInteger(maxAgeDays)))
    body.registration = {
      maxAgeDays: maxAgeDays as number | null,
      lapsesAt: lapsesAt as string | null,
    };
  return body;
}

/**
 * Send one registration -- `POST` to enroll, `PUT` to rotate or renew -- and
 * classify the answer. Never throws for a network failure or a status: each
 * is an answer kind. Redirects are not followed, so the credential reaches no
 * second host, and no reason repeats the credential, the exchange id, or the
 * relay key the request sent, each replaced by its marker. A 2xx is
 * `registered` only when its body is the registrar's answer to a registration
 * -- a JSON object, within the answer bound, stating `maxAgeDays` and
 * `lapsesAt`; any other 2xx is `unavailable` with a fixed reason, and so is a
 * request `transport.signal` cancelled. With `authorization` unset the request
 * has no `Authorization` header: an enrollment without a token.
 */
export async function sendRelayRegistration(
  request: {
    registrar: RelayRegistrar;
    method: "POST" | "PUT";
    body: string;
    authorization?: string;
  },
  transport: RelayRegistrarTransport = {},
): Promise<RelayRegistrarAnswer> {
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const timeoutMs = transport.timeoutMs ?? RELAY_REGISTRAR_REQUEST_TIMEOUT_MS;
  const timeout = timeoutSignal(timeoutMs);
  const { signal, release } = requestSignal(timeout.signal, transport.signal);
  const cancel = transport.signal;
  const sent = sentValues(request);
  try {
    let response: Response;
    try {
      response = await fetchImpl(registrarRequestUrl(request.registrar), {
        method: request.method,
        redirect: "manual",
        headers: {
          ...(request.authorization !== undefined && {
            Authorization: request.authorization,
          }),
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
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const failure: RelayRegistrarUnreachableFailure | undefined = timedOut
        ? { failure: "no-answer", timedOutMs: timeoutMs }
        : unreachableFailure(err);
      return {
        kind: "unavailable",
        reason: timedOut
          ? `no answer within ${timeoutMs} ms`
          : `it could not be reached (${withSentValuesRemoved(
              err instanceof Error ? err.message : String(err),
              sent,
            )})`,
        ...(failure !== undefined && {
          unreachable: {
            kind: "relay-registrar-unreachable",
            ...registrarHostAndPort(request.registrar),
            ...failure,
          },
        }),
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
    const body = await readAnswerBody(response, signal, sent);
    if (status >= 200 && status < 300) {
      if (body.malformedLapse === true)
        return { kind: "unavailable", status, reason: MALFORMED_LAPSE_REASON };
      if (body.registration === undefined)
        return { kind: "unavailable", status, reason: UNREAD_ANSWER_REASON };
      return { kind: "registered", ...body.registration };
    }
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
    timeout.clear();
    release();
  }
}

/** The final answer to a registration, after its retries. */
export type RelayRegistrationOutcome = Exclude<
  RelayRegistrarAnswer,
  { kind: "clock-skew" }
>;

/**
 * What a registration the registrar did not confirm came to, as a message
 * states it: `HTTP <status>: <reason>`, either half alone where the other is
 * absent, or the outcome's kind where both are.
 */
export function relayRegistrationOutcomeDetail(
  outcome: Exclude<RelayRegistrationOutcome, { kind: "registered" }>,
): string {
  const status = outcome.status === undefined ? "" : `HTTP ${outcome.status}`;
  const reason = outcome.reason ?? "";
  if (status !== "" && reason !== "") return `${status}: ${reason}`;
  return status || reason || outcome.kind;
}

/** The line a run states once the registrar holds a key it registered. */
export function relayRegistrationNotice(
  registrar: RelayRegistrar,
  outcome: Extract<RelayRegistrationOutcome, { kind: "registered" }>,
): string {
  const lapse =
    outcome.lapsesAt === null
      ? "; the registration does not lapse"
      : `; the registration lapses at ${outcome.lapsesAt} unless a run renews it`;
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
  /**
   * Ends the retries without cutting a request: once it aborts, a wait under
   * way ends, and the attempt in flight or the next one is the last. Unlike
   * `signal`, it never reaches a request, which runs to its own timeout.
   */
  lastAttemptSignal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// `sleep(ms)`, ended early once any of `cancels` aborts.
async function sleepUnlessCancelled(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  cancels: ReadonlyArray<AbortSignal | undefined>,
): Promise<void> {
  const sources = cancels.filter(
    (cancel): cancel is AbortSignal => cancel !== undefined,
  );
  if (sources.length === 0) return sleep(ms);
  if (sources.some((cancel) => cancel.aborted)) return;
  let stop = () => {};
  const cancelled = new Promise<void>((resolve) => {
    stop = resolve;
    for (const cancel of sources)
      cancel.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([sleep(ms), cancelled]);
  } finally {
    for (const cancel of sources) cancel.removeEventListener("abort", stop);
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
 * no further attempt is made and the outcome is `unavailable`; once
 * `env.lastAttemptSignal` aborts, the attempt in flight or the next one is
 * the last, and its answer is the outcome.
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
    if (
      answer.kind === "unavailable" &&
      attempt < delays.length &&
      env.lastAttemptSignal?.aborted !== true
    ) {
      await sleepUnlessCancelled(sleep, delays[attempt]!, [
        env.signal,
        env.lastAttemptSignal,
      ]);
      attempt++;
      continue;
    }
    return answer;
  }
}

/**
 * Enroll the exchange at a registrar that takes an enrollment without a token
 * (infra/relay/README.md, Enrollment without a token): a `POST` with no
 * `Authorization` header registering the relay key derived from
 * `sharedSecret` under the exchange id derived from it
 * ({@link deriveRelayExchangeId}), with `maxAgeDays` `null`, since the
 * registrar fixes the lapse. Either party may send it: the same key on the same
 * id is answered as registered. Retried as {@link registerRelayKey} is; a 401
 * or 409 is final.
 */
export async function enrollRelayKeyWithoutToken(
  params: { registrarUrl: string; sharedSecret: string },
  env: RelayRegistrationEnvironment = {},
): Promise<RelayRegistrationOutcome> {
  const sleep = env.sleep ?? defaultSleep;
  const delays = env.retryDelaysMs ?? RELAY_REGISTRATION_RETRY_DELAYS_MS;
  const registrar: RelayRegistrar = {
    url: params.registrarUrl,
    exchangeId: await deriveRelayExchangeId(params.sharedSecret),
  };
  const body = relayRegistrationBody(
    await deriveRelayKey(params.sharedSecret),
    null,
  );
  for (let attempt = 0; ; attempt++) {
    if (env.signal?.aborted === true)
      return {
        kind: "unavailable",
        reason: RELAY_REGISTRATION_CANCELLED_REASON,
      };
    const answer = await sendRelayRegistration(
      { registrar, method: "POST", body },
      env,
    );
    if (answer.kind === "clock-skew")
      return { kind: "refused", status: 401, reason: answer.reason };
    if (
      answer.kind !== "unavailable" ||
      attempt >= delays.length ||
      env.lastAttemptSignal?.aborted === true
    )
      return answer;
    await sleepUnlessCancelled(sleep, delays[attempt]!, [
      env.signal,
      env.lastAttemptSignal,
    ]);
  }
}

/** What one enrollment without a token, bounded by a wait, came to. */
export type RelayEnrollmentWithinWait =
  | { kind: "enrolled"; lapsesAt: string | null }
  /**
   * Refused, unreachable, or unanswered within the wait;
   * `detail` says which ({@link relayRegistrationOutcomeDetail}).
   */
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/**
 * One {@link enrollRelayKeyWithoutToken} attempt, with no retry, whose request
 * is cut once `waitMs` pass: the request's own timeout is the wait, so no
 * second timer races it. `cancelled` once `signal` aborts, before or during
 * the attempt; a same-key repeat is `enrolled`. Never throws.
 */
export async function enrollRelayKeyWithinWait(
  params: { registrarUrl: string; sharedSecret: string },
  options: {
    waitMs: number;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
  },
): Promise<RelayEnrollmentWithinWait> {
  const { signal } = options;
  const cancelled = (): boolean => signal?.aborted === true;
  if (cancelled()) return { kind: "cancelled" };
  let outcome: RelayRegistrationOutcome;
  try {
    outcome = await enrollRelayKeyWithoutToken(params, {
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(signal !== undefined && { signal }),
      timeoutMs: options.waitMs,
      retryDelaysMs: [],
    });
  } catch {
    outcome = { kind: "unavailable", reason: "it could not be reached" };
  }
  if (cancelled()) return { kind: "cancelled" };
  return outcome.kind === "registered"
    ? { kind: "enrolled", lapsesAt: outcome.lapsesAt }
    : { kind: "failed", detail: relayRegistrationOutcomeDetail(outcome) };
}
