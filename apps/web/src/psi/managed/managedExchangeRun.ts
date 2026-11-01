/**
 * The platform half of the managed (recurring) exchange's run+rotate critical
 * section: the single-writer window ({@link ./managedExchangeLock.ts}) and
 * the strict-durability, field-scoped store write that the pure ordering
 * logic in {@link ./managedRunRotate.ts} drives. The runner passes its
 * input-guard, handshake, and data-exchange phases in; the input guard gates
 * the handshake (its result is the handshake's argument), and the
 * data-exchange phase is handed the durable persist, which core's terms
 * exchange awaits at this side's point in the store order.
 *
 * Four invariants this module owns (normative in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md; docs/notes/managed-exchange-design.md
 * records the rationale):
 *
 * - **Input guard before connection.** The input file is acquired and its
 *   columns validated against the standing terms before the handshake opens
 *   any connection; the guard's result is the handshake's argument. A benign
 *   input rejection records the bookkeeping kind its remedy calls for --
 *   `"input"` for a missing file or a gone permission, `"terms-shortfall"`
 *   for columns the standing terms cannot be run against -- and re-raises
 *   with no connection attempted, never through desync/attack framing.
 *
 * - **Single-writer exclusion.** The Web Locks lock keyed to the record's id
 *   ({@link ./managedExchangeLock.ts}) is held from "begin this run" through
 *   the run's success stamp, the payload exchange included, so one exchange of
 *   a record is in flight at a time in a browser profile: a second tab, a
 *   second attended Run, or a scheduled attempt is refused or queued for the
 *   whole run rather than for its rotation alone, and cannot double-rotate or
 *   exchange a second time against the partner. Besides runs, only the
 *   re-invite, relay enrollment and its stop, and an import replace take this
 *   lock, so none of them lands while an exchange is in flight. A run of
 *   this window is listed while it holds the lock ({@link ./managedWindowRuns.ts}),
 *   and a stop asked before its key exchange starts ends it.
 *
 * - **A run uses the record as stored when it takes the lock.** The input
 *   guard and the handshake are handed the record read inside the locked
 *   window, never the copy a caller loaded before requesting the lock, so the
 *   secret a run authenticates with and rotates is the one the store holds
 *   while no other write can change it. The rotation write still refuses
 *   where the stored secret is not that one
 *   ({@link ManagedExchangeSecretChangedError}): a safety check.
 *
 * - **Persist-before-success.** On the responder only, a rotation-in-flight
 *   marker is written durably before the key exchange starts. The next secret
 *   is written durably (a strict-durability transaction awaited to
 *   `complete`, which removes the marker) inside the terms exchange: the
 *   initiator's before it sends `proceed`, the responder's on reading it,
 *   both before any payload round. {@link storeRotatedSecret} is the write the
 *   terms exchange awaits; {@link persistManagedExchangeRotation} is the
 *   durable, field-scoped write beneath it. A responder run that ends at the
 *   terms exchange with neither side able to have stored removes the marker
 *   ({@link clearManagedExchangeRotationInFlight}). The initiator's rotation
 *   write keeps the secret its key exchange used as the previous secret, and
 *   a second strict-durability write removes it once the partner's first
 *   frame after the terms exchange shows it stored
 *   ({@link dropManagedExchangePreviousSecret}).
 */

import {
  InternalConsistencyError,
  getLogger,
  handshakeRoleForRendezvousRole,
} from "@alcove/core";

import {
  ManagedExchangeSecretChangedError,
  clearManagedExchangeRotationInFlight,
  dropManagedExchangePreviousSecret,
  getManagedExchange,
  markManagedExchangeRotationInFlight,
  persistManagedExchangeRotation,
  recordManagedExchangeLastRun,
} from "./managedExchangeStore";
import { ManagedInputError, managedInputLastRun } from "./managedInputGuard";
import {
  RotationPersistError,
  storeRotatedSecret,
  succeededRun,
} from "./managedRunRotate";
import {
  runRotationPrevious,
  runnableManagedExchangeOrRefuse,
} from "./managedExchangeRecord";
import { enterManagedWindowRun } from "./managedWindowRuns";
import { withManagedExchangeLock } from "./managedExchangeLock";

import type { AuthResult } from "@alcove/core";

import type {
  ManagedExchangeLastRun,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { ManagedExchangeLockOptions } from "./managedExchangeLock";
import type { RotationWriteBack } from "./managedRunRotate";

const log = getLogger("managedExchangeRun");

/** Which of its secrets each side's key exchange used (`AuthResult`'s
 * `secretUsed`). */
export type ManagedRunSecretUsed = AuthResult["secretUsed"];

/** A key exchange both sides completed under their current secret. */
const BOTH_CURRENT: ManagedRunSecretUsed = {
  local: "current",
  partner: "current",
};

/**
 * Raised when the record a run reads inside the run+rotate lock is gone,
 * does not validate, or holds a configuration only. Raised before the input
 * is read and before any connection, so it rotates nothing; the runner
 * records it under the `custody-unreadable` kind rather than the retryable
 * `transport` tier, since the same stored record refuses identically at the
 * next run.
 */
export class ManagedExchangeNotRunnableError extends Error {
  constructor(id: string, cause: unknown) {
    super(`managed exchange ${id} has no stored copy this device can run`, {
      cause,
    });
    this.name = "ManagedExchangeNotRunnableError";
  }
}

/** The input, handshake, and data-exchange phases the runner supplies to
 * {@link runManagedExchange}. The persist and lock are this module's; the runner
 * cannot reach the handshake before the input is acquired and validated, and
 * stores the next secret only through the persist this module hands it. */
interface ManagedExchangeRunPhases<TInput, THandshake, TExchange> {
  /** The record whose secret this run rotates. Its `id` keys the lock, the
   * read of the record the run uses, and the field-scoped store writes. */
  record: { id: string };
  /**
   * The instant this run began, UTC milliseconds -- before the lock was
   * requested, so it precedes every act the run makes. Passed to every
   * bookkeeping write so a failure outcome cannot overwrite a success another
   * context stamped after that instant (see
   * {@link ./managedExchangeStore.ts}, `recordManagedExchangeLastRun`). The
   * caller supplies it rather than this module reading the clock, so the
   * pre-connection checks it makes first are inside the run this instant
   * opens.
   */
  runStartedAtMs: number;
  /**
   * Acquire and validate the input file before any connection: read it
   * from the working folder (or take the re-selected file), then reject a
   * missing file, a gone permission, or a column shape the standing terms
   * cannot satisfy as a benign pre-run failure (`acquireValidatedManagedInput`
   * in {@link ./managedInputHandle.ts} raises a {@link ManagedInputError}).
   * Its result is handed to {@link handshake}, so the connection it opens is
   * unreachable until the guard passes. Receives the record as read inside the
   * lock, whose terms the input is validated against.
   */
  acquireInput: (current: RunnableManagedExchangeRecord) => Promise<TInput>;
  /** Run the authenticated handshake and yield whatever the data exchange
   * needs, the next secret's inputs among them. Runs inside the lock, after
   * the input guard passed; receives the acquired input, the start of the key
   * exchange it must await after the partner connects and before the key
   * exchange starts, whatever its role, and the record as read inside the
   * lock, whose secret it authenticates with. The start refuses a run a stop
   * came first for, moves it past every later stop, and on a responder run
   * writes the durable rotation-in-flight marker. */
  handshake: (
    input: TInput,
    beginKeyExchange: () => Promise<void>,
    current: RunnableManagedExchangeRecord,
  ) => Promise<THandshake>;
  /** Begin and complete the data exchange. Receives the value the handshake
   * produced; the durable rotation write, which the data exchange hands
   * core's terms exchange as its store with the secrets the key exchange
   * used (both sides' current where omitted), and which resolves only once
   * the next secret is committed; the callback it hands core's terms
   * exchange as `TermsRotation.partnerMayHoldNextSecret`, which decides
   * whether a failed responder run removes its rotation-in-flight marker; and
   * the durable removal of the previous secret it hands core as
   * `TermsRotation.partnerStored` on the initiator. */
  dataExchange: (
    handshake: THandshake,
    persistNextSecret: (
      nextSecret: string,
      secretUsed?: ManagedRunSecretUsed,
    ) => Promise<void>,
    partnerMayHoldNextSecret: (mayHold: boolean) => void,
    partnerStored: () => Promise<void>,
  ) => Promise<TExchange>;
  /** Invoked once, synchronously, at the instant the data exchange begins
   * (immediately before {@link dataExchange}, with the lock still held).
   * Marks the phase boundary a failure classifier
   * reads to tell a pre-data-exchange failure from one that could postdate
   * the first peer-visible payload: a `security`-kind error before this
   * fires is the handshake failing closed, one after it can arise on a
   * tampered frame mid-exchange. */
  onDataExchangeStart?: () => void;
  /** Lock acquisition discipline (queue vs. fail-fast). */
  lock?: ManagedExchangeLockOptions;
  /** The run's own controller. Given, the run is listed in this window's runs
   * while it holds the lock ({@link enterManagedWindowRun}), and the start of
   * the key exchange refuses with `ManagedRunStoppedError` where a stop came
   * first. */
  stop?: AbortController;
  /** The clock, injected so a test can pin the rotation and bookkeeping stamps.
   * Defaults to `Date.now`. */
  now?: () => number;
}

/** The outcome of a completed managed exchange run: the data-exchange result and
 * the `succeeded` `lastRun` this run stamped. The store's write rules decide
 * which of two racing runs' tails it keeps ({@link ./managedExchangeStore.ts},
 * `recordManagedExchangeLastRun`), so this is this run's outcome, not
 * necessarily the stored one. */
export interface ManagedExchangeRunResult<TExchange> {
  /** The data-exchange phase's return value. */
  exchange: TExchange;
  /** The `succeeded` `lastRun` this run stamped. */
  lastRun: ManagedExchangeLastRun;
  /** Whether the store took the success stamp. `false` only when the stamp
   * write threw: the exchange completed and its results stand, but the stored
   * record still holds whatever run it held before this one. A stamp the store
   * skipped as stale counts as taken. */
  lastRunSaved: boolean;
  /** A short plain-words reason the stamp write threw (full storage, aborted
   * write, or an unknown cause); set exactly when `lastRunSaved` is `false`. */
  lastRunNotSavedReason?: string;
  /** The secret this run's rotation stored. A write made on the run's behalf
   * after it releases the lock, such as a scheduled run's backup, is made only
   * while the stored record still holds it. */
  rotatedSecret: string;
}

/**
 * Run a managed exchange's run+rotate critical section (the module header
 * states the four invariants this enforces). The single-writer lock covers
 * "begin this run" through the success stamp, so the payload exchange runs
 * inside it; no payload round begins before the persist resolves, since the
 * terms exchange awaits it.
 *
 * The read of the record the run uses, then the input guard, run first inside
 * the lock and refuse before any connection is opened, the guard recording the
 * benign input `lastRun`. A persist failure records a
 * `storage`-kind `lastRun`; a handshake or data-exchange failure propagates
 * unchanged for the runner to classify. Every bookkeeping write states
 * `runStartedAtMs`, so the store's write rules
 * ({@link recordManagedExchangeLastRun}) hold a failure off a success another
 * context stamped after this run began. The success stamp is best-effort like
 * the failure stamps: the rotated secret is already durable and the exchange
 * has completed, so a failed stamp resolves the run with `lastRunSaved: false`
 * rather than dropping its results.
 *
 * @throws {ManagedExchangeLockUnavailableError} if `lock.ifAvailable` is set
 *   and a run is already in progress on this device.
 * @throws {ManagedExchangeNotRunnableError} if the record is gone, does not
 *   validate, or holds a configuration only when the lock is granted; no
 *   input was read and no connection made.
 * @throws {ManagedInputError} if the input guard rejects (a missing file, a
 *   gone permission, or an unsatisfiable column shape); the benign `lastRun`
 *   is recorded best-effort first, and no connection was made.
 * @throws {RotationPersistError} if the rotation write fails; the `storage`
 *   `lastRun` is recorded best-effort first -- a bookkeeping-write failure
 *   never replaces this error.
 * @throws {ManagedExchangeSecretChangedError} if the rotation write's safety
 *   check finds the stored secret replaced; nothing is written or recorded.
 * @throws {ManagedRunStoppedError} from the start of the key exchange, where a
 *   stop through `stop` came first; nothing is written.
 */
export async function runManagedExchange<TInput, THandshake, TExchange>(
  phases: ManagedExchangeRunPhases<TInput, THandshake, TExchange>,
): Promise<ManagedExchangeRunResult<TExchange>> {
  const { record, runStartedAtMs } = phases;
  const now = phases.now ?? Date.now;

  return await withManagedExchangeLock(
    record.id,
    async () => {
      const listed =
        phases.stop === undefined
          ? undefined
          : enterManagedWindowRun(record.id, phases.stop);
      try {
        return await runLocked(listed?.enterKeyExchange);
      } finally {
        listed?.release();
      }
    },
    phases.lock,
  );

  async function runLocked(
    enterKeyExchange: (() => void) | undefined,
  ): Promise<ManagedExchangeRunResult<TExchange>> {
    const current = await readRecordToRun(record.id);
    // The input guard runs before the handshake opens any connection. A benign
    // input rejection records its classified bookkeeping inside the lock (this
    // run's record until the lock releases), then re-raises with no handshake
    // attempted.
    let input: TInput;
    try {
      input = await phases.acquireInput(current);
    } catch (error) {
      if (error instanceof ManagedInputError) {
        // Best-effort, for the same reason the storage tier is below: a failed
        // bookkeeping write must not replace the ManagedInputError the runner
        // classifies on.
        try {
          await recordLastRun(
            record.id,
            managedInputLastRun(error.rejection, now()),
            runStartedAtMs,
          );
        } catch {
          // Swallowed: the ManagedInputError still reaches the runner on the rethrow.
        }
      }
      throw error;
    }
    // The initiator stores the next secret first, so only a responder can be
    // left behind by a run cut partway.
    const role = handshakeRoleForRendezvousRole(current.side);
    const marksRotationInFlight = role === "responder";
    const handshake = await phases.handshake(
      input,
      async () => {
        enterKeyExchange?.();
        if (marksRotationInFlight)
          await markManagedExchangeRotationInFlight(
            record.id,
            new Date(now()).toISOString(),
          );
      },
      current,
    );
    let rotatedSecret: string | undefined;
    let healedCutRotation = false;
    // How far the terms exchange got in the store order, which decides
    // whether a failed responder run leaves its marker.
    const storeOrder = { partnerMayHoldNextSecret: false, storeBegan: false };
    const persistNextSecret = async (
      nextSecret: string,
      secretUsed: ManagedRunSecretUsed = BOTH_CURRENT,
    ): Promise<void> => {
      storeOrder.storeBegan = true;
      const previous = runRotationPrevious(current, role, secretUsed.local);
      rotatedSecret = await storeRotatedSecret(
        {
          persist: (writeBack: RotationWriteBack) =>
            persistRotation(
              record.id,
              current.sharedSecret,
              writeBack,
              previous,
              current.relayRegistrar !== undefined
                ? new Date(now()).toISOString()
                : undefined,
            ),
          tokenMaxAgeDays: current.tokenMaxAgeDays,
          now,
        },
        nextSecret,
      );
      healedCutRotation =
        secretUsed.local === "previous" || secretUsed.partner === "previous";
    };
    // On the initiator, the partner's first frame after the terms exchange
    // shows it stored the next secret, so the previous secret is removed.
    const partnerStored = async (): Promise<void> => {
      if (role === "initiator" && rotatedSecret !== undefined)
        await dropManagedExchangePreviousSecret(record.id, rotatedSecret);
    };
    // The peer-visible data exchange and the success stamp run inside the
    // single-writer window, so no second context can exchange against the
    // partner for this record while this one is. The boundary is marked
    // before the first peer-visible payload, so a classifier can tell a
    // handshake failure from one that could postdate it.
    phases.onDataExchangeStart?.();
    // A persist failure is the one failure this section records itself: the
    // `storage` bookkeeping steers the next handshake failure to the benign
    // tier. Every other failure is the runner's to classify and record.
    const exchange = await phases
      .dataExchange(
        handshake,
        persistNextSecret,
        (mayHold) => {
          storeOrder.partnerMayHoldNextSecret = mayHold;
        },
        partnerStored,
      )
      .catch(async (error: unknown) => {
        // The safety check refused the rotation: the record is the replacing
        // write's, so this run stamps nothing on it.
        if (
          error instanceof RotationPersistError &&
          error.cause instanceof ManagedExchangeSecretChangedError
        )
          throw error.cause;
        if (error instanceof RotationPersistError) {
          // Best-effort: the storage subsystem that just failed the rotation
          // persist may fail this write too, and a second storage rejection
          // must never replace the RotationPersistError -- the runner's
          // instanceof classification, and the storage lastRun the error
          // itself holds, depend on the original propagating.
          try {
            await recordLastRun(record.id, error.lastRun, runStartedAtMs);
          } catch {
            // Swallowed: error.lastRun still reaches the runner on the rethrow.
          }
        }
        // A responder whose key exchange completed and whose run ended with
        // neither side able to have stored -- before it sent its value, or on
        // the initiator's abort in place of `proceed` -- has nothing for the
        // next run to report.
        if (
          marksRotationInFlight &&
          !storeOrder.partnerMayHoldNextSecret &&
          !storeOrder.storeBegan
        )
          await clearRotationInFlight(record.id, current.sharedSecret);
        throw error;
      });
    // Every authenticated run that completes stored its next secret.
    if (rotatedSecret === undefined)
      throw new InternalConsistencyError(
        `managed exchange ${record.id}: the exchange completed without storing a next secret`,
      );
    const lastRun = succeededRun(now(), healedCutRotation);
    try {
      await recordLastRun(record.id, lastRun, runStartedAtMs);
    } catch (error) {
      log.warn(
        `managed exchange ${record.id}: the success stamp was not saved (${describeStoreError(error)})`,
      );
      return {
        exchange,
        lastRun,
        lastRunSaved: false,
        lastRunNotSavedReason: storeErrorReason(error),
        rotatedSecret,
      };
    }
    return { exchange, lastRun, lastRunSaved: true, rotatedSecret };
  }
}

/**
 * Read the record this run uses, inside the lock and before the input guard.
 *
 * @throws {ManagedExchangeNotRunnableError} if no record with `id` exists,
 *   the stored value is not a valid record, or it holds a configuration only.
 */
async function readRecordToRun(
  id: string,
): Promise<RunnableManagedExchangeRecord> {
  try {
    const stored = await getManagedExchange(id);
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    return runnableManagedExchangeOrRefuse(stored);
  } catch (error) {
    throw new ManagedExchangeNotRunnableError(id, error);
  }
}

/** The durable, field-scoped rotation write the ordering awaits before the data
 * exchange, over the secret the run read. Split out so the write target is one
 * call site. */
async function persistRotation(
  id: string,
  expectedSharedSecret: string,
  writeBack: RotationWriteBack,
  previous: ReturnType<typeof runRotationPrevious>,
  relayRegistrationPendingSince: string | undefined,
): Promise<void> {
  await persistManagedExchangeRotation(id, expectedSharedSecret, {
    sharedSecret: writeBack.sharedSecret,
    expires: writeBack.expires,
    ...previous,
    ...(relayRegistrationPendingSince !== undefined && {
      relayRegistrationPendingSince,
    }),
  });
}

/** Remove a responder run's rotation-in-flight marker. Best-effort: a failed
 * write is logged, and the run's own failure is what propagates. */
async function clearRotationInFlight(
  id: string,
  sharedSecret: string,
): Promise<void> {
  try {
    await clearManagedExchangeRotationInFlight(id, sharedSecret);
  } catch (error) {
    log.warn(
      `managed exchange ${id}: the record still marks this key exchange as in flight (${describeStoreError(error)})`,
    );
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

function describeStoreError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : errorName(error);
}

function storeErrorReason(error: unknown): string {
  switch (errorName(error)) {
    case "QuotaExceededError":
      return "this browser's storage is full";
    case "AbortError":
      return "the browser aborted the storage write";
    default:
      return "the cause is unknown";
  }
}

async function recordLastRun(
  id: string,
  lastRun: ManagedExchangeLastRun,
  runStartedAtMs: number,
): Promise<void> {
  await recordManagedExchangeLastRun(id, lastRun, runStartedAtMs);
}
