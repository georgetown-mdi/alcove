import { describe, expect, test } from "vitest";

import {
  FAN_OUT_FUNCTION_NAMES,
  MAX_TRANSFORM_PATTERN_LENGTH,
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  getDefaultStandardization,
  lastNameColumn,
  prepareForExchange,
  runPipeline,
  safeParseStandardization,
  stepCanEmptyRealizedValue,
} from "@alcove/core";
import { UnknownStandardizationFunctionError } from "@alcove/core/testing";

import {
  EXPERT_FUNCTION_GROUPS_FAN_OUT_ONLY,
  INERT_COALESCE_ADVICE,
  NULL_IF_BOTH_VALUES_REFUSAL,
  STANDARDIZATION_EXPERT_FUNCTION_GROUPS,
  STANDARDIZATION_FUNCTION_GROUPS,
  applyCleaningSettingsOverrides,
  applyInputOverrides,
  applyStepOverrides,
  authorableFunctionNames,
  cleaningSettingsOf,
  declaresBothNullIfValues,
  describeParamFields,
  descriptorFor,
  expertFunctionNames,
  functionDisplay,
  halfFilledLastNameRuleNotice,
  inertCoalesceCause,
  isMaxPeoplePerValueValid,
  isStepValid,
  lastNameCleaningSteps,
  lastNameRuleEntryCleaned,
  lastNameRuleEntryNotice,
  lastNameRuleLastNameNotice,
  nullIfLastNameFromLists,
  pipelineHasInertCoalesce,
  stepLabel,
  transformationWithCleaningSettings,
  validateParamValue,
} from "../../../src/psi/standardizationAuthoring.js";

import type {
  ColumnMetadata,
  LinkageField,
  LinkageTerms,
  Standardization,
} from "@alcove/core";

import type { FieldStepOverride } from "../../../src/psi/standardizationAuthoring.js";

describe("function grouping parity with the descriptor table", () => {
  // The grouping is the add menu's source of truth; pin it to core's descriptor
  // table in both directions so a standard-tier function added to core cannot ship
  // without a group, and a regex-tier (deferred expert tier) function cannot leak
  // into the menu.
  const standardTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "standard")
    .map((d) => d.name);

  test("offers exactly the standard-tier functions", () => {
    expect([...authorableFunctionNames].sort()).toEqual(
      [...standardTierNames].sort(),
    );
  });

  test("the standard menu excludes every regex-tier function (those are gated to the expert menu)", () => {
    const regexTier = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
      .filter((d) => d.tier === "regex")
      .map((d) => d.name);
    expect(regexTier.length).toBeGreaterThan(0);
    for (const name of regexTier)
      expect(authorableFunctionNames.has(name)).toBe(false);
  });

  test("lists each function in exactly one group", () => {
    const flat = STANDARDIZATION_FUNCTION_GROUPS.flatMap(
      (g) => g.functionNames,
    );
    expect(flat.length).toBe(new Set(flat).size);
  });

  test("coalesce's editor copy states core's condition, in plain language", () => {
    const display = functionDisplay("coalesce");
    const descriptor = STANDARDIZATION_FUNCTION_DESCRIPTORS["coalesce"];
    // The description IS core's, not a paraphrase of it, so a later correction
    // there cannot leave this surface asserting a behavior coalesce does not have.
    expect(display.blurb).toBe(descriptor.blurb);
    // The label stays plain language rather than the SQL term the descriptor
    // has, and states the condition core's does: a value an earlier rule of
    // the same pipeline emptied -- not an absent or empty input, which never
    // reaches the step.
    expect(display.label).not.toBe(descriptor.label);
    expect(display.label.toLowerCase()).toContain("rule emptied the value");
  });

  test("every other function's label and blurb are the descriptor's own", () => {
    // coalesce is the single label override; nothing else restates core's copy,
    // so a correction in the descriptor table reaches the menu unaided.
    for (const name of authorableFunctionNames) {
      if (name === "coalesce") continue;
      const descriptor = STANDARDIZATION_FUNCTION_DESCRIPTORS[name];
      expect(functionDisplay(name)).toEqual({
        label: descriptor.label,
        blurb: descriptor.blurb,
      });
    }
  });

  test("a step's label states the built-in two-character filter in plain words, and any other step as its function", () => {
    expect(
      stepLabel({ function: "filter_regex", params: { pattern: "^.{2,}$" } }),
    ).toBe("Keep values of at least two characters");
    for (const step of [
      { function: "filter_regex", params: { pattern: "^.{3,}$" } },
      { function: "filter_regex", params: { pattern: "^.{2,}$", extra: "" } },
      { function: "filter_regex" },
      { function: "to_upper_case" },
    ])
      expect(stepLabel(step)).toBe(functionDisplay(step.function).label);
  });

  test("an unrecognized (imported) function name is sanitized for display", () => {
    // The add-step menu only offers descriptor-backed functions, but an imported
    // linkage-terms document has a free-text transform `function`. An
    // unrecognized name falls back to the raw name as its label -- which the editor
    // renders as text and into aria-labels -- so it must be sanitized: a bidi /
    // control / homoglyph payload must not survive into the DOM to spoof a benign
    // function name.
    // Construct the payload from code points so the test source stays ASCII.
    const rlo = String.fromCharCode(0x202e); // right-to-left override (bidi)
    const bel = String.fromCharCode(0x07); // a C0 control char
    const hostile = `to_upper_case${rlo}evomer${bel}`;
    const display = functionDisplay(hostile);
    // The raw bidi-override and control code points must not survive the render.
    expect(display.label).not.toContain(rlo);
    expect(display.label).not.toContain(bel);
    // The printable ASCII prefix is preserved; the dangerous bytes are escaped.
    expect(display.label).toContain("to_upper_case");
  });
});

describe("expert (regex-tier) function grouping parity with the descriptor table", () => {
  // The gated expert menu is the raw-pattern add-step source of truth; pin it to
  // core's regex tier in both directions so a regex-tier function added to core
  // cannot ship without an expert group, and a standard-tier function cannot leak
  // into the expert menu.
  const regexTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "regex")
    .map((d) => d.name);

  test("offers exactly the regex-tier functions", () => {
    expect([...expertFunctionNames].sort()).toEqual([...regexTierNames].sort());
  });

  test("is disjoint from the standard menu", () => {
    for (const name of expertFunctionNames)
      expect(authorableFunctionNames.has(name)).toBe(false);
  });

  test("lists each expert function in exactly one group", () => {
    const flat = STANDARDIZATION_EXPERT_FUNCTION_GROUPS.flatMap(
      (g) => g.functionNames,
    );
    expect(flat.length).toBe(new Set(flat).size);
  });
});

describe("the add menu offers the fan-out family", () => {
  test("offers every function core classes as fan-out", () => {
    // Read from core's own list, so a producer added there must reach the menu.
    expect(FAN_OUT_FUNCTION_NAMES.length).toBeGreaterThan(0);
    for (const name of FAN_OUT_FUNCTION_NAMES)
      expect(
        authorableFunctionNames.has(name) || expertFunctionNames.has(name),
      ).toBe(true);
  });

  test("labels each fan-out function from its descriptor", () => {
    for (const name of FAN_OUT_FUNCTION_NAMES) {
      expect(descriptorFor(name)).toBeDefined();
      expect(functionDisplay(name).label).not.toBe(name);
    }
  });

  test("the key-element menu offers the fan-out functions and no other raw pattern", () => {
    expect(
      EXPERT_FUNCTION_GROUPS_FAN_OUT_ONLY.flatMap(
        (group) => group.functionNames,
      ).sort(),
    ).toEqual([...FAN_OUT_FUNCTION_NAMES].sort());
  });
});

describe("descriptor-driven typed param fields", () => {
  test("classifies each param into its widget kind from the Zod type", () => {
    const fields = (name: string) =>
      describeParamFields(STANDARDIZATION_FUNCTION_DESCRIPTORS[name]);

    // substring: two numeric inputs.
    const substring = fields("substring");
    expect(substring.map((f) => [f.key, f.kind])).toEqual([
      ["start", "number"],
      ["length", "number"],
    ]);

    // phonetic: a single enum, defaulted to soundex.
    const [algorithm] = fields("phonetic");
    expect(algorithm.kind).toBe("enum");
    expect(algorithm.enumOptions).toEqual(["soundex"]);
    expect(algorithm.defaultValue).toBe("soundex");

    // parse_date: two strings, each holding its declared default.
    const parseDate = fields("parse_date");
    expect(parseDate.map((f) => f.kind)).toEqual(["string", "string"]);
    expect(parseDate.find((f) => f.key === "inputFormat")?.defaultValue).toBe(
      "MM/DD/YYYY",
    );

    // null_if: an optional string and an optional string-array.
    const nullIf = fields("null_if");
    expect(nullIf.find((f) => f.key === "value")).toMatchObject({
      kind: "string",
      optional: true,
    });
    expect(nullIf.find((f) => f.key === "values")).toMatchObject({
      kind: "stringArray",
      optional: true,
    });
  });

  test("a no-param function yields no fields", () => {
    expect(
      describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS["squash_spaces"],
      ),
    ).toEqual([]);
  });

  test("every param field has a non-empty plain-language label (standard and expert tiers)", () => {
    for (const name of [...authorableFunctionNames, ...expertFunctionNames])
      for (const field of describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS[name],
      )) {
        expect(field.label.length).toBeGreaterThan(0);
        // A camelCase key (the raw snake-free runtime key) must be relabeled, not
        // shown verbatim -- e.g. split_on's includeOriginal.
        if (/[A-Z]/.test(field.key)) expect(field.label).not.toBe(field.key);
      }
  });

  test("classifies every authorable descriptor's params into a known widget kind, resolving the deepest wrapper chains", () => {
    // The earlier test samples four descriptors; this proves the Zod unwrapping
    // holds for ALL standard-tier descriptors, so a Zod-internals change cannot
    // silently mis-render a descriptor the sample misses.
    for (const name of authorableFunctionNames)
      for (const field of describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS[name],
      )) {
        expect(["number", "string", "enum", "stringArray"]).toContain(
          field.kind,
        );
        if (field.kind === "enum")
          expect((field.enumOptions ?? []).length).toBeGreaterThan(0);
      }
    // The two deepest wrapper chains: `pad_left.char` is a refine folded under a
    // default (must show the "0" default as a string), and `coalesce.default` is
    // an optional string (must show as optional, not required).
    const padChar = describeParamFields(
      STANDARDIZATION_FUNCTION_DESCRIPTORS["pad_left"],
    ).find((f) => f.key === "char");
    expect(padChar).toMatchObject({ kind: "string", defaultValue: "0" });
    const coalesceDefault = describeParamFields(
      STANDARDIZATION_FUNCTION_DESCRIPTORS["coalesce"],
    ).find((f) => f.key === "default");
    expect(coalesceDefault).toMatchObject({ kind: "string", optional: true });
  });

  test("classifies the regex-tier params: a pattern as a string, includeOriginal as a boolean switch", () => {
    const splitOn = describeParamFields(
      STANDARDIZATION_FUNCTION_DESCRIPTORS["split_on"],
    );
    // The pattern/delimiter render as a text input (validated against the dialect
    // schema); the new boolean kind drives includeOriginal's switch.
    expect(splitOn.find((f) => f.key === "delimiter")?.kind).toBe("string");
    expect(splitOn.find((f) => f.key === "includeOriginal")).toMatchObject({
      kind: "boolean",
      defaultValue: false,
    });
    // Every expert (regex-tier) descriptor's params resolve to a known widget kind,
    // including the boolean kind, so the editor renders a typed control for each
    // rather than a raw text box.
    for (const name of expertFunctionNames)
      for (const field of describeParamFields(
        STANDARDIZATION_FUNCTION_DESCRIPTORS[name],
      ))
        expect([
          "number",
          "string",
          "enum",
          "stringArray",
          "boolean",
        ]).toContain(field.kind);
  });
});

describe("every reachable pipeline function is descriptor-backed", () => {
  // `isStepValid` refuses a step whose function has no descriptor, so a default
  // pipeline that named an uncatalogued function would block its own launch. The
  // add menu offers only standard-tier descriptors (parity-tested above); pin the
  // other source of steps, the recommended defaults, so such a function is caught
  // here rather than at the gate an operator meets.
  test("every function a default standardization emits has a descriptor", () => {
    const fieldTypes = [
      "first_name",
      "last_name",
      "date_of_birth",
      "ssn",
      "ssn4",
      "phone_number",
      "email_address",
    ] as const;
    const metadata: Array<ColumnMetadata> = fieldTypes.map((type, i) => ({
      name: `c${i}`,
      type,
      role: "linkage",
      isPayload: false,
    }));
    const terms: LinkageTerms = {
      version: "1.0.0",
      identity: "x",
      date: "2026-01-01",
      algorithm: "psi",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields: fieldTypes.map((type, i) => ({ name: `f${i}`, type })),
      linkageKeys: fieldTypes.map((_, i) => ({
        name: `k${i}`,
        elements: [{ field: `f${i}` }],
      })),
    };
    const functions = new Set(
      getDefaultStandardization(metadata, terms).flatMap((t) =>
        (t.steps ?? []).map((s) => s.function),
      ),
    );
    expect(functions.size).toBeGreaterThan(0);
    for (const name of functions) expect(descriptorFor(name)).toBeDefined();
  });
});

describe("param value validation per the descriptor's declared type", () => {
  const substring = STANDARDIZATION_FUNCTION_DESCRIPTORS["substring"];
  const padLeft = STANDARDIZATION_FUNCTION_DESCRIPTORS["pad_left"];

  test("accepts a value matching the param type", () => {
    expect(validateParamValue(substring, "start", 3).ok).toBe(true);
    expect(validateParamValue(substring, "length", 4).ok).toBe(true);
    expect(validateParamValue(padLeft, "char", "0").ok).toBe(true);
  });

  test("rejects a value the descriptor's type forbids", () => {
    // A fractional start, a zero start (positions are 1-indexed), a non-positive
    // length, and a multi-character fill all fail -- exactly as core's factory would.
    expect(validateParamValue(substring, "start", 2.5).ok).toBe(false);
    expect(validateParamValue(substring, "start", 0).ok).toBe(false);
    expect(validateParamValue(substring, "length", 0).ok).toBe(false);
    expect(validateParamValue(padLeft, "char", "ab").ok).toBe(false);
  });

  test("rejects an unknown parameter key", () => {
    expect(validateParamValue(substring, "nope", 1).ok).toBe(false);
  });

  test("rejects an integer beyond the safe range (canonical-encoding hazard)", () => {
    // A transform param is embedded in the cross-party token and canonically
    // encoded; an integer at or beyond 2^53 cannot round-trip reproducibly
    // (canonicalString throws on a non-safe integer), so the descriptor's
    // z.number().int() must reject it before it can be authored. This pins the
    // boundary against a future zod change that could regress it.
    expect(validateParamValue(substring, "start", 2 ** 53).ok).toBe(false);
    expect(validateParamValue(substring, "length", 2 ** 53).ok).toBe(false);
    expect(validateParamValue(padLeft, "length", 2 ** 53).ok).toBe(false);
    // The largest safe integer is still within range, so the bound sits exactly
    // at the safe-integer edge, not below any legitimate value.
    expect(
      validateParamValue(substring, "start", Number.MAX_SAFE_INTEGER).ok,
    ).toBe(true);
  });
});

describe("raw-pattern (regex-tier) param validation through the editor's path", () => {
  const filterRegex = STANDARDIZATION_FUNCTION_DESCRIPTORS["filter_regex"];
  const splitOn = STANDARDIZATION_FUNCTION_DESCRIPTORS["split_on"];

  test("accepts an in-dialect pattern", () => {
    expect(validateParamValue(filterRegex, "pattern", "^\\d{9}$").ok).toBe(
      true,
    );
    expect(validateParamValue(splitOn, "delimiter", "[ ,]").ok).toBe(true);
  });

  test("rejects an out-of-dialect pattern (lookaround / backreference)", () => {
    // Exactly what the linear-time engine cannot compile and the runtime gate
    // rejects -- so the editor refuses a pattern an exchange would refuse.
    expect(validateParamValue(filterRegex, "pattern", "a(?=b)").ok).toBe(false);
  });

  test("rejects an over-length pattern (the editor compile-cost guard)", () => {
    const overLimit = "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1);
    expect(validateParamValue(filterRegex, "pattern", overLimit).ok).toBe(
      false,
    );
  });
});

describe("raw-pattern authoring is bounded by the linear-time engine", () => {
  test("a pathological RE2-conformant pattern terminates rather than hanging the preview", () => {
    const pattern = "(a+)+$";
    // (a+)+$ is the classic catastrophic-backtracking pattern: on a backtracking
    // engine it hangs on a long non-matching input, freezing the tab the live
    // preview runs on. It is in-dialect (no backreference/lookaround), so the editor
    // accepts it...
    expect(
      validateParamValue(
        STANDARDIZATION_FUNCTION_DESCRIPTORS["filter_regex"],
        "pattern",
        pattern,
      ).ok,
    ).toBe(true);
    // ...and core compiles it under the linear-time engine, so runPipeline -- the
    // exact function StandardizationPreview runs over the operator's sample --
    // returns in linear time. The test completing well under the default timeout IS
    // the bound; a backtracking engine would not return here.
    const hostile = "a".repeat(50000) + "!";
    expect(
      runPipeline(hostile, [{ function: "filter_regex", params: { pattern } }]),
    ).toBeNull();
  });
});

describe("isStepValid (the launch gate's basis)", () => {
  test("a fully-specified or no-param step is valid", () => {
    expect(
      isStepValid({ function: "substring", params: { start: 1, length: 3 } }),
    ).toBe(true);
    expect(isStepValid({ function: "to_upper_case" })).toBe(true);
    // null_if's value/values are both optional, so an empty step is valid.
    expect(isStepValid({ function: "null_if" })).toBe(true);
  });

  test("a step missing or clearing a required param is invalid", () => {
    // start is required and absent.
    expect(isStepValid({ function: "substring", params: { length: 3 } })).toBe(
      false,
    );
    // start cleared in the NumberInput stores undefined; an empty string is also
    // rejected (defends the runtime even if a "" ever reaches here).
    expect(
      isStepValid({ function: "substring", params: { start: "", length: 3 } }),
    ).toBe(false);
    // pad_left needs a length; a fresh step (char defaulted, no length) is invalid.
    expect(isStepValid({ function: "pad_left", params: { char: "0" } })).toBe(
      false,
    );
  });

  test("a regex-tier step with valid params is valid (default pipelines and authored expert steps alike)", () => {
    expect(
      isStepValid({
        function: "replace_regex",
        params: { pattern: "[^0-9]", replacement: "" },
      }),
    ).toBe(true);
    expect(
      isStepValid({
        function: "filter_regex",
        params: { pattern: "^\\d{9}$" },
      }),
    ).toBe(true);
  });

  test("gates a regex step on its pattern: a missing pattern is invalid", () => {
    expect(
      isStepValid({ function: "filter_regex", params: { pattern: "^A" } }),
    ).toBe(true);
    expect(isStepValid({ function: "filter_regex" })).toBe(false);
  });

  test("a null_if declaring both value and values is invalid", () => {
    // Each param is well-formed on its own, so only the pair is wrong: core
    // refuses it where the document is decoded (the run applies the list and
    // ignores the single value), and an editor grading each param alone would
    // call the step valid and meet that refusal at launch.
    const bothDeclared = {
      function: "null_if",
      params: { value: "UNKNOWN", values: ["UNKNOWN", "N/A"] },
    };
    expect(declaresBothNullIfValues(bothDeclared)).toBe(true);
    expect(isStepValid(bothDeclared)).toBe(false);
    expect(
      safeParseStandardization([
        { output: "ssn", input: "SSN", steps: [bothDeclared] },
      ]).success,
    ).toBe(false);
  });

  test("the refusal names both halves of the pair and the remedy", () => {
    // The copy the step editor renders beside such a step: the remedy is
    // removal, because an emptied text box is `""` and an emptied tag list is
    // `[]`, each of which still declares the param.
    expect(NULL_IF_BOTH_VALUES_REFUSAL).toContain(
      "a single value and a list of values",
    );
    expect(NULL_IF_BOTH_VALUES_REFUSAL).toContain("Remove this step");
  });

  test.each([
    ["the single value", { value: "UNKNOWN" }],
    ["the list", { values: ["UNKNOWN", "N/A"] }],
  ])("a null_if declaring %s alone is valid", (_name, params) => {
    expect(declaresBothNullIfValues({ function: "null_if", params })).toBe(
      false,
    );
    expect(isStepValid({ function: "null_if", params })).toBe(true);
  });

  test("a function core does not recognize is invalid", () => {
    // The descriptor table is core's own registry, so a name absent from it is
    // one `compileSteps` throws on -- the whole pipeline, before the first row.
    // Refusing it here is what keeps such a step out of a launched exchange and
    // out of a minted invitation's cleaning.
    expect(isStepValid({ function: "totally_unknown" })).toBe(false);
    expect(descriptorFor("totally_unknown")).toBeUndefined();
    expect(() =>
      runPipeline("VALUE", [{ function: "totally_unknown" }]),
    ).toThrow(UnknownStandardizationFunctionError);
  });
});

describe("a coalesce that substitutes nothing where it sits", () => {
  const withDefault = { function: "coalesce", params: { default: "Z" } };

  test("a coalesce in first position substitutes nothing", () => {
    // A pipeline starts from a non-null string, so a coalesce reached with a
    // value still in hand returns it untouched; a record whose field is absent
    // never enters the pipeline at all. Nothing ahead of the step can have
    // emptied anything, so the fault is its position, not its default.
    expect(inertCoalesceCause(withDefault, [])).toBe("no-emptying-rule");
    expect(pipelineHasInertCoalesce([withDefault])).toBe(true);
  });

  test("a coalesce preceded only by value-preserving steps substitutes nothing", () => {
    // Every step ahead of it returns a value for every value it is handed, so
    // the substituting branch is never reached. Adding the default does not fix
    // it, which is why the position is the cause reported.
    const preceding = [
      { function: "trim_whitespace" },
      { function: "to_upper_case" },
      { function: "pad_left", params: { length: 9, char: "0" } },
    ];
    expect(inertCoalesceCause(withDefault, preceding)).toBe("no-emptying-rule");
    expect(pipelineHasInertCoalesce([...preceding, withDefault])).toBe(true);
  });

  test("a coalesce after a step that can empty a value substitutes, and raises nothing", () => {
    const preceding = [
      { function: "trim_whitespace" },
      { function: "null_if", params: { values: ["X"] } },
    ];
    expect(inertCoalesceCause(withDefault, preceding)).toBeUndefined();
    expect(pipelineHasInertCoalesce([...preceding, withDefault])).toBe(false);
  });

  test("moving an emptying step ahead of the coalesce clears the advisory", () => {
    // The editor re-derives the verdict per position on every render, so a
    // reorder is what clears it -- the same flip the runtime makes.
    const nullIf = { function: "null_if", params: { values: ["X"] } };
    expect(pipelineHasInertCoalesce([withDefault, nullIf])).toBe(true);
    expect(pipelineHasInertCoalesce([nullIf, withDefault])).toBe(false);
  });

  test("a coalesce declaring no default substitutes nothing either", () => {
    // The editor's own `default` control is a text input, so a coalesce with no
    // default arrives on an imported document; core runs it as a pass-through,
    // so the surface must not claim a substitution. Reported against the default
    // rather than the position, because an emptying rule already precedes it.
    const preceding = [{ function: "null_if", params: { values: ["X"] } }];
    expect(inertCoalesceCause({ function: "coalesce" }, preceding)).toBe(
      "no-text-default",
    );
  });

  test("the position half is core's own classification, not a second list here", () => {
    // Every function core classes as value-preserving leaves a coalesce after it
    // inert, and every other one rescues it. Driven over the whole descriptor
    // table so a function added to core is covered here with no edit -- the web
    // surface reads the verdict and restates no rule of its own.
    for (const name of Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS)) {
      const canEmpty = stepCanEmptyRealizedValue({ function: name });
      expect(
        pipelineHasInertCoalesce([{ function: name }, withDefault]),
        name,
      ).toBe(!canEmpty);
    }
  });

  test("no other function raises the advisory", () => {
    for (const name of Object.keys(STANDARDIZATION_FUNCTION_DESCRIPTORS)) {
      if (name === "coalesce") continue;
      expect(inertCoalesceCause({ function: name }, []), name).toBeUndefined();
    }
    expect(
      inertCoalesceCause({ function: "totally_unknown" }, []),
    ).toBeUndefined();
  });

  test("each cause has advice naming the remedy that reaches it", () => {
    expect(INERT_COALESCE_ADVICE["no-emptying-rule"]).toContain(
      "Move this step",
    );
    expect(INERT_COALESCE_ADVICE["no-text-default"]).toContain("text default");
  });
});

describe("the settings beside a field's steps", () => {
  test.each([undefined, 1, 5, Number.MAX_SAFE_INTEGER])(
    "a limit of %j is one the configuration schema reads",
    (limit) => {
      expect(isMaxPeoplePerValueValid(limit)).toBe(true);
      expect(
        safeParseStandardization([
          { output: "ssn", input: "ssn", max_people_per_value: limit },
        ]).success,
      ).toBe(true);
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "3", null])(
    "a limit of %j is one the configuration schema refuses",
    (limit) => {
      expect(isMaxPeoplePerValueValid(limit)).toBe(false);
      expect(
        safeParseStandardization([
          { output: "ssn", input: "ssn", max_people_per_value: limit },
        ]).success,
      ).toBe(false);
    },
  );

  test("two empty lists state no last-name rule, and either list alone states one", () => {
    expect(nullIfLastNameFromLists([], [])).toBeUndefined();
    expect(nullIfLastNameFromLists(["JOHN"], [])).toEqual({
      values: ["JOHN"],
      lastNames: [],
    });
    expect(nullIfLastNameFromLists([], ["DOE"])).toEqual({
      values: [],
      lastNames: ["DOE"],
    });
  });

  test("a rule with exactly one list filled is noted as dropping nothing", () => {
    expect(halfFilledLastNameRuleNotice([], [])).toBeUndefined();
    expect(halfFilledLastNameRuleNotice(["JOHN"], ["DOE"])).toBeUndefined();
    expect(halfFilledLastNameRuleNotice(["JOHN"], [])).toBe(
      "Add at least one last name, or this rule drops nothing.",
    );
    expect(halfFilledLastNameRuleNotice([], ["DOE"])).toBe(
      "Add at least one value, or this rule drops nothing.",
    );
  });

  test("a value entry the field's cleaning changes is reported with what it becomes", () => {
    const upper = [{ function: "to_upper_case" }];
    expect(lastNameRuleEntryCleaned("JOHN", upper)).toBeUndefined();
    expect(lastNameRuleEntryCleaned("john", [])).toBeUndefined();
    expect(lastNameRuleEntryCleaned("john", upper)).toBe("JOHN");
    expect(lastNameRuleEntryNotice("john", "JOHN")).toBe(
      'This field\'s cleaning turns "john" into "JOHN", so it never matches. Enter "JOHN" instead.',
    );

    const dropped = lastNameRuleEntryCleaned("NONE", [
      { function: "null_if", params: { value: "NONE" } },
    ]);
    expect(dropped).toBeNull();
    expect(lastNameRuleEntryNotice("NONE", null)).toBe(
      'This field\'s cleaning drops "NONE", so it never matches. Remove it.',
    );

    const split = lastNameRuleEntryCleaned("ANN-MARIE", [
      { function: "split_on", params: { delimiter: "-" } },
    ]);
    expect(split).toEqual(new Set(["ANN", "MARIE"]));
    if (split === undefined) throw new Error("expected a split entry");
    expect(lastNameRuleEntryNotice("ANN-MARIE", split)).toBe(
      'This field\'s cleaning splits "ANN-MARIE" into "ANN", "MARIE", so it never matches. Enter each part on its own instead.',
    );
  });

  test("a value entry is not checked against a step that cannot run yet", () => {
    expect(
      lastNameRuleEntryCleaned("john", [
        { function: "to_upper_case" },
        { function: "pad_left" },
      ]),
    ).toBeUndefined();
  });

  const stated: Standardization[number] = {
    output: "first_name",
    input: "fname",
    steps: [{ function: "to_upper_case" }],
    maxPeoplePerValue: 2,
    nullIfLastName: { values: ["JOHN"], lastNames: ["DOE"] },
  };

  test("the settings a transformation states are read without its binding or steps", () => {
    expect(cleaningSettingsOf(stated)).toEqual({
      maxPeoplePerValue: 2,
      nullIfLastName: { values: ["JOHN"], lastNames: ["DOE"] },
    });
    expect(
      cleaningSettingsOf({ output: "dob", input: "dob", steps: [] }),
    ).toEqual({});
  });

  test("replacing the settings keeps the binding and steps and removes what is left out", () => {
    expect(
      transformationWithCleaningSettings(stated, { maxPeoplePerValue: 4 }),
    ).toEqual({
      output: "first_name",
      input: "fname",
      steps: [{ function: "to_upper_case" }],
      maxPeoplePerValue: 4,
    });
    const cleared = transformationWithCleaningSettings(stated, {});
    expect(cleared).not.toHaveProperty("maxPeoplePerValue");
    expect(cleared).not.toHaveProperty("nullIfLastName");
    expect(
      transformationWithCleaningSettings(stated, {
        maxPeoplePerValue: undefined,
        nullIfLastName: undefined,
      }),
    ).toEqual(cleared);
  });

  test("a settings override replaces a field's settings whatever column it reads", () => {
    const base: Standardization = [
      stated,
      { output: "email", input: "mail", steps: [], maxPeoplePerValue: 5 },
    ];
    const result = applyCleaningSettingsOverrides(
      base,
      new Map([["first_name", { maxPeoplePerValue: 3 }]]),
    );
    expect(result).toEqual([
      {
        output: "first_name",
        input: "fname",
        steps: [{ function: "to_upper_case" }],
        maxPeoplePerValue: 3,
      },
      base[1],
    ]);
    expect(applyCleaningSettingsOverrides(base, new Map())).toEqual(base);
  });
});

describe("the last names a last-name rule lists", () => {
  const terms: LinkageTerms = {
    version: "1.0.0",
    identity: "party",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "first_name", type: "first_name" },
      { name: "last_name", type: "last_name" },
      { name: "date_of_birth", type: "date_of_birth" },
    ],
    linkageKeys: [
      {
        name: "names",
        elements: [{ field: "first_name" }, { field: "last_name" }],
      },
    ],
  };
  const metadata: Array<ColumnMetadata> = [
    { name: "given", type: "first_name", role: "linkage", isPayload: false },
    { name: "surname", type: "last_name", role: "linkage", isPayload: false },
    { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
  ];
  const rawRows = [
    { given: "Jane", surname: "Doe", dob: "1990-02-03" },
    { given: "John", surname: "Roe", dob: "1985-11-30" },
  ];
  const defaults = getDefaultStandardization(metadata, terms);
  const ownLastName: Standardization = defaults.map((transformation) =>
    transformation.output === "last_name"
      ? { ...transformation, steps: [{ function: "trim_whitespace" }] }
      : transformation,
  );

  test.each([
    ["the party's own last-name transformation", ownLastName],
    [
      "the default last-name cleaning",
      defaults.filter((t) => t.output !== "last_name"),
    ],
  ])("are cleaned with the steps the run chooses: %s", (_, standardization) => {
    const steps = lastNameCleaningSteps(
      standardization,
      metadata,
      terms.linkageFields,
    );
    expect(steps).toEqual(
      lastNameColumn(standardization, metadata, terms, rawRows)?.steps,
    );
    expect(steps).toBeDefined();
  });

  test("are cleaned with no steps where the party has no last name column", () => {
    const withoutLastName = metadata.filter((c) => c.type !== "last_name");
    expect(
      lastNameCleaningSteps(defaults, withoutLastName, terms.linkageFields),
    ).toBeUndefined();
  });

  test("an entry the last-name cleaning changes is reported with the form it cleans to", () => {
    const steps = lastNameCleaningSteps(
      defaults,
      metadata,
      terms.linkageFields,
    );
    if (steps === undefined) throw new Error("expected last-name steps");
    expect(lastNameRuleEntryCleaned("DOE", steps)).toBeUndefined();
    const cleaned = lastNameRuleEntryCleaned("Doe", steps);
    expect(cleaned).toBe(runPipeline("Doe", steps));
    expect(cleaned).toBe("DOE");
    expect(lastNameRuleLastNameNotice("Doe", "DOE")).toBe(
      'Your last-name cleaning turns "Doe" into "DOE", so it never matches. Enter "DOE" instead.',
    );

    const dropped = lastNameRuleEntryCleaned("D", steps);
    expect(dropped).toBeNull();
    expect(lastNameRuleLastNameNotice("D", null)).toBe(
      'Your last-name cleaning drops "D", so it never matches. Remove it.',
    );
    expect(
      lastNameRuleLastNameNotice("SMITH-JONES", new Set(["SMITH", "JONES"])),
    ).toBe(
      'Your last-name cleaning splits "SMITH-JONES" into "SMITH", "JONES", so it never matches. Enter each part on its own instead.',
    );
  });
});

describe("applyStepOverrides (per-field override layer)", () => {
  const base: Standardization = [
    { output: "fn", input: "fname", steps: [{ function: "to_upper_case" }] },
    { output: "ln", input: "lname", steps: [{ function: "to_upper_case" }] },
  ];

  test("applies an override while its input column still matches the binding", () => {
    const overrides = new Map<string, FieldStepOverride>([
      ["fn", { input: "fname", steps: [{ function: "trim_whitespace" }] }],
    ]);
    const result = applyStepOverrides(base, overrides);
    expect(result.find((t) => t.output === "fn")?.steps).toEqual([
      { function: "trim_whitespace" },
    ]);
    // An unrelated field is untouched.
    expect(result.find((t) => t.output === "ln")?.steps).toEqual([
      { function: "to_upper_case" },
    ]);
  });

  test("drops a stale override after the field re-binds to a different column", () => {
    // The field now binds to `notes`, but the override was authored against `fname`.
    const rebased: Standardization = [
      { output: "fn", input: "notes", steps: [{ function: "to_upper_case" }] },
    ];
    const overrides = new Map<string, FieldStepOverride>([
      ["fn", { input: "fname", steps: [{ function: "trim_whitespace" }] }],
    ]);
    // Falls back to the re-derived recommended steps, not the stale override -- so
    // steps authored to clean `fname` never silently drive `notes`.
    expect(applyStepOverrides(rebased, overrides)[0].steps).toEqual([
      { function: "to_upper_case" },
    ]);
  });

  test("no override leaves the base unchanged", () => {
    expect(applyStepOverrides(base, new Map())).toEqual(base);
  });
});

describe("applyInputOverrides (per-field input-column rebind)", () => {
  const base: Standardization = [
    { output: "maiden_name", input: "name_col", steps: [] },
    { output: "current_name", input: "name_col", steps: [] },
  ];
  const fields: Array<LinkageField> = [
    { name: "maiden_name", type: "first_name" },
    { name: "current_name", type: "first_name" },
  ];
  const columns: Array<ColumnMetadata> = [
    { name: "name_col", type: "first_name", role: "linkage", isPayload: false },
    {
      name: "other_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
  ];

  test("rebinds a field to its chosen column, leaving steps and other fields alone", () => {
    const result = applyInputOverrides(
      base,
      new Map([["current_name", "other_col"]]),
      fields,
      columns,
    );
    expect(result.map((t) => [t.output, t.input])).toEqual([
      ["maiden_name", "name_col"],
      ["current_name", "other_col"],
    ]);
    expect(result.map((t) => t.steps)).toEqual([[], []]);
  });

  test("a no-op override (same column) and an absent override leave the base unchanged", () => {
    expect(
      applyInputOverrides(
        base,
        new Map([["maiden_name", "name_col"]]),
        fields,
        columns,
      ),
    ).toEqual(base);
    expect(applyInputOverrides(base, new Map(), fields, columns)).toEqual(base);
  });

  describe("a field rebound to a column of the type it is derived from", () => {
    const ssn4Fields: Array<LinkageField> = [{ name: "ssn4", type: "ssn4" }];
    const ssnColumns: Array<ColumnMetadata> = [
      { name: "last4", type: "ssn4", role: "linkage", isPayload: false },
      { name: "full_ssn", type: "ssn", role: "linkage", isPayload: false },
    ];
    const ssn4Base = getDefaultStandardization(
      ssnColumns.filter((column) => column.name === "last4"),
      {
        version: "1.0.0",
        identity: "acceptor",
        date: "2026-01-01",
        algorithm: "psi",
        linkageStrategy: "cascade",
        output: { expectsOutput: true, shareWithPartner: true },
        deduplicate: false,
        linkageFields: ssn4Fields,
        linkageKeys: [{ name: "s4", elements: [{ field: "ssn4" }] }],
      },
    );
    const cleaned = (column: string, value: string) => {
      const transformation = applyInputOverrides(
        ssn4Base,
        new Map([["ssn4", column]]),
        ssn4Fields,
        ssnColumns,
      )[0];
      expect(transformation.input).toBe(column);
      return runPipeline(value, transformation.steps ?? []);
    };

    test("takes the steps derived from the source type, dropping a full number", () => {
      expect(cleaned("full_ssn", "123-45-6789")).toBeNull();
      expect(cleaned("full_ssn", "078-05-1120")).toBeNull();
      expect(cleaned("full_ssn", "***-**-8924")).toBe("8924");
    });

    test("keeps its steps when the column has the field's own type", () => {
      const rebound = applyInputOverrides(
        ssn4Base,
        new Map([["ssn4", "last4_copy"]]),
        ssn4Fields,
        [
          ...ssnColumns,
          {
            name: "last4_copy",
            type: "ssn4",
            role: "linkage",
            isPayload: false,
          },
        ],
      );
      expect(rebound[0]?.steps).toEqual(ssn4Base[0]?.steps);
    });
  });
});

describe("acceptor per-field column binding (multiple fields of one type)", () => {
  // Two linkage fields of one semantic type -- the maiden + current name case. The
  // adopted terms declare both (an inviter authored them); the acceptor must bind
  // each to a DISTINCT column of its own file.
  const terms: LinkageTerms = {
    version: "1.0.0",
    identity: "acceptor",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "maiden_name", type: "first_name" },
      { name: "current_name", type: "first_name" },
    ],
    linkageKeys: [
      { name: "maiden", elements: [{ field: "maiden_name" }] },
      { name: "current", elements: [{ field: "current_name" }] },
    ],
  };
  const metadata: Array<ColumnMetadata> = [
    {
      name: "maiden_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name: "current_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
  ];
  const rawRows = [{ maiden_col: "Smith", current_col: "Jones" }];

  test("the default type fallback collapses both same-typed fields onto the first column", () => {
    const base = getDefaultStandardization(metadata, terms);
    expect(base.map((t) => [t.output, t.input])).toEqual([
      ["maiden_name", "maiden_col"],
      ["current_name", "maiden_col"],
    ]);
  });

  test("an input override gives the second field its own column and round-trips through prepareForExchange to distinct values", () => {
    const standardization = applyInputOverrides(
      getDefaultStandardization(metadata, terms),
      new Map([["current_name", "current_col"]]),
      terms.linkageFields,
      metadata,
    );
    expect(standardization.map((t) => [t.output, t.input])).toEqual([
      ["maiden_name", "maiden_col"],
      ["current_name", "current_col"],
    ]);
    // The same { metadata, standardization } the editor hands onLaunch, run through
    // the exchange's own preparation: each field now reads its own column, so a row
    // whose two name columns differ produces two distinct cleaned values (NAME_STEPS
    // uppercases) rather than the collapsed identical pair the default would give.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata, standardization },
      "acceptor",
      rawRows,
      ["maiden_col", "current_col"],
    );
    expect(prepared.dataset.getField("maiden_name")?.get(0)).toEqual(["SMITH"]);
    expect(prepared.dataset.getField("current_name")?.get(0)).toEqual([
      "JONES",
    ]);
  });
});
