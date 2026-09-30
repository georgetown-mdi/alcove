import { describe, expect, test } from "vitest";

import {
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import {
  BACKUP_NOT_PAIR_REASON,
  UNREADABLE_CONFIGURATION_REASON,
  alreadyHeldImportReason,
  pairImportFailureReason,
} from "@recurring/managedImportFailure";
import {
  KEY_FILE_ALONE_REASON,
  NOT_A_PAIR_REASON,
  PAIR_IMPORTED_NOTICE,
  TOO_MANY_FILES_REASON,
  managedImportFileChoice,
  pairImportedNotice,
} from "@recurring/managedImportFiles";
import {
  ManagedKeyFileRefusedError,
  readManagedCommandLineKeyFile,
  readManagedCommandLinePair,
} from "@psi/managed/managedCommandLineImport";
import {
  custodyUnreadablePairImportReason,
  handedOffPairImportReason,
} from "@recurring/managedHandoffGate";
import { ManagedImportBackupNotConfigurationError } from "@psi/managed/managedExchangeImport";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

// Sorting a control's chosen files into one file or a configuration with its key
// file, by name alone, and what the pair import says when it refuses or lands.

const named = (name: string) => ({ name });

describe("sorting the chosen files", () => {
  test("nothing chosen is no choice", () => {
    expect(managedImportFileChoice([])).toBeUndefined();
  });

  test("one file that is not a key file is imported on its own", () => {
    const file = named("alcove.yaml");
    expect(managedImportFileChoice([file])).toEqual({ kind: "one", file });
  });

  test.each([".alcove.key", "alcove.key", "ALCOVE.KEY"])(
    "%s chosen alone is refused, naming the configuration to add",
    (name) => {
      expect(managedImportFileChoice([named(name)])).toEqual({
        kind: "refused",
        cause: "key-file-alone",
        reason: KEY_FILE_ALONE_REASON,
      });
    },
  );

  test("a configuration and a key file are a pair, in either order", () => {
    const configurationFile = named("alcove.yaml");
    const keyFile = named(".alcove.key");
    const pair = { kind: "pair", configurationFile, keyFile };
    expect(managedImportFileChoice([configurationFile, keyFile])).toEqual(pair);
    expect(managedImportFileChoice([keyFile, configurationFile])).toEqual(pair);
  });

  test.each([[["alcove.yaml", "other.yaml"]], [[".alcove.key", "alcove.key"]]])(
    "two files that are not one of each (%o) are refused",
    (names) => {
      expect(managedImportFileChoice(names.map(named))).toEqual({
        kind: "refused",
        cause: "not-a-pair",
        reason: NOT_A_PAIR_REASON,
      });
    },
  );

  test("more than two files are refused", () => {
    expect(
      managedImportFileChoice(
        ["alcove.yaml", ".alcove.key", "backup.json"].map(named),
      ),
    ).toEqual({
      kind: "refused",
      cause: "too-many-files",
      reason: TOO_MANY_FILES_REASON,
    });
  });
});

describe("what the pair import says", () => {
  test("a landed pair says the exchange runs here now and names the run to stop", () => {
    expect(PAIR_IMPORTED_NOTICE.lead).toContain("runs in this browser now");
    expect(PAIR_IMPORTED_NOTICE.lead).toContain("stop that first");
  });

  const webrtcLocator = {
    channel: "webrtc",
    host: "signaling.example.org",
  } as const;

  /** A pair import of a hand-written webrtc configuration stating `settings`
   * beside the connection and the terms. */
  function importedPair(settings: Record<string, unknown>) {
    const document = {
      ...composeManagedExchangeFile({
        connection: webrtcLocator,
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      connection: { ...connectionFromLocator(webrtcLocator), role: "acceptor" },
      ...settings,
    };
    return readManagedCommandLinePair(
      stringifyYaml(snakeizeKeys(document)),
      JSON.stringify({ sharedSecret: generateSharedSecret() }),
    );
  }

  test.each([
    [
      "metadata",
      {
        metadata: [
          {
            name: "case_id",
            type: "identifier",
            role: "identifier",
            isPayload: false,
          },
        ],
      },
    ],
    [
      "standardization",
      {
        standardization: [
          { output: "first_name", input: "first_name", steps: [] },
        ],
      },
    ],
    ["expected_partner_deduplicate", { expectedPartnerDeduplicate: true }],
  ] as const)(
    "a landed pair whose file states %s names it as kept unchanged",
    (name, settings) => {
      const notice = pairImportedNotice(importedPair(settings));

      expect(notice.title).toBe(PAIR_IMPORTED_NOTICE.title);
      expect(notice.lead).toBe(PAIR_IMPORTED_NOTICE.lead);
      expect(notice.consequences).toEqual([
        `This configuration states a setting this app keeps unchanged but does not show or edit: ${name}.`,
      ]);
    },
  );

  test("a landed pair names every such setting its file states, never a value", () => {
    const notice = pairImportedNotice(
      importedPair({
        metadata: [
          {
            name: "program",
            type: "other",
            role: "payload",
            isPayload: true,
          },
        ],
        expectedPartnerDeduplicate: true,
      }),
    );

    expect(notice.consequences).toHaveLength(1);
    expect(notice.consequences[0]).toContain(
      "settings this app keeps unchanged but does not show or edit: " +
        "expected_partner_deduplicate, metadata.",
    );
    expect(notice.consequences[0]).not.toContain("program");
  });

  test("a landed pair whose file states none of them adds no line", () => {
    expect(pairImportedNotice(importedPair({}))).toEqual(PAIR_IMPORTED_NOTICE);
  });

  test("a refused key file states its own reason, and never the secret", () => {
    const sharedSecret = generateSharedSecret();
    let refusal: unknown;
    try {
      readManagedCommandLineKeyFile(
        JSON.stringify({ sharedSecret, stray: sharedSecret }),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ManagedKeyFileRefusedError);
    const reason = pairImportFailureReason(refusal);
    expect(reason).toContain("holds a field this app does not read");
    expect(reason).not.toContain(sharedSecret);
  });

  test("a backup file as the configuration is named as a backup", () => {
    expect(
      pairImportFailureReason(new ManagedImportBackupNotConfigurationError()),
    ).toBe(BACKUP_NOT_PAIR_REASON);
  });

  test("anything else leaves the configuration file to check", () => {
    expect(pairImportFailureReason(new Error("x"))).toBe(
      UNREADABLE_CONFIGURATION_REASON,
    );
  });

  test("the store's refusals name the exchange, or name it neutrally", () => {
    expect(alreadyHeldImportReason("Riverbend")).toContain('"Riverbend"');
    expect(alreadyHeldImportReason("")).toMatch(/^That exchange/);
    expect(handedOffPairImportReason("command-line", "Riverbend")).toContain(
      "Take this exchange back",
    );
    expect(handedOffPairImportReason("command-line", "")).toMatch(
      /^That exchange/,
    );
    expect(custodyUnreadablePairImportReason("Riverbend")).toContain(
      "alcove.yaml and .alcove.key again",
    );
  });
});
