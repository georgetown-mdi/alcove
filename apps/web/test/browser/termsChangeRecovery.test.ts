/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { APPLY_TERMS_LABEL } from "@console/termsChangeRecoveryModel";
import { TermsChangeRecovery } from "@console/TermsChangeRecovery";

import { createAppMount } from "./renderApp";

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
  test("names the apply as a docker run with a terminal", async () => {
    stubApplyRunTermsDiffer();
    app.render(
      createElement(TermsChangeRecovery, {
        termsChange: {
          proposalWritten: true,
          delta: {
            received: undefined,
            sent: undefined,
            partnerDeduplicate: undefined,
            otherTerms: ["linkage rule set"],
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
    expect(app.container.textContent).toContain(
      "docker run --rm -it --mount " +
        "type=bind,src=/path/to/your/working-folder,dst=/work ",
    );
    expect(app.container.textContent).toContain(
      ` apply @${JOB_ID}/alcove.proposed-terms`,
    );
  });
});
