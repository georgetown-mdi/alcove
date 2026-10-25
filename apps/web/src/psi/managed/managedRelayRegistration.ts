/**
 * The managed exchange's relay key registration (docs/spec/PROTOCOL.md,
 * "Registering the rotated relay key"): which runs register, the retry before
 * a run connects of a registration the registrar did not confirm, the signed
 * registration of the rotated key after a run, and the enrollment made with
 * the relay-owner token, and the registration a re-invite makes of its fresh
 * secret's key. The requests and their answers are core's
 * (`relayRegistrarClient.ts`), shared with the command line.
 *
 * Where each credential lives. The pre-rotation secret a registration is
 * signed with is the run's own copy of the record it read when it took the
 * run+rotate lock, or the re-invite's copy of the record it replaced, and
 * nothing derived from it is written. The relay-owner
 * token is an argument of {@link enrollManagedRelayRegistrar}, sent in one
 * request and passed to no store.
 */

import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  enrollRelayKey,
  getLogger,
  registerRelayKey,
  relayRegistrarLabel,
  relayRegistrationNotice,
  sanitizeForDisplay,
} from "@alcove/core";

import { readOwnRelaySetting } from "../transport/ownRelaySetting";

import {
  clearManagedExchangeRelayRegistrationPending,
  getManagedExchange,
  persistManagedExchangeRelayRegistrar,
} from "./managedExchangeStore";
import { runnableManagedExchangeOrRefuse } from "./managedExchangeRecord";

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
 * enrolled at, when the run relays through this browser's own relay -- this
 * browser's relay setting names at least one TURN url, each minted from the
 * shared secret. `undefined` otherwise. Whatever relay the invitation names
 * is listed beside it and decides nothing here.
 */
export function managedRelayRegistrarForRun(
  record: Pick<ManagedExchangeRecord, "relayRegistrar">,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): RelayRegistrar | undefined {
  const registrar = record.relayRegistrar;
  if (registrar === undefined) return undefined;
  const own = readOwn();
  return own.kind === "set" && own.relay.turn.length > 0
    ? registrar
    : undefined;
}

function failureDetail(outcome: RelayRegistrationFailure): string {
  const status = outcome.status === undefined ? "" : `HTTP ${outcome.status}`;
  const reason = outcome.reason ?? "";
  return status !== "" && reason !== ""
    ? `${status}: ${reason}`
    : status || reason;
}

const REGISTRAR_REFUSES_RUNS =
  "Until the registrar holds this exchange's current key, the relay refuses " +
  "this exchange's runs";

/** Where a registration that did not land was made: after a run rotated the
 * secret, in the retry before a run connects, or after a re-invite replaced
 * the secret. */
export type ManagedRelayRegistrationStage = "rotation" | "pending" | "reinvite";

const FAILED_REGISTRATION: Record<
  ManagedRelayRegistrationStage,
  (label: string) => string
> = {
  rotation: (label) =>
    `The exchange's shared secret rotated, and ${label} did not register ` +
    "the relay key derived from the new secret",
  pending: (label) =>
    "This exchange records a relay key registration that was not " +
    `confirmed, and ${label} did not confirm it before this run connected`,
  reinvite: (label) =>
    "The re-invite replaced the exchange's shared secret, and " +
    `${label} did not register the relay key derived from the new secret`,
};

const KEPT_AFTER_FAILED_REGISTRATION: Record<
  ManagedRelayRegistrationStage,
  string
> = {
  rotation: "The run's results stand and the rotated shared secret is kept.",
  pending:
    "Nothing was sent to your partner, and the shared secret is unchanged.",
  reinvite: "The new invitation stands.",
};

const UNAVAILABLE_NEXT_STEP: Record<ManagedRelayRegistrationStage, string> = {
  rotation:
    "The next run retries the registration before it connects; if the " +
    `registrar then refuses it, ${MANAGED_RELAY_REENROLLMENT_STEP}.`,
  pending: "Run the exchange again once the registrar answers.",
  reinvite:
    "The key the registrar holds is derived from the replaced secret, which " +
    `is not kept, so no run can register the new key; ` +
    `${MANAGED_RELAY_REENROLLMENT_STEP}.`,
};

/**
 * The message a registration that did not land states, for the `stage` it
 * was made at. It names the registrar and the next step; a refusal names
 * owner-token re-enrollment, since the key the registrar holds is not one
 * this browser has.
 */
export function managedRelayRegistrationFailureMessage(
  registrar: RelayRegistrar,
  outcome: RelayRegistrationFailure,
  stage: ManagedRelayRegistrationStage,
): string {
  const label = relayRegistrarLabel(registrar);
  const detail = failureDetail(outcome);
  const what = FAILED_REGISTRATION[stage](label);
  const kept = KEPT_AFTER_FAILED_REGISTRATION[stage];
  switch (outcome.kind) {
    case "refused":
      return (
        `${what} (${detail}): the registrar does not hold the key the ` +
        `registration was signed with. ${kept} ${REGISTRAR_REFUSES_RUNS}; ` +
        `${MANAGED_RELAY_REENROLLMENT_STEP}.`
      );
    case "unavailable":
      return `${what}: ${detail}. ${kept} ${UNAVAILABLE_NEXT_STEP[stage]}`;
    case "rejected":
      return (
        `${what}: it refused the request (${detail}). ${kept} Check the ` +
        "registrar address and exchange id under Relay registration on this " +
        `exchange's page, then ${MANAGED_RELAY_REENROLLMENT_STEP}.`
      );
  }
}

/**
 * The message of a run stopped before connecting because a re-invite's
 * registration was not confirmed: the registrar holds the key of the secret
 * the re-invite replaced, so only owner-token re-enrollment registers the
 * current one.
 */
export function managedRelayReinviteKeyLostMessage(
  registrar: RelayRegistrar,
): string {
  return (
    "This exchange's re-invite replaced its shared secret, and " +
    `${relayRegistrarLabel(registrar)} did not confirm the relay key derived ` +
    "from the new one. The key the registrar holds is derived from the " +
    "replaced secret, which is not kept, so no run can register the current " +
    `key. ${KEPT_AFTER_FAILED_REGISTRATION.pending} ` +
    `${REGISTRAR_REFUSES_RUNS}; ${MANAGED_RELAY_REENROLLMENT_STEP}.`
  );
}

/** Why a run stopped before connecting over its relay key registration: the
 * registrar's answer to the retry, or `key-lost`, a re-invite's registration
 * that was not confirmed, for which no retry is sent. */
export type ManagedRelayRegistrationStop =
  RelayRegistrationFailure | { kind: "key-lost" };

/**
 * Raised before a run connects when the pending registration it retried was
 * not confirmed, or when a re-invite's registration was not, which no run can
 * confirm. The run stopped before any contact with the partner, so the
 * shared secret is unchanged and the record still holds the pending
 * registration.
 */
export class ManagedRelayRegistrationError extends Error {
  /** The registrar that did not confirm. */
  readonly registrar: RelayRegistrar;
  /** How it answered, or `key-lost` when nothing was asked. */
  readonly outcome: ManagedRelayRegistrationStop;
  constructor(
    registrar: RelayRegistrar,
    outcome: ManagedRelayRegistrationStop,
  ) {
    super(
      outcome.kind === "key-lost"
        ? managedRelayReinviteKeyLostMessage(registrar)
        : managedRelayRegistrationFailureMessage(registrar, outcome, "pending"),
    );
    this.name = "ManagedRelayRegistrationError";
    this.registrar = registrar;
    this.outcome = outcome;
  }
}

/** The store reads and writes a registration makes: injectable for tests. */
export interface ManagedRelayRegistrationStore {
  /** Reads the stored record. */
  getRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Drops the pending registration where the record still holds
   * `confirmedSecret` and names `registrar`, and returns the stored record. */
  clearPending: (
    id: string,
    confirmedSecret: string,
    registrar: RelayRegistrar,
  ) => Promise<RunnableManagedExchangeRecord>;
}

const defaultRegistrationStore: ManagedRelayRegistrationStore = {
  getRecord: getManagedExchange,
  clearPending: clearManagedExchangeRelayRegistrationPending,
};

async function readRegistrationRecord(
  store: ManagedRelayRegistrationStore,
  id: string,
): Promise<RunnableManagedExchangeRecord> {
  const stored = await store.getRecord(id);
  if (stored === undefined)
    throw new Error(`no managed exchange with id ${id}`);
  return runnableManagedExchangeOrRefuse(stored);
}

/**
 * Before a run connects: when the record stored under `id` records a
 * registration the registrar did not confirm, register the key derived from
 * its secret again, at the registrar it names. The record is read here rather
 * than taken from the run's copy: a re-invite takes no lock, so it may have
 * replaced the secret or confirmed its own registration since the run took
 * the lock. The key the registrar held
 * before that rotation left with the run that made it, so this is a renewal
 * signed with the current key, which the registrar takes only if it already
 * holds that key -- a rotation whose answer was lost. A confirmed renewal
 * drops the pending registration from the record. `env.signal` cancels the
 * renewal and its retries. A registration pending for the reason `"reinvite"`
 * sends nothing: the key the registrar holds is derived from a secret the
 * re-invite replaced, so no renewal can confirm it.
 *
 * @throws {ManagedRelayRegistrationError} if the registrar did not confirm,
 *   or the registration is pending for the reason `"reinvite"`.
 * @throws {Error} if the record is gone or holds a configuration only.
 * @throws the reason `env.signal` aborted with, when it cancelled the renewal;
 *   the registration stays pending.
 */
export async function retryPendingManagedRelayRegistration(
  id: string,
  env: RelayRegistrationEnvironment = {},
  store: ManagedRelayRegistrationStore = defaultRegistrationStore,
): Promise<void> {
  const current = await readRegistrationRecord(store, id);
  const registrar = current.relayRegistrar;
  if (
    current.relayRegistrationPendingSince === undefined ||
    registrar === undefined
  )
    return;
  if (current.relayRegistrationPendingReason === "reinvite")
    throw new ManagedRelayRegistrationError(registrar, { kind: "key-lost" });
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
  if (outcome.kind !== "registered") {
    env.signal?.throwIfAborted();
    throw new ManagedRelayRegistrationError(registrar, outcome);
  }
  await store.clearPending(current.id, current.sharedSecret, registrar);
  log.info(relayRegistrationNotice(registrar, outcome));
}

/** The registration of its rotated relay key a run owes once its rotation is
 * stored: the parameters of {@link registerRotatedManagedRelayKey}. */
export interface RotatedManagedRelayKeyRegistration {
  id: string;
  registrar: RelayRegistrar;
  preRotationSecret: string;
  rotatedSecret: string;
}

/**
 * The registration a run owes once its rotation is stored, or `undefined` for
 * none: at the registrar `rotated` names, the record the rotation write
 * stored, read inside that write's own transaction, where the run relays
 * through this browser's own relay ({@link managedRelayRegistrarForRun}).
 * Enrollment takes no lock, so the registrar the run read when it took the
 * lock may not be this one; the rotation write set the pending registration
 * against this one.
 */
export function rotatedManagedRelayKeyRegistration(
  rotated: RunnableManagedExchangeRecord,
  preRotationSecret: string,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): RotatedManagedRelayKeyRegistration | undefined {
  const registrar = managedRelayRegistrarForRun(rotated, readOwn);
  if (registrar === undefined) return undefined;
  return {
    id: rotated.id,
    registrar,
    preRotationSecret,
    rotatedSecret: rotated.sharedSecret,
  };
}

/** How {@link registerRotatedManagedRelayKey} runs: injectable for tests. */
export type RotatedManagedRelayKeyEnvironment = Omit<
  RelayRegistrationEnvironment,
  "signal" | "lastAttemptSignal"
> & {
  /** The run's cancel: ends the retries, never the request under way. */
  cancel?: AbortSignal;
};

/** What {@link registerRotatedManagedRelayKey} did. */
export type RotatedManagedRelayKeyResult =
  { kind: "registered" } | { kind: "failed"; message: string };

/** The most registrations a run makes after it rotated: one for the secret the
 * record holds, and one more for each re-invite that replaced it while the
 * last was made. */
const MAX_ROTATED_KEY_REGISTRATIONS = 3;

/**
 * After a run rotated the secret: read the record, and register the relay key
 * derived from the secret it holds -- the rotated one, or a re-invite's that
 * replaced it -- signed with the key derived from `preRotationSecret`, which
 * the registrar holds, or failing that with the rotated one's, which an
 * enrollment after the rotation registered. A confirmed registration drops
 * the pending registration where the record still holds the secret it
 * registered and names that registrar. Where the record holds another secret
 * by then, a re-invite replaced it while the registration was made, and the
 * re-invite's own registration was signed with a key the registrar no longer
 * held or did not yet hold; that secret's key is registered next, signed with
 * the key just confirmed. So the registrar ends holding the key of the secret
 * the record holds. A failed registration leaves the pending registration for
 * the next run's retry, and its message names the registrar and the next step.
 *
 * `env.cancel`, the run's cancel, ends the retries but reaches no request:
 * the attempt under way when it aborts, or the next one when it aborts
 * between attempts, runs to its timeout and is the last. The pre-rotation
 * secret is held nowhere else, so an abandoned registration would leave a
 * key only the relay-owner token can replace. Never throws: the run's own
 * outcome is not this registration's.
 */
export async function registerRotatedManagedRelayKey(
  params: RotatedManagedRelayKeyRegistration,
  env: RotatedManagedRelayKeyEnvironment = {},
  store: ManagedRelayRegistrationStore = defaultRegistrationStore,
): Promise<RotatedManagedRelayKeyResult> {
  const { id, registrar, preRotationSecret, rotatedSecret } = params;
  const { cancel, ...transport } = env;
  const couldNotRegister = (error: unknown): RotatedManagedRelayKeyResult => {
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
  };
  let signingSecrets: [string, ...Array<string>] = [
    preRotationSecret,
    rotatedSecret,
  ];
  let current: RunnableManagedExchangeRecord;
  try {
    current = await readRegistrationRecord(store, id);
  } catch (error) {
    return couldNotRegister(error);
  }
  for (let made = 0; made < MAX_ROTATED_KEY_REGISTRATIONS; made += 1) {
    const target = current;
    const registerSignedWith = (signingSecret: string) =>
      registerRelayKey(
        {
          registrar,
          signingSecret,
          registeredSecret: target.sharedSecret,
          maxAgeDays: target.tokenMaxAgeDays ?? null,
        },
        { ...transport, lastAttemptSignal: cancel },
      );
    let outcome: RelayRegistrationOutcome;
    try {
      const [first, ...rest] = signingSecrets;
      outcome = await registerSignedWith(first);
      for (const signingSecret of rest)
        if (outcome.kind === "refused")
          outcome = await registerSignedWith(signingSecret);
    } catch (error) {
      return couldNotRegister(error);
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
    const registered = current.sharedSecret;
    signingSecrets = [registered];
    try {
      current = await store.clearPending(id, registered, registrar);
    } catch (error) {
      log.warn(
        "the registrar confirmed the rotated relay key, and the record still " +
          "records it as unconfirmed, so the next run confirms it again:",
        error,
      );
      return { kind: "registered" };
    }
    if (current.sharedSecret === registered) break;
  }
  return { kind: "registered" };
}

/**
 * After a re-invite replaced the secret of an enrolled exchange: register the
 * relay key derived from the
 * fresh secret `written` holds, signed with the key derived from the secret
 * `replaced` held, which the registrar holds. A confirmed registration drops
 * the pending registration the re-invite write stored and returns the record
 * as stored; any other outcome is logged with the registrar's answer and
 * returns `written`, whose pending registration's reason names the
 * re-enrollment step. Never throws for the registration: the re-invite
 * stands either way.
 */
export async function registerReinvitedManagedRelayKey(
  replaced: RunnableManagedExchangeRecord,
  written: RunnableManagedExchangeRecord,
  env: RelayRegistrationEnvironment = {},
  store: ManagedRelayRegistrationStore = defaultRegistrationStore,
): Promise<RunnableManagedExchangeRecord> {
  const registrar = written.relayRegistrar;
  if (registrar === undefined) return written;
  let outcome: RelayRegistrationOutcome;
  try {
    outcome = await registerRelayKey(
      {
        registrar,
        signingSecret: replaced.sharedSecret,
        registeredSecret: written.sharedSecret,
        maxAgeDays: written.tokenMaxAgeDays ?? null,
      },
      env,
    );
  } catch (error) {
    log.error("registering the re-invited relay key failed:", error);
    return written;
  }
  if (outcome.kind !== "registered") {
    log.warn(
      sanitizeForDisplay(
        managedRelayRegistrationFailureMessage(registrar, outcome, "reinvite"),
        { maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH },
      ),
    );
    return written;
  }
  log.info(relayRegistrationNotice(registrar, outcome));
  try {
    return await store.clearPending(
      written.id,
      written.sharedSecret,
      registrar,
    );
  } catch (error) {
    log.warn(
      "the registrar confirmed the re-invited relay key, and the record " +
        "still records it as unconfirmed:",
      error,
    );
    return written;
  }
}

/** How {@link enrollManagedRelayRegistrar} ended. */
export type ManagedRelayEnrollmentResult =
  | { kind: "enrolled"; record: RunnableManagedExchangeRecord }
  | { kind: "failed"; outcome: RelayRegistrationFailure };

/** The platform boundaries an enrollment drives: injectable for tests. */
export interface ManagedRelayEnrollmentDeps {
  getRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  persistRegistrar: (
    id: string,
    registrar: RelayRegistrar,
    confirmedSecret: string,
  ) => Promise<RunnableManagedExchangeRecord>;
  env?: RelayRegistrationEnvironment;
}

const defaultEnrollmentDeps: ManagedRelayEnrollmentDeps = {
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
 * Takes no lock. The registrar is stored only where the record still holds
 * the secret whose key the registrar confirmed, so a run rotating the secret
 * while the registrar is asked refuses the enrollment; one that rotates after
 * it is stored leaves its registration pending and registers its rotated key
 * here ({@link persistManagedExchangeRotation} reads the registrar inside its
 * own write, and {@link rotatedManagedRelayKeyRegistration} takes it from
 * there).
 *
 * @throws {Error} if the record is gone or holds a configuration only.
 * @throws {ManagedRelayRegistrarStaleError} if the secret changed while the
 *   registrar was asked.
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
}

/** The platform boundaries stopping a registration drives: injectable for
 * tests. */
export interface ManagedRelayRegistrationStopDeps {
  removeRegistrar: (id: string) => Promise<RunnableManagedExchangeRecord>;
}

const defaultStopDeps: ManagedRelayRegistrationStopDeps = {
  removeRegistrar: (id) => persistManagedExchangeRelayRegistrar(id, undefined),
};

/**
 * Stop registering a stored exchange's relay key: drop the registrar it was
 * enrolled at and any pending registration. Takes no lock: a run in flight
 * registers its rotated key at the registrar its rotation write read, so a
 * rotation written after this has landed reads none, sets no pending
 * registration, and registers nowhere.
 *
 * @throws {Error} if the record is gone or holds a configuration only.
 */
export async function stopManagedRelayRegistration(
  id: string,
  deps: ManagedRelayRegistrationStopDeps = defaultStopDeps,
): Promise<RunnableManagedExchangeRecord> {
  return deps.removeRegistrar(id);
}

/** What a form taking a registrar's exchange id adds to a refusal of it. */
export const EXCHANGE_ID_PRIVACY =
  "The registrar's answers let anyone learn whether an id is enrolled, so " +
  "choose one that names neither party.";

type RelayRegistrarIssues = ReadonlyArray<{
  path: ReadonlyArray<PropertyKey>;
  message: string;
}>;

// The problems of one field of a registrar that failed its schema, in the
// schema's own words with its opening -- the command line's configuration
// key -- replaced by the field's name on the enrollment form.
function relayRegistrarFieldProblems(
  issues: RelayRegistrarIssues,
  field: "url" | "exchangeId",
  schemaPrefix: string,
  formName: string,
): Array<string> {
  return issues
    .filter((issue) => issue.path[0] === field)
    .map((issue) => {
      const rule = issue.message.startsWith(schemaPrefix)
        ? issue.message.slice(schemaPrefix.length)
        : issue.message;
      return `${formName} ${rule}.`;
    });
}

/**
 * The exchange-id problems of a registrar that failed its schema, in the
 * schema's own words with the field named as the enrollment form names it.
 */
export function relayRegistrarExchangeIdProblems(
  issues: RelayRegistrarIssues,
): Array<string> {
  return relayRegistrarFieldProblems(
    issues,
    "exchangeId",
    "relay_registrar.exchange_id ",
    "The exchange id",
  );
}

/**
 * The address problems of a registrar that failed its schema, in the schema's
 * own words with the field named as the enrollment form names it.
 */
export function relayRegistrarUrlProblems(
  issues: RelayRegistrarIssues,
): Array<string> {
  return relayRegistrarFieldProblems(
    issues,
    "url",
    "relay_registrar.url ",
    "The registrar address",
  );
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
