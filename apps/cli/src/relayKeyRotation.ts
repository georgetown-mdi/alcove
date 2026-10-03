// The registration a run makes after its shared secret rotates, signed with
// the relay key the registrar holds (docs/spec/PROTOCOL.md, "Registering the
// rotated relay key"), and the retry of one the registrar did not confirm,
// before the next run dials. The signed request and its retries are core's
// `registerRelayKey`; this module holds the key file and exit-code halves.

import {
  ConnectionError,
  registerRelayKey,
  sanitizeErrorForDisplay,
  UsageError,
} from "@alcove/core";
import type {
  ConnectionConfig,
  RelayRegistrar,
  RelayRegistrationEnvironment,
} from "@alcove/core";

import {
  clearRelayRegistrationPending,
  loadKeyFile,
  type KeyFile,
} from "./keyFile";
import {
  relayRegistrarForRun,
  relayRegistrarLabel,
  relayRegistrationNotice,
  type RelayRegistrationOutcome,
} from "./relayRegistrar";
import { AUTHENTICATION_FAILED_EXIT_CODE } from "./util/exit";
import { withRecoveryHintTag } from "./util/recoveryHint";

export {
  registerRelayKey,
  RELAY_REGISTRATION_RETRY_DELAYS_MS,
} from "@alcove/core";
export type { RelayRegistrationEnvironment } from "@alcove/core";

/** The step every lost-key outcome names. */
export const RELAY_REENROLLMENT_STEP =
  "enroll the exchange again with the relay-owner token: run " +
  "'alcove enroll-relay --replace-relay-key' with this run's --config-file " +
  "and --key-file, and enter the token when asked";

/**
 * What a run states when its connection names a registrar it does not
 * register at, because it relays through the relay the invitation named;
 * `undefined` when the registrar is used or none is named.
 */
export function relayRegistrarUnusedNotice(
  connection: ConnectionConfig,
): string | undefined {
  if (connection.channel !== "webrtc") return undefined;
  const registrar = connection.relayRegistrar;
  if (registrar === undefined || relayRegistrarForRun(connection) !== undefined)
    return undefined;
  return (
    `connection.relay_registrar is not used on this run: it relays through ` +
    "the relay your partner's invitation named (connection.invitation_relay), " +
    `so nothing is registered at ${relayRegistrarLabel(registrar)}.`
  );
}

function answerDetail(outcome: RelayRegistrationOutcome): string {
  if (outcome.kind === "registered") return "";
  const status = outcome.status === undefined ? "" : `HTTP ${outcome.status}`;
  const reason = outcome.reason ?? "";
  return status !== "" && reason !== ""
    ? `${status}: ${reason}`
    : status || reason;
}

/**
 * The failure a registration outcome other than `registered` becomes, for the
 * `stage` it was made at:
 *
 * - `rotation`: the run's own rotation, after the exchange;
 * - `pending`: the retry of an unconfirmed rotation, before the run dials.
 *
 * A refusal is exit 77 with the re-enrollment step, since the key the
 * registrar holds is not one this run has; an unavailable registrar is a
 * `transport` failure (69); a request the registrar will not take is a usage
 * error (64).
 */
export function relayRegistrationError(
  registrar: RelayRegistrar,
  outcome: Exclude<RelayRegistrationOutcome, { kind: "registered" }>,
  stage: "rotation" | "pending",
): Error {
  const label = relayRegistrarLabel(registrar);
  const detail = answerDetail(outcome);
  const what =
    stage === "rotation"
      ? `the exchange's shared secret rotated, and ${label} did not register ` +
        "the relay key derived from the new secret"
      : "the key file records a relay key registration that was not " +
        `confirmed, and ${label} did not confirm it before this run dialed`;
  const sent =
    stage === "pending"
      ? " Nothing was sent to your partner, and the shared secret is unchanged."
      : " The rotated shared secret is kept.";
  switch (outcome.kind) {
    case "refused":
      return withRecoveryHintTag(
        Object.assign(
          new Error(
            `${what} (${detail}): the registrar does not hold the key this ` +
              `run signed with.${sent} Until the registrar holds this ` +
              `exchange's current key, the relay refuses this party's runs; ` +
              `${RELAY_REENROLLMENT_STEP}.`,
          ),
          { exitCode: AUTHENTICATION_FAILED_EXIT_CODE },
        ),
      );
    case "unavailable":
      return new ConnectionError(
        `${what}: ${detail}.${sent} ` +
          (stage === "pending"
            ? "Run the exchange again once the registrar answers."
            : "The next run retries the registration before it dials; if " +
              `the registrar then refuses it, ${RELAY_REENROLLMENT_STEP}.`),
        "transport",
      );
    case "rejected":
      return new UsageError(
        `${what}: it refused the request (${detail}).${sent} Check ` +
          "connection.relay_registrar in the configuration; once it is " +
          `corrected, ${RELAY_REENROLLMENT_STEP}.`,
      );
  }
}

/** What {@link registerRotatedRelayKey} did. */
export type RotatedRelayKeyResult =
  | { kind: "not-rotated" }
  | {
      kind: "registered";
      outcome: Extract<RelayRegistrationOutcome, { kind: "registered" }>;
      /** A failure to drop the confirmed pending registration from the key file. */
      clearError?: unknown;
    }
  | { kind: "failed"; error: Error };

/**
 * After a run: when the key file at `keyFilePath` holds a secret other than
 * `preRotationSecret` -- the run rotated it -- register the relay key derived
 * from the rotated secret, signed with the key derived from
 * `preRotationSecret`, which the registrar holds. `preRotationSecret` is the
 * run's in-memory copy; nothing derived from it is written. A confirmed
 * registration drops the key file's pending marker; a failed one leaves it
 * for the next run's retry. The rotated secret is never rolled back.
 */
export async function registerRotatedRelayKey(
  params: {
    registrar: RelayRegistrar;
    preRotationSecret: string;
    keyFilePath: string;
    maxAgeDays: number | null;
  },
  env: RelayRegistrationEnvironment = {},
): Promise<RotatedRelayKeyResult> {
  const { registrar, preRotationSecret, keyFilePath, maxAgeDays } = params;
  let current: KeyFile | undefined;
  try {
    current = loadKeyFile(keyFilePath, { warnOnPermissive: false });
  } catch (err) {
    return {
      kind: "failed",
      error: new Error(
        `the key file could not be read back to register the rotated relay ` +
          `key at ${relayRegistrarLabel(registrar)}; ${RELAY_REENROLLMENT_STEP}.`,
        { cause: err },
      ),
    };
  }
  if (current === undefined || current.sharedSecret === preRotationSecret)
    return { kind: "not-rotated" };
  const outcome = await registerRelayKey(
    {
      registrar,
      signingSecret: preRotationSecret,
      registeredSecret: current.sharedSecret,
      maxAgeDays,
    },
    env,
  );
  if (outcome.kind !== "registered")
    return {
      kind: "failed",
      error: relayRegistrationError(registrar, outcome, "rotation"),
    };
  try {
    clearRelayRegistrationPending(keyFilePath, current.sharedSecret);
  } catch (clearError) {
    return { kind: "registered", outcome, clearError };
  }
  return { kind: "registered", outcome };
}

/**
 * Log what {@link registerRotatedRelayKey} did, and return whether the
 * registration failed: a failure is logged at error level with its next step.
 */
export function logRotatedRelayKey(
  result: RotatedRelayKeyResult,
  registrar: RelayRegistrar,
  log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  },
): boolean {
  if (result.kind === "not-rotated") return false;
  if (result.kind === "failed") {
    log.error(sanitizeErrorForDisplay(result.error));
    return true;
  }
  log.info(relayRegistrationNotice(registrar, result.outcome));
  if (result.clearError !== undefined)
    log.warn(
      "the key file still records the registration as unconfirmed, so the " +
        "next run confirms it again before it dials: " +
        sanitizeErrorForDisplay(result.clearError),
    );
  return false;
}

/**
 * Before a run dials: when the key file records a rotation the registrar did
 * not confirm, register the key derived from `sharedSecret` again. The key
 * the registrar held before that rotation was dropped with the run that made
 * it, so this is a renewal signed with the current key, which the registrar
 * takes only if it already holds that key -- a rotation whose answer was lost.
 * A confirmed renewal drops the marker; anything else throws the classified
 * failure ({@link relayRegistrationError}, stage `pending`).
 */
export async function retryPendingRelayRegistration(
  params: {
    registrar: RelayRegistrar;
    keyFilePath: string;
    sharedSecret: string;
    maxAgeDays: number | null;
  },
  env: RelayRegistrationEnvironment = {},
): Promise<Extract<RelayRegistrationOutcome, { kind: "registered" }>> {
  const { registrar, keyFilePath, sharedSecret, maxAgeDays } = params;
  const outcome = await registerRelayKey(
    {
      registrar,
      signingSecret: sharedSecret,
      registeredSecret: sharedSecret,
      maxAgeDays,
    },
    env,
  );
  if (outcome.kind !== "registered")
    throw relayRegistrationError(registrar, outcome, "pending");
  clearRelayRegistrationPending(keyFilePath, sharedSecret);
  return outcome;
}
