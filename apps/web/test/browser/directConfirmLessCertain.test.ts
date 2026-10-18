/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { LESS_CERTAIN_KEY_COPY } from "@alcove/core";

import {
  DIRECT_DEDUPLICATE_DEFAULT,
  DIRECT_LESS_CERTAIN_REMEDY,
  DIRECT_LINKAGE_STRATEGY_DEFAULT,
} from "@exchange/directExchangeModel";
import { DirectConfirmSection } from "@exchange/DirectConfirmSection";
import { LESS_CERTAIN_TERMS_LINE } from "@components/InvitationTerms";
import { lessCertainInfoLabel } from "@components/LessCertainInfo";

import { activate, control } from "./keyboardOnly";
import { createAppMount } from "./renderApp";

import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const app = createAppMount();

afterEach(app.unmount);

// Names and a date of birth with nothing else, so the inferred terms include
// the built-in keys marked less certain.
const profile: ProfiledJobInput = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob"],
  sanitizedColumnPositions: [],
  dateInputFormats: new Map(),
  columnSamples: new Map([
    ["client_id", ["1", "2"]],
    ["first_name", ["Ann", "Bo"]],
    ["last_name", ["Lee", "Ray"]],
    ["dob", ["01/02/1990", "03/04/1985"]],
  ]),
};

test("the quick exchange confirm explains a key marked less certain with its own remedy", async () => {
  const noop = () => undefined;
  app.render(
    createElement(DirectConfirmSection, {
      profile,
      identity: "",
      onIdentity: noop,
      linkageStrategy: DIRECT_LINKAGE_STRATEGY_DEFAULT,
      onLinkageStrategy: noop,
      deduplicate: DIRECT_DEDUPLICATE_DEFAULT,
      onDeduplicate: noop,
      affirmed: false,
      onAffirm: noop,
      onRun: noop,
      onBack: noop,
      running: false,
    }),
  );

  await expect.element(page.getByText(LESS_CERTAIN_TERMS_LINE)).toBeVisible();
  const name = lessCertainInfoLabel();
  const info = page.getByRole("button", { name, exact: true });
  const panel = document.getElementById(
    info.element().getAttribute("aria-controls") ?? "",
  )!;
  const explained = `${LESS_CERTAIN_KEY_COPY.explanation} ${DIRECT_LESS_CERTAIN_REMEDY}`;
  await expect.poll(() => panel.textContent).toBe(explained);
  expect(panel.textContent).not.toContain(LESS_CERTAIN_KEY_COPY.acceptorRemedy);

  await activate(control("button", name));
  await expect
    .element(page.elementLocator(panel).getByText(explained))
    .toBeVisible();
});
