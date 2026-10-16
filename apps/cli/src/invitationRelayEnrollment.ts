// The enrollment a run makes, before it dials, at the registrar its
// invitation's relay names (docs/spec/PROTOCOL.md, "Enrolling at a default
// relay"): one attempt without a token, its wait bounded, and a failure
// reported while the run goes on. The attempt is core's
// `enrollRelayKeyWithinWait`; the browser's counterpart is
// apps/web/src/psi/transport/defaultRelay.ts.

import {
  enrollRelayKeyWithinWait,
  redactAndSanitizeForDisplay,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type { RelayEnrollmentWithinWait } from "@alcove/core";

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
export type InvitationRelayEnrollment = RelayEnrollmentWithinWait;

/** What the enrollment reads from its surroundings: injectable for tests. */
export interface InvitationRelayEnrollmentDependencies {
  /** The fetch implementation the client sends with. */
  fetch?: typeof globalThis.fetch;
  /** Cancels the enrollment and the wait for it. */
  signal?: AbortSignal;
}

/**
 * Enroll the relay key derived from `sharedSecret` at `registrarUrl`, under
 * the exchange id derived from the same secret, with no token: one attempt,
 * waited on for at most {@link INVITATION_RELAY_ENROLLMENT_WAIT_MS}. A
 * same-key repeat, either party's or a later run's on the same secret, is
 * answered as enrolled.
 */
export function enrollAtInvitationRelay(
  registrarUrl: string,
  sharedSecret: string,
  dependencies: InvitationRelayEnrollmentDependencies = {},
): Promise<InvitationRelayEnrollment> {
  return enrollRelayKeyWithinWait(
    { registrarUrl, sharedSecret },
    { waitMs: INVITATION_RELAY_ENROLLMENT_WAIT_MS, ...dependencies },
  );
}

/** The registrar as a message names it: its origin alone. */
function registrarOrigin(registrarUrl: string): string {
  return new URL(registrarUrl).origin;
}

/**
 * The line a run states when the invitation relay's registrar enrolls the
 * exchange, with the lapse the registrar states. Composed raw, as the warning
 * below is.
 */
export function invitationRelayEnrolledNotice(
  registrarUrl: string,
  lapsesAt: string | null,
): string {
  const lapse = lapsesAt === null ? "" : `, until ${lapsesAt}`;
  return (
    `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
    `partner's invitation names enrolled this exchange${lapse}`
  );
}

/**
 * The first sentence of {@link invitationRelayNotEnrolledWarning}: the
 * registrar and what it answered.
 */
export function invitationRelayNotEnrolledStatement(
  registrarUrl: string,
  detail: string,
): string {
  return (
    `the relay registrar at ${registrarOrigin(registrarUrl)} that your ` +
    `partner's invitation names did not enroll this exchange (${detail}).`
  );
}

/** The second sentence of {@link invitationRelayNotEnrolledWarning}. */
export const INVITATION_RELAY_NOT_ENROLLED_REMEDY =
  "The run continues with its other relays, and that relay takes it only " +
  "if your partner enrolled the exchange there.";

/**
 * The warning a run states when its enrollment at the invitation relay's
 * registrar fails. Composed raw: the registrar url and the detail are the
 * partner's or the registrar's text, escaped at each sink.
 */
export function invitationRelayNotEnrolledWarning(
  registrarUrl: string,
  detail: string,
): string {
  return `${invitationRelayNotEnrolledStatement(registrarUrl, detail)} ${INVITATION_RELAY_NOT_ENROLLED_REMEDY}`;
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
    sinks.log.info(
      redactAndSanitizeForDisplay(
        invitationRelayEnrolledNotice(registrarUrl, enrollment.lapsesAt),
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
