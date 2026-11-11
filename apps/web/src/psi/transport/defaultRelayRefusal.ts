/**
 * Why the default relay's registrar did not enroll a run, read from its
 * answer, and how the app states it. The registrar's own text is never shown:
 * a known reason picks one of the app's fixed sentences, and any other answer
 * is stated as a refusal with no reason given (docs/spec/RELAY_CREDENTIALS.md,
 * Enrolling at a default relay).
 */

import type { RelayEnrollmentWithinWait } from "@alcove/core";

/** Every {@link DefaultRelayRefusalCause}, in the order the spec lists them. */
export const DEFAULT_RELAY_REFUSAL_CAUSES = [
  "address-cap",
  "rate-limit",
  "address-table-full",
  "relay-full",
  "unreachable",
  "other",
] as const;

/**
 * Why an enrollment failed: the cap on one address's exchanges, the rate
 * limit on one address's requests, the registrar's table of addresses full,
 * the relay's ceiling on exchanges, no answer at all, or anything else.
 */
export type DefaultRelayRefusalCause =
  (typeof DEFAULT_RELAY_REFUSAL_CAUSES)[number];

/** A failed enrollment as the app states and records it. */
export interface DefaultRelayRefusal {
  cause: DefaultRelayRefusalCause;
  /** The registrar's `Retry-After` wait, where its answer stated one. */
  retryAfterSeconds?: number;
}

// The status and the start of the registrar's `error` text for each refusal
// it states a cause for (infra/relay/registrar.py, the TOKENLESS_*_REFUSAL
// constants).
const KNOWN_REFUSALS: ReadonlyArray<{
  cause: DefaultRelayRefusalCause;
  status: number;
  reasonStart: string;
}> = [
  {
    cause: "address-cap",
    status: 429,
    reasonStart: "this address holds ",
  },
  {
    cause: "rate-limit",
    status: 429,
    reasonStart: "this address has sent ",
  },
  {
    cause: "address-table-full",
    status: 429,
    reasonStart:
      "the registrar is answering enrollments without a token from as many " +
      "addresses as it can",
  },
  {
    cause: "relay-full",
    status: 503,
    reasonStart:
      "the relay holds as many exchanges enrolled without a token as it serves",
  },
];

/** The {@link DefaultRelayRefusal} a failed enrollment states. */
export function defaultRelayRefusal(
  failure: Extract<RelayEnrollmentWithinWait, { kind: "failed" }>,
): DefaultRelayRefusal {
  const answer = failure.answer;
  if (answer === undefined) return { cause: "unreachable" };
  const known = KNOWN_REFUSALS.find(
    ({ status, reasonStart }) =>
      answer.status === status &&
      answer.reason?.startsWith(reasonStart) === true,
  );
  return {
    cause: known?.cause ?? "other",
    ...(answer.retryAfterSeconds !== undefined && {
      retryAfterSeconds: answer.retryAfterSeconds,
    }),
  };
}

/** What happened, in one sentence whose "it" is the relay server. */
const REFUSAL_REASONS: Readonly<Record<DefaultRelayRefusalCause, string>> = {
  "address-cap":
    "Too many exchanges from your network are already set up on it.",
  "rate-limit":
    "Your network asked it to set up too many exchanges in a short time.",
  "address-table-full":
    "It is taking requests from as many networks as it can.",
  "relay-full": "It is serving as many exchanges as it can.",
  unreachable: "It could not be reached, or did not answer in time.",
  other: "It did not accept the request.",
};

/** The sentence stating why the relay server did not take the exchange. */
export function defaultRelayRefusalReason(
  refusal: DefaultRelayRefusal,
): string {
  return REFUSAL_REASONS[refusal.cause];
}

/** A wait of `seconds` as a sentence states it: "less than a minute", "about
 * 12 minutes", "about 3 hours". */
export function retryWaitPhrase(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120)
    return `about ${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  return `about ${String(Math.round(minutes / 60))} hours`;
}

// The wait the registrar stated, as a sentence, or none.
function retryWaitSentence(refusal: DefaultRelayRefusal): Array<string> {
  return refusal.retryAfterSeconds === undefined
    ? []
    : [
        `It said to try again in ${retryWaitPhrase(refusal.retryAfterSeconds)}.`,
      ];
}

/**
 * The run notice a run shows, as it connects, when its enrollment at the
 * default relay fails: what happened, the wait the registrar stated, and
 * what to do if the run does not connect without the relay.
 */
export function defaultRelayNotEnrolledNotice(
  refusal: DefaultRelayRefusal,
): string {
  const next =
    refusal.retryAfterSeconds !== undefined
      ? "If the exchange does not connect without it, try again after that."
      : refusal.cause === "unreachable"
        ? "If the exchange does not connect without it, check your network " +
          "connection and try again."
        : "If the exchange does not connect without it, try again later.";
  return [
    "The site's relay server could not be set up for this exchange, so this " +
      "run connects without it.",
    defaultRelayRefusalReason(refusal),
    ...retryWaitSentence(refusal),
    next,
  ].join(" ");
}

/**
 * The run notice a run shows when its enrollment at the default relay under
 * its previous secret fails, while the one under its current secret confirmed.
 */
export function defaultRelayPreviousNotEnrolledNotice(
  refusal: DefaultRelayRefusal,
): string {
  return [
    "The site's relay server could not be set up for the secret from before " +
      "the run that stopped partway.",
    defaultRelayRefusalReason(refusal),
    ...retryWaitSentence(refusal),
    "This run looks for your partner on that server under the current " +
      "secret only.",
  ].join(" ");
}
