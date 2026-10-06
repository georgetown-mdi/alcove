import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Capture writeExchangeRecord's logger so the non-fatal "audit record could not
// be written" WARN is asserted (proving the failure is reported) rather than
// leaked to the suite output, and so the INFO lines the successful writes emit
// can be asserted for what they tell the operator. getLogger is the only
// @alcove/core export replaced; everything else stays real.
const logCapture = vi.hoisted(() => ({
  infos: [] as string[],
  warnings: [] as string[],
}));

vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: (msg: string, ...args: unknown[]) => {
        logCapture.infos.push([msg, ...args.map(String)].join(" "));
      },
      warn: (msg: string, ...args: unknown[]) => {
        logCapture.warnings.push([msg, ...args.map(String)].join(" "));
      },
      debug: () => {},
      error: () => {},
      trace: () => {},
    }),
  };
});

import {
  AGREED_TERMS_VERSION,
  getDefaultLinkageTerms,
  parseAgreedTerms,
  parseExchangeRecord,
  parseVerificationKeys,
  type AgreedTerms,
  type ExchangeRecord,
  type VerificationKeys,
} from "@alcove/core";

import {
  agreedTermsPathFor,
  keysPathFor,
  recordFilePathIn,
  recordPathsFor,
  writeExchangeRecord,
} from "../../src/recordFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-record-test-"));
  logCapture.infos.length = 0;
  logCapture.warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal but schema-valid record + verification-keys pair to write to disk.
const record: ExchangeRecord = {
  version: "alcove-exchange-record/v10",
  outcome: "completed",
  certificateMismatchObserved: false,
  createdAt: "2026-01-02T03:04:05.000Z",
  termsHash: "hQi6gjL9Z0RFtfz2TZVqXmUF1Cu8PaBFbClOJ9R8l_Q",
  localIdentity: "Party A",
  partnerIdentity: "Party B",
  governance: {
    algorithm: "psi",
    matchingBasis: [{ name: "ssn", type: "ssn" }],
    payloadSent: [],
    payloadReceived: [],
    matching: {
      localDeduplicate: false,
      partnerDeduplicate: false,
      cardinality: "one-to-one",
    },
  },
  recordsExposed: 5,
  resultSize: 2,
  bindingNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  commitments: {
    localPayloadSent: "We5eIlrtkWBUe1uSGrla5rvLs0YhGFPPVDjk4EPX2k8",
    partnerPayloadReceived: "IFfNSyYoX8tKe2k-o6TjmrS1sW1ndtpZjexzR-fZa5g",
  },
};

const keys: VerificationKeys = {
  version: "alcove-exchange-keys/v2",
  salts: {
    localPayloadSent: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    partnerPayloadReceived: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  },
};

test("keysPathFor swaps a .json suffix for .keys.json", () => {
  expect(keysPathFor("/tmp/rec.json")).toBe("/tmp/rec.keys.json");
  // A leading ./ is preserved so the paired record and keys paths match.
  expect(keysPathFor("./alcove-record-X.json")).toBe(
    "./alcove-record-X.keys.json",
  );
  // No .json suffix: append rather than mangle.
  expect(keysPathFor("/tmp/rec")).toBe("/tmp/rec.keys.json");
});

test("recordPathsFor names the record in the folder, stamped with its createdAt", () => {
  // The filename timestamp is the record's createdAt, not a separate clock
  // read, so the filename matches the timestamp recorded inside the file.
  expect(recordPathsFor("/tmp/out", "2026-06-06T01:02:03.456Z")).toEqual({
    recordFilePath: path.join(
      "/tmp/out",
      "alcove-record-2026-06-06T01-02-03-456Z.json",
    ),
    keysFilePath: path.join(
      "/tmp/out",
      "alcove-record-2026-06-06T01-02-03-456Z.keys.json",
    ),
  });
  expect(recordPathsFor(".", "2026-06-06T01:02:03.456Z")).toEqual({
    recordFilePath: "alcove-record-2026-06-06T01-02-03-456Z.json",
    keysFilePath: "alcove-record-2026-06-06T01-02-03-456Z.keys.json",
  });
});

test("writeExchangeRecord writes both files, parseable and owner-only", () => {
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  const keysFilePath = keysPathFor(recordFilePath);
  expect(
    writeExchangeRecord(path.dirname(recordFilePath), record, keys, "test"),
  ).toEqual({ kind: "written", paths: { recordFilePath, keysFilePath } });

  // Both files exist and round-trip through the schema parsers.
  expect(
    parseExchangeRecord(JSON.parse(fs.readFileSync(recordFilePath, "utf8"))),
  ).toEqual(record);
  expect(
    parseVerificationKeys(JSON.parse(fs.readFileSync(keysFilePath, "utf8"))),
  ).toEqual(keys);

  // A completed run's line contains none of the terminated tail: it has no
  // disclosure-before-a-failure to report.
  expect(
    logCapture.infos.find((m) =>
      m.includes("wrote self-attested exchange record"),
    ),
  ).not.toContain("terminated");

  // Owner-only permissions on POSIX (mirrors saveKeyFile).
  if (process.platform !== "win32") {
    expect(fs.statSync(recordFilePath).mode & 0o077).toBe(0);
    expect(fs.statSync(keysFilePath).mode & 0o077).toBe(0);
  }
});

test("writeExchangeRecord is non-fatal when the destination is unwritable", () => {
  // A record path whose parent is a regular file cannot be created; the helper warns
  // rather than throws, so a successful exchange is never failed by an audit-write
  // problem. The return value still reports the loss to the caller -- what an
  // unattended run's machine-interface stream and exit code show when nobody reads
  // stderr. It names the destination, not the cause: the caller's sink already
  // escapes the log line's cause once.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const recordFilePath = recordFilePathIn(blocker, record.createdAt); // parent is a file
  let written: ReturnType<typeof writeExchangeRecord> | undefined;
  expect(() => {
    written = writeExchangeRecord(
      path.dirname(recordFilePath),
      record,
      keys,
      "test",
    );
  }).not.toThrow();
  expect(written?.kind).toBe("failed");
  const failure = written?.kind === "failed" ? written.message : undefined;
  expect(failure).toContain("the exchange record could not be written to");
  expect(failure).toContain(recordFilePath);
  expect(failure).toContain("need not be re-run");
  expect(fs.existsSync(recordFilePath)).toBe(false);
  // The non-fatal failure is reported as a WARN (asserting it both proves the
  // diagnostic fired and keeps it off the suite output).
  expect(
    logCapture.warnings.some((m) =>
      m.includes("the exchange record could not be written"),
    ),
  ).toBe(true);
});

// --- A terminated run's record -----------------------------------------------

/** The record a run that disclosed and then terminated without a receipt leaves
 * behind: the same shape and the same destination, saying so itself. */
const terminatedRecord: ExchangeRecord = {
  ...record,
  outcome: "receipt-swap-terminated",
};

test("a terminated run's record is written to the same destination", () => {
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  expect(
    writeExchangeRecord(
      path.dirname(recordFilePath),
      terminatedRecord,
      keys,
      "test",
    ).kind,
  ).toBe("written");
  expect(
    parseExchangeRecord(JSON.parse(fs.readFileSync(recordFilePath, "utf8"))),
  ).toEqual(terminatedRecord);
  expect(fs.existsSync(keysPathFor(recordFilePath))).toBe(true);

  // The line naming the file says what the record covers and names no failing
  // step: one outcome covers every way the post-disclosure region can end, so a
  // line naming the receipt swap would report a step to an operator whose run
  // was refused at the received-payload check before it -- or who configured no
  // signing identity, and had no swap to fail.
  const wrote = logCapture.infos.find((m) =>
    m.includes("wrote self-attested exchange record"),
  );
  expect(wrote).toBeDefined();
  expect(wrote).toContain("before the run terminated");
  expect(wrote).toContain("no receipt accompanies it");
  expect(wrote).not.toContain("swap");
  // This record observed no certificate mismatch, so the line says nothing
  // about the partner's certificate: the partner name in it is the
  // self-asserted value every record holds, with nothing to qualify.
  expect(wrote).not.toContain("certificate");
});

test("a record stating an observed certificate mismatch says so where the file is named", () => {
  // The one arm on which the record narrows who received the disclosure. An
  // operator reading the log line has to be told, since the partner name beside
  // it is one the run has positive grounds to doubt.
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  expect(
    writeExchangeRecord(
      path.dirname(recordFilePath),
      { ...terminatedRecord, certificateMismatchObserved: true },
      keys,
      "test",
    ).kind,
  ).toBe("written");

  const wrote = logCapture.infos.find((m) =>
    m.includes("wrote self-attested exchange record"),
  );
  expect(wrote).toContain("not the one pinned for them");
  expect(wrote).toContain("what they claimed");
});

test("a terminated run's lost record is not reported as a completed exchange", () => {
  // "The exchange and its results succeeded and need not be re-run" is the
  // completed run's remedy, and it is the wrong thing to tell an operator whose
  // run failed. The prose turns on the record's own outcome, so the file and the
  // words about it cannot disagree.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const recordFilePath = recordFilePathIn(blocker, record.createdAt);
  const written = writeExchangeRecord(
    path.dirname(recordFilePath),
    terminatedRecord,
    keys,
    "test",
  );
  expect(written.kind).toBe("failed");
  const failure = written.kind === "failed" ? written.message : undefined;
  expect(failure).toContain("the exchange record could not be written to");
  expect(failure).toContain("disclosed before it failed");
  expect(failure).not.toContain("need not be re-run");
  expect(
    logCapture.warnings.some((m) => m.includes("disclosed before it failed")),
  ).toBe(true);
});

// --- The agreed-terms file -----------------------------------------------------

const agreedTerms: AgreedTerms = {
  version: AGREED_TERMS_VERSION,
  localTerms: getDefaultLinkageTerms("Party A"),
  partnerTerms: getDefaultLinkageTerms("Party B"),
};

test("agreedTermsPathFor pairs the file with its record as the keys file is", () => {
  expect(agreedTermsPathFor("/tmp/rec.json")).toBe("/tmp/rec.terms.json");
  expect(agreedTermsPathFor("./alcove-record-X.json")).toBe(
    "./alcove-record-X.terms.json",
  );
  expect(agreedTermsPathFor("/tmp/rec")).toBe("/tmp/rec.terms.json");
});

test("writeExchangeRecord writes the agreed terms beside the record, owner-only", () => {
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  const termsFilePath = agreedTermsPathFor(recordFilePath);
  expect(
    writeExchangeRecord(
      path.dirname(recordFilePath),
      record,
      keys,
      "test",
      agreedTerms,
    ).kind,
  ).toBe("written");
  expect(
    parseAgreedTerms(JSON.parse(fs.readFileSync(termsFilePath, "utf8"))),
  ).toEqual(agreedTerms);
  if (process.platform !== "win32")
    expect(fs.statSync(termsFilePath).mode & 0o777).toBe(0o600);
  expect(logCapture.infos.join("\n")).toContain(
    `wrote both parties' agreed terms to ${termsFilePath}`,
  );
  expect(logCapture.warnings).toEqual([]);
});

test("a terminated run's record gets the agreed-terms file beside it", () => {
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  expect(
    writeExchangeRecord(
      path.dirname(recordFilePath),
      terminatedRecord,
      keys,
      "test",
      agreedTerms,
    ).kind,
  ).toBe("written");
  expect(
    parseAgreedTerms(
      JSON.parse(fs.readFileSync(agreedTermsPathFor(recordFilePath), "utf8")),
    ),
  ).toEqual(agreedTerms);
  expect(logCapture.warnings).toEqual([]);
});

test("an agreed-terms write that fails leaves the record written and says what to pass", () => {
  const recordFilePath = recordFilePathIn(dir, record.createdAt);
  // A directory where the file would go makes its rename fail.
  fs.mkdirSync(agreedTermsPathFor(recordFilePath));
  expect(
    writeExchangeRecord(
      path.dirname(recordFilePath),
      record,
      keys,
      "test",
      agreedTerms,
    ).kind,
  ).toBe("written");
  expect(fs.existsSync(recordFilePath)).toBe(true);
  expect(logCapture.warnings).toHaveLength(1);
  expect(logCapture.warnings[0]).toContain("could not be written");
  expect(logCapture.warnings[0]).toContain("the record is unaffected");
});
