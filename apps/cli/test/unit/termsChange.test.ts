import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import PSI from "@openmined/psi.js";
import {
  deriveAcceptedLinkageTerms,
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  OperatorConfigError,
  parseExchangeSpec,
  prepareForExchange,
  runExchange,
  TermsChangeRefusedError,
  termsStatingDeclaredPayloadSend,
  validateCompatibility,
} from "@alcove/core";
import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";
import type {
  ExchangeSpec,
  LinkageTerms,
  MessageConnection,
  Metadata,
  TermsChange,
} from "@alcove/core";

vi.mock("../../src/util/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/util/prompt")>(
    "../../src/util/prompt",
  );
  return {
    ...actual,
    promptConfirm: vi.fn(),
    promptConfirmOrClosed: vi.fn(),
  };
});

import { handler as applyHandler } from "../../src/commands/apply";
import { saveConfig } from "../../src/config";
import { buildErrorEvent, classifyTerminalError } from "../../src/eventStream";
import { saveKeyFile } from "../../src/keyFile";
import { termsChangeHandler, termsProposalPath } from "../../src/termsChange";
import { exitCodeForError } from "../../src/util/exit";
import { promptConfirm, promptConfirmOrClosed } from "../../src/util/prompt";
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
    interactive,
    log: getLogger("exchange"),
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
    expect(after.expectedPartnerDeduplicate).toBe(false);
    expect(fs.existsSync(termsProposalPath(setup.config))).toBe(false);
  });

  test("confirming never rewrites the deduplicate the configuration holds the partner to", async () => {
    promptConfirmMock.mockResolvedValue(true);
    const { error } = await settle(
      changeFor({ ...setup.partnerTerms, deduplicate: true }),
      true,
    );
    expect(error).toBeUndefined();
    const after = readSpec(setup.config);
    expect(receivedColumns(after)).toEqual(["notes", "county"]);
    expect(after.expectedPartnerDeduplicate).toBe(false);
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

    // The command the refusal names applies the proposal, answered at a
    // terminal.
    vi.mocked(promptConfirmOrClosed).mockResolvedValue("yes");
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
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
      if (stdinIsTTY !== undefined)
        Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    const applied = readSpec(setup.config);
    expect(receivedColumns(applied)).toEqual(["notes", "county"]);

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
      ),
    ]);
    expect(partnerSide.status).toBe("fulfilled");
    expect(ownSide.status).toBe("fulfilled");
  });
});

// --- A partner's deduplicate met at the terms exchange ----------------------

const psiLibrary = await PSI();

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

// Agency B's run from its configuration, with the real handler, against
// Agency A's run under `partnerTerms`; B's frames are captured.
async function exchangeWithPartner(
  partnerTerms: LinkageTerms,
  interactive: boolean,
) {
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
  const spec = readSpec(setup.config);
  const bMetadata = spec.metadata!;
  const bPrepared = prepareForExchange(
    spec,
    "Agency B",
    rowsFor(bMetadata, "b"),
    bMetadata.map(({ name }) => name),
  );
  bPrepared.expectedPartnerDeduplicate = spec.expectedPartnerDeduplicate;
  const aPrepared = prepareForExchange(
    { metadata: setup.partnerMetadata, linkageTerms: partnerTerms },
    "Agency A",
    rowsFor(setup.partnerMetadata, "a"),
    setup.partnerMetadata.map(({ name }) => name),
  );
  const stdio = captureStdio();
  try {
    const [, bOutcome] = await Promise.allSettled([
      runExchange(connA, "initiator", aPrepared, { psiLibrary }),
      runExchange(capturingB, "responder", bPrepared, {
        psiLibrary,
        onTermsChange: termsChangeHandler({
          configPath: setup.config,
          keyPath: setup.key,
          interactive,
          log: getLogger("exchange"),
        }),
      }),
    ]);
    return { bOutcome, bSent, stderr: stdio.stderrWrites.join("") };
  } finally {
    stdio.restore();
  }
}

describe("a partner that changes its deduplicate", () => {
  for (const interactive of [true, false])
    for (const changesColumns of [false, true])
      test(`is refused and written as a proposal (${interactive ? "attended" : "unattended"}, ${changesColumns ? "with" : "without"} a column change)`, async () => {
        promptConfirmMock.mockResolvedValue(true);
        const before = fs.readFileSync(setup.config, "utf8");
        const partnerTerms: LinkageTerms = {
          ...(changesColumns
            ? setup.partnerTerms
            : {
                ...setup.partnerTerms,
                payload: { send: [{ name: "notes" }] },
              }),
          deduplicate: true,
        };
        if (!changesColumns)
          setup.partnerMetadata = setup.partnerMetadata.map((column) =>
            column.name === "county"
              ? { ...column, isPayload: false, role: "ignored" as const }
              : column,
          );
        const { bOutcome, bSent, stderr } = await exchangeWithPartner(
          partnerTerms,
          interactive,
        );
        expect(bOutcome.status).toBe("rejected");
        const error = (bOutcome as PromiseRejectedResult).reason as Error;
        expect(error).toBeInstanceOf(OperatorConfigError);
        expect(exitCodeForError(error)).toBe(64);
        expect(error.message).toContain("deduplicate");
        expect(error.message).toContain("alcove apply");
        expect(promptConfirmMock).not.toHaveBeenCalled();
        expect(stderr).toContain("your partner's deduplicate: false -> true");
        expect(fs.existsSync(termsProposalPath(setup.config))).toBe(true);
        expect(fs.readFileSync(setup.config, "utf8")).toBe(before);
        expect(readSpec(setup.config).expectedPartnerDeduplicate).toBe(false);
        expect(
          bSent.every(
            (m) =>
              typeof m === "object" &&
              m !== null &&
              ("linkageTerms" in m || "decision" in m),
          ),
        ).toBe(true);
      });
});

describe("the event stream's error event", () => {
  test("states the change a refused run wrote as a proposal", async () => {
    const { error } = await settle(changeFor(setup.partnerTerms), false);
    expect(buildErrorEvent(error, "prepare").termsChange).toEqual({
      proposalWritten: true,
      received: { added: ["county"], removed: [] },
      otherTerms: [],
    });
  });

  test("states a change declined at the prompt, with no proposal written", async () => {
    promptConfirmMock.mockResolvedValue(false);
    const { error } = await settle(changeFor(setup.partnerTerms), true);
    expect(buildErrorEvent(error, "prepare").termsChange).toMatchObject({
      proposalWritten: false,
      received: { added: ["county"], removed: [] },
    });
  });

  test("states a change core refused before anything was written, escaped", () => {
    const refusal = new TermsChangeRefusedError("linkage terms differ", {
      received: { added: ["a\u202eb"], removed: [] },
      sent: undefined,
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["algorithm mismatch"],
    });
    expect(buildErrorEvent(refusal, "prepare").termsChange).toEqual({
      proposalWritten: false,
      received: { added: ["a\\u202eb"], removed: [] },
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["algorithm mismatch"],
    });
  });

  test("has no terms change on any other failure", () => {
    expect(
      "termsChange" in buildErrorEvent(new OperatorConfigError("x"), "prepare"),
    ).toBe(false);
  });
});
