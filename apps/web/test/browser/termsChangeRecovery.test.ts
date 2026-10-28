/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { APPLY_TERMS_LABEL } from "@console/termsChangeRecoveryModel";
import { TermsChangeRecovery } from "@console/TermsChangeRecovery";

import { createAppMount } from "./renderApp";
import { expectWorkingFolderCommandPerShell } from "./workingFolderCommandBlocks";

const JOB_ID = "job-1";

const app = createAppMount();

afterEach(() => {
  app.unmount();
  vi.unstubAllGlobals();
});

/** The console's apply endpoint, answering that the run used terms changed in
 * the console, the outcome whose copy names the command-line apply. */
function stubApplyRunTermsDiffer(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    if (String(input) !== `/api/jobs/${JOB_ID}/apply-terms`)
      return Promise.reject(new Error(`unexpected request ${String(input)}`));
    return Promise.resolve(
      new Response(JSON.stringify({ status: "run-terms-differ" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

describe("TermsChangeRecovery: applying the change from the command line", () => {
  test("names the apply as a run with a terminal, for each shell", async () => {
    stubApplyRunTermsDiffer();
    app.render(
      createElement(TermsChangeRecovery, {
        termsChange: {
          proposalWritten: true,
          delta: {
            received: undefined,
            sent: undefined,
            partnerDeduplicate: undefined,
            otherTerms: ["legal agreement"],
          },
        },
        jobId: JOB_ID,
        canApply: true,
        onApplied: () => undefined,
        onReviewApplied: () => undefined,
      }),
    );

    await page.getByRole("button", { name: APPLY_TERMS_LABEL }).click();

    await expect
      .element(
        page.getByText("Apply the change from the command line with", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    const blocks = expectWorkingFolderCommandPerShell(
      app.container,
      `apply @${JOB_ID}/alcove.proposed-terms`,
      { interactive: true },
    );
    expect(blocks.windows).toMatch(
      new RegExp(` apply "@${JOB_ID}/alcove\\.proposed-terms"$`),
    );
    // The announced sentence stays the sentence alone.
    expect(page.getByRole("status").element().textContent).not.toContain(
      "docker",
    );
  });

  test("names the proposal beside alcove.yaml for a run of the working folder's own file", async () => {
    stubApplyRunTermsDiffer();
    app.render(
      createElement(TermsChangeRecovery, {
        termsChange: {
          proposalWritten: true,
          delta: {
            received: undefined,
            sent: undefined,
            partnerDeduplicate: undefined,
            otherTerms: ["legal agreement"],
          },
        },
        jobId: JOB_ID,
        canApply: true,
        inWorkingFolder: true,
        onApplied: () => undefined,
        onReviewApplied: () => undefined,
      }),
    );

    await page.getByRole("button", { name: APPLY_TERMS_LABEL }).click();

    await expect
      .element(
        page.getByText("Apply the change from the command line with", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expectWorkingFolderCommandPerShell(
      app.container,
      " apply alcove.proposed-terms",
      { interactive: true },
    );
    expect(app.container.textContent).not.toContain(`@${JOB_ID}/`);
  });
});
