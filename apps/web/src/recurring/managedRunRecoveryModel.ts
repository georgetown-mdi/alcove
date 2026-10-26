import { standingCompromiseResponse } from "@psi/managed/managedExchangeRecord";

import { managedRunReinvites } from "./managedRunLaunchModel";

import type { LiveManagedRunFailure } from "./managedRunSurfaceModel";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRunFailure } from "./managedRunLaunchModel";
import type { ManagedStandingConditionView } from "./managedStandingConditionModel";

/**
 * The managed run surface's failure recovery: the confirmation gate a live failure
 * asks, the compromise response the operator gave, the standing condition's
 * clearance, and the re-invite mint. No rendering and no I/O -- the surface makes
 * each store write and reports its outcome here as an action.
 *
 * The confirmation grant and the compromise answer name the failure they were
 * given for by its run number, so a later failure the operator has answered
 * nothing about still gets its own gate.
 */

/** Which control asked for the re-invite: the failure-path recovery near the top
 * of the page, or the detail section far below it. */
export type ManagedReinviteSite = "recovery" | "detail";

/** Why a mint failed. `saved-server-refused`: this browser's coordination
 * server setting cannot be read, so the re-invite names the server the
 * exchange saved, and that address fails the validation a run applies.
 * `secret-changed`: the re-invite write's safety check found the secret it
 * was composed over replaced. */
export type ManagedReinviteFailureCause =
  "saved-server-refused" | "secret-changed" | "other";

/** The mint's last request. A mint a run's lock refused goes back to `idle`:
 * the run-in-flight reading states why. */
export type ManagedReinviteRequest =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "failed"; cause: ManagedReinviteFailureCause };

/** The alert a failed mint shows beside the control that asked for it. */
export interface ManagedReinviteFailureAlert {
  title: string;
  message: string;
}

/** A failed mint's alert, by its cause. */
export const MANAGED_REINVITE_FAILURE_ALERTS: Readonly<
  Record<ManagedReinviteFailureCause, ManagedReinviteFailureAlert>
> = {
  "saved-server-refused": {
    title: "Could not create a fresh invitation",
    message:
      "Relay settings cannot read your coordination server, and the " +
      "coordination server address this exchange saved cannot be used. Set " +
      "your coordination server again or clear it in relay settings first, " +
      "then try again.",
  },
  "secret-changed": {
    title: "Could not create a fresh invitation",
    message:
      "This exchange's shared secret changed while the invitation was being " +
      "made, so nothing was saved and no invitation was made. Try again.",
  },
  other: {
    title: "Could not create a fresh invitation",
    message: "Nothing changed here; try again.",
  },
};

/** The write of the operator's compromise answer onto the record. */
export type ManagedCompromiseWrite =
  { kind: "idle" } | { kind: "writing" } | { kind: "failed" };

/** The standing condition's clear request. A clear taken from under a compromise
 * response grants the confirmation for the failure that response was answered at,
 * read when the clear starts. */
export type ManagedStandingClear =
  | { kind: "idle" }
  | {
      kind: "clearing";
      grantsConfirmation: { runNumber: number | undefined } | undefined;
    }
  | { kind: "failed" };

/** The failure recovery's whole state on the surface. */
export interface ManagedRecoveryState {
  /** The run number of the failure the operator confirmed as a real partner-side
   * failure at its gate. */
  confirmationGrantedFor: number | undefined;
  compromise: {
    write: ManagedCompromiseWrite;
    /** The store refused this page's mint over an answer the page had not read
     * (another tab's), so the page shows the response as if it had read it. */
    withheldByStore: boolean;
    /** The run number of the failure whose gate the answer was last given at on
     * this visit; an answer at the standing condition's gate leaves it unchanged. */
    answeredFor: number | undefined;
  };
  /** Kept apart from the live failure's gate: both can show at once, and clearing
   * one must not move the other. */
  standing: {
    /** Cleared on this visit; the section keeps its place after the write. */
    settled: boolean;
    clear: ManagedStandingClear;
  };
  reinvite: {
    /** The site of the in-flight (or last) mint. */
    site: ManagedReinviteSite | undefined;
    request: ManagedReinviteRequest;
    /** The fresh invitation the operator forwards, once composed and its secret
     * persisted onto the record. */
    composed: ManagedReinvite | undefined;
  };
}

/** No recovery taken this visit. */
export const MANAGED_RECOVERY_INITIAL: ManagedRecoveryState = {
  confirmationGrantedFor: undefined,
  compromise: {
    write: { kind: "idle" },
    withheldByStore: false,
    answeredFor: undefined,
  },
  standing: { settled: false, clear: { kind: "idle" } },
  reinvite: { site: undefined, request: { kind: "idle" }, composed: undefined },
};

/** Where the operator gave the compromise answer: a live failure's gate (by its
 * run number) or the standing condition's. */
export type ManagedCompromiseGate =
  { kind: "failure"; runNumber: number | undefined } | { kind: "standing" };

/** The recovery's events. `run-started` and `reinvite-composed` also move the run
 * state; the composed surface reducer routes them to both. */
export type ManagedRecoveryAction =
  | { type: "run-started" }
  | { type: "confirmation-granted"; runNumber: number | undefined }
  | { type: "compromise-answer-started"; gate: ManagedCompromiseGate }
  | { type: "compromise-answer-written" }
  | { type: "compromise-answer-failed" }
  | { type: "standing-clear-started"; pastResponse: boolean }
  | { type: "standing-cleared" }
  | { type: "standing-clear-failed" }
  | { type: "reinvite-started"; site: ManagedReinviteSite }
  | { type: "reinvite-composed"; reinvite: ManagedReinvite }
  /** The recheck before the mint, or the lock the mint takes, found a run; the
   * in-flight reading states it. */
  | { type: "reinvite-held-by-run" }
  /** The store refused the mint over a compromise answer this page had not read. */
  | { type: "reinvite-withheld" }
  | { type: "reinvite-failed"; cause: ManagedReinviteFailureCause };

/** The recovery's reducer. A run start drops the last run's grant, its composed
 * re-invite, a failed mint and an unsaved compromise answer; it keeps the store's
 * withhold, the failure an answer was given at, and the standing condition's
 * clearance. */
export function managedRecoveryReducer(
  state: ManagedRecoveryState,
  action: ManagedRecoveryAction,
): ManagedRecoveryState {
  switch (action.type) {
    case "run-started":
      return {
        ...state,
        confirmationGrantedFor: undefined,
        compromise:
          state.compromise.write.kind === "failed"
            ? { ...state.compromise, write: { kind: "idle" } }
            : state.compromise,
        reinvite: {
          ...state.reinvite,
          composed: undefined,
          request:
            state.reinvite.request.kind === "failed"
              ? { kind: "idle" }
              : state.reinvite.request,
        },
      };
    case "confirmation-granted":
      return { ...state, confirmationGrantedFor: action.runNumber };
    case "compromise-answer-started":
      return {
        ...state,
        compromise: {
          ...state.compromise,
          write: { kind: "writing" },
          answeredFor:
            action.gate.kind === "failure"
              ? action.gate.runNumber
              : state.compromise.answeredFor,
        },
      };
    case "compromise-answer-written":
      return {
        ...state,
        compromise: { ...state.compromise, write: { kind: "idle" } },
      };
    case "compromise-answer-failed":
      return {
        ...state,
        compromise: { ...state.compromise, write: { kind: "failed" } },
      };
    case "standing-clear-started":
      return {
        ...state,
        standing: {
          ...state.standing,
          clear: {
            kind: "clearing",
            grantsConfirmation: action.pastResponse
              ? { runNumber: state.compromise.answeredFor }
              : undefined,
          },
        },
      };
    case "standing-cleared": {
      const { clear } = state.standing;
      const grant =
        clear.kind === "clearing" ? clear.grantsConfirmation : undefined;
      // The clear write drops the answer with the condition, so this page's own
      // record of an unsaved or store-withheld answer goes with it.
      return {
        ...state,
        confirmationGrantedFor:
          grant === undefined ? state.confirmationGrantedFor : grant.runNumber,
        compromise: {
          ...state.compromise,
          write:
            state.compromise.write.kind === "failed"
              ? { kind: "idle" }
              : state.compromise.write,
          withheldByStore: false,
        },
        standing: { settled: true, clear: { kind: "idle" } },
      };
    }
    case "standing-clear-failed":
      return {
        ...state,
        standing: { ...state.standing, clear: { kind: "failed" } },
      };
    case "reinvite-started":
      return {
        ...state,
        reinvite: {
          ...state.reinvite,
          site: action.site,
          request: { kind: "minting" },
        },
      };
    case "reinvite-composed":
      return {
        ...state,
        reinvite: {
          ...state.reinvite,
          request: { kind: "idle" },
          composed: action.reinvite,
        },
      };
    case "reinvite-held-by-run":
      return {
        ...state,
        reinvite: { ...state.reinvite, request: { kind: "idle" } },
      };
    case "reinvite-withheld":
      return {
        ...state,
        compromise: { ...state.compromise, withheldByStore: true },
        reinvite: { ...state.reinvite, request: { kind: "idle" } },
      };
    case "reinvite-failed":
      return {
        ...state,
        reinvite: {
          ...state.reinvite,
          request: { kind: "failed", cause: action.cause },
        },
      };
  }
}

/** Whether the operator confirmed the live failure at its gate. A grant given
 * for an earlier failure does not carry to a later one. */
export function managedConfirmationGranted(
  recovery: ManagedRecoveryState,
  liveFailure: LiveManagedRunFailure | undefined,
): boolean {
  return (
    liveFailure !== undefined &&
    recovery.confirmationGrantedFor === liveFailure.runNumber
  );
}

/**
 * Whether a compromise response withholds every mint and reply on this page: one
 * the record holds, one being written (both outcomes keep the withhold, so no
 * control is live across the write), one this device refused to save, or one the
 * store refused a mint over. An unsaved answer stays until the page is left or a
 * run starts, which is the side to fail to.
 */
export function managedCompromiseResponseActive(
  recovery: ManagedRecoveryState,
  record: ManagedExchangeRecord | undefined,
): boolean {
  return (
    recovery.compromise.write.kind !== "idle" ||
    recovery.compromise.withheldByStore ||
    (record !== undefined && standingCompromiseResponse(record) !== undefined)
  );
}

/** Whether a mint is in flight. */
export function managedReinviteInFlight(
  recovery: ManagedRecoveryState,
): boolean {
  return recovery.reinvite.request.kind === "minting";
}

/** The mint's failed alert at `site`, or `undefined` where none shows: it shows
 * only at the site that asked for it, so the two sites on screen do not both
 * show it. */
export function managedReinviteFailureAt(
  recovery: ManagedRecoveryState,
  site: ManagedReinviteSite,
): ManagedReinviteFailureAlert | undefined {
  const { request } = recovery.reinvite;
  return request.kind === "failed" && recovery.reinvite.site === site
    ? MANAGED_REINVITE_FAILURE_ALERTS[request.cause]
    : undefined;
}

/**
 * Whether the standing condition's section shows. A composed re-invite replaces
 * it. A live failure on the tier the condition resolves to already shows that
 * tier's recovery, so the section steps aside for it; once cleared on this visit
 * it keeps its place.
 */
export function managedStandingConditionShown(
  recovery: ManagedRecoveryState,
  view: ManagedStandingConditionView | undefined,
  failure: ManagedRunFailure | undefined,
): boolean {
  return (
    recovery.reinvite.composed === undefined &&
    (recovery.standing.settled ||
      (view !== undefined && view.tier !== failure?.kind))
  );
}

/** Whether the live failure offers the re-invite: directly, or through the
 * confirmation gate whose outcomes decide whether one happens. The standing
 * section then adds no mint control of its own. */
export function managedFailureHoldsReinvite(
  failure: ManagedRunFailure | undefined,
): boolean {
  return (
    failure !== undefined &&
    (managedRunReinvites(failure) || failure.recovery === "confirm")
  );
}
