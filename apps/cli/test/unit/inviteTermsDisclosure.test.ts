import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import logLibrary from "loglevel";
import { expect, test, vi } from "vitest";

import {
  CONSENT_FACTS,
  COUNT_ONLY_DECLARED_STRATEGY_STATEMENT,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  decodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  missingFieldConditionStatement,
  summarizeInvitation,
} from "@alcove/core";
import { COUNT_ONLY_PROBE_TERMS } from "@alcove/core/testing";
import type { LinkageTerms } from "@alcove/core";

import { validateInvite } from "../../src/commands/invite";
import { saveConfig } from "../../src/config";
import { renderExchangeDisclosure } from "../../src/exchangeDisclosure";
import { displayInvitation } from "../../src/invitationDisplay";
import { singlePassDisclosureNotice } from "../../src/onlineBootstrap";

const HEADING =
  "What these terms disclose, which your partner is also shown before accepting:";
const STRATEGY_LINE_PREFIX = "  linkage strategy (enforced): ";
const KEYS_LINE = "  linkage keys (enforced):";

const INPUT_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

function defaultTerms(): LinkageTerms {
  return getDefaultLinkageTerms("Agency A", inferMetadata(INPUT_COLUMNS, []));
}

// The default keys and one more on the two names that matches only where a
// date of birth is missing.
function withMissingDateKey(terms: LinkageTerms): LinkageTerms {
  const fieldOf = (type: string): string => {
    const field = terms.linkageFields.find((entry) => entry.type === type);
    if (field === undefined) throw new Error(`no ${type} field declared`);
    return field.name;
  };
  return {
    ...terms,
    linkageKeys: [
      ...terms.linkageKeys,
      {
        name: "names, no date of birth",
        elements: [
          { field: fieldOf("first_name") },
          { field: fieldOf("last_name") },
        ],
        condition: { missingField: fieldOf("date_of_birth") },
      },
    ],
  };
}

const SHAPES: ReadonlyArray<{ label: string; terms: LinkageTerms }> = [
  {
    label: "psi, one key",
    terms: {
      ...defaultTerms(),
      linkageKeys: defaultTerms().linkageKeys.slice(0, 1),
    },
  },
  {
    label: "psi, several keys under single-pass with a missing-field key",
    terms: {
      ...withMissingDateKey(defaultTerms()),
      linkageStrategy: "single-pass",
    },
  },
  {
    label: "psi-c, several keys with a missing-field key, both receive",
    terms: COUNT_ONLY_PROBE_TERMS,
  },
  {
    label: "psi-c, several keys under single-pass, the inviter alone receives",
    terms: {
      ...COUNT_ONLY_PROBE_TERMS,
      linkageStrategy: "single-pass",
      output: { expectsOutput: true, shareWithPartner: false },
    },
  },
];

/** The lines `alcove invite` printed under its heading from a configuration
 * holding `terms`, and the terms the invitation states. */
async function inviteFromConfig(
  terms: LinkageTerms,
): Promise<{ block: string[]; minted: LinkageTerms }> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-invite-disclosure-"));
  const configPath = path.join(dir, "alcove.yaml");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
  const log = getLogger("invite-terms-disclosure-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: {
        configFile: configPath,
        keyFile: path.join(dir, ".alcove.key"),
        record: false,
        eventStream: false,
        logLevel: logLibrary.levels.SILENT,
        verbosity: 0,
      },
      acceptTimeout: 900,
      log,
    });
    const printed = infoSpy.mock.calls.map((call) => String(call[0]));
    const start = printed.indexOf(HEADING);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = printed.findIndex(
      (line, index) => index > start && !line.startsWith("  "),
    );
    return {
      block: printed.slice(start + 1, end === -1 ? undefined : end),
      minted: (await decodeInvitation(ready.invitation)).linkageTerms,
    };
  } finally {
    infoSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What `alcove accept` shows the partner for `terms`. */
function partnerShown(terms: LinkageTerms): string[] {
  const lines: string[] = [];
  displayInvitation({
    token: { linkageTerms: terms },
    ownOutboundSend: [],
    emit: (line) => lines.push(line),
    promptFollows: false,
  });
  return lines;
}

/** What `alcove exchange` shows the inviter for its own `terms`. */
function inviterRunShown(terms: LinkageTerms): string[] {
  const lines: string[] = [];
  renderExchangeDisclosure(
    (line) => lines.push(line),
    terms,
    inferMetadata(INPUT_COLUMNS, []),
    INPUT_COLUMNS,
    undefined,
    "configuredExchange",
  );
  return lines;
}

function containsRun(lines: string[], run: string[]): boolean {
  return lines.some((_, at) =>
    run.every((line, offset) => lines[at + offset] === line),
  );
}

test.each(SHAPES)(
  "alcove invite from a configuration states what the partner is shown ($label)",
  async ({ terms }) => {
    const { block, minted } = await inviteFromConfig(terms);
    const strategyAt = block.findIndex((line) =>
      line.startsWith(STRATEGY_LINE_PREFIX),
    );
    const keysAt = block.indexOf(KEYS_LINE);
    expect(strategyAt).toBeGreaterThan(0);
    expect(keysAt).toBeGreaterThan(strategyAt);
    const algorithmTier = block.slice(0, strategyAt);
    const strategy = block.slice(strategyAt, keysAt);
    const conditionLines = block
      .slice(keysAt + 1)
      .filter((line) => line.startsWith("      "));
    const expectedConditions = summarizeInvitation({ linkageTerms: minted })
      .linkageKeys.flatMap((key) => key.condition ?? [])
      .map((condition) => `      ${condition}`);
    expect(conditionLines).toEqual(expectedConditions);

    for (const shown of [partnerShown(minted), inviterRunShown(terms)]) {
      expect(containsRun(shown, algorithmTier)).toBe(true);
      expect(containsRun(shown, strategy)).toBe(true);
      for (const line of conditionLines) expect(shown).toContain(line);
    }
  },
);

test("the count-only block states the whole tier and the psi-c missing-field line", async () => {
  const { block } = await inviteFromConfig(COUNT_ONLY_PROBE_TERMS);
  expect(block).toEqual(
    expect.arrayContaining([
      "  PSI algorithm (enforced): psi-c",
      `    ${COUNT_ONLY_DISCLOSURE_STATEMENT}`,
      `    ${CONSENT_FACTS.countOnlyResult.note}`,
      `    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`,
      `    ${CONSENT_FACTS.countOnlyReportedCount.note}`,
      `    ${CONSENT_FACTS.countOnlyInputChoice.note}`,
      "  linkage strategy (enforced): cascade",
      `      ${missingFieldConditionStatement("date of birth", "psi-c")}`,
    ]),
  );
  expect(block.join("\n")).not.toContain(
    missingFieldConditionStatement("date of birth", "psi"),
  );
});

test("a count-only block for a sole receiver leaves out the reported-count line", async () => {
  const { block } = await inviteFromConfig({
    ...COUNT_ONLY_PROBE_TERMS,
    linkageStrategy: "single-pass",
    output: { expectsOutput: true, shareWithPartner: false },
  });
  expect(block).not.toContain(
    `    ${CONSENT_FACTS.countOnlyReportedCount.note}`,
  );
  expect(block).toContain(`    ${COUNT_ONLY_DECLARED_STRATEGY_STATEMENT}`);
});

test("a psi block states the single-pass note and the psi missing-field line", async () => {
  const { block } = await inviteFromConfig({
    ...withMissingDateKey(defaultTerms()),
    linkageStrategy: "single-pass",
  });
  expect(block).toContain("  PSI algorithm (enforced): psi");
  expect(block).toContain(`    ${singlePassDisclosureNotice()}`);
  expect(block).toContain(
    `      ${missingFieldConditionStatement("date of birth", "psi")}`,
  );
  expect(block.join("\n")).not.toContain(COUNT_ONLY_DISCLOSURE_STATEMENT);
});
