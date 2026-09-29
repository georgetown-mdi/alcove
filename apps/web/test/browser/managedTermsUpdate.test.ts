/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { getDefaultLinkageTerms, inferMetadata } from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  applyManagedExchangeSentColumns,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { ManagedTermsUpdate } from "@recurring/ManagedTermsUpdate";

import {
  MAKE_TERMS_UPDATE_LABEL,
  SAVE_SENT_COLUMNS_LABEL,
  TERMS_UPDATE_WITHHELD_TEXT,
} from "@recurring/managedTermsUpdateModel";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { Metadata } from "@alcove/core";
import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

/** The linkage columns, plus `notes` sent and `county` held back. */
const METADATA: Metadata = [
  ...inferMetadata(LINKAGE_COLUMNS, []),
  { name: "notes", type: "other", role: "payload", isPayload: true },
  { name: "county", type: "other", role: "ignored", isPayload: false },
];

function savedRecord(): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: {
          channel: "webrtc",
          host: "signaling.example.org",
          port: 3000,
          path: "/api/",
        },
        linkageTerms: getDefaultLinkageTerms(
          "County Health Dept",
          inferMetadata(LINKAGE_COLUMNS, []),
        ),
        metadata: METADATA,
      }),
      side: "inviter",
      sharedSecret: "A".repeat(43),
    }),
  );
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

function renderSection(
  record: RunnableManagedExchangeRecord,
  runInFlight: boolean,
): void {
  app.render(
    createElement(ManagedTermsUpdate, {
      record,
      runInFlight,
      onChanged: () => undefined,
    }),
  );
}

describe("changing a saved exchange's terms", () => {
  test("withholds the terms update and the column save while a run is in flight", async () => {
    const record = savedRecord();
    renderSection(record, true);

    await expect
      .element(page.getByText(TERMS_UPDATE_WITHHELD_TEXT["run-in-flight"]))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: MAKE_TERMS_UPDATE_LABEL }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("checkbox", { name: "county" }));
    await expect
      .element(page.getByRole("button", { name: SAVE_SENT_COLUMNS_LABEL }))
      .toBeDisabled();

    renderSection(record, false);
    await expect
      .element(page.getByRole("button", { name: MAKE_TERMS_UPDATE_LABEL }))
      .toBeInTheDocument();
  });

  test("starts the column choice again when the stored columns change", async () => {
    const record = savedRecord();
    renderSection(record, false);

    const notes = page.getByRole("checkbox", { name: "notes" });
    const county = page.getByRole("checkbox", { name: "county" });
    await expect.element(notes).toBeChecked();
    await expect.element(county).not.toBeChecked();
    await userEvent.click(notes);
    await expect.element(notes).not.toBeChecked();

    renderSection(
      runnableManagedExchangeOrRefuse(
        applyManagedExchangeSentColumns(record, ["notes", "county"]),
      ),
      false,
    );
    await expect.element(notes).toBeChecked();
    await expect.element(county).toBeChecked();
    await expect
      .element(page.getByRole("button", { name: SAVE_SENT_COLUMNS_LABEL }))
      .toBeDisabled();
  });
});
