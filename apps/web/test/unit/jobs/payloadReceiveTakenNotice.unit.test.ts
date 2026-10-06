import path from "node:path";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  RELAY_TERMS_CHANGE_LIST_CAP,
  validateAndSanitizeEvent,
} from "@jobs/cliDriver";
import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import {
  payloadReceiveTakenConsoleNotice,
  relayedTakenColumns,
} from "@jobs/payloadReceiveTakenNotice";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";
import { JobManager } from "@jobs/jobManager";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import { route as EventsRoute } from "../../../server/console/routes/$jobId/events";

import {
  STUB_CLI_PATH,
  STUB_CONFIG_FILE_TOKEN,
  awaitTerminalEmitted,
  trackScratchDirs,
  validIntent,
  validZeroSetupIntent,
} from "../../utils/jobFixtures";

import type { JobCreateIntent } from "@jobs/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// What the console tells an operator when a run it drove took the payload
// columns its partner declares without asking. The CLI's own line names the
// configuration file it wrote them into, a path inside this container, and
// promises later exchanges hold the partner to them, which only that per-run
// file does; the relay rebuilds the notice from the event's column list.

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();
const managers: Array<JobManager> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  removeScratchDirs();
  vi.unstubAllEnvs();
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

/** The CLI's fill warning as it writes it on fd 3 for `columns`: its message
 * names the configuration (the token the stub replaces with its --config-file
 * value), and its column list holds each name unescaped. */
function cliTakenEvent(
  columns: Array<string>,
  columnCount: number,
): Record<string, unknown> {
  return {
    v: 1,
    type: "warning",
    source: "payloadReceiveTaken",
    message:
      "this unattended run took the payload columns your partner declares it " +
      'sends you, without asking: "program", "county". They were written to ' +
      `${STUB_CONFIG_FILE_TOKEN} as linkage_terms.payload.receive, and later ` +
      "exchanges refuse a partner that sends a different list.",
    columns,
    columnCount,
  };
}

const CLI_TAKEN_EVENT = cliTakenEvent(["program", "county"], 3);

/** One job of `intent` driven to its terminal event, its child emitting
 * `takenEvent` and a result. */
async function runTakingJob(
  label: string,
  intent: JobCreateIntent,
  takenEvent: Record<string, unknown> = CLI_TAKEN_EVENT,
): Promise<{ dataRoot: string; record: JobRecord; id: string }> {
  const dataRoot = scratchDir(`${label}-root`);
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir(`${label}-rvz`),
    childEnv: {
      STUB_EXIT_CODE: "0",
      STUB_FD3_EVENTS: JSON.stringify([
        takenEvent,
        { v: 1, type: "result", resultWritten: true },
      ]),
    },
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const id = await manager.createJob(intent);
  const record = manager.getJob(id)!;
  await awaitTerminalEmitted(record);
  return { dataRoot, record, id };
}

/** The single warning among the events a record buffered. */
function soleWarning(record: JobRecord): RelayEvent {
  const warnings = record.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "warning");
  expect(warnings).toHaveLength(1);
  return warnings[0];
}

describe("the relayed fill notice states no container path", () => {
  test("an exchange run's notice is the console's, naming the columns and where to record them", async () => {
    const { dataRoot, record } = await runTakingJob("taken", validIntent());
    const notice = soleWarning(record);
    expect(notice.source).toBe("payloadReceiveTaken");
    expect(notice.columns).toEqual(["program", "county"]);
    expect(notice.columnCount).toBe(3);
    expect(notice.message).toBe(
      payloadReceiveTakenConsoleNotice("exchange", {
        columns: ["program", "county"],
        columnCount: 3,
      }),
    );
    expect(notice.message).toContain(
      'The columns taken: "program", "county", and 1 more.',
    );
    expect(notice.message).toContain("linkage_terms.payload.receive");
    expect(notice.message).not.toContain(dataRoot);
    expect(notice.message).not.toContain(
      path.join(record.workdir, JOB_FILE_NAMES.config),
    );
  });

  test("a direct exchange's notice says no configuration records them", async () => {
    const { dataRoot, record } = await runTakingJob(
      "taken-direct",
      validZeroSetupIntent(),
    );
    const notice = soleWarning(record);
    expect(notice.message).toBe(
      payloadReceiveTakenConsoleNotice("zeroSetup", {
        columns: ["program", "county"],
        columnCount: 3,
      }),
    );
    expect(notice.message).toContain("records them in no configuration");
    expect(notice.message).not.toContain(dataRoot);
  });
});

/** The job's whole SSE body, read off the real route. */
async function sseBody(id: string): Promise<string> {
  const handlers = EventsRoute.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;
  const response = (await handlers.GET({
    request: new Request(`http://localhost/api/jobs/${id}/events`, {
      headers: { host: "localhost" },
    }),
    params: { jobId: id },
  })) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

/** What the run view shows for an SSE body: each warning the real browser-side
 * client delivers to the seat, folded through the run view's warning sink. */
async function runViewWarnings(
  id: string,
  body: string,
): Promise<Array<string>> {
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );
  let shown: Array<string> = [];
  await createServerJobReattachDriver(
    id,
    createFetchJobApiClient(fetchImpl),
  ).run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onWarning: (message) => {
      shown = appendSanitizedRunWarning(shown, message);
    },
  });
  return shown;
}

/** The quoted names a list of `"name", "name"` holds, a doubled quote read as
 * one quote inside a name. */
function quotedNames(list: string): Array<string> {
  const names: Array<string> = [];
  const quoted = /"((?:[^"]|"")*)"(?:, |$)/gy;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(list)) !== null)
    names.push(match[1].replaceAll('""', '"'));
  return names;
}

describe("the fill notice on the run view", () => {
  test("shows each partner column name escaped once, from the CLI's event through the relay to the run view", async () => {
    const { id } = await runTakingJob(
      "taken-e2e",
      validIntent(),
      cliTakenEvent(["caf\u00e9", "a\\b", 'x", "y'], 3),
    );
    const shown = (await runViewWarnings(id, await sseBody(id))).filter(
      (warning) => warning.includes("The columns taken"),
    );
    expect(shown).toHaveLength(1);
    const list = /The columns taken: (.*)\.$/.exec(shown[0])?.[1];
    expect(list).toBe('"caf\\xe9", "a\\\\b", "x"", ""y"');
    expect(quotedNames(list ?? "")).toEqual(["caf\\xe9", "a\\\\b", 'x", "y']);
    expect(shown[0]).not.toContain("\u00e9");
  });

  test("a column list that is not the CLI's shape leaves the names out rather than the notice", () => {
    for (const malformed of [
      { columns: "program", columnCount: 1 },
      { columns: [1], columnCount: 1 },
      { columns: ["program"], columnCount: 0 },
      { columns: ["program"] },
    ]) {
      const taken = relayedTakenColumns({
        v: 1,
        type: "warning",
        ...malformed,
      });
      expect(taken).toBeUndefined();
      expect(payloadReceiveTakenConsoleNotice("exchange", taken)).not.toContain(
        "The columns taken",
      );
    }
  });
});

/** Partner names whose quoted list fills the CLI's whole warning budget, one
 * in five holding a character the run view escapes. */
function namesFillingTheCliBudget(): Array<string> {
  const names: Array<string> = [];
  let listed = 0;
  while (listed < WARNING_MESSAGE_MAX_DISPLAY_LENGTH - 300) {
    const name = `column_${String(names.length)}${names.length % 5 === 0 ? "_caf\u00e9" : "_xxxx"}`;
    names.push(name);
    listed += `, "${name}"`.length;
  }
  return names;
}

/** Expect the run view's `shown` notice to list a prefix of `names` whole,
 * escaped once, and to count the rest of `columnCount`, uncut by the sink. */
function expectWholeNamesAndCount(
  shown: string,
  names: Array<string>,
  columnCount: number,
): void {
  expect(shown.length).toBeLessThanOrEqual(WARNING_MESSAGE_MAX_DISPLAY_LENGTH);
  expect(shown).not.toContain(DISPLAY_TRUNCATION_MARKER);
  const match = /The columns taken: (.*), and (\d+) more\.$/.exec(shown);
  expect(match).not.toBeNull();
  const listed = quotedNames(match?.[1] ?? "");
  expect(listed.length).toBeGreaterThan(0);
  expect(listed).toEqual(
    names
      .slice(0, listed.length)
      .map((name) =>
        sanitizeForDisplay(name, { maxLength: Number.POSITIVE_INFINITY }),
      ),
  );
  expect(Number(match?.[2])).toBe(columnCount - listed.length);
}

describe("the fill notice at the run view's budget", () => {
  for (const [mode, intent] of [
    ["exchange", validIntent],
    ["zeroSetup", validZeroSetupIntent],
  ] as const)
    test(`in ${mode} mode, shows whole names and the count for the CLI's full list`, async () => {
      const names = namesFillingTheCliBudget();
      const columnCount = names.length + 40;
      const { id } = await runTakingJob(
        `taken-full-${mode}`,
        intent(),
        cliTakenEvent(names, columnCount),
      );
      const shown = (await runViewWarnings(id, await sseBody(id))).filter(
        (warning) => warning.includes("The columns taken"),
      );
      expect(shown).toHaveLength(1);
      expectWholeNamesAndCount(shown[0], names, columnCount);
    });

  test("never splits a name at the cut, whatever its length", () => {
    const cliNames = namesFillingTheCliBudget();
    const names = [...cliNames, ...cliNames.map((name) => `${name}_more`)];
    for (const mode of ["exchange", "zeroSetup"] as const) {
      const lastShown =
        quotedNames(
          /The columns taken: (.*), and \d+ more\.$/.exec(
            payloadReceiveTakenConsoleNotice(mode, {
              columns: names,
              columnCount: names.length,
            }),
          )?.[1] ?? "",
        ).length - 1;
      expect(lastShown).toBeGreaterThan(0);
      for (let width = 1; width <= 60; width += 1) {
        const columns = names.map((name, index) =>
          index === lastShown ? `${name}_${"\u00e9".repeat(width)}` : name,
        );
        const [shown] = appendSanitizedRunWarning(
          [],
          payloadReceiveTakenConsoleNotice(mode, {
            columns,
            columnCount: columns.length,
          }),
        );
        expectWholeNamesAndCount(shown, columns, columns.length);
      }
    }
  });
});

describe("the relay's column list", () => {
  test("passes the names through unescaped, for the run view's single escape", () => {
    const event = validateAndSanitizeEvent(
      cliTakenEvent(["caf\u00e9", "a\\b", "bell\u0007"], 3),
    );
    expect(event?.columns).toEqual(["caf\u00e9", "a\\b", "bell\u0007"]);
  });

  test("keeps the first names up to the cap and counts the rest in the notice", () => {
    const columns = Array.from(
      { length: RELAY_TERMS_CHANGE_LIST_CAP + 5 },
      (_, index) => `c${String(index)}`,
    );
    const event = validateAndSanitizeEvent(
      cliTakenEvent(columns, columns.length),
    );
    expect(event?.columns).toEqual(
      columns.slice(0, RELAY_TERMS_CHANGE_LIST_CAP),
    );
    expect(
      payloadReceiveTakenConsoleNotice("exchange", relayedTakenColumns(event!)),
    ).toMatch(/"c255", and 5 more\.$/);
  });

  test("fits a name past the per-value budget rather than relaying it whole", () => {
    const event = validateAndSanitizeEvent(
      cliTakenEvent(["x".repeat(100_000)], 1),
    );
    const [name] = event?.columns as Array<string>;
    expect(name.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
  });

  test("escapes a columns field on any other warning as it does every field", () => {
    const event = validateAndSanitizeEvent({
      ...cliTakenEvent(["caf\u00e9"], 1),
      source: "undeclaredColumns",
    });
    expect(event?.columns).toEqual(["caf\\xe9"]);
  });
});
