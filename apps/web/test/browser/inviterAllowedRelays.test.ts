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
import {
  RELAY_OPERATOR_DISCLOSURE,
  relaySummary,
} from "@exchange/ExchangeConnectionSettings";
import { ALLOWED_RELAYS_GUIDE_URL } from "@exchange/userGuide";
import { DEFAULT_RELAY_SWITCH_LABEL } from "@psi/transport/defaultRelaySwitch";
import { InviterScreen } from "@exchange/InviterScreen";
import { OWN_DEFAULT_RELAY_NOTICE_LEAD } from "@exchange/DefaultRelayNotice";
import { PENDING_INVITATION_STORAGE_KEY } from "@exchange/pendingInvitationKey";
import { listenAsInviter } from "@psi/transport/rendezvous";
import { parkWebSocketRelayConnection } from "@psi/transport/websocketRelayConnection";

import { removeOwnRelay, setOwnRelay } from "./connectionSettings";
import { createAppMount } from "./renderApp";

import { lifecycleCall, lifecycleCalls, parkedRelays } from "./moduleMocks";

import type { DefaultRelayBuild } from "@utils/clientConfig";
import type { OwnRelayEntry } from "./connectionSettings";

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

// Hold the mint open or fail it per-test, to act on the review while the
// invitation is created; unset, it delegates to the real generateInvitation.
const mintHarness = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  fail: undefined as Error | undefined,
}));
vi.mock("@psi/invitation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateInvitation: async (params: unknown) => {
      await mintHarness.hold;
      if (mintHarness.fail !== undefined) throw mintHarness.fail;
      return (actual.generateInvitation as (p: unknown) => Promise<unknown>)(
        params,
      );
    },
  };
});

// The build's default relay, the build's own where unset.
const relayBuild = vi.hoisted(() => ({
  current: undefined as DefaultRelayBuild | undefined,
}));
vi.mock("@utils/clientConfig", async (importOriginal) => {
  const real = await (
    await import("../utils/clientConfigMock")
  ).clientConfigMock(importOriginal);
  return {
    ...real,
    defaultRelayBuild: () => relayBuild.current ?? real.defaultRelayBuild(),
  };
});

const KEPT_URL = "turns:relay.example.org:443?transport=tcp";
const LEFT_OUT_URL = "turn:backup.example.net:3478";

const INVITER_CSV =
  "client_id,first_name,last_name,dob\n" +
  "1,Ann,Lee,01/02/1990\n2,Bo,Ray,03/04/1985\n";

const app = createAppMount();

afterEach(() => {
  app.unmount();
  lifecycleCalls.length = 0;
  mintHarness.hold = undefined;
  mintHarness.fail = undefined;
  relayBuild.current = undefined;
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

/** The exchange's own relay, which the run lists. */
const OWN_RELAY = { turn: [KEPT_URL, LEFT_OUT_URL] };

/** Walk the inviting seat from an empty file step to its review step, and set
 * `relay` as the exchange's own there. */
async function openReview(relay?: OwnRelayEntry) {
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
  if (relay !== undefined) await setOwnRelay(relay);
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
    await openReview(OWN_RELAY);

    await expect
      .element(page.getByText(ALLOWED_RELAYS_UNSET_SUMMARY))
      .toBeInTheDocument();
    await expect.element(setButton()).toBeEnabled();
    expect(allowedField().query()).toBeNull();
    expect(pageText()).not.toContain(CREATED_INVITATION_ALLOWED_RELAYS_SCOPE);
  });

  test("open on their action, empty, with the short description and the guide, and Done closes them", async () => {
    await openReview(OWN_RELAY);

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
    await openReview(OWN_RELAY);
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
    await openReview(OWN_RELAY);
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
    await openReview(OWN_RELAY);
    await setRelays("relay.example.org");
    await doneButton().click();

    await removeOwnRelay();
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
    await openReview(OWN_RELAY);
    await setRelays("relay.example.org");
    await doneButton().click();

    await removeOwnRelay();
    await removeButton().click();
    await expect.element(setButton()).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(pageText()).toContain(ALLOWED_RELAYS_UNSET_SUMMARY);
  });

  test("creating the invitation commits the list: the invitation, its waiting record and its run keep only the relays it names", async () => {
    await openReview(OWN_RELAY);
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
    await openReview(OWN_RELAY);
    await create();

    const { record, turn } = await keptInvitation();
    expect(turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(record).not.toHaveProperty("allowedRelays");

    const { options } = await runListen();
    expect(options.relay?.turn).toEqual([KEPT_URL, LEFT_OUT_URL]);
    expect(options.relaysLeftOut).toEqual([]);
  });

  test("a run parks the WebSocket relay its Connection settings name, as inviter, and closes it when the run ends", async () => {
    parkedRelays.length = 0;
    await openReview({
      turn: [KEPT_URL],
      websocket: "wss://wsrelay.example.org/relay",
    });
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

  test("Back from the created invitation shows the list it took, fixed", async () => {
    await openReview(OWN_RELAY);
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
    await openReview(OWN_RELAY);
    await create();

    await backToReview();
    await expect
      .element(page.getByText(ALLOWED_RELAYS_UNSET_SUMMARY))
      .toBeInTheDocument();
    expect(setButton().query()).toBeNull();
    expect(allowedField().query()).toBeNull();
  });
});

describe("InviterScreen: the review's Allowed relays from the press of Create", () => {
  const COMMITTED = ["relay.example.org"];

  test("are fixed while the invitation is created: no edit is accepted, and the invitation and the fixed view keep the list at the press", async () => {
    await openReview(OWN_RELAY);
    await setRelays("Relay.Example.org");
    let release: () => void = () => undefined;
    mintHarness.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    await createButton().click();
    await expect
      .element(page.getByText(allowedRelaysSummary(COMMITTED)))
      .toBeInTheDocument();
    expect(allowedField().query()).toBeNull();
    expect(changeButton().query()).toBeNull();
    expect(removeButton().query()).toBeNull();
    expect(setButton().query()).toBeNull();

    release();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Your invitation is ready");
    const { record, turn } = await keptInvitation();
    expect(record.allowedRelays).toEqual(COMMITTED);
    expect(turn).toEqual([KEPT_URL]);

    await backToReview();
    await expect
      .element(page.getByText(allowedRelaysSummary(COMMITTED)))
      .toBeInTheDocument();
    expect(allowedField().query()).toBeNull();
    expect(changeButton().query()).toBeNull();
  });

  test("a create that fails returns the list to the draft as typed, open to edits", async () => {
    await openReview(OWN_RELAY);
    await setRelays("Relay.Example.org");
    mintHarness.fail = new Error("mint refused");

    await createButton().click();
    await expect
      .element(page.getByText("Could not create the invitation"))
      .toBeInTheDocument();
    await expect.element(allowedField()).toHaveValue("Relay.Example.org");
    await expect.element(allowedField()).toBeEnabled();
  });
});

describe("InviterScreen: the review's Connection settings", () => {
  const scheme = () => (window.location.protocol === "https:" ? "wss" : "ws");
  const serverField = () =>
    page.getByRole("textbox", { name: "Coordination server" });

  test("start from this site's coordination server, and the invitation names the one entered", async () => {
    await openReview();
    await expect
      .poll(() => (serverField().element() as HTMLInputElement).value)
      .toMatch(new RegExp(`^${scheme()}://.+/api/$`));

    await userEvent.fill(
      serverField(),
      `${scheme()}://coordination.agency.example/signal/`,
    );
    await create();
    const { record } = await keptInvitation();
    const token = await decodeInvitation(record.encoded);
    expect(token.connectionEndpoint).toMatchObject({
      channel: "webrtc",
      host: "coordination.agency.example",
      path: "/signal/",
    });
  });

  test("a refused address holds the create", async () => {
    await openReview();
    await userEvent.fill(serverField(), "https://app.example.org/");
    await expect.element(createButton()).toBeDisabled();
    expect(pageText()).toContain("Resolve the connection settings above");
  });

  test("the relay set there is kept with the waiting invitation", async () => {
    await openReview({ turn: [KEPT_URL] });
    await create();
    const { record, turn } = await keptInvitation();
    expect(turn).toEqual([KEPT_URL]);
    expect((record as { ownRelay?: unknown }).ownRelay).toEqual({
      turn: [KEPT_URL],
      stun: [],
    });
  });

  const SITE_TURN = "turns:turn.example.org:443?transport=tcp";
  const OTHER_SERVER = () =>
    `${scheme()}://coordination.agency.example/signal/`;
  const relaySwitch = () =>
    page.getByRole("switch", { name: DEFAULT_RELAY_SWITCH_LABEL });
  const changeRelay = () => page.getByRole("button", { name: "Change relay" });
  const removeRelay = () => page.getByRole("button", { name: "Remove relay" });
  const committedRelayLine = () =>
    page.getByText(
      relaySummary({ turn: SITE_TURN, stun: "", websocket: "" }) ?? "no relay",
    );

  /** The review with the build offering its relay server switched off, the
   * exchange's own relay naming it, and another coordination server. */
  async function openSiteRelayReview() {
    relayBuild.current = {
      kind: "opt-in",
      relay: {
        turnUrl: SITE_TURN,
        registrarUrl: "https://registrar.example.org",
      },
    };
    await openReview({ turn: [SITE_TURN] });
    await userEvent.fill(serverField(), OTHER_SERVER());
  }

  test("are fixed from the press of Create: an edit while the invitation is created changes neither what it names nor what the fields show", async () => {
    await openSiteRelayReview();
    let release: () => void = () => undefined;
    mintHarness.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    await createButton().click();
    await expect.element(serverField()).toHaveAttribute("readonly");
    await serverField().click();
    await userEvent.keyboard("{End}x");
    await expect.element(serverField()).toHaveValue(OTHER_SERVER());
    await expect.element(relaySwitch()).toBeDisabled();
    await expect.element(committedRelayLine()).toBeInTheDocument();
    expect(changeRelay().query()).toBeNull();
    expect(removeRelay().query()).toBeNull();

    release();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Your invitation is ready");
    const { record, turn } = await keptInvitation();
    const token = await decodeInvitation(record.encoded);
    expect(token.connectionEndpoint).toMatchObject({
      channel: "webrtc",
      host: "coordination.agency.example",
      path: "/signal/",
    });
    expect(turn).toEqual([SITE_TURN]);
    expect(record).not.toHaveProperty("defaultRelayOn");
  });

  test("Back from the created invitation shows the server, relays and switch it took, fixed, and the notice they give", async () => {
    await openSiteRelayReview();
    await create();

    await backToReview();
    await expect.element(serverField()).toHaveValue(OTHER_SERVER());
    await expect.element(serverField()).toHaveAttribute("readonly");
    await expect.element(committedRelayLine()).toBeInTheDocument();
    expect(changeRelay().query()).toBeNull();
    expect(removeRelay().query()).toBeNull();
    await expect.element(relaySwitch()).not.toBeChecked();
    await expect.element(relaySwitch()).toBeDisabled();
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        `${OWN_DEFAULT_RELAY_NOTICE_LEAD} ${RELAY_OPERATOR_DISCLOSURE}`,
      );
  });

  test("a create that fails returns them to the draft as typed, open to edits", async () => {
    await openSiteRelayReview();
    mintHarness.fail = new Error("mint refused");

    await createButton().click();
    await expect
      .element(page.getByText("Could not create the invitation"))
      .toBeInTheDocument();
    await expect.element(serverField()).not.toHaveAttribute("readonly");
    await expect.element(serverField()).toHaveValue(OTHER_SERVER());
    await expect.element(relaySwitch()).toBeEnabled();
    await expect.element(removeRelay()).toBeInTheDocument();
  });
});
