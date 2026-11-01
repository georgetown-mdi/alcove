// The enrollment a run makes, before it dials, at the registrar its
// invitation's relay names (docs/spec/PROTOCOL.md, "Enrolling at a default
// relay"): one attempt without a token, its wait bounded, and a failure
// reported while the run goes on. The attempt is core's
// `enrollRelayKeyWithinWait`; the browser's counterpart is
// apps/web/src/psi/transport/defaultRelay.ts.

import {
  enrollRelayKeyWithinWait,
  INVITATION_RELAY_ENROLLMENT_WAIT_MS,
  invitationRelayEnrolledNotice,
  invitationRelayNotEnrolledStatement,
  redactAndSanitizeForDisplay,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type {
  HandshakeSecretKind,
  RelayEnrollmentWithinWait,
} from "@alcove/core";

import type { EventStreamEmitter } from "./eventStream";

export {
  INVITATION_RELAY_ENROLLMENT_WAIT_MS,
  invitationRelayEnrolledNotice,
  invitationRelayNotEnrolledStatement,
};

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
 * What a line about one of a run's two enrollments starts with, naming the
 * secret it enrolled.
 */
const ENROLLED_SECRET_PREFIX: Readonly<Record<HandshakeSecretKind, string>> =
  Object.freeze({
    current: "for the current shared secret, ",
    previous: "for the shared secret from before a run that stopped partway, ",
  });

/**
 * Report an enrollment: a confirmed one on the log at info level, a failed one
 * as a warning on the log and the event stream. A cancelled one reports
 * nothing, since the run is stopping. `secretKind` names which secret it
 * enrolled, on a run that enrolls both its current and its previous secret;
 * a run enrolling one passes none.
 */
export function reportInvitationRelayEnrollment(
  registrarUrl: string,
  enrollment: InvitationRelayEnrollment,
  sinks: {
    log: { info: (message: string) => void; warn: (message: string) => void };
    emit: (fn: (e: EventStreamEmitter) => void) => void;
  },
  secretKind?: HandshakeSecretKind,
): void {
  if (enrollment.kind === "cancelled") return;
  const prefix =
    secretKind === undefined ? "" : ENROLLED_SECRET_PREFIX[secretKind];
  if (enrollment.kind === "enrolled") {
    sinks.log.info(
      redactAndSanitizeForDisplay(
        prefix +
          invitationRelayEnrolledNotice(registrarUrl, enrollment.lapsesAt),
      ),
    );
    return;
  }
  const warning =
    prefix + invitationRelayNotEnrolledWarning(registrarUrl, enrollment.detail);
  sinks.log.warn(
    redactAndSanitizeForDisplay(warning, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  );
  sinks.emit((e) => e.invitationRelayEnrollment(warning, secretKind));
}
