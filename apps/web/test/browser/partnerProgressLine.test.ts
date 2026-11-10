/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { SINGLE_PASS_STAGE_IDS } from "@alcove/core";

import {
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithPartnerProgress,
  runWithPsiProgress,
  runWithStage,
} from "@exchange/exchangeRun";
import { StatusPanel } from "@exchange/StatusPanel";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { ExchangeRun } from "@exchange/exchangeRun";

// What the operator reads while waiting on a partner's crypto operation: the
// partner's figure under the stage label, outside the announced region, gone
// once this party's own operation or the end of the run takes the panel, and
// never anything but an integer from 0 to 100.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

const FIGURE_TEXT = "Your partner is matching records";

function waitingRun(): ExchangeRun {
  return runWithStage(
    initialRun(),
    SINGLE_PASS_STAGE_IDS.encryptingPartnerData,
    new Date(),
  );
}

async function mountedText(
  run: ExchangeRun,
  flags: { done: boolean; halted: boolean } = { done: false, halted: false },
): Promise<string> {
  app.render(createElement(StatusPanel, { run, ...flags }));
  return await vi.waitFor(() => {
    const text = app.container.textContent;
    if (text === "") throw new Error("the status panel is not mounted");
    return text;
  });
}

test("a waiting party reads the partner's figure, outside the announced region", async () => {
  const text = await mountedText(runWithPartnerProgress(waitingRun(), 40));

  expect(text).toContain("Your partner is matching records: 40% done");
  const announced = app.container.querySelector("[aria-live]");
  expect(announced?.textContent).not.toContain(FIGURE_TEXT);
});

test("the figure is gone once cleared", async () => {
  const cleared = runWithPartnerProgress(
    runWithPartnerProgress(waitingRun(), 40),
    undefined,
  );

  expect(await mountedText(cleared)).not.toContain(FIGURE_TEXT);
});

test("this party's own operation takes the line over the partner's figure", async () => {
  const running = runWithPsiProgress(
    runWithPartnerProgress(waitingRun(), 40),
    { operation: "processClientRequest", elements: 1204, state: "started" },
    new Date(),
  );

  const text = await mountedText(running);
  expect(text).toContain("1,204 values");
  expect(text).not.toContain(FIGURE_TEXT);
});

test("the figure is gone once the run completes or fails", async () => {
  const shown = runWithPartnerProgress(waitingRun(), 40);

  expect(
    await mountedText(runWithCompletion(shown, new Date()), {
      done: true,
      halted: false,
    }),
  ).not.toContain(FIGURE_TEXT);
  expect(
    await mountedText(runWithFailure(shown), { done: false, halted: true }),
  ).not.toContain(FIGURE_TEXT);
});

test.each([101, -1, 4.5, "42" as unknown as number])(
  "a figure of %s never reaches the screen",
  async (percent) => {
    const viaModel = runWithPartnerProgress(waitingRun(), percent);
    expect(viaModel.partnerPercent).toBeUndefined();
    expect(await mountedText(viaModel)).not.toContain(FIGURE_TEXT);

    // A run whose state holds the value anyway still renders no figure.
    const forced = { ...waitingRun(), partnerPercent: percent };
    expect(await mountedText(forced)).not.toContain(FIGURE_TEXT);
  },
);
