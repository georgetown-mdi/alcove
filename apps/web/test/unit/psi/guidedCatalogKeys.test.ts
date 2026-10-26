import { describe, expect, test } from "vitest";

import {
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
} from "@alcove/core";
import { validateStandardizationAgainstTerms } from "@alcove/core/testing";

import { composeManagedDocument } from "@exchange/manageOfferModel";

import {
  buildAdvancedTerms,
  seedAdvancedInvite,
  setDraftMetadata,
  validateAdvancedInvite,
} from "../../../src/psi/authoring/advancedInvite.js";
import { generateInvitation } from "../../../src/psi/invitation.js";
import { prepareManagedRerunExchange } from "../../../src/psi/managed/managedPreparedExchange.js";
import { setColumnTypeForMatching } from "../../../src/psi/metadataEditing.js";

import type { CSVRow, LinkageTerms } from "@alcove/core";

/**
 * The guided key list over a file holding the contact and address columns: the
 * catalog's keys over them arrive with the rest, on, and nothing is offered
 * beside them.
 */

const COLUMNS = [
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "zip",
  "phone",
  "email",
];
const ROWS: Array<CSVRow> = [
  {
    ssn: "900-31-2245",
    first_name: "Maria",
    last_name: "Alvarez",
    dob: "03/07/1988",
    zip: "60614-1234",
    phone: "(312) 555-0142",
    email: "Maria.Alvarez@example.org",
  },
];

const metadata = inferMetadata(COLUMNS, []);
const guided = () => seedAdvancedInvite("Inviter", COLUMNS, ROWS).draft;

const LOCATION = {
  origin: "https://example.org",
  signaling: { host: "example.org", path: "/api/", secure: true },
};

describe("the guided key list", () => {
  test("holds the catalog keys the file supplies, all on, and no offer", () => {
    const draft = guided();
    expect(draft.keys.map((entry) => entry.key)).toStrictEqual(
      getDefaultLinkageTerms("Inviter", metadata).linkageKeys,
    );
    expect(draft.keys.every((entry) => entry.enabled)).toBe(true);
    const names = draft.keys.map((entry) => entry.key.name);
    expect(names).toContain("LN + FN + DOB + ZIP5");
    expect(names).toContain("LN + FN + DOB + PHONE");
    expect(names).toContain("FN + DOB + EMAIL");
    expect(names).not.toContain("FN + EMAIL");
    expect(names).not.toContain("LN + FN + DOB + ZIP");
  });

  test("builds the catalog's terms, cleaned as the terms declare", async () => {
    const draft = guided();
    const terms = buildAdvancedTerms(draft);
    expect(terms.linkageKeys).toStrictEqual(
      getDefaultLinkageTerms("Inviter", metadata).linkageKeys,
    );
    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: draft.identity,
      profiledColumns: COLUMNS,
      location: LOCATION,
      lifetimeSeconds: draft.lifetimeSeconds,
      linkageTerms: terms,
      metadata: draft.metadata,
      standardization: draft.standardization,
    });
    expect(minted.linkageTerms).not.toHaveProperty("linkageRuleSet");
    expect(
      validateStandardizationAgainstTerms(
        minted.standardization ?? [],
        minted.linkageTerms,
      ),
    ).toEqual([]);
  });
});

describe("a catalog key this file cannot supply", () => {
  const BACKBONE = ["ssn", "first_name", "last_name", "dob", "zip"];

  test("is absent from the guided list and its terms, not listed off", () => {
    const draft = seedAdvancedInvite("Inviter", BACKBONE, ROWS).draft;
    const listed = draft.keys.map((entry) => entry.key.name);
    expect(listed).toContain("LN + FN + DOB + ZIP5");
    expect(listed).not.toContain("LN + FN + DOB + PHONE");
    expect(listed).not.toContain("FN + DOB + EMAIL");
    const termKeys = buildAdvancedTerms(draft).linkageKeys.map(
      (key) => key.name,
    );
    expect(termKeys).toStrictEqual(listed);
  });

  test("leaves the list when a column edit takes away its column", () => {
    const draft = guided();
    const retyped = setDraftMetadata(
      draft,
      setColumnTypeForMatching(draft.metadata, "phone", "other"),
      ROWS,
    );
    const listed = retyped.keys.map((entry) => entry.key.name);
    expect(listed).not.toContain("LN + FN + DOB + PHONE");
    expect(listed).toContain("LN + FN + DOB + ZIP5");
    expect(listed).toContain("FN + DOB + EMAIL");
    expect(
      buildAdvancedTerms(retyped).linkageKeys.map((key) => key.name),
    ).toStrictEqual(listed);
  });
});

describe("a key a column edit newly makes offerable", () => {
  const BACKBONE = ["ssn", "first_name", "last_name", "dob", "postal", "tel"];
  const edited = () => {
    const draft = seedAdvancedInvite("Inviter", BACKBONE, ROWS).draft;
    const zip = setColumnTypeForMatching(draft.metadata, "postal", "zip_code");
    const phone = setColumnTypeForMatching(zip, "tel", "phone_number");
    return setDraftMetadata(draft, phone, ROWS);
  };

  test("takes its catalog position, not the end of the list", () => {
    const draft = edited();
    expect(draft.keys.map((entry) => entry.key)).toStrictEqual(
      getDefaultLinkageTerms("Inviter", draft.metadata).linkageKeys,
    );
    const names = draft.keys.map((entry) => entry.key.name);
    expect(names.indexOf("LN + FN + DOB + ZIP5")).toBeLessThan(
      names.indexOf("LN + FN + DOB"),
    );
    expect(names.indexOf("LN + FN + DOB + PHONE")).toBeLessThan(
      names.indexOf("LN + FN + DOB"),
    );
  });

  test("builds the catalog's keys in catalog order", () => {
    const draft = edited();
    expect(buildAdvancedTerms(draft).linkageKeys).toStrictEqual(
      getDefaultLinkageTerms("Inviter", draft.metadata).linkageKeys,
    );
  });
});

describe("a file with no date-of-birth column", () => {
  const UNDATED = ["first_name", "last_name", "phone", "email"];
  const undatedRows: Array<CSVRow> = [
    {
      first_name: "Maria",
      last_name: "Alvarez",
      phone: "(312) 555-0142",
      email: "Maria.Alvarez@example.org",
    },
  ];
  const seeded = () => seedAdvancedInvite("Inviter", UNDATED, undatedRows);

  test("is offered the contact rules that run where one side has no date", () => {
    const { draft } = seeded();
    expect(draft.keys.map((entry) => entry.key)).toStrictEqual(
      getDefaultLinkageTerms("Inviter", draft.metadata).linkageKeys,
    );
    expect(draft.keys.map((entry) => entry.key.name)).toStrictEqual([
      "LN + FN + PHONE",
      "PHONE + soundex(LN) + FN",
      "FN + PHONE",
      "LN + FN + EMAIL",
      "EMAIL + soundex(LN) + FN",
    ]);
  });

  test("builds the quick path's terms and can generate", () => {
    const { draft, seed } = seeded();
    const terms = buildAdvancedTerms(draft);
    expect(terms.linkageKeys).toStrictEqual(seed.terms.linkageKeys);
    expect(terms.linkageFields).toStrictEqual(seed.terms.linkageFields);
    const validation = validateAdvancedInvite(draft, seed);
    expect(validation.errors).toEqual({});
    expect(validation.canGenerate).toBe(true);
  });
});

describe("a saved exchange holding a retired offer key", () => {
  test("still runs", () => {
    const defaults = getDefaultLinkageTerms("Inviter", metadata);
    const terms: LinkageTerms = {
      ...defaults,
      linkageKeys: [
        ...defaults.linkageKeys,
        {
          name: "FN + EMAIL",
          elements: [{ field: "first_name" }, { field: "email_address" }],
        },
        {
          name: "LN + FN + DOB + ZIP",
          elements: [
            { field: "last_name" },
            { field: "first_name" },
            { field: "date_of_birth" },
            { field: "zip_code" },
          ],
        },
      ],
    };
    const document = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: terms,
        metadata,
        standardization: getDefaultStandardization(metadata, terms),
      },
      { channel: "webrtc", host: "example.org", port: 3000, path: "/api/" },
    );
    expect(() =>
      prepareManagedRerunExchange(document, ROWS, COLUMNS),
    ).not.toThrow();
  });
});
