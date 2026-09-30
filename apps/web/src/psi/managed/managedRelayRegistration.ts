/**
 * The managed exchange's relay key registration (docs/spec/PROTOCOL.md,
 * "Registering the rotated relay key"): which runs register, the retry before
 * a run connects of a registration the registrar did not confirm, the signed
 * registration of the rotated key after a run, and the enrollment made with
 * the relay-owner token. The requests and their answers are core's
 * (`relayRegistrarClient.ts`), shared with the command line.
 *
 * Where each credential lives. The pre-rotation secret a registration is
 * signed with is the run's own copy of the record it read inside the
 * run+rotate lock, and nothing derived from it is written. The relay-owner
 * token is an argument of {@link enrollManagedRelayRegistrar}, sent in one
 * request and passed to no store.
 */

import {
  enrollRelayKey,
  getLogger,
  registerRelayKey,
  relayRegistrarLabel,
  relayRegistrationNotice,
} from "@alcove/core";

import { readOwnRelaySetting, relayForRun } from "../transport/ownRelaySetting";

import {
  clearManagedExchangeRelayRegistrationPending,
  getManagedExchange,
  persistManagedExchangeRelayRegistrar,
} from "./managedExchangeStore";
import { runnableManagedExchangeOrRefuse } from "./managedExchangeRecord";
import { withManagedExchangeLock } from "./managedExchangeLock";

import type {
  RelayRegistrar,
  RelayRegistrationEnvironment,
  RelayRegistrationOutcome,
} from "@alcove/core";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { OwnRelayRead } from "../transport/ownRelaySetting";

const log = getLogger("managedRelayRegistration");

/** A registration outcome other than the registrar holding the key. */
export type RelayRegistrationFailure = Exclude<
  RelayRegistrationOutcome,
  { kind: "registered" }
>;

/** The step every lost-key outcome names. */
export const MANAGED_RELAY_REENROLLMENT_STEP =
  "enroll the exchange again with the relay-owner token under Relay " +
  "registration on this exchange's page, choosing to replace the key the " +
  "registrar holds";

/**
 * The registrar a run of `record` registers at: the one the record was
 * enrolled at, when the run relays through this browser's own relay -- the
 * invitation the record was accepted from names no TURN url, and this
 * browser's relay setting names at least one, each minted from the shared
 * secret. `undefined` otherwise: the party that supplies a relay is the one
 * that registers at it.
 */
export function managedRelayRegistrarForRun(
  record: Pick<ManagedExchangeRecord, "relayRegistrar" | "exchangeFile">,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): RelayRegistrar | undefined {
  const registrar = record.relayRegistrar;
  if (registrar === undefined) return undefined;
  const connection = record.exchangeFile.connection;
  const invitationRelay =
    connection.channel === "webrtc" ? connection.invitationRelay : undefined;
  if ((invitationRelay?.turn ?? []).length > 0) return undefined;
  const relay = relayForRun(invitationRelay, readOwn);
  return relay !== undefined && relay.turn.length > 0 ? registrar : undefined;
}

function failureDetail(outcome: RelayRegistrationFailure): string {
  const status = outcome.status === undefined ? "" : `HTTP ${outcome.status}`;
  const reason = outcome.reason ?? "";
  return status !== "" && reason !== ""
    ? `${status}: ${reason}`
    : status || reason;
}

/**
 * The message a registration that did not land states, for the `stage` it
 * was made at: `rotation`, after a run rotated the secret, or `pending`, the
 * retry before a run connects. It names the registrar and the next step; a
 * refusal names owner-token re-enrollment, since the key the registrar holds
 * is not one this browser has.
 */
export function managedRelayRegistrationFailureMessage(
  registrar: RelayRegistrar,
  outcome: RelayRegistrationFailure,
  stage: "rotation" | "pending",
): string {
  const label = relayRegistrarLabel(registrar);
  const detail = failureDetail(outcome);
  const what =
    stage === "rotation"
      ? `The exchange's shared secret rotated, and ${label} did not register ` +
        "the relay key derived from the new secret"
      : "This exchange records a relay key registration that was not " +
        `confirmed, and ${label} did not confirm it before this run connected`;
  const kept =
    stage === "pending"
      ? "Nothing was sent to your partner, and the shared secret is unchanged."
      : "The run's results stand and the rotated shared secret is kept.";
  switch (outcome.kind) {
    case "refused":
      return (
        `${what} (${detail}): the registrar does not hold the key this run ` +
        `signed with. ${kept} Until the registrar holds this exchange's ` +
        `current key, the relay refuses this exchange's runs; ` +
        `${MANAGED_RELAY_REENROLLMENT_STEP}.`
      );
    case "unavailable":
      return (
        `${what}: ${detail}. ${kept} ` +
        (stage === "pending"
          ? "Run the exchange again once the registrar answers."
          : "The next run retries the registration before it connects; if " +
            `the registrar then refuses it, ${MANAGED_RELAY_REENROLLMENT_STEP}.`)
      );
    case "rejected":
      return (
        `${what}: it refused the request (${detail}). ${kept} Check the ` +
        "registrar address and exchange id under Relay registration on this " +
        `exchange's page, then ${MANAGED_RELAY_REENROLLMENT_STEP}.`
      );
  }
}

/**
 * Raised before a run connects when the pending registration it retried was
 * not confirmed. The run stopped before any contact with the partner, so the
 * shared secret is unchanged and the record still holds the pending
 * registration.
 */
export class ManagedRelayRegistrationError extends Error {
  /** The registrar that did not confirm. */
  readonly registrar: RelayRegistrar;
  /** How it answered. */
  readonly outcome: RelayRegistrationFailure;
  constructor(registrar: RelayRegistrar, outcome: RelayRegistrationFailure) {
    super(
      managedRelayRegistrationFailureMessage(registrar, outcome, "pending"),
    );
    this.name = "ManagedRelayRegistrationError";
    this.registrar = registrar;
    this.outcome = outcome;
  }
}

/** The store writes a registration makes: injectable for tests. */
export interface ManagedRelayRegistrationStore {
  clearPending: (id: string, confirmedSecret: string) => Promise<void>;
}

const defaultRegistrationStore: ManagedRelayRegistrationStore = {
  clearPending: clearManagedExchangeRelayRegistrationPending,
};

/**
 * Before a run connects: when `current` records a registration the registrar
 * did not confirm, register the key derived from its secret again. The key
 * the registrar held before that rotation left with the run that made it, so
 * this is a renewal signed with the current key, which the registrar takes
 * only if it already holds that key -- a rotation whose answer was lost. A
 * confirmed renewal drops the pending registration from the record.
 *
 * @throws {ManagedRelayRegistrationError} if the registrar did not confirm.
 */
export async function retryPendingManagedRelayRegistration(
  current: RunnableManagedExchangeRecord,
  registrar: RelayRegistrar,
  env: RelayRegistrationEnvironment = {},
  store: ManagedRelayRegistrationStore = defaultRegistrationStore,
): Promise<void> {
  if (current.relayRegistrationPendingSince === undefined) return;
  log.info(
    "retrying a relay key registration not confirmed since " +
      `${current.relayRegistrationPendingSince} at ${relayRegistrarLabel(registrar)}`,
  );
  const outcome = await registerRelayKey(
    {
      registrar,
      signingSecret: current.sharedSecret,
      registeredSecret: current.sharedSecret,
      maxAgeDays: current.tokenMaxAgeDays ?? null,
    },
    env,
  );
  if (outcome.kind !== "registered")
    throw new ManagedRelayRegistrationError(registrar, outcome);
  await store.clearPending(current.id, current.sharedSecret);
  log.info(relayRegistrationNotice(registrar, outcome));
}

/** What {@link registerRotatedManagedRelayKey} did. */
export type RotatedManagedRelayKeyResult =
  { kind: "registered" } | { kind: "failed"; message: string };

/**
 * After a run rotated the secret: register the relay key derived from
 * `rotatedSecret`, signed with the key derived from `preRotationSecret`, which
 * the registrar holds. A confirmed registration drops the pending
 * registration the rotation write stored; a failed one leaves it for the next
 * run's retry, and its message names the registrar and the next step. Never
 * throws: the run's own outcome is not this registration's.
 */
export async function registerRotatedManagedRelayKey(
  params: {
    id: string;
    registrar: RelayRegistrar;
    preRotationSecret: string;
    rotatedSecret: string;
    maxAgeDays: number | null;
  },
  env: RelayRegistrationEnvironment = {},
  store: ManagedRelayRegistrationStore = defaultRegistrationStore,
): Promise<RotatedManagedRelayKeyResult> {
  const { id, registrar, preRotationSecret, rotatedSecret, maxAgeDays } =
    params;
  let outcome: RelayRegistrationOutcome;
  try {
    outcome = await registerRelayKey(
      {
        registrar,
        signingSecret: preRotationSecret,
        registeredSecret: rotatedSecret,
        maxAgeDays,
      },
      env,
    );
  } catch (error) {
    log.error("registering the rotated relay key failed:", error);
    return {
      kind: "failed",
      message: managedRelayRegistrationFailureMessage(
        registrar,
        {
          kind: "unavailable",
          reason: "the registration could not be made",
        },
        "rotation",
      ),
    };
  }
  if (outcome.kind !== "registered")
    return {
      kind: "failed",
      message: managedRelayRegistrationFailureMessage(
        registrar,
        outcome,
        "rotation",
      ),
    };
  log.info(relayRegistrationNotice(registrar, outcome));
  try {
    await store.clearPending(id, rotatedSecret);
  } catch (error) {
    log.warn(
      "the registrar confirmed the rotated relay key, and the record still " +
        "records it as unconfirmed, so the next run confirms it again:",
      error,
    );
  }
  return { kind: "registered" };
}

/** How {@link enrollManagedRelayRegistrar} ended. */
export type ManagedRelayEnrollmentResult =
  | { kind: "enrolled"; record: RunnableManagedExchangeRecord }
  | { kind: "failed"; outcome: RelayRegistrationFailure };

/** The platform boundaries an enrollment drives: injectable for tests. */
export interface ManagedRelayEnrollmentDeps {
  /** Runs `step` under the record's run+rotate lock, refusing when a run holds it. */
  withLock: <T>(id: string, step: () => Promise<T>) => Promise<T>;
  getRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  persistRegistrar: (
    id: string,
    registrar: RelayRegistrar,
    confirmedSecret: string,
  ) => Promise<RunnableManagedExchangeRecord>;
  env?: RelayRegistrationEnvironment;
}

const defaultEnrollmentDeps: ManagedRelayEnrollmentDeps = {
  withLock: (id, step) =>
    withManagedExchangeLock(id, step, { ifAvailable: true }),
  getRecord: getManagedExchange,
  persistRegistrar: persistManagedExchangeRelayRegistrar,
};

/**
 * Enroll a stored exchange at `registrar` and, once the registrar holds the
 * relay key derived from the record's current secret, store the registrar on
 * the record, dropping any pending registration.
 *
 * With `ownerToken`, the relay-owner token enrolls the key -- a `POST`, or the
 * `PUT` that replaces whatever key the registrar holds where `replace` is set.
 * The token is sent in that one request and passed to nothing else. Without
 * it, the registration is a renewal signed with the current key, which
 * confirms a registrar that already holds it: an exchange the command line
 * enrolled, brought here.
 *
 * Runs under the record's run+rotate lock, so no run rotates the secret while
 * the registrar is asked.
 *
 * @throws {ManagedExchangeLockUnavailableError} if a run holds the lock.
 * @throws {Error} if the record is gone or holds a configuration only.
 * @throws {ManagedRelayRegistrarStaleError} if the secret moved regardless.
 */
export async function enrollManagedRelayRegistrar(
  params: {
    id: string;
    registrar: RelayRegistrar;
    ownerToken?: string;
    replace?: boolean;
  },
  deps: ManagedRelayEnrollmentDeps = defaultEnrollmentDeps,
): Promise<ManagedRelayEnrollmentResult> {
  const { id, registrar, ownerToken } = params;
  return deps.withLock(id, async () => {
    const stored = await deps.getRecord(id);
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const record = runnableManagedExchangeOrRefuse(stored);
    const maxAgeDays = record.tokenMaxAgeDays ?? null;
    const outcome =
      ownerToken === undefined
        ? await registerRelayKey(
            {
              registrar,
              signingSecret: record.sharedSecret,
              registeredSecret: record.sharedSecret,
              maxAgeDays,
            },
            deps.env,
          )
        : await enrollRelayKey(
            {
              registrar,
              sharedSecret: record.sharedSecret,
              maxAgeDays,
              ownerToken,
              replace: params.replace === true,
            },
            deps.env,
          );
    if (outcome.kind !== "registered") return { kind: "failed", outcome };
    return {
      kind: "enrolled",
      record: await deps.persistRegistrar(id, registrar, record.sharedSecret),
    };
  });
}

/** The message a failed enrollment states: the registrar's answer and what to
 * do next. */
export function managedRelayEnrollmentFailureMessage(
  registrar: RelayRegistrar,
  outcome: RelayRegistrationFailure,
  withToken: boolean,
): string {
  const label = relayRegistrarLabel(registrar);
  const detail = failureDetail(outcome);
  switch (outcome.kind) {
    case "refused":
      return withToken
        ? `${label} refused the enrollment (${detail}). Check the relay-owner ` +
            "token; if the registrar already holds a key for this exchange id, " +
            "choose to replace it."
        : `${label} does not hold this exchange's current relay key ` +
            `(${detail}). Enter the relay-owner token to enroll the exchange.`;
    case "unavailable":
      return `${label} did not answer (${detail}). Nothing was stored; try again once it answers.`;
    case "rejected":
      return `${label} refused the request (${detail}). Check the registrar address and exchange id.`;
  }
}
