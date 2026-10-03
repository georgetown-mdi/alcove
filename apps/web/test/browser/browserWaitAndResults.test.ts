/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the spine renders with its real geometry: without
// it the Stepper's completed-step icon has no size bound and blankets the top
// bar, intercepting the clicks this walk makes.
import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@alcove/core";

import {
  PartnerNoShowError,
  waitForIncomingConnection,
} from "@psi/transport/waitForConnection";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { InviterScreen } from "@exchange/InviterScreen";
import { listenAsInviter } from "@psi/transport/rendezvous";
import { timeOfDayLabel } from "@exchange/exchangeRun";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

import type * as WaitForConnectionModule from "@psi/transport/waitForConnection";
import type { InvitationToken, LinkageTerms } from "@alcove/core";

// The browser seats' waiting, resuming, and leaving: the listening deadline the
// share screen states, the no-show each seat shows with Keep waiting, the
// invitation a reload can wait on again, the confirms that keep a completed
// run's downloads and a step's edits from being lost to one click, and the
// keep-open callout on both seats' runs.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/transport/waitForConnection", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitForConnectionModule>();
  return {
    ...actual,
    waitForIncomingConnection: vi.fn(actual.waitForIncomingConnection),
  };
});

// Stub the run lifecycle so a run never dials: each invocation's options are
// captured so a test can drive the same callbacks the real lifecycle fires, and
// call the seat's own acquire to reach the listening wait.
interface CapturedLifecycle {
  sharedSecret: string;
  acquire: (context: {
    signal: AbortSignal;
    onStage: (stageId: string) => void;
    onStages: (stages: Array<unknown>) => void;
    onPsiProgress: (progress: unknown) => void;
    onRunNotice: (message: string) => void;
  }) => Promise<unknown>;
  onResult: (outputs: unknown) => void;
  onError: (failure: { category: string; error: unknown }) => void;
}
const lifecycleHarness = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: unknown) => {
    lifecycleHarness.calls.push(options);
    return Promise.resolve();
  },
}));

function lifecycleCall(index: number): CapturedLifecycle {
  return lifecycleHarness.calls[index] as CapturedLifecycle;
}

const INVITER_CSV =
  "client_id,first_name,last_name,dob,program_code\n" +
  "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n";

function inviterFile(content = INVITER_CSV): File {
  return new File([content], "clients.csv", { type: "text/csv" });
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

async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

/** A matcher for text that holds `text` anywhere. */
function containing(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Whether the page would ask the operator to confirm leaving. */
function unloadWouldBeConfirmed(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Follow a download link without leaving the page or writing a file. */
function followDownload(name: RegExp) {
  const link = page.getByRole("link", { name }).element();
  const stop = (event: Event) => event.preventDefault();
  document.addEventListener("click", stop, { capture: true });
  try {
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  } finally {
    document.removeEventListener("click", stop, { capture: true });
  }
}

/** A matched run's outputs with a record, as the lifecycle hands them over. */
function matchedOutputs() {
  return {
    kind: "matched" as const,
    resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
    matchedRecordCount: 3,
    record: {
      recordUrl: URL.createObjectURL(new Blob(["{}"])),
      recordFileName: "alcove-record-2026-07-08T14-32.json",
      keysUrl: URL.createObjectURL(new Blob(["{}"])),
      keysFileName: "alcove-record-2026-07-08T14-32.keys.json",
    },
  };
}

const PENDING_KEY = "alcove-pending-invitation";

const app = createAppMount();

afterEach(() => {
  app.unmount();
  lifecycleHarness.calls.length = 0;
  vi.mocked(listenAsInviter).mockReset();
  window.sessionStorage.clear();
  window.location.hash = "";
});

/** Walk the inviting seat from an empty file step to its share screen. */
async function createInvitation() {
  app.render(createElement(InviterScreen));
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  await userEvent.upload(
    page.elementLocator(
      document.querySelector('input[type="file"]') as HTMLElement,
    ),
    inviterFile(),
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
  await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
}

/** Walk the accepting seat from its invitation link to a launched run. */
async function launchAccept() {
  window.location.hash = await encodeAcceptToken();
  app.render(createElement(AcceptorScreen));
  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await userEvent.click(
    page.getByRole("button", { name: "Continue: consent & your file" }),
  );
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  await userEvent.upload(
    page.elementLocator(
      document.querySelector('input[type="file"]') as HTMLElement,
    ),
    new File(["first_name,last_name\nAlice,Smith\n"], "cohort_intake.csv", {
      type: "text/csv",
    }),
  );
  await userEvent.click(
    page.getByRole("button", { name: "Accept and continue" }),
  );
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
  await userEvent.click(
    page.getByRole("button", { name: "Start the exchange" }),
  );
  await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
}

describe("the inviting seat's wait for its partner", () => {
  test("the share screen states the time the listening wait actually ends", async () => {
    await createInvitation();
    const peer = { on: vi.fn(), once: vi.fn(), off: vi.fn(), destroy: vi.fn() };
    vi.mocked(listenAsInviter).mockResolvedValue(peer as never);

    const controller = new AbortController();
    const waiting = lifecycleCall(0)
      .acquire({
        signal: controller.signal,
        onStage: () => undefined,
        onStages: () => undefined,
        onPsiProgress: () => undefined,
        onRunNotice: () => undefined,
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(peer.once).toHaveBeenCalled());

    const until = vi.mocked(waitForIncomingConnection).mock.lastCall?.[1]
      ?.until;
    if (until === undefined) throw new Error("the wait was given no deadline");
    const tenMinutes = 10 * 60 * 1000;
    expect(Math.abs(until.getTime() - (Date.now() + tenMinutes))).toBeLessThan(
      60 * 1000,
    );
    const callout = page.getByText(/^This page waits until /);
    await expect.element(callout).toBeInTheDocument();
    expect(
      callout
        .element()
        .textContent.startsWith(
          `This page waits until ${timeOfDayLabel(until)} for your partner to connect.`,
        ),
    ).toBe(true);

    controller.abort();
    await waiting;
  });

  test("a no-show gets its own copy and Keep waiting listens on the same invitation", async () => {
    await createInvitation();
    const waitedUntil = new Date(Date.now() - 1000);
    lifecycleCall(0).onError({
      category: "exchange",
      error: new PartnerNoShowError("nobody arrived", waitedUntil),
    });

    const alert = page.getByRole("alert");
    await expect
      .element(alert)
      .toMatchTextContent(containing("Your partner did not connect"));
    await expect
      .element(alert)
      .toMatchTextContent(
        containing(
          `Your partner did not connect by ${timeOfDayLabel(waitedUntil)}`,
        ),
      );
    expect(alert.element().textContent).not.toContain(
      "temporary connection problem",
    );
    await expect
      .element(alert)
      .toMatchTextContent(containing("Agree a time with your partner"));
    // The link stays on screen: the invitation is still good.
    await expect
      .element(page.getByRole("heading", { name: "Share this invitation" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Keep waiting" }).click();
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(2));
    expect(lifecycleCall(1).sharedSecret).toBe(lifecycleCall(0).sharedSecret);
    expect(page.getByRole("alert").query()).toBeNull();
  });
});

describe("the accepting seat's wait for its partner", () => {
  test("a no-show gets its own copy and Keep waiting dials the same invitation", async () => {
    await launchAccept();
    lifecycleCall(0).onError({
      category: "exchange",
      error: new PartnerNoShowError("nobody answered", new Date()),
    });

    const alert = page.getByRole("alert");
    await expect
      .element(alert)
      .toMatchTextContent(containing("Your partner's page did not answer"));
    await expect
      .element(alert)
      .toMatchTextContent(containing("It may have closed"));
    await expect
      .element(alert)
      .toMatchTextContent(
        containing("Ask your partner to open their invitation page"),
      );
    expect(alert.element().textContent).not.toContain(
      "temporary connection problem",
    );

    await page.getByRole("button", { name: "Keep waiting" }).click();
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(2));
    expect(lifecycleCall(1).sharedSecret).toBe(lifecycleCall(0).sharedSecret);
  });

  test("the run asks to keep the tab open", async () => {
    await launchAccept();
    await expect
      .element(page.getByText("Keep this tab open."))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Your browser is running the exchange with your partner. Closing or reloading this tab stops it for both of you.",
        ),
      )
      .toBeInTheDocument();
  });
});

describe("waiting again on an invitation after a reload", () => {
  test("the inviter is offered the invitation it created, and choosing the file again listens on it", async () => {
    await createInvitation();
    const original = lifecycleCall(0).sharedSecret;
    expect(window.sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    // The entry holds this party's settings and the invitation, never a row.
    expect(window.sessionStorage.getItem(PENDING_KEY)).not.toContain("Ann");

    // A reload drops the page and keeps this tab's session storage.
    app.unmount();
    lifecycleHarness.calls.length = 0;
    app.render(createElement(InviterScreen));

    await expect
      .element(
        page.getByRole("heading", { name: "Your invitation is still open" }),
      )
      .toBeInTheDocument();
    await userEvent.upload(
      page.getByLabelText("Choose clients.csv again"),
      inviterFile(),
    );

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Waiting for your partner");
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
    expect(lifecycleCall(0).sharedSecret).toBe(original);
    expect(unloadWouldBeConfirmed()).toBe(true);

    // Completing the run removes the kept invitation.
    lifecycleCall(0).onResult({
      kind: "counted",
      intersectionCount: 4,
      countReportedByPartner: true,
    });
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Exchange complete");
    await vi.waitFor(() =>
      expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull(),
    );
  });

  test("a file with other columns does not resume, and discarding removes the invitation", async () => {
    await createInvitation();
    app.unmount();
    app.render(createElement(InviterScreen));
    await expect
      .element(
        page.getByRole("heading", { name: "Your invitation is still open" }),
      )
      .toBeInTheDocument();

    await userEvent.upload(
      page.getByLabelText("Choose clients.csv again"),
      inviterFile("first_name,last_name\nAnn,Lee\n"),
    );
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(
        containing("This file does not match the invitation"),
      );

    await page.getByRole("button", { name: "Discard the invitation" }).click();
    expect(
      page
        .getByRole("heading", { name: "Your invitation is still open" })
        .query(),
    ).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("a failure the invitation cannot retry removes it before any start over, and a reload offers nothing", async () => {
    expectConsole("error", "Error: kex failed");
    await createInvitation();
    expect(window.sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });
    await expect
      .element(
        page.getByRole("button", {
          name: "Start over with a fresh invitation",
        }),
      )
      .toBeInTheDocument();
    await vi.waitFor(() =>
      expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull(),
    );

    app.unmount();
    app.render(createElement(InviterScreen));
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await flushPendingUpdates();
    expect(
      page
        .getByRole("heading", { name: "Your invitation is still open" })
        .query(),
    ).toBeNull();
  });

  test("starting over removes the kept invitation", async () => {
    expectConsole("error", "Error: kex failed");
    await createInvitation();
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });
    await page
      .getByRole("button", { name: "Start over with a fresh invitation" })
      .click();
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe("leaving a completed browser run", () => {
  test("the inviter is asked first while a download is untaken, naming what is left", async () => {
    await createInvitation();
    lifecycleCall(0).onResult(matchedOutputs());
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Exchange complete");
    expect(unloadWouldBeConfirmed()).toBe(true);

    await page.getByRole("button", { name: "Set up another exchange" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Leave without your downloads?",
    });
    await expect
      .element(dialog)
      .toMatchTextContent(
        containing(
          "You have not downloaded the result, the record, or the verification keys.",
        ),
      );
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));

    followDownload(/^Download result/);
    followDownload(/^Download record/);
    await page.getByRole("button", { name: "Set up another exchange" }).click();
    await expect
      .element(page.getByRole("dialog"))
      .toMatchTextContent(
        containing("You have not downloaded the verification keys."),
      );
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    followDownload(/^Download verification keys/);
    await expect
      .element(page.getByRole("link", { name: "Set up another exchange" }))
      .toBeInTheDocument();
    expect(unloadWouldBeConfirmed()).toBe(false);
  });

  test("the acceptor is asked first while a download is untaken", async () => {
    await launchAccept();
    lifecycleCall(0).onResult(matchedOutputs());
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Exchange complete");
    expect(unloadWouldBeConfirmed()).toBe(true);
    await page.getByRole("button", { name: "Set up another exchange" }).click();
    await expect
      .element(
        page.getByRole("dialog", { name: "Leave without your downloads?" }),
      )
      .toBeInTheDocument();
  });
});

describe("Reset to defaults", () => {
  test("the inviter's review step confirms, naming what resets", async () => {
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await userEvent.upload(
      page.elementLocator(
        document.querySelector('input[type="file"]') as HTMLElement,
      ),
      inviterFile(),
    );
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    const dialog = page.getByRole("dialog", { name: "Reset to defaults?" });
    await expect
      .element(dialog)
      .toMatchTextContent(containing("linkage keys, column types and sharing"));
    await userEvent.click(
      dialog.getByRole("button", { name: "Reset to defaults" }),
    );
    await expect
      .element(page.getByText("Reset to the default settings."))
      .toBeInTheDocument();
  });
});
