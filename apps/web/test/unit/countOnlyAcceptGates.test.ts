import { describe, expect, test } from "vitest";

import {
  acceptorColumnsEditorState,
  acceptorDisclosedColumns,
  acceptorInitialColumnsState,
  acceptorLaunchBlockedReason,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";
import { importLinkageTerms } from "@psi/linkageTermsIO";
import { setColumnDisclosure } from "@psi/metadataEditing";

import {
  EXPERT_FUNCTION_GROUPS_WITHOUT_FAN_OUT,
  cleaningFanOutRefusedUnder,
} from "@psi/standardizationAuthoring";

import { FAN_OUT_FUNCTION_NAMES } from "@alcove/core";

import type { CSVRow, LinkageTerms } from "@alcove/core";

// The count-only shape refusals as the ACCEPTING web operator meets them: an
// out-of-shape document refused on import (core's schema, shared with the
// invitation decode), and marked columns refused at the launch gate -- a rule
// no linkage-terms document holds. Both rules read the algorithm alone.

/** An invitation in the count-only shape the specification admits: no
 * deduplication and no payload in either direction. */
const countOnlyTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi-c",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
};

function rows(columns: Array<string>): Array<CSVRow> {
  return [Object.fromEntries(columns.map((name) => [name, "value"]))];
}

/** The columns step over `columns` with each of `sent` marked to send. */
function editorFor(
  columns: Array<string>,
  terms: LinkageTerms,
  sent: Array<string> = [],
) {
  const seeded = acceptorInitialColumnsState(columns);
  const state = {
    ...seeded,
    metadata: sent.reduce(
      (metadata, name) =>
        setColumnDisclosure(metadata, name, "payload").metadata,
      seeded.metadata,
    ),
  };
  return {
    editorState: acceptorColumnsEditorState(state, terms, rows(columns)),
    verdict: acceptorVerdict(
      columns,
      terms,
      acceptorColumnsEditorState(state, terms, rows(columns)),
    ),
  };
}

describe("the count-only launch gate (the acceptor's own marked columns)", () => {
  test("blocks launch when a marked column would be sent under count-only terms", () => {
    // `notes` is marked for transmission, which a count-only exchange has
    // nowhere to put.
    const columns = ["first_name", "notes"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms, [
      "notes",
    ]);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(verdict.satisfiableKeyCount).toBeGreaterThan(0);
    const reason = acceptorLaunchBlockedReason(
      verdict,
      editorState,
      countOnlyTerms,
    );
    expect(reason).toBe(
      "Unmark the columns you send above before you can start: a count-only exchange sends none.",
    );
  });

  test("a file with an id column arrives launchable, and marking the id blocks", () => {
    const columns = ["id", "first_name"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([]);
    expect(
      editorState.metadata.find((column) => column.name === "id"),
    ).toMatchObject({ role: "identifier", isPayload: false });
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, countOnlyTerms),
    ).toBeUndefined();

    const marked = {
      ...editorState,
      metadata: setColumnDisclosure(
        editorState.metadata,
        "id",
        "identifier-sent",
      ).metadata,
    };
    expect(acceptorLaunchBlockedReason(verdict, marked, countOnlyTerms)).toBe(
      "Unmark the columns you send above before you can start: a count-only exchange sends none.",
    );
  });

  test("the same file under psi terms launches, so the gate is the algorithm's", () => {
    const columns = ["first_name", "notes"];
    const asPsi: LinkageTerms = { ...countOnlyTerms, algorithm: "psi" };
    const { editorState, verdict } = editorFor(columns, asPsi, ["notes"]);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, asPsi),
    ).toBeUndefined();
  });

  test("blocks launch on a split in the acceptor's own cleaning under count-only terms", () => {
    // The algorithm is the partner's choice, so the remedy is the step.
    const columns = ["first_name"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms);
    const split = {
      ...editorState,
      standardization: editorState.standardization.map((transformation) => ({
        ...transformation,
        steps: [{ function: "split_on", params: { delimiter: "-" } }],
      })),
    };
    expect(acceptorLaunchBlockedReason(verdict, split, countOnlyTerms)).toBe(
      "Your partner chose a count-only exchange, which matches one value per " +
        "record, so remove the Split on step from your cleaning before you " +
        "can start.",
    );
    expect(
      acceptorLaunchBlockedReason(verdict, split, {
        ...countOnlyTerms,
        algorithm: "psi",
      }),
    ).toBeUndefined();
  });

  test("the acceptor's cleaning menu withholds a split exactly under count-only terms", () => {
    expect(cleaningFanOutRefusedUnder(countOnlyTerms)).toBe(true);
    expect(
      cleaningFanOutRefusedUnder({ ...countOnlyTerms, algorithm: "psi" }),
    ).toBe(false);
    const withheld = EXPERT_FUNCTION_GROUPS_WITHOUT_FAN_OUT.flatMap(
      (group) => group.functionNames,
    );
    for (const name of FAN_OUT_FUNCTION_NAMES)
      expect(withheld).not.toContain(name);
    expect(withheld.length).toBeGreaterThan(0);
  });

  test("count-only terms over a file that sends nothing launch", () => {
    const columns = ["first_name"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, countOnlyTerms),
    ).toBeUndefined();
  });
});

describe("the import door refuses a count-only document outside the shape", () => {
  // The import door shows core's own value-free refine message, so the rules
  // are stated once and this pins that they reach the operator intact.
  test.each([
    {
      rule: "deduplicate",
      terms: { ...countOnlyTerms, deduplicate: true },
      expected: /set deduplicate to false/,
    },
    {
      rule: "payload",
      terms: { ...countOnlyTerms, payload: { send: [{ name: "notes" }] } },
      expected: /must declare no payload columns/,
    },
  ])("refuses an imported document declaring $rule", ({ terms, expected }) => {
    const result = importLinkageTerms(JSON.stringify(terms));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(expected);
  });

  test.each([
    { shape: "the count-only shape", terms: countOnlyTerms },
    {
      shape: "several linkage keys",
      terms: {
        ...countOnlyTerms,
        linkageFields: [
          ...countOnlyTerms.linkageFields,
          { name: "lastName", type: "last_name" },
        ],
        linkageKeys: [
          ...countOnlyTerms.linkageKeys,
          { name: "last", elements: [{ field: "lastName" }] },
        ],
      },
    },
    {
      shape: "single-pass",
      terms: { ...countOnlyTerms, linkageStrategy: "single-pass" },
    },
  ])("a count-only document declaring $shape imports", ({ terms }) => {
    const result = importLinkageTerms(JSON.stringify(terms));
    expect(result.success).toBe(true);
  });
});
