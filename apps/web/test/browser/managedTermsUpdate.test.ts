/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  decodeTermsUpdate,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  applyManagedExchangeSentColumns,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedTermsUpdate } from "@recurring/ManagedTermsUpdate";

import {
  MAKE_TERMS_UPDATE_LABEL,
  READ_TERMS_UPDATE_LABEL,
  SAVE_SENT_COLUMNS_LABEL,
  TERMS_UPDATE_APPLIED_TEXT,
  TERMS_UPDATE_INPUT_LABEL,
  TERMS_UPDATE_NOT_APPLIED_TEXT,
  TERMS_UPDATE_WITHHELD_TEXT,
} from "@recurring/managedTermsUpdateModel";
import { ACCEPT_TERMS_CHANGE_LABEL } from "@recurring/managedTermsChangeModel";

import {
  CLI_TERMS_UPDATE,
  CLI_TERMS_UPDATE_SECRET,
} from "../utils/cliTermsUpdateFixture";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

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
  onChanged: () => void = () => undefined,
): void {
  app.render(
    createElement(ManagedTermsUpdate, { record, runInFlight, onChanged }),
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
    await expect
      .element(page.getByRole("button", { name: READ_TERMS_UPDATE_LABEL }))
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

describe("applying a partner's terms update", () => {
  beforeEach(clearManagedExchanges);
  afterEach(clearManagedExchanges);

  /** Agency B, which accepted Agency A's terms while A sent only `notes`. */
  async function storedAgencyB(): Promise<RunnableManagedExchangeRecord> {
    const { linkageTerms } = await decodeTermsUpdate(
      CLI_TERMS_UPDATE,
      CLI_TERMS_UPDATE_SECRET,
    );
    return runnableManagedExchangeOrRefuse(
      await createManagedExchange({
        label: "Riverbend quarterly",
        exchangeFile: composeManagedExchangeFile({
          connection: {
            channel: "webrtc",
            host: "signaling.example.org",
            port: 3000,
            path: "/api/",
          },
          linkageTerms: deriveAcceptedLinkageTerms(
            { ...linkageTerms, payload: { send: [{ name: "notes" }] } },
            "Agency B",
          ),
          metadata: inferMetadata(LINKAGE_COLUMNS, []),
          expectedPartnerDeduplicate: false,
        }),
        side: "acceptor",
        sharedSecret: CLI_TERMS_UPDATE_SECRET,
      }),
    );
  }

  test("shows the change an update from the command line makes and saves it on Accept", async () => {
    const record = await storedAgencyB();
    const onChanged = vi.fn();
    renderSection(record, false, onChanged);

    await userEvent.fill(
      page.getByLabelText(TERMS_UPDATE_INPUT_LABEL),
      CLI_TERMS_UPDATE,
    );
    await userEvent.click(
      page.getByRole("button", { name: READ_TERMS_UPDATE_LABEL }),
    );
    await expect
      .element(page.getByText("Columns your partner now sends you"))
      .toBeInTheDocument();
    await expect.element(page.getByText("county")).toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: ACCEPT_TERMS_CHANGE_LABEL }),
    );

    await expect
      .element(page.getByText(TERMS_UPDATE_APPLIED_TEXT))
      .toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(
      (
        await getManagedExchange(record.id)
      )?.exchangeFile.linkageTerms.payload?.receive?.map(({ name }) => name),
    ).toEqual(["notes", "county"]);
  });

  test("hides the change and Accept once the pasted text is edited", async () => {
    const record = await storedAgencyB();
    renderSection(record, false);
    const input = page.getByLabelText(TERMS_UPDATE_INPUT_LABEL);

    await userEvent.fill(input, CLI_TERMS_UPDATE);
    await userEvent.click(
      page.getByRole("button", { name: READ_TERMS_UPDATE_LABEL }),
    );
    await expect
      .element(page.getByRole("button", { name: ACCEPT_TERMS_CHANGE_LABEL }))
      .toBeInTheDocument();

    await userEvent.fill(input, `${CLI_TERMS_UPDATE}x`);
    await expect
      .element(page.getByRole("button", { name: ACCEPT_TERMS_CHANGE_LABEL }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Columns your partner now sends you"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: READ_TERMS_UPDATE_LABEL }))
      .toBeInTheDocument();
    expect(await getManagedExchange(record.id)).toEqual(record);
  });

  test("names what is wrong with a malformed update and changes nothing", async () => {
    expectConsole(
      "error",
      "ManagedTermsUpdateNotAppliedError: the terms update was not applied to this exchange: format",
    );
    const record = await storedAgencyB();
    renderSection(record, false);

    await userEvent.fill(
      page.getByLabelText(TERMS_UPDATE_INPUT_LABEL),
      "not a terms update",
    );
    await userEvent.click(
      page.getByRole("button", { name: READ_TERMS_UPDATE_LABEL }),
    );

    await expect
      .element(page.getByText(TERMS_UPDATE_NOT_APPLIED_TEXT.format))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: ACCEPT_TERMS_CHANGE_LABEL }))
      .not.toBeInTheDocument();
    expect(await getManagedExchange(record.id)).toEqual(record);
  });
});
