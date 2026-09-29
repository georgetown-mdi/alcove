import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  OperatorConfigError,
  parseExchangeSpec,
  termsStatingDeclaredPayloadSend,
  validateCompatibility,
} from "@alcove/core";
import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";
import type {
  ExchangeSpec,
  LinkageTerms,
  Metadata,
  TermsChange,
} from "@alcove/core";

vi.mock("../../src/util/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/util/prompt")>(
    "../../src/util/prompt",
  );
  return { ...actual, promptConfirm: vi.fn() };
});

import { handler as applyHandler } from "../../src/commands/apply";
import { saveConfig } from "../../src/config";
import { classifyTerminalError } from "../../src/eventStream";
import { saveKeyFile } from "../../src/keyFile";
import { termsChangeHandler, termsProposalPath } from "../../src/termsChange";
import { exitCodeForError } from "../../src/util/exit";
import { promptConfirm } from "../../src/util/prompt";
import { captureProcessExit } from "../exitCapture";
import { captureStdio } from "../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirm);

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

interface Setup {
  dir: string;
  config: string;
  key: string;
  secret: string;
  // Agency A's terms as its run states them after its metadata added `county`.
  partnerTerms: LinkageTerms;
  partnerMetadata: Metadata;
}

let setup: Setup;

/**
 * Agency B's side of an established partnership that receives `notes` from
 * Agency A, whose metadata has since added `county`.
 */
function establish(): Setup {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-terms-change-"));
  const config = path.join(dir, "b.yaml");
  const key = path.join(dir, "b.key");
  const aTerms: LinkageTerms = {
    ...getDefaultLinkageTerms("Agency A", inferMetadata(LINKAGE_COLUMNS, [])),
    payload: { send: [{ name: "notes" }] },
  };
  const bTerms = deriveAcceptedLinkageTerms(aTerms, "Agency B");
  saveConfig(config, {
    connection: { channel: "filedrop", path: "/mnt/b" },
    linkageTerms: bTerms,
    metadata: metadataWith(),
    expectedPayloadColumns: ["notes"],
    expectedPartnerDeduplicate: false,
  });
  const secret = generateSharedSecret();
  saveKeyFile(key, { sharedSecret: secret });
  const partnerMetadata = metadataWith("notes", "county");
  return {
    dir,
    config,
    key,
    secret,
    partnerTerms: termsStatingDeclaredPayloadSend(aTerms, partnerMetadata),
    partnerMetadata,
  };
}

function readSpec(configPath: string): ExchangeSpec {
  return parseExchangeSpec(YAML.parse(fs.readFileSync(configPath, "utf8")));
}

/** The change core hands Agency B's run for Agency A's stated terms. */
function changeFor(
  partnerTerms: LinkageTerms,
  continuable = true,
): TermsChange {
  const local = readSpec(setup.config).linkageTerms;
  return {
    delta: validateCompatibility(local, partnerTerms).delta,
    partnerTerms,
    adoptedTerms: deriveAcceptedLinkageTerms(partnerTerms, "Agency B"),
    continuable,
  };
}

async function settle(
  change: TermsChange,
  interactive: boolean,
): Promise<{ error: unknown; stderr: string }> {
  const handler = termsChangeHandler({
    configPath: setup.config,
    keyPath: setup.key,
    existing: readSpec(setup.config),
    interactive,
    log: getLogger("exchange"),
    logFile: undefined,
  });
  const stdio = captureStdio();
  try {
    await handler(change);
    return { error: undefined, stderr: stdio.stderrWrites.join("") };
  } catch (error) {
    return { error, stderr: stdio.stderrWrites.join("") };
  } finally {
    stdio.restore();
  }
}

beforeEach(() => {
  setup = establish();
  promptConfirmMock.mockReset();
});

afterEach(() => {
  fs.rmSync(setup.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const receivedColumns = (spec: ExchangeSpec) =>
  spec.linkageTerms.payload?.receive?.map(({ name }) => name);

describe("an attended run", () => {
  test("shows the delta, and confirming writes the partner's terms into the configuration", async () => {
    promptConfirmMock.mockResolvedValue(true);
    const { error, stderr } = await settle(changeFor(setup.partnerTerms), true);
    expect(error).toBeUndefined();
    expect(stderr).toContain("columns your partner now sends you");
    expect(stderr).toContain("county");
    const after = readSpec(setup.config);
    expect(receivedColumns(after)).toEqual(["notes", "county"]);
    expect(after.expectedPayloadColumns).toEqual(["notes", "county"]);
    // What this party sends is not part of the change, so no consent to it is
    // recorded.
    expect(after.outboundPayloadConsent).toBeUndefined();
    expect(fs.existsSync(termsProposalPath(setup.config))).toBe(false);
  });

  test("declining ends the run and leaves the configuration as it was", async () => {
    promptConfirmMock.mockResolvedValue(false);
    const before = fs.readFileSync(setup.config, "utf8");
    const { error } = await settle(changeFor(setup.partnerTerms), true);
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect((error as Error).message).toMatch(/did not accept/);
    expect(exitCodeForError(error)).toBe(64);
    expect(classifyTerminalError(error, "prepare")).toBe("config");
    expect(fs.readFileSync(setup.config, "utf8")).toBe(before);
    expect(fs.existsSync(termsProposalPath(setup.config))).toBe(false);
  });

  test("terms the configuration could not load under are refused without asking", async () => {
    saveConfig(setup.config, {
      ...readSpec(setup.config),
      includeOwnColumns: "disclosed",
    });
    const before = fs.readFileSync(setup.config, "utf8");
    const change = changeFor(setup.partnerTerms);
    const { payload: _payload, ...adopted } = change.adoptedTerms;
    const { error } = await settle(
      {
        ...change,
        adoptedTerms: {
          ...adopted,
          algorithm: "psi-c",
          linkageKeys: adopted.linkageKeys.slice(0, 1),
        },
      },
      true,
    );
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect((error as Error).message).toContain("include_own_columns");
    expect(exitCodeForError(error)).toBe(64);
    expect(classifyTerminalError(error, "prepare")).toBe("config");
    expect(fs.readFileSync(setup.config, "utf8")).toBe(before);
  });

  test("a change this run cannot continue under is written as a proposal without asking", async () => {
    const { error } = await settle(changeFor(setup.partnerTerms, false), true);
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(fs.existsSync(termsProposalPath(setup.config))).toBe(true);
  });
});

describe("an unattended run", () => {
  test("refuses, writes the partner's terms beside the configuration, and names the command that applies them", async () => {
    const before = fs.readFileSync(setup.config, "utf8");
    const { error } = await settle(changeFor(setup.partnerTerms), false);
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(OperatorConfigError);
    expect(exitCodeForError(error)).toBe(64);
    expect(classifyTerminalError(error, "prepare")).toBe("config");
    const proposal = termsProposalPath(setup.config);
    expect(proposal).toBe(path.join(setup.dir, "b.proposed-terms"));
    expect((error as Error).message).toContain(
      `alcove apply --config-file ${setup.config} --key-file ${setup.key} @${proposal}`,
    );
    expect(fs.readFileSync(setup.config, "utf8")).toBe(before);

    // The command the refusal names applies the proposal.
    promptConfirmMock.mockResolvedValue(true);
    const exitSpy = captureProcessExit();
    const stdio = captureStdio();
    try {
      await applyHandler({
        _: ["apply"],
        $0: "alcove",
        "config-file": setup.config,
        "key-file": setup.key,
        "log-level": "info",
        args: [`@${proposal}`],
      } as unknown as Arguments);
    } finally {
      stdio.restore();
      exitSpy.mockRestore();
    }
    const applied = readSpec(setup.config);
    expect(receivedColumns(applied)).toEqual(["notes", "county"]);
    expect(applied.expectedPayloadColumns).toEqual(["notes", "county"]);

    // A re-run agrees terms with the partner with nothing left to take on.
    const [connA, connB] = createMessagePipe();
    const ownTerms = termsStatingDeclaredPayloadSend(
      applied.linkageTerms,
      applied.metadata!,
    );
    const [partnerSide, ownSide] = await Promise.allSettled([
      exchangeTerms(connA, "initiator", setup.partnerTerms, 3),
      exchangeTerms(
        connB,
        "responder",
        ownTerms,
        3,
        undefined,
        undefined,
        true,
        undefined,
        {
          expectedReceive: applied.expectedPayloadColumns,
        },
      ),
    ]);
    expect(partnerSide.status).toBe("fulfilled");
    expect(ownSide.status).toBe("fulfilled");
  });
});
