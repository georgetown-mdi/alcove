import { describe, expect, test } from "vitest";

import {
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  assertDisclosedNamesCarriable,
  assertPayloadSendDisclosed,
  deriveAcceptedLinkageTerms,
  runPipeline,
  safeParseLinkageTerms,
  sanitizeForDisplay,
} from "@alcove/core";

import {
  acceptorCleaningAttention,
  acceptorColumnsEditorState,
  acceptorDisclosedColumns,
  acceptorHasIdentifierConflict,
  acceptorInitialColumnsState,
  acceptorLaunchBlockedReason,
  acceptorLaunchPayload,
  acceptorOverlongDisclosedColumns,
  acceptorPartnerNote,
  acceptorPayloadDeclarationConflict,
  acceptorUnsatisfiedTypes,
  acceptorVerdict,
  acceptorWidenedMetadata,
  acceptorWideningOfferSentence,
} from "@exchange/acceptorColumnsModel";

import { CSV_DELIMITER_SINGLE_COLUMN_REMEDY } from "@components/csvDelimiterChoice";

import {
  CONFIG_EXCHANGE_FILES,
  EXCHANGE_FILES_DEFAULT,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import {
  CONNECTION_TUNING_DEFAULT,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import {
  SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
  splitRendezvousRetainProblem,
} from "@console/filedropRendezvousChoice";

import {
  RECEIPTS_DEFAULT,
  receiptsWithResolvedIdentity,
  signingIdentityDivergence,
} from "@psi/receiptsModel";
import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";
import { dateInputFormatsForColumns } from "@psi/authoring/advancedInvite";

import {
  DISCLOSURE_LABELS,
  disclosureOf,
  setColumnDisclosure,
  setColumnTypeForMatching,
} from "@psi/metadataEditing";
import { cleaningSettingsOf } from "@psi/standardizationAuthoring";

import type {
  CSVRow,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@alcove/core";
import type { AcceptorColumnsState } from "@exchange/acceptorColumnsModel";
import type { CleaningSettings } from "@psi/standardizationAuthoring";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { FieldValueCoverage } from "@psi/workers/nonEmptyAggregate";

// Two single-element keys, one per name field, so a CSV can satisfy both, one, or
// neither -- the three verdict outcomes. Adopted verbatim from the invitation; the
// acceptor cannot edit fields or keys.
const nameTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

// A single date-of-birth key whose adopted cleaning is self-defeating: the
// parse_date input format omits the year, so the pipeline drops every record no
// matter the data. Core's verdict grades this key dead.
const deadDobTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "dob", type: "date_of_birth" }],
  linkageKeys: [
    {
      name: "d",
      elements: [
        {
          field: "dob",
          transform: [
            { function: "parse_date", params: { inputFormat: "MM/DD" } },
          ],
        },
      ],
    },
  ],
};

function rows(columns: Array<string>): Array<CSVRow> {
  return [Object.fromEntries(columns.map((c) => [c, "x"]))];
}

/** The seed metadata for `columns` with each of `sent` marked to send, since a
 * column that inference does not recognize is seeded as ignored. */
function seededWithSent(columns: Array<string>, sent: Array<string>): Metadata {
  return sent.reduce(
    (metadata, name) => setColumnDisclosure(metadata, name, "payload").metadata,
    acceptorInitialColumnsState(columns).metadata,
  );
}

/** The derived editor state (metadata + effective standardization) for a fresh
 * acquire of `columns`, plus any state overrides applied on top. */
function editorFor(
  columns: Array<string>,
  terms: LinkageTerms,
  overrides: Partial<AcceptorColumnsState> = {},
) {
  const state: AcceptorColumnsState = {
    ...acceptorInitialColumnsState(columns),
    ...overrides,
  };
  return {
    state,
    editorState: acceptorColumnsEditorState(state, terms, rows(columns)),
  };
}

/** How many agreed keys the current marks leave satisfiable, and how many
 * taking the notice's widening offer does, graded by the launch gate's own
 * derivation. */
function satisfiableKeysAroundOffer(
  columns: Array<string>,
  terms: LinkageTerms,
  state: AcceptorColumnsState,
): { before: number; after: number } {
  const count = (metadata: Metadata) =>
    acceptorVerdict(
      columns,
      terms,
      acceptorColumnsEditorState({ ...state, metadata }, terms, rows(columns)),
    ).satisfiableKeyCount;
  return {
    before: count(state.metadata),
    after: count(acceptorWidenedMetadata(terms, state.metadata)),
  };
}

/** The seed with its `identifier` column also roled `identifier`: inference
 * promotes one column, but an authored metadata block can declare two. */
function seedWithSecondIdentifier(
  columns: Array<string>,
  isPayload = true,
): Metadata {
  return acceptorInitialColumnsState(columns).metadata.map((column) =>
    column.name === "identifier"
      ? { ...column, role: "identifier", isPayload }
      : column,
  );
}

describe("acceptor columns editor state", () => {
  test("seeds metadata from the file's columns and starts with empty override layers", () => {
    const state = acceptorInitialColumnsState(["first_name", "last_name"]);
    expect(state.metadata.map((c) => c.name)).toEqual([
      "first_name",
      "last_name",
    ]);
    expect(state.inputOverrides.size).toBe(0);
    expect(state.stepOverrides.size).toBe(0);
  });

  test.each([
    "id",
    "identifier",
    "case_id",
    "Client ID",
    "ClientID",
    "PersonID",
    "PersonalID",
  ])(
    "an inferred %j column starts as the record identifier, not sent, and a second id column starts ignored",
    (name) => {
      const { metadata } = acceptorInitialColumnsState([
        name,
        "first_name",
        "last_name",
        "household_id",
        "notes",
      ]);
      expect(
        metadata.map((column) => [column.name, disclosureOf(column)]),
      ).toEqual([
        [name, "identifier"],
        ["first_name", "match"],
        ["last_name", "match"],
        ["household_id", "ignored"],
        ["notes", "ignored"],
      ]);
      expect(acceptorDisclosedColumns(metadata)).toEqual([]);
    },
  );

  test("an HMIS PersonalID column starts as the identifier, not sent", () => {
    const { metadata } = acceptorInitialColumnsState([
      "PersonalID",
      "FirstName",
      "LastName",
      "DOB",
    ]);
    const personalId = metadata.find((column) => column.name === "PersonalID");
    if (personalId === undefined)
      throw new Error("the seed lists no PersonalID column");
    expect(personalId.type).toBe("identifier");
    expect(disclosureOf(personalId)).toBe("identifier");
    expect(acceptorDisclosedColumns(metadata)).toEqual([]);
  });

  test("the effective standardization has one transformation per satisfiable field", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    expect(editorState.standardization.map((t) => t.output).sort()).toEqual([
      "firstName",
      "lastName",
    ]);
  });

  test("an ssn4 field may be bound to an ssn column, the type it is derived from", () => {
    const ssn4Terms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [{ name: "ssn4", type: "ssn4" }],
      linkageKeys: [{ name: "s4", elements: [{ field: "ssn4" }] }],
    };
    const metadata: Metadata = [
      { name: "primary", type: "ssn", role: "linkage", isPayload: false },
      { name: "secondary", type: "ssn", role: "linkage", isPayload: false },
      { name: "given", type: "first_name", role: "linkage", isPayload: false },
    ];
    const bound = (column: string) =>
      editorFor(["primary", "secondary", "given"], ssn4Terms, {
        metadata,
        inputOverrides: new Map([["ssn4", column]]),
      }).editorState.standardization.find((t) => t.output === "ssn4")?.input;
    expect(bound("secondary")).toBe("secondary");
    // A column of a type the field neither has nor derives from is stale.
    expect(bound("given")).toBe("primary");
  });

  describe("an ssn4 field rebound among the file's own columns", () => {
    const ssn4Terms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [{ name: "ssn4", type: "ssn4" }],
      linkageKeys: [{ name: "s4", elements: [{ field: "ssn4" }] }],
    };
    const columns = ["last4", "full_ssn", "given"];
    const metadata: Metadata = [
      { name: "last4", type: "ssn4", role: "linkage", isPayload: false },
      { name: "full_ssn", type: "ssn", role: "linkage", isPayload: false },
      { name: "given", type: "first_name", role: "linkage", isPayload: false },
    ];
    const cleaned = (column: string, value: string) => {
      const transformation = editorFor(columns, ssn4Terms, {
        metadata,
        inputOverrides: new Map([["ssn4", column]]),
      }).editorState.standardization.find((t) => t.output === "ssn4");
      expect(transformation?.input).toBe(column);
      return runPipeline(value, transformation?.steps ?? []);
    };

    test("rebound to the ssn column, it drops a full number and keeps the last four of a masked one", () => {
      expect(cleaned("full_ssn", "123-45-6789")).toBeNull();
      expect(cleaned("full_ssn", "***-**-8924")).toBe("8924");
    });

    test("left on its own ssn4 column, it keeps the steps it was derived with", () => {
      expect(cleaned("last4", "8924")).toBe("8924");
      expect(
        editorFor(columns, ssn4Terms, { metadata }).editorState.standardization,
      ).toEqual(
        editorFor(columns, ssn4Terms, {
          metadata,
          inputOverrides: new Map([["ssn4", "last4"]]),
        }).editorState.standardization,
      );
    });
  });
});

describe("the acceptor's date-of-birth format follows the bound column", () => {
  test("a column retyped as the date of birth is parsed with its own format", () => {
    // The seed binds `dob` (US layout); the operator retypes `birth_date` (ISO
    // layout) as the date of birth and `dob` as other. The console derives the
    // cleaning from the profiled per-column formats with no rows, and must parse
    // `birth_date` as ISO, as the hosted path inferring from the rows does.
    const dobTerms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [{ name: "date_of_birth", type: "date_of_birth" }],
      linkageKeys: [{ name: "d", elements: [{ field: "date_of_birth" }] }],
    };
    const columns = ["dob", "birth_date"];
    const csvRows: Array<CSVRow> = [
      { dob: "01/31/1990", birth_date: "1990-01-31" },
      { dob: "12/25/1985", birth_date: "1985-12-25" },
    ];
    const formats = dateInputFormatsForColumns(columns, csvRows);
    const seed = acceptorInitialColumnsState(columns);
    const retyped: AcceptorColumnsState = {
      ...seed,
      metadata: setColumnTypeForMatching(
        seed.metadata.map((column) =>
          column.name === "dob" ? { ...column, type: "other" } : column,
        ),
        "birth_date",
        "date_of_birth",
      ),
    };
    const fromProfile = acceptorColumnsEditorState(
      retyped,
      dobTerms,
      [],
      formats,
    );
    const [transform] = fromProfile.standardization;
    expect(transform.input).toBe("birth_date");
    expect(transform.steps).toContainEqual({
      function: "parse_date",
      params: { inputFormat: "YYYY-MM-DD", outputFormat: "YYYYMMDD" },
    });
    expect(fromProfile).toEqual(
      acceptorColumnsEditorState(retyped, dobTerms, csvRows),
    );
  });
});

describe("acceptor note for the partner", () => {
  test("a partial file lists keys by field type and names no column or key", () => {
    const columns = ["first_name", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const note = acceptorPartnerNote(columns, nameTerms, editorState);
    expect(note).toContain(
      "My file can supply 1 of the 2 agreed linkage keys.",
    );
    expect(note).toContain("Keys my file can supply:\n- First name");
    expect(note).toContain("Keys my file cannot supply:\n- Last name");
    expect(note).toContain("Field types my file does not have: Last name.");
    for (const name of ["first_name", "notes", "firstName", "lastName"])
      expect(note).not.toContain(name);
    expect(note).not.toMatch(/\bfirst\b|\blast\b/);
  });

  test("a blocked file says no key can be supplied", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const note = acceptorPartnerNote(["notes"], nameTerms, editorState);
    expect(note).toContain(
      "My file cannot supply any of the 2 agreed linkage keys.",
    );
    expect(note).not.toContain("Keys my file can supply:");
  });

  test("keys naming the same field types are listed once with a count", () => {
    const terms: LinkageTerms = {
      ...nameTerms,
      linkageKeys: [
        ...nameTerms.linkageKeys,
        { name: "last again", elements: [{ field: "lastName" }] },
      ],
    };
    const columns = ["first_name"];
    const { editorState } = editorFor(columns, terms);
    expect(acceptorPartnerNote(columns, terms, editorState)).toContain(
      "- Last name (2 keys)",
    );
  });

  test("a fully covered file has no note", () => {
    const columns = ["first_name", "last_name"];
    const { editorState } = editorFor(columns, nameTerms);
    expect(
      acceptorPartnerNote(columns, nameTerms, editorState),
    ).toBeUndefined();
  });
});

describe("acceptor verdict (re-shown, not re-derived)", () => {
  test("a file with no matching columns is blocked with the exact mockup title and a distinct announcement", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const verdict = acceptorVerdict(["notes"], nameTerms, editorState);
    expect(verdict.kind).toBe("blocked");
    expect(verdict.title).toBe("This file cannot match yet");
    // The spoken form is worded differently from the visible title.
    expect(verdict.announcement).toBe(
      "No agreed linkage key can be satisfied by your columns yet.",
    );
    expect(verdict.announcement).not.toBe(verdict.title);
  });

  test("a partially-covered file shows N-of-M and is not fully satisfied", () => {
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(verdict.title).toBe("1 of 2 keys can match");
    expect(verdict.announcement).toBe(
      "1 of 2 linkage keys can be satisfied by your columns.",
    );
    // The three display kinds show coverage; the launch decision is core's.
    expect(verdict.fullySatisfied).toBe(false);
  });

  test("a fully-covered file is all-clear", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("allClear");
    expect(verdict.title).toBe("All 2 keys can match");
    expect(verdict.announcement).toBe(
      "All 2 linkage keys can be satisfied by your columns.",
    );
  });

  test("a file that read as one column states the delimiter remedy", () => {
    // One column holding the whole header is what a file separated by something
    // other than the delimiter it was read by comes out as, and that delimiter is
    // a control on this screen -- unlike the adopted terms.
    const mashed = ["first_name\tlast_name"];
    const { editorState } = editorFor(mashed, nameTerms);
    const verdict = acceptorVerdict(mashed, nameTerms, editorState);
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.delimiterRemedy).toBe(CSV_DELIMITER_SINGLE_COLUMN_REMEDY);
  });

  test("a shortfall over several columns states no delimiter remedy", () => {
    const columns = ["first_name", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.delimiterRemedy).toBe("");
  });

  test("a self-defeating adopted rule shows all-clear on coverage yet is not satisfied", () => {
    const { editorState } = editorFor(["date_of_birth"], deadDobTerms);
    const verdict = acceptorVerdict(
      ["date_of_birth"],
      deadDobTerms,
      editorState,
    );
    // The columns are present, so the coverage reading passes and the dead rule is
    // reported separately as a count -- but the key can never match, so the run
    // decision does not follow the coverage reading.
    expect(verdict.kind).toBe("allClear");
    expect(verdict.deadKeyCount).toBe(1);
    expect(verdict.fullySatisfied).toBe(false);
  });
});

describe("acceptor quick-fix mapper", () => {
  test("appears only when a required field type is missing, one entry per unsatisfied type", () => {
    // Both name types missing -> two mapper entries.
    const blocked = editorFor(["alpha", "beta"], nameTerms);
    const types = acceptorUnsatisfiedTypes(
      ["alpha", "beta"],
      nameTerms,
      blocked.editorState,
    );
    expect(types.map((t) => t.type).sort()).toEqual([
      "first_name",
      "last_name",
    ]);
    expect(types.map((t) => t.label).sort()).toEqual([
      "First name",
      "Last name",
    ]);
  });

  test("is empty once every required type is covered", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    expect(
      acceptorUnsatisfiedTypes(
        ["first_name", "last_name"],
        nameTerms,
        editorState,
      ),
    ).toEqual([]);
  });

  test("a remap forces role linkage, so it flips the verdict -- a bare retype would not", () => {
    // Both columns infer to role: payload (unrecognized). setColumnTypeForMatching
    // must re-role the chosen column to linkage, not merely retype it.
    const columns = ["alpha", "beta"];
    const seed = acceptorInitialColumnsState(columns);
    // Sanity: a bare retype path is exactly what setColumnTypeForMatching guards
    // against; here we assert the matching helper produces a role: linkage column.
    const remapped = setColumnTypeForMatching(
      seed.metadata,
      "alpha",
      "first_name",
    );
    const alpha = remapped.find((c) => c.name === "alpha");
    expect(alpha?.role).toBe("linkage");
    expect(alpha?.type).toBe("first_name");

    // Driven through the model: after remapping alpha, first is satisfiable ->
    // partial; after remapping beta too, both -> all-clear.
    const afterAlpha = editorFor(columns, nameTerms, {
      metadata: remapped,
    });
    expect(
      acceptorVerdict(columns, nameTerms, afterAlpha.editorState).kind,
    ).toBe("partial");
    const bothRemapped = setColumnTypeForMatching(
      remapped,
      "beta",
      "last_name",
    );
    const afterBoth = editorFor(columns, nameTerms, {
      metadata: bothRemapped,
    });
    expect(
      acceptorVerdict(columns, nameTerms, afterBoth.editorState).kind,
    ).toBe("allClear");
  });
});

describe("acceptor launch gates", () => {
  // The gate IS the reason: `undefined` is the only enabled state, so a test that
  // pins the sentence pins the gate too, and a state that closes the gate without a
  // sentence -- the disabled button a screen-reader operator is told nothing about --
  // cannot be written.
  test("an unsatisfiable file disables launch (satisfiableKeyCount === 0) and says which columns to set", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const verdict = acceptorVerdict(["notes"], nameTerms, editorState);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
  });

  test("a satisfiable file enables launch", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeUndefined();
  });

  test("partial coverage disables launch and offers both remedies", () => {
    // An exchange runs every key both parties agreed on, so covering some of them
    // is refused at the run boundary -- and therefore here, where the operator can
    // still remap a column or go back to the partner.
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(verdict.fullySatisfied).toBe(false);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree on terms with your partner over the keys both files can supply.",
    );
  });

  test("a dead key disables launch and sends the operator to the partner", () => {
    // Every element field resolves, so coverage shows all-clear -- but the agreed
    // terms declare cleaning that drops every record, which no edit on this screen
    // clears. The sentence names the one remedy that exists.
    const columns = ["date_of_birth"];
    const { editorState } = editorFor(columns, deadDobTerms);
    const verdict = acceptorVerdict(columns, deadDobTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(verdict.deadKeyCount).toBe(1);
    expect(verdict.fullySatisfied).toBe(false);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, deadDobTerms),
    ).toBe(
      "Ask your partner for a corrected invitation before you can start: " +
        "cleaning declared in the agreed terms drops every record for a key, " +
        "so it can never match.",
    );
  });

  test("two identifier columns disable launch even when the keys are satisfiable, naming the identifier rule", () => {
    const columns = ["id", "identifier", "first_name", "last_name"];
    const { editorState } = editorFor(columns, nameTerms, {
      metadata: seedWithSecondIdentifier(columns),
    });
    // The keys are covered, but the metadata has two identifiers.
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Choose a single record identifier column above before you can start.",
    );
  });

  test("a mid-edit cleaning step disables launch (standardization invalid) and points at the steps", () => {
    // A date_of_birth field whose recommended parse_date step is cleared mid-edit:
    // the override layer has an invalid step, so the gate must close.
    const dobTerms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "d", elements: [{ field: "dob" }] }],
    };
    const columns = ["date_of_birth"];
    const seed = acceptorInitialColumnsState(columns);
    const base = acceptorColumnsEditorState(seed, dobTerms, rows(columns));
    const dobTransform = base.standardization[0];
    // Author an invalid parse_date (empty inputFormat) against the same input.
    const invalidSteps = [
      { function: "parse_date", params: { inputFormat: "" } },
    ];
    const withInvalid = editorFor(columns, dobTerms, {
      stepOverrides: new Map([
        [
          dobTransform.output,
          { input: dobTransform.input, steps: invalidSteps },
        ],
      ]),
    });
    const verdict = acceptorVerdict(columns, dobTerms, withInvalid.editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, withInvalid.editorState, dobTerms),
    ).toBe(
      "Finish, fix, or remove the highlighted cleaning steps above before you can start.",
    );
  });

  // The step's own gates, which the model cannot derive: an SFTP accept with no
  // connection authored, a file-handling combination core refuses, and a
  // connection-tuning value the run would refuse.
  const satisfiableColumns = ["first_name", "last_name"];
  const satisfiable = editorFor(satisfiableColumns, nameTerms);
  const satisfiableVerdict = acceptorVerdict(
    satisfiableColumns,
    nameTerms,
    satisfiable.editorState,
  );

  test("a device reporting offline disables launch and names the shared reason", () => {
    const blocks = {
      deduplicatePairRefused: false,
      deduplicateChangedAfterConsent: false,
      connectionBlocked: false,
      exchangeFilesBlocked: false,
      connectionTuningBlocked: false,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, offline: true },
      ),
    ).toBe(OFFLINE_EXCHANGE_REASON);
    // Only the offline direction gates: a device reporting a connection is not
    // treated as a promise that the partner is reachable, so it blocks nothing.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, offline: false },
      ),
    ).toBeUndefined();
  });

  test("a refused duplicate-matching pair disables launch from a later step", () => {
    // The review step disables its own Continue on the pair, but the browser can
    // restore a later step straight from history: a Forward past that button
    // would otherwise reach the launch with the refused value still set. The
    // remedy is back on the terms, so the sentence sends the operator there.
    const blocks = {
      offline: false,
      deduplicateChangedAfterConsent: false,
      connectionBlocked: false,
      exchangeFilesBlocked: false,
      connectionTuningBlocked: false,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, deduplicatePairRefused: true },
      ),
    ).toBe(
      "Go back to the terms and resolve the duplicate-matching settings " +
        "before you can start.",
    );
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, deduplicatePairRefused: false },
      ),
    ).toBeUndefined();
  });

  test("a duplicate-matching value moved since consent disables launch", () => {
    // The run presents the value the consent gate committed, so the two must
    // agree before it starts: launching would run a value the terms step no
    // longer shows, and the control alone changes nothing the operator
    // consented to.
    const blocks = {
      offline: false,
      deduplicatePairRefused: false,
      connectionBlocked: false,
      exchangeFilesBlocked: false,
      connectionTuningBlocked: false,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, deduplicateChangedAfterConsent: true },
      ),
    ).toBe(
      "This exchange runs with the duplicate-matching setting you accepted, " +
        "which is not the one now on the terms step. Accept again to apply " +
        "the change, or set the control back.",
    );
    // The refused pair speaks first: its own control clears both.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          ...blocks,
          deduplicatePairRefused: true,
          deduplicateChangedAfterConsent: true,
        },
      ),
    ).toBe(
      "Go back to the terms and resolve the duplicate-matching settings " +
        "before you can start.",
    );
  });

  test("offline speaks ahead of the screen's own problems, which no edit here can outrun", () => {
    // A file that can match nothing is a fix the operator makes on this screen;
    // no network is not, so it is the sentence they meet first rather than the
    // one waiting after every column is set.
    const columns = ["id", "identifier", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.satisfiableKeyCount).toBe(0);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms, {
        offline: true,
        deduplicatePairRefused: false,
        deduplicateChangedAfterConsent: false,
        connectionBlocked: false,
        exchangeFilesBlocked: false,
        connectionTuningBlocked: false,
        runDiagnosticsBlocked: false,
        receiptsBlocked: false,
      }),
    ).toBe(OFFLINE_EXCHANGE_REASON);
  });

  test("an unauthored transport connection disables launch and names the connection card", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          deduplicatePairRefused: false,
          deduplicateChangedAfterConsent: false,
          connectionBlocked: true,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    ).toBe("Set up the SFTP connection above before you can start.");
  });

  test("a split rendezvous without retain mode disables launch, in the console's words", () => {
    // The acceptor's directories are the console's own mounts, so a split
    // console imposes the retain precondition on every accept it runs -- and
    // the sentence the operator meets is the one naming the control to turn on,
    // taken from the shared predicate rather than restated here.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          deduplicatePairRefused: false,
          deduplicateChangedAfterConsent: false,
          connectionBlocked: false,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
          splitDirectoryProblem: splitRendezvousRetainProblem(
            { configured: true, split: true, locator: "in" },
            false,
          ),
        },
      ),
    ).toBe(SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT);
  });

  test("a refused file-handling combination disables launch and names those settings", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          deduplicatePairRefused: false,
          deduplicateChangedAfterConsent: false,
          connectionBlocked: false,
          exchangeFilesBlocked: true,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    ).toBe("Resolve the file-handling settings above before you can start.");
  });

  test("a refused connection-tuning value names that card rather than the file-handling one", () => {
    // Both cards sit in the one section below the columns, so a shared flag would
    // send the operator to the wrong one -- and each is a collapsed disclosure
    // whose own problem notice is invisible until it is opened. Driven through
    // both cards' models exactly as the screen drives them, rather than by setting
    // the flags by hand.
    const stepBlocks = {
      offline: false,
      deduplicatePairRefused: false,
      deduplicateChangedAfterConsent: false,
      connectionBlocked: false,
      exchangeFilesBlocked:
        exchangeFilesProblems(EXCHANGE_FILES_DEFAULT, CONFIG_EXCHANGE_FILES)
          .length > 0,
      connectionTuningBlocked:
        connectionTuningProblems({
          ...CONNECTION_TUNING_DEFAULT,
          peerTimeout: { magnitude: "soon", unit: "m" },
        }).length > 0,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(stepBlocks.exchangeFilesBlocked).toBe(false);
    expect(stepBlocks.connectionTuningBlocked).toBe(true);
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        stepBlocks,
      ),
    ).toBe(
      "Resolve the connection-tuning settings above before you can start.",
    );
  });

  test("a diverging signing identity holds the launch in its own words", () => {
    // The one gate whose sentence IS the statement rather than a pointer at a
    // control: both of its remedies are off this screen -- the name committed at
    // the consent gate, and a re-key at the command line -- so the blocked-launch
    // line is where the operator reads the whole thing. Composed by the receipts
    // model the card drives, not written by hand here.
    const statement = signingIdentityDivergence(
      receiptsWithResolvedIdentity(
        { ...RECEIPTS_DEFAULT, mode: "certificate" },
        "B".repeat(42) + "A",
        "County Registrar",
      ),
      "Agency A",
    );
    expect(statement).toBeDefined();
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          deduplicatePairRefused: false,
          deduplicateChangedAfterConsent: false,
          connectionBlocked: false,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
          ...(statement !== undefined
            ? { signingIdentityDivergence: statement }
            : {}),
        },
      ),
    ).toBe(statement);
  });

  test("omitting the step's own gates is the same as none of them being set", () => {
    // The default the model tests read, stated once so it is a decision rather than
    // an accident of the signature.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
      ),
    ).toBe(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          deduplicatePairRefused: false,
          deduplicateChangedAfterConsent: false,
          connectionBlocked: false,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    );
  });

  test("with several gates closed the sentence names the topmost surface on the screen", () => {
    // A file that can match nothing AND has two identifiers AND has no
    // connection authored: the operator is sent to the verdict at the top of the
    // step, not to a gate further down that a fix up there may clear anyway.
    const columns = ["id", "identifier", "notes"];
    const { editorState } = editorFor(columns, nameTerms, {
      metadata: seedWithSecondIdentifier(columns),
    });
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.satisfiableKeyCount).toBe(0);
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms, {
        offline: false,
        deduplicatePairRefused: false,
        deduplicateChangedAfterConsent: false,
        connectionBlocked: true,
        exchangeFilesBlocked: true,
        connectionTuningBlocked: true,
        runDiagnosticsBlocked: false,
        receiptsBlocked: false,
      }),
    ).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
  });
});

describe("a marked column whose name is too long to include", () => {
  // The gap this closes: the marks name the acceptor's own header, which no
  // schema bounds, so an oversized name is markable
  // here and refused only by the partner's parse of the payload frame -- after the
  // frame is sent.
  const atCeiling = "a".repeat(MAX_NAME_LENGTH);
  const pastCeiling = atCeiling + "a";
  // One code POINT, two UTF-16 code units: MAX_NAME_LENGTH of them is under the
  // ceiling on the count ColumnName's display cut uses and over it on the count
  // every such bound uses.
  const astralPastCeiling = "\u{1D54F}".repeat(MAX_NAME_LENGTH);

  /** The columns step for a file covering both keys plus one column of the given
   * name, marked to send. */
  function stepFor(name: string) {
    const columns = ["first_name", "last_name", name];
    const { editorState } = editorFor(columns, nameTerms, {
      metadata: seededWithSent(columns, [name]),
    });
    return {
      editorState,
      verdict: acceptorVerdict(columns, nameTerms, editorState),
    };
  }

  test("a name at the ceiling is valid and does not block launch", () => {
    const { editorState, verdict } = stepFor(atCeiling);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([atCeiling]);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeUndefined();
  });

  test("one code unit past the ceiling blocks launch, naming the notice above", () => {
    const { editorState, verdict } = stepFor(pastCeiling);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3]);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Resolve the column name that is too long to send above before you can start.",
    );
  });

  test("the bound counts UTF-16 code units, not the code points the display cut counts", () => {
    expect([...astralPastCeiling].length).toBe(MAX_NAME_LENGTH);
    expect(astralPastCeiling.length).toBe(MAX_NAME_LENGTH * 2);
    const { editorState, verdict } = stepFor(astralPastCeiling);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeDefined();
  });

  test("unmarking the column clears the block -- the file itself is not refused", () => {
    // An oversized name is fully usable for matching and ignoring: the bound is on
    // what is DISCLOSED, so it clears on this screen without another file.
    const { editorState, verdict } = stepFor(pastCeiling);
    const unmarked = {
      ...editorState,
      metadata: setColumnDisclosure(
        editorState.metadata,
        pastCeiling,
        "ignored",
      ).metadata,
    };
    expect(acceptorDisclosedColumns(unmarked.metadata)).toEqual([]);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, unmarked.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, unmarked, nameTerms),
    ).toBeUndefined();
  });

  test("several offending columns pluralize the sentence", () => {
    const columns = ["first_name", "last_name", pastCeiling, pastCeiling + "b"];
    const { editorState } = editorFor(columns, nameTerms, {
      metadata: seededWithSent(columns, [pastCeiling, pastCeiling + "b"]),
    });
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3, 4]);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Resolve the column names that are too long to send above before you can start.",
    );
  });

  test("says nothing when the inviting party is entitled to no result", () => {
    // Nothing is transmitted to a party that receives no result, so no name is
    // disclosed and the run does not refuse this pair -- and the panel beside the
    // grid already states that no column leaves whatever these marks say.
    const noResultTerms: LinkageTerms = {
      ...nameTerms,
      output: { expectsOutput: false, shareWithPartner: true },
    };
    const columns = ["first_name", "last_name", pastCeiling];
    const { editorState } = editorFor(columns, noResultTerms, {
      metadata: seededWithSent(columns, [pastCeiling]),
    });
    const verdict = acceptorVerdict(columns, noResultTerms, editorState);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([
      pastCeiling,
    ]);
    expect(
      acceptorOverlongDisclosedColumns(noResultTerms, editorState.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, noResultTerms),
    ).toBeUndefined();
  });

  test("the gate refuses exactly what core's prepare-time refusal does", () => {
    // Driven through core's own function rather than a second model of it: the
    // screen and the run must not disagree about which names are valid. The
    // acceptor's own output is the invitation's mirrored onto it, which is what
    // core reads.
    const accepted = deriveAcceptedLinkageTerms(nameTerms, "Sam Alvarez");
    for (const name of [atCeiling, pastCeiling, astralPastCeiling]) {
      const { editorState } = stepFor(name);
      let coreRefused = false;
      try {
        assertDisclosedNamesCarriable(editorState.metadata, accepted.output);
      } catch {
        coreRefused = true;
      }
      expect(
        acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata)
          .length > 0,
      ).toBe(coreRefused);
    }
  });
});

describe("the invitation's declared payload set against the marks", () => {
  // A file covering both keys plus one unrecognized column marked to send -- so
  // the file discloses exactly one column and every other gate is clear.
  // `record_id` infers to the identifier role (unsent, unmatched), so marking it
  // adds a disclosure without costing a key -- which lets an open launch be
  // pinned beside each conflict without the linkage clause firing.
  const columns = ["first_name", "last_name", "notes", "record_id"];

  /** Every invitation shape this describe drives, named once. The equivalence
   * test below reads this table rather than a copy of it, so a shape added here
   * is checked against core's own enforcement without a second edit. */
  const shapes = {
    acceptsNothingAndTakesTheResult: { payload: { receive: [] } },
    acceptsNothingAndTakesNoResult: {
      output: { expectsOutput: false, shareWithPartner: true },
      payload: { receive: [] },
    },
    declaresNoPayloadAtAll: {},
    declaresOnlyWhatItSends: { payload: { send: [{ name: "risk_score" }] } },
    acceptsTheDisclosedColumn: { payload: { receive: [{ name: "notes" }] } },
    acceptsOnlyAColumnNotDisclosed: {
      payload: { receive: [{ name: "risk_score" }] },
    },
    acceptsTheDisclosedColumnAndOneTheFileLacks: {
      payload: { receive: [{ name: "notes" }, { name: "risk_score" }] },
    },
    acceptsTheDisclosedColumnAndOneMarkedForMatching: {
      payload: { receive: [{ name: "notes" }, { name: "first_name" }] },
    },
  } satisfies Record<string, Partial<LinkageTerms>>;

  /** The invitation's own perspective, which the columns step holds, with the
   * named shape's payload declaration and output entitlement. Taking a name rather
   * than a literal keeps {@link shapes} the only place a shape is written. */
  function invitation(shape: keyof typeof shapes): LinkageTerms {
    return { ...nameTerms, ...shapes[shape] };
  }

  const notesSent = seededWithSent(columns, ["notes"]);

  /** The mark states every shape is driven in. The base marks disclose one
   * column, so a declaration can only omit that one or name others; the second
   * state discloses two, which is what makes a NON-EMPTY declaration able to omit
   * one while naming another -- the under-declared direction the empty declaration
   * cannot produce on this file. */
  const markStates = {
    onlyNotesSent: notesSent,
    firstNameAlsoSent: setColumnDisclosure(notesSent, "first_name", "payload")
      .metadata,
    recordIdAlsoSent: setColumnDisclosure(notesSent, "record_id", "payload")
      .metadata,
  } satisfies Record<string, Metadata>;

  /** Whether core's own comparison finds the marks differ from the declaration,
   * driven through the real functions rather than a second model of them: the
   * invitation mirrored onto this party by {@link deriveAcceptedLinkageTerms},
   * checked by {@link assertPayloadSendDisclosed}. */
  function coreFindsDifference(
    terms: LinkageTerms,
    metadata: Metadata,
  ): boolean {
    const accepted = deriveAcceptedLinkageTerms(terms, "Sam Alvarez");
    try {
      assertPayloadSendDisclosed(accepted.payload, metadata, accepted.output);
      return false;
    } catch {
      return true;
    }
  }

  test("names the disclosed columns without holding the launch when the invitation accepts none and the inviting party receives the result", () => {
    // Core offers an empty declaration's difference as a terms change, as it
    // does any other, so the notice informs and the launch stays open.
    const terms = invitation("acceptsNothingAndTakesTheResult");
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.sentButNotDeclared).toEqual(["notes"]);
    expect(conflict?.declaredButNotSent).toEqual([]);
    expect(conflict?.title).toBe(
      "Your partner's invitation lists no columns to receive",
    );
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(false);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();
  });

  test("says nothing when the inviting party is entitled to no result", () => {
    // Nothing is transmitted to a party that receives no result, so there is no
    // difference to state -- and the panel beside the grid already states that no
    // column leaves whatever these marks say.
    const terms = invitation("acceptsNothingAndTakesNoResult");
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata),
    ).toBeUndefined();
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();
  });

  test("says nothing when the invitation declares no payload set at all", () => {
    // The lazy direction: an absent declaration is reconciled against this party's
    // own disclosure when the exchange runs, not against a set it never named --
    // whether the invitation has no payload block, or one naming only what it
    // sends.
    for (const terms of [
      invitation("declaresNoPayloadAtAll"),
      invitation("declaresOnlyWhatItSends"),
    ]) {
      const { editorState } = editorFor(columns, terms, {
        metadata: notesSent,
      });
      expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
      expect(
        acceptorPayloadDeclarationConflict(terms, editorState.metadata),
      ).toBeUndefined();
      const verdict = acceptorVerdict(columns, terms, editorState);
      expect(
        acceptorLaunchBlockedReason(verdict, editorState, terms),
      ).toBeUndefined();
    }
  });

  test("says nothing when the declaration names exactly the columns the marks send", () => {
    const terms = invitation("acceptsTheDisclosedColumn");
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata),
    ).toBeUndefined();
  });

  test("clears as the operator re-marks every disclosed column", () => {
    const terms = invitation("acceptsNothingAndTakesTheResult");
    // A matched column additionally marked sent, so the edit that clears the
    // conflict is exercised on both routes off that mark: back to matching for a
    // linkage column, and ignored for the unrecognized one, which cannot match.
    const sentTwice = markStates.firstNameAlsoSent;
    const seeded = editorFor(columns, terms, { metadata: sentTwice });
    expect(
      acceptorPayloadDeclarationConflict(terms, seeded.editorState.metadata)
        ?.sentButNotDeclared,
    ).toEqual(["first_name", "notes"]);

    // One of the two re-marked leaves the conflict standing on the other.
    const partly = setColumnDisclosure(sentTwice, "notes", "ignored").metadata;
    const halfCleared = editorFor(columns, terms, { metadata: partly });
    expect(
      acceptorPayloadDeclarationConflict(
        terms,
        halfCleared.editorState.metadata,
      )?.sentButNotDeclared,
    ).toEqual(["first_name"]);
    // Sending a matched column costs the key it matched on, so this state is short
    // of an agreed key as well as over-disclosing -- and the linkage clause is the
    // one the operator meets first, at the top of the screen. The remaining mark is
    // still named by the notice it points at.
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, halfCleared.editorState),
        halfCleared.editorState,
        terms,
      ),
    ).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree on terms with your partner over the keys both files can supply.",
    );

    const cleared = setColumnDisclosure(partly, "first_name", "match").metadata;
    const edited = editorFor(columns, terms, { metadata: cleared });
    expect(acceptorDisclosedColumns(edited.editorState.metadata)).toEqual([]);
    expect(
      acceptorPayloadDeclarationConflict(terms, edited.editorState.metadata),
    ).toBeUndefined();
    const verdict = acceptorVerdict(columns, terms, edited.editorState);
    expect(verdict.kind).toBe("allClear");
    expect(
      acceptorLaunchBlockedReason(verdict, edited.editorState, terms),
    ).toBeUndefined();
  });

  test("a non-empty declaration that omits a marked column names it without holding the launch, and a re-mark here clears it", () => {
    // Under-declaration against a NON-EMPTY declaration: the declaration names one
    // of the two columns the marks send. The partner's run is offered the
    // difference before any data moves, so the notice informs and the launch
    // stays open.
    const terms = invitation("acceptsTheDisclosedColumn");
    const marked = editorFor(columns, terms, {
      metadata: markStates.recordIdAlsoSent,
    });
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      marked.editorState.metadata,
    );
    expect(conflict?.sentButNotDeclared).toEqual(["record_id"]);
    expect(conflict?.declaredButNotSent).toEqual([]);
    expect(conflict?.title).toBe(
      "Your partner's invitation does not list this column",
    );
    const verdict = acceptorVerdict(columns, terms, marked.editorState);
    expect(verdict.fullySatisfied).toBe(true);
    expect(
      acceptorLaunchBlockedReason(verdict, marked.editorState, terms),
    ).toBeUndefined();

    const reMarked = editorFor(columns, terms, {
      metadata: setColumnDisclosure(
        markStates.recordIdAlsoSent,
        "record_id",
        "identifier",
      ).metadata,
    });
    expect(
      acceptorPayloadDeclarationConflict(terms, reMarked.editorState.metadata),
    ).toBeUndefined();
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, reMarked.editorState),
        reMarked.editorState,
        terms,
      ),
    ).toBeUndefined();
  });

  test("a declared column the file does not have is named as absent, no local edit is offered, and the launch stays open", () => {
    // Over-declaration with no local remedy at all: the operator cannot mark a
    // column their file does not have, so the entry says so.
    const terms = invitation("acceptsTheDisclosedColumnAndOneTheFileLacks");
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.sentButNotDeclared).toEqual([]);
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(conflict?.title).toBe(
      "Your partner's invitation lists a column you are not sending",
    );
    expect(acceptorWideningOfferSentence(terms, editorState.metadata)).toBe(
      undefined,
    );
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();
  });

  test("a declared column the file does have is flagged as one the operator could mark, and marking it clears the conflict", () => {
    // The secondary remedy, which exists only here: the column is in the file, so
    // marking it to send is available -- at the cost of disclosing more, which is
    // why it is never the notice's lead.
    const terms = invitation(
      "acceptsTheDisclosedColumnAndOneMarkedForMatching",
    );
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "first_name", inFile: true }]);

    const widened = editorFor(columns, terms, {
      metadata: markStates.firstNameAlsoSent,
    });
    expect(
      acceptorPayloadDeclarationConflict(terms, widened.editorState.metadata),
    ).toBeUndefined();
    // Widening clears the conflict but does not open the launch here: the column
    // the partner asked for is one this file matches on, so sending it costs the
    // key -- an exchange the run boundary refuses. The gate says so rather than
    // letting the operator launch into that refusal.
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, widened.editorState),
        widened.editorState,
        terms,
      ),
    ).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree on terms with your partner over the keys both files can supply.",
    );
  });

  test("a declared column the file keeps as its record identifier is offered too, and stays the identifier", () => {
    // The same offer over a column that is neither matched on nor sent: `record_id`
    // infers to the identifier role, so `inFile` is read from the metadata whatever
    // use the column currently has, and the offer sends it as the identifier, so
    // the file's own result still begins with it.
    const identifierColumns = ["first_name", "last_name", "record_id"];
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: "record_id" }] },
    };
    const { state, editorState } = editorFor(identifierColumns, terms);
    expect(
      editorState.metadata.find((column) => column.name === "record_id")?.role,
    ).toBe("identifier");
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([]);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "record_id", inFile: true }]);

    const widened = acceptorWidenedMetadata(terms, editorState.metadata);
    expect(acceptorPayloadDeclarationConflict(terms, widened)).toBeUndefined();
    const recordId = widened.find((column) => column.name === "record_id")!;
    expect(disclosureOf(recordId)).toBe("identifier-sent");
    expect(acceptorDisclosedColumns(widened)).toEqual(["record_id"]);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send it, set it to "${DISCLOSURE_LABELS["identifier-sent"]}" below.`,
    );
  });

  test("the offer names the choice it applies to each column it would set", () => {
    // The record identifier and a column used for nothing, offered together:
    // the identifier stays the identifier and is sent, the other column is sent.
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: "record_id" }, { name: "notes" }] },
    };
    const { state } = editorFor(columns, terms);
    const widened = acceptorWidenedMetadata(terms, state.metadata);
    expect(
      widened
        .filter((column) => ["record_id", "notes"].includes(column.name))
        .map((column) => [column.name, disclosureOf(column)]),
    ).toEqual([
      ["notes", "payload"],
      ["record_id", "identifier-sent"],
    ]);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send them, set your record identifier to "${DISCLOSURE_LABELS["identifier-sent"]}" and the other column to "${DISCLOSURE_LABELS.payload}" below.`,
    );
  });

  test("the offer names the matched column's own choice beside the identifier's, and costs no key", () => {
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: "record_id" }, { name: "first_name" }] },
    };
    const { state } = editorFor(columns, terms);
    const keys = satisfiableKeysAroundOffer(columns, terms, state);
    expect(keys.before).toBeGreaterThan(0);
    expect(keys.after).toBe(keys.before);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send them, set your record identifier to "${DISCLOSURE_LABELS["identifier-sent"]}" and the column used to match to "${DISCLOSURE_LABELS["match-sent"]}" below.`,
    );
  });

  test("the offer over all three uses names each one's choice", () => {
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: {
        receive: [
          { name: "record_id" },
          { name: "first_name" },
          { name: "notes" },
        ],
      },
    };
    const { state } = editorFor(columns, terms);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send them, set your record identifier to "${DISCLOSURE_LABELS["identifier-sent"]}", the column used to match to "${DISCLOSURE_LABELS["match-sent"]}", and the other column to "${DISCLOSURE_LABELS.payload}" below.`,
    );
  });

  test("a declaration naming the same held-but-unsent column twice widens it once", () => {
    // A declaration may name one column twice; that is still one column to list,
    // one to mark, and one the widening offer marks.
    const identifierColumns = ["first_name", "last_name", "record_id"];
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: "record_id" }, { name: "record_id" }] },
    };
    const { state, editorState } = editorFor(identifierColumns, terms);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "record_id", inFile: true }]);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send it, set it to "${DISCLOSURE_LABELS["identifier-sent"]}" below.`,
    );
  });

  test.each([{ receive: ["identifier"] }, { receive: ["id", "identifier"] }])(
    "with two record identifiers, the offer sends the unsent one of $receive as payload and changes no other column",
    ({ receive }) => {
      // `id` set sent and a second identifier unsent, so the file has no one
      // record identifier. The offer marks no column identifier-and-sent,
      // demotes no identifier, and leaves the already-sent `id` as it is.
      const twoIdentifierColumns = [
        "id",
        "identifier",
        "first_name",
        "last_name",
      ];
      const terms: LinkageTerms = {
        ...nameTerms,
        payload: { receive: receive.map((name) => ({ name })) },
      };
      const { state } = editorFor(twoIdentifierColumns, terms, {
        metadata: seedWithSecondIdentifier(twoIdentifierColumns, false).map(
          (column) =>
            column.name === "id" ? { ...column, isPayload: true } : column,
        ),
      });
      expect(
        state.metadata
          .filter((column) => column.role === "identifier")
          .map((column) => [column.name, disclosureOf(column)]),
      ).toEqual([
        ["id", "identifier-sent"],
        ["identifier", "identifier"],
      ]);

      const widened = acceptorWidenedMetadata(terms, state.metadata);
      for (const column of widened) {
        const before = state.metadata.find((c) => c.name === column.name)!;
        if (column.name === "identifier")
          expect(disclosureOf(column), column.name).toBe("payload");
        else expect(column, column.name).toEqual(before);
      }
      expect(acceptorDisclosedColumns(widened)).toEqual(["id", "identifier"]);
      expect(
        acceptorPayloadDeclarationConflict(terms, widened)
          ?.declaredButNotSent ?? [],
      ).toEqual([]);
      expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
        ` To send it, set it to "${DISCLOSURE_LABELS.payload}" below.`,
      );
    },
  );

  test("a widened column this file matches on keeps its role and is sent", () => {
    const terms = invitation(
      "acceptsTheDisclosedColumnAndOneMarkedForMatching",
    );
    const { state, editorState } = editorFor(columns, terms, {
      metadata: notesSent,
    });
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "first_name", inFile: true }]);

    const widenedMetadata = acceptorWidenedMetadata(terms, state.metadata);
    const firstName = widenedMetadata.find(
      (column) => column.name === "first_name",
    )!;
    expect(firstName.role).toBe("linkage");
    expect(firstName.isPayload).toBe(true);
    expect(disclosureOf(firstName)).toBe("match-sent");
    expect(acceptorDisclosedColumns(widenedMetadata)).toEqual([
      "first_name",
      "notes",
    ]);
    expect(coreFindsDifference(terms, widenedMetadata)).toBe(false);

    const keys = satisfiableKeysAroundOffer(columns, terms, state);
    expect(keys.after).toBe(keys.before);
    const widened = editorFor(columns, terms, { metadata: widenedMetadata });
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, widened.editorState),
        widened.editorState,
        terms,
      ),
    ).toBeUndefined();
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send it, set it to "${DISCLOSURE_LABELS["match-sent"]}" below.`,
    );
  });

  test("the offer over several columns this file matches on names them together", () => {
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: {
        receive: [
          { name: "notes" },
          { name: "first_name" },
          { name: "last_name" },
        ],
      },
    };
    const { state } = editorFor(columns, terms, { metadata: notesSent });
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send them, set them to "${DISCLOSURE_LABELS["match-sent"]}" below.`,
    );
  });

  test("the offer costs no key for a declared column that feeds none", () => {
    // The two uses a declared column can sit at without feeding a key: the record
    // identifier, and a column used for nothing. Sending either replaces that use
    // and leaves every agreed key where it was, so the offer stands as it was.
    for (const { use, declaredName, metadata } of [
      {
        use: "the record identifier",
        declaredName: "record_id",
        metadata: notesSent,
      },
      {
        use: "a column used for nothing",
        declaredName: "notes",
        metadata: setColumnDisclosure(notesSent, "notes", "ignored").metadata,
      },
    ]) {
      const terms: LinkageTerms = {
        ...nameTerms,
        payload: { receive: [{ name: declaredName }] },
      };
      const { state, editorState } = editorFor(columns, terms, { metadata });
      expect(
        acceptorPayloadDeclarationConflict(terms, editorState.metadata)
          ?.declaredButNotSent,
        use,
      ).toEqual([{ displayName: declaredName, inFile: true }]);
      const keys = satisfiableKeysAroundOffer(columns, terms, state);
      expect(keys.after, use).toBe(keys.before);
    }
  });

  test("the offer is read from the whole declaration, past the names a notice paints", () => {
    // A surface paints at most MAX_DECLARED_NAMES_SHOWN of these names, so an
    // offer read per painted name would go quiet exactly where the declaration is
    // long. The column it offers sits past that bound here.
    const absent = Array.from(
      { length: MAX_DECLARED_NAMES_SHOWN + 1 },
      (_, index) => `absent_${index}`,
    );
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: {
        receive: [...absent, "first_name"].map((name) => ({ name })),
      },
    };
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    const { state, editorState } = editorFor(columns, terms, {
      metadata: notesSent,
    });
    const gaps =
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent ?? [];
    expect(
      gaps.slice(0, MAX_DECLARED_NAMES_SHOWN).some((gap) => gap.inFile),
    ).toBe(false);
    expect(acceptorWideningOfferSentence(terms, state.metadata)).toBe(
      ` To send the one in your file, set it to "${DISCLOSURE_LABELS["match-sent"]}" below.`,
    );
  });

  test("taking the offer costs no agreed key and clears the screen", () => {
    // The offer names no cost, so taking it must leave every key it found
    // satisfiable. Checked against the state one edit away as the console derives
    // it: the operator's own re-mark over the file's real rows, a file whose rows
    // fix the date-of-birth format among them.
    const dobColumns = ["date_of_birth", "first_name", "notes"];
    const dobTerms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [
        { name: "dob", type: "date_of_birth" },
        { name: "firstName", type: "first_name" },
      ],
      linkageKeys: [
        { name: "d", elements: [{ field: "dob" }] },
        { name: "f", elements: [{ field: "firstName" }] },
      ],
      payload: {
        receive: [{ name: "notes" }, { name: "date_of_birth" }],
      },
    };
    const offers: Array<{
      use: string;
      columns: Array<string>;
      terms: LinkageTerms;
      rows: Array<CSVRow>;
      sent: Array<string>;
      offered: Array<string>;
      choice: DisclosureChoice;
    }> = [
      {
        use: "a column the file matches on",
        columns,
        terms: invitation("acceptsTheDisclosedColumnAndOneMarkedForMatching"),
        rows: rows(columns),
        sent: ["notes"],
        offered: ["first_name"],
        choice: "match-sent",
      },
      {
        use: "the file's record identifier",
        columns: ["first_name", "last_name", "record_id"],
        terms: { ...nameTerms, payload: { receive: [{ name: "record_id" }] } },
        rows: rows(["first_name", "last_name", "record_id"]),
        sent: [],
        offered: ["record_id"],
        choice: "identifier-sent",
      },
      {
        use: "a date-of-birth column whose format the rows fix",
        columns: dobColumns,
        terms: dobTerms,
        rows: [{ date_of_birth: "1980-01-02", first_name: "Ann", notes: "x" }],
        sent: ["notes"],
        offered: ["date_of_birth"],
        choice: "match-sent",
      },
    ];
    for (const offer of offers) {
      expect(safeParseLinkageTerms(offer.terms).success, offer.use).toBe(true);
      const state: AcceptorColumnsState = {
        ...acceptorInitialColumnsState(offer.columns),
        metadata: seededWithSent(offer.columns, offer.sent),
      };
      const before = acceptorColumnsEditorState(state, offer.terms, offer.rows);
      // What taking the offer does, in full: the declared columns this file has are
      // exactly the ones re-marked below.
      expect(
        acceptorPayloadDeclarationConflict(offer.terms, before.metadata)
          ?.declaredButNotSent.filter((gap) => gap.inFile)
          .map((gap) => gap.displayName),
        offer.use,
      ).toEqual(offer.offered);
      const taken = offer.offered.reduce(
        (metadata, name) =>
          setColumnDisclosure(metadata, name, offer.choice).metadata,
        state.metadata,
      );
      expect(taken, offer.use).toEqual(
        acceptorWidenedMetadata(offer.terms, state.metadata),
      );
      const after = acceptorColumnsEditorState(
        { ...state, metadata: taken },
        offer.terms,
        offer.rows,
      );
      expect(
        acceptorVerdict(offer.columns, offer.terms, after).satisfiableKeyCount,
        offer.use,
      ).toBe(
        acceptorVerdict(offer.columns, offer.terms, before).satisfiableKeyCount,
      );
      expect(
        acceptorLaunchBlockedReason(
          acceptorVerdict(offer.columns, offer.terms, after),
          after,
          offer.terms,
        ),
        offer.use,
      ).toBeUndefined();
    }
  });

  test("both directions at once are stated together, and clearing one leaves the other named", () => {
    const terms = invitation("acceptsOnlyAColumnNotDisclosed");
    const { editorState } = editorFor(columns, terms, { metadata: notesSent });
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.sentButNotDeclared).toEqual(["notes"]);
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(conflict?.title).toBe(
      "Your columns differ from your partner's invitation",
    );
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();

    const reMarked = editorFor(columns, terms, {
      metadata: setColumnDisclosure(notesSent, "notes", "ignored").metadata,
    });
    const remaining = acceptorPayloadDeclarationConflict(
      terms,
      reMarked.editorState.metadata,
    );
    expect(remaining?.sentButNotDeclared).toEqual([]);
    expect(remaining?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(remaining?.title).toBe(
      "Your partner's invitation lists a column you are not sending",
    );
  });

  test("a declared name is escaped and the operator's own header is not", () => {
    // The two halves of one statement have different provenance: the declaration
    // is the partner's text, which reaches the operator escaped at this sink; the
    // marked names are the operator's own CSV headers, which the step renders
    // through ColumnName's isolation and so must arrive here verbatim. Applying
    // either treatment to both is the failure this pins.
    // Written as an escape, never as a raw byte, so a test about an invisible
    // character is itself readable: U+202E RIGHT-TO-LEFT OVERRIDE, which reorders
    // the copy around it wherever it is rendered unescaped and uncontained.
    const partnerName = "risk\u202Escore";
    const ownHeader = "notes\u202Eevil";
    const ownColumns = ["first_name", "last_name", ownHeader];
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: partnerName }] },
    };
    const { editorState } = editorFor(ownColumns, terms, {
      metadata: seededWithSent(ownColumns, [ownHeader]),
    });
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: sanitizeForDisplay(partnerName), inFile: false },
    ]);
    expect(conflict?.declaredButNotSent[0].displayName).not.toBe(partnerName);
    expect(conflict?.sentButNotDeclared).toEqual([ownHeader]);
  });

  test("every shape this describe drives is an invitation core would accept", () => {
    // The equivalence below is only worth what its shapes are: a shape core's own
    // schema would refuse at decode can never reach this step, so agreeing with
    // core on it would prove nothing.
    for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>)
      expect(safeParseLinkageTerms(invitation(shape)).success, shape).toBe(
        true,
      );
  });

  test("a non-empty declaration cannot arrive alongside an inviting party entitled to no result", () => {
    // Why the non-empty comparison is not gated on the output direction without
    // contradicting the panel that says nothing is sent: the pair those two
    // statements would need is not a parseable invitation.
    expect(
      safeParseLinkageTerms({
        ...nameTerms,
        output: { expectsOutput: false, shareWithPartner: true },
        payload: { receive: [{ name: "risk_score" }] },
      }).success,
    ).toBe(false);
  });

  test("fires exactly when core's comparison finds a difference, and never holds the launch", () => {
    // Every shape this describe drives, in every mark state, through core's real
    // mirror and real comparison. Core offers every difference, an empty
    // declaration included, as a terms change, so the launch gate reads the
    // same with the declaration removed.
    for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>)
      for (const marks of Object.keys(markStates) as Array<
        keyof typeof markStates
      >) {
        const terms = invitation(shape);
        const { editorState } = editorFor(columns, terms, {
          metadata: markStates[marks],
        });
        const conflict = acceptorPayloadDeclarationConflict(
          terms,
          editorState.metadata,
        );
        expect(conflict !== undefined, `${shape} / ${marks}`).toBe(
          coreFindsDifference(terms, editorState.metadata),
        );
        const undeclared: LinkageTerms = { ...terms };
        delete undeclared.payload;
        const verdict = acceptorVerdict(columns, terms, editorState);
        expect(
          acceptorLaunchBlockedReason(verdict, editorState, terms),
          `${shape} / ${marks}`,
        ).toBe(acceptorLaunchBlockedReason(verdict, editorState, undeclared));
      }
  });
});

describe("the acceptor's shared-value limit and last-name rule", () => {
  const columns = ["first_name", "last_name", "email"];
  const emailTerms: LinkageTerms = {
    ...nameTerms,
    linkageFields: [
      ...nameTerms.linkageFields,
      { name: "email", type: "email_address" },
    ],
    linkageKeys: [
      ...nameTerms.linkageKeys,
      { name: "mail", elements: [{ field: "email" }] },
    ],
  };
  const settingsOf = (
    standardization: Standardization,
    output: string,
  ): CleaningSettings => {
    const transformation = standardization.find((t) => t.output === output);
    if (transformation === undefined) throw new Error(`no ${output} cleaning`);
    return cleaningSettingsOf(transformation);
  };

  test("the tab starts from the default cleaning's settings", () => {
    const { standardization } = editorFor(columns, emailTerms).editorState;
    expect(settingsOf(standardization, "firstName")).toEqual({
      nullIfLastName: { values: ["JOHN", "JANE"], lastNames: ["DOE"] },
    });
    expect(settingsOf(standardization, "lastName")).toEqual({});
    expect(settingsOf(standardization, "email")).toEqual({
      maxPeoplePerValue: 5,
    });
  });

  test("an edit states the field's settings whole and reaches the launch", () => {
    const edited: CleaningSettings = {
      maxPeoplePerValue: 2,
      nullIfLastName: { values: ["MARY"], lastNames: ["ROE"] },
    };
    const { editorState } = editorFor(columns, emailTerms, {
      settingsOverrides: new Map([
        ["firstName", edited],
        ["email", {}],
      ]),
    });
    const launched = acceptorLaunchPayload(editorState).edits.standardization;
    expect(settingsOf(launched, "firstName")).toEqual(edited);
    expect(settingsOf(launched, "email")).toEqual({});
    expect(
      launched.find((t) => t.output === "email")?.steps?.length,
    ).toBeGreaterThan(0);
  });

  test("the settings stay when the field reads another column", () => {
    const twoNames = ["first_name", "nickname", "last_name"];
    const seed = acceptorInitialColumnsState(twoNames);
    const { editorState } = editorFor(twoNames, nameTerms, {
      metadata: setColumnTypeForMatching(
        seed.metadata,
        "nickname",
        "first_name",
      ),
      inputOverrides: new Map([["firstName", "nickname"]]),
      settingsOverrides: new Map([["firstName", { maxPeoplePerValue: 4 }]]),
    });
    const firstName = editorState.standardization.find(
      (t) => t.output === "firstName",
    );
    expect(firstName?.input).toBe("nickname");
    expect(settingsOf(editorState.standardization, "firstName")).toEqual({
      maxPeoplePerValue: 4,
    });
  });

  test("a limit the configuration schema refuses blocks the start, naming its card", () => {
    const withLimit = (maxPeoplePerValue: number) => {
      const { editorState } = editorFor(columns, emailTerms, {
        settingsOverrides: new Map([["email", { maxPeoplePerValue }]]),
      });
      return acceptorLaunchBlockedReason(
        acceptorVerdict(columns, emailTerms, editorState),
        editorState,
        emailTerms,
      );
    };
    expect(withLimit(0)).toBe(
      "Fix or clear the highlighted limit on people sharing one value in " +
        "the Email address cleaning above before you can start.",
    );
    expect(withLimit(2.5)).toBe(withLimit(0));
    expect(withLimit(1)).toBeUndefined();
  });

  test("a limit on a cleaning whose output names no linkage field reads as a field", () => {
    const { editorState } = editorFor(columns, emailTerms, {
      settingsOverrides: new Map([["email", { maxPeoplePerValue: 0 }]]),
    });
    const strayOutput = {
      ...editorState,
      standardization: editorState.standardization.map((transformation) =>
        transformation.output === "email"
          ? { ...transformation, output: "noSuchField" }
          : transformation,
      ),
    };
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, emailTerms, strayOutput),
        strayOutput,
        emailTerms,
      ),
    ).toBe(
      "Fix or clear the highlighted limit on people sharing one value in " +
        "a field's cleaning above before you can start.",
    );
  });
});

describe("acceptor launch payload", () => {
  test("has the same metadata and standardization the verdict consumed", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const payload = acceptorLaunchPayload(editorState);
    // The gate and the run cannot disagree: identical object references.
    expect(payload.edits.metadata).toBe(editorState.metadata);
    expect(payload.edits.standardization).toBe(editorState.standardization);
  });
});

describe("acceptor cleaning attention", () => {
  const satisfiable = editorFor(["first_name", "last_name"], nameTerms);

  test("no reason to review -> no attention, an em-dash rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      new Map(),
      0,
      false,
    );
    expect(attention.needsAttention).toBe(false);
    expect(attention.railValue).toBeUndefined();
  });

  test("a silent-empty field raises attention with the failing-field count", () => {
    const transformation = satisfiable.editorState.standardization[0];
    const output = transformation.output;
    const collapsed: FieldValueCoverage = {
      output,
      input: transformation.input,
      total: 10,
      produced: 0,
      rate: 0,
      unavailable: false,
    };
    const rates = new Map<string, FieldValueCoverage>([[output, collapsed]]);
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      rates,
      0,
      false,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(1);
    expect(attention.railValue).toBe("1 field failing");
  });

  test("a dead key alone raises attention without a failing-field count", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      new Map(),
      1,
      false,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBe("1 key to review");
  });

  test("an unavailable coverage sweep raises attention with a distinct rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      null,
      0,
      true,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBe("Coverage unavailable");
  });

  test("a dead key outranks an unavailable sweep in the rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      null,
      1,
      true,
    );
    expect(attention.railValue).toBe("1 key to review");
  });
});

describe("acceptor columns editor state: input-override layer", () => {
  // A single firstName field with two candidate columns of that same type, so the
  // default binding (the FIRST column of the type -- resolveFieldColumns) and an
  // explicit input override (the SECOND column) are observably different. Only
  // given_name starts role: linkage; nickname is remapped to it in the tests below
  // via setColumnTypeForMatching, exactly as the columns-step quick-fix mapper does.
  const oneFieldTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "County Health Department",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "firstName", type: "first_name" }],
    linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
  };
  const columns = ["given_name", "nickname"];

  test("a live input override rebinds the field to the target column", () => {
    const seed = acceptorInitialColumnsState(columns);
    const bothLinkage = setColumnTypeForMatching(
      setColumnTypeForMatching(seed.metadata, "given_name", "first_name"),
      "nickname",
      "first_name",
    );
    const withoutOverride = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
    });
    // With no override, the default binding is the first role: linkage column of
    // the type.
    expect(withoutOverride.editorState.standardization[0].input).toBe(
      "given_name",
    );

    const withOverride = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
    });
    expect(withOverride.editorState.standardization[0].input).toBe("nickname");
  });

  test("a stale input override (target no longer role: linkage of that type) is dropped", () => {
    const seed = acceptorInitialColumnsState(columns);
    // Only given_name is role: linkage; nickname is left at its inferred role
    // (payload, an unrecognized header), so an override pointing at it is stale.
    const onlyGivenNameLinkage = setColumnTypeForMatching(
      seed.metadata,
      "given_name",
      "first_name",
    );
    const { editorState } = editorFor(columns, oneFieldTerms, {
      metadata: onlyGivenNameLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
    });
    // The stale override is dropped; the derived default (given_name) returns
    // rather than binding a column the core would refuse.
    expect(editorState.standardization[0].input).toBe("given_name");
  });

  test("layering order: an input rebind stales a step override authored against the old input", () => {
    const seed = acceptorInitialColumnsState(columns);
    const bothLinkage = setColumnTypeForMatching(
      setColumnTypeForMatching(seed.metadata, "given_name", "first_name"),
      "nickname",
      "first_name",
    );
    // Author a step override against the ORIGINAL input (given_name).
    const stepOverrides = new Map([
      [
        "firstName",
        { input: "given_name", steps: [{ function: "to_upper_case" }] },
      ],
    ]);
    const beforeRebind = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      stepOverrides,
    });
    // The step override applies while the field is still bound to given_name.
    expect(beforeRebind.editorState.standardization[0].input).toBe(
      "given_name",
    );
    expect(beforeRebind.editorState.standardization[0].steps).toEqual([
      { function: "to_upper_case" },
    ]);

    // Now rebind the input to nickname AND keep the same (now-stale) step
    // override. applyInputOverrides runs before applyStepOverrides, so the step
    // override's `input: "given_name"` no longer matches the rebound
    // transformation's input and is dropped, rather than silently cleaning the
    // new column with steps authored for the old one.
    const afterRebind = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
      stepOverrides,
    });
    expect(afterRebind.editorState.standardization[0].input).toBe("nickname");
    expect(afterRebind.editorState.standardization[0].steps).not.toEqual([
      { function: "to_upper_case" },
    ]);
  });
});
