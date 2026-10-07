import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import {
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
} from "@alcove/core";
import type { ExchangeSpec, InvitationToken, LinkageTerms } from "@alcove/core";

import { PERSISTENCE_LOSS_EXIT_CODE } from "@alcove/cli-contract";

import {
  deriveAcceptedInvitationTerms,
  diffKeptLinkageTerms,
  termsUpdateWrite,
  writeAcceptanceRecordReportingLoss,
} from "../../src/acceptedTermsRecords";
import {
  persistExpectedPartnerDeduplicate,
  persistTermsUpdate,
  saveConfig,
} from "../../src/config";
import { type EventStreamEmitter } from "../../src/eventStream";

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

function sampleTerms(identity: string): LinkageTerms {
  return getDefaultLinkageTerms(identity, inferMetadata(LINKAGE_COLUMNS, []));
}

function sampleToken(
  overrides: Partial<InvitationToken> = {},
): InvitationToken {
  return {
    version: "1",
    linkageTerms: sampleTerms("Inviter Org"),
    sharedSecret: "A".repeat(43),
    ...overrides,
  };
}

function recordingLog(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => lines.push(message), lines };
}

let dir: string;
let configPath: string;
let exitCodeBeforeTest: typeof process.exitCode;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-accepted-terms-"));
  configPath = path.join(dir, "alcove.yaml");
  exitCodeBeforeTest = process.exitCode;
});

afterEach(() => {
  process.exitCode = exitCodeBeforeTest;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeKeptConfig(terms: LinkageTerms = sampleTerms("Acceptor Org")) {
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
}

// A kept configuration whose records are written in the camelCase spelling
// the loader also accepts.
function writeCamelCaseKeptConfig(): void {
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: sampleTerms("Acceptor Org"),
      expectedPartnerDeduplicate: true,
    }),
  );
}

const CAMEL_CASE_RECORD_KEYS = ["linkageTerms", "expectedPartnerDeduplicate"];

function readKeptConfig(): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
}

// --- deriveAcceptedInvitationTerms -------------------------------------------

test("deriveAcceptedInvitationTerms takes each record from the token", () => {
  const token = sampleToken({
    connectionEndpoint: {
      channel: "webrtc",
      host: "peer.example.org",
      path: "/psi",
      relay: { stun: ["stun:stun.example.org:3478"] },
    },
  });
  token.linkageTerms.deduplicate = true;

  const accepted = deriveAcceptedInvitationTerms(token, "Acceptor Org");

  expect(accepted.linkageTerms).toEqual(
    deriveAcceptedLinkageTerms(token.linkageTerms, "Acceptor Org"),
  );
  expect(accepted.linkageTerms.identity).toBe("Acceptor Org");
  expect(accepted.expectedPartnerDeduplicate).toBe(true);
  expect(accepted.invitationRelay).toEqual({
    stun: ["stun:stun.example.org:3478"],
  });
});

test("deriveAcceptedInvitationTerms leaves absent records undefined", () => {
  const accepted = deriveAcceptedInvitationTerms(
    sampleToken({
      connectionEndpoint: { channel: "filedrop", path: "/mnt/share" },
    }),
    "Acceptor Org",
  );
  expect(accepted.expectedPartnerDeduplicate).toBe(false);
  expect(accepted.invitationRelay).toBeUndefined();
});

// --- diffKeptLinkageTerms ----------------------------------------------------

function keptSpec(terms: LinkageTerms): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  };
}

test("diffKeptLinkageTerms returns no conflict for terms that agree", () => {
  const log = recordingLog();
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec(sampleTerms("Acceptor Org")),
    accepted: sampleTerms("Acceptor Org"),
    citationDriftAlternative: "decline-to-reuse",
    log,
  });
  expect(conflicts).toEqual([]);
  expect(log.lines).toEqual([]);
});

test("diffKeptLinkageTerms returns a conflict for a disagreeing agreement field", () => {
  const accepted = sampleTerms("Acceptor Org");
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec({
      ...sampleTerms("Acceptor Org"),
      linkageKeys: accepted.linkageKeys.slice(1),
    }),
    accepted,
    citationDriftAlternative: "decline-to-reuse",
    log: recordingLog(),
  });
  expect(conflicts.length).toBeGreaterThan(0);
});

test("diffKeptLinkageTerms warns on a soft mismatch without a conflict", () => {
  const log = recordingLog();
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec({ ...sampleTerms("Acceptor Org"), date: "2020-01-01" }),
    accepted: { ...sampleTerms("Acceptor Org"), date: "2021-01-01" },
    citationDriftAlternative: "decline-to-reuse",
    log,
  });
  expect(conflicts).toEqual([]);
  expect(log.lines.length).toBeGreaterThan(0);
});

function withPayloadNote(name: string, description: string): LinkageTerms {
  return {
    ...sampleTerms("Acceptor Org"),
    payload: { send: [{ name, description }] },
  };
}

test("diffKeptLinkageTerms keeps a configuration a re-invite differs from only in a payload description", () => {
  const log = recordingLog();
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec(withPayloadNote("note", "Case notes")),
    accepted: withPayloadNote("note", "Case notes, free text"),
    citationDriftAlternative: "decline-to-reuse",
    log,
  });
  expect(conflicts).toEqual([]);
  expect(log.lines).toEqual([]);
});

test("diffKeptLinkageTerms refuses a configuration a re-invite differs from in a linkage term", () => {
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec(withPayloadNote("note", "Case notes")),
    accepted: withPayloadNote("case_note", "Case notes"),
    citationDriftAlternative: "decline-to-reuse",
    log: recordingLog(),
  });
  expect(conflicts.map((c) => c.field)).toEqual(["payload"]);
});

// --- persistExpectedPartnerDeduplicate on a kept configuration --------------

test("persistExpectedPartnerDeduplicate rewrites a camelCase record under one spelling", () => {
  writeCamelCaseKeptConfig();
  persistExpectedPartnerDeduplicate(configPath, false);
  const raw = readKeptConfig();
  expect(raw).not.toHaveProperty("expectedPartnerDeduplicate");
  expect(raw["expected_partner_deduplicate"]).toBe(false);
  expect(parseExchangeSpec(raw).expectedPartnerDeduplicate).toBe(false);
});

// --- writeAcceptanceRecordReportingLoss --------------------------------------

test("writeAcceptanceRecordReportingLoss writes without reporting a loss", () => {
  writeKeptConfig();
  const log = recordingLog();
  const warning = vi.fn();
  const written = writeAcceptanceRecordReportingLoss(configPath, true, {
    log,
    eventStream: { warning } as unknown as EventStreamEmitter,
  });
  expect(written).toBe(true);
  expect(readKeptConfig().expected_partner_deduplicate).toBe(true);
  expect(log.lines).toEqual([]);
  expect(warning).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCodeBeforeTest);
});

test("writeAcceptanceRecordReportingLoss reports a lost write", () => {
  const clause = "recording the duplicate matching your partner declared";
  const log = recordingLog();
  const warning = vi.fn();
  const written = writeAcceptanceRecordReportingLoss(configPath, false, {
    log,
    eventStream: { warning } as unknown as EventStreamEmitter,
  });
  expect(written).toBe(false);
  expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
  expect(warning).toHaveBeenCalledTimes(1);
  const [source, notice] = warning.mock.calls[0] as [string, string];
  expect(source).toBe("persistenceLoss");
  expect(notice).toContain(clause);
  expect(notice).not.toContain("ENOENT");
  expect(log.lines).toHaveLength(1);
  expect(log.lines[0]).toContain(`${notice}: `);
  expect(log.lines[0]).toContain("ENOENT");
});

// --- termsUpdateWrite and persistTermsUpdate ---------------------------------

test("deriveAcceptedInvitationTerms keeps this party's own deduplicate where given", () => {
  const accepted = deriveAcceptedInvitationTerms(
    sampleToken(),
    "Acceptor Org",
    true,
  );
  expect(accepted.linkageTerms.deduplicate).toBe(true);
  expect(accepted.expectedPartnerDeduplicate).toBe(false);
});

test("termsUpdateWrite takes the terms and records from the accepted update", () => {
  const accepted = deriveAcceptedInvitationTerms(sampleToken(), "Acceptor Org");
  expect(termsUpdateWrite(accepted)).toEqual({
    linkageTerms: accepted.linkageTerms,
    expectedPartnerDeduplicate: false,
  });
});

test("persistTermsUpdate writes the terms and every record, keeping the rest of the file", () => {
  writeKeptConfig();
  const before = readKeptConfig();
  const terms: LinkageTerms = {
    ...sampleTerms("Acceptor Org"),
    algorithm: "psi",
  };
  persistTermsUpdate(configPath, {
    linkageTerms: terms,
    expectedPartnerDeduplicate: true,
  });
  const after = readKeptConfig();
  expect(after["connection"]).toEqual(before["connection"]);
  expect(after["expected_partner_deduplicate"]).toBe(true);
  expect(parseExchangeSpec(after).linkageTerms).toEqual(terms);
});

test("persistTermsUpdate replaces camelCase records instead of keeping them beside the update", () => {
  writeCamelCaseKeptConfig();
  const terms: LinkageTerms = {
    ...sampleTerms("Acceptor Org"),
    algorithm: "psi",
  };
  persistTermsUpdate(configPath, {
    linkageTerms: terms,
    expectedPartnerDeduplicate: false,
  });
  const raw = readKeptConfig();
  for (const key of CAMEL_CASE_RECORD_KEYS) expect(raw).not.toHaveProperty(key);
  const spec = parseExchangeSpec(raw);
  expect(spec.linkageTerms).toEqual(terms);
  expect(spec.expectedPartnerDeduplicate).toBe(false);
});

test("persistTermsUpdate refuses a document that would not load and leaves the file unchanged", () => {
  writeKeptConfig();
  const before = fs.readFileSync(configPath, "utf8");
  expect(() =>
    persistTermsUpdate(configPath, {
      linkageTerms: { ...sampleTerms("Acceptor Org"), linkageKeys: [] },
      expectedPartnerDeduplicate: false,
    }),
  ).toThrow("was left unchanged");
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
});
