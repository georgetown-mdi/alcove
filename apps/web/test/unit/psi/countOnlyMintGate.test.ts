import { describe, expect, test } from "vitest";

import {
  FAN_OUT_FUNCTION_NAMES,
  OperatorConfigError,
  assertFanOutImplemented,
} from "@alcove/core";

import { buildAdvancedTerms } from "@psi/authoring/advancedInviteTerms";
import { seedAdvancedInvite } from "@psi/authoring/advancedInviteDraft";
import { setColumnDisclosure } from "@psi/metadataEditing";
import { validateAdvancedInvite } from "@psi/authoring/advancedInviteValidation";

import type { LinkageKey, LinkageStrategy } from "@alcove/core";
import type { AdvancedInviteDraft } from "@psi/authoring/advancedInviteTypes";

// The count-only shape gate at the web AUTHORING boundary. Each of its rules
// is reached through `buildAdvancedTerms`; the rules themselves read the
// algorithm and the document.
// The accept and import gates are the same rules at the other two boundaries, in
// countOnlyAcceptGates.test.ts.

const LINKAGE_COLUMNS = ["ssn", "first_name", "last_name", "dob"];
const NOW = new Date("2026-01-01T00:00:00Z");

/** Whether a seeded key declares a candidate set: a swap, a fuzzy
 * comparison, or a step that splits a value. */
function declaresCandidateSet(key: LinkageKey): boolean {
  return (
    key.swap !== undefined ||
    key.elements.some(
      (element) =>
        element.generateFuzzyComparisons !== undefined ||
        (element.transform ?? []).some((step) =>
          FAN_OUT_FUNCTION_NAMES.includes(step.function),
        ),
    )
  );
}

/** A count-only draft in the shape the specification admits: the seeded
 * draft narrowed to its first linkage key, which declares no candidate set. */
function countOnlyDraft(columns: Array<string> = LINKAGE_COLUMNS) {
  const { draft, seed } = seedAdvancedInvite("Org", columns);
  return {
    seed,
    draft: {
      ...draft,
      algorithm: "psi-c" as const,
      keys: draft.keys.map((entry, index) => ({
        ...entry,
        enabled: index === 0,
      })),
    },
  };
}

describe("the count-only shape gate at the Generate boundary", () => {
  test("the draft's psi-c really does reach the built terms", () => {
    // Without this the cases below could pass on a `psi` document, which every rule
    // leaves alone -- they would gate nothing and still be green.
    const { draft } = countOnlyDraft();
    expect(buildAdvancedTerms(draft).algorithm).toBe("psi-c");
  });

  test("a count-only draft in the specified shape can still be generated", () => {
    const { draft, seed } = countOnlyDraft();
    const result = validateAdvancedInvite(draft, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
  });

  test("a count-only draft with every key that declares no candidate set, under single-pass, can be generated", () => {
    const { draft, seed } = countOnlyDraft();
    const everyKey: AdvancedInviteDraft = {
      ...draft,
      linkageStrategy: "single-pass",
      keys: draft.keys.map((entry) => ({
        ...entry,
        enabled: !declaresCandidateSet(entry.key),
      })),
    };
    const result = validateAdvancedInvite(everyKey, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.terms?.linkageKeys.length).toBeGreaterThan(1);
    expect(result.terms?.linkageStrategy).toBe("single-pass");
  });

  test("the seeded count-only draft with every key on is refused for its candidate sets alone", () => {
    const { draft, seed } = countOnlyDraft();
    const result = validateAdvancedInvite(
      {
        ...draft,
        keys: draft.keys.map((entry) => ({ ...entry, enabled: true })),
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(Object.keys(result.errors)).toEqual(["keys"]);
    expect(result.errors.keys).toMatch(/matches one value per record/);
  });

  test.each([
    {
      rule: "duplicate matches",
      edit: (draft: AdvancedInviteDraft): AdvancedInviteDraft => ({
        ...draft,
        deduplicate: true,
      }),
      field: "keys" as const,
      expected: /several of your records cannot match one partner record/,
    },
  ])(
    "blocks Generate on a count-only draft declaring $rule",
    ({ edit, field, expected }) => {
      const { draft, seed } = countOnlyDraft();
      const result = validateAdvancedInvite(edit(draft), seed, NOW);
      expect(result.canGenerate).toBe(false);
      expect(result.terms).toBeUndefined();
      // The rule broken and what to change, not the generic schema-failure message
      // the issue path would otherwise map this control to.
      expect(result.errors[field]).toMatch(expected);
    },
  );

  test("blocks Generate on a count-only draft whose columns are marked to send", () => {
    // The rule this editor's own metadata holds: a marked column authors a
    // payload send AND is what the run would transmit, and a count-only exchange
    // has room for neither. The payload control names the marks, since clearing
    // them is what the operator does about it.
    const { draft, seed } = countOnlyDraft([...LINKAGE_COLUMNS, "notes"]);
    const sending = {
      ...draft,
      metadata: setColumnDisclosure(draft.metadata, "notes", "payload")
        .metadata,
    };
    const result = validateAdvancedInvite(sending, seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.payload).toMatch(/sends no data columns/);
    expect(result.errors.payload).toMatch(/so they are not sent/);
  });

  test("under psi the identical draft generates, so every refusal above was the count-only rules'", () => {
    // Every rule above is the count-only algorithm's: under psi the same draft
    // keeps its deduplicating term and its marked column, and generates.
    // Nothing here was a rule the identifier-revealing algorithm holds too.
    const { draft, seed } = countOnlyDraft([...LINKAGE_COLUMNS, "notes"]);
    const asPsi: AdvancedInviteDraft = {
      ...draft,
      algorithm: "psi",
      deduplicate: true,
      linkageStrategy: "single-pass",
      keys: draft.keys.map((entry) => ({ ...entry, enabled: true })),
      metadata: setColumnDisclosure(draft.metadata, "notes", "payload")
        .metadata,
    };
    const result = validateAdvancedInvite(asPsi, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
    expect(result.terms?.deduplicate).toBe(true);
  });
});

describe("the count-only candidate-set gate at the Generate boundary", () => {
  // The rule the shape rules above do not hold: a count-only round counts
  // matched values where the matching pairs each record at most once, so a key
  // expanding a record into several candidates is refused at prepare and again
  // at the agreed-terms run boundary.

  /** The seeded count-only draft narrowed to the one built-in key declaring a
   * swap -- an expansion, and the reason the gate is reachable through the keys
   * the editor seeds rather than an authored one. It satisfies every count-only
   * shape rule: one key, cascade, no deduplication, no payload. */
  function swappedKeyDraft() {
    const { draft, seed } = countOnlyDraft();
    const swapIndex = draft.keys.findIndex(
      (entry) => entry.key.swap !== undefined,
    );
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    return {
      seed,
      draft: {
        ...draft,
        keys: draft.keys.map((entry, index) => ({
          ...entry,
          enabled: index === swapIndex,
        })),
      },
    };
  }

  test("the swap really does reach the built terms", () => {
    // Without this the case below could pass on a draft whose enabled key
    // declares no swap, gating nothing and still being green.
    const { draft } = swappedKeyDraft();
    const terms = buildAdvancedTerms(draft);
    expect(terms.algorithm).toBe("psi-c");
    expect(terms.linkageKeys.every((key) => key.swap !== undefined)).toBe(true);
  });

  test("blocks Generate on a count-only draft whose key declares a swap", () => {
    const { draft, seed } = swappedKeyDraft();
    const result = validateAdvancedInvite(draft, seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    // What is wrong and what to change, against the key list that holds both
    // remedies -- not the generic schema-failure message, and not the alert the
    // mint would otherwise raise after the operator pressed Generate.
    expect(result.errors.keys).toMatch(/matches one value per record/);
    expect(result.errors.keys).toMatch(/either-order swap/);
    expect(result.errors.keys).toMatch(/Reveal the matched identifiers/);
  });

  test("under psi the identical draft generates, so the refusal was the count-only algorithm's", () => {
    // The identifier-revealing algorithm resolves a candidate set under both
    // linkage strategies, so the same swapped key generates there.
    const { draft, seed } = swappedKeyDraft();
    const asPsi: AdvancedInviteDraft = { ...draft, algorithm: "psi" };
    const result = validateAdvancedInvite(asPsi, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
  });
});

describe("the count-only fan-out gate at the Generate boundary", () => {
  // Core refuses a count-only exchange that splits a value, in its own cleaning
  // as well as in a linkage key, so both stay refused at Generate.
  const [fanOutFunction] = FAN_OUT_FUNCTION_NAMES;
  const fanOutStep = { function: fanOutFunction, params: { delimiter: "-" } };
  // Keyed by the strategy union, so a strategy added to core fails to compile
  // here until it is listed.
  const EVERY_STRATEGY = Object.keys({
    cascade: true,
    "single-pass": true,
  } satisfies Record<LinkageStrategy, true>) as Array<LinkageStrategy>;

  function withCleaningFanOut(draft: AdvancedInviteDraft): AdvancedInviteDraft {
    return {
      ...draft,
      standardization: draft.standardization.map((transformation) => ({
        ...transformation,
        steps: [...(transformation.steps ?? []), fanOutStep],
      })),
    };
  }

  function withKeyFanOut(draft: AdvancedInviteDraft): AdvancedInviteDraft {
    return {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        key: {
          ...entry.key,
          elements: entry.key.elements.map((element, position) =>
            position === 0 ? { ...element, transform: [fanOutStep] } : element,
          ),
        },
      })),
    };
  }

  test("blocks Generate on a count-only draft whose cleaning splits a value", () => {
    const { draft, seed } = countOnlyDraft();
    const result = validateAdvancedInvite(withCleaningFanOut(draft), seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.standardization).toMatch(
      /count-only exchange matches one value per record/,
    );
    expect(result.errors.standardization).toMatch(
      /Reveal the matched identifiers/,
    );
  });

  test("names the step, the card it sits on, and where the method is set", () => {
    const { draft, seed } = countOnlyDraft();
    const split: AdvancedInviteDraft = {
      ...draft,
      standardization: draft.standardization.map((transformation) =>
        transformation.output === "last_name"
          ? { ...transformation, steps: [fanOutStep] }
          : transformation,
      ),
    };
    expect(
      validateAdvancedInvite(split, seed, NOW).errors.standardization,
    ).toBe(
      "A count-only exchange matches one value per record, but the Split on " +
        "step in the Last name cleaning from the last_name column splits a " +
        "value into parts. Remove " +
        'that step, or set Matching method to "Reveal the matched ' +
        'identifiers (standard)" on Matching & sharing.',
    );
  });

  test("refuses a cleaning split exactly where core's mint assert does", () => {
    const { draft, seed } = countOnlyDraft();
    for (const algorithm of ["psi", "psi-c"] as const)
      for (const linkageStrategy of EVERY_STRATEGY) {
        const edited: AdvancedInviteDraft = {
          ...withCleaningFanOut(draft),
          algorithm,
          linkageStrategy,
        };
        let coreRefuses = false;
        try {
          assertFanOutImplemented(
            buildAdvancedTerms(edited),
            edited.standardization,
          );
        } catch (error) {
          if (!(error instanceof OperatorConfigError)) throw error;
          coreRefuses = true;
        }
        expect(
          validateAdvancedInvite(edited, seed, NOW).errors.standardization !==
            undefined,
          `${algorithm} under ${linkageStrategy}`,
        ).toBe(coreRefuses);
      }
  });

  test("blocks Generate on a count-only draft whose key splits a value", () => {
    const { draft, seed } = countOnlyDraft();
    const result = validateAdvancedInvite(withKeyFanOut(draft), seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toMatch(/splits a value into parts/);
  });

  test("under psi both drafts generate", () => {
    const { draft, seed } = countOnlyDraft();
    for (const edit of [withCleaningFanOut, withKeyFanOut]) {
      const asPsi: AdvancedInviteDraft = { ...edit(draft), algorithm: "psi" };
      const result = validateAdvancedInvite(asPsi, seed, NOW);
      expect(result.errors).toEqual({});
      expect(result.canGenerate).toBe(true);
    }
  });
});
