/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import {
  buildAdvancedTerms,
  seedAdvancedInvite,
} from "@psi/authoring/advancedInvite";
import { exportLinkageTerms } from "@psi/linkageTermsIO";

import { TermsImportExport } from "@components/TermsImportExport";

import { createAppMount } from "./renderApp";

import type { CleaningNotLoaded } from "@psi/authoring/advancedInvite";

const COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

const app = createAppMount();

function mountEditor(notLoaded: ReadonlyArray<CleaningNotLoaded> = []) {
  const { draft, seed } = seedAdvancedInvite("County Health Dept", COLUMNS);
  const currentTerms = buildAdvancedTerms(draft);
  app.render(
    createElement(TermsImportExport, {
      currentTerms,
      seed,
      rawRows: [],
      onImport: () => notLoaded,
    }),
  );
  return currentTerms;
}

const pasteBox = () =>
  page.getByRole("textbox", {
    name: "Paste a JSON or YAML linkage-terms document to import",
  });
const importButton = () => page.getByRole("button", { name: "Import" });

afterEach(app.unmount);

describe("TermsImportExport", () => {
  test("editing the paste box after a failed import clears the rejection alert", async () => {
    mountEditor();
    await userEvent.fill(pasteBox(), "not json or yaml: [");
    await userEvent.click(importButton());
    await expect
      .element(page.getByText("Could not import these terms"))
      .toBeInTheDocument();

    await userEvent.type(pasteBox(), " ");
    await expect
      .element(page.getByText("Could not import these terms"))
      .not.toBeInTheDocument();
    expect(page.getByRole("status").element().textContent).toBe("");
  });

  test("a valid import after a failed one succeeds without the stale error lingering", async () => {
    const currentTerms = mountEditor();
    await userEvent.fill(pasteBox(), "not json or yaml: [");
    await userEvent.click(importButton());
    await expect
      .element(page.getByText("Could not import these terms"))
      .toBeInTheDocument();

    await userEvent.clear(pasteBox());
    await userEvent.fill(pasteBox(), exportLinkageTerms(currentTerms, "json"));
    await userEvent.click(importButton());
    await expect
      .element(
        page
          .getByText("Imported. Review the loaded terms before you continue.")
          .first(),
      )
      .toBeInTheDocument();
    expect(page.getByText("Could not import these terms").query()).toBeNull();
  });

  test("states why each field's cleaning did not load", async () => {
    const currentTerms = mountEditor([
      { output: "middle_name", input: "middle", reason: "no-field" },
      { output: "ssn", input: "SSN_RAW", reason: "no-column" },
      { output: "first_name", input: "first_name", reason: "not-matching" },
      {
        output: "last_name",
        input: "dob",
        reason: "other-type",
        fieldType: "last_name",
      },
    ]);
    await userEvent.fill(pasteBox(), exportLinkageTerms(currentTerms, "json"));
    await userEvent.click(importButton());
    await expect
      .element(
        page.getByText("Some cleaning steps were not loaded", { exact: true }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("status").element().textContent).toBe(
      "Imported, but some cleaning steps were not loaded. " +
        "middle_name: these terms declare no field of that name. " +
        "ssn: your file has no column named SSN_RAW. " +
        "first_name: your column first_name is not used to match. Set it " +
        'to "Used to match - not sent" under Matching & sharing, then paste ' +
        "the configuration again. " +
        "last_name: your column dob is not a Last name column. Set its type " +
        "under Matching & sharing, then paste the configuration again. " +
        "Review the loaded terms before you continue.",
    );
  });
});
