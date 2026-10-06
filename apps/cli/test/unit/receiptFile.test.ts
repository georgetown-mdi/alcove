import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Capture writeDualSignedRecord's logger so the non-fatal "could not be written"
// WARN is asserted rather than leaked to the suite output. getLogger is the only
// @alcove/core export replaced; everything else stays real.
const logCapture = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("@alcove/core", async (importActual) => {
  const actual = await importActual<typeof import("@alcove/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: () => {},
      warn: (msg: string, ...args: unknown[]) => {
        logCapture.warnings.push([msg, ...args.map(String)].join(" "));
      },
      debug: () => {},
      error: () => {},
      trace: () => {},
    }),
  };
});

import { parseDualSignedRecord, type DualSignedRecord } from "@alcove/core";

import {
  receiptFilePathIn,
  writeDualSignedRecord,
} from "../../src/receiptFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-receipt-test-"));
  logCapture.warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal schema-valid dual-signed record (the certificates self-verify; these
// are the checked-in signing-cert vectors' identities, reused for a valid shape).
const certA = {
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
const record: DualSignedRecord = {
  version: "alcove-signed-receipt/v4",
  content: {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  },
  initiator: { certificate: certA, signature: "AAAA" },
  responder: {
    certificate: { ...certA, identity: "Party B" },
    signature: "AAAA",
  },
};

test("receiptFilePathIn is a filesystem-safe timestamped path in the folder", () => {
  const p = receiptFilePathIn(dir, "2026-06-06T01:02:03.456Z");
  expect(p).toBe(
    path.join(dir, "alcove-receipt-2026-06-06T01-02-03-456Z.json"),
  );
  expect(path.basename(p)).not.toContain(":");
  expect(receiptFilePathIn(".", "2026-06-06T01:02:03.456Z")).toBe(
    "alcove-receipt-2026-06-06T01-02-03-456Z.json",
  );
});

test("writeDualSignedRecord writes a parseable owner-only file in the folder", () => {
  const target = path.join(dir, "alcove-receipt-2026-01-01T00-00-00Z.json");
  expect(
    writeDualSignedRecord(record, dir, "2026-01-01T00:00:00Z", "test"),
  ).toBeUndefined();
  expect(fs.readdirSync(dir)).toEqual([path.basename(target)]);
  expect(fs.existsSync(target)).toBe(true);
  // The written file round-trips through the parser.
  const parsed = parseDualSignedRecord(
    JSON.parse(fs.readFileSync(target, "utf8")),
  );
  expect(parsed).toEqual(record);
  expect(logCapture.warnings).toHaveLength(0);
  // On POSIX the file is owner-only (0600).
  if (process.platform !== "win32") {
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test("writeDualSignedRecord warns rather than throws on a write failure", () => {
  // A path whose parent is a file, not a directory, makes the write fail; the
  // helper is non-fatal, so it warns and does not throw.
  const fileAsParent = path.join(dir, "afile");
  fs.writeFileSync(fileAsParent, "x");
  const target = receiptFilePathIn(fileAsParent, "2026-01-01T00:00:00Z");
  let failure: string | undefined;
  expect(() => {
    failure = writeDualSignedRecord(
      record,
      fileAsParent,
      "2026-01-01T00:00:00Z",
      "test",
    );
  }).not.toThrow();
  expect(logCapture.warnings.length).toBeGreaterThan(0);
  expect(logCapture.warnings[0]).toMatch(/could not be written/);
  // The returned message is the machine-interface half of the same failure: a
  // supervisor that reads only fd 3 and the exit code learns the receipt is
  // missing from it. It names the destination and no cause.
  expect(failure).toContain("the dual-signed record could not be written to");
  expect(failure).toContain(target);
});
