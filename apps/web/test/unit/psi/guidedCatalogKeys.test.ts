import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
} from "@alcove/core";
import { validateStandardizationAgainstTerms } from "@alcove/core/testing";

import { composeManagedDocument } from "@exchange/manageOfferModel";

import {
  buildAdvancedTerms,
  linkageRuleSetReferenceForDraft,
  seedAdvancedInvite,
  setDraftMetadata,
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

  test("builds terms citing the catalog, cleaned as the terms declare", async () => {
    const draft = guided();
    const terms = buildAdvancedTerms(draft);
    expect(linkageRuleSetReferenceForDraft(terms)).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    const minted = await generateInvitation({
      inviterName: draft.identity,
      profiledColumns: COLUMNS,
      location: LOCATION,
      lifetimeSeconds: draft.lifetimeSeconds,
      linkageTerms: terms,
      metadata: draft.metadata,
      standardization: draft.standardization,
    });
    expect(minted.linkageTerms.linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(
      validateStandardizationAgainstTerms(
        minted.standardization ?? [],
        minted.linkageTerms,
      ),
    ).toEqual([]);
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

  test("leaves the built terms citing the catalog", () => {
    expect(
      linkageRuleSetReferenceForDraft(buildAdvancedTerms(edited())),
    ).toStrictEqual(DEFAULT_LINKAGE_RULE_SET.reference);
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
    delete terms.linkageRuleSet;
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
