import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  inferMetadata,
  UsageError,
} from "@alcove/core";

import {
  readPartnershipConfig,
  readPartnershipTermsSource,
} from "../../src/termsUpdateFiles";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-terms-update-files-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readPartnershipConfig refuses a configuration it cannot read as a usage error", () => {
  // A directory where the configuration should be is there but cannot be read:
  // the operator's path to fix, not a transport failure to retry.
  const configPath = path.join(dir, "alcove.yaml");
  fs.mkdirSync(configPath);
  expect(() => readPartnershipConfig(configPath)).toThrow(UsageError);
  expect(() => readPartnershipConfig(configPath)).toThrow(
    /config file .*alcove\.yaml could not be read/,
  );
});

describe("a configuration naming the rule set and writing no rules", () => {
  const header = ["first_name", "last_name", "dob", "ssn"];

  /** A configuration citing the shipped set, with or without metadata. */
  function writeRuleSetConfig(withMetadata: boolean): string {
    const {
      linkageFields: _fields,
      linkageKeys: _keys,
      ...rest
    } = getDefaultLinkageTerms("Agency A");
    const configPath = path.join(dir, "alcove.yaml");
    fs.writeFileSync(
      configPath,
      YAML.stringify({
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkage_terms: {
          ...rest,
          linkageRuleSet: DEFAULT_LINKAGE_RULE_SET.reference,
        },
        ...(withMetadata ? { metadata: inferMetadata(header, []) } : {}),
      }),
    );
    return configPath;
  }

  const readers = [
    {
      command: "alcove update",
      read: (configPath: string) =>
        readPartnershipTermsSource(configPath).linkageTerms,
    },
    {
      command: "alcove apply",
      read: (configPath: string) =>
        readPartnershipConfig(configPath).linkageTerms,
    },
  ];

  test.each(readers)(
    "$command refuses one with no metadata block, since its keys follow an input header",
    ({ command, read }) => {
      const configPath = writeRuleSetConfig(false);
      expect(() => read(configPath)).toThrow(UsageError);
      expect(() => read(configPath)).toThrow(
        new RegExp(
          "writes no linkage_fields, linkage_keys or metadata block, so the " +
            `keys it runs are the ones its input file's header supplies, and ${command} ` +
            "takes no input file to read them from. Add a metadata block",
        ),
      );
    },
  );

  test.each(readers)(
    "$command reads one with a metadata block as the exchange runs it",
    ({ read }) => {
      const configPath = writeRuleSetConfig(true);
      const expected = getDefaultLinkageTerms(
        "Agency A",
        inferMetadata(header, []),
      );
      const terms = read(configPath);
      expect(terms.linkageKeys).toEqual(expected.linkageKeys);
      expect(terms.linkageFields).toEqual(expected.linkageFields);
    },
  );
});
