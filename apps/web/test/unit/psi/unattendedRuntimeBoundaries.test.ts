import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";

import ts from "typescript";

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  APP_SHELL_UPDATE_HOLD_LOCK_NAME,
  holdAppShellUpdateAcrossWindows,
  holdAppShellUpdateHere,
  resetAppShellUpdateHold,
} from "@utils/appShellUpdateHold";
import {
  appShellUpdateReady,
  registerAppShell,
  resetAppShellUpdate,
} from "@utils/appShellUpdate";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  awaitManagedExchangeLockTurn,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import { applyWaitingAppUpdateBetweenRuns } from "@psi/managed/managedAppUpdate";

import {
  MANAGED_INPUT_FILE_NAME,
  acquireManagedInput,
  readInputFileModifiedAt,
} from "@psi/managed/managedInputHandle";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  removeBackupFromWorkingFolder,
  writeBackupToWorkingFolder,
  writeResultsToWorkingDirectory,
} from "@psi/managed/managedWorkingDirectory";
import { managedBackupFileName } from "@psi/managed/managedExchangeExport";
import { runResultsFileName } from "@psi/parkedResults";

import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  startManagedScheduleRuntime,
} from "@psi/managed/managedScheduleRuntime";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import {
  createServiceWorkerHarness,
  serviceWorkerSourceModel,
} from "../../utils/serviceWorkerHarness";

import type { ShellContainer, ShellWorker } from "@utils/appShellUpdate";

import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalStateShape";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";

/**
 * The four runtime boundaries the unattended runner rests on, as checks rather
 * than as prose: an exchange is executed by the app runtime and by nothing else,
 * a waiting app-shell update is applied only between runs and never while
 * anything would be lost, the folder the operator granted is written only by a
 * recurring exchange's runs -- the scheduled run and the attended one, through
 * one writer -- and the app reads exactly one conventioned name from that
 * folder and never enumerates it.
 *
 * Each is a claim about what does NOT happen, which is exactly the kind a
 * comment cannot keep true (CONTRIBUTING.md, Code Conventions).
 */

vi.mock("@psi/workers/csvParseController", () => ({
  loadCSVFileOffMainThread: () =>
    Promise.resolve({
      data: [],
      errors: [],
      meta: { fields: ["ssn"], sanitizedColumnPositions: [] },
    }),
}));

// ---------------------------------------------------------------------------
// No exchange runs in the service worker.

/** The event types the shipped worker registers a listener for. Anything past
 * these is a way for the browser to WAKE the worker on its own. */
const REGISTERED_WORKER_EVENTS = ["install", "activate", "message", "fetch"];

/**
 * Capabilities running an exchange needs, none of which the worker may reach:
 * the record store the secret and schedule live in, the two transports a live
 * exchange uses, the PSI engine and the worker it runs in, and the one call a
 * classic worker script pulls further code in with.
 */
const EXCHANGE_CAPABILITIES = [
  "indexedDB",
  "RTCPeerConnection",
  "WebSocket",
  "WebAssembly",
  "Worker",
  "importScripts",
];

/** Which of {@link EXCHANGE_CAPABILITIES} a worker source reaches, from anywhere
 * in it. The guard, extracted so it can be run against a source that must fail
 * it as well as against the shipped one. */
function exchangeCapabilitiesReached(source?: string): Array<string> {
  const model = serviceWorkerSourceModel(source);
  const referenced = new Set<string>([
    ...[...model.functions.values()].flatMap((names) => [...names]),
    ...model.outsideFunctions.map((reference) => reference.name),
  ]);
  return EXCHANGE_CAPABILITIES.filter((capability) =>
    referenced.has(capability),
  );
}

describe("the app-shell service worker", () => {
  test("registers no background wakeup, so nothing can be scheduled into it", () => {
    const harness = createServiceWorkerHarness();

    expect([...harness.registeredEventTypes]).toEqual(REGISTERED_WORKER_EVENTS);
    // Named explicitly as well as bounded by the list above: Periodic
    // Background Sync's short opportunistic windows cannot sustain a live
    // two-party exchange, so the runner is an open app runtime and the worker
    // is not a second one by design (docs/notes/managed-exchange-design.md,
    // "The automation goal and its platform envelope").
    expect(harness.registeredEventTypes).not.toContain("periodicsync");
    expect(harness.registeredEventTypes).not.toContain("sync");
    expect(harness.registeredEventTypes).not.toContain("push");
  });

  test("reaches nothing an exchange would need, from any of its code", () => {
    expect(exchangeCapabilitiesReached()).toEqual([]);
  });

  test("would be caught reaching one through the global scope it runs in", () => {
    // A guard nothing can fail asserts nothing, and this one nearly was: a
    // capability captured as `self.indexedDB` -- a worker script's prevailing
    // idiom -- names the global object in scope and the capability as a
    // property off it, so a model reading only the scope half saw `self` and
    // passed.
    expect(
      exchangeCapabilitiesReached(
        'self.addEventListener("message", () => {\n' +
          '  const db = self.indexedDB.open("records");\n' +
          "  void db;\n" +
          "});\n",
      ),
    ).toEqual(["indexedDB"]);
    expect(
      exchangeCapabilitiesReached(
        "function compile(bytes) {\n" +
          "  return globalThis.WebAssembly.compile(bytes);\n" +
          "}\n",
      ),
    ).toEqual(["WebAssembly"]);
  });
});

// ---------------------------------------------------------------------------
// The scheduled runner applies a waiting app-shell update only between runs.

/** A worker whose state a test can advance, firing `statechange` as a real
 * one does. */
function fakeWorker(state: string) {
  const listeners: Array<() => void> = [];
  const worker = {
    state,
    postMessage: () => undefined,
    addEventListener: (_type: "statechange", listener: () => void) => {
      listeners.push(listener);
    },
  };
  return {
    worker: worker as ShellWorker,
    advanceTo(next: string) {
      worker.state = next;
      for (const listener of listeners) listener();
    },
  };
}

/** A container whose page is controlled, with `waiting` behind it when an
 * update is already installed, and a way to announce one later -- as the
 * browser does when it finds a redeployed script mid-run. */
function shellContainer(waiting: boolean) {
  const updateFound: Array<() => void> = [];
  const registration = {
    installing: null as ShellWorker | null,
    waiting: waiting ? fakeWorker("installed").worker : null,
    addEventListener: (_type: "updatefound", listener: () => void) => {
      updateFound.push(listener);
    },
    update: () => Promise.resolve(),
  };
  const container: ShellContainer = {
    controller: fakeWorker("activated").worker,
    register: () => Promise.resolve(registration),
    addEventListener: () => undefined,
  };
  return {
    container,
    installUpdate() {
      const installing = fakeWorker("installing");
      registration.installing = installing.worker;
      for (const listener of updateFound) listener();
      installing.advanceTo("installed");
      registration.waiting = installing.worker;
    },
  };
}

/** This page's shell, registered with a reload the test counts. */
async function registerShell(waiting: boolean) {
  const shell = shellContainer(waiting);
  const reload = vi.fn();
  await registerAppShell(shell.container, {
    reload,
    onPageUnloading: () => undefined,
  });
  return { ...shell, reload };
}

function dueRecord(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: {} as FileSystemDirectoryHandle,
    schedule: {
      anchor: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: "2026-01-06T14:00:00.000Z",
      consecutiveMisses: 0,
    },
  });
}

/** Seams over one due record whose run succeeds, so a tick goes all the way
 * through: catch-up, an attempt, and the window's bookkeeping write. The
 * stored record is never advanced, so every tick finds the window due again:
 * each one stands for the next scheduled run. The apply before each attempt
 * is the runtime's own, over this process's real Web Locks. `during` runs
 * inside each attempt, holding the record's run+rotate lock as a run does. */
function seamsForDueWindow(
  record: ManagedExchangeRecord,
  during: () => void = () => undefined,
): {
  seams: ManagedScheduleTickSeams;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    seams: {
      now: () => Date.parse("2026-01-06T14:30:00.000Z"),
      listRecords: () =>
        Promise.resolve({ records: [record], unreadableIds: [] }),
      readRecord: () => Promise.resolve(record),
      awaitLockTurn: () => Promise.resolve(),
      listLocalState: () =>
        Promise.resolve({
          states: new Map<string, ManagedLocalState>(),
          unreadableIds: [],
        }),
      persistAdvance: () => Promise.resolve(record),
      runAttempt: () =>
        withManagedExchangeLock(record.id, () => {
          attempts += 1;
          during();
          return Promise.resolve(undefined);
        }),
      delay: () => Promise.resolve(),
      stopped: () => false,
      applyWaitingAppUpdate: () => applyWaitingAppUpdateBetweenRuns(),
    },
  };
}

/** Hold another record's run+rotate lock until the returned function is
 * called, as a run in another window does. */
async function runInAnotherWindow(): Promise<() => void> {
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started = (): void => undefined;
  const holding = new Promise<void>((resolve) => {
    started = resolve;
  });
  void withManagedExchangeLock("another-exchange", () => {
    started();
    return finished;
  });
  await holding;
  return finish;
}

afterEach(() => {
  resetAppShellUpdate();
  resetAppShellUpdateHold();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a scheduled run and a waiting app-shell update", () => {
  test("waiting with nothing in progress anywhere is applied before the run, and the run is made on the reloaded page", async () => {
    const shell = await registerShell(true);
    expect(appShellUpdateReady()).toBe(true);

    const record = dueRecord();
    const { seams, attempts } = seamsForDueWindow(record);
    const [entry] = await tickManagedSchedules(seams);

    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(attempts()).toBe(0);
    expect(entry.skipped).toBe("app-update");

    // The reloaded page: the takeover activated the new code, so nothing is
    // waiting, and its first wake makes the run the old page left.
    resetAppShellUpdate();
    const reloaded = await registerShell(false);
    const [rerun] = await tickManagedSchedules(seams);

    expect(attempts()).toBe(1);
    expect(rerun.disposition).toBe("succeeded");
    expect(reloaded.reload).not.toHaveBeenCalled();
  });

  test("arriving during a run is applied after the run ends and before the next one", async () => {
    const shell = await registerShell(false);
    const record = dueRecord();
    const { seams, attempts } = seamsForDueWindow(record, () => {
      shell.installUpdate();
    });

    const [first] = await tickManagedSchedules(seams);

    expect(attempts()).toBe(1);
    expect(first.disposition).toBe("succeeded");
    expect(appShellUpdateReady()).toBe(true);
    expect(shell.reload).not.toHaveBeenCalled();

    const [next] = await tickManagedSchedules(seams);

    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(attempts()).toBe(1);
    expect(next.skipped).toBe("app-update");
  });

  test("waiting while another window runs an exchange is held until that run ends", async () => {
    const shell = await registerShell(true);
    const record = dueRecord();
    const { seams, attempts } = seamsForDueWindow(record);
    const finishOtherRun = await runInAnotherWindow();

    const [held] = await tickManagedSchedules(seams);

    expect(shell.reload).not.toHaveBeenCalled();
    expect(attempts()).toBe(1);
    expect(held.disposition).toBe("succeeded");

    finishOtherRun();
    await awaitManagedExchangeLockTurn("another-exchange");
    const [next] = await tickManagedSchedules(seams);

    expect(shell.reload).toHaveBeenCalledTimes(1);
    expect(next.skipped).toBe("app-update");
  });

  test("waiting while any window's leave-page prompt is armed, or a view here holds it, is held", async () => {
    const shell = await registerShell(true);
    const { seams, attempts } = seamsForDueWindow(dueRecord());

    const releasePrompt = holdAppShellUpdateAcrossWindows();
    await tickManagedSchedules(seams);
    releasePrompt();

    const releaseView = holdAppShellUpdateHere();
    await tickManagedSchedules(seams);
    releaseView();

    expect(attempts()).toBe(2);
    expect(shell.reload).not.toHaveBeenCalled();

    await vi.waitFor(async () => {
      const { held } = await navigator.locks.query();
      expect(held?.map((lock) => lock.name)).not.toContain(
        APP_SHELL_UPDATE_HOLD_LOCK_NAME,
      );
    });
    await tickManagedSchedules(seams);
    expect(shell.reload).toHaveBeenCalledTimes(1);
  });

  test("none waiting reloads nothing, and the run is made", async () => {
    const shell = await registerShell(false);
    const { seams, attempts } = seamsForDueWindow(dueRecord());

    const [entry] = await tickManagedSchedules(seams);

    expect(shell.reload).not.toHaveBeenCalled();
    expect(attempts()).toBe(1);
    expect(entry.disposition).toBe("succeeded");
  });

  test("is not applied where the lock state cannot be read", async () => {
    let applied = 0;
    const answer = await applyWaitingAppUpdateBetweenRuns({
      updateReady: () => true,
      heldHere: () => false,
      lockNames: () => Promise.reject(new Error("the lock manager is gone")),
      apply: () => (applied += 1),
    });

    expect(answer).toBe(false);
    expect(applied).toBe(0);
  });
});

describe("the runtime's look for a new deployment", () => {
  test("is made once an hour of wakes has passed since the start, and not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-01-06T09:00:00.000Z"));
    const looks: Array<number> = [];
    const controller = new AbortController();
    startManagedScheduleRuntime({
      signal: controller.signal,
      tick: () => Promise.resolve([]),
      seams: seamsForDueWindow(dueRecord()).seams,
      checkForAppUpdate: () => {
        looks.push(Date.now());
        return Promise.resolve();
      },
    });

    // The launch's own navigation was the first look.
    await vi.advanceTimersByTimeAsync(0);
    expect(looks).toEqual([]);
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS - 60_000);
    expect(looks).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(looks).toEqual([Date.parse("2026-01-06T10:00:00.000Z")]);
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(looks).toEqual([
      Date.parse("2026-01-06T10:00:00.000Z"),
      Date.parse("2026-01-06T11:00:00.000Z"),
    ]);
    controller.abort();
  });
});

// ---------------------------------------------------------------------------
// The granted working folder is written by a recurring exchange's runs alone.

/** The app source tree, walked for what reaches the folder write. */
const WEB_SOURCE_ROOT = new URL("../../../src/", import.meta.url);

/** Every source file under {@link WEB_SOURCE_ROOT}, as paths relative to it. */
function webSourceFiles(within = ""): Array<string> {
  return readdirSync(new URL(within, WEB_SOURCE_ROOT), {
    withFileTypes: true,
  }).flatMap((entry) =>
    entry.isDirectory()
      ? webSourceFiles(`${within}${entry.name}/`)
      : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        ? [`${within}${entry.name}`]
        : [],
  );
}

/** Every source file under {@link WEB_SOURCE_ROOT}, keyed by its relative path
 * in listing order, read once for every scan below. */
let webSources: ReadonlyMap<string, string>;

beforeAll(async () => {
  const files = webSourceFiles();
  const texts = await Promise.all(
    files.map((file) => readFile(new URL(file, WEB_SOURCE_ROOT), "utf8")),
  );
  webSources = new Map(files.map((file, index) => [file, texts[index]]));
});

/** The name a function-like node is known by, where it has one: a declaration's
 * own name, or the variable or property an unnamed function is assigned to. */
function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name !== undefined
  )
    return node.name.getText();
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) ||
      ts.isPropertyAssignment(node.parent))
  )
    return node.parent.name.getText();
  return undefined;
}

/** The named functions enclosing `node`, outermost first, joined by dots;
 * `(module)` for a reference at module scope. */
function enclosingFunctions(node: ts.Node): string {
  const names: Array<string> = [];
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
    const name = functionName(at);
    if (name !== undefined) names.unshift(name);
  }
  return names.length === 0 ? "(module)" : names.join(".");
}

/**
 * Every place `source` names `symbol`, as `file: enclosing functions`, other
 * than the plain import that brings it in and its own declaration. A use that
 * is not a call -- the function passed or stored as a value, or an import that
 * renames it, either of which would let a caller the list does not name reach
 * it -- is reported as one, so it fails the exact list below rather than
 * passing unseen.
 */
function symbolSites(file: string, source: string, symbol: string) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: Array<string> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === symbol) {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent)) {
        if (parent.propertyName !== undefined)
          sites.push(`${file}: import renamed to ${parent.name.text}`);
      } else if (!(ts.isFunctionDeclaration(parent) && parent.name === node)) {
        const callee = ts.isPropertyAccessExpression(parent) ? parent : node;
        const called =
          ts.isCallExpression(callee.parent) &&
          callee.parent.expression === callee;
        sites.push(
          `${file}: ${enclosingFunctions(node)}${called ? "" : " (not a call)"}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return sites;
}

/** Every place the app source names `symbol` (see {@link symbolSites}). Only a
 * module whose text holds the name can name it, so only those are parsed. */
function appSymbolSites(symbol: string): Array<string> {
  return [...webSources]
    .flatMap(([file, source]) =>
      source.includes(symbol) ? symbolSites(file, source, symbol) : [],
    )
    .sort();
}

/** The one writer both runs of a recurring exchange write their results
 * through, and the platform write beneath it. */
const RUN_RESULTS_WRITER = "writeRunResultsToWorkingFolder";
const FOLDER_WRITE = "writeResultsToWorkingDirectory";

/** The writer the backup a scheduled run takes after its rotation goes
 * through, which never replaces a name the folder already holds. */
const BACKUP_WRITER = "writeBackupToWorkingFolder";

/** The modules that conduct a one-off exchange, none of which holds a folder
 * grant to write through. */
const ONE_OFF_EXCHANGE_SURFACES = [
  "exchange/AcceptorExchangeSection.tsx",
  "exchange/DirectRunSection.tsx",
  "exchange/InviterExchangeSection.tsx",
  "exchange/RecoveredExchangePanel.tsx",
];

describe("writing a run's results into the granted folder", () => {
  test("is reached from the scheduled run and the attended run of a recurring exchange, and from nowhere else", () => {
    expect(appSymbolSites(RUN_RESULTS_WRITER)).toEqual([
      "psi/managed/managedScheduleRuntime.ts: writeUnattendedResultsToFolder",
      "recurring/useManagedRunSurface.ts: useManagedRunSurface.run",
    ]);
  });

  test("goes through that one writer, so both runs write the same file under the same name", () => {
    expect(appSymbolSites(FOLDER_WRITE)).toEqual([
      "psi/managed/managedWorkingDirectory.ts: writeRunResultsToWorkingFolder",
    ]);
  });

  test("writes a backup there only from the scheduled run's backup step", () => {
    expect(appSymbolSites(BACKUP_WRITER)).toEqual([
      "psi/managed/managedScheduleRuntime.ts: browserFolderBackupDeps.writeToFolder",
    ]);
  });

  test("is reached from no one-off exchange's surface", () => {
    const reaching = new Set(
      [
        ...appSymbolSites(RUN_RESULTS_WRITER),
        ...appSymbolSites(FOLDER_WRITE),
        ...appSymbolSites(BACKUP_WRITER),
      ].map((site) => site.slice(0, site.indexOf(":"))),
    );
    const modules = [...webSources.keys()];
    for (const surface of ONE_OFF_EXCHANGE_SURFACES) {
      // Each is a real module, so the check cannot pass over a renamed one.
      expect(modules).toContain(surface);
      expect(reaching.has(surface)).toBe(false);
    }
  });

  test("is guarded by a check that would catch a second caller, however it is reached", () => {
    // A guard nothing can fail asserts nothing: a one-off surface calling the
    // writer, calling it through a namespace import, renaming it on import, or
    // handing it on as a value is each reported.
    const file = "exchange/DirectRunSection.tsx";
    expect(
      symbolSites(
        file,
        [
          `import { ${RUN_RESULTS_WRITER} } from "@psi/managed/managedWorkingDirectory";`,
          `import * as folder from "@psi/managed/managedWorkingDirectory";`,
          `import { ${RUN_RESULTS_WRITER} as write } from "@psi/managed/managedWorkingDirectory";`,
          "export function DirectRunSection() {",
          `  const finish = async () => { await ${RUN_RESULTS_WRITER}(record, at, csv); };`,
          `  const again = () => folder.${RUN_RESULTS_WRITER}(record, at, csv);`,
          `  const later = [${RUN_RESULTS_WRITER}];`,
          "  return null;",
          "}",
        ].join("\n"),
        RUN_RESULTS_WRITER,
      ),
    ).toEqual([
      `${file}: import renamed to write`,
      `${file}: DirectRunSection.finish`,
      `${file}: DirectRunSection.again`,
      `${file}: DirectRunSection (not a call)`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The working folder is read by one name and never enumerated.

/** What the app may do with a working-folder handle: read its own name, look a
 * file up by name -- the input read, the results write, and the check whether
 * the write's own name is already held -- and remove the entry a failed write
 * created. Anything else, and every way of iterating a folder, is off it. */
const FOLDER_OPERATIONS_ALLOWED = new Set<PropertyKey>([
  "name",
  "getFileHandle",
  "removeEntry",
]);

/** A permission layer granting everything, so the recorder below sees the folder
 * operations alone rather than the permission extension's. */
const grantedPermission: HandlePermissionQuery = {
  query: () => Promise.resolve("granted"),
  request: () => Promise.resolve("granted"),
};

/** A working folder holding `input.csv`, recording every property read off it
 * and every name looked up in it. An iteration method, read or called, is
 * recorded like any other access, so the check below catches it whether or not
 * the fake implements it. `failWrite` makes the results stream refuse the bytes. */
function recordingFolder(options: { failWrite?: boolean } = {}) {
  const accessed: Array<PropertyKey> = [];
  const lookups: Array<{ name: string; create: boolean }> = [];
  const removed: Array<string> = [];
  const held = new Set([MANAGED_INPUT_FILE_NAME]);
  const target = {
    name: "Riverbend exchange",
    getFileHandle: (name: string, lookup?: { create?: boolean }) => {
      const create = lookup?.create === true;
      lookups.push({ name, create });
      if (!held.has(name) && !create)
        return Promise.reject(
          new DOMException(
            "A requested file could not be found",
            "NotFoundError",
          ),
        );
      held.add(name);
      return Promise.resolve({
        getFile: () => Promise.resolve(new File(["ssn\n"], name)),
        createWritable: () =>
          Promise.resolve({
            write: () =>
              options.failWrite === true
                ? Promise.reject(new Error("the disk is full"))
                : Promise.resolve(),
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      });
    },
    removeEntry: (name: string) => {
      removed.push(name);
      held.delete(name);
      return Promise.resolve();
    },
    entries: () => [][Symbol.iterator](),
    keys: () => [][Symbol.iterator](),
    values: () => [][Symbol.iterator](),
    [Symbol.asyncIterator]: () => [][Symbol.iterator](),
  };
  const handle = new Proxy(target, {
    get(folder, property, receiver) {
      accessed.push(property);
      return Reflect.get(folder, property, receiver) as unknown;
    },
  }) as unknown as FileSystemDirectoryHandle;
  return { handle, accessed, lookups, removed };
}

/** The accesses the recorder saw that the allowed set does not admit. */
function disallowedAccesses(accessed: Array<PropertyKey>): Array<string> {
  return accessed
    .filter((property) => !FOLDER_OPERATIONS_ALLOWED.has(property))
    .map(String);
}

/** Every call site in the app source that reaches into a folder's entries, as
 * `module: method(arguments)`. */
function folderEntryCalls(): Array<string> {
  return [...webSources].flatMap(([file, source]) =>
    [
      ...source.matchAll(
        /\.(getFileHandle|getDirectoryHandle|removeEntry)\(([^,)]*)/g,
      ),
    ].map((call) => `${file}: ${call[1]}(${call[2].trim()})`),
  );
}

describe("the working folder", () => {
  test("gives a run's input read exactly one lookup, of the conventioned name", async () => {
    const folder = recordingFolder();
    await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "unattended" },
      grantedPermission,
    );
    await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "attended" },
      grantedPermission,
    );
    await readInputFileModifiedAt(folder.handle, grantedPermission);

    expect(folder.lookups).toEqual([
      { name: MANAGED_INPUT_FILE_NAME, create: false },
      { name: MANAGED_INPUT_FILE_NAME, create: false },
      { name: MANAGED_INPUT_FILE_NAME, create: false },
    ]);
    expect(disallowedAccesses(folder.accessed)).toEqual([]);
  });

  test("gives the results write the one name it writes, and nothing else", async () => {
    const fileName = runResultsFileName(
      "Riverbend quarterly",
      "2026-01-06T14:00:00.000Z",
    );
    const written = recordingFolder();
    await writeResultsToWorkingDirectory(
      written.handle,
      fileName,
      new Blob(["ssn\n"]),
      grantedPermission,
    );
    expect(written.lookups.map((lookup) => lookup.name)).toEqual([
      fileName,
      fileName,
    ]);
    expect(disallowedAccesses(written.accessed)).toEqual([]);

    // A failed write removes the entry it created, and only that one.
    const failed = recordingFolder({ failWrite: true });
    await writeResultsToWorkingDirectory(
      failed.handle,
      fileName,
      new Blob(["ssn\n"]),
      grantedPermission,
    );
    expect(failed.removed).toEqual([fileName]);
    expect(disallowedAccesses(failed.accessed)).toEqual([]);
  });

  test("gives the backup write the one name it writes, and stops at a name already held", async () => {
    // The feature detection a stored grant is followed on, which Node lacks.
    vi.stubGlobal("FileSystemDirectoryHandle", class {});
    const fileName = managedBackupFileName(
      "Riverbend quarterly",
      new Date("2026-01-06T14:00:00Z"),
    );
    const backedUp = recordingFolder();
    await writeBackupToWorkingFolder(
      { workingDirectoryHandle: backedUp.handle },
      fileName,
      new Blob(["{}\n"]),
      grantedPermission,
    );
    expect(backedUp.lookups).toEqual([
      { name: fileName, create: false },
      { name: fileName, create: true },
    ]);
    expect(disallowedAccesses(backedUp.accessed)).toEqual([]);

    // Held already: looked up once, and neither created nor removed.
    const again = await writeBackupToWorkingFolder(
      { workingDirectoryHandle: backedUp.handle },
      fileName,
      new Blob(["{}\n"]),
      grantedPermission,
    );
    expect(again).toEqual({ kind: "name-held", fileName });
    expect(backedUp.lookups.slice(2)).toEqual([
      { name: fileName, create: false },
    ]);
    expect(backedUp.removed).toEqual([]);
    expect(disallowedAccesses(backedUp.accessed)).toEqual([]);

    // The previous backup's removal: the one name it is handed, looked up and
    // removed, and nothing listed.
    await removeBackupFromWorkingFolder(
      { workingDirectoryHandle: backedUp.handle },
      fileName,
      grantedPermission,
    );
    expect(backedUp.lookups.slice(3)).toEqual([
      { name: fileName, create: false },
    ]);
    expect(backedUp.removed).toEqual([fileName]);
    expect(disallowedAccesses(backedUp.accessed)).toEqual([]);
  });

  test("never has its input file's name taken by a results write", () => {
    // The write creates the name it is handed; every name a run hands it is a
    // results name, which cannot be the input's, whatever the label says.
    for (const label of ["", "input", MANAGED_INPUT_FILE_NAME, "Riverbend"])
      expect(runResultsFileName(label, "2026-01-06T14:00:00.000Z")).not.toBe(
        MANAGED_INPUT_FILE_NAME,
      );
  });

  test("is reached into from the input read, the writes, and the previous backup's removal alone", () => {
    // The input read names the one conventioned constant; the writes name their
    // own file, and the removal the name its caller took from the backup
    // marker. No module gets a directory handle's child folders, and no other
    // module looks a name up at all.
    expect(folderEntryCalls()).toEqual([
      "psi/managed/managedInputHandle.ts: getFileHandle(MANAGED_INPUT_FILE_NAME)",
      "psi/managed/managedWorkingDirectory.ts: getFileHandle(fileName)",
      "psi/managed/managedWorkingDirectory.ts: removeEntry(fileName)",
      "psi/managed/managedWorkingDirectory.ts: getFileHandle(fileName)",
      "psi/managed/managedWorkingDirectory.ts: getFileHandle(fileName)",
      "psi/managed/managedWorkingDirectory.ts: removeEntry(fileName)",
    ]);
  });

  test("is guarded by a check that would catch an enumeration", async () => {
    // A guard nothing can fail asserts nothing: a read that walks the folder's
    // entries, by method or by async iteration, is what the recorder exists to
    // see.
    const listed = recordingFolder();
    const walked = listed.handle as unknown as {
      values: () => Iterable<unknown>;
    };
    for (const entry of walked.values()) void entry;
    expect(disallowedAccesses(listed.accessed)).toEqual(["values"]);

    const iterated = recordingFolder();
    const iterable = iterated.handle as unknown as AsyncIterable<unknown>;
    for await (const entry of iterable) void entry;
    expect(disallowedAccesses(iterated.accessed)).toContain(
      "Symbol(Symbol.asyncIterator)",
    );
  });
});

/** Whether an iterated expression names a directory handle, by the words its
 * identifiers use. */
const NAMES_A_FOLDER = /handle|director|folder/i;

/** Every site in `source` that iterates an expression naming a handle, a
 * directory, or a folder: a `for await` loop over one, or a `.values(`,
 * `.keys(`, or `.entries(` call on one. */
function directoryIterationSites(source: string): Array<string> {
  const loops = [...source.matchAll(/for\s+await\s*\([^\n]*?\bof\s+([^\n{]*)/g)]
    .map((loop) => loop[1].trim())
    .filter((iterated) => NAMES_A_FOLDER.test(iterated))
    .map((iterated) => `for await of ${iterated}`);
  const listings = [
    ...source.matchAll(/([\w$.?[\]]+)\.(values|keys|entries)\(/g),
  ]
    .filter((call) => NAMES_A_FOLDER.test(call[1]))
    .map((call) => `${call[1]}.${call[2]}()`);
  return [...loops, ...listings];
}

/** Every directory-iteration site in the app source, as `module: site`. */
function directoryIterationCalls(): Array<string> {
  return [...webSources].flatMap(([file, source]) =>
    directoryIterationSites(source).map((site) => `${file}: ${site}`),
  );
}

describe("the working folder's source scan for iteration", () => {
  test("finds no module iterating an expression that names a handle, a directory, or a folder (a for await loop, or a .values(, .keys(, or .entries( call)", () => {
    expect(directoryIterationCalls()).toEqual([]);
  });

  test("catches a folder listing in any module and passes other iteration", () => {
    expect(
      directoryIterationSites(
        "for await (const e of record.workingDirectoryHandle.values()) {",
      ),
    ).toEqual([
      "for await of record.workingDirectoryHandle.values())",
      "record.workingDirectoryHandle.values()",
    ]);
    expect(directoryIterationSites("for await (const e of folder) {")).toEqual([
      "for await of folder)",
    ]);
    expect(directoryIterationSites("const names = directory.keys();")).toEqual([
      "directory.keys()",
    ]);
    expect(
      directoryIterationSites(
        [
          "for await (const frame of readEventStreamFrames(response)) {",
          "for (const [key, value] of Object.entries(settings)) {",
          "const ids = records.map((record) => record.id).values();",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
