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
  USE_BUILT_IN_RULES_LABEL,
  addKey,
  buildAdvancedTerms,
  citationDropFor,
  draftFromTerms,
  draftHasOfferedKeys,
  removeKey,
  seededCitationDropNotice,
  validateAdvancedInvite,
} from "@psi/authoring/advancedInvite";
import {
  USE_BUILT_IN_RULES_STATEMENT,
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithBuiltInKeys,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithPrecisionFloorSelection,
  emptyGuidedKeysNotice,
  enabledKeys,
  guidedKeysAnnouncement,
  keyOrderHelp,
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
      expect(citationDropFor(chosen.draft, chosen.seed)).toBeUndefined();
    }
  });

  test("keeps a key turned off across a floor change and back", () => {
    const offAt = keyNames(seeded).indexOf("SSN + LN + DOB");
    const narrowed = editorWithKeyEnabled(seeded, offAt, false);
    const isOff = (editor: InviterEditor) =>
      editor.draft.keys.find((entry) => entry.key.name === "SSN + LN + DOB")
        ?.enabled === false;

    const at99 = editorWithPrecisionFloorSelection(narrowed, AT_99_YES);
    expect(isOff(at99)).toBe(true);
    expect(enabledKeys(at99.draft)).toHaveLength(at99.draft.keys.length - 1);

    const back = editorWithPrecisionFloorSelection(
      at99,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(isOff(back)).toBe(true);
    expect(back.draft.keys).toStrictEqual(narrowed.draft.keys);
  });

  test("turns on a key the new selection adds", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99_YES);
    const at95 = editorWithPrecisionFloorSelection(
      at99,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    const added = at95.draft.keys.filter(
      (entry) => !keyNames(at99).includes(entry.key.name),
    );
    expect(added.map((entry) => entry.key.name)).toContain("SSN + FN");
    expect(added.every((entry) => entry.enabled)).toBe(true);
  });

  test("takes the order from the catalog, not from a key moved by hand", () => {
    const moved = editorWithKeyMoved(seeded, 0, 1);
    const at99 = editorWithPrecisionFloorSelection(moved, AT_99_YES);
    expect(keyNames(at99)).toStrictEqual(catalogKeyNames(at99, AT_99_YES));
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

describe("replacing authored keys with the built-in rules", () => {
  const seeded = editorFromCsv("Dana", withSsn);
  const at99 = editorWithPrecisionFloorSelection(seeded, AT_99_YES);

  test("lists the default selection's rules, all on, and opens the floor choice again", () => {
    const authored = editorWithAuthoredDraft(
      at99,
      addKey(at99.draft, "first_name"),
    );
    const guided = editorWithBuiltInKeys(authored);
    expect(guided.keysAuthored).toBeUndefined();
    expect(guided.draft.precisionFloorSelection).toStrictEqual(
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(guided.draft.keys).toStrictEqual(seeded.draft.keys);
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(citationDropFor(guided.draft, guided.seed)).toBeUndefined();
    expect(
      editorWithPrecisionFloorSelection(guided, AT_99_YES).draft
        .precisionFloorSelection,
    ).toStrictEqual(AT_99_YES);
  });

  test("replaces only the keys, keeping a column edit and the other settings", () => {
    const edited = editorWithColumnDisclosure(
      seeded,
      withSsn,
      "program_code",
      "payload",
    ).editor;
    const authored = editorWithAuthoredDraft(edited, {
      ...addKey(edited.draft, "first_name"),
      algorithm: "psi-c",
    });
    const guided = editorWithBuiltInKeys(authored);
    expect(guided.draft.metadata).toStrictEqual(edited.draft.metadata);
    expect(guided.draft.algorithm).toBe("psi-c");
    expect(guided.seed).toBe(authored.seed);
  });

  test("takes an imported document's citation and fields with its keys", () => {
    const misdescribed = buildAdvancedTerms(seeded.draft);
    misdescribed.linkageKeys = [...misdescribed.linkageKeys].reverse();
    const imported = editorWithImportedTerms(seeded, withSsn, misdescribed);
    expect(citationDropFor(imported.draft, imported.seed)?.title).toBe(
      IMPORTED_CITATION_DROP_TITLE,
    );
    const guided = editorWithBuiltInKeys(imported);
    expect(guided.draft.importedRuleSetCitation).toBeUndefined();
    expect(guided.draft.importedLinkageFields).toBeUndefined();
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(validateAdvancedInvite(guided.draft, guided.seed).canGenerate).toBe(
      true,
    );
  });

  test("builds valid terms from a document that named a field its own way", () => {
    const terms = buildAdvancedTerms(seeded.draft);
    const rename = (name: string) => (name === "last_name" ? "surname" : name);
    const { linkageRuleSet: _citation, ...uncited } = terms;
    const renamed = {
      ...uncited,
      linkageFields: terms.linkageFields.map((field) => ({
        ...field,
        name: rename(field.name),
      })),
      linkageKeys: terms.linkageKeys.map((key) => ({
        ...key,
        elements: key.elements.map((element) => ({
          ...element,
          field: rename(element.field),
        })),
      })),
    };
    const guided = editorWithBuiltInKeys(
      editorWithImportedTerms(seeded, withSsn, renamed),
    );
    expect(validateAdvancedInvite(guided.draft, guided.seed).canGenerate).toBe(
      true,
    );
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });

  test("states in its confirm what replaces the keys", () => {
    expect(USE_BUILT_IN_RULES_STATEMENT).toBe(
      "This replaces these keys with the built-in rules at 95% precision and " +
        "above that your file supplies, for two files that both draw their " +
        "members from one state or one metropolitan area, all turned on. " +
        "Your columns and other settings stay. This cannot be undone.",
    );
  });
});

describe("the key order help", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("at 95% names the 99% rules first, then the 95% rules", () => {
    expect(keyOrderHelp(seeded)).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys come with the rules at 99% precision " +
        "first, then the rules at 95%.",
    );
  });

  test("at 99% names the 99% rules only", () => {
    expect(
      keyOrderHelp(editorWithPrecisionFloorSelection(seeded, AT_99_YES)),
    ).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys are only the rules at 99% precision.",
    );
  });

  test("for authored keys says only that they are tried in the order listed", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(keyOrderHelp(authored)).toBe(
      "Records are matched on these keys, tried in the order listed, and " +
        "earlier keys match first.",
    );
  });
});

describe("the announcement after a floor choice", () => {
  test("counts the keys listed and the keys on", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    const count = seeded.draft.keys.length;
    expect(guidedKeysAnnouncement(seeded)).toBe(
      `The key list shows ${String(count)} built-in rules your file ` +
        "supplies, all turned on.",
    );
    expect(guidedKeysAnnouncement(editorWithKeyEnabled(seeded, 0, false))).toBe(
      `The key list shows ${String(count)} built-in rules your file ` +
        `supplies, ${String(count - 1)} turned on.`,
    );
  });

  test("reads the empty-list note for an empty list", () => {
    const empty = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99_YES,
    );
    expect(empty.draft.keys).toHaveLength(0);
    expect(guidedKeysAnnouncement(empty)).toBe(emptyGuidedKeysNotice(empty));
    expect(guidedKeysAnnouncement(empty)).not.toContain("0 built-in");
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

  test("names no coverage condition at 99%, whichever the answer", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    for (const oneStateOrMetroArea of [true, false])
      expect(
        rulesSelected(
          editorWithPrecisionFloorSelection(seeded, {
            floor: 99,
            oneStateOrMetroArea,
          }),
          withSsn,
        ),
      ).toBe(
        "The built-in rules at 99% precision and above that your file supplies",
      );
  });
});

describe("a seeded draft's dropped citation", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("is not dropped by turning one key off", () => {
    const narrowed = editorWithKeyEnabled(seeded, 0, false);
    expect(buildAdvancedTerms(narrowed.draft).linkageRuleSet).toBeDefined();
    expect(citationDropFor(narrowed.draft, narrowed.seed)).toBeUndefined();
  });

  test("is noticed when a key moves out of order, and restored by moving it back", () => {
    const moved = editorWithKeyMoved(seeded, 0, 1);
    expect(buildAdvancedTerms(moved.draft).linkageRuleSet).toBeUndefined();
    const drop = citationDropFor(moved.draft, moved.seed);
    expect(drop?.title).toBe(SEEDED_CITATION_DROP_TITLE);
    expect(drop?.notice).toBe(
      "A key was moved out of the built-in order, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules. Move the keys back into their built-in " +
        "order to keep the citation, or create the invitation without it.",
    );
    const restored = editorWithKeyMoved(moved, 1, -1);
    expect(citationDropFor(restored.draft, restored.seed)).toBeUndefined();
  });

  test("is noticed when a key is added in Expert authoring, naming the way back", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(buildAdvancedTerms(authored.draft).linkageRuleSet).toBeUndefined();
    expect(seededCitationDropNotice(authored.draft, authored.seed)).toBe(
      "A key was added or changed in Expert authoring, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules. To keep the citation, choose Use the " +
        "built-in rules on Matching keys, which replaces these keys, or " +
        "create the invitation without it.",
    );
  });

  test("is noticed when every key is off", () => {
    let allOff = seeded;
    for (const index of seeded.draft.keys.keys())
      allOff = editorWithKeyEnabled(allOff, index, false);
    expect(seededCitationDropNotice(allOff.draft, allOff.seed)).toContain(
      "Turn a linkage key back on to keep the citation",
    );
  });

  test("is noticed for keys authored after a floor that offers the file none", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99_YES,
    );
    expect(at99.draft.keys).toHaveLength(0);
    expect(citationDropFor(at99.draft, at99.seed)).toBeUndefined();
    const authored = editorWithAuthoredDraft(
      at99,
      addKey(at99.draft, "first_name"),
    );
    expect(citationDropFor(authored.draft, authored.seed)?.notice).toContain(
      USE_BUILT_IN_RULES_LABEL,
    );
  });

  test("is not stated for a file the built-in rules never supplied", () => {
    const unmatchable = csvOf({
      client_id: "1",
      first_name: "Ann",
      program_code: "A",
    });
    const seededBare = editorFromCsv("Dana", unmatchable);
    expect(buildAdvancedTerms(seededBare.draft).linkageRuleSet).toBeUndefined();
    const authored = editorWithAuthoredDraft(
      seededBare,
      addKey(seededBare.draft, "first_name"),
    );
    expect(citationDropFor(authored.draft, authored.seed)).toBeUndefined();
  });

  test("leaves an imported draft's drop to the imported notice", () => {
    const misdescribed = buildAdvancedTerms(seeded.draft);
    misdescribed.linkageKeys = [...misdescribed.linkageKeys].reverse();
    const imported = editorWithAuthoredDraft(
      seeded,
      draftFromTerms(misdescribed, seeded.seed, 3600, withSsn.rawRows),
    );
    expect(
      seededCitationDropNotice(imported.draft, imported.seed),
    ).toBeUndefined();
    expect(citationDropFor(imported.draft, imported.seed)?.title).toBe(
      IMPORTED_CITATION_DROP_TITLE,
    );
  });
});

describe("an authored draft a column edit leaves the catalog offering no key", () => {
  test("states the citation its new keys drop", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", withSsn),
      AT_99_YES,
    );
    const narrowed = editorWithAuthoredDraft(at99, removeKey(at99.draft, 0));
    expect(buildAdvancedTerms(narrowed.draft).linkageRuleSet).toBeDefined();

    const retyped = editorWithColumnType(
      narrowed,
      withSsn,
      "ssn",
      "other",
    ).editor;
    expect(retyped.draft.precisionFloorSelection).toStrictEqual(AT_99_YES);
    expect(draftHasOfferedKeys(retyped.draft)).toBe(false);

    const allOff = {
      ...retyped.draft,
      keys: retyped.draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const rewritten = editorWithAuthoredDraft(
      retyped,
      addKey(allOff, "first_name"),
    );
    expect(
      validateAdvancedInvite(rewritten.draft, rewritten.seed).canGenerate,
    ).toBe(true);
    expect(buildAdvancedTerms(rewritten.draft).linkageRuleSet).toBeUndefined();
    const drop = citationDropFor(rewritten.draft, rewritten.seed);
    expect(drop?.title).toBe(SEEDED_CITATION_DROP_TITLE);
    expect(drop?.notice).toContain(USE_BUILT_IN_RULES_LABEL);
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
