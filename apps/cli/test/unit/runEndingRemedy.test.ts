// Each run-ending path of the CLI states its step through the remedy module:
// the command boundary and the terminal event for a catalog cause, the failure
// site and the signal handler for what the run left its key file holding, and
// the failure site for the lines it logs beside a failure.

import { describe, expect, test } from "vitest";

import {
  failureCauseFromUntrusted,
  failureCauseSentence,
  markFailureCause,
  statesItsOwnNextStep,
  type FailureCause,
} from "@alcove/core";
import { REPRESENTATIVE_FAILURE_CAUSES } from "@alcove/core/testing";

import { buildErrorEvent } from "../../src/eventStream";
import {
  bothSweptStep,
  keyFileNotSavedRemedy,
  keyFileSavedConfigNotWrittenRemedy,
  keyFileStateStep,
  keyFileWriteFailure,
  missingReceiptWarning,
  remedyForCause,
  type RotationStanding,
  type RunEnding,
  type SignedRunFacts,
} from "../../src/failureRemedy";
import { renderFailureForOperator } from "../../src/util/exit";

const causeError = (cause: FailureCause): Error =>
  markFailureCause(new Error(failureCauseSentence(cause)), cause);

describe("a representative cause of each kind", () => {
  test.each(Object.values(REPRESENTATIVE_FAILURE_CAUSES))(
    "$kind states core's sentence, then the CLI's remedy, at the command boundary and on the terminal event",
    (cause) => {
      const expected = `${failureCauseSentence(cause)}\n${remedyForCause(cause)}`;
      expect(renderFailureForOperator(causeError(cause))).toBe(expected);
      const event = buildErrorEvent(causeError(cause), "run");
      expect(event.message).toBe(expected);
      expect(event.recoveryHint).toBe(true);
      // The cause as a supervisor reads it off the stream.
      expect(
        failureCauseFromUntrusted(JSON.parse(JSON.stringify(event.cause))),
      ).toEqual(cause);
    },
  );
});

const FAILED: RunEnding = { kind: "failed", errorStatesItsStep: false };
const FAILED_STEP_STATED: RunEnding = {
  kind: "failed",
  errorStatesItsStep: true,
};
const INTERRUPTED: RunEnding = { kind: "interrupted" };

const step = (
  standing: RotationStanding,
  ending: RunEnding,
  onlineSetup = false,
): string | undefined => keyFileStateStep({ standing, onlineSetup }, ending);

describe("the key-file state step", () => {
  test("an interrupt states the failure site's wording for each standing", () => {
    expect(step("partner-may-lag", INTERRUPTED)).toBe(
      "The shared secret was already rotated and saved before the exchange " +
        "was interrupted. Retry the exchange with the same key file; if " +
        "authentication fails on retry, ask your partner for a new invitation.",
    );
    expect(step("both-stored", INTERRUPTED)).toBe(
      "The shared secret was already rotated and saved before the exchange " +
        "was interrupted. Your partner saved it too, so retry the exchange " +
        "with the same key file.",
    );
    expect(step("partner-may-lead", INTERRUPTED)).toBe(
      "This side had not saved the next shared secret when the exchange was " +
        "interrupted, and your partner may already have saved it. Retry the " +
        "exchange with the existing key file; if authentication fails on " +
        "retry, ask your partner for a new invitation.",
    );
    expect(step("unchanged", INTERRUPTED)).toBeUndefined();
  });

  test.each(["partner-may-lead", "partner-may-lag", "both-stored"] as const)(
    "%s reads the same on a failure and an interrupt but for when it happened",
    (standing) => {
      const failed = step(standing, FAILED)!;
      expect(failed).toContain("this error");
      expect(step(standing, INTERRUPTED)).toBe(
        failed
          .replace("this error occurred", "the exchange was interrupted")
          .replace("this error", "the exchange was interrupted"),
      );
    },
  );

  test("a failure that states its own step gets the secret's state without a retry", () => {
    expect(step("partner-may-lead", FAILED_STEP_STATED)).toBe(
      "This side had not saved the next shared secret when this error " +
        "occurred, and your partner may already have saved it, so the next " +
        "run may need a new invitation from your partner.",
    );
    expect(step("partner-may-lag", FAILED_STEP_STATED)).toBeUndefined();
    expect(step("both-stored", FAILED_STEP_STATED)).toBeUndefined();
  });

  test("an authentication failure on a run that rotated nobody names a new invitation", () => {
    const line = step("unchanged", {
      ...FAILED_STEP_STATED,
      authenticationFailed: true,
    });
    expect(line).toMatch(
      /^Authentication failed, and a retry with this key file fails the same way\. /,
    );
    expect(line).toContain("new invitation");
    expect(step("unchanged", FAILED)).toBeUndefined();
  });

  test("an online setup behind its partner states the unsaved key file on either ending", () => {
    expect(step("partner-may-lead", INTERRUPTED, true)).toBe(
      keyFileNotSavedRemedy(INTERRUPTED),
    );
    expect(step("partner-may-lead", FAILED_STEP_STATED, true)).toBe(
      keyFileNotSavedRemedy(FAILED_STEP_STATED),
    );
  });

  test("a key file saved before its configuration takes the place of the rotation line", () => {
    const setup = {
      keyPath: "/k/.alcove.key",
      configPath: "/k/alcove.yaml",
      kept: false,
      configWriteFailed: false,
    };
    expect(
      keyFileStateStep(
        {
          standing: "partner-may-lag",
          onlineSetup: true,
          keyFileSavedConfigNotWritten: setup,
        },
        INTERRUPTED,
      ),
    ).toBe(keyFileSavedConfigNotWrittenRemedy(setup, INTERRUPTED));
  });
});

describe("a key-file write failure", () => {
  test("states what happened, the path and the write's failure, then its step, and marks the step", () => {
    const err = keyFileWriteFailure(
      "first-store",
      "/k/.alcove.key",
      "EACCES: permission denied",
    );
    expect(err.message).toBe(
      "authentication succeeded, but the next shared secret could not be " +
        "saved to /k/.alcove.key: EACCES: permission denied Your partner did " +
        "not save it. Fix the key file's location or permissions, then run " +
        "the same command again; if authentication fails on that run, ask " +
        "your partner for a new invitation.",
    );
    expect(statesItsOwnNextStep(err)).toBe(true);
    expect(renderFailureForOperator(err)).toBe(err.message);
  });

  test("a failure with no write of its own runs the step on from the path", () => {
    const err = keyFileWriteFailure("partner-store", "/k/.alcove.key");
    expect(err.message).toMatch(
      /^Your partner could not save the new shared secret, so the exchange stopped\. This side had already saved it to \/k\/\.alcove\.key, and kept the secret this run used/,
    );
  });

  test("escapes the key file path where the failure is shown", () => {
    const shown = renderFailureForOperator(
      keyFileWriteFailure("previous-drop", "/k/\x1b[31m.alcove.key", "EIO"),
    );
    expect(shown).not.toContain("\x1b");
    expect(shown).toContain(
      "/k/<1b>[31m.alcove.key: EIO. The exchange stopped.",
    );
  });
});

describe("the both-swept line", () => {
  test("a peer-wait timeout after a delete-mode sweep states the likely cause and the step", () => {
    expect(
      bothSweptStep({ deleteModeSweep: true, peerWaitTimedOut: true }),
    ).toBe(
      "Both sides appear to have cleared the folder at the same time, " +
        "removing each other's files. The folder should be empty now. Run " +
        "the exchange again on both sides, without --sweep-exchange-files.",
    );
  });

  test("states nothing without both facts", () => {
    expect(
      bothSweptStep({ deleteModeSweep: false, peerWaitTimedOut: true }),
    ).toBeUndefined();
    expect(
      bothSweptStep({ deleteModeSweep: true, peerWaitTimedOut: false }),
    ).toBeUndefined();
  });
});

describe("the missing-receipt warning", () => {
  const DROPPED: SignedRunFacts = {
    receiptConfigured: true,
    exchangeComplete: false,
    receiptRefused: false,
    localConfigRefused: false,
  };

  test("a signed run that failed before the swap completed names the transport and the inactivity limit", () => {
    expect(missingReceiptWarning(DROPPED)).toBe(
      "A signed receipt was configured for this exchange, but no receipt " +
        "reached this side before the exchange ended and the receipt swap " +
        "did not complete. A partner that presents no signing certificate " +
        "is refused earlier, at the authenticated setup step, so check the " +
        "transport and the peer's own logs rather than the partner's " +
        "signing configuration. If the peer was still working when the " +
        "exchange ended, run again with a longer --inactivity-timeout, or " +
        "raise inactivity_timeout_ms under connection.options in the " +
        "configuration.",
    );
  });

  test.each([
    { receiptConfigured: false },
    { exchangeComplete: true },
    { receiptRefused: true },
    { localConfigRefused: true },
  ])("states nothing for %o", (fact) => {
    expect(missingReceiptWarning({ ...DROPPED, ...fact })).toBeUndefined();
  });
});
