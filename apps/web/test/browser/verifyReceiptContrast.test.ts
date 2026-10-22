/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the verdict renders on its real painted
// backgrounds, which the contrast walk resolves.
import "@mantine/core/styles.css";

import {
  SIGNED_RECEIPT_VERSION,
  generateSigningIdentity,
  serializeDualSignedRecord,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@alcove/core";
import { buildExchangeRecord, signReceiptContent } from "@alcove/core/testing";

import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { sweepContrast, textContrast } from "./contrastSweep";

import type { DualSignedRecord, LinkageTerms } from "@alcove/core";
import type { ReceiptContent } from "@alcove/core/testing";

// The verify screen's states past its initial mount, which the route sweep
// (themeContrastSweep.test.ts) cannot reach: a verdict over a loaded signed
// receipt, and a half-supplied pair of re-supply CSVs. Each is swept whole,
// and the caution text the state exists to show is measured on its own, so the
// test fails if that text stops rendering rather than passing on its absence.

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

const UNANCHORED_GUIDANCE = "Nothing you supplied confirms whose certificates";
const ONE_CSV_WARNING =
  "Supply both the input and the result to open the commitments";
// One row status of each verdict tone the fixture below reaches.
const TONE_STATUSES = {
  verified: "Verifies over this receipt's content",
  failed: "Does not match",
  incomplete: "Not anchored",
} as const;

/** A record and its keys from one run, and a signed receipt from another run of
 * the same exchange, so the signed verdict holds a row of every tone. */
async function buildFixture() {
  const { record, keys } = await buildExchangeRecord({
    localTerms: LOCAL_TERMS,
    partnerTerms: PARTNER_TERMS,
    contributedLinkageFields: ["ssn"],
    outcome: "completed",
    certificateMismatchObserved: false,
    recordsExposed: 2,
    localPayloadSent: { columns: ["dose"], rows: [["10mg"], ["20mg"]] },
    partnerPayloadReceived: { columns: ["clinic"], rows: [["n"], ["s"]] },
    associationTable: [
      [0, 1],
      [1, 0],
    ],
    createdAt: "2026-01-02T03:04:05.000Z",
    receiptBinder: "cmVjb3JkUnVu",
  });
  const us = await generateSigningIdentity("Party A");
  const partner = await generateSigningIdentity("Party B");
  const content: ReceiptContent = {
    termsHash: record.termsHash,
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "cmVjZWlwdFJ1bg",
  };
  const signed: DualSignedRecord = {
    version: SIGNED_RECEIPT_VERSION,
    content,
    initiator: {
      certificate: us.certificate,
      signature: await signReceiptContent(us, content, "initiator"),
    },
    responder: {
      certificate: partner.certificate,
      signature: await signReceiptContent(partner, content, "responder"),
    },
  };
  return { record, keys, signed };
}

function file(name: string, content: string, type: string): File {
  return new File([content], name, { type });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

async function mountVerifyScreen(scheme: "light" | "dark"): Promise<void> {
  app.render(createElement(VerifyReceiptScreen), { forceColorScheme: scheme });
  await expect
    .element(
      page.getByRole("heading", {
        level: 1,
        name: "Verify an exchange record",
      }),
    )
    .toBeInTheDocument();
}

/** Hand `chosen` to the dropzone labelled `label`, and wait for its chosen-file
 * card. A disclosure panel's inputs enter the DOM a commit after it opens, so
 * the input is polled for. */
async function uploadTo(label: string, chosen: File): Promise<void> {
  const selector = `[aria-label="${label}"] input[type="file"]`;
  await expect.poll(() => document.querySelector(selector)).not.toBeNull();
  const input = document.querySelector(selector);
  if (input === null) throw new Error(`the '${label}' input left the DOM`);
  await userEvent.upload(page.elementLocator(input), chosen);
  await expect.element(page.getByText(chosen.name)).toBeInTheDocument();
}

/** Every element with a text node of its own matching `text`, each measured
 * against its floor. A text node matches when it contains `text`, or with
 * `exact` when it equals `text` once trimmed. */
function measuredText(text: string, { exact = false } = {}) {
  const shown = [...app.container.querySelectorAll<HTMLElement>("*")].filter(
    (el) =>
      [...el.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          (exact
            ? (node.textContent ?? "").trim() === text
            : (node.textContent ?? "").includes(text)),
      ),
  );
  return shown.map((el) => textContrast(el));
}

function expectSweepClean(): void {
  const { failures, unresolved } = sweepContrast(app.container);
  expect(failures).toEqual([]);
  expect(unresolved).toEqual([]);
}

async function loadRecordAndKeys({
  record,
  keys,
}: Pick<Awaited<ReturnType<typeof buildFixture>>, "record" | "keys">) {
  await uploadTo(
    "Exchange record",
    file("rec.json", serializeExchangeRecord(record), "application/json"),
  );
  await uploadTo(
    "Verification keys",
    file("rec.keys.json", serializeVerificationKeys(keys), "application/json"),
  );
}

describe(
  "verify receipt screen contrast (WCAG 2.1 AA)",
  { timeout: 40_000 },
  () => {
    for (const scheme of ["light", "dark"] as const) {
      test(`a signed receipt verdict and its guidance (${scheme})`, async () => {
        const fixture = await buildFixture();
        await mountVerifyScreen(scheme);
        await loadRecordAndKeys(fixture);
        await userEvent.click(
          page.getByRole("button", {
            name: "Check the partner's signatures with the signed receipt",
          }),
        );
        await uploadTo(
          "Signed receipt",
          file(
            "receipt.json",
            serializeDualSignedRecord(fixture.signed),
            "application/json",
          ),
        );
        await userEvent.click(
          page.getByRole("button", { name: "Verify with the signed receipt" }),
        );
        await expect
          .element(page.getByText(UNANCHORED_GUIDANCE, { exact: false }))
          .toBeInTheDocument();
        for (const status of Object.values(TONE_STATUSES))
          expect(measuredText(status, { exact: true }).length).toBeGreaterThan(
            0,
          );

        expectSweepClean();
        const guidance = measuredText(UNANCHORED_GUIDANCE);
        expect(guidance).toHaveLength(1);
        expect(guidance[0]?.ratio).toBeGreaterThanOrEqual(4.5);
      });

      test(`one of the two re-supply CSVs (${scheme})`, async () => {
        await mountVerifyScreen(scheme);
        await loadRecordAndKeys(await buildFixture());
        await userEvent.click(
          page.getByRole("button", {
            name: "Re-supply your files to open the commitments",
          }),
        );
        await uploadTo(
          "Your input CSV",
          file("input.csv", "pid,dose\nP0,10mg\nP1,20mg\n", "text/csv"),
        );
        await expect
          .element(page.getByText(ONE_CSV_WARNING).first())
          .toBeInTheDocument();

        expectSweepClean();
        // Shown in the re-supply section and again beside the disabled Verify.
        const warnings = measuredText(ONE_CSV_WARNING);
        expect(warnings).toHaveLength(2);
        for (const warning of warnings)
          expect(warning?.ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  },
);
