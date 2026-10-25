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
  ALLOWED_RELAYS_FIELD_DESCRIPTION,
  ALLOWED_RELAYS_UNSET_SUMMARY,
  CREATED_INVITATION_ALLOWED_RELAYS_SCOPE,
  allowedRelaysRunNotice,
  allowedRelaysSummary,
} from "@psi/transport/relayRestriction";
import { ALLOWED_RELAYS_GUIDE_URL } from "@exchange/userGuide";
import { InviterScreen } from "@exchange/InviterScreen";
import { PENDING_INVITATION_STORAGE_KEY } from "@exchange/pendingInvitationKey";
import { listenAsInviter } from "@psi/transport/rendezvous";
import { parkWebSocketRelayConnection } from "@psi/transport/websocketRelayConnection";
import { writeOwnRelaySetting } from "@psi/transport/ownRelaySetting";

import { createAppMount } from "./renderApp";

import { lifecycleCall, lifecycleCalls, parkedRelays } from "./moduleMocks";

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

vi.mock("@psi/transport/websocketRelayConnection", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parkWebSocketRelayConnection: vi.fn(
    (await import("./moduleMocks")).unpairedRelay,
  ),
}));

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
const setButton = () =>
  page.getByRole("button", { name: "Set Allowed relays" });
const changeButton = () =>
  page.getByRole("button", { name: "Change Allowed relays" });
const removeButton = () =>
  page.getByRole("button", { name: "Remove Allowed relays" });
const doneButton = () => page.getByRole("button", { name: "Done" });
const createButton = () =>
  page.getByRole("button", { name: "Create the invitation" });
const pageText = () => document.body.textContent;

/** Save a relay of this browser's own, which the run lists. */
function ownRelay() {
  writeOwnRelaySetting({ turn: [KEPT_URL, LEFT_OUT_URL], stun: [] });
}

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
  await expect.element(createButton()).toBeInTheDocument();
}

/** Open the field from its line and type `text` into it. */
async function setRelays(text: string) {
  await setButton().click();
  await userEvent.fill(allowedField(), text);
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
  const options = vi.mocked(listenAsInviter).mock.lastCall?.[2];
  if (options === undefined) throw new Error("the run did not listen");
  return { options, notices };
}

describe("InviterScreen: the review's Allowed relays", () => {
  test("are not offered where the run lists no relay, and the create names none", async () => {
    await openReview();

    expect(setButton().query()).toBeNull();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).not.toContain("Allowed relays");
    await create();
    const { record, turn } = await keptInvitation();
    expect(turn).toBeUndefined();
    expect(record).not.toHaveProperty("allowedRelays");
  });

  test("start as one line, whatever an earlier build stored for this browser", async () => {
    window.localStorage.setItem(
      "alcove-relay-restriction",
      JSON.stringify({ version: 1, allowedRelays: ["relay.example.org"] }),
    );
    ownRelay();
    await openReview();

    await expect
      .element(page.getByText(ALLOWED_RELAYS_UNSET_SUMMARY))
      .toBeInTheDocument();
    await expect.element(setButton()).toBeEnabled();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("open on their action, empty, with the short description and the guide, and Done closes them", async () => {
    ownRelay();
    await openReview();

    await setButton().click();
    await expect.element(allowedField()).toHaveValue("");
    await expect.element(allowedField()).toHaveFocus();
    await expect
      .element(allowedField())
      .toHaveAccessibleDescription(ALLOWED_RELAYS_FIELD_DESCRIPTION);
    await expect
      .element(page.getByRole("link", { name: "More about Allowed relays" }))
      .toHaveAttribute("href", ALLOWED_RELAYS_GUIDE_URL);

    await doneButton().click();
    await expect.element(setButton()).toHaveFocus();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).toContain(ALLOWED_RELAYS_UNSET_SUMMARY);
  });

  test("a line the field refuses shows its error and holds the create and Done until it is fixed", async () => {
    ownRelay();
    await openReview();
    const refusal = () => page.getByText(/^Line 1: enter /);

    await setRelays("turns:relay.example.org:443");
    await expect.element(refusal()).toBeInTheDocument();
    await expect.element(refusal()).not.toHaveAttribute("role", "alert");
    await expect
      .element(allowedField())
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(createButton()).toBeDisabled();
    await expect.element(doneButton()).toBeDisabled();
    expect(pageText()).toContain(
      "Resolve the allowed relays above to continue.",
    );
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);

    await userEvent.fill(allowedField(), "relay.example.org");
    await expect.poll(pageText).not.toContain("Line 1:");
    await expect.element(createButton()).toBeEnabled();
    await expect.element(doneButton()).toBeEnabled();
    expect(pageText()).toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("once set, show the list as one line, which Change opens and Remove clears", async () => {
    ownRelay();
    await openReview();
    await setRelays("Relay.Example.org\nbackup.example.org:443");
    await doneButton().click();

    await expect
      .element(
        page.getByText(
          allowedRelaysSummary(["relay.example.org", "backup.example.org:443"]),
        ),
      )
      .toBeInTheDocument();
    await expect.element(changeButton()).toHaveFocus();
    await expect.element(removeButton()).toBeInTheDocument();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);

    await changeButton().click();
    await expect
      .element(allowedField())
      .toHaveValue("Relay.Example.org\nbackup.example.org:443");
    await expect.element(allowedField()).toHaveFocus();
    await doneButton().click();

    await removeButton().click();
    await expect.element(setButton()).toHaveFocus();
    expect(pageText()).toContain(ALLOWED_RELAYS_UNSET_SUMMARY);
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
    await create();
    const { record } = await keptInvitation();
    expect(record).not.toHaveProperty("allowedRelays");
  });

  test("a list once typed stays shown, and is created, after the run stops listing a relay", async () => {
    ownRelay();
    await openReview();
    await setRelays("relay.example.org");
    await doneButton().click();

    writeOwnRelaySetting({ turn: [], stun: [] });
    await page
      .getByRole("combobox", { name: "Invitation duration" })
      .selectOptions("1 day");
    await expect
      .element(page.getByText(allowedRelaysSummary(["relay.example.org"])))
      .toBeInTheDocument();
    await create();
    const { record } = await keptInvitation();
    expect(record.allowedRelays).toEqual(["relay.example.org"]);
  });

  test("Remove after the run stops listing a relay keeps the line, with focus on its action", async () => {
    ownRelay();
    await openReview();
    await setRelays("relay.example.org");
    await doneButton().click();

    writeOwnRelaySetting({ turn: [], stun: [] });
    await removeButton().click();
    await expect.element(setButton()).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(pageText()).toContain(ALLOWED_RELAYS_UNSET_SUMMARY);
  });

  test("creating the invitation commits the list: the invitation, its waiting record and its run keep only the relays it names", async () => {
    ownRelay();
    await openReview();
    await setRelays("Relay.Example.org");
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
    ownRelay();
    await openReview();
    await create();

    const { record, turn } = await keptInvitation();
    expect(turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(record).not.toHaveProperty("allowedRelays");

    const { options } = await runListen();
    expect(options.relay?.turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(options.relaysLeftOut).toEqual([]);
  });

  test("a run parks the WebSocket relay its own setting names, as inviter, and closes it when the run ends", async () => {
    parkedRelays.length = 0;
    writeOwnRelaySetting({
      turn: [KEPT_URL],
      stun: [],
      websocket: "wss://wsrelay.example.org/relay",
    });
    await openReview();
    await create();

    await runListen();
    expect(vi.mocked(parkWebSocketRelayConnection)).toHaveBeenCalledTimes(1);
    expect(parkedRelays).toEqual([
      {
        options: expect.objectContaining({
          url: "wss://wsrelay.example.org/relay",
          role: "inviter",
        }) as unknown,
        closed: true,
      },
    ]);
  });

  /** Go back from the created invitation to its review. */
  async function backToReview() {
    const landed = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await landed;
    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
  }

  test("Back from the created invitation shows the list it took, fixed", async () => {
    ownRelay();
    await openReview();
    await setRelays("Relay.Example.org");
    await create();

    await backToReview();
    await expect
      .element(page.getByText(allowedRelaysSummary(["relay.example.org"])))
      .toBeInTheDocument();
    expect(changeButton().query()).toBeNull();
    expect(removeButton().query()).toBeNull();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("Back from an invitation created with no list shows every relay, fixed", async () => {
    ownRelay();
    await openReview();
    await create();

    await backToReview();
    await expect
      .element(page.getByText(ALLOWED_RELAYS_UNSET_SUMMARY))
      .toBeInTheDocument();
    expect(setButton().query()).toBeNull();
    expect(allowedField().query()).toBeNull();
  });
});
