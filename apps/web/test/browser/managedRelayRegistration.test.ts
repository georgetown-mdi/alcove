/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  ManagedRelayRegistration,
  PARTNER_RELAY_TEXT,
  STOPPED_OWN_RELAY_TEXT,
} from "@recurring/ManagedRelayRegistration";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  createManagedExchange,
  persistManagedExchangeRelayRegistrar,
} from "@psi/managed/managedExchangeStore";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { RelayRegistrar } from "@alcove/core";

// The Relay registration section of a saved exchange's page: the withheld
// enrollment of an exchange relaying through its partner's relay, the
// enrollment form's field problems, the replace choice following the token,
// what stopping registration says, and the unconfirmed registration of an
// exchange enrolled nowhere.

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

function renderSection(record: RunnableManagedExchangeRecord): void {
  app.render(
    createElement(ManagedRelayRegistration, {
      record,
      runInFlight: false,
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
  test("an exchange relaying through its partner's relay withholds enrollment and says why", async () => {
    renderSection(
      runnableManagedExchangeOrRefuse(
        buildManagedExchangeRecord(newExchange(true)),
      ),
    );

    const enroll = page.getByRole("button", { name: "Enroll" });
    await expect.element(enroll).toBeDisabled();
    await expect
      .element(enroll)
      .toHaveAccessibleDescription(PARTNER_RELAY_TEXT);
    await expect.element(addressField()).not.toBeInTheDocument();
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
