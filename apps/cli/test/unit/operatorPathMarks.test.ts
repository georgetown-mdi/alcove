import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getLogger, operatorSuppliedSpans } from "@alcove/core";
import type {
  DualSignedRecord,
  ExchangeRecord,
  VerificationKeys,
} from "@alcove/core";

import { logOnlineBootstrapOutcome } from "../../src/onlineBootstrap";
import { writeDualSignedRecord } from "../../src/receiptFile";
import { recordFilePathIn, writeExchangeRecord } from "../../src/recordFile";
import { openInputSource } from "../../src/util/dataIo";

// Every message the record and receipt writers, the online-bootstrap summary
// and the CSV input reader compose about the OPERATOR's own path marks that
// path, so the display sink shows it as they typed it instead of escaping every
// separator and handing back a path they cannot copy into a command
// (packages/core/src/utils/operatorSuppliedText.ts).
//
// Each case below drives one converted sink and reads what it produced: the
// marked spans on the error for a refusal, the rendered line for a log sink.
// The fixture path holds backslashes on every platform -- native separators on
// Windows, and one directory name spelling them off it, where a backslash is a
// legal filename character -- so the NATIVE-separator case runs on Windows
// alone while every sink is still exercised wherever the suite runs.
//
// The two sinks reached only through a live bootstrap run are driven where that
// harness already exists: runOnlineBootstrap's re-gate refusal and its
// both-files-on-disk note in onlineBootstrap.test.ts, and the rotated-token
// save failure in protocol.test.ts, which pairs two authenticated parties.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-operator-path-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A path under the fixture directory holding backslashes, its parent created. */
function backslashedPath(name: string): string {
  const full =
    process.platform === "win32"
      ? path.join(dir, "alcove", name)
      : path.join(dir, `C:\\alcove\\${name}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** A folder whose path holds a backslash, as {@link backslashedPath}'s does. */
function backslashedFolder(): string {
  const full = backslashedPath("out");
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/** The same path as a fragment nobody marked reaches the operator. */
const escaped = (value: string): string => value.replaceAll("\\", "\\\\");

/** The fragments a refusal marks as the operator's own, read off the error. */
function markedFragments(thrown: unknown): string[] {
  const error = thrown as Error;
  return (operatorSuppliedSpans(error, error.message) ?? [])
    .filter((span) => span.operatorSupplied)
    .map((span) => span.text);
}

/**
 * One converted sink: what drives it, and a fragment of the copy it alone
 * writes, so a case that reached some other message fails rather than passing
 * on a path another line named.
 */
interface SinkCase<Outcome> {
  readonly name: string;
  readonly says: readonly string[];
  readonly drive: () => Promise<Outcome>;
}

/** A refusal: the error the driver raised, plus the path it names. */
interface RefusalOutcome {
  readonly filePath: string;
  readonly thrown: unknown;
}

/** A log line: every line the driver emitted, plus the paths it names. */
interface LineOutcome {
  readonly filePaths: readonly string[];
  readonly lines: readonly string[];
}

/** A logger stub for the functions that take one, with the lines it collected. */
function stubLog(): { log: ReturnType<typeof getLogger>; lines: string[] } {
  const lines: string[] = [];
  const collect = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    log: {
      info: collect,
      warn: collect,
      error: collect,
    } as unknown as ReturnType<typeof getLogger>,
  };
}

/** Collect every line a named logger emits at the levels these sinks use. */
function captureLines(loggerName: string): string[] {
  const logger = getLogger(loggerName);
  const lines: string[] = [];
  const collect = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(logger, "info").mockImplementation(collect);
  vi.spyOn(logger, "warn").mockImplementation(collect);
  return lines;
}

/**
 * Assert that the sink the case is about wrote the operator's path as they
 * typed it: the copy it alone writes is there, each path is there unescaped,
 * and no line the drive produced holds the escaped form.
 */
function expectPathsAsTyped(
  outcome: LineOutcome,
  says: readonly string[],
): void {
  const text = outcome.lines.join("\n");
  for (const phrase of says) expect(text).toContain(phrase);
  for (const filePath of outcome.filePaths) {
    expect(text).toContain(filePath);
    expect(text).not.toContain(escaped(filePath));
  }
}

/** Run `act`, returning what it threw. */
async function raised(act: () => unknown): Promise<unknown> {
  try {
    await act();
  } catch (err: unknown) {
    return err;
  }
  throw new Error("the driver raised nothing");
}

// --- the record and receipt writers ------------------------------------------

const RECORD: ExchangeRecord = {
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

const KEYS: VerificationKeys = {
  version: "alcove-exchange-keys/v2",
  salts: {
    localPayloadSent: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    partnerPayloadReceived: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  },
};

const CERTIFICATE = {
  version: "alcove-signing-cert/v3" as const,
  algorithm: "ecdsa-p256-sha256" as const,
  identity: "Party A",
  publicKey: {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: "UVw9brnjlrkE0_7Kf1T9zQzB6Ze_N13KUVrQpsO0A18",
    y: "RTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q",
  },
  signature:
    "CzgwEmZnlYhLunf5m3CK7WWpHiUlMeRW_hhdJmbaPiwbsuT0LPP0EJGcHskJMB7icXOXfuZ1DPlQlnkpqtVL4g",
};

const DUAL_SIGNED_RECORD: DualSignedRecord = {
  version: "alcove-signed-receipt/v4",
  content: {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  },
  initiator: { certificate: CERTIFICATE, signature: "AAAA" },
  responder: {
    certificate: { ...CERTIFICATE, identity: "Party B" },
    signature: "AAAA",
  },
};

// --- refusals ----------------------------------------------------------------

const REFUSALS: readonly SinkCase<RefusalOutcome>[] = [
  {
    name: "input CSV: a positional naming a file that is not there",
    says: ["does not exist"],
    drive: async () => {
      const filePath = backslashedPath("records.csv");
      return {
        filePath,
        thrown: await raised(() => openInputSource(filePath)),
      };
    },
  },
];

for (const { name, says, drive } of REFUSALS)
  test(`${name} marks the path it names`, async () => {
    const { filePath, thrown } = await drive();
    for (const phrase of says)
      expect((thrown as Error).message).toContain(phrase);
    expect(markedFragments(thrown)).toContain(filePath);
  });

// --- log lines ---------------------------------------------------------------

const LINES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "record file: the verification keys it wrote",
    says: ["wrote private verification keys to"],
    drive: async () => {
      const folder = backslashedFolder();
      const filePath = recordFilePathIn(folder, RECORD.createdAt);
      const lines = captureLines("record-marks");
      writeExchangeRecord(folder, RECORD, KEYS, "record-marks");
      return { filePaths: [filePath.replace(/\.json$/, ".keys.json")], lines };
    },
  },
  {
    name: "record file: the self-attested record it wrote",
    says: ["self-attested exchange record"],
    drive: async () => {
      const folder = backslashedFolder();
      const filePath = recordFilePathIn(folder, RECORD.createdAt);
      const lines = captureLines("record-marks");
      writeExchangeRecord(folder, RECORD, KEYS, "record-marks");
      return { filePaths: [filePath], lines };
    },
  },
  {
    name: "record file: the keys orphaned by a failed record write",
    says: ["were already written to"],
    drive: async () => {
      // A directory at the record's own path: the keys beside it are written
      // first and the record write then fails, leaving them to be named.
      const folder = backslashedFolder();
      const filePath = recordFilePathIn(folder, RECORD.createdAt);
      fs.mkdirSync(filePath);
      const lines = captureLines("record-marks");
      writeExchangeRecord(folder, RECORD, KEYS, "record-marks");
      return { filePaths: [filePath.replace(/\.json$/, ".keys.json")], lines };
    },
  },
  {
    name: "receipt file: the dual-signed record it wrote",
    says: ["wrote dual-signed exchange record"],
    drive: async () => {
      const filePath = backslashedPath("alcove-receipt.json");
      const lines = captureLines("receipt-marks");
      writeDualSignedRecord(
        { receiptFile: filePath },
        DUAL_SIGNED_RECORD,
        dir,
        "2026-01-01T00:00:00Z",
        "receipt-marks",
      );
      return { filePaths: [filePath], lines };
    },
  },
  {
    name: "bootstrap summary: the config and key a clean run wrote",
    says: ["saved config to"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      const keyFile = backslashedPath(".alcove.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, { configFile, keyFile });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
  {
    name: "bootstrap summary: the config a reuse run kept",
    says: ["reused the existing configuration at"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      const keyFile = backslashedPath(".alcove.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, {
        configFile,
        keyFile,
        reuseExistingConfig: true,
      });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
  {
    name: "bootstrap summary: the config a failed write left unwritten",
    says: ["but the configuration could not be written to"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      const keyFile = backslashedPath(".alcove.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, {
        configFile,
        keyFile,
        configWriteError: new Error("permission denied"),
      });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
];

for (const { name, says, drive } of LINES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathsAsTyped(await drive(), says);
  });

test("a log sink renders an operator path rather than interpolating it raw", async () => {
  // What the mark decides beyond the separators: the render replaces the
  // control class with a printable marker, so a path containing an escape
  // sequence cannot drive the terminal it is reported on. Interpolated raw, the
  // byte would reach the operator as it stands.
  const { log, lines } = stubLog();
  logOnlineBootstrapOutcome(log, {
    configFile: "/srv/\x1b[31mdrop/alcove.yaml",
    keyFile: ".alcove.key",
  });
  const text = lines.join("\n");
  expect(text).toContain("/srv/<1b>[31mdrop/alcove.yaml");
  expect(text).not.toContain("\x1b");
});
