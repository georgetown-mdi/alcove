import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";

import ts from "typescript";

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  appShellUpdateReady,
  registerAppShell,
  resetAppShellUpdate,
} from "@utils/appShellUpdate";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

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
  writeBackupToWorkingFolder,
  writeResultsToWorkingDirectory,
} from "@psi/managed/managedWorkingDirectory";
import { managedBackupFileName } from "@psi/managed/managedExchangeExport";
import { runResultsFileName } from "@psi/parkedResults";
import { startManagedScheduleRuntime } from "@psi/managed/managedScheduleRuntime";
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
 * a scheduled run never applies a waiting app-shell update, the folder the
 * operator granted is written only by a recurring exchange's runs -- the
 * scheduled run and the attended one, through one writer -- and the app reads
 * exactly one conventioned name from that folder and never enumerates it.
 *
 * All four are claims about what does NOT happen, which is exactly the kind a
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
    // is not a second one by design (docs/MANAGED_EXCHANGE.md, "The
    // automation goal and its platform envelope").
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
// The scheduled runner never applies a waiting app-shell update.

/** A worker whose state never changes; the update path only reads it. */
function fakeWorker(state: string): ShellWorker {
  return {
    state,
    postMessage: () => undefined,
    addEventListener: () => undefined,
  };
}

/** A container reporting a worker already installed and waiting behind the one
 * controlling this page -- the state an announced update sits in. */
function containerWithWaitingUpdate(): ShellContainer {
  const registration = {
    installing: null,
    waiting: fakeWorker("installed"),
    addEventListener: () => undefined,
  };
  return {
    controller: fakeWorker("activated"),
    register: () => Promise.resolve(registration),
    addEventListener: () => undefined,
  };
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
 * through: catch-up, an attempt, and the window's bookkeeping write. */
function seamsForDueWindow(record: ManagedExchangeRecord): {
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
      listLocalState: () =>
        Promise.resolve({
          states: new Map<string, ManagedLocalState>(),
          unreadableIds: [],
        }),
      persistAdvance: () => Promise.resolve(record),
      runAttempt: () => {
        attempts += 1;
        return Promise.resolve(undefined);
      },
      delay: () => Promise.resolve(),
      stopped: () => false,
    },
  };
}

afterEach(() => {
  resetAppShellUpdate();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a scheduled run and a waiting app-shell update", () => {
  test("leaves the update waiting: the runner never reloads the runtime under itself", async () => {
    const reload = vi.fn();
    await registerAppShell(containerWithWaitingUpdate(), {
      reload,
      isInstalledRuntime: () => true,
      onPageUnloading: () => undefined,
    });
    expect(appShellUpdateReady()).toBe(true);

    const record = dueRecord();
    const { seams, attempts } = seamsForDueWindow(record);
    const [entry] = await tickManagedSchedules(seams);

    expect(attempts()).toBe(1);
    expect(entry.disposition).toBe("succeeded");
    // A waiting worker takes over at the next cold start. Applying it means a
    // reload, and a reload during a run raises a confirmation an unattended
    // runtime has nobody to answer -- so the runner leaves it alone and the
    // offer stands for whoever opens the app next.
    expect(reload).not.toHaveBeenCalled();
    expect(appShellUpdateReady()).toBe(true);
  });

  test("holds across the host loop that wakes the tick, not only one tick", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await registerAppShell(containerWithWaitingUpdate(), {
      reload,
      isInstalledRuntime: () => true,
      onPageUnloading: () => undefined,
    });

    const { seams } = seamsForDueWindow(dueRecord());
    const controller = new AbortController();
    startManagedScheduleRuntime({
      signal: controller.signal,
      intervalMs: 1000,
      seams,
    });
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort();

    expect(reload).not.toHaveBeenCalled();
    expect(appShellUpdateReady()).toBe(true);
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
      "recurring/ManagedRunSurface.tsx: ManagedRunSurface.run",
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
    const fileName = managedBackupFileName(new Date("2026-01-06T14:00:00Z"));
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
  });

  test("never has its input file's name taken by a results write", () => {
    // The write creates the name it is handed; every name a run hands it is a
    // results name, which cannot be the input's, whatever the label says.
    for (const label of ["", "input", MANAGED_INPUT_FILE_NAME, "Riverbend"])
      expect(runResultsFileName(label, "2026-01-06T14:00:00.000Z")).not.toBe(
        MANAGED_INPUT_FILE_NAME,
      );
  });

  test("is reached into from the input read and the results write alone", () => {
    // The input read names the one conventioned constant; the results write names
    // its own file. No module gets a directory handle's child folders, and no
    // other module looks a name up at all.
    expect(folderEntryCalls()).toEqual([
      "psi/managed/managedInputHandle.ts: getFileHandle(MANAGED_INPUT_FILE_NAME)",
      "psi/managed/managedWorkingDirectory.ts: getFileHandle(fileName)",
      "psi/managed/managedWorkingDirectory.ts: removeEntry(fileName)",
      "psi/managed/managedWorkingDirectory.ts: getFileHandle(fileName)",
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
