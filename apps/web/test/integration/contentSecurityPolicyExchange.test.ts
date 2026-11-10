import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { chromium } from "playwright";

import { CSV_WORKER_FILE_BYTE_THRESHOLD } from "@psi/workers/csvParseController";
import { NON_EMPTY_WORKER_ROW_THRESHOLD } from "@psi/workers/nonEmptyAggregate";
import { contentSecurityPolicy } from "@utils/securityHeaders";

import { CSP_REPORT_PATH, startStaticHost } from "../staticHost/server.js";
import { browserDisableFeaturesSwitch } from "../../vite.config.ts";
import { serviceWorkerStringArray } from "../utils/serviceWorkerHarness";
import { startStandaloneBroker } from "../utils/standaloneBroker.ts";

import { hasHostedBuild, hostedOutput, webRoot } from "./prodServer.js";

import type { Browser, FileChooser, Page } from "playwright";
import type { StandaloneBroker } from "../utils/standaloneBroker.ts";
import type { StaticHost } from "../staticHost/server.js";

// The hosted production build, served with the Content-Security-Policy its
// `_headers` sends, runs a whole exchange between two browser parties in real
// Chromium, loads every route document, and starts each of its three workers,
// and the browser reports no violation of that policy from any page or worker.
// The host adds only a report endpoint to the policy. The inviter names a
// standalone broker under Connection settings, so the build's own coordination
// server is never dialled. Rebuild (`npm run build -w apps/web`) before
// re-running; CI always rebuilds first.

const SETUP_TIMEOUT_MS = 60_000;
// The bundle fetch, a CSV parse, and the invitation mint.
const LOAD_TIMEOUT_MS = 30_000;
// Re-renders off state the app already holds.
const STEP_TIMEOUT_MS = 15_000;
// Budget for the app to hydrate before the dropzone answers a click.
const HYDRATION_TIMEOUT_MS = 20_000;
const CHOOSER_PROBE_TIMEOUT_MS = 2_000;
const ACTION_TIMEOUT_MS = 5_000;
// The rendezvous, the key exchange, and a PSI round per linkage key of the
// default terms, on two parties sharing one machine.
const EXCHANGE_TIMEOUT_MS = 120_000;
// How long a violation the last step raised has to reach the report endpoint.
const REPORT_SETTLE_MS = 1_000;

const inviterFile = resolve(webRoot, "../../test_data/fake_data_1.csv");
const acceptorFile = resolve(webRoot, "../../test_data/fake_data_2.csv");

const POLICY_MESSAGE = /Content[- ]Security[- ]Policy/i;

/** Every route document the build writes, a record id in place of the
 * parameter route's placeholder, and a path only the fallback answers. */
const routeDocuments = [
  ...serviceWorkerStringArray("SHELL_ROUTES").map((route) =>
    route.replace(/\/_$/, "/abc123"),
  ),
  "/not-a-route/deeper",
];

const OFF_THREAD_CSV_NAME = "off-thread.csv";

/** Write the smallest CSV that both parses off the page (one byte over
 * CSV_WORKER_FILE_BYTE_THRESHOLD) and has its coverage swept off the page
 * (over NON_EMPTY_WORKER_ROW_THRESHOLD rows), and return its path. */
function writeOffThreadCsv(dir: string): string {
  const header = "ssn,first_name,last_name,dob\n";
  const row = "123456789,Alice,Smith,1990-01-02\n";
  const rows = Math.max(
    Math.ceil(
      (CSV_WORKER_FILE_BYTE_THRESHOLD + 1 - header.length) / row.length,
    ),
    NON_EMPTY_WORKER_ROW_THRESHOLD + 1,
  );
  const path = join(dir, OFF_THREAD_CSV_NAME);
  writeFileSync(path, header + row.repeat(rows));
  return path;
}

/** Record every browser message naming the policy, from `page` and from each
 * worker it starts. */
function recordPolicyMessages(
  page: Page,
  party: string,
  messages: Array<string>,
): void {
  const keep = (where: string, text: string): void => {
    if (POLICY_MESSAGE.test(text)) messages.push(`${party} ${where}: ${text}`);
  };
  page.on("console", (message) => keep("page", message.text()));
  page.on("pageerror", (error) => keep("page", error.message));
  page.on("worker", (worker) =>
    worker.on("console", (message) => keep(worker.url(), message.text())),
  );
}

/** Choose `path` through the dropzone's own file chooser, retrying only the
 * click that opens it: the chooser opens once hydration has attached the
 * handler, so a file set earlier is never lost. */
async function chooseFile(page: Page, label: string, path: string) {
  const dropzone = page.getByLabel(label);
  let chooser: FileChooser | undefined;
  await vi.waitFor(
    async () => {
      const opened = await Promise.all([
        page.waitForEvent("filechooser", { timeout: CHOOSER_PROBE_TIMEOUT_MS }),
        dropzone.click({ timeout: ACTION_TIMEOUT_MS }),
      ]);
      chooser = opened[0];
    },
    { timeout: HYDRATION_TIMEOUT_MS, interval: 200 },
  );
  if (chooser === undefined) throw new Error("no file chooser was captured");
  await chooser.setFiles(path);
}

describe.skipIf(!hasHostedBuild)(
  "the hosted build under its Content-Security-Policy",
  () => {
    let host: StaticHost | undefined;
    let broker: StandaloneBroker | undefined;
    let browser: Browser | undefined;

    beforeAll(async () => {
      host = await startStaticHost(hostedOutput, { collectCspReports: true });
      broker = await startStandaloneBroker("signaling broker setup failure:");
      browser = await chromium.launch({
        headless: true,
        args: [browserDisableFeaturesSwitch],
      });
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await browser?.close();
      await broker?.stop();
      await host?.close();
    }, SETUP_TIMEOUT_MS);

    test(
      "completes an exchange with no policy violation reported",
      async () => {
        if (host === undefined || broker === undefined || browser === undefined)
          throw new Error("setup did not finish");
        const base = host.origin;
        const reportsBefore = host.cspReports.length;
        const messages: Array<string> = [];

        const document = await fetch(`${base}/exchange`);
        await document.body?.cancel();
        expect(
          document.headers.get("content-security-policy"),
          "the build serves the current policy; rebuild if this fails",
        ).toBe(`${contentSecurityPolicy}; report-uri ${CSP_REPORT_PATH}`);

        const inviterContext = await browser.newContext({
          permissions: ["clipboard-read", "clipboard-write"],
        });
        const acceptorContext = await browser.newContext();
        try {
          const inviter = await inviterContext.newPage();
          recordPolicyMessages(inviter, "inviter", messages);
          await inviter.goto(`${base}/exchange`, {
            waitUntil: "load",
            timeout: LOAD_TIMEOUT_MS,
          });
          await chooseFile(inviter, "Your data file", inviterFile);
          await inviter
            .getByText("fake_data_1.csv")
            .first()
            .waitFor({ timeout: LOAD_TIMEOUT_MS });
          await inviter
            .getByLabel("Your name")
            .fill("Inviter Org", { timeout: ACTION_TIMEOUT_MS });
          await inviter
            .getByRole("button", { name: "Continue to matching & sharing" })
            .click({ timeout: STEP_TIMEOUT_MS });
          await inviter
            .getByRole("button", { name: "Continue to review & create" })
            .click({ timeout: STEP_TIMEOUT_MS });
          await inviter
            .getByLabel("Coordination server")
            .fill(`ws://127.0.0.1:${broker.port}${broker.path}/`, {
              timeout: STEP_TIMEOUT_MS,
            });
          await inviter
            .getByRole("button", { name: "Create the invitation" })
            .click({ timeout: STEP_TIMEOUT_MS });
          await inviter
            .getByRole("button", { name: "Copy invitation as a link" })
            .click({ timeout: LOAD_TIMEOUT_MS });
          const deepLink = await inviter.evaluate(() =>
            navigator.clipboard.readText(),
          );
          expect(deepLink).toContain("/accept#");

          const acceptor = await acceptorContext.newPage();
          recordPolicyMessages(acceptor, "acceptor", messages);
          await acceptor.goto(deepLink, {
            waitUntil: "load",
            timeout: LOAD_TIMEOUT_MS,
          });
          await acceptor
            .getByRole("button", { name: "Continue: consent & your file" })
            .click({ timeout: LOAD_TIMEOUT_MS });
          await acceptor
            .getByRole("checkbox", { name: "I have reviewed the terms" })
            .check({ timeout: STEP_TIMEOUT_MS });
          await acceptor
            .getByRole("textbox", { name: "Your name or agency" })
            .fill("Acceptor Org", { timeout: ACTION_TIMEOUT_MS });
          await acceptor
            .locator("input[type=file]")
            .setInputFiles(acceptorFile);
          await acceptor
            .getByText("fake_data_2.csv")
            .first()
            .waitFor({ timeout: LOAD_TIMEOUT_MS });
          await acceptor
            .getByRole("button", { name: "Accept and continue" })
            .click({ timeout: STEP_TIMEOUT_MS });
          await acceptor
            .getByRole("button", { name: "Start the exchange" })
            .click({ timeout: LOAD_TIMEOUT_MS });

          for (const party of [acceptor, inviter])
            await party
              .getByRole("heading", { name: "Exchange complete", level: 1 })
              .waitFor({ timeout: EXCHANGE_TIMEOUT_MS });
          await acceptor.waitForTimeout(REPORT_SETTLE_MS);
        } catch (error) {
          // A blocked script usually ends the exchange early, so the step that
          // timed out names the violation it followed.
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
              `policy violations reported: ${JSON.stringify(
                [...host.cspReports.slice(reportsBefore), ...messages],
                null,
                2,
              )}`,
            { cause: error },
          );
        } finally {
          await inviterContext.close();
          await acceptorContext.close();
        }

        expect(host.cspReports.slice(reportsBefore)).toEqual([]);
        expect(messages).toEqual([]);
      },
      SETUP_TIMEOUT_MS + LOAD_TIMEOUT_MS * 6 + EXCHANGE_TIMEOUT_MS * 2,
    );

    test(
      "loads every route document and starts the CSV workers with no policy violation reported",
      async () => {
        if (host === undefined || browser === undefined)
          throw new Error("setup did not finish");
        const reportsBefore = host.cspReports.length;
        const messages: Array<string> = [];
        const workerUrls: Array<string> = [];
        const context = await browser.newContext();
        const tempDir = mkdtempSync(join(tmpdir(), "alcove-csp-workers-"));
        try {
          const page = await context.newPage();
          recordPolicyMessages(page, "visitor", messages);
          page.on("worker", (worker) => workerUrls.push(worker.url()));
          for (const route of routeDocuments) {
            await page.goto(`${host.origin}${route}`, {
              waitUntil: "load",
              timeout: LOAD_TIMEOUT_MS,
            });
            await page.locator("h1").first().waitFor({
              timeout: LOAD_TIMEOUT_MS,
            });
          }

          await page.goto(`${host.origin}/exchange`, {
            waitUntil: "load",
            timeout: LOAD_TIMEOUT_MS,
          });
          await chooseFile(page, "Your data file", writeOffThreadCsv(tempDir));
          await page
            .getByText(OFF_THREAD_CSV_NAME)
            .first()
            .waitFor({ timeout: LOAD_TIMEOUT_MS });
          await page
            .getByLabel("Your name")
            .fill("Worker Check", { timeout: ACTION_TIMEOUT_MS });
          await page
            .getByRole("button", { name: "Continue to matching & sharing" })
            .click({ timeout: STEP_TIMEOUT_MS });
          await vi.waitFor(
            () => {
              for (const name of [
                "csvParse.worker",
                "nonEmptyAggregate.worker",
              ])
                expect(workerUrls.some((url) => url.includes(name))).toBe(true);
            },
            { timeout: LOAD_TIMEOUT_MS, interval: 200 },
          );
          await page.waitForTimeout(REPORT_SETTLE_MS);
        } finally {
          await context.close();
          rmSync(tempDir, { recursive: true, force: true });
        }

        expect(host.cspReports.slice(reportsBefore)).toEqual([]);
        expect(messages).toEqual([]);
      },
      LOAD_TIMEOUT_MS * (routeDocuments.length * 2 + 6) + HYDRATION_TIMEOUT_MS,
    );
  },
);
