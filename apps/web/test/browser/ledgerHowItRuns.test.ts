import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { Ledger } from "@exchange/Ledger";

import { createAppMount } from "./renderApp";

// The "How it runs" heading's info tooltip names the transports of the build
// that shows it: the hosted app runs in the browser, the console's server runs
// every exchange.

const build = vi.hoisted(() => ({ console: false }));

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).clientConfigMock(importOriginal, {
    isConsoleBuild: () => build.console,
  }),
);

const app = createAppMount();

afterEach(() => {
  app.unmount();
});

async function openHowItRunsTooltip(): Promise<void> {
  app.render(
    createElement(Ledger, {
      rows: [{ label: "How it runs", value: "SFTP" }],
    }),
  );
  await page.getByRole("button", { name: 'What "How it runs" means' }).hover();
}

describe("the ledger's How it runs tooltip", () => {
  test("the hosted app names the browser transport", async () => {
    build.console = false;
    await openHowItRunsTooltip();
    await expect
      .element(page.getByRole("tooltip"))
      .toHaveTextContent(
        "How the exchange runs: live between your two browsers, or through files on an SFTP server or shared folder using the command-line tool.",
      );
  });

  test("the console names its own transports and not the browser", async () => {
    build.console = true;
    await openHowItRunsTooltip();
    const tooltip = page.getByRole("tooltip");
    await expect
      .element(tooltip)
      .toHaveTextContent(
        "How the exchange runs: this console runs it, not your browser. It goes through files on an SFTP server or a shared folder, or live over WebRTC.",
      );
    expect(tooltip.element().textContent).not.toMatch(/two browsers/);
  });
});
