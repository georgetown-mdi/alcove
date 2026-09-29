import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
  snakeizeKeys,
} from "@alcove/core";
import { stringify as stringifyYaml } from "yaml";

import { JobManager, TERMS_PROPOSAL_REFUSAL } from "@jobs/jobManager";
import { RECEIPTS_DEFAULT, receiptsIntentFields } from "@psi/receiptsModel";
import { TERMS_PROPOSAL_FILE_NAME } from "@jobs/termsProposal";
import { applyJobTermsProposal } from "@psi/jobClient/termsProposalClient";
import { authoringStateFromDocument } from "@console/loadedConfig";
import { connectionTuningOptions } from "@console/connectionTuningModel";
import { openMountedConfiguration } from "@jobs/configLoad";
import { relayedTermsChangeOf } from "@psi/jobClient/serverJobExchangeDriver";

import { Route as ApplyTermsRoute } from "../../src/routes/api/jobs/$jobId/apply-terms";

import {
  cliEntry,
  cliIsBuilt,
  expectCliSucceeded,
  fillInFileDropConnection,
  invitationFrom,
  pairsFromResultCsv,
  startCli,
} from "./cliParty";

import type { CliRun } from "./cliParty";
import type { JobFiledropExchangeIntent } from "@jobs/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";

/**
 * The whole of "use the GUI for the settings and the CLI for the work", driven
 * end to end: `alcove` writes a file-drop configuration, the console opens it
 * off its mounted folder, runs the exchange it states against a real `alcove`
 * partner, and hands back the configuration a scheduled command-line run loads.
 *
 * Both parties here are the real program -- the partner spawned directly, this
 * side spawned by the console's own job manager over the configuration it
 * composed -- so what the test settles is that a console run of an OPENED
 * configuration links, on the terms the file states. The linkage terms are
 * passed through untouched: the invitation the partner minted is what both
 * sides run under, and the console changes nothing about it.
 */

// Two rows in common at different offsets on each side, so a party reading its
// own table back cannot pass by symmetry.
const PARTNER_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const CONSOLE_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

const PARTNER_IDENTITY = "Agency A, a@agency-a.example";
const CONSOLE_IDENTITY = "Agency B, b@agency-b.example";

/** The pairs each side must resolve: [own row, partner row]. */
const PARTNER_PAIRS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
];
const CONSOLE_PAIRS: Array<[number, number]> = [
  [1, 0],
  [2, 1],
];

// A local directory answers in microseconds, so the poll interval is what keeps
// the rounds moving rather than a production cadence.
const POLL_INTERVAL_MS = 20;

// The peer budget: it bounds the gaps between a live partner's messages, so it
// is the deadline for a partner that stopped, never the test's runtime.
const PEER_TIMEOUT_MS = 60_000;

// A hard deadline on each `alcove` invocation, past the peer budget so a run
// that hangs is reported as a hang rather than absorbed into a budget's expiry.
const CLI_DEADLINE_MS = 150_000;

/** How long the console's job may take to reach its terminal event. */
const JOB_DEADLINE_MS = 150_000;

interface Workspace {
  root: string;
  dropDir: string;
  partnerDir: string;
  partnerOutput: string;
  partnerConfig: string;
  /** The console's single mounted working folder: the configuration, the key
   * file beside it, and the input CSV. */
  mount: string;
  mountedConfig: string;
}

function makeWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "alcove-console-loaded-"));
  const dropDir = path.join(root, "drop");
  const partnerDir = path.join(root, "partner");
  const mount = path.join(root, "mount");
  for (const dir of [dropDir, partnerDir, mount]) mkdirSync(dir);
  writeFileSync(path.join(partnerDir, "input.csv"), PARTNER_CSV);
  writeFileSync(path.join(mount, "input.csv"), CONSOLE_CSV);
  return {
    root,
    dropDir,
    partnerDir,
    partnerOutput: path.join(partnerDir, "out.csv"),
    partnerConfig: path.join(partnerDir, "alcove.yaml"),
    mount,
    mountedConfig: path.join(mount, "alcove.yaml"),
  };
}

let workspace: Workspace;
const managers: Array<JobManager> = [];

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    undefined;
  for (const manager of managers.splice(0)) manager.shutdown();
  rmSync(workspace.root, { recursive: true, force: true });
});

/** The shared secret the key file beside the mounted configuration holds,
 * which is what the console's run holds the exchange to. */
function mountedSharedSecret(mount: string): string {
  const parsed = parseSensitiveJson(
    readFileSync(path.join(mount, ".alcove.key"), "utf8"),
    "mounted key file",
  );
  const { sharedSecret } = parsed as { sharedSecret?: unknown };
  if (typeof sharedSecret !== "string")
    throw new Error("the mounted key file states no shared secret");
  return sharedSecret;
}

/**
 * The exchange the console runs for the configuration it opened: the settings
 * the document states, through the manager's own open and the console's own
 * mapping. The linkage terms, metadata, and standardization are the file's,
 * unedited, and the intent reports the configuration as opened and states no
 * secret, which has the run use the key file beside it and its hand-off merge
 * the opened document.
 */
function intentFromOpen(manager: JobManager): JobFiledropExchangeIntent {
  const response = manager.openMountedConfiguration();
  if (response.document === undefined)
    throw new Error("the mount holds no configuration to open");
  const loaded = authoringStateFromDocument(response.document);
  if (loaded.channel !== "filedrop")
    throw new Error(`the mounted configuration runs over ${loaded.channel}`);
  const options = connectionTuningOptions(loaded.connectionTuning);
  return {
    channel: "filedrop",
    side: "acceptor",
    linkageTerms: loaded.linkageTerms,
    inputFile: { name: "input.csv" },
    mountedConfigurationOpened: true,
    ...(loaded.metadata !== undefined ? { metadata: loaded.metadata } : {}),
    ...(loaded.standardization !== undefined
      ? { standardization: loaded.standardization }
      : {}),
    ...loaded.records,
    ...(options !== undefined ? { options } : {}),
  };
}

/** The configuration the mount holds, as the export's merge base reads it. */
function mountedDocumentOf(mount: string) {
  const document = openMountedConfiguration(mount).opened?.document;
  if (document === undefined)
    throw new Error("the mount holds no configuration to open");
  return document;
}

/** Resolve once the console's child has exited, or fail on the deadline. The
 * wait is on the terminal STATE rather than on the terminal event: the event is
 * the run's own last word, and the exit that follows it is what says the child
 * is done with the folder this test reads next. */
async function waitForTerminal(manager: JobManager, id: string): Promise<void> {
  const deadline = Date.now() + JOB_DEADLINE_MS;
  for (;;) {
    const record = manager.getJob(id);
    if (record === undefined) throw new Error("the job left the slot");
    if (record.terminal !== null) {
      if (record.terminal.outcome !== "succeeded")
        throw new Error(
          `the console run ended ${record.terminal.outcome}: ` +
            JSON.stringify(record.events.slice(-3)),
        );
      return;
    }
    if (Date.now() > deadline)
      throw new Error("the console run reached no terminal event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The partnership the console's mount holds: the partner's `alcove invite`,
 * accepted on the command line into the mount -- an alcove.yaml, the key file
 * beside it, and the operator's own input -- with each connection block filled
 * in, as an offline invitation asks. The mounted block names a folder other
 * than the one the console runs over, so a run that read it would not meet
 * the partner.
 */
async function establishPartnership(): Promise<void> {
  const invite = await startCli({
    args: ["invite", "--identity", PARTNER_IDENTITY, "input.csv"],
    cwd: workspace.partnerDir,
    timeoutMs: CLI_DEADLINE_MS,
  });
  expectCliSucceeded(invite, "invite");
  fillInFileDropConnection({
    configPath: workspace.partnerConfig,
    dropDir: workspace.dropDir,
    pollIntervalMs: POLL_INTERVAL_MS,
    peerTimeoutMs: PEER_TIMEOUT_MS,
  });
  const accept = await startCli({
    args: [
      "accept",
      "--identity",
      CONSOLE_IDENTITY,
      "--consent-to-terms",
      invitationFrom(invite),
      "input.csv",
    ],
    cwd: workspace.mount,
    timeoutMs: CLI_DEADLINE_MS,
  });
  expectCliSucceeded(accept, "accept");
  fillInFileDropConnection({
    configPath: workspace.mountedConfig,
    dropDir: "/not-the-folder-the-console-runs-over",
    pollIntervalMs: POLL_INTERVAL_MS,
    peerTimeoutMs: PEER_TIMEOUT_MS,
  });
}

/** A console job manager over the workspace's mount, as the console image
 * builds one. */
function consoleManager(): JobManager {
  const manager = new JobManager({
    dataRoot: workspace.mount,
    binaryPath: cliEntry,
    jobInputDir: workspace.mount,
    jobRendezvousDir: workspace.dropDir,
  });
  managers.push(manager);
  return manager;
}

describe.skipIf(!cliIsBuilt)(
  "a configuration Alcove wrote, opened in the console and run",
  () => {
    test("the console links against a real Alcove partner on the file's terms", async () => {
      await establishPartnership();
      const manager = consoleManager();

      const secretBeforeRun = mountedSharedSecret(workspace.mount);
      const id = await manager.createJob({
        ...intentFromOpen(manager),
        tokenMaxAgeDays: 30,
      });
      const createdAt = Date.now();
      const partner = startCli({
        args: ["exchange", "input.csv", "out.csv"],
        cwd: workspace.partnerDir,
        timeoutMs: CLI_DEADLINE_MS,
      });

      await waitForTerminal(manager, id);
      expectCliSucceeded(await partner, "exchange");

      const record = manager.getJob(id);
      if (record === undefined) throw new Error("the job left the slot");
      expect(pairsFromResultCsv(record.outputPath)).toEqual(CONSOLE_PAIRS);
      expect(pairsFromResultCsv(workspace.partnerOutput)).toEqual(
        PARTNER_PAIRS,
      );

      // The run continued the exchange under the key file beside the
      // configuration and left its rotated secret there, as a command-line run
      // does; it wrote no key file of its own.
      expect(mountedSharedSecret(workspace.mount)).not.toBe(secretBeforeRun);
      expect(
        mountedSharedSecret(workspace.mount) ===
          mountedSharedSecret(workspace.partnerDir),
      ).toBe(true);
      expect(existsSync(path.join(record.workdir, ".alcove.key"))).toBe(false);

      // The max-age policy the console composed is the one the CLI stamped the
      // rotated secret with, as a command-line run under the same policy does.
      const { expires } = parseSensitiveJson(
        readFileSync(path.join(workspace.mount, ".alcove.key"), "utf8"),
        "mounted key file",
      ) as { expires?: string };
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(Date.parse(expires ?? "")).toBeGreaterThanOrEqual(
        createdAt + thirtyDaysMs - 60_000,
      );
      expect(Date.parse(expires ?? "")).toBeLessThanOrEqual(
        Date.now() + thirtyDaysMs,
      );

      // The hand-off the same run composed is the configuration the operator
      // takes to cron: the terms the file stated, and the rendezvous folder as a
      // placeholder rather than the console's own mount.
      const handoff = manager.getJobHandoff(id);
      if (handoff?.template.kind !== "config")
        throw new Error("the run composed no configuration template");
      const exported = parseExchangeSpec(
        parseSensitiveYaml(handoff.template.yaml, "exported configuration"),
      );
      expect(exported.linkageTerms).toEqual(
        mountedDocumentOf(workspace.mount).linkageTerms,
      );
      expect(handoff.template.yaml).not.toContain(workspace.dropDir);
    });
  },
);

describe.skipIf(!cliIsBuilt)(
  "an opened configuration's maximum age, held by the real Alcove",
  () => {
    test("a run whose shared secret is past its expiry is refused", async () => {
      // The mount an operator has once a max-age policy stamped the key file
      // and the exchange then went unrun past that stamp. No partner is needed:
      // the run is refused before it reaches the shared folder.
      writeFileSync(
        workspace.mountedConfig,
        stringifyYaml(
          snakeizeKeys({
            connection: { channel: "filedrop", path: workspace.dropDir },
            linkageTerms: getDefaultLinkageTerms(CONSOLE_IDENTITY),
            authentication: { tokenMaxAgeDays: 30 },
          }),
        ),
      );
      writeFileSync(
        path.join(workspace.mount, ".alcove.key"),
        JSON.stringify({
          sharedSecret: "c".repeat(42) + "A",
          expires: "2020-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );

      const manager = consoleManager();
      const response = manager.openMountedConfiguration();
      if (response.document === undefined)
        throw new Error("the mount holds no configuration to open");
      const loaded = authoringStateFromDocument(response.document);
      const receipts = receiptsIntentFields({
        ...RECEIPTS_DEFAULT,
        ...loaded.receipts,
      });
      expect(receipts.tokenMaxAgeDays).toBe(30);

      const id = await manager.createJob({
        channel: "filedrop",
        side: "acceptor",
        linkageTerms: loaded.linkageTerms,
        inputFile: { name: "input.csv" },
        mountedConfigurationOpened: true,
        ...receipts,
      });

      const deadline = Date.now() + JOB_DEADLINE_MS;
      let record = manager.getJob(id);
      while (record?.terminal === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        record = manager.getJob(id);
      }
      if (record === undefined || record.terminal === null)
        throw new Error("the console run reached no terminal state");
      // The CLI's load-time refusal: a usage fault, before any exchange file.
      expect(record.terminal.outcome).not.toBe("succeeded");
      expect(record.terminal.exitCode).toBe(64);
      expect(JSON.stringify(record.events)).toContain(
        "remove the expired key file on both sides",
      );
      expect(readdirSync(workspace.dropDir)).toEqual([]);
      expect(
        JSON.parse(
          readFileSync(path.join(workspace.mount, ".alcove.key"), "utf8"),
        ),
      ).toMatchObject({ expires: "2020-01-01T00:00:00.000Z" });
    });
  },
);

/** The partner's input once it adds a column to what it sends: the rows of
 * {@link PARTNER_CSV}, each with its county. */
const PARTNER_CSV_WITH_COUNTY =
  "ssn,first_name,last_name,date_of_birth,county\n" +
  "111223333,bob,smith,1990-01-01,Adams\n" +
  "222334444,carol,jones,1985-11-30,Brown\n" +
  "333445555,dave,lee,1979-04-02,Clark\n";

/** The county the console's result must hold for each of its matched rows. */
const COUNTY_BY_CONSOLE_ROW: Record<string, string> = {
  "1": "Adams",
  "2": "Brown",
};

/**
 * The partner changes its terms the common way: it adds a column to its input
 * and sends it, declaring it in its metadata and its `payload.send`. The key
 * file is untouched, so the partnership is the same one.
 */
function partnerStartsSendingCounty(): void {
  writeFileSync(
    path.join(workspace.partnerDir, "input.csv"),
    PARTNER_CSV_WITH_COUNTY,
  );
  const config = parseSensitiveYaml(
    readFileSync(workspace.partnerConfig, "utf8"),
    "partner configuration",
  ) as {
    linkage_terms: { payload?: Record<string, unknown> };
    metadata: Array<Record<string, unknown>>;
  };
  config.metadata.push({
    name: "county",
    type: "other",
    role: "payload",
    is_payload: true,
  });
  config.linkage_terms.payload = {
    ...config.linkage_terms.payload,
    send: [{ name: "county" }],
  };
  writeFileSync(workspace.partnerConfig, stringifyYaml(config));
}

/** Run one console exchange against the partner's `alcove exchange`, and
 * resolve once both have exited, however each ended. */
async function runAgainstPartner(
  manager: JobManager,
  intent: JobFiledropExchangeIntent,
): Promise<{ record: JobRecord; partner: CliRun }> {
  const id = await manager.createJob(intent);
  const partner = startCli({
    args: ["exchange", "input.csv", "out.csv"],
    cwd: workspace.partnerDir,
    timeoutMs: CLI_DEADLINE_MS,
  });
  const deadline = Date.now() + JOB_DEADLINE_MS;
  let record = manager.getJob(id);
  while (record !== undefined && record.terminal === null) {
    if (Date.now() > deadline)
      throw new Error("the console run reached no terminal state");
    await new Promise((resolve) => setTimeout(resolve, 25));
    record = manager.getJob(id);
  }
  if (record === undefined) throw new Error("the job left the slot");
  return { record, partner: await partner };
}

function expectRunSucceeded(record: JobRecord): void {
  if (record.terminal?.outcome !== "succeeded")
    throw new Error(
      `the console run ended ${String(record.terminal?.outcome)}: ` +
        JSON.stringify(record.events.slice(-3)),
    );
}

/**
 * An exchange on the agreed terms, then the partner's change, then the
 * console's next run of the opened configuration: the run the partner's
 * change stops. `editIntent` stands for what the operator changed on the
 * console's pages before starting that run.
 */
async function runRefusedOnPartnerChange(
  manager: JobManager,
  editIntent: (
    intent: JobFiledropExchangeIntent,
  ) => JobFiledropExchangeIntent = (intent) => intent,
): Promise<JobRecord> {
  const agreed = await runAgainstPartner(manager, intentFromOpen(manager));
  expectRunSucceeded(agreed.record);
  expectCliSucceeded(agreed.partner, "exchange");
  expect(await manager.deleteJob(agreed.record.id)).toBe(true);

  partnerStartsSendingCounty();
  const { record, partner } = await runAgainstPartner(
    manager,
    editIntent(intentFromOpen(manager)),
  );
  // The partner is refused by this side, which it reports as a partner
  // refusal rather than asking anything.
  if (partner.exitCode !== 76)
    throw new Error(
      `the partner's alcove exchange exited ${String(partner.exitCode)}, ` +
        `not with a partner refusal\n${partner.output}\n` +
        JSON.stringify(record.events.slice(-3)),
    );
  return record;
}

/** The refusal a partner's terms change ends a console run with, as the seat
 * reads it: the terms-change failure, stating a proposal the console holds. */
function expectTermsChangeRefusal(record: JobRecord): void {
  expect(record.terminal?.outcome).toBe("failed");
  expect(record.terminal?.exitCode).toBe(64);
  const terminal = record.events.at(-1)?.event;
  if (terminal === undefined) throw new Error("the run emitted no event");
  expect(terminal.type).toBe("error");
  expect(terminal.category).toBe("config");
  expect(terminal.message).toBe(TERMS_PROPOSAL_REFUSAL);
  const termsChange = relayedTermsChangeOf(terminal);
  expect(termsChange?.proposalWritten).toBe(true);
  expect(termsChange?.delta.received).toEqual({
    added: ["county"],
    removed: [],
  });
  expect(record.termsProposal).toBe("available");
  expect(existsSync(path.join(record.workdir, TERMS_PROPOSAL_FILE_NAME))).toBe(
    true,
  );
}

/**
 * The seat's Apply: its own client, `POST /api/jobs/:jobId/apply-terms`,
 * answered by the route's handler over the console's job manager, as the
 * console server answers it on loopback.
 */
async function applyThroughConsoleRoute(
  manager: JobManager,
  jobId: string,
): Promise<string> {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", workspace.mount);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const handlers = ApplyTermsRoute.options.server?.handlers as Record<
    string,
    (context: {
      request: Request;
      params: Record<string, string>;
    }) => Promise<Response>
  >;
  const fetchThroughRoute = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const match = /^\/api\/jobs\/([^/]+)\/apply-terms$/.exec(url.pathname);
    if (match === null) throw new Error(`no route for ${url.pathname}`);
    return handlers[init?.method ?? "GET"]({
      request: new Request(url, {
        ...init,
        headers: { host: "localhost" },
      }),
      params: { jobId: decodeURIComponent(match[1]) },
    });
  };
  return applyJobTermsProposal(jobId, fetchThroughRoute);
}

/** The console's result rows, each keyed by its header. */
function resultRows(resultPath: string): Array<Record<string, string>> {
  const [header, ...rows] = readFileSync(resultPath, "utf8").trim().split("\n");
  const columns = header.split(",");
  return rows.map((row) => {
    const cells = row.split(",");
    return Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
  });
}

describe.skipIf(!cliIsBuilt)(
  "a partner's terms change, met by a console run of the opened configuration",
  () => {
    test("the run is refused, Apply takes the change into alcove.yaml, and the next run links on it", async () => {
      await establishPartnership();
      const manager = consoleManager();
      const refused = await runRefusedOnPartnerChange(manager);
      expectTermsChangeRefusal(refused);

      const beforeApply = readFileSync(workspace.mountedConfig, "utf8");
      expect(await applyThroughConsoleRoute(manager, refused.id)).toBe(
        "applied",
      );
      expect(refused.termsProposal).toBe("applied");
      expect(readFileSync(workspace.mountedConfig, "utf8")).not.toBe(
        beforeApply,
      );
      const applied = mountedDocumentOf(workspace.mount);
      expect(applied.linkageTerms.payload?.receive).toEqual([
        { name: "county" },
      ]);
      expect(applied.expectedPayloadColumns).toEqual(["county"]);

      // The seat reopens the configuration before the next run, which then
      // runs on the terms the file took on.
      expect(await manager.deleteJob(refused.id)).toBe(true);
      const rerun = await runAgainstPartner(manager, intentFromOpen(manager));
      expectRunSucceeded(rerun.record);
      expectCliSucceeded(rerun.partner, "exchange");
      const rows = resultRows(rerun.record.outputPath);
      expect(rows.map((row) => [row.row_id, row.their_row_id])).toEqual(
        CONSOLE_PAIRS.map(([own, partner]) => [String(own), String(partner)]),
      );
      for (const row of rows)
        expect(row.county).toBe(COUNTY_BY_CONSOLE_ROW[row.row_id]);
    });

    test("a declined apply or a run whose terms were edited leaves alcove.yaml unchanged", async () => {
      await establishPartnership();
      const manager = consoleManager();
      const refused = await runRefusedOnPartnerChange(manager, (intent) => ({
        ...intent,
        linkageTerms: { ...intent.linkageTerms, date: "2026-07-12" },
      }));
      expectTermsChangeRefusal(refused);
      const beforeApply = readFileSync(workspace.mountedConfig, "utf8");

      // The run's terms are not the file's, so the change the seat showed is
      // not the one the file would take on: nothing runs.
      expect(await applyThroughConsoleRoute(manager, refused.id)).toBe(
        "run-terms-differ",
      );
      expect(readFileSync(workspace.mountedConfig, "utf8")).toBe(beforeApply);
      expect(refused.termsProposal).toBe("available");

      // The same proposal applied on the command line without
      // --consent-to-terms and nothing to answer the question: declined.
      const declined = await startCli({
        args: [
          "apply",
          `--config-file=${workspace.mountedConfig}`,
          `--key-file=${path.join(workspace.mount, ".alcove.key")}`,
          `@${path.join(refused.workdir, TERMS_PROPOSAL_FILE_NAME)}`,
        ],
        cwd: workspace.mount,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(declined, "apply");
      expect(declined.output).toContain(
        "update declined; the configuration was not changed",
      );
      expect(readFileSync(workspace.mountedConfig, "utf8")).toBe(beforeApply);
    });
  },
);
