import fs from "node:fs";

import {
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  redactAndFitUnescaped,
  redactAndSanitizeForDisplay,
  renderedDisplayCost,
  sanitizeForDisplay,
} from "@alcove/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { reconcileHostKeyFingerprints } from "@alcove/core/testing";

import {
  UNESCAPED_MESSAGE_FIELD,
  validateAndSanitizeEvent,
} from "@jobs/cliDriver";
import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { JobManager } from "@jobs/jobManager";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import { route as EventsRoute } from "../../../server/console/routes/$jobId/events";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// Every warning the CLI raises reaches a console seat escaped exactly once:
// the CLI writes the text unescaped beside its own escape of it, the relay
// fits that text without escaping it, and the seat's warning sink escapes it.
// Each source is driven from the bytes a child writes on fd 3, through the
// real manager, SSE route and browser-side client, to the string a seat
// renders, holding a value with a backslash and a non-ASCII character.

/** A value a partner chose, holding a backslash and a non-ASCII character. */
const PARTNER_VALUE = "a\\b caf\u00e9";

/** That value as one escape renders it: the backslash doubled once, the
 * non-ASCII character as one `\xHH` escape whose backslash is not doubled. */
const ESCAPED_ONCE = "a\\\\b caf\\xe9";

/** What a second escape would add: a run of four backslashes, or the escape
 * of the escape's own backslash before `xe9`. */
const ESCAPED_TWICE_TELLS = ["\\\\\\\\", "\\\\xe9"];

/**
 * The CLI's warning sources (`WARNING_SOURCES` in
 * packages/cli-contract/src/warningSources.ts, published in
 * docs/spec/CLI_EVENTS.md), each with a stand-in for its notice
 * holding the value and its own `[source]` tag, since the relay and the seat
 * treat every source's text alike. The divergence notice is core's real
 * composition; the fill warning's partner text rides its `columns` instead and
 * is listed apart.
 */
const CLI_WARNING_TEXT: ReadonlyArray<[string, () => string]> = [
  ["termsExchange", () => `terms note [termsExchange]: ${PARTNER_VALUE}`],
  [
    "hostKeyDivergence",
    () =>
      reconcileHostKeyFingerprints(
        { fingerprint: "SHA256:local", keyType: "ssh-ed25519" },
        { fingerprint: `SHA256:${PARTNER_VALUE}`, keyType: "ssh-ed25519" },
      )!,
  ],
  [
    "partnerCertificatePinned",
    () => `pinned [partnerCertificatePinned]: ${PARTNER_VALUE}`,
  ],
  [
    "unnamedPartnerRecord",
    () => `unnamed partner [unnamedPartnerRecord]: ${PARTNER_VALUE}`,
  ],
  [
    "resolvedCardinality",
    () => `cardinality [resolvedCardinality]: ${PARTNER_VALUE}`,
  ],
  [
    "pairTableAdvisory",
    () => `pair table [pairTableAdvisory]: ${PARTNER_VALUE}`,
  ],
  [
    "signingWithoutRecord",
    () => `no record [signingWithoutRecord]: ${PARTNER_VALUE}`,
  ],
  [
    "undeclaredColumns",
    () => `undeclared [undeclaredColumns]: ${PARTNER_VALUE}`,
  ],
  [
    "payloadSendBeyondConfiguration",
    () => `sent beyond [payloadSendBeyondConfiguration]: ${PARTNER_VALUE}`,
  ],
  [
    "terminatedRunRecord",
    () => `record not written [terminatedRunRecord]: ${PARTNER_VALUE}`,
  ],
  ["persistenceLoss", () => `lost [persistenceLoss]: ${PARTNER_VALUE}`],
  ["logFileLoss", () => `log lines lost [logFileLoss]: ${PARTNER_VALUE}`],
  ["memoryShortfall", () => `memory [memoryShortfall]: ${PARTNER_VALUE}`],
];

/**
 * The fd-3 line the CLI writes for a warning of `source` composed as `text`:
 * the fields `buildWarningEvent` (apps/cli/src/eventStream.ts) builds, encoded
 * to printable ASCII as its writer encodes every line.
 */
function cliWarningLine(
  source: string,
  text: string,
  extra: Record<string, unknown> = {},
): string {
  const event = {
    v: 1,
    type: "warning",
    source,
    message: redactAndSanitizeForDisplay(text, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
    [UNESCAPED_MESSAGE_FIELD]: redactAndFitUnescaped(
      text,
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    ),
    ...extra,
  };
  return asciiJsonLine(event);
}

/** `value` as one NDJSON line, every unit outside printable ASCII written as
 * the JSON escape for it. */
function asciiJsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}\n`;
}

/** The fill warning's fd-3 line: its message is escaped name by name and its
 * partner text is in `columns`, unescaped. */
const FILL_LINE = asciiJsonLine({
  v: 1,
  type: "warning",
  source: "payloadReceiveTaken",
  message:
    "this unattended run took the payload columns your partner declares it " +
    `sends you, without asking: "${sanitizeForDisplay(PARTNER_VALUE)}". ` +
    "They were not written to any configuration.",
  columns: [PARTNER_VALUE],
  columnCount: 1,
});

/** The text the seat must render for each source: one escape of what the CLI
 * composed. */
function renderedOnce(text: string): string {
  return sanitizeForDisplay(text, {
    maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  });
}

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

/** One exchange job driven to its terminal event, its child writing `fd3` on
 * fd 3 and then a result. */
async function runJob(
  label: string,
  fd3: string,
): Promise<{ record: JobRecord; id: string }> {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  const dataRoot = scratchDir(`${label}-root`);
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir(`${label}-rvz`),
    childEnv: {
      STUB_EXIT_CODE: "0",
      STUB_FD3_RAW: fd3,
      STUB_FD3_EVENTS: JSON.stringify([
        { v: 1, type: "result", resultWritten: true },
      ]),
    },
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const id = await manager.createJob(validIntent());
  const record = manager.getJob(id)!;
  const deadline = Date.now() + 5000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { record, id };
}

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

/** Each warning the real browser-side client delivers to a seat for an SSE
 * body, folded through the seat's warning sink. */
async function seatWarnings(id: string, body: string): Promise<Array<string>> {
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

/** The relayed warnings a record buffered. */
function relayedWarnings(record: JobRecord): Array<RelayEvent> {
  return record.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "warning");
}

function expectEscapedOnce(rendered: string): void {
  expect(rendered).toContain(ESCAPED_ONCE);
  for (const tell of ESCAPED_TWICE_TELLS) expect(rendered).not.toContain(tell);
  expect(rendered).toMatch(/^[\x20-\x7e]*$/);
}

describe("each CLI warning source renders in a console seat escaped once", () => {
  let rendered: Array<string> = [];
  let relayed: Array<RelayEvent> = [];

  beforeAll(async () => {
    const fd3 =
      CLI_WARNING_TEXT.map(([source, text]) =>
        cliWarningLine(
          source,
          text(),
          source === "logFileLoss" ? { lostLines: 2 } : {},
        ),
      ).join("") + FILL_LINE;
    const { record, id } = await runJob("single-escape", fd3);
    relayed = relayedWarnings(record);
    rendered = await seatWarnings(id, await sseBody(id));
  });

  for (const [source, text] of CLI_WARNING_TEXT)
    test(`${source}: from the child's fd 3 to the rendered string`, () => {
      const event = relayed.find((candidate) => candidate.source === source);
      expect(event).toBeDefined();
      // The job stream holds the text unescaped, for the seat's one pass.
      expect(event!.message).toBe(text());
      const shown = rendered.filter((warning) =>
        source === "hostKeyDivergence"
          ? warning.includes("different SFTP host keys")
          : warning.includes(`[${source}]`),
      );
      expect(shown).toEqual([renderedOnce(text())]);
      expectEscapedOnce(shown[0]);
    });

  test("payloadReceiveTaken: from the child's fd 3 to the rendered string", () => {
    const shown = rendered.filter((warning) =>
      warning.includes("The columns taken"),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(`The columns taken: "${ESCAPED_ONCE}".`);
    expectEscapedOnce(shown[0]);
  });

  test("no relayed warning holds the CLI's unescaped field under its own name", () => {
    expect(relayed).toHaveLength(CLI_WARNING_TEXT.length + 1);
    for (const event of relayed)
      expect(event).not.toHaveProperty(UNESCAPED_MESSAGE_FIELD);
  });
});

/** Every string a relayed value holds, keys included, with its path. */
function stringsOf(
  value: unknown,
  at: string,
): Array<{ at: string; text: string }> {
  if (typeof value === "string") return [{ at, text: value }];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => stringsOf(entry, `${at}[${index}]`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, inner]) => [
      { at: `${at} key`, text: key },
      ...stringsOf(inner, `${at}.${key}`),
    ]);
  return [];
}

describe("no relayed field reaches a seat unescaped", () => {
  const HOSTILE =
    `\u001b[31m\u202e\u0085${PARTNER_VALUE}\u2028\r\n` +
    'data: {"v":1,"type":"warning","message":"forged"}\n\n';
  const PRINTABLE = /^[\x20-\x7e]*$/;

  test("the one unescaped field is the warning text the seat escapes, and the seat escapes it", async () => {
    const fd3 = asciiJsonLine({
      v: 1,
      type: "warning",
      source: "termsExchange",
      message: sanitizeForDisplay(HOSTILE),
      [UNESCAPED_MESSAGE_FIELD]: HOSTILE,
      detail: HOSTILE,
      nested: { [HOSTILE]: [HOSTILE] },
    });
    const { record, id } = await runJob("hostile", fd3);
    const [event] = relayedWarnings(record);
    expect(event.message).toBe(HOSTILE);
    for (const { at, text } of stringsOf(event, "event"))
      if (at !== "event.message") expect(text, at).toMatch(PRINTABLE);

    const shown = await seatWarnings(id, await sseBody(id));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(PRINTABLE);
    expect(shown[0]).toBe(sanitizeForDisplay(HOSTILE));
  });

  test("every other event type's strings stay escaped at the relay", () => {
    for (const source of [
      { v: 1, type: "stages", stages: [{ id: HOSTILE, label: HOSTILE }] },
      { v: 1, type: "stage", id: HOSTILE, label: HOSTILE },
      { v: 1, type: "error", category: "exchange", message: HOSTILE },
      {
        v: 1,
        type: "result",
        resultWritten: true,
        [UNESCAPED_MESSAGE_FIELD]: HOSTILE,
      },
      {
        v: 1,
        type: "error",
        category: "exchange",
        message: "x",
        [UNESCAPED_MESSAGE_FIELD]: HOSTILE,
      },
    ]) {
      const event = validateAndSanitizeEvent(source);
      expect(event).not.toBeNull();
      for (const { at, text } of stringsOf(event, "event"))
        expect(text, at).toMatch(PRINTABLE);
    }
  });
});

describe("the relay's bound on the unescaped warning text", () => {
  test("fits an oversize text to what the seat's escape renders within the budget", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      source: "termsExchange",
      message: "x",
      [UNESCAPED_MESSAGE_FIELD]: "\u202e".repeat(200_000),
    });
    const message = event?.message as string;
    expect(message.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(renderedDisplayCost(message)).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    const [shown] = appendSanitizedRunWarning([], message);
    expect(shown.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
  });

  test("redacts private-key material the text holds", () => {
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      source: "termsExchange",
      message: "x",
      [UNESCAPED_MESSAGE_FIELD]:
        `rejected: -----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n` +
        "-----END OPENSSH PRIVATE KEY-----",
    });
    expect(event?.message).toContain("[redacted private key]");
    expect(event?.message).not.toContain(body);
  });

  test("a text that is not a string leaves the CLI's escaped message, escaped again", () => {
    for (const unescaped of [7, null, ["a"], { a: "b" }]) {
      const event = validateAndSanitizeEvent({
        v: 1,
        type: "warning",
        source: "termsExchange",
        message: ESCAPED_ONCE,
        [UNESCAPED_MESSAGE_FIELD]: unescaped,
      });
      expect(event).not.toBeNull();
      expect(event?.message).toBe(sanitizeForDisplay(ESCAPED_ONCE));
      expect(event).not.toHaveProperty(UNESCAPED_MESSAGE_FIELD);
    }
  });
});
