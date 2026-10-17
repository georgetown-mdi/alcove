import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  linkageTermsFromRuleSet,
  precisionFloorSelectionStatement,
} from "@alcove/core";

import {
  IMPORTED_CITATION_DROP_TITLE,
  SEEDED_CITATION_DROP_TITLE,
  addKey,
  buildAdvancedTerms,
  citationDropFor,
  draftFromTerms,
  seededCitationDropNotice,
} from "@psi/authoring/advancedInvite";
import {
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithColumnDisclosure,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithPrecisionFloorSelection,
  emptyGuidedKeysNotice,
  enabledKeys,
} from "@psi/inviterEditor";
import { answersRows } from "@psi/inviterModel";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { PrecisionFloorSelection } from "@alcove/core";

function csvOf(row: Record<string, string>): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 1024,
    rawRows: [row],
    columns: Object.keys(row),
    rowCount: 1,
  };
}

// A full SSN, both names and a date of birth: rules in both bands, and the
// three name + date rules with the coverage condition.
const withSsn = csvOf({
  client_id: "1",
  ssn: "123-45-6789",
  first_name: "Ann",
  last_name: "Lee",
  dob: "01/02/1990",
  program_code: "A",
});

// Names and a date of birth alone: no rule at 99% is built from these.
const namesAndDate = csvOf({
  client_id: "1",
  first_name: "Ann",
  last_name: "Lee",
  dob: "01/02/1990",
});

const AT_99_YES: PrecisionFloorSelection = {
  floor: 99,
  oneStateOrMetroArea: true,
};
const AT_95_NO: PrecisionFloorSelection = {
  floor: 95,
  oneStateOrMetroArea: false,
};

const NAME_AND_DATE_RULES = [
  "LN + FN + DOB",
  "swap(LN, FN) + DOB",
  "split(LN) + FN + DOB",
];

function keyNames(editor: InviterEditor): Array<string> {
  return editor.draft.keys.map((entry) => entry.key.name);
}

/** The catalog keys `selection` picks for `editor`'s columns, in order. */
function catalogKeyNames(
  editor: InviterEditor,
  selection: PrecisionFloorSelection,
): Array<string> {
  return linkageTermsFromRuleSet(
    DEFAULT_LINKAGE_RULE_SET,
    undefined,
    editor.draft.metadata,
    selection,
  ).linkageKeys.map((key) => key.name);
}

function rulesSelected(editor: InviterEditor, csv: AcquiredCsv): string {
  const row = answersRows(editor, csv).find(
    (entry) => entry.label === "Rules selected",
  );
  if (row === undefined) throw new Error("no Rules selected row");
  return row.value;
}

describe("the seeded draft", () => {
  test("opens at the 95% floor with the coverage question answered yes", () => {
    const editor = editorFromCsv("Dana", withSsn);
    expect(editor.draft.precisionFloorSelection).toStrictEqual(
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(keyNames(editor)).toStrictEqual(
      catalogKeyNames(editor, DEFAULT_PRECISION_FLOOR_SELECTION),
    );
    expect(buildAdvancedTerms(editor.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });
});

describe("choosing a precision floor", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("at 99% keeps a rule at the floor and drops one below it", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99_YES);
    expect(keyNames(at99)).toContain("SSN + LN + DOB");
    expect(keyNames(at99)).not.toContain("SSN + FN");
    for (const rule of NAME_AND_DATE_RULES)
      expect(keyNames(at99)).not.toContain(rule);
    expect(keyNames(at99)).toStrictEqual(catalogKeyNames(at99, AT_99_YES));
    expect(at99.draft.precisionFloorSelection).toStrictEqual(AT_99_YES);
  });

  test("at 95% keeps a rule above the floor and one at it", () => {
    const at95 = editorWithPrecisionFloorSelection(
      editorWithPrecisionFloorSelection(seeded, AT_99_YES),
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(keyNames(at95)).toContain("SSN + LN + DOB");
    expect(keyNames(at95)).toContain("SSN + FN");
    expect(keyNames(at95)).toStrictEqual(keyNames(seeded));
  });

  test("emits the catalog's citation at either floor", () => {
    for (const selection of [AT_99_YES, DEFAULT_PRECISION_FLOOR_SELECTION]) {
      const chosen = editorWithPrecisionFloorSelection(seeded, selection);
      expect(buildAdvancedTerms(chosen.draft).linkageRuleSet).toStrictEqual(
        DEFAULT_LINKAGE_RULE_SET.reference,
      );
      expect(citationDropFor(chosen.draft)).toBeUndefined();
    }
  });

  test("reseeds the keys, every one turned back on", () => {
    const narrowed = editorWithKeyEnabled(seeded, 0, false);
    expect(enabledKeys(narrowed.draft)).toHaveLength(
      narrowed.draft.keys.length - 1,
    );
    const reseeded = editorWithPrecisionFloorSelection(narrowed, AT_99_YES);
    expect(reseeded.draft.keys.every((entry) => entry.enabled)).toBe(true);
    const back = editorWithPrecisionFloorSelection(
      reseeded,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(back.draft.keys).toStrictEqual(seeded.draft.keys);
  });

  test("holds across a column edit, which reconciles at the chosen floor", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99_YES);
    const edited = editorWithColumnDisclosure(
      at99,
      withSsn,
      "program_code",
      "payload",
    ).editor;
    expect(edited.draft.precisionFloorSelection).toStrictEqual(AT_99_YES);
    expect(keyNames(edited)).toStrictEqual(keyNames(at99));
  });
});

describe("the coverage answer", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("yes admits the name + date rules at the 95% floor", () => {
    for (const rule of NAME_AND_DATE_RULES)
      expect(keyNames(seeded)).toContain(rule);
  });

  test("no withholds them, and the rest of the floor's rules stay", () => {
    const answeredNo = editorWithPrecisionFloorSelection(seeded, AT_95_NO);
    for (const rule of NAME_AND_DATE_RULES)
      expect(keyNames(answeredNo)).not.toContain(rule);
    expect(keyNames(answeredNo)).toContain("SSN + FN");
    expect(keyNames(answeredNo)).toStrictEqual(
      keyNames(seeded).filter((name) => !NAME_AND_DATE_RULES.includes(name)),
    );
    expect(buildAdvancedTerms(answeredNo.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });
});

describe("keys written in Expert authoring or loaded from a document", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("are not reseeded by a floor choice", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(editorWithPrecisionFloorSelection(authored, AT_99_YES)).toBe(
      authored,
    );
    const imported = editorWithImportedTerms(
      seeded,
      withSsn,
      buildAdvancedTerms(seeded.draft),
    );
    expect(imported.draft.precisionFloorSelection).toBeUndefined();
    expect(editorWithPrecisionFloorSelection(imported, AT_99_YES)).toBe(
      imported,
    );
  });

  test("are named on Review & create as selected by no floor", () => {
    const imported = editorWithImportedTerms(
      seeded,
      withSsn,
      buildAdvancedTerms(seeded.draft),
    );
    expect(rulesSelected(imported, withSsn)).toBe(
      "Keys written in Expert authoring or loaded from a document",
    );
  });
});

describe("Review & create", () => {
  test("names the floor and the coverage answer the keys were selected with", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    const capitalized = (selection: PrecisionFloorSelection) => {
      const statement = precisionFloorSelectionStatement(selection);
      return statement.charAt(0).toUpperCase() + statement.slice(1);
    };
    expect(rulesSelected(seeded, withSsn)).toBe(
      capitalized(DEFAULT_PRECISION_FLOOR_SELECTION),
    );
    for (const selection of [AT_99_YES, AT_95_NO])
      expect(
        rulesSelected(
          editorWithPrecisionFloorSelection(seeded, selection),
          withSsn,
        ),
      ).toBe(capitalized(selection));
  });
});

describe("a seeded draft's dropped citation", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("is not dropped by turning one key off", () => {
    const narrowed = editorWithKeyEnabled(seeded, 0, false);
    expect(buildAdvancedTerms(narrowed.draft).linkageRuleSet).toBeDefined();
    expect(citationDropFor(narrowed.draft)).toBeUndefined();
  });

  test("is noticed when a key moves out of order, and restored by moving it back", () => {
    const moved = editorWithKeyMoved(seeded, 0, 1);
    expect(buildAdvancedTerms(moved.draft).linkageRuleSet).toBeUndefined();
    const drop = citationDropFor(moved.draft);
    expect(drop?.title).toBe(SEEDED_CITATION_DROP_TITLE);
    expect(drop?.notice).toContain("Undo the key edits to keep the citation");
    const restored = editorWithKeyMoved(moved, 1, -1);
    expect(citationDropFor(restored.draft)).toBeUndefined();
  });

  test("is noticed when a key is added in Expert authoring", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(buildAdvancedTerms(authored.draft).linkageRuleSet).toBeUndefined();
    expect(seededCitationDropNotice(authored.draft)).toContain(
      "no longer drawn from the built-in rule set",
    );
  });

  test("is noticed when every key is off", () => {
    let allOff = seeded;
    for (const index of seeded.draft.keys.keys())
      allOff = editorWithKeyEnabled(allOff, index, false);
    expect(seededCitationDropNotice(allOff.draft)).toContain(
      "Turn a linkage key back on to keep the citation",
    );
  });

  test("is not stated for a file the floor offers no key, which had none", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99_YES,
    );
    expect(at99.draft.keys).toHaveLength(0);
    const authored = editorWithAuthoredDraft(
      at99,
      addKey(at99.draft, "first_name"),
    );
    expect(citationDropFor(authored.draft)).toBeUndefined();
  });

  test("leaves an imported draft's drop to the imported notice", () => {
    const misdescribed = buildAdvancedTerms(seeded.draft);
    misdescribed.linkageKeys = [...misdescribed.linkageKeys].reverse();
    const imported = editorWithAuthoredDraft(
      seeded,
      draftFromTerms(misdescribed, seeded.seed, 3600, withSsn.rawRows),
    );
    expect(seededCitationDropNotice(imported.draft)).toBeUndefined();
    expect(citationDropFor(imported.draft)?.title).toBe(
      IMPORTED_CITATION_DROP_TITLE,
    );
  });
});

describe("an empty guided key list", () => {
  test("names the wider choice that supplies rules", () => {
    const seeded = editorFromCsv("Dana", namesAndDate);
    expect(emptyGuidedKeysNotice(seeded)).toBeUndefined();
    for (const selection of [AT_99_YES, AT_95_NO]) {
      const empty = editorWithPrecisionFloorSelection(seeded, selection);
      expect(empty.draft.keys).toHaveLength(0);
      expect(emptyGuidedKeysNotice(empty)).toBe(
        "Your file's columns supply none of the built-in rules these " +
          "choices select. The built-in rules at 95% precision and above, " +
          "with the question above answered Yes, include rules your file " +
          "supplies.",
      );
    }
  });

  test("says nothing where no choice supplies a rule", () => {
    const unmatchable = csvOf({ client_id: "1", program_code: "A" });
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", unmatchable),
      AT_99_YES,
    );
    expect(at99.draft.keys).toHaveLength(0);
    expect(emptyGuidedKeysNotice(at99)).toBeUndefined();
  });
});
