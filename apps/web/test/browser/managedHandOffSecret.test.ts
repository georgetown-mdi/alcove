/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import {
  clearManagedExchanges,
  listManagedExchanges,
} from "@psi/managed/managedExchangeStore";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { InviterScreen } from "@exchange/InviterScreen";
import { stagesFor } from "@exchange/exchangeRun";

import { createAppMount } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@alcove/core";
import type { RunCompletion } from "@psi/exchangeLifecycle";

// Saving a completed one-shot exchange as a recurring one hands it off to a
// managed record. The record's secret is the one the completed run's handshake
// rotated to, which both parties derived; the invitation's own secret is never
// what the record stores. The run is recorded rather than run, and completed by
// firing the callbacks the real lifecycle fires, rotated secret included; the
// deposit then lands in the real managed store.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

interface CapturedRun {
  sharedSecret: string;
  onStages: (stages: Array<unknown>) => void;
  onResult: (
    outputs: {
      kind: "matched";
      resultsUrl: string;
      matchedRecordCount: number;
    },
    completion: RunCompletion,
  ) => void;
}
const runs = vi.hoisted(() => ({ calls: [] as Array<unknown> }));
vi.mock("@psi/exchangeLifecycle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExchangeLifecycle: (options: unknown) => {
    runs.calls.push(options);
    return Promise.resolve();
  },
}));

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  window.location.hash = "";
  runs.calls.length = 0;
  await clearManagedExchanges();
});

const saveButton = () =>
  page.getByRole("button", { name: "Save as a recurring exchange" });

/** Complete the screen's one run, rotating to `rotatedSecret`, and return the
 * secret the run was started with. */
async function completeRun(rotatedSecret: string): Promise<string> {
  await vi.waitFor(() => expect(runs.calls).toHaveLength(1));
  const run = runs.calls[0] as CapturedRun;
  run.onStages(
    stagesFor(
      minimalPreparedExchange({
        linkageTerms: getDefaultLinkageTerms("Hand-off"),
      }),
    ),
  );
  run.onResult(
    {
      kind: "matched",
      resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
      matchedRecordCount: 2,
    },
    { rotatedSecret },
  );
  await expect.element(saveButton()).toBeInTheDocument();
  return run.sharedSecret;
}

/** Save the completed exchange and return the one record the store then holds. */
async function saveAndReadRecord() {
  await saveButton().click();
  await vi.waitFor(async () =>
    expect(await listManagedExchanges()).toHaveLength(1),
  );
  const [record] = await listManagedExchanges();
  return record;
}

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

describe("the managed record a one-shot hand-off deposits", () => {
  test("the inviter's record holds the run's rotated secret, not the invitation's", async () => {
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob\n" +
            "1,Ann,Lee,01/02/1990\n2,Bo,Ray,03/04/1985\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Your invitation is ready");

    const rotatedSecret = generateSharedSecret();
    const invitationSecret = await completeRun(rotatedSecret);
    const record = await saveAndReadRecord();

    expect(record.side).toBe("inviter");
    expect(record.sharedSecret).toBe(rotatedSecret);
    expect(record.sharedSecret).not.toBe(invitationSecret);
  });

  test("the acceptor's record holds the run's rotated secret, not the invitation's", async () => {
    const token: InvitationToken = {
      version: "1",
      linkageTerms: acceptorTerms,
      sharedSecret: generateSharedSecret(),
      connectionEndpoint: {
        channel: "webrtc",
        host: "127.0.0.1",
        port: 3000,
        path: "/api/",
      },
    };
    window.location.hash = await encodeInvitation(token);
    app.render(createElement(AcceptorScreen));
    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name\nAlice,Smith\n"], "cohort.csv", {
        type: "text/csv",
      }),
    );
    await expect.element(page.getByText("cohort.csv")).toBeInTheDocument();
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await page.getByRole("button", { name: "Start the exchange" }).click();

    const rotatedSecret = generateSharedSecret();
    const runSecret = await completeRun(rotatedSecret);
    expect(runSecret).toBe(token.sharedSecret);
    const record = await saveAndReadRecord();

    expect(record.side).toBe("acceptor");
    expect(record.sharedSecret).toBe(rotatedSecret);
    expect(record.sharedSecret).not.toBe(token.sharedSecret);
  });
});
