/**
 * The note a managed run states when its key exchange completed under a
 * previous secret, healing a run cut between the two saves of a rotation
 * (docs/notes/rotation-hardening.md, "What the operator is told"). Both sides
 * state it, so that a heal cannot hide a copy of the exchange running
 * elsewhere.
 */

import type { ManagedExchangeSide } from "./managedExchangeRecord";
import type { ManagedRunSecretUsed } from "./managedExchangeRun";

/** The step for a second copy, on the side that kept the previous secret:
 * over WebRTC the acceptor, which cannot re-invite. */
const AHEAD_SECOND_COPY_STEP =
  "If they did, ask your partner to re-invite you, so that only one copy runs.";

/** The step for a second copy, on the side whose partner kept it: over
 * WebRTC the inviter. */
const BEHIND_SECOND_COPY_STEP =
  "If it does, re-invite your partner, so that only one copy runs.";

/** The live note of the side that kept the previous secret, the one ahead. */
const AHEAD_RUN_NOTE =
  "The last run stopped before your partner saved the new secret, so this " +
  "run used the secret from before that run, and both sides have saved a " +
  "new secret. If neither of you had a run stop partway, ask your partner " +
  `whether they ran this exchange from another copy. ${AHEAD_SECOND_COPY_STEP}`;

/** The live note of the side whose partner kept it, the one behind. */
const BEHIND_RUN_NOTE =
  "Your partner still had the secret from before your last run stopped, so " +
  "this run used it, and both sides have saved a new secret. If no run of " +
  "yours stopped partway, check whether this exchange also runs from " +
  `another copy. ${BEHIND_SECOND_COPY_STEP}`;

/**
 * The note a run states once both sides saved the next secret: the ahead
 * side's where this side used its previous secret, the behind side's where
 * the partner used its own, and `undefined` for a key exchange both completed
 * under the current secret.
 */
export function managedHealNote(
  secretUsed: ManagedRunSecretUsed,
): string | undefined {
  if (secretUsed.local === "previous") return AHEAD_RUN_NOTE;
  if (secretUsed.partner === "previous") return BEHIND_RUN_NOTE;
  return undefined;
}

/**
 * The note the run history states beside a completed run marked
 * `healedCutRotation`, chosen by this record's side: over WebRTC only the
 * acceptor keeps a previous secret, so the acceptor of a heal run was the side
 * ahead and the inviter the side behind.
 */
export function recordedHealNote(
  side: ManagedExchangeSide | undefined,
): string {
  return side === "acceptor"
    ? "The run before this one stopped before your partner saved the new " +
        "secret, so this run used the secret from before that run, and both " +
        "sides saved a new secret. If neither of you had a run stop partway, " +
        "ask your partner whether they ran this exchange from another copy. " +
        AHEAD_SECOND_COPY_STEP
    : "Your partner still had the secret from before the run before this " +
        "one stopped, so this run used it, and both sides saved a new " +
        "secret. If no run of yours stopped partway, check whether this " +
        `exchange also runs from another copy. ${BEHIND_SECOND_COPY_STEP}`;
}
