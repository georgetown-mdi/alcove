/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { missingFieldConditionStatement } from "@alcove/core";

import { InvitationTerms } from "@components/InvitationTerms";

import { createAppMount } from "./renderApp";
import { readyDisclosures } from "./collapsePanels";

import type { LinkageTerms } from "@alcove/core";

// Measured with the Mantine stylesheet loaded, which the main InvitationTerms
// suite does not load, so the gaps are the ones the app ships.

// The schema admits only date-of-birth fields in a condition, so a second
// block needs a condition naming another type; the render does not validate,
// and the second key's condition names the SSN field.
const twoConditionTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: true,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN",
      elements: [{ field: "ssn" }, { field: "last_name" }],
      condition: { missingField: "dob" },
    },
    {
      name: "FN + LN + DOB",
      elements: [
        { field: "first_name" },
        { field: "last_name" },
        { field: "dob" },
      ],
      condition: { missingField: "ssn" },
    },
  ],
};

const app = createAppMount();

afterEach(app.unmount);

// The list of key names whose aria-describedby names the statement, and that
// statement's line.
function conditionBlock(statement: string) {
  const lists = Array.from(
    app.container.querySelectorAll<HTMLElement>("ul[aria-describedby]"),
  ).filter(
    (list) =>
      document.getElementById(list.getAttribute("aria-describedby") ?? "")
        ?.textContent === statement,
  );
  expect(lists).toHaveLength(1);
  const list = lists[0];
  const statementLine = document.getElementById(
    list.getAttribute("aria-describedby") ?? "",
  );
  const wrapper = list.parentElement;
  if (statementLine === null || wrapper === null)
    throw new Error("a condition block has no statement or no wrapper");
  return { list, statementLine, wrapper };
}

test("two missing-field condition blocks are each one group, set further apart than the rows inside one", async () => {
  app.render(
    createElement(InvitationTerms, {
      linkageTerms: twoConditionTerms,
      allowedRelays: undefined,
      perspective: "review",
    }),
  );
  await readyDisclosures(app.container);

  const blocks = [
    missingFieldConditionStatement("date of birth", "psi"),
    missingFieldConditionStatement("SSN", "psi"),
  ].map(conditionBlock);

  for (const { list, statementLine, wrapper } of blocks) {
    expect(Array.from(wrapper.children)).toEqual([list, statementLine]);
  }
  expect(
    blocks.map(({ list }) =>
      Array.from(list.querySelectorAll("li"), (row) => row.textContent),
    ),
  ).toEqual([["SSN + LN"], ["FN + LN + DOB"]]);
  expect(blocks[1].wrapper.previousElementSibling).toBe(blocks[0].wrapper);

  const gapInsideBlock =
    blocks[0].statementLine.getBoundingClientRect().top -
    blocks[0].list.getBoundingClientRect().bottom;
  const gapBetweenBlocks =
    blocks[1].wrapper.getBoundingClientRect().top -
    blocks[0].wrapper.getBoundingClientRect().bottom;
  expect(gapInsideBlock).toBeCloseTo(2, 0);
  expect(gapBetweenBlocks).toBeGreaterThan(gapInsideBlock);
});
