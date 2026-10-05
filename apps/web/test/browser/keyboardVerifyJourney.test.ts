/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  buildExchangeRecord,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@alcove/core";

import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";

import { activate, control, tabTo, typeInto } from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectNoAccessibilityViolations } from "./accessibilityRules";

import type { ExchangeRecord, LinkageTerms } from "@alcove/core";

// The verify flow driven from the keyboard alone (keyboardOnly.ts): the record
// and its keys, the re-supplied files and terms, and the verdict, held to the
// rule scan (accessibilityRules.ts) at the incomplete, verified and failed
// verdicts. The fixture is verify.test.ts's single-key exchange.

const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  payload: { send: [{ name: "dose" }] },
};
const PARTNER_TERMS: LinkageTerms = {
  ...LOCAL_TERMS,
  identity: "Party B",
  payload: { send: [{ name: "clinic" }] },
};
const LOCAL_CONFIG = {
  linkage_terms: LOCAL_TERMS,
  metadata: [
    { name: "pid", type: "other", role: "identifier", is_payload: false },
    { name: "ssn", type: "ssn", role: "linkage", is_payload: false },
    { name: "dose", type: "other", role: "payload", is_payload: true },
  ],
};
const INPUT_CSV = "pid,dose\nP0,10mg\nP1,20mg\n";
const RESULT_CSV = "pid,their_row_id,clinic\nP0,1,south\nP1,0,north\n";

async function exchangeRecord() {
  return buildExchangeRecord({
    localTerms: LOCAL_TERMS,
    partnerTerms: PARTNER_TERMS,
    contributedLinkageFields: ["ssn"],
    outcome: "completed",
    certificateMismatchObserved: false,
    recordsExposed: 2,
    localPayloadSent: { columns: ["dose"], rows: [["10mg"], ["20mg"]] },
    partnerPayloadReceived: {
      columns: ["clinic"],
      rows: [["north"], ["south"]],
    },
    associationTable: [
      [0, 1],
      [1, 0],
    ],
    createdAt: "2026-01-02T03:04:05.000Z",
    receiptBinder: "YmluZGVy",
  });
}

/** Tabs to the file control `label` names and hands it `file`, then waits for
 * its chosen-file card. */
async function chooseFile(label: string, file: File): Promise<void> {
  await tabTo((focused) => focused.getAttribute("aria-label") === label);
  const input = document.activeElement?.querySelector('input[type="file"]');
  expect(input, `no file input under '${label}'`).not.toBeNull();
  await userEvent.upload(page.elementLocator(input as HTMLElement), file);
  await expect.element(page.getByText(file.name)).toBeInTheDocument();
}

/** Text typed through `userEvent.keyboard`, with the brackets it reads as key
 * names doubled so they type as themselves. */
function literalKeys(text: string): string {
  return text.replace(/[{[]/g, (bracket) => bracket + bracket);
}

async function expectVerdictFocused(title: string): Promise<void> {
  await expect
    .element(page.getByText(title, { exact: true }))
    .toBeInTheDocument();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-testid"))
    .toBe("verdict");
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

async function loadRecord(record: ExchangeRecord, keysJson: string) {
  app.render(createElement(VerifyReceiptScreen));
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Verify an exchange record");
  await chooseFile(
    "Exchange record",
    new File([serializeExchangeRecord(record)], "alcove-record-x.json", {
      type: "application/json",
    }),
  );
  await chooseFile(
    "Verification keys",
    new File([keysJson], "alcove-record-x.keys.json", {
      type: "application/json",
    }),
  );
}

async function resupplyFiles(): Promise<void> {
  // The closed disclosure's name runs on into its summary line.
  await activate(
    control("button", /^Re-supply your files to open the commitments/),
  );
  await chooseFile(
    "Your input CSV",
    new File([INPUT_CSV], "input.csv", { type: "text/csv" }),
  );
  await chooseFile(
    "Your result CSV",
    new File([RESULT_CSV], "result.csv", { type: "text/csv" }),
  );
}

// Both tests carry a 90 s timeout: the slowest full-suite run measured under
// container load (load average ~26 on 10 cores) took 57 s for the first, which
// types two terms documents key by key, so 90 s is a 1.6x margin over it.
test("verify: record, keys, re-supplied files and terms to a verified verdict, from the keyboard", async () => {
  const { record, keys } = await exchangeRecord();
  await loadRecord(record, serializeVerificationKeys(keys));
  expectNoAccessibilityViolations(app.container, { page: true });

  await activate(control("button", "Verify"));
  await expectVerdictFocused("Incomplete");
  expectNoAccessibilityViolations(app.container, { page: true });

  await resupplyFiles();
  await typeInto(
    control("textbox", "Your linkage terms"),
    literalKeys(JSON.stringify(LOCAL_CONFIG)),
  );
  await activate(control("button", "Load these terms"));
  await typeInto(
    control("textbox", "Your partner's linkage terms"),
    literalKeys(JSON.stringify(PARTNER_TERMS)),
  );
  await activate(control("button", "Load these terms"));
  await activate(control("button", "Verify with these files"));

  await expectVerdictFocused("Verified");
  expectNoAccessibilityViolations(app.container, { page: true });
}, 90_000);

test("verify: an altered record reaches the failed verdict, from the keyboard", async () => {
  const { record, keys } = await exchangeRecord();
  const original = record.commitments.localPayloadSent;
  const tampered: ExchangeRecord = {
    ...record,
    commitments: {
      ...record.commitments,
      localPayloadSent: (original[0] === "A" ? "B" : "A") + original.slice(1),
    },
  };
  await loadRecord(tampered, serializeVerificationKeys(keys));
  await resupplyFiles();
  await activate(control("button", "Verify with these files"));

  await expectVerdictFocused("Verification failed");
  expectNoAccessibilityViolations(app.container, { page: true });
}, 90_000);
