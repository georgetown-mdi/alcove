// The enrollment a run makes, before it dials, at the registrar its
// invitation's relay names (docs/spec/PROTOCOL.md, "Enrolling at a default
// relay"): one attempt without a token, its wait bounded, and a failure
// reported while the run goes on. The request is core's
// `enrollRelayKeyWithoutToken`; the browser's counterpart is
// apps/web/src/psi/transport/defaultRelay.ts.

import {
  enrollRelayKeyWithoutToken,
  redactAndSanitizeForDisplay,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type { RelayRegistrationOutcome } from "@alcove/core";

import type { EventStreamEmitter } from "./eventStream";

/**
 * How long a run waits for its enrollment at the invitation relay's registrar
 * before it dials without it. An arbitrary working value, the browser's own
 * (`DEFAULT_RELAY_DIAL_WAIT_MS` in apps/web): a registrar that is up answers
 * one HTTPS request well inside it, and one that is down or slow costs a run
 * no more than this.
 */
export const INVITATION_RELAY_ENROLLMENT_WAIT_MS = 3_000;

/** What one enrollment at the invitation relay's registrar came to. */
export type InvitationRelayEnrollment =
  | { kind: "enrolled"; lapsesAt: string | null }
  /** Refused, unreachable, or unanswered within the wait; `detail` says which. */
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/** What the enrollment reads from its surroundings: injectable for tests. */
export interface InvitationRelayEnrollmentDependencies {
  /** The registrar client; core's {@link enrollRelayKeyWithoutToken}. */
  enroll?: typeof enrollRelayKeyWithoutToken;
  /** The fetch implementation the client sends with. */
  fetch?: typeof globalThis.fetch;
  /** Cancels the enrollment and the wait for it. */
  signal?: AbortSignal;
  /** How long the run waits; {@link INVITATION_RELAY_ENROLLMENT_WAIT_MS}. */
  waitMs?: number;
}

function outcomeDetail(
  outcome: Exclude<RelayRegistrationOutcome, { kind: "registered" }>,
): string {
  const status = outcome.status === undefined ? "" : `HTTP ${outcome.status}`;
  const reason = outcome.reason ?? "";
  if (status !== "" && reason !== "") return `${status}: ${reason}`;
  return status || reason || outcome.kind;
}

/**
 * Enroll the relay key derived from `sharedSecret` at `registrarUrl`, under
 * the exchange id derived from the same secret, with no token: one attempt,
 * waited on for at most `waitMs`. A same-key repeat, either party's or a
 * later run's on the same secret, is answered as enrolled.
 */
export async function enrollAtInvitationRelay(
  registrarUrl: string,
  sharedSecret: string,
  dependencies: InvitationRelayEnrollmentDependencies = {},
): Promise<InvitationRelayEnrollment> {
  const { signal } = dependencies;
  const cancelled = (): boolean => signal?.aborted === true;
  if (cancelled()) return { kind: "cancelled" };
  const enroll = dependencies.enroll ?? enrollRelayKeyWithoutToken;
  const waitMs = dependencies.waitMs ?? INVITATION_RELAY_ENROLLMENT_WAIT_MS;
  const attempt = enroll(
    { registrarUrl, sharedSecret },
    {
      ...(dependencies.fetch !== undefined && { fetch: dependencies.fetch }),
      ...(signal !== undefined && { signal }),
      timeoutMs: waitMs,
      retryDelaysMs: [],
    },
  ).then(
    (outcome): InvitationRelayEnrollment =>
      outcome.kind === "registered"
        ? { kind: "enrolled", lapsesAt: outcome.lapsesAt }
        : { kind: "failed", detail: outcomeDetail(outcome) },
    (): InvitationRelayEnrollment => ({
      kind: "failed",
      detail: "it could not be reached",
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting = (): void => {};
  const waited = new Promise<InvitationRelayEnrollment>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ kind: "failed", detail: `no answer within ${waitMs} ms` }),
      waitMs,
    );
    stopWaiting = () => resolve({ kind: "cancelled" });
    signal?.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    const first = await Promise.race([attempt, waited]);
    return cancelled() ? { kind: "cancelled" } : first;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stopWaiting);
  }
}

/** The registrar as a message names it: its origin alone. */
function registrarOrigin(registrarUrl: string): string {
  return new URL(registrarUrl).origin;
}

/**
 * The warning a run states when its enrollment at the invitation relay's
 * registrar fails. Composed raw: the registrar url and the detail are the
 * partner's or the registrar's text, escaped at each sink.
 */
export function invitationRelayNotEnrolledWarning(
  registrarUrl: string,
  detail: string,
): string {
  return (
    `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
    `partner's invitation names did not enroll this exchange (${detail}). ` +
    "The run continues with its other relays, and that relay takes it only " +
    "if your partner enrolled the exchange there."
  );
}

/**
 * Report an enrollment: a confirmed one on the log at info level, a failed one
 * as a warning on the log and the event stream. A cancelled one reports
 * nothing, since the run is stopping.
 */
export function reportInvitationRelayEnrollment(
  registrarUrl: string,
  enrollment: InvitationRelayEnrollment,
  sinks: {
    log: { info: (message: string) => void; warn: (message: string) => void };
    emit: (fn: (e: EventStreamEmitter) => void) => void;
  },
): void {
  if (enrollment.kind === "cancelled") return;
  if (enrollment.kind === "enrolled") {
    const lapse =
      enrollment.lapsesAt === null ? "" : `, until ${enrollment.lapsesAt}`;
    sinks.log.info(
      redactAndSanitizeForDisplay(
        `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
          `partner's invitation names enrolled this exchange${lapse}`,
      ),
    );
    return;
  }
  const warning = invitationRelayNotEnrolledWarning(
    registrarUrl,
    enrollment.detail,
  );
  sinks.log.warn(
    redactAndSanitizeForDisplay(warning, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  );
  sinks.emit((e) => e.warning("invitationRelayEnrollment", warning));
}
