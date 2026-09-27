import { expect, test } from "vitest";

import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { prepareForExchange } from "../src/exchange";
import { OperatorConfigError } from "../src/errors";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";

// A column typed `identifier` is valid metadata, and a linkage field of that
// type satisfies every local check, but the partner's parse of the terms
// admits no linkage field of that type.
const columns = ["short_id"];
const rows = [{ short_id: "abc123def456" }, { short_id: "zyx987wvu654" }];
const metadata: Metadata = [
  { name: "short_id", type: "identifier", role: "linkage", isPayload: false },
];
const { linkageRuleSet: _unused, ...defaultTerms } =
  getDefaultLinkageTerms("Party A");
const identifierTerms = {
  ...defaultTerms,
  linkageFields: [{ name: "short_id", type: "identifier" }],
  linkageKeys: [{ name: "ID", elements: [{ field: "short_id" }] }],
} as unknown as LinkageTerms;

function refusalOf(linkageTerms: LinkageTerms): unknown {
  try {
    prepareForExchange({ linkageTerms, metadata }, "Party A", rows, columns);
  } catch (err) {
    return err;
  }
  return undefined;
}

test("terms holding a field type the partner's parser lacks are refused at prepare, naming the field and value", () => {
  const err = refusalOf(identifierTerms);
  expect(err).toBeInstanceOf(OperatorConfigError);
  const message = (err as Error).message;
  expect(message).toContain("refused by the partner on receipt");
  expect(message).toContain("linkage_fields.0.type");
  expect(message).toContain('(the value is "identifier")');
});

test("a quoted value is cut short so the refusal stays on one line", () => {
  const err = refusalOf({
    ...identifierTerms,
    version: `${"9".repeat(60)}\nsecond line`,
  });
  expect(err).toBeInstanceOf(OperatorConfigError);
  const message = (err as Error).message;
  expect(message).toContain(`"${"9".repeat(40)}..."`);
  expect(message).not.toContain("\n");
});

test("valid terms still prepare", () => {
  const prepared = prepareForExchange(
    {
      linkageTerms: {
        ...identifierTerms,
        linkageFields: [{ name: "short_id", type: "ssn" }],
      },
      metadata: [
        { name: "short_id", type: "ssn", role: "linkage", isPayload: false },
      ],
    },
    "Party A",
    [{ short_id: "123456789" }, { short_id: "987654321" }],
    columns,
  );
  expect(prepared.linkageTerms.linkageFields).toEqual([
    { name: "short_id", type: "ssn" },
  ]);
});
