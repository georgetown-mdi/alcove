import { describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import { readManagedCommandLineConfiguration } from "@psi/managed/managedCommandLineImport";

import {
  LIVE_COPY_IMPORT_CONFIRM,
  UNREADABLE_IMPORT_REASON,
  UNRECOGNIZED_IMPORT_REASON,
  alreadyHeldBackupImportReason,
  alreadyHeldImportReason,
  chosenCopyImportReason,
  importFailureReason,
  liveCopyImportReason,
  liveCopyKeepLabel,
  liveCopyReplaceLabel,
  storedCopyImportReason,
  storedCopyTakeLabel,
} from "@recurring/managedImportFailure";
import {
  MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@alcove/core";
import type { ManagedStoredCopy } from "@psi/managed/managedPairRecognition";

/** A record built from `fields` and narrowed to the runnable shape: every fixture
 * here is built with a shared secret, and the export paths take the record type
 * that holds one. */
function runnableRecord(
  fields: NewManagedExchange,
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(buildManagedExchangeRecord(fields));
}

// What the import affordance says about a file it will not take. The copy is
// driven from real rejections rather than a hand-made error, so a route that
// stops being a schema failure fails this test rather than quietly showing the
// operator the wrong remedy.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** A valid artifact as the loose document a newer build's extra markers are
 * added to. */
function artifactDocument(): Record<string, unknown> {
  const record = runnableRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  return encodeManagedExchangeArtifact(record) as unknown as Record<
    string,
    unknown
  >;
}

function serialize(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A hand-written command-line configuration, as the file on disk holds it: the
 * document this app composes plus the `role` the CLI reads. Loosely typed, since
 * what it is here for is being edited off the schema. */
function configurationDocument(): Record<string, unknown> & {
  connection: WebRTCConnectionConfig;
} {
  const composed = composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
  const connection = composed.connection as WebRTCConnectionConfig;
  return { ...composed, connection: { ...connection, role: "acceptor" } };
}

/** The reason the affordance shows for a command-line configuration it refuses. */
function reasonForImportingConfiguration(
  document: Record<string, unknown>,
): string {
  try {
    readManagedCommandLineConfiguration(stringifyYaml(snakeizeKeys(document)));
  } catch (error) {
    return importFailureReason(error);
  }
  throw new Error("the import was expected to refuse this configuration");
}

/** The reason the affordance shows for bytes the import refuses. */
function reasonForImporting(source: string): string {
  try {
    importManagedExchangeArtifact(source);
  } catch (error) {
    return importFailureReason(error);
  }
  throw new Error("the import was expected to refuse these bytes");
}

describe("a backup file the artifact schema rejects", () => {
  test("names a newer version as a cause, with both ways past it", () => {
    const document = artifactDocument();
    document.local = {
      ...(document.local as Record<string, unknown>),
      heldSigningIdentity: true,
    };

    const reason = reasonForImporting(serialize(document));

    expect(reason).toBe(UNRECOGNIZED_IMPORT_REASON);
    expect(reason).toBe(
      "This app does not recognize what the backup file holds. It may have " +
        "been exported by a newer version of this app than this page is " +
        "running: reload this page to use the current version, or export the " +
        "backup again from the device that wrote this file. Otherwise check " +
        "that you chose the backup file you exported and that it was not " +
        "modified.",
    );
  });

  test("says the same for an artifact version this build does not know", () => {
    const document = artifactDocument();
    document.artifactVersion = "alcove-managed-exchange-artifact/v3";

    expect(reasonForImporting(serialize(document))).toBe(
      UNRECOGNIZED_IMPORT_REASON,
    );
  });

  test("says the same for an embedded document this build does not know", () => {
    const document = artifactDocument();
    document.exchangeDocument = `${document.exchangeDocument as string}later_agreed_option: true\n`;

    expect(reasonForImporting(serialize(document))).toBe(
      UNRECOGNIZED_IMPORT_REASON,
    );
  });
});

describe("a command-line configuration off the exchange-file schema", () => {
  test("names the fields to fix, in the spelling the file writes them", () => {
    const document = configurationDocument();

    const reason = reasonForImportingConfiguration({
      ...document,
      csvDelimiter: ";;",
      connection: {
        ...document.connection,
        server: { ...document.connection.server, port: 70_000 },
      },
    });

    expect(reason).toContain("csv_delimiter");
    expect(reason).toContain("connection.server.port");
    expect(reason).toContain("import it again");
    expect(reason).not.toBe(UNRECOGNIZED_IMPORT_REASON);
    expect(reason).not.toContain("newer version");
  });

  test("a backup envelope missing a field keeps the version wording", () => {
    // The two schema failures part here: the operator wrote the configuration
    // above by hand and can fix the line it names, while a backup file this app
    // wrote is only explained by the build that wrote it.
    const document = artifactDocument();
    delete document.local;

    expect(reasonForImporting(serialize(document))).toBe(
      UNRECOGNIZED_IMPORT_REASON,
    );
  });
});

describe("a backup file at an earlier artifact version whose migration fails", () => {
  test("names both versions and the cause, and gives an older file's way on", () => {
    // Told the newer-build story, the operator would reload a page that is
    // already current.
    const document = artifactDocument();
    document.artifactVersion = MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION;
    (document.local as Record<string, unknown>).standingCondition = {
      since: "2026-10-01T00:00:00.000Z",
      kind: "auth",
      response: { kind: "compromise", at: "2026-10-02T00:00:00.000Z" },
    };

    const reason = reasonForImporting(serialize(document));

    expect(reason).toBe(
      "The backup file is format version alcove-managed-exchange-backup/v2, " +
        "and this version of Alcove could not move it to version " +
        "alcove-managed-exchange-backup/v3: it records that the exchange was " +
        "treated as a possible compromise, which a backup of that version " +
        "cannot record. The file was not changed. Export the backup again " +
        "from the device that holds the exchange, or set up a new exchange " +
        "with your partner.",
    );
    expect(reason).not.toContain("newer version");
    expect(reason).not.toContain("reload");
  });

  test("names a version no migration leads from", () => {
    const document = artifactDocument();
    document.artifactVersion = "alcove-managed-exchange-backup/v1";

    expect(reasonForImporting(serialize(document))).toContain(
      "could not move it to version alcove-managed-exchange-backup/v3: it " +
        "has no migration from version alcove-managed-exchange-backup/v1.",
    );
  });
});

describe("a backup file that does not parse", () => {
  test("is the file's own problem, and says nothing about a version", () => {
    const reason = reasonForImporting("not a backup file at all");

    expect(reason).toBe(UNREADABLE_IMPORT_REASON);
    expect(reason).not.toContain("version");
  });

  test("an embedded document that is not YAML falls the same way", () => {
    const document = artifactDocument();
    document.exchangeDocument = "connection: [\n";

    expect(reasonForImporting(serialize(document))).toBe(
      UNREADABLE_IMPORT_REASON,
    );
  });
});

describe("a failure that is not the file's", () => {
  test("keeps the operator on the file rather than blaming a version", () => {
    expect(importFailureReason(new Error("the store would not open"))).toBe(
      UNREADABLE_IMPORT_REASON,
    );
  });
});

/** The serialized artifact the export actually writes still imports, so the
 * rejections above are the fixtures' doing and not the fixture builder's. */
describe("the artifact this build writes", () => {
  test("imports without reaching a refusal at all", () => {
    expect(() =>
      importManagedExchangeArtifact(
        serializeManagedExchangeArtifact(
          artifactDocument() as unknown as Parameters<
            typeof serializeManagedExchangeArtifact
          >[0],
        ),
      ),
    ).not.toThrow();
  });
});

/** Listed exchanges that run here, one per label, as a backup import names
 * them. */
function runningCopies(...labels: Array<string>): Array<ManagedStoredCopy> {
  return labels.map((label, index) => ({
    id: `listed-${index}`,
    label,
    state: "runs-here",
  }));
}

/** Every reason a backup import can be refused or stopped with, where a
 * listed exchange is involved. */
const LISTED_EXCHANGE_REASONS: Array<[string, string]> = [
  ["already held", alreadyHeldBackupImportReason("Riverbend quarterly")],
  [
    "a possible live copy",
    liveCopyImportReason(runningCopies("Riverbend quarterly")),
  ],
  [
    "a possible configuration-only copy",
    liveCopyImportReason([
      { id: "a", label: "Riverbend quarterly", state: "configuration-only" },
    ]),
  ],
];

describe("what a backup import says about an exchange already listed", () => {
  test("each names the listed exchange, and an unnamed one neutrally", () => {
    for (const [, reason] of LISTED_EXCHANGE_REASONS)
      expect(reason).toContain('"Riverbend quarterly"');
    expect(alreadyHeldBackupImportReason("")).toMatch(/^That exchange /);
    expect(liveCopyImportReason(runningCopies(""))).toMatch(
      /^An exchange in the list /,
    );
  });

  test("the possible live copy states nothing was imported and the three ways on", () => {
    const reason = liveCopyImportReason(runningCopies("Riverbend quarterly"));
    expect(reason).toContain("Nothing was imported.");
    expect(reason).toMatch(/this backup is the newer one: replace the saved/);
    expect(reason).toMatch(
      /run history and accounting of disclosures are kept/,
    );
    expect(reason).toMatch(/older than the saved copy, keep the saved copy/);
    expect(reason).toMatch(/add the backup as a new exchange/);
    expect(reason).not.toMatch(/open it from the list/i);
  });

  test("several possible live copies are named in one reason", () => {
    const reason = liveCopyImportReason(
      runningCopies("Riverbend quarterly", "", "Weekly"),
    );
    expect(reason).toMatch(/^3 exchanges in the list /);
    expect(reason).toContain(
      '"Riverbend quarterly", "Weekly", and 1 with no name',
    );
    expect(reason).toContain("Nothing was imported.");
    expect(reason).toMatch(/replace that saved copy with it/);
    expect(reason).toMatch(/keep the saved copies/);
    expect(liveCopyImportReason(runningCopies("", ""))).toMatch(
      /^2 exchanges in the list have /,
    );
  });

  test("a configuration-only copy, which never ran here, is not said to have run here", () => {
    const reason = liveCopyImportReason([
      { id: "a", label: "Riverbend", state: "configuration-only" },
    ]);
    expect(reason).toBe(
      '"Riverbend" holds a configuration without its key file and has the ' +
        "same terms and the same side as this backup. Nothing was imported. " +
        "If the backup is of that exchange, replace the saved copy with it. " +
        "If this is a separate exchange with the same terms, add the backup " +
        "as a new exchange.",
    );

    const configurationOnly = liveCopyImportReason([
      { id: "a", label: "Riverbend", state: "configuration-only" },
      { id: "b", label: "", state: "configuration-only" },
    ]);
    expect(configurationOnly).toMatch(
      /^2 exchanges in the list \("Riverbend", and 1 with no name\)/,
    );
    expect(configurationOnly).toMatch(/none holds its secret/);
    expect(configurationOnly).toMatch(/replace that saved copy with it/);

    const mixed = liveCopyImportReason([
      { id: "a", label: "Riverbend", state: "configuration-only" },
      { id: "b", label: "Weekly", state: "runs-here" },
    ]);
    expect(mixed).toMatch(/Replace one that runs here only if the exchange/);
    for (const text of [reason, configurationOnly])
      expect(text).not.toMatch(/last ran here|different secret/);
  });

  test("one replace button for one copy, one per copy for several, then keep and add", () => {
    expect(liveCopyReplaceLabel(["Riverbend quarterly"], 0)).toBe(
      "Replace the saved copy",
    );
    expect(liveCopyReplaceLabel(["Riverbend quarterly", ""], 0)).toBe(
      'Replace "Riverbend quarterly"',
    );
    expect(liveCopyReplaceLabel(["Riverbend quarterly", ""], 1)).toBe(
      "Replace listed exchange 2",
    );
    expect(liveCopyKeepLabel(1)).toBe("Keep the saved copy");
    expect(liveCopyKeepLabel(2)).toBe("Keep the saved copies");
    expect(LIVE_COPY_IMPORT_CONFIRM).toBe("Add as a new exchange");
    expect(LIVE_COPY_IMPORT_CONFIRM).not.toMatch(/separate/i);
  });

  test("a held exchange whose saved state cannot be read is named, with removal as the way on", () => {
    expect(alreadyHeldBackupImportReason("Riverbend quarterly", true)).toBe(
      '"Riverbend quarterly" is in this browser with this backup\'s secret, ' +
        "but part of its saved state cannot be read, so it cannot be opened. " +
        "Remove it from the list, then import this backup again.",
    );
    expect(alreadyHeldImportReason("", true)).toBe(
      "That exchange is in this browser with the secret this .alcove.key " +
        "holds, but part of its saved state cannot be read, so it cannot be " +
        "opened. Remove it from the list, then import these files again.",
    );
    expect(alreadyHeldBackupImportReason("Riverbend quarterly")).toMatch(
      /Open it from the list/,
    );
  });

  test("no reason advises clearing the list to import", () => {
    for (const [name, reason] of [
      ...LISTED_EXCHANGE_REASONS,
      ["unreadable", UNREADABLE_IMPORT_REASON],
      ["unrecognized", UNRECOGNIZED_IMPORT_REASON],
    ]) {
      expect(reason, name).not.toMatch(/\bevery\b|\ball\b/i);
      expect(reason, name).not.toMatch(/no recurring exchanges/i);
    }
  });
});

describe("an import question where the rotation histories order the copies", () => {
  test("one saved copy: the backup states the order found and the matching way on", () => {
    const newer = liveCopyImportReason([
      {
        id: "a",
        label: "Riverbend",
        state: "runs-here",
        order: "import-newer",
      },
    ]);
    expect(newer).toBe(
      '"Riverbend" has the same terms and the same side as this backup, with ' +
        "a different secret. Nothing was imported. This backup is newer than " +
        "the saved copy: replace the saved copy with it, and the saved copy's " +
        "run history and accounting of disclosures are kept. If this is a " +
        "separate exchange with the same terms, add the backup as a new " +
        "exchange.",
    );
    const older = liveCopyImportReason([
      {
        id: "a",
        label: "Riverbend",
        state: "runs-here",
        order: "import-older",
      },
    ]);
    expect(older).toMatch(
      /This backup is older than the saved copy, so keep the saved copy\./,
    );
    for (const text of [newer, older]) {
      expect(text).not.toMatch(/If the exchange ran on another device/);
      expect(text).toMatch(/add the backup as a new exchange\.$/);
    }
  });

  test("one saved copy: the files state the order found and the matching way on", () => {
    const newer = storedCopyImportReason([
      { id: "a", label: "", state: "runs-here", order: "import-newer" },
    ]);
    const older = storedCopyImportReason([
      { id: "a", label: "", state: "runs-here", order: "import-older" },
    ]);
    expect(newer).toMatch(
      /These files are newer than the saved copy: replace the saved copy with them/,
    );
    expect(older).toMatch(
      /These files are older than the saved copy, so cancel to keep the saved copy\./,
    );
    for (const text of [newer, older]) {
      expect(text).not.toMatch(/If the exchange ran from these files/);
      expect(text).toMatch(/add these files as a new one\.$/);
    }
  });

  test("several saved copies: each order found is named, and a copy with none says nothing", () => {
    const copies = [
      {
        id: "a",
        label: "Riverbend",
        state: "runs-here",
        order: "import-newer",
      },
      { id: "b", label: "", state: "runs-here", order: "import-older" },
      { id: "c", label: "Weekly", state: "runs-here" },
    ] as const;
    const backup = liveCopyImportReason(copies);
    expect(backup).toContain('This backup is newer than "Riverbend".');
    expect(backup).toContain("This backup is older than listed exchange 2.");
    expect(backup).not.toMatch(/than "Weekly"/);
    expect(storedCopyImportReason(copies)).toContain(
      'These files are newer than "Riverbend".',
    );
  });
});

describe("what a pair import says about a stored exchange it may belong to", () => {
  test("names the one exchange, what it is, and each way on", () => {
    const reason = storedCopyImportReason([
      { id: "a", label: "Riverbend", state: "configuration-only" },
    ]);
    expect(reason).toContain('"Riverbend"');
    expect(reason).toMatch(/configuration without its key file/);
    expect(reason).toMatch(/Nothing was imported/);
    expect(reason).toMatch(/complete it with these files/);
    expect(reason).toMatch(/add these files as a new one/);
    expect(reason).not.toMatch(/stop its scheduled run/);
  });

  test("names several exchanges together", () => {
    const copies = [
      { id: "a", label: "Riverbend", state: "configuration-only" },
      { id: "b", label: "", state: "configuration-only" },
    ] as const;
    expect(storedCopyImportReason(copies)).toMatch(
      /2 exchanges in the list \("Riverbend", and 1 with no name\)/,
    );
    expect(storedCopyTakeLabel(copies, 0)).toBe('Complete "Riverbend"');
    expect(storedCopyTakeLabel(copies, 1)).toBe("Complete listed exchange 2");
  });

  test("each button says what it does to the exchange", () => {
    expect(
      storedCopyTakeLabel(
        [{ id: "a", label: "", state: "configuration-only" }],
        0,
      ),
    ).toBe("Complete it");
    expect(
      storedCopyTakeLabel(
        [{ id: "a", label: "Riverbend", state: "configuration-only" }],
        0,
      ),
    ).toBe('Complete "Riverbend"');
  });

  test("one that runs here is offered for replacing, with cancel to keep it", () => {
    const copies = [{ id: "a", label: "", state: "runs-here" }] as const;
    const reason = storedCopyImportReason(copies);
    expect(reason).toMatch(/^An exchange in the list runs in this browser/);
    expect(reason).toMatch(/replace the saved copy with them/);
    expect(reason).toMatch(
      /run history and accounting of disclosures are kept/,
    );
    expect(reason).toMatch(/cancel to keep the saved copy/);
    expect(reason).not.toMatch(/, keep the saved copy/);
    expect(reason).toMatch(/add these files as a new one/);
    expect(storedCopyTakeLabel(copies, 0)).toBe("Replace the saved copy");

    const mixed = [
      { id: "a", label: "Riverbend", state: "runs-here" },
      { id: "b", label: "", state: "configuration-only" },
      { id: "c", label: "", state: "runs-here" },
    ] as const;
    expect(storedCopyImportReason(mixed)).toMatch(/Replace one that runs here/);
    expect(storedCopyTakeLabel(mixed, 0)).toBe('Replace "Riverbend"');
    expect(storedCopyTakeLabel(mixed, 1)).toBe("Complete listed exchange 2");
    expect(storedCopyTakeLabel(mixed, 2)).toBe("Replace listed exchange 3");
  });

  test("a chosen exchange that could not take the import says what to do", () => {
    expect(chosenCopyImportReason("changed", "files")).toMatch(
      /changed since you chose it.*Import the files again/,
    );
    expect(chosenCopyImportReason("changed", "backup")).toMatch(
      /Import the backup again/,
    );
    expect(chosenCopyImportReason("run-in-flight", "backup")).toMatch(
      /running right now.*When the run finishes, import the backup again/,
    );
    expect(chosenCopyImportReason("run-in-flight", "files")).toMatch(
      /import the files again/,
    );
    expect(chosenCopyImportReason("changed", "files")).not.toMatch(
      /taken back/,
    );
  });
});
