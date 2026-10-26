/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  ManagedRelayRegistration,
  STOPPED_OWN_RELAY_TEXT,
} from "@recurring/ManagedRelayRegistration";
import {
  ManagedRunStoppedError,
  managedWindowRunStage,
  stopWaitingManagedWindowRun,
} from "@psi/managed/managedWindowRuns";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeRelayRegistrar,
} from "@psi/managed/managedExchangeStore";
import { runManagedRerun } from "@psi/managed/managedRun";

import {
  RELAY_REGISTRATION_HELD_BY_RUN_TEXT,
  STOP_RUN_AND_ENROLL_LABEL,
} from "@recurring/managedRunHolder";
import { withManagedExchangeLock } from "@psi/managed/managedExchangeLock";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRunHolder } from "@recurring/managedRunHolder";
import type { RelayRegistrar } from "@alcove/core";

// The Relay registration section of a saved exchange's page: the
// enrollment offered whatever relay the invitation named, the enrollment
// form's field problems, the replace choice following the token,
// what stopping registration says, the unconfirmed registration of an
// exchange enrolled nowhere, and the form while a run holds the exchange.

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "riverbend-q3",
};

function newExchange(relayThroughPartner = false): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        ...(relayThroughPartner && {
          relay: { turn: ["turns:partner.example.org:443"] },
        }),
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: relayThroughPartner ? "acceptor" : "inviter",
    sharedSecret: generateSharedSecret(),
  };
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

function renderSection(
  record: RunnableManagedExchangeRecord,
  run: {
    holder?: ManagedRunHolder;
    onRunLockRefused?: () => void;
    onRecheckRunLock?: () => void;
  } = {},
): void {
  app.render(
    createElement(ManagedRelayRegistration, {
      record,
      runInFlight: run.holder !== undefined,
      runHolder: run.holder,
      onRunLockRefused: run.onRunLockRefused ?? (() => undefined),
      onRecheckRunLock: run.onRecheckRunLock ?? (() => undefined),
      onChanged: () => undefined,
    }),
  );
}

const addressField = () =>
  page.getByRole("textbox", { name: "Registrar address" });
const exchangeIdField = () =>
  page.getByRole("textbox", { name: "Exchange id at the registrar" });
const tokenField = () => page.getByLabelText("Relay-owner token");
const replaceChoice = () =>
  page.getByRole("checkbox", {
    name: "Replace the key the registrar holds for this exchange id",
  });

describe("the relay registration section", () => {
  test("an exchange whose invitation named a relay offers enrollment", async () => {
    renderSection(
      runnableManagedExchangeOrRefuse(
        buildManagedExchangeRecord(newExchange(true)),
      ),
    );

    await expect
      .element(page.getByRole("button", { name: "Enroll" }))
      .toBeEnabled();
    await expect.element(addressField()).toBeInTheDocument();
  });

  test("a field the registrar schema refuses is marked invalid and described by the schema's reason", async () => {
    renderSection(
      runnableManagedExchangeOrRefuse(
        buildManagedExchangeRecord(newExchange()),
      ),
    );

    await userEvent.fill(addressField(), "http://relay.example.org");
    await userEvent.fill(exchangeIdField(), "..");
    await userEvent.click(page.getByRole("button", { name: "Enroll" }));

    await expect
      .element(addressField())
      .toHaveAttribute("aria-invalid", "true");
    await expect
      .element(addressField())
      .toHaveAccessibleDescription(
        /^The registrar address must be an https:\/\/ url/,
      );
    await expect
      .element(exchangeIdField())
      .toHaveAttribute("aria-invalid", "true");
    await expect
      .element(exchangeIdField())
      .toHaveAccessibleDescription(
        /The exchange id must not be '\.' or '\.\.'/,
      );
    await expect.element(page.getByRole("alert").first()).toBeInTheDocument();

    await userEvent.fill(addressField(), REGISTRAR.url);
    await userEvent.fill(exchangeIdField(), "..");
    await userEvent.click(page.getByRole("button", { name: "Enroll" }));
    await expect
      .element(addressField())
      .not.toHaveAttribute("aria-invalid", "true");
  });

  test("clearing the relay-owner token clears the replace choice with it", async () => {
    renderSection(
      runnableManagedExchangeOrRefuse(
        buildManagedExchangeRecord(newExchange()),
      ),
    );

    await expect.element(replaceChoice()).toBeDisabled();
    await userEvent.fill(tokenField(), "owner-token-for-this-test-only");
    await userEvent.click(replaceChoice());
    await expect.element(replaceChoice()).toBeChecked();

    await userEvent.clear(tokenField());
    await expect.element(replaceChoice()).toBeDisabled();
    await expect.element(replaceChoice()).not.toBeChecked();
  });

  test("stopping registration says the relay refuses the exchange after its next run unless the key is registered again", async () => {
    const created = await createManagedExchange(newExchange());
    const enrolled = await persistManagedExchangeRelayRegistrar(
      created.id,
      REGISTRAR,
      created.sharedSecret,
    );
    renderSection(enrolled);

    await userEvent.click(
      page.getByRole("button", { name: "Stop registering" }),
    );
    await expect
      .element(page.getByText(STOPPED_OWN_RELAY_TEXT, { exact: false }))
      .toBeInTheDocument();
  });

  test("an exchange enrolled nowhere with an unconfirmed registration names enrollment", async () => {
    renderSection(
      runnableManagedExchangeOrRefuse({
        ...runnableManagedExchangeOrRefuse(
          buildManagedExchangeRecord(newExchange()),
        ),
        relayRegistrationPendingSince: "2026-09-29T12:00:00.000Z",
      }),
    );

    await expect
      .element(
        page.getByText(
          "Enroll the exchange under Relay registration to register it.",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });
});

describe("the relay registration section while a run holds the exchange", () => {
  async function enrolledExchange(): Promise<RunnableManagedExchangeRecord> {
    const created = await createManagedExchange(newExchange());
    return persistManagedExchangeRelayRegistrar(
      created.id,
      REGISTRAR,
      created.sharedSecret,
    );
  }

  test("a run elsewhere withholds both writes and says how to end it sooner", async () => {
    renderSection(await enrolledExchange(), { holder: "elsewhere" });

    await expect
      .element(page.getByText(RELAY_REGISTRATION_HELD_BY_RUN_TEXT.elsewhere))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Enroll" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Stop registering" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: STOP_RUN_AND_ENROLL_LABEL }))
      .not.toBeInTheDocument();
    await expect.element(tokenField()).toBeEnabled();
  });

  test("a run of this window that reached its partner offers no stop", async () => {
    renderSection(await enrolledExchange(), { holder: "here-exchanging" });

    await expect
      .element(
        page.getByText(RELAY_REGISTRATION_HELD_BY_RUN_TEXT["here-exchanging"]),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: STOP_RUN_AND_ENROLL_LABEL }))
      .not.toBeInTheDocument();
  });

  test("a run of this window still waiting offers the stop, which rereads the lock when no run of this window is left to stop", async () => {
    let rechecks = 0;
    renderSection(await enrolledExchange(), {
      holder: "here-waiting",
      onRecheckRunLock: () => {
        rechecks += 1;
      },
    });

    await expect
      .element(
        page.getByText(RELAY_REGISTRATION_HELD_BY_RUN_TEXT["here-waiting"]),
      )
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: STOP_RUN_AND_ENROLL_LABEL }),
    );
    expect(rechecks).toBe(1);
  });

  test("an enrollment the lock refused says nothing changed and keeps the token", async () => {
    const created = await createManagedExchange(newExchange());
    const record = runnableManagedExchangeOrRefuse(created);
    let refusals = 0;
    renderSection(record, {
      onRunLockRefused: () => {
        refusals += 1;
      },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let granted!: () => void;
    const holding = new Promise<void>((resolve) => {
      granted = resolve;
    });
    const run = withManagedExchangeLock(record.id, async () => {
      granted();
      await released;
    });
    await holding;

    try {
      await userEvent.fill(addressField(), REGISTRAR.url);
      await userEvent.fill(exchangeIdField(), REGISTRAR.exchangeId);
      await userEvent.fill(tokenField(), "owner-token-for-this-test-only");
      await userEvent.click(page.getByRole("button", { name: "Enroll" }));

      await expect
        .element(
          page.getByText(
            "A run of this exchange started before the request was sent, " +
              "so nothing changed. Try again once the run ends.",
          ),
        )
        .toBeInTheDocument();
      await expect
        .element(tokenField())
        .toHaveValue("owner-token-for-this-test-only");
      expect(refusals).toBe(1);
    } finally {
      release();
      await run;
    }
  });
});

describe("stopping a waiting run of this window to enroll", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A run of `record` in this window, waiting for a partner who never
   * arrives until its stop cuts the wait. */
  async function waitingRun(record: RunnableManagedExchangeRecord) {
    const stop = new AbortController();
    let waiting!: () => void;
    const listed = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const run = runManagedRerun(
      record,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          new Promise<never>((_resolve, reject) => {
            waiting();
            stop.signal.addEventListener("abort", () => {
              reject(new Error("the wait for the partner was aborted"));
            });
          }),
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { stop },
    ).catch((error: unknown) => error);
    await listed;
    return { stop, run };
  }

  test("a form the registrar schema refuses leaves the run waiting and marks the field", async () => {
    const record = runnableManagedExchangeOrRefuse(
      await createManagedExchange(newExchange()),
    );
    const { stop, run } = await waitingRun(record);
    renderSection(record, { holder: "here-waiting" });

    try {
      await userEvent.fill(addressField(), "http://relay.example.org");
      await userEvent.fill(exchangeIdField(), REGISTRAR.exchangeId);
      await userEvent.click(
        page.getByRole("button", { name: STOP_RUN_AND_ENROLL_LABEL }),
      );

      await expect
        .element(addressField())
        .toHaveAttribute("aria-invalid", "true");
      await expect
        .element(addressField())
        .toHaveAccessibleDescription(
          /^The registrar address must be an https:\/\/ url/,
        );
      expect(managedWindowRunStage(record.id)).toBe("waiting");
      expect(stop.signal.aborted).toBe(false);
    } finally {
      stopWaitingManagedWindowRun(record.id);
      await run;
    }
  });

  test("a valid form stops the run and enrolls", async () => {
    const record = runnableManagedExchangeOrRefuse(
      await createManagedExchange(newExchange()),
    );
    const asked: Array<string> = [];
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      asked.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ maxAgeDays: null, lapsesAt: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const { run } = await waitingRun(record);
    renderSection(record, { holder: "here-waiting" });

    await userEvent.fill(addressField(), REGISTRAR.url);
    await userEvent.fill(exchangeIdField(), REGISTRAR.exchangeId);
    await userEvent.click(
      page.getByRole("button", { name: STOP_RUN_AND_ENROLL_LABEL }),
    );

    expect(await run).toBeInstanceOf(ManagedRunStoppedError);
    await expect
      .element(
        page.getByText(
          "The registrar holds this exchange's current relay key.",
        ),
      )
      .toBeInTheDocument();
    expect(asked).toHaveLength(1);
    expect((await getManagedExchange(record.id))?.relayRegistrar).toEqual(
      REGISTRAR,
    );
  });
});
