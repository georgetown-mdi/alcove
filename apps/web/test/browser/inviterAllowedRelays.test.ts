/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the spine renders with its real geometry: without
// it the Stepper's completed-step icon has no size bound and blankets the top
// bar, intercepting the clicks this walk makes.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@alcove/core";

import {
  CREATED_INVITATION_ALLOWED_RELAYS_SCOPE,
  allowedRelaysRunNotice,
} from "@psi/transport/relayRestriction";
import { InviterScreen } from "@exchange/InviterScreen";
import { PENDING_INVITATION_STORAGE_KEY } from "@exchange/pendingInvitationKey";
import { listenAsInviter } from "@psi/transport/rendezvous";
import { writeOwnRelaySetting } from "@psi/transport/ownRelaySetting";

import { createAppMount } from "./renderApp";

import { lifecycleCall, lifecycleCalls } from "./moduleMocks";

// The hosted inviter sets its exchange's own Allowed relays in the browser
// transport card of the review step. Creating the invitation commits them:
// the invitation names only the relays they keep, the waiting invitation's
// record keeps them for a reload, and the run lists only them. The run is
// recorded rather than run; its own acquire is called to reach the listen.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/exchangeLifecycle", async (importOriginal) =>
  (await import("./moduleMocks")).exchangeLifecycleMock(importOriginal),
);

const KEPT_URL = "turns:relay.example.org:443?transport=tcp";
const LEFT_OUT_URL = "turn:backup.example.net:3478";

const INVITER_CSV =
  "client_id,first_name,last_name,dob\n" +
  "1,Ann,Lee,01/02/1990\n2,Bo,Ray,03/04/1985\n";

const app = createAppMount();

afterEach(() => {
  app.unmount();
  lifecycleCalls.length = 0;
  vi.mocked(listenAsInviter).mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const allowedField = () =>
  page.getByRole("textbox", { name: "Allowed relays" });
const createButton = () =>
  page.getByRole("button", { name: "Create the invitation" });
const pageText = () => document.body.textContent;

/** Walk the inviting seat from an empty file step to its review step. */
async function openReview() {
  app.render(createElement(InviterScreen));
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  await userEvent.upload(
    page.elementLocator(
      document.querySelector('input[type="file"]') as HTMLElement,
    ),
    new File([INVITER_CSV], "clients.csv", { type: "text/csv" }),
  );
  await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  await page
    .getByRole("button", { name: "Continue to matching & sharing" })
    .click();
  await page
    .getByRole("button", { name: "Continue to review & create" })
    .click();
  await expect.element(allowedField()).toBeInTheDocument();
}

/** Create the invitation from the review step and wait for its run. */
async function create() {
  await createButton().click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Your invitation is ready");
  await vi.waitFor(() => expect(lifecycleCalls).toHaveLength(1));
}

/** The waiting invitation's record, and the TURN urls its token names. */
async function keptInvitation() {
  const record = JSON.parse(
    window.sessionStorage.getItem(PENDING_INVITATION_STORAGE_KEY) ?? "",
  ) as { encoded: string; allowedRelays?: Array<string> };
  const token = await decodeInvitation(record.encoded);
  const endpoint = token.connectionEndpoint;
  return {
    record,
    turn: endpoint?.channel === "webrtc" ? endpoint.relay?.turn : undefined,
  };
}

/** Call the run's own acquire up to its listen, and return what the listen
 * was given and what the run said. */
async function runListen() {
  vi.mocked(listenAsInviter).mockRejectedValue(new Error("not listening"));
  const notices: Array<string> = [];
  await lifecycleCall(0)
    .acquire({
      signal: new AbortController().signal,
      onCloseOutcome: () => undefined,
      onStage: () => undefined,
      onStages: () => undefined,
      onPsiProgress: () => undefined,
      onRunNotice: (notice) => notices.push(notice),
    })
    .catch(() => undefined);
  const options = vi.mocked(listenAsInviter).mock.lastCall?.[1];
  if (options === undefined) throw new Error("the run did not listen");
  return { options, notices };
}

describe("InviterScreen: the review's Allowed relays", () => {
  test("start empty whatever an earlier build stored for this browser", async () => {
    window.localStorage.setItem(
      "alcove-relay-restriction",
      JSON.stringify({ version: 1, allowedRelays: ["relay.example.org"] }),
    );
    await openReview();

    await expect.element(allowedField()).toHaveValue("");
    await expect.element(allowedField()).toBeEnabled();
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("a line the field refuses shows its error and holds the create until it is fixed", async () => {
    await openReview();
    const refusal = () => page.getByText(/^Line 1: enter /);

    await userEvent.fill(allowedField(), "turns:relay.example.org:443");
    await expect.element(refusal()).toBeInTheDocument();
    await expect.element(refusal()).not.toHaveAttribute("role", "alert");
    await expect
      .element(allowedField())
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(createButton()).toBeDisabled();
    expect(pageText()).toContain(
      "Resolve the allowed relays above to continue.",
    );
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);

    await userEvent.fill(allowedField(), "relay.example.org");
    await expect.poll(pageText).not.toContain("Line 1:");
    await expect.element(createButton()).toBeEnabled();
    expect(pageText()).toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("creating the invitation commits the list: the invitation, its waiting record and its run keep only the relays it names", async () => {
    writeOwnRelaySetting({ turn: [KEPT_URL, LEFT_OUT_URL], stun: [] });
    await openReview();
    await userEvent.fill(allowedField(), "Relay.Example.org");
    await create();

    const { record, turn } = await keptInvitation();
    expect(turn).toEqual([KEPT_URL]);
    expect(record.allowedRelays).toEqual(["relay.example.org"]);

    const { options, notices } = await runListen();
    expect(options.relay?.turn).toEqual([KEPT_URL]);
    expect(options.relaysLeftOut).toEqual([LEFT_OUT_URL]);
    expect(notices).toContain(
      allowedRelaysRunNotice([KEPT_URL], [LEFT_OUT_URL]),
    );
  });

  test("an empty field restricts nothing", async () => {
    writeOwnRelaySetting({ turn: [KEPT_URL, LEFT_OUT_URL], stun: [] });
    await openReview();
    await create();

    const { record, turn } = await keptInvitation();
    expect(turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(record).not.toHaveProperty("allowedRelays");

    const { options } = await runListen();
    expect(options.relay?.turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(options.relaysLeftOut).toEqual([]);
  });

  test("Back from the created invitation shows the field fixed on the list it took", async () => {
    await openReview();
    await userEvent.fill(allowedField(), "Relay.Example.org");
    await create();

    const landed = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await landed;
    await expect.element(allowedField()).toBeDisabled();
    await expect.element(allowedField()).toHaveValue("relay.example.org");
    expect(pageText()).toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });
});
