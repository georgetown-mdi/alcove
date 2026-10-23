import { expect, test } from "vitest";
import { ZodError } from "zod";

import {
  decodeInvitation,
  encodeInvitation,
} from "../../src/config/invitation";
import { safeParseLinkageTerms } from "../../src/config/linkageTermsSchema";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import {
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY,
  COUNT_ONLY_SHAPE_REFUSALS,
} from "../../src/linkageTermsPolicy";
import {
  candidateSetUnderStrategyMessage,
  MAX_EFFECTIVE_KEY_COUNT,
  MAX_KEY_CANDIDATE_WIDTH,
} from "../../src/fanOutFunctions";
import { REGEX_STEP_PATTERN_PARAM } from "../../src/config/transformRegexDialect";
import { encodeRawInvitation } from "../utils/support";

// The strings a partner authors in the document below. A refusal locates the
// offending key by its position and states a fixed literal, so none of these
// may reach the issue a decode raises: the accept route renders a decode error
// with no sanitizing pass of its own (describeDecodeError.ts).
const PARTNER_TEXT = [
  "Partner Authored Identity",
  "partner_given",
  "partner_family",
  "partner_identifier",
  "Partner Key Name",
  "partner-delimiter",
];

// A SHARED_SECRET_REGEX-valid placeholder (43 base64url characters).
const VALID_SECRET = "A".repeat(43);

const splitOn = [
  { function: "split_on", params: { delimiter: "partner-delimiter" } },
];

function partnerTerms(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0.0",
    identity: "Partner Authored Identity",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "partner_given", type: "first_name" },
      { name: "partner_family", type: "last_name" },
      { name: "partner_identifier", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "Partner Key Name",
        elements: [{ field: "partner_given" }, { field: "partner_family" }],
      },
    ],
    ...overrides,
  };
}

// A key whose candidate set a count-only round has no resolution for.
const candidateSetKeys = [
  {
    name: "Partner Key Name",
    elements: [{ field: "partner_given", transform: splitOn }],
  },
];

// Each fan-out element contributes 20 candidates and the key's elements
// multiply, so three of them declare 8000 against the 1024 ceiling.
const overWideKeys = [
  {
    name: "Partner Key Name",
    elements: [
      { field: "partner_given", transform: splitOn },
      { field: "partner_family", transform: splitOn },
      { field: "partner_identifier", transform: splitOn },
    ],
  },
];

// 13 keys of width 400 sum to 5200, above the 5120 ceiling, with every key
// under the per-key one.
const overCountKeys = Array.from({ length: 13 }, (_, index) => ({
  name: `Partner Key Name ${index}`,
  elements: [
    { field: "partner_given", transform: splitOn },
    { field: "partner_family", transform: splitOn },
  ],
}));

function refusalsOf(raw: Record<string, unknown>): ReadonlyArray<string> {
  const result = safeParseLinkageTerms(raw);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

function expectNoPartnerText(messages: ReadonlyArray<string>): void {
  for (const message of messages)
    for (const authored of PARTNER_TEXT)
      expect(message).not.toContain(authored);
}

function invitationOver(terms: Record<string, unknown>): Promise<string> {
  return encodeRawInvitation({
    version: "1",
    linkageTerms: terms,
    sharedSecret: VALID_SECRET,
  });
}

async function decodeRefusalsOf(
  terms: Record<string, unknown>,
): Promise<ReadonlyArray<string>> {
  const encoded = await invitationOver(terms);
  const raised: unknown = await decodeInvitation(encoded).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(raised).toBeInstanceOf(ZodError);
  return (raised as ZodError).issues.map((issue) => issue.message);
}

test("a candidate set under the count-only algorithm is refused at the parse", () => {
  const messages = refusalsOf(
    partnerTerms({ algorithm: "psi-c", linkageKeys: candidateSetKeys }),
  );
  expect(messages).toContain(COUNT_ONLY_SHAPE_REFUSALS.candidateSet);
  expectNoPartnerText(messages);
});

test("a candidate set under the count-only algorithm is refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ algorithm: "psi-c", linkageKeys: candidateSetKeys }),
  );
  expect(messages).toContain(COUNT_ONLY_SHAPE_REFUSALS.candidateSet);
  expectNoPartnerText(messages);
});

test("a candidate set under a strategy off the allowlist is refused at the parse", () => {
  // Both shipped strategies resolve a candidate set, so the allowlist half is
  // driven by standing one of them down, as the round's own gate is driven
  // (link.test.ts). It is the entry a strategy added later starts from.
  const shipped = CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade;
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = false;
  try {
    const messages = refusalsOf(
      partnerTerms({ linkageKeys: candidateSetKeys }),
    );
    expect(messages).toContain(candidateSetUnderStrategyMessage());
    expectNoPartnerText(messages);
  } finally {
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = shipped;
  }
});

test("a candidate set under a strategy off the allowlist is refused at the decode", async () => {
  const shipped = CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade;
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = false;
  try {
    const messages = await decodeRefusalsOf(
      partnerTerms({ linkageKeys: candidateSetKeys }),
    );
    expect(messages).toContain(candidateSetUnderStrategyMessage());
    expectNoPartnerText(messages);
  } finally {
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = shipped;
  }
});

test("a key wider than the per-key candidate ceiling is refused at the parse", () => {
  const messages = refusalsOf(partnerTerms({ linkageKeys: overWideKeys }));
  expect(messages.join("\n")).toContain(
    `${MAX_KEY_CANDIDATE_WIDTH} candidate values one key may hold`,
  );
  expect(messages.join("\n")).toContain("the linkage key at linkage_keys[0]");
  expectNoPartnerText(messages);
});

test("a key wider than the per-key candidate ceiling is refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ linkageKeys: overWideKeys }),
  );
  expect(messages.join("\n")).toContain(
    `${MAX_KEY_CANDIDATE_WIDTH} candidate values one key may hold`,
  );
  expectNoPartnerText(messages);
});

test("terms above the effective key count ceiling are refused at the parse", () => {
  const messages = refusalsOf(partnerTerms({ linkageKeys: overCountKeys }));
  expect(messages.join("\n")).toContain(
    `more than the ${MAX_EFFECTIVE_KEY_COUNT} an exchange allows`,
  );
  expectNoPartnerText(messages);
});

test("terms above the effective key count ceiling are refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ linkageKeys: overCountKeys }),
  );
  expect(messages.join("\n")).toContain(
    `more than the ${MAX_EFFECTIVE_KEY_COUNT} an exchange allows`,
  );
  expectNoPartnerText(messages);
});

// Each raw-pattern function keyed to the param it matches on, which the
// function reads no default for. Driven from the shipped table rather than a
// copy of it, so a function added to one is refused here or says so.
const patternSteps = Object.entries(REGEX_STEP_PATTERN_PARAM).map(
  ([fn, param]) => ({ fn, param }),
);

test.each(patternSteps)(
  "$fn with no $param is refused at the parse",
  ({ fn, param }) => {
    const messages = refusalsOf(
      partnerTerms({
        linkageKeys: [
          {
            name: "Partner Key Name",
            elements: [
              { field: "partner_given", transform: [{ function: fn }] },
            ],
          },
        ],
      }),
    );
    expect(messages).toContain(
      `${fn} ${param} must be declared, and this step declares none`,
    );
    expectNoPartnerText(messages);
  },
);

test.each(patternSteps)(
  "$fn with no $param is refused at the decode",
  async ({ fn, param }) => {
    // Without the refusal the step compiles the literal `undefined` and
    // matches, splits, or filters on those nine characters, which is a wrong
    // result rather than a failed run.
    const messages = await decodeRefusalsOf(
      partnerTerms({
        linkageKeys: [
          {
            name: "Partner Key Name",
            elements: [
              { field: "partner_given", transform: [{ function: fn }] },
            ],
          },
        ],
      }),
    );
    expect(messages).toContain(
      `${fn} ${param} must be declared, and this step declares none`,
    );
    expectNoPartnerText(messages);
  },
);

test("a mistyped param is named the way the document writes it", () => {
  // Validation runs on the camelized shape, and the paths that locate a
  // refusal stop at `params`, so the message is the only part that names the
  // key -- and it names the one the operator can find in the file.
  const messages = refusalsOf(
    partnerTerms({
      linkageKeys: [
        {
          name: "Partner Key Name",
          elements: [
            {
              field: "partner_given",
              transform: [
                {
                  function: "split_on",
                  params: { delimiter: ",", include_original: 5 },
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(messages).toContain(
    "split_on include_original must be true or false, not a number",
  );
  expect(messages.join("\n")).not.toContain("includeOriginal");
});

// A split_on delimiter matching the empty string splits a value between its
// characters, so a key over it matches on shared letters. The empty delimiter,
// and three patterns that match without consuming a character.
const EMPTY_MATCHING_DELIMITERS = ["", "-*", "|", "\\B"];

const EMPTY_MATCHING_DELIMITER_REFUSAL =
  "split_on delimiter must not match the empty string, which can split a " +
  "value into single characters";

// The split sits second in the second element's transform, so the issue path
// is read off the step's own position rather than the first one.
function keysSplittingOn(delimiter: string): Array<Record<string, unknown>> {
  return [
    {
      name: "Partner Key Name",
      elements: [
        { field: "partner_given" },
        {
          field: "partner_family",
          transform: [
            { function: "to_upper_case" },
            { function: "split_on", params: { delimiter } },
          ],
        },
      ],
    },
  ];
}

test.each(EMPTY_MATCHING_DELIMITERS)(
  "a split_on delimiter of %j is refused at the parse, locating the step",
  (delimiter) => {
    const result = safeParseLinkageTerms(
      partnerTerms({ linkageKeys: keysSplittingOn(delimiter) }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.map((issue) => [issue.path, issue.message]),
    ).toEqual([
      [
        [
          "linkageKeys",
          0,
          "elements",
          1,
          "transform",
          1,
          "params",
          "delimiter",
        ],
        EMPTY_MATCHING_DELIMITER_REFUSAL,
      ],
    ]);
  },
);

test.each(EMPTY_MATCHING_DELIMITERS)(
  "a split_on delimiter of %j is refused at the decode",
  async (delimiter) => {
    const messages = await decodeRefusalsOf(
      partnerTerms({ linkageKeys: keysSplittingOn(delimiter) }),
    );
    expect(messages).toEqual([EMPTY_MATCHING_DELIMITER_REFUSAL]);
    expectNoPartnerText(messages);
  },
);

test.each(EMPTY_MATCHING_DELIMITERS)(
  "a split_on delimiter of %j is refused at the mint",
  async (delimiter) => {
    const raised: unknown = await encodeInvitation({
      version: "1",
      linkageTerms: partnerTerms({
        linkageKeys: keysSplittingOn(delimiter),
      }) as unknown as LinkageTerms,
      sharedSecret: VALID_SECRET,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(raised).toBeInstanceOf(ZodError);
    expect((raised as ZodError).issues.map((issue) => issue.message)).toEqual([
      EMPTY_MATCHING_DELIMITER_REFUSAL,
    ]);
  },
);

// `\b` is zero-width too, but matches only beside a word character, so it
// cannot match the empty string and splits at word boundaries alone.
test.each(["-", "[-\\s]+", "\\b"])(
  "a split_on delimiter of %j still parses and decodes",
  async (delimiter) => {
    const runnable = partnerTerms({ linkageKeys: keysSplittingOn(delimiter) });
    expect(safeParseLinkageTerms(runnable).success).toBe(true);
    const token = await decodeInvitation(await invitationOver(runnable));
    expect(
      token.linkageTerms.linkageKeys[0].elements[1].transform?.[1].params,
    ).toEqual({ delimiter });
  },
);

test("terms an exchange can run still parse and decode", async () => {
  // The same document with one fan-out element on a `psi` cascade: a candidate
  // set both shipped strategies resolve, at a width of 20 against both
  // ceilings.
  const runnable = partnerTerms({ linkageKeys: candidateSetKeys });
  expect(safeParseLinkageTerms(runnable).success).toBe(true);
  const token = await decodeInvitation(await invitationOver(runnable));
  expect(token.linkageTerms.linkageKeys).toHaveLength(1);
});
