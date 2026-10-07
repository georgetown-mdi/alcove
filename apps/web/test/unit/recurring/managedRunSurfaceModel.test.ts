import { describe, expect, test } from "vitest";
import { displayText } from "@alcove/core";

import {
  MANAGED_RUN_INITIAL,
  managedRunCompletion,
  managedRunInProgress,
  managedRunInputSource,
  managedRunLiveFailure,
  managedRunReducer,
  managedSurfaceView,
} from "@recurring/managedRunSurfaceModel";
import { TERMS_CHANGE_TAKEN_ON_FAILURE } from "@recurring/managedRunLaunchModel";

import type {
  ManagedRunAction,
  ManagedRunInputChoices,
  ManagedRunState,
  ManagedSurfaceViewInputs,
} from "@recurring/managedRunSurfaceModel";
import type { ResolvedMatching, TermsChange } from "@alcove/core";
import type { RunOutputs } from "@psi/runOutputs";

const OUTPUTS: RunOutputs = {
  kind: "matched",
  resultsUrl: "blob:results",
  matchedRecordCount: 2,
};

const MATCHING: ResolvedMatching = {
  localDeduplicate: true,
  partnerDeduplicate: false,
  cardinality: "one-to-many",
};

const FINISHED_AT = new Date("2026-10-07T12:00:00Z");

function fold(
  actions: ReadonlyArray<ManagedRunAction>,
  from: ManagedRunState = MANAGED_RUN_INITIAL,
): ManagedRunState {
  return actions.reduce(managedRunReducer, from);
}

const completed: ManagedRunAction = {
  type: "run-completed",
  outputs: OUTPUTS,
  finishedAt: FINISHED_AT,
  unsavedReason: undefined,
};

const failedRun = (runNumber: number): ManagedRunAction => ({
  type: "run-failed",
  failure: { alert: TERMS_CHANGE_TAKEN_ON_FAILURE, runNumber },
});

describe("a visit with no run", () => {
  test("is not running and shows neither outputs nor a failure", () => {
    expect(managedRunInProgress(MANAGED_RUN_INITIAL)).toBe(false);
    expect(managedRunCompletion(MANAGED_RUN_INITIAL)).toBeUndefined();
    expect(managedRunLiveFailure(MANAGED_RUN_INITIAL)).toBeUndefined();
    expect(MANAGED_RUN_INITIAL.warnings).toEqual([]);
    expect(MANAGED_RUN_INITIAL.matching).toBeUndefined();
    expect(MANAGED_RUN_INITIAL.termsChangeQuestion).toBeUndefined();
  });
});

describe("a run that produces its outputs", () => {
  test("counts as running from its start until it settles, including the folder write", () => {
    const started = fold([{ type: "run-started" }]);
    expect(managedRunInProgress(started)).toBe(true);
    const finishing = fold([completed], started);
    expect(managedRunInProgress(finishing)).toBe(true);
    const writing = fold(
      [{ type: "folder-write-started", directoryName: "work" }],
      finishing,
    );
    expect(managedRunInProgress(writing)).toBe(true);
    expect(managedRunInProgress(fold([{ type: "run-settled" }], writing))).toBe(
      false,
    );
  });

  test("shows its outputs from the moment they arrive", () => {
    const state = fold([{ type: "run-started" }, completed]);
    expect(managedRunCompletion(state)).toEqual({
      outputs: OUTPUTS,
      finishedAt: FINISHED_AT,
      unsavedReason: undefined,
      folderWrite: undefined,
    });
  });

  test("keeps the same outputs and instant across the folder write and the settle", () => {
    const state = fold([
      { type: "run-started" },
      completed,
      { type: "folder-write-started", directoryName: "work" },
      {
        type: "folder-write-finished",
        write: {
          directoryName: "work",
          delivery: {
            kind: "written",
            fileName: "results.csv",
            directoryName: "work",
          },
        },
      },
      { type: "run-settled" },
    ]);
    const completion = managedRunCompletion(state);
    expect(completion?.outputs).toBe(OUTPUTS);
    expect(completion?.finishedAt).toBe(FINISHED_AT);
  });

  test("states the reason the store refused its success stamp", () => {
    const state = fold([
      { type: "run-started" },
      { ...completed, unsavedReason: "the store is full" },
      { type: "run-settled" },
    ]);
    expect(managedRunCompletion(state)?.unsavedReason).toBe(
      "the store is full",
    );
  });

  test("reports the folder write under way, then how it turned out", () => {
    const writing = fold([
      { type: "run-started" },
      completed,
      { type: "folder-write-started", directoryName: "work" },
    ]);
    expect(managedRunCompletion(writing)?.folderWrite).toEqual({
      directoryName: "work",
    });
    const delivery = {
      kind: "written",
      fileName: "results.csv",
      directoryName: "work",
    } as const;
    const written = fold(
      [
        {
          type: "folder-write-finished",
          write: { directoryName: "work", delivery },
        },
      ],
      writing,
    );
    expect(managedRunCompletion(written)?.folderWrite).toEqual({
      directoryName: "work",
      delivery,
    });
  });

  test("drops the folder note where the folder was gone at the write", () => {
    const state = fold([
      { type: "run-started" },
      completed,
      { type: "folder-write-started", directoryName: "work" },
      { type: "folder-write-skipped" },
    ]);
    expect(managedRunCompletion(state)?.folderWrite).toBeUndefined();
  });

  test("has no folder note where the write never started", () => {
    const state = fold([
      { type: "run-started" },
      completed,
      { type: "run-settled" },
    ]);
    expect(managedRunCompletion(state)?.folderWrite).toBeUndefined();
  });

  test("keeps its outputs on screen over a failure reported after them", () => {
    const finishing = fold([{ type: "run-started" }, completed]);
    const state = fold([failedRun(1), { type: "run-settled" }], finishing);
    expect(managedRunLiveFailure(state)).toBeUndefined();
    expect(managedRunCompletion(state)?.outputs).toBe(OUTPUTS);
    expect(managedRunInProgress(state)).toBe(false);
  });
});

describe("a run that fails", () => {
  test("shows the failure with its run number once settled, and is no longer running", () => {
    const state = fold([
      { type: "run-started" },
      failedRun(1),
      { type: "run-settled" },
    ]);
    expect(managedRunLiveFailure(state)).toEqual({
      alert: TERMS_CHANGE_TAKEN_ON_FAILURE,
      runNumber: 1,
    });
    expect(managedRunInProgress(state)).toBe(false);
    expect(managedRunCompletion(state)).toBeUndefined();
  });

  test("a later run clears the failure at its start and numbers its own", () => {
    const first = fold([
      { type: "run-started" },
      failedRun(1),
      { type: "run-settled" },
    ]);
    const restarted = fold([{ type: "run-started" }], first);
    expect(managedRunLiveFailure(restarted)).toBeUndefined();
    const second = fold([failedRun(2), { type: "run-settled" }], restarted);
    expect(managedRunLiveFailure(second)?.runNumber).toBe(2);
  });

  test("a run the hand-off refused settles with no failure on screen", () => {
    const state = fold([{ type: "run-started" }, { type: "run-settled" }]);
    expect(managedRunLiveFailure(state)).toBeUndefined();
    expect(managedRunInProgress(state)).toBe(false);
    expect(managedRunCompletion(state)).toBeUndefined();
  });
});

describe("clearing the failure", () => {
  test("a composed re-invite or a settled terms proposal takes the failure down", () => {
    const failed = fold([
      { type: "run-started" },
      failedRun(1),
      { type: "run-settled" },
    ]);
    const cleared = fold([{ type: "failure-cleared" }], failed);
    expect(managedRunLiveFailure(cleared)).toBeUndefined();
    expect(managedRunInProgress(cleared)).toBe(false);
  });

  test("changes nothing where no failure stands", () => {
    for (const state of [
      MANAGED_RUN_INITIAL,
      fold([{ type: "run-started" }]),
      fold([{ type: "run-started" }, completed]),
    ])
      expect(managedRunReducer(state, { type: "failure-cleared" })).toBe(state);
  });
});

describe("what the driver reports along the way", () => {
  test("notices accumulate in arrival order and stand beside a failure", () => {
    const state = fold([
      { type: "run-started" },
      { type: "warning-raised", escapedWarning: displayText`first` },
      { type: "warning-raised", escapedWarning: displayText`second` },
      failedRun(1),
      { type: "run-settled" },
    ]);
    expect(state.warnings).toEqual(["first", "second"]);
  });

  test("notices stand beside the outputs of a run that produced them", () => {
    const state = fold([
      { type: "run-started" },
      completed,
      { type: "warning-raised", escapedWarning: displayText`late` },
      { type: "run-settled" },
    ]);
    expect(state.warnings).toEqual(["late"]);
  });

  test("a new run starts with no notices and no resolved matching", () => {
    const state = fold([
      { type: "run-started" },
      { type: "warning-raised", escapedWarning: displayText`first` },
      { type: "matching-resolved", matching: MATCHING },
      failedRun(1),
      { type: "run-settled" },
      { type: "run-started" },
    ]);
    expect(state.warnings).toEqual([]);
    expect(state.matching).toBeUndefined();
  });

  test("the resolved matching is held once reported", () => {
    const state = fold([
      { type: "run-started" },
      { type: "matching-resolved", matching: MATCHING },
    ]);
    expect(state.matching).toBe(MATCHING);
  });

  test("a terms change is asked until its answer, and a run start leaves it to its answer", () => {
    const question = {
      change: {} as TermsChange,
      answer: () => undefined,
    };
    const asked = fold([
      { type: "run-started" },
      { type: "terms-change-asked", question },
    ]);
    expect(asked.termsChangeQuestion).toBe(question);
    expect(fold([{ type: "run-started" }], asked).termsChangeQuestion).toBe(
      question,
    );
    expect(
      fold([{ type: "terms-change-answered" }], asked).termsChangeQuestion,
    ).toBeUndefined();
  });
});

describe("the run's input", () => {
  const folder = { name: "work" } as FileSystemDirectoryHandle;
  const file = new File(["a,b\n"], "input.csv");
  const loaded: ManagedRunInputChoices = {
    recordLoaded: true,
    usableFolder: undefined,
    folderGrantable: true,
    chosenFile: undefined,
  };

  test("there is none before the record loads", () => {
    expect(
      managedRunInputSource({
        ...loaded,
        recordLoaded: false,
        usableFolder: folder,
        folderGrantable: false,
        chosenFile: file,
      }),
    ).toBeUndefined();
  });

  test("a usable folder is read, attended", () => {
    expect(managedRunInputSource({ ...loaded, usableFolder: folder })).toEqual({
      kind: "folder",
      directory: folder,
      attendance: "attended",
    });
  });

  test("a usable folder outranks a chosen file", () => {
    expect(
      managedRunInputSource({
        ...loaded,
        usableFolder: folder,
        folderGrantable: false,
        chosenFile: file,
      }),
    ).toEqual({ kind: "folder", directory: folder, attendance: "attended" });
  });

  test("a browser that can grant a folder asks for one rather than taking a file", () => {
    expect(
      managedRunInputSource({ ...loaded, chosenFile: file }),
    ).toBeUndefined();
  });

  test("a browser that cannot grant a folder runs from the chosen file, once chosen", () => {
    expect(
      managedRunInputSource({
        ...loaded,
        folderGrantable: false,
        chosenFile: file,
      }),
    ).toEqual({ kind: "file", file });
    expect(
      managedRunInputSource({ ...loaded, folderGrantable: false }),
    ).toBeUndefined();
  });
});

describe("the surface's view", () => {
  const base: ManagedSurfaceViewInputs = {
    loadFailure: undefined,
    configurationLoaded: false,
    recordLoaded: true,
    run: MANAGED_RUN_INITIAL,
    commandLineHandedOff: false,
    migrated: false,
    migrationAwaitingConfirm: false,
  };
  const finished = fold([{ type: "run-started" }, completed]);

  test("is the run controls for a loaded record with nothing else under way", () => {
    expect(managedSurfaceView(base)).toBe("run");
  });

  test("is loading until a record or a configuration loads", () => {
    expect(managedSurfaceView({ ...base, recordLoaded: false })).toBe(
      "loading",
    );
  });

  test("a load failure outranks everything", () => {
    for (const loadFailure of ["missing", "unloadable", "spent"] as const)
      expect(
        managedSurfaceView({
          ...base,
          loadFailure,
          configurationLoaded: true,
          run: finished,
          commandLineHandedOff: true,
        }),
      ).toBe(loadFailure);
  });

  test("a configuration outranks a held record", () => {
    expect(managedSurfaceView({ ...base, configurationLoaded: true })).toBe(
      "configuration",
    );
  });

  test("a run's outputs outrank a hand-off, from the moment they arrive", () => {
    expect(
      managedSurfaceView({
        ...base,
        run: finished,
        commandLineHandedOff: true,
        migrated: true,
        migrationAwaitingConfirm: true,
      }),
    ).toBe("complete");
  });

  test("a failed or running run stays on the run controls", () => {
    expect(
      managedSurfaceView({ ...base, run: fold([{ type: "run-started" }]) }),
    ).toBe("run");
    expect(
      managedSurfaceView({
        ...base,
        run: fold([{ type: "run-started" }, failedRun(1)]),
      }),
    ).toBe("run");
  });

  test("the hand-offs rank command line, then migrated, then awaiting confirmation", () => {
    expect(
      managedSurfaceView({
        ...base,
        commandLineHandedOff: true,
        migrated: true,
        migrationAwaitingConfirm: true,
      }),
    ).toBe("command-line");
    expect(
      managedSurfaceView({
        ...base,
        migrated: true,
        migrationAwaitingConfirm: true,
      }),
    ).toBe("migrated");
    expect(
      managedSurfaceView({ ...base, migrationAwaitingConfirm: true }),
    ).toBe("confirm-move");
  });
});
