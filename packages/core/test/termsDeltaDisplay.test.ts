import { describe, expect, test } from "vitest";

import {
  compareTerms,
  termsAdoptingPartnerTerms,
} from "../src/linkageTermsNegotiation";
import { termsDeltaSections } from "../src/termsDeltaDisplay";

import type { LinkageTerms, Payload } from "../src/config/linkageTermsSchema";
import type { TermsDelta } from "../src/linkageTermsNegotiation";
import type { TermsDeltaSection } from "../src/termsDeltaDisplay";

const NO_CHANGE: TermsDelta = {
  received: undefined,
  sent: undefined,
  partnerDeduplicate: undefined,
  otherTerms: [],
};

describe("termsDeltaSections", () => {
  test("a delta that differs in nothing has no section", () => {
    expect(termsDeltaSections(NO_CHANGE)).toEqual([]);
  });

  test("shows each part that differs, received columns first and other terms last", () => {
    const sections = termsDeltaSections({
      received: { added: ["county"], removed: ["notes"] },
      sent: { added: ["zip"], removed: [] },
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["algorithm mismatch: local psi, partner psi-c"],
    });
    expect(sections).toEqual([
      {
        kind: "columns",
        label: "columns your partner now sends you",
        columns: ["county"],
      },
      {
        kind: "columns",
        label: "columns your partner no longer sends you",
        columns: ["notes"],
      },
      {
        kind: "columns",
        label:
          "columns you no longer send your partner (your partner decides on this)",
        columns: ["zip"],
      },
      {
        kind: "partnerDeduplicate",
        label: "your partner's deduplicate",
        expected: false,
        presented: true,
      },
      {
        kind: "otherTerms",
        label: "other terms that differ",
        differences: ["algorithm mismatch: local psi, partner psi-c"],
      },
    ]);
  });

  test("keeps the partner's names raw, for the display sink to escape", () => {
    const [section] = termsDeltaSections({
      ...NO_CHANGE,
      received: { added: ["a\u202eb"], removed: [] },
    });
    expect(section).toMatchObject({ columns: ["a\u202eb"] });
  });
});

const baseTerms: LinkageTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const columns = (...names: string[]) => names.map((name) => ({ name }));
const withPayload = (payload: Payload): LinkageTerms => ({
  ...baseTerms,
  payload,
});
const namesOf = (list: ReadonlyArray<{ name: string }> | undefined) =>
  (list ?? []).map(({ name }) => name);

const NOW_SEND =
  "columns you now send your partner (your partner decides on these)";
const NO_LONGER_SEND =
  "columns you no longer send your partner (your partner decides on this)";
const NOW_SENDS_YOU = "columns your partner now sends you";
const NO_LONGER_SENDS_YOU = "columns your partner no longer sends you";

const columnSection = (
  sections: TermsDeltaSection[],
  label: string,
): string[] | undefined => {
  const section = sections.find((s) => s.label === label);
  return section?.kind === "columns" ? section.columns : undefined;
};

describe("termsDeltaSections against adopting the partner's terms", () => {
  const sectionsFor = (local: LinkageTerms, partner: LinkageTerms) =>
    termsDeltaSections(compareTerms(local, partner).delta);

  const expectLabelsMatchAdoption = (
    local: LinkageTerms,
    partner: LinkageTerms,
  ) => {
    const sections = sectionsFor(local, partner);
    const adopted = termsAdoptingPartnerTerms(local, partner);
    expect(adopted).toBeDefined();
    const before = {
      send: namesOf(local.payload?.send),
      receive: namesOf(local.payload?.receive),
    };
    const after = {
      send: namesOf(adopted?.payload?.send),
      receive: namesOf(adopted?.payload?.receive),
    };
    const gained = (from: string[], to: string[]) =>
      to.filter((name) => !from.includes(name));
    const nonEmpty = (names: string[]) =>
      names.length > 0 ? names : undefined;
    expect(columnSection(sections, NOW_SEND)).toEqual(
      nonEmpty(gained(before.send, after.send)),
    );
    expect(columnSection(sections, NO_LONGER_SEND)).toEqual(
      nonEmpty(gained(after.send, before.send)),
    );
    expect(columnSection(sections, NOW_SENDS_YOU)).toEqual(
      nonEmpty(gained(before.receive, after.receive)),
    );
    expect(columnSection(sections, NO_LONGER_SENDS_YOU)).toEqual(
      nonEmpty(gained(after.receive, before.receive)),
    );
  };

  test("a column the partner's terms now receive is one this party now sends", () => {
    const local = withPayload({ send: columns("a") });
    const partner = withPayload({ receive: columns("a", "x") });
    expect(sectionsFor(local, partner)).toEqual([
      { kind: "columns", label: NOW_SEND, columns: ["x"] },
    ]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("a column the partner's terms no longer receive is one this party no longer sends", () => {
    const local = withPayload({ send: columns("a") });
    const partner = withPayload({ receive: [] });
    expect(sectionsFor(local, partner)).toEqual([
      { kind: "columns", label: NO_LONGER_SEND, columns: ["a"] },
    ]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("a partner stating a send list and no receive list shows no send section", () => {
    const local = withPayload({
      send: columns("a", "b"),
      receive: columns("x"),
    });
    const partner = withPayload({ send: columns("x") });
    expect(sectionsFor(local, partner)).toEqual([]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("adopting a partner stating no receive list keeps this party's send list", () => {
    const local = withPayload({
      send: columns("a", "b"),
      receive: columns("x"),
    });
    const partner = withPayload({ send: columns("x") });
    expect(
      namesOf(termsAdoptingPartnerTerms(local, partner)?.payload?.send),
    ).toEqual(["a", "b"]);
  });

  test("adopting a partner that expects no output drops this party's send list", () => {
    const local = withPayload({
      send: columns("a", "b"),
      receive: columns("x"),
    });
    const partner: LinkageTerms = {
      ...withPayload({ send: columns("x") }),
      output: { expectsOutput: false, shareWithPartner: true },
    };
    const adopted = termsAdoptingPartnerTerms(local, partner);
    expect(adopted?.output.shareWithPartner).toBe(false);
    expect(namesOf(adopted?.payload?.send)).toEqual([]);
    expect(sectionsFor(local, partner)).toEqual([
      {
        kind: "otherTerms",
        label: "other terms that differ",
        differences: [
          "output mismatch: local will share with partner, but partner does not expect output",
        ],
      },
    ]);
  });

  test("a partner stating no receive list against no send list shows no send section", () => {
    const local = withPayload({ receive: columns("x") });
    const partner = withPayload({ send: columns("x") });
    expect(sectionsFor(local, partner)).toEqual([]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("a column the partner's terms now send is one the partner now sends this party", () => {
    const local = withPayload({ receive: columns("a") });
    const partner = withPayload({ send: columns("a", "x") });
    expect(sectionsFor(local, partner)).toEqual([
      { kind: "columns", label: NOW_SENDS_YOU, columns: ["x"] },
    ]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("a column the partner's terms no longer send is one the partner no longer sends this party", () => {
    const local = withPayload({ receive: columns("a", "x") });
    const partner = withPayload({ send: columns("a") });
    expect(sectionsFor(local, partner)).toEqual([
      { kind: "columns", label: NO_LONGER_SENDS_YOU, columns: ["x"] },
    ]);
    expectLabelsMatchAdoption(local, partner);
  });

  test("both directions changing at once each read as adopting does", () => {
    const local = withPayload({
      send: columns("a", "b"),
      receive: columns("c", "d"),
    });
    const partner = withPayload({
      send: columns("c", "e"),
      receive: columns("a", "f"),
    });
    expect(sectionsFor(local, partner)).toEqual([
      { kind: "columns", label: NOW_SENDS_YOU, columns: ["e"] },
      { kind: "columns", label: NO_LONGER_SENDS_YOU, columns: ["d"] },
      { kind: "columns", label: NOW_SEND, columns: ["f"] },
      { kind: "columns", label: NO_LONGER_SEND, columns: ["b"] },
    ]);
    expectLabelsMatchAdoption(local, partner);
  });
});

describe("termsDeltaSections for terms other than payload columns", () => {
  test("the partner's deduplicate shows the value held to, then the value its terms state", () => {
    const sections = termsDeltaSections(
      compareTerms(
        baseTerms,
        { ...baseTerms, deduplicate: true },
        {
          partnerDeduplicate: false,
        },
      ).delta,
    );
    expect(sections).toEqual([
      {
        kind: "partnerDeduplicate",
        label: "your partner's deduplicate",
        expected: false,
        presented: true,
      },
    ]);
  });

  test("field, key-transform and output differences are reported without a direction", () => {
    const partner: LinkageTerms = {
      ...baseTerms,
      linkageFields: [
        {
          name: "firstName",
          type: "first_name",
          constraints: { allowedCharacters: "[A-Z]" },
        },
      ],
      linkageKeys: [
        {
          name: "firstName",
          elements: [
            {
              field: "firstName",
              transform: [
                { function: "phonetic", params: { algorithm: "soundex" } },
              ],
            },
          ],
        },
      ],
      output: { expectsOutput: true, shareWithPartner: false },
    };
    const [section] = termsDeltaSections(
      compareTerms(baseTerms, partner).delta,
    );
    expect(section).toMatchObject({ kind: "otherTerms" });
    const differences =
      section?.kind === "otherTerms" ? section.differences : [];
    expect(differences).toEqual([
      "output mismatch: local expects output, but partner will not share",
      expect.stringMatching(/^linkage fields do not match.*differently/),
      expect.stringMatching(/^linkage keys do not match.*differently/),
    ]);
  });
});
