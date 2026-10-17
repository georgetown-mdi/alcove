import { describe, expect, test } from "vitest";

import { deriveAcceptedLinkageTerms, prepareForExchange } from "@alcove/core";

import {
  addKey,
  buildAdvancedTerms,
  draftFromTerms,
  inviterExchangeDataSpec,
} from "../../../src/psi/authoring/advancedInvite.js";
import {
  draftWithFieldAdded,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
} from "../../../src/psi/authoring/advancedInviteDraft.js";

import type { CSVRow, Metadata, Standardization } from "@alcove/core";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

/** Retype the `ssn` column to `first_name`, so its standardization transformation
 * is no longer valid for its column's type. */
function retypeSsnToFirstName(metadata: Metadata): Metadata {
  return metadata.map((column) =>
    column.name === "ssn" ? { ...column, type: "first_name" } : column,
  );
}

describe("setDraftMetadataKeepingKeys", () => {
  test("leaves the key set untouched while swapping in the new metadata", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const metadata = retypeSsnToFirstName(draft.metadata);
    const kept = setDraftMetadataKeepingKeys(draft, metadata);

    // The key set is byte-identical -- this variant is for an authored/imported key
    // set, where the template-driven key reconciliation must NOT run and silently
    // drop keys the operator authored.
    expect(kept.keys).toStrictEqual(draft.keys);
    expect(kept.metadata).toBe(metadata);
  });

  test("reconciles the standardization even though it keeps the keys", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    expect(draft.standardization.some((t) => t.output === "ssn")).toBe(true);

    const metadata = retypeSsnToFirstName(draft.metadata);
    const kept = setDraftMetadataKeepingKeys(draft, metadata);

    // The ssn column was retyped, so its stale transformation is dropped -- the
    // standardization reconciliation is orthogonal to the key set and applies here
    // exactly as it does on the key-reconciling path.
    expect(kept.standardization.some((t) => t.output === "ssn")).toBe(false);
  });

  test("keeps the keys setDraftMetadata re-derives away, on the same standardization", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const metadata = retypeSsnToFirstName(draft.metadata);

    const kept = setDraftMetadataKeepingKeys(draft, metadata);
    const reconciled = setDraftMetadata(draft, metadata);

    // The full setDraftMetadata re-derives the offerable key set (dropping keys the
    // retype makes unofferable), so it ends with fewer keys; the keep-keys variant
    // preserves the count.
    expect(kept.keys.length).toBe(draft.keys.length);
    expect(reconciled.keys.length).toBeLessThan(draft.keys.length);
    // Both run the same standardization reconciliation over the keys they end
    // with. The key-reconciling path also withdraws the cleaning an opt-in offer
    // minted for a key it just dropped; no column here is of an opt-in type, so
    // there is none to withdraw and the two standardizations agree.
    expect(kept.standardization).toStrictEqual(reconciled.standardization);
  });
});

describe("draftWithFieldAdded", () => {
  // Two columns of one opt-in type, so the type's FIRST field and its second are
  // both reachable, and a guided draft has cleaning for neither (with no date of
  // birth, no built-in key over these columns reads a ZIP).
  const ZIP_COLUMNS = ["ssn", "first_name", "last_name", "zip", "zipcode"];
  const ZIP_ROWS: Array<CSVRow> = [
    {
      ssn: "501-22-3344",
      first_name: "Ada",
      last_name: "Lovelace",
      zip: "20001-1234",
      zipcode: "20002-5678",
    },
  ];

  test("the first field of a type takes the type's own name and its recommended cleaning", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    expect(draft.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const added = draftWithFieldAdded(draft, "zip_code");
    const first = added.standardization.at(-1);
    // The bare type name, not `zip_code_2`: a first field named for a second is
    // treated as one of a pair whose other half does not exist, and is the name no
    // key picker offers a field under.
    expect(first?.output).toBe("zip_code");
    expect(first?.input).toBe("zip");
    // With the recommended pipeline, so keying it matches what the accepting party
    // -- deriving its cleaning from these same terms -- matches.
    const keyed = addKey(added, "zip_code");
    const terms = buildAdvancedTerms(keyed);
    const inviter = prepareForExchange(
      inviterExchangeDataSpec(terms, {
        metadata: keyed.metadata,
        standardization: keyed.standardization,
      }),
      "Org",
      ZIP_ROWS,
      ZIP_COLUMNS,
    );
    const acceptor = prepareForExchange(
      { linkageTerms: deriveAcceptedLinkageTerms(terms, "Acceptor") },
      "Acceptor",
      ZIP_ROWS,
      ZIP_COLUMNS,
    );
    expect(inviter.dataset.getField("zip_code")?.get(0)).toEqual(["20001"]);
    expect(acceptor.dataset.getField("zip_code")?.get(0)).toEqual(["20001"]);
  });

  test("the second field of a type is suffixed and starts from the first's steps", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    const first = draftWithFieldAdded(draft, "zip_code");
    const edited = {
      ...first,
      standardization: first.standardization.map((transformation) =>
        transformation.output === "zip_code"
          ? { ...transformation, steps: [{ function: "trim_whitespace" }] }
          : transformation,
      ),
    };

    const second = draftWithFieldAdded(edited, "zip_code");
    const added = second.standardization.at(-1);
    expect(added?.output).toBe("zip_code_2");
    expect(added?.input).toBe("zipcode");
    // The sibling's own steps, not the recommended ones: a second field of a type
    // starts from what the operator cleans the first with.
    expect(added?.steps).toEqual([{ function: "trim_whitespace" }]);
  });

  test("a sibling with steps omitted mirrors as raw, not the recommended pipeline", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    // Not reachable through the UI: a sibling transformation whose `steps` is
    // omitted entirely (raw/no cleaning), built directly rather than through
    // draftWithFieldAdded, which always seeds either the recommended pipeline or
    // the sibling's own steps.
    const withRawSibling = {
      ...draft,
      standardization: [
        ...draft.standardization,
        { output: "zip_code", input: "zip" },
      ],
    };

    const second = draftWithFieldAdded(withRawSibling, "zip_code");
    const added = second.standardization.at(-1);
    expect(added?.output).toBe("zip_code_2");
    expect(added?.input).toBe("zipcode");
    // Mirrors the sibling as raw, not silently upgraded to the recommended
    // pipeline.
    expect(added?.steps).toEqual([]);
  });

  test("a type whose columns are all bound leaves the draft untouched", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    // One free column left after the first add, none after the second.
    const bound = draftWithFieldAdded(
      draftWithFieldAdded(draft, "zip_code"),
      "zip_code",
    );
    expect(draftWithFieldAdded(bound, "zip_code")).toBe(bound);
  });
});

describe("a same-typed field carries the type's shared-value limit", () => {
  const COLUMNS = [
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "social_security_number",
    "phone",
    "phone_number",
    "email",
  ];
  const ROWS: Array<CSVRow> = [
    {
      first_name: "Ada",
      last_name: "Lovelace",
      dob: "12/10/1985",
      ssn: "372-45-6789",
      social_security_number: "456-78-9012",
      phone: "202-555-0101",
      phone_number: "202-555-0102",
      email: "ada@example.org",
    },
    {
      first_name: "Grace",
      last_name: "Hopper",
      dob: "12/09/1986",
      ssn: "567-89-0123",
      social_security_number: "456-78-9012",
      phone: "202-555-0103",
      phone_number: "202-555-0104",
      email: "grace@example.org",
    },
  ];

  test("an added second ssn field takes the sibling's limit and the run drops a value two people share", () => {
    const { draft } = seedAdvancedInvite("Org", COLUMNS, ROWS);
    const added = draftWithFieldAdded(draft, "ssn");
    const second = added.standardization.at(-1);
    expect(second?.output).toBe("ssn_2");
    expect(second?.maxPeoplePerValue).toBe(1);

    const keyed = addKey(added, "ssn_2");
    const prepared = prepareForExchange(
      {
        linkageTerms: buildAdvancedTerms(keyed),
        metadata: keyed.metadata,
        standardization: keyed.standardization,
      },
      "Org",
      ROWS,
      COLUMNS,
    );
    expect(prepared.dataset.getField("ssn")?.get(0)).toEqual(["372456789"]);
    expect(prepared.dataset.getField("ssn_2")?.get(0)).toEqual([]);
    expect(prepared.dataset.getField("ssn_2")?.get(1)).toEqual([]);
  });

  test("a second field copies a sibling whose limit the operator removed", () => {
    const { draft } = seedAdvancedInvite("Org", COLUMNS, ROWS);
    const unscreened = {
      ...draft,
      standardization: draft.standardization.map(
        ({ maxPeoplePerValue: _removed, ...transformation }) => transformation,
      ),
    };
    const added = draftWithFieldAdded(unscreened, "ssn").standardization.at(-1);
    expect(added?.output).toBe("ssn_2");
    expect(added).not.toHaveProperty("maxPeoplePerValue");
  });

  test("a field with no sibling takes the recommended limit", () => {
    const { draft } = seedAdvancedInvite("Org", COLUMNS, ROWS);
    const withoutEmail = {
      ...draft,
      standardization: draft.standardization.filter(
        (transformation) => transformation.output !== "email_address",
      ),
    };
    const added = draftWithFieldAdded(withoutEmail, "email_address");
    const email = added.standardization.at(-1);
    expect(email?.output).toBe("email_address");
    expect(email?.maxPeoplePerValue).toBe(5);
  });

  test("an imported extra phone field carries the default limit into the run", () => {
    const { draft, seed } = seedAdvancedInvite("Org", COLUMNS, ROWS);
    const twoPhones = draftWithFieldAdded(
      draftWithFieldAdded(draft, "phone_number"),
      "phone_number",
    );
    const exported = buildAdvancedTerms(
      addKey(addKey(twoPhones, "phone_number"), "phone_number_2"),
    );
    const imported = draftFromTerms(exported, seed, 3600, ROWS);
    const extra = imported.standardization.find(
      (transformation) => transformation.output === "phone_number_2",
    );
    expect(extra?.input).toBe("phone_number");
    expect(extra?.maxPeoplePerValue).toBe(5);

    const household: Array<CSVRow> = Array.from({ length: 6 }, (_, n) => ({
      ...ROWS[0],
      first_name: `Person${n}`,
      phone: `202-555-01${String(n).padStart(2, "0")}`,
      phone_number: "202-555-0199",
    }));
    const prepared = prepareForExchange(
      {
        linkageTerms: buildAdvancedTerms(imported),
        metadata: imported.metadata,
        standardization: imported.standardization,
      },
      "Org",
      household,
      COLUMNS,
    );
    expect(prepared.dataset.getField("phone_number_2")?.get(0)).toEqual([]);
    expect(prepared.dataset.getField("phone_number")?.get(0)).toEqual([
      "2025550100",
    ]);
  });
});

describe("the guided draft screens the default fields", () => {
  const COLUMNS = ["first_name", "last_name", "dob", "ssn", "phone", "email"];

  const limitOf = (standardization: Standardization, output: string) =>
    standardization.find((transformation) => transformation.output === output)
      ?.maxPeoplePerValue;

  test("the seed gives ssn, phone and email their limits", () => {
    const { draft } = seedAdvancedInvite("Org", COLUMNS);
    expect(limitOf(draft.standardization, "ssn")).toBe(1);
    expect(limitOf(draft.standardization, "phone_number")).toBe(5);
    expect(limitOf(draft.standardization, "email_address")).toBe(5);
    expect(limitOf(draft.standardization, "first_name")).toBeUndefined();
  });

  test("a phone key a column edit newly offers brings the phone limit", () => {
    const { draft } = seedAdvancedInvite("Org", COLUMNS);
    const withoutPhone = setDraftMetadata(
      draft,
      draft.metadata.map((column) =>
        column.name === "phone" ? { ...column, type: "other" } : column,
      ),
    );
    expect(
      withoutPhone.standardization.some(
        (transformation) => transformation.output === "phone_number",
      ),
    ).toBe(false);

    const restored = setDraftMetadata(withoutPhone, draft.metadata);
    expect(
      buildAdvancedTerms(restored).linkageKeys.some((key) =>
        key.elements.some((element) => element.field === "phone_number"),
      ),
    ).toBe(true);
    expect(limitOf(restored.standardization, "phone_number")).toBe(5);
  });
});
