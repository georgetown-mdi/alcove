import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
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
  /** A configuration citing the shipped set and writing neither list. */
  function writeRuleSetConfig(): string {
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
      }),
    );
    return configPath;
  }

  test.each([
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
  ])("$command refuses it", ({ read }) => {
    const configPath = writeRuleSetConfig();
    expect(() => read(configPath)).toThrow(UsageError);
    expect(() => read(configPath)).toThrow(
      "names a rule set in linkage_terms.linkage_rule_set but writes no " +
        "linkage_fields or linkage_keys. Run 'alcove init'",
    );
  });
});
