import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  MAX_PARAMS_ENTRIES,
  parseLinkageTerms,
  safeParseLinkageTerms,
  safeParseLinkageTermsTheReaderWrote,
} from "../../src/config/linkageTermsSchema";
import { InvitationLinkageTermsSchema } from "../../src/config/invitation";
import {
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "../../src/config/exchangeSpec";
import { computeTermsHash } from "../../src/records/exchangeRecord";
import {
  camelizeKeys,
  KeyFoldCollisionError,
} from "../../src/utils/camelizeKeys";

function dateTerms(identity: string, params: Record<string, unknown>) {
  return {
    version: "1.0.0",
    identity,
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: false },
    deduplicate: false,
    linkage_fields: [{ name: "dob", type: "date_of_birth" }],
    linkage_keys: [
      {
        name: "DOB",
        elements: [
          { field: "dob", transform: [{ function: "parse_date", params }] },
        ],
      },
    ],
  };
}

const dateParams = { input_format: "MM/DD/YYYY", output_format: "YYYYMMDD" };
const collidingParams = { input_format: "MM/DD/YYYY", inputFormat: "YYYY" };
const paramsPath = ["linkageKeys", 0, "elements", 0, "transform", 0, "params"];

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

// --- Hashes of collision-free documents --------------------------------------
// Pinned agreed-terms hashes of documents holding no collision: refusing
// collisions changes no hash of a document the fold lets through.

test("a collision-free document hashes as before", async () => {
  const hash = await computeTermsHash(
    parseLinkageTerms(dateTerms("Party A", dateParams)),
    parseLinkageTerms(dateTerms("Party B", dateParams)),
  );
  expect(hash).toBe("1ku2ognY1RDDTviURNHQ5x9Na6-N7hymtkl41TRaBzg");
});

test("a collision-free document with an unfolded provider_options subtree hashes as before", async () => {
  const params = { ...dateParams, provider_options: { input_format: "x" } };
  const terms = parseLinkageTerms(dateTerms("Party A", params));
  expect(terms.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    inputFormat: "MM/DD/YYYY",
    outputFormat: "YYYYMMDD",
    providerOptions: { input_format: "x" },
  });
  const hash = await computeTermsHash(
    terms,
    parseLinkageTerms(dateTerms("Party B", params)),
  );
  expect(hash).toBe("PZ9Zmep9m8t_M7pzoyseFVfRgtfEgE46IyCnlUauIJo");
});

// --- Partner path -------------------------------------------------------------

test("a partner's terms holding two keys that fold to one name are refused", () => {
  const err = thrownBy(() =>
    parseLinkageTerms(dateTerms("Party B", collidingParams)),
  );
  expect(err).toBeInstanceOf(KeyFoldCollisionError);
  const collision = err as KeyFoldCollisionError;
  expect(collision.keys).toEqual(["input_format", "inputFormat"]);
  expect(collision.foldedKey).toBe("inputFormat");
  expect(collision.path).toEqual(paramsPath);
  expect(collision.message).toBe(
    'keys "input_format" and "inputFormat" are read as the same key, ' +
      '"inputFormat", at linkageKeys.0.elements.0.transform.0.params',
  );
});

test("the non-throwing partner parse refuses the collision too", () => {
  const result = safeParseLinkageTerms(dateTerms("Party B", collidingParams));
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.path).toEqual(paramsPath);
  expect(issue?.message).toContain('"input_format"');
  expect(issue?.message).toContain('"inputFormat"');
});

test("an invitation's terms holding a collision are refused at decode", () => {
  const err = thrownBy(() =>
    InvitationLinkageTermsSchema.parse(dateTerms("Party B", collidingParams)),
  );
  expect(err).toBeInstanceOf(KeyFoldCollisionError);
});

// --- Config path --------------------------------------------------------------

test("the operator's own terms holding a collision are refused, naming both keys", () => {
  const result = safeParseLinkageTermsTheReaderWrote(
    dateTerms("Party A", collidingParams),
  );
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.code).toBe("unrecognized_keys");
  expect(issue?.path).toEqual(paramsPath);
  expect(issue?.message).toBe(
    'Keys "input_format" and "inputFormat" are read as one setting. ' +
      "Write the setting once.",
  );
});

test("the throwing exchange-file parse states a collision as a schema issue", () => {
  const err = thrownBy(() =>
    parseExchangeSpec({
      version: "1.0.0",
      linkage_terms: {},
      linkageTerms: {},
    }),
  );
  expect(err).toBeInstanceOf(ZodError);
  const issue = (err as ZodError).issues[0];
  expect(issue.path).toEqual([]);
  expect(issue.message).toContain('"linkage_terms"');
  expect(issue.message).toContain('"linkageTerms"');
});

// --- The fold's two exceptions ------------------------------------------------

test("two spellings inside a provider_options subtree are two keys", () => {
  const params = {
    ...dateParams,
    provider_options: { ready_timeout: 1, readyTimeout: 2 },
  };
  const terms = parseLinkageTerms(dateTerms("Party A", params));
  expect(
    terms.linkageKeys[0].elements[0].transform?.[0].params?.providerOptions,
  ).toEqual({ ready_timeout: 1, readyTimeout: 2 });
});

test("two spellings inside a params object past the width bound are left unfolded", () => {
  const wide: Record<string, unknown> = { input_format: "a", inputFormat: "b" };
  for (let i = 0; Object.keys(wide).length <= MAX_PARAMS_ENTRIES; i++)
    wide[`p${i}`] = i;
  const bound = new Map([["params", MAX_PARAMS_ENTRIES]]);
  expect(camelizeKeys({ params: wide }, bound)).toEqual({ params: wide });
  // The schema refuses such a params object on its own count bound.
  expect(safeParseLinkageTerms(dateTerms("Party A", wide)).success).toBe(false);
});

// A params object of 259 keys, two of which fold to one name.
function wideCollidingParams(): Record<string, unknown> {
  const wide: Record<string, unknown> = { a_b: 1, aB: 2 };
  for (let i = 0; i < MAX_PARAMS_ENTRIES + 1; i++) wide[`p${i}`] = i;
  return wide;
}

const widthRefusal = `transform params must not exceed ${MAX_PARAMS_ENTRIES} entries`;

test("the exchange file folds its linkage terms under the same width bound", () => {
  const terms = dateTerms("Party A", wideCollidingParams());
  const alone = safeParseLinkageTerms(terms);
  expect(alone.success).toBe(false);
  expect(alone.error?.issues).toContainEqual(
    expect.objectContaining({ path: paramsPath, message: widthRefusal }),
  );
  expect(() => parseLinkageTerms(terms)).toThrow(widthRefusal);

  const inFile = { linkage_terms: terms };
  const inFilePath = ["linkageTerms", ...paramsPath];
  const safe = safeParseExchangeSpec(inFile);
  expect(safe.success).toBe(false);
  const thrown = thrownBy(() => parseExchangeSpec(inFile));
  expect(thrown).toBeInstanceOf(ZodError);
  for (const issues of [safe.error?.issues, (thrown as ZodError).issues]) {
    expect(issues).toContainEqual(
      expect.objectContaining({ path: inFilePath, message: widthRefusal }),
    );
    expect(issues).not.toContainEqual(
      expect.objectContaining({ keys: ["a_b", "aB"] }),
    );
  }
});

test("the exchange file's width bound reaches no params object outside its linkage terms", () => {
  const inFile = {
    linkage_terms: dateTerms("Party A", dateParams),
    standardization: { steps: [{ params: wideCollidingParams() }] },
  };
  const safe = safeParseExchangeSpec(inFile);
  expect(safe.success).toBe(false);
  expect(safe.error?.issues).toEqual([
    expect.objectContaining({
      path: ["standardization", "steps", 0, "params"],
      keys: ["a_b", "aB"],
    }),
  ]);
});
