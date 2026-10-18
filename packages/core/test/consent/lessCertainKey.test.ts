import { describe, expect, test } from "vitest";

import { LESS_CERTAIN_KEY_COPY } from "../../src/consent/consentFacts.js";
import { linkageKeyIsLessCertain } from "../../src/consent/lessCertainKey.js";
import { summarizeInvitation } from "../../src/consent/invitationSummary.js";
import { getDefaultLinkageTerms } from "../../src/defaults/builtInLinkageTerms.js";
import { inferMetadata } from "../../src/config/metadata.js";

import type {
  LinkageField,
  LinkageKey,
  LinkageTerms,
} from "../../src/config/linkageTermsSchema.js";

// Fields named as an author in Expert authoring might name them, so a mark
// that read the key's name or the built-in field names would miss them.
const AUTHORED_FIELDS: Array<LinkageField> = [
  { name: "given", type: "first_name" },
  { name: "surname", type: "last_name" },
  { name: "born", type: "date_of_birth" },
  { name: "tax_id", type: "ssn" },
  { name: "postcode", type: "zip_code" },
];

const key = (name: string, ...fields: Array<string>): LinkageKey => ({
  name,
  elements: fields.map((field) => ({ field })),
});

describe("linkageKeyIsLessCertain", () => {
  test("marks an authored first name, date of birth and last name key", () => {
    expect(
      linkageKeyIsLessCertain(
        key("people", "given", "born", "surname"),
        AUTHORED_FIELDS,
      ),
    ).toBe(true);
  });

  test("leaves a key with an SSN or a ZIP unmarked", () => {
    expect(
      linkageKeyIsLessCertain(
        key("with ssn", "given", "born", "surname", "tax_id"),
        AUTHORED_FIELDS,
      ),
    ).toBe(false);
    expect(
      linkageKeyIsLessCertain(
        key("with zip", "given", "born", "surname", "postcode"),
        AUTHORED_FIELDS,
      ),
    ).toBe(false);
  });

  test("marks a key of names alone, and one with a transformed element", () => {
    expect(
      linkageKeyIsLessCertain(
        key("names", "given", "surname"),
        AUTHORED_FIELDS,
      ),
    ).toBe(true);
    expect(
      linkageKeyIsLessCertain(
        {
          elements: [
            {
              field: "surname",
              transform: [
                { function: "substring", params: { start: 1, length: 4 } },
              ],
            },
            { field: "given" },
            { field: "born", generateFuzzyComparisons: "adjacent_years" },
          ],
        },
        AUTHORED_FIELDS,
      ),
    ).toBe(true);
  });

  test("leaves a key with no element, or an undeclared field, unmarked", () => {
    expect(linkageKeyIsLessCertain(key("empty"), AUTHORED_FIELDS)).toBe(false);
    expect(
      linkageKeyIsLessCertain(
        key("dangling", "given", "born", "nickname"),
        AUTHORED_FIELDS,
      ),
    ).toBe(false);
  });

  test("ignores the key's name", () => {
    expect(
      linkageKeyIsLessCertain(
        key("LN + FN + DOB", "given", "born", "tax_id"),
        AUTHORED_FIELDS,
      ),
    ).toBe(false);
  });
});

describe("the consent summary's less certain mark", () => {
  const terms: LinkageTerms = {
    ...getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
    ),
    linkageFields: AUTHORED_FIELDS,
    linkageKeys: [
      key("authored people", "given", "born", "surname"),
      key("authored with ssn", "tax_id", "born"),
    ],
  };

  test("marks the authored name and date key and only it", () => {
    const [people, withSsn] = summarizeInvitation({
      linkageTerms: terms,
    }).linkageKeys;
    expect(people.lessCertain).toBe(true);
    expect(people.lessCertainHeaderMarker).toBe("(less certain)");
    expect(people.lessCertainHeaderMarker).toBe(
      `(${LESS_CERTAIN_KEY_COPY.mark})`,
    );
    expect(withSsn.lessCertain).toBe(false);
    expect(withSsn.lessCertainHeaderMarker).toBeUndefined();
  });

  test("marks the three built-in name and date keys", () => {
    const summary = summarizeInvitation({
      linkageTerms: getDefaultLinkageTerms(
        "Inviter",
        inferMetadata(["ssn", "first_name", "last_name", "dob", "zip"], []),
      ),
    });
    expect(
      summary.linkageKeys.filter((k) => k.lessCertain).map((k) => k.id),
    ).toStrictEqual([
      "LN + FN + DOB",
      "swap(LN, FN) + DOB",
      "split(LN) + FN + DOB",
    ]);
    const swapped = summary.linkageKeys.find(
      (k) => k.id === "swap(LN, FN) + DOB",
    );
    expect(swapped?.swapHeaderMarker).toBe("(matched in either order)");
    expect(swapped?.lessCertainHeaderMarker).toBe("(less certain)");
  });
});

describe("LESS_CERTAIN_KEY_COPY", () => {
  test("states the mark, why, and the acceptor's remedy", () => {
    expect(LESS_CERTAIN_KEY_COPY).toStrictEqual({
      mark: "less certain",
      explanation:
        "Matches on nothing beyond a name and a date of birth. Different " +
        "people share a name and a date of birth more often the more people " +
        "the two files cover, so some of these matches may be two different " +
        "people. Rules like this are usually safe when both files cover a " +
        "small population; leave them out when the files cover many people.",
      acceptorRemedy:
        "To leave them out, ask your partner for an invitation without them.",
    });
  });

  test("speaks of how many people the files cover, not of a place", () => {
    for (const text of Object.values(LESS_CERTAIN_KEY_COPY))
      expect(text).not.toMatch(/state|metropolitan|area|region/i);
  });
});
