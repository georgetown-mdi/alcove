import { describe, expect, test } from "vitest";

import {
  reattachHeading,
  reattachedRunState,
  runReattachView,
} from "@exchange/reattachedRunState";

import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";

const STILL_RUNNING = "An exchange started from this console is still running";
const FINISHED = "An exchange started from this console has finished";
const STOPPED = "An exchange started from this console stopped";
const RECONNECTING = "Reconnecting to your exchange";

describe("runReattachView", () => {
  test("a fresh run is not re-attached and not recovering", () => {
    expect(
      runReattachView({
        reattached: undefined,
        reattaching: false,
        failed: false,
        hasOutputs: false,
      }),
    ).toEqual({
      reattachedRun: false,
      reattachState: "running",
      recovering: false,
    });
  });

  test("the interim while the busy create resolves is recovering but not re-attached", () => {
    expect(
      runReattachView({
        reattached: undefined,
        reattaching: true,
        failed: false,
        hasOutputs: false,
      }),
    ).toEqual({
      reattachedRun: false,
      reattachState: "running",
      recovering: true,
    });
  });

  test("a re-attached run is recovering, with the state its status decides", () => {
    const view = (reattached: JobRunStatus) =>
      runReattachView({
        reattached,
        reattaching: false,
        failed: false,
        hasOutputs: false,
      });
    expect(view("running")).toEqual({
      reattachedRun: true,
      reattachState: "running",
      recovering: true,
    });
    expect(view("succeeded")).toMatchObject({
      reattachedRun: true,
      reattachState: "finished",
    });
    expect(view("failed")).toMatchObject({
      reattachedRun: true,
      reattachState: "stopped",
    });
    expect(view("cancelled")).toMatchObject({
      reattachedRun: true,
      reattachState: "stopped",
    });
  });

  test("a delivered failure or output wins over the probe's status", () => {
    expect(
      runReattachView({
        reattached: "running",
        reattaching: false,
        failed: true,
        hasOutputs: false,
      }).reattachState,
    ).toBe("stopped");
    expect(
      runReattachView({
        reattached: "running",
        reattaching: false,
        failed: false,
        hasOutputs: true,
      }).reattachState,
    ).toBe("finished");
  });

  test("a fresh run that fails or yields outputs is not re-attached", () => {
    const view = runReattachView({
      reattached: undefined,
      reattaching: false,
      failed: false,
      hasOutputs: true,
    });
    expect(view.reattachedRun).toBe(false);
    expect(view.recovering).toBe(false);
  });
});

describe("reattachedRunState", () => {
  const statuses: Array<JobRunStatus> = [
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ];

  test("a delivered failure stops the run whatever the status or outputs", () => {
    for (const status of statuses)
      for (const hasOutputs of [false, true])
        expect(reattachedRunState({ failed: true, hasOutputs, status })).toBe(
          "stopped",
        );
  });

  test("outputs finish the run, even when the status says failed or cancelled", () => {
    for (const status of statuses)
      expect(
        reattachedRunState({ failed: false, hasOutputs: true, status }),
      ).toBe("finished");
  });

  test("with no outputs, a failed or cancelled status stops the run", () => {
    for (const status of ["failed", "cancelled"] as const)
      expect(
        reattachedRunState({ failed: false, hasOutputs: false, status }),
      ).toBe("stopped");
  });

  test("with no outputs, a succeeded status finishes the run and running stays running", () => {
    expect(
      reattachedRunState({
        failed: false,
        hasOutputs: false,
        status: "succeeded",
      }),
    ).toBe("finished");
    expect(
      reattachedRunState({
        failed: false,
        hasOutputs: false,
        status: "running",
      }),
    ).toBe("running");
  });
});

describe("reattachHeading", () => {
  test("a fresh run has no heading", () => {
    expect(
      reattachHeading({
        reattachedRun: false,
        reattachState: "running",
        recovering: false,
      }),
    ).toBeUndefined();
  });

  test("the interim before the probe resolves heads as reconnecting", () => {
    expect(
      reattachHeading({
        reattachedRun: false,
        reattachState: "running",
        recovering: true,
      }),
    ).toBe(RECONNECTING);
  });

  test("a re-attached run heads by its state", () => {
    const heading = (reattachState: "running" | "finished" | "stopped") =>
      reattachHeading({ reattachedRun: true, reattachState, recovering: true });
    expect(heading("running")).toBe(STILL_RUNNING);
    expect(heading("finished")).toBe(FINISHED);
    expect(heading("stopped")).toBe(STOPPED);
  });

  test("composes with runReattachView end to end", () => {
    expect(
      reattachHeading(
        runReattachView({
          reattached: "succeeded",
          reattaching: false,
          failed: false,
          hasOutputs: false,
        }),
      ),
    ).toBe(FINISHED);
    expect(
      reattachHeading(
        runReattachView({
          reattached: undefined,
          reattaching: true,
          failed: false,
          hasOutputs: false,
        }),
      ),
    ).toBe(RECONNECTING);
  });
});
