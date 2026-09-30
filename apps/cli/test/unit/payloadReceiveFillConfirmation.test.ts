import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import YAML from "yaml";
import PSI from "@openmined/psi.js";
import {
  DISPLAY_TRUNCATION_MARKER,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  OperatorConfigError,
  parseExchangeSpec,
  prepareForExchange,
  runExchange,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import { createMessagePipe } from "@alcove/core/testing";
import type { ExchangeSpec, MessageConnection, Metadata } from "@alcove/core";

vi.mock("../../src/util/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/util/prompt")>(
    "../../src/util/prompt",
  );
  return { ...actual, promptConfirm: vi.fn() };
});

import { persistFilledPayloadReceive, saveConfig } from "../../src/config";
import { buildErrorEvent, classifyTerminalError } from "../../src/eventStream";
import {
  payloadReceiveFillConfirmation,
  payloadReceiveTakenNotice,
  reportPayloadReceiveFill,
} from "../../src/termsChange";
import { exitCodeForError } from "../../src/util/exit";
import { promptConfirm } from "../../src/util/prompt";
import { captureStdio } from "../loggingTestSupport";

// Agency B runs from a configuration listing no payload columns it receives,
// against Agency A, whose metadata sends `notes` and `county`: B's first run
// with the handlers `alcove exchange` passes core.

const promptConfirmMock = vi.mocked(promptConfirm);
const psiLibrary = await PSI();

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

function metadataWith(...sent: string[]): Metadata {
  return [
    ...inferMetadata(LINKAGE_COLUMNS, []),
    ...sent.map((name) => ({
      name,
      type: "other" as const,
      role: "payload" as const,
      isPayload: true,
    })),
  ];
}

function rowsFor(metadata: Metadata, prefix: string) {
  return ["Carol", "Elizabeth", `${prefix}-only`].map((first, i) =>
    Object.fromEntries(
      metadata.map(({ name }) => [
        name,
        name === "first_name" ? first : `${prefix}-${name}-${i}`,
      ]),
    ),
  );
}

let dir: string;
let config: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-receive-fill-"));
  config = path.join(dir, "b.yaml");
  saveConfig(config, {
    connection: { channel: "filedrop", path: "/mnt/b" },
    linkageTerms: getDefaultLinkageTerms(
      "Agency B",
      inferMetadata(LINKAGE_COLUMNS, []),
    ),
    metadata: metadataWith(),
  });
  promptConfirmMock.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readSpec(): ExchangeSpec {
  return parseExchangeSpec(YAML.parse(fs.readFileSync(config, "utf8")));
}

const isTermsOrDecisionFrame = (m: unknown): boolean =>
  typeof m === "object" &&
  m !== null &&
  ("linkageTerms" in m || "decision" in m);

async function firstRun(interactive: boolean) {
  const [connA, connB] = createMessagePipe();
  const bSent: unknown[] = [];
  const capturingB: MessageConnection = {
    send: (m: unknown) => {
      bSent.push(m);
      return connB.send(m);
    },
    receive: (timeoutMs?: number) => connB.receive(timeoutMs),
    close: () => connB.close(),
    setInboundFrameCap: connB.setInboundFrameCap?.bind(connB),
  };
  const spec = readSpec();
  const bMetadata = spec.metadata!;
  const bPrepared = prepareForExchange(
    spec,
    "Agency B",
    rowsFor(bMetadata, "b"),
    bMetadata.map(({ name }) => name),
  );
  const aMetadata = metadataWith("notes", "county");
  const aPrepared = prepareForExchange(
    {
      metadata: aMetadata,
      linkageTerms: getDefaultLinkageTerms(
        "Agency A",
        inferMetadata(LINKAGE_COLUMNS, []),
      ),
    },
    "Agency A",
    rowsFor(aMetadata, "a"),
    aMetadata.map(({ name }) => name),
  );
  const onPayloadReceiveFill = payloadReceiveFillConfirmation({
    configPath: config,
    interactive,
    log: getLogger("exchange"),
    logFile: undefined,
  });
  const stdio = captureStdio();
  try {
    const [aOutcome, bOutcome] = await Promise.allSettled([
      runExchange(connA, "initiator", aPrepared, { psiLibrary }),
      runExchange(capturingB, "responder", bPrepared, {
        psiLibrary,
        ...(onPayloadReceiveFill !== undefined ? { onPayloadReceiveFill } : {}),
        onPayloadReceiveFilled: (columns) =>
          persistFilledPayloadReceive(config, columns),
      }),
    ]);
    return { aOutcome, bOutcome, bSent, stderr: stdio.stderrWrites.join("") };
  } finally {
    stdio.restore();
  }
}

const receivedColumns = (spec: ExchangeSpec) =>
  spec.linkageTerms.payload?.receive?.map(({ name }) => name);

describe("an attended first run", () => {
  test("shows the partner's declared columns, and confirming records them and continues", async () => {
    promptConfirmMock.mockResolvedValue(true);
    const { aOutcome, bOutcome, stderr } = await firstRun(true);
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(promptConfirmMock.mock.calls[0][0]).toContain(
      "linkage_terms.payload.receive",
    );
    expect(stderr).toContain("lists none you receive");
    expect(stderr).toContain("columns your partner now sends you");
    expect(stderr).toMatch(/notes[\s\S]*county/);
    expect(aOutcome.status).toBe("fulfilled");
    expect(bOutcome.status).toBe("fulfilled");
    expect(receivedColumns(readSpec())).toEqual(["notes", "county"]);
  });

  test("declining ends the run before this party sends any key or data and records no receive columns", async () => {
    promptConfirmMock.mockResolvedValue(false);
    const before = fs.readFileSync(config, "utf8");
    const { aOutcome, bOutcome, bSent } = await firstRun(true);
    expect(bOutcome.status).toBe("rejected");
    const error = (bOutcome as PromiseRejectedResult).reason as Error;
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(error.message).toMatch(
      /did not accept the payload columns .* stopped before sending any of your linkage keys or data, and no columns you receive were recorded in /,
    );
    expect(exitCodeForError(error)).toBe(64);
    expect(classifyTerminalError(error, "prepare")).toBe("config");
    expect(buildErrorEvent(error, "prepare").termsChange).toEqual({
      proposalWritten: false,
      received: { added: ["notes", "county"], removed: [] },
      otherTerms: [],
    });
    expect(aOutcome.status).toBe("rejected");
    expect(bSent.every(isTermsOrDecisionFrame)).toBe(true);
    expect(fs.readFileSync(config, "utf8")).toBe(before);
  });
});

describe("an unattended first run", () => {
  test("takes the partner's declared columns without asking and records them", async () => {
    const { aOutcome, bOutcome } = await firstRun(false);
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(aOutcome.status).toBe("fulfilled");
    expect(bOutcome.status).toBe("fulfilled");
    expect(receivedColumns(readSpec())).toEqual(["notes", "county"]);
  });
});

describe("the unattended fill notice", () => {
  test("names each column escaped once and the configuration written to", () => {
    expect(
      payloadReceiveTakenNotice(
        ["back\\slash", "bell\u0007", "zip\u202e"],
        "/srv/alcove.yaml",
      ),
    ).toBe(
      "this unattended run took the payload columns your partner declares " +
        'it sends you, without asking: "back\\\\slash", "bell\\x07", ' +
        '"zip\\u202e". They were written to /srv/alcove.yaml as ' +
        "linkage_terms.payload.receive, and later exchanges refuse a " +
        "partner that sends a different list.",
    );
  });

  test("says the columns were written nowhere when there is no configuration", () => {
    expect(payloadReceiveTakenNotice(["notes"], undefined)).toBe(
      "this unattended run took the payload columns your partner declares " +
        'it sends you, without asking: "notes". They were not written to ' +
        "any configuration.",
    );
  });

  test("cuts many long partner column names short, keeping the whole line within the warning cap and the configuration it names", () => {
    const columns = Array.from(
      { length: 200 },
      (_, index) => `column_${String(index)}_${"x".repeat(200)}`,
    );
    const notice = payloadReceiveTakenNotice(columns, "/srv/alcove.yaml");
    expect(notice.length).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    expect(notice).toContain(
      `${DISPLAY_TRUNCATION_MARKER}. They were written to /srv/alcove.yaml as linkage_terms.payload.receive, and later exchanges refuse a partner that sends a different list.`,
    );
  });

  test("goes through the unfiltered writer on an unattended run that took a column, and a fill recorded in a configuration is otherwise logged at info", () => {
    const outcomes = [
      { columns: ["notes"], recordedIn: "alcove.yaml", unattended: true },
      { columns: ["notes"], recordedIn: undefined, unattended: true },
      { columns: [], recordedIn: "alcove.yaml", unattended: true },
      { columns: [], recordedIn: undefined, unattended: true },
      { columns: ["notes"], recordedIn: "alcove.yaml", unattended: false },
      { columns: ["notes"], recordedIn: undefined, unattended: false },
    ].map(({ columns, recordedIn, unattended }) => {
      const written: string[] = [];
      const logged: string[] = [];
      reportPayloadReceiveFill({
        columns,
        recordedIn,
        unattendedWriter: unattended ? (line) => written.push(line) : undefined,
        log: { info: (message) => logged.push(message) },
      });
      return [written.length, logged.length];
    });
    expect(outcomes).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 0],
      [0, 1],
      [0, 0],
    ]);
  });
});
