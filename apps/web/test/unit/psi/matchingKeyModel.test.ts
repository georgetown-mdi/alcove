import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  MATCHING_KEY_CONFIG_REFUSALS,
  decodeInvitation,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import {
  MATCHING_KEY_WITHHELD_COPY,
  matchingKeyField,
  matchingKeyWithheldReason,
} from "@psi/matchingKeyModel";
import {
  editorFromCsv,
  editorWithImportedTerms,
  editorWithIncludeMatchingKey,
} from "@psi/inviterEditor";
import { generateInvitation } from "@psi/invitation";
import { inviterExchangeDataSpec } from "@psi/authoring/advancedInviteTerms";

import type { LinkageTerms, Output } from "@alcove/core";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { InvitationLocation } from "@psi/invitation";

// The authoring control's own model: when the matched-key column can be
// written, why not where it cannot, and the one place the choice is narrowed to
// terms that admit it (the mint).

const columns = ["client_id", "first_name", "last_name", "dob"];
const metadata = inferMetadata(columns, []);

const BOTH_RECEIVE: Output = { expectsOutput: true, shareWithPartner: true };
const PARTNER_ONLY: Output = { expectsOutput: false, shareWithPartner: true };

const location: InvitationLocation = {
  origin: "https://example.org:8443",
  signaling: {
    host: "example.org",
    port: 8443,
    path: "/api/",
    secure: true,
  },
};

const CSV = `${columns.join(",")}\n17,Alice,Smith,1990-01-02\n`;

function acquired(): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 4096,
    rawRows: [
      {
        client_id: "17",
        first_name: "Alice",
        last_name: "Smith",
        dob: "1990-01-02",
      },
    ],
    columns,
    rowCount: 1,
  };
}

function termsWith(overrides: Partial<LinkageTerms>): LinkageTerms {
  return { ...getDefaultLinkageTerms("County Health", metadata), ...overrides };
}

describe("matchingKeyWithheldReason", () => {
  test("cascade psi terms that give this party a result admit the column", () => {
    expect(
      matchingKeyWithheldReason({
        algorithm: "psi",
        linkageStrategy: "cascade",
        output: BOTH_RECEIVE,
      }),
    ).toBeUndefined();
  });

  test.each([
    [
      "count-only",
      { algorithm: "psi-c", linkageStrategy: "cascade", output: BOTH_RECEIVE },
    ],
    [
      "single-pass",
      {
        algorithm: "psi",
        linkageStrategy: "single-pass",
        output: BOTH_RECEIVE,
      },
    ],
    [
      "no-output",
      { algorithm: "psi", linkageStrategy: "cascade", output: PARTNER_ONLY },
    ],
  ] as const)("%s terms withhold it", (reason, terms) => {
    expect(matchingKeyWithheldReason(terms)).toBe(reason);
  });

  test("every reason the config parse refuses has the control's own copy", () => {
    expect(Object.keys(MATCHING_KEY_WITHHELD_COPY).sort()).toEqual(
      Object.keys(MATCHING_KEY_CONFIG_REFUSALS).sort(),
    );
  });
});

describe("matchingKeyField", () => {
  test("a chosen column reaches the config as true", () => {
    expect(matchingKeyField(true, termsWith({}))).toEqual({
      includeMatchingKey: true,
    });
  });

  test("off composes no key at all, not an explicit false", () => {
    expect(matchingKeyField(false, termsWith({}))).toEqual({});
    expect(matchingKeyField(undefined, termsWith({}))).toEqual({});
  });

  test("a choice the terms do not admit composes no key", () => {
    expect(matchingKeyField(true, termsWith({ algorithm: "psi-c" }))).toEqual(
      {},
    );
    expect(
      matchingKeyField(true, termsWith({ linkageStrategy: "single-pass" })),
    ).toEqual({});
    expect(matchingKeyField(true, termsWith({ output: PARTNER_ONLY }))).toEqual(
      {},
    );
  });
});

describe("editorWithIncludeMatchingKey", () => {
  test("turning it on writes the draft and turning it off drops the field", () => {
    const editor = editorFromCsv("County Health", acquired());
    expect(editor.draft).not.toHaveProperty("includeMatchingKey");

    const chosen = editorWithIncludeMatchingKey(editor, true);
    expect(chosen.draft.includeMatchingKey).toBe(true);

    const cleared = editorWithIncludeMatchingKey(chosen, false);
    expect(cleared.draft).not.toHaveProperty("includeMatchingKey");
  });

  test("a sealed session refuses the edit like every other mutator", () => {
    const sealed = {
      ...editorFromCsv("County Health", acquired()),
      sealed: true,
    };
    expect(editorWithIncludeMatchingKey(sealed, true)).toBe(sealed);
  });

  test("importing a terms document keeps the choice the operator set", () => {
    const chosen = editorWithIncludeMatchingKey(
      editorFromCsv("County Health", acquired()),
      true,
    );
    const imported = editorWithImportedTerms(chosen, acquired(), termsWith({}));
    expect(imported.draft.includeMatchingKey).toBe(true);
  });
});

describe("generateInvitation narrows the choice once, at the mint", () => {
  test("a chosen column rides the mint and the run's data spec, never the token", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: Readable.from(CSV),
      location,
      metadata,
      includeMatchingKey: true,
    });
    expect(minted.includeMatchingKey).toBe(true);
    expect(
      inviterExchangeDataSpec(minted.linkageTerms, {
        includeMatchingKey: minted.includeMatchingKey,
      }).includeMatchingKey,
    ).toBe(true);

    // Local: the partner's copy of the terms holds nothing about it, so neither
    // the consent display nor the agreed-terms hash moves.
    const token = await decodeInvitation(minted.encoded);
    expect(JSON.stringify(token)).not.toContain("includeMatchingKey");
    expect(JSON.stringify(token)).not.toContain("include_matching_key");
  });

  test("single-pass terms mint no choice", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: Readable.from(CSV),
      location,
      linkageTerms: termsWith({ linkageStrategy: "single-pass" }),
      metadata,
      includeMatchingKey: true,
    });
    expect(minted).not.toHaveProperty("includeMatchingKey");
  });

  test("an omitted choice mints none", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: Readable.from(CSV),
      location,
      metadata,
    });
    expect(minted).not.toHaveProperty("includeMatchingKey");
  });
});
