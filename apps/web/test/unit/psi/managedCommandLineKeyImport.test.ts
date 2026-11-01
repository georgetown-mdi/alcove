import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  KEY_FILE_MIGRATIONS,
  KeyFileSchema,
  ROTATION_HISTORY_MAX_ENTRIES,
  generateSharedSecret,
  getDefaultLinkageTerms,
  serializeKeyFile,
  snakeizeKeys,
} from "@alcove/core";
import { keyFileSchemaFor } from "@alcove/core/testing";

import { stringify as stringifyYaml } from "yaml";

import {
  MAX_KEY_FILE_IMPORT_BYTES,
  ManagedConfigurationRefusedError,
  ManagedKeyFileRefusedError,
  readManagedCommandLineConfiguration,
  readManagedCommandLineKeyFile,
  readManagedCommandLineKeyFileFields,
  readManagedCommandLinePair,
} from "@psi/managed/managedCommandLineImport";
import {
  ManagedImportAlreadyHeldError,
  ManagedImportBackupNotConfigurationError,
  ManagedImportChosenCopyError,
  ManagedImportStoredCopyError,
  importManagedCommandLinePair,
  managedInstallFields,
} from "@psi/managed/managedExchangeImport";
import {
  applyManagedExchangeCommandLinePair,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedPairReconcileOutcome,
  ManagedReplaceOutcome,
} from "@psi/managed/managedExchangeStore";
import type { FormatMigrations } from "@alcove/core";
import type { ManagedPairImportDeps } from "@psi/managed/managedExchangeImport";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

// The key leg of the command-line import: an alcove.yaml read with the
// .alcove.key beside it installs a runnable record, the key file is validated
// on its own terms, a matching stored exchange is reconciled on the backup
// import's rule, and the secret appears on no surface -- no refusal, no log
// line, no request. The store-backed half (real IndexedDB) is the browser
// suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

/** The secret the chosen stored copy holds, which a replace writes over. */
const STORED_SECRET = generateSharedSecret();

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "acceptor",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The two files the app's own command-line export writes for a record. */
function exportedPair(
  overrides: Partial<NewManagedExchange> = {},
  readOwn?: () => OwnRelayRead,
): {
  record: RunnableManagedExchangeRecord;
  configuration: string;
  key: string;
} {
  const record = runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord(newExchange(overrides)),
  );
  const exported = composeManagedCronExport(record, readOwn);
  return {
    record,
    configuration: exported.config.text,
    key: exported.key.text,
  };
}

/** A `.alcove.key` as Alcove's own writer lays it out (`saveKeyFile`,
 * `apps/cli/src/keyFile.ts`): the pair, pretty-printed, and a newline. */
function commandLineKeyText(fields: object): string {
  return JSON.stringify(fields, null, 2) + "\n";
}

/** Everything an error exposes that a surface or a log line could show. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [
    error.name,
    error.message,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    String(error.cause ?? ""),
  ].join("\n");
}

/** The error `run` throws; fails the test if it throws none. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

/** The error `run` rejects with; fails the test if it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("reading a .alcove.key", () => {
  test("the file Alcove writes is read as the key pair", () => {
    const sharedSecret = generateSharedSecret();
    expect(
      readManagedCommandLineKeyFile(
        commandLineKeyText({
          sharedSecret,
          expires: "2026-12-31T00:00:00.000Z",
        }),
      ),
    ).toEqual({ sharedSecret, expires: "2026-12-31T00:00:00.000Z" });
    expect(
      readManagedCommandLineKeyFile(commandLineKeyText({ sharedSecret })),
    ).toEqual({ sharedSecret });
  });

  test("a relay key registration the registrar has not confirmed is read", () => {
    const sharedSecret = generateSharedSecret();
    expect(
      readManagedCommandLineKeyFile(
        commandLineKeyText({
          sharedSecret,
          relayRegistrationPendingSince: "2026-09-01T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      sharedSecret,
      relayRegistrationPendingSince: "2026-09-01T00:00:00.000Z",
    });
  });

  test("the key file the app's own export writes is read back", () => {
    const { record, key } = exportedPair({
      expires: "2026-12-31T00:00:00.000Z",
      tokenMaxAgeDays: 30,
    });
    expect(readManagedCommandLineKeyFile(key)).toEqual({
      sharedSecret: record.sharedSecret,
      expires: "2026-12-31T00:00:00.000Z",
    });
  });

  test("a field the key file schema does not know is refused as written by a newer Alcove, by name", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readManagedCommandLineKeyFile(
        commandLineKeyText({
          sharedSecret,
          expires: "2026-12-31T00:00:00.000Z",
          fieldFromALaterBuild: sharedSecret,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toBe(
      'The key file has the field "fieldFromALaterBuild", which this version ' +
        "of Alcove does not read: it was made by a newer version of Alcove. " +
        "Use the version of Alcove that wrote the key file, or a newer one. " +
        "Nothing was imported.",
    );
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a key file stating a newer version is refused naming the version", () => {
    const error = thrownBy(() =>
      readManagedCommandLineKeyFile(
        commandLineKeyText({
          version: 2,
          sharedSecret: generateSharedSecret(),
        }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toMatch(
      /^The key file is format version 2, made by a newer version of Alcove/,
    );
  });

  test("a configuration stating its format version and notes imports, and the export holds both", () => {
    const { configuration, key } = exportedPair();
    expect(configuration.startsWith("format_version: 1\n")).toBe(true);
    const about = "about:\n  label: Quarterly match\n  from_a_later_build: 1\n";
    const imported = readManagedCommandLinePair(
      `${about}${configuration}`,
      key,
    );
    expect(imported.exchangeFile.formatVersion).toBe(1);
    const reexported = composeManagedCronExport(imported).config.text;
    expect(reexported.startsWith("format_version: 1\n")).toBe(true);
    expect(reexported).toContain(about);
  });

  test("a configuration leaving out its format version imports, and the export states it", () => {
    const { configuration, key } = exportedPair();
    const imported = readManagedCommandLinePair(
      configuration.replace(/^format_version: 1\n/, ""),
      key,
    );
    expect(imported.exchangeFile.formatVersion).toBeUndefined();
    expect(composeManagedCronExport(imported).config.text).toBe(configuration);
  });

  test("a key file exported here imports again and re-exports byte for byte", () => {
    const { record, configuration, key } = exportedPair({
      expires: "2026-12-31T00:00:00.000Z",
    });
    const imported = readManagedCommandLinePair(configuration, key);
    expect(imported.sharedSecret).toBe(record.sharedSecret);
    const reexported = composeManagedCronExport(imported).key.text;
    expect(reexported).toBe(key);
    expect(KeyFileSchema.parse(JSON.parse(reexported))).toEqual({
      sharedSecret: record.sharedSecret,
      expires: "2026-12-31T00:00:00.000Z",
    });
  });

  // Each refusal names what is wrong in fixed words. The near-miss secret in
  // each file is the value a message must not echo.
  const nearMiss = generateSharedSecret().slice(0, 42);
  const cases: Array<[string, string, string]> = [
    [
      "bytes that are not JSON",
      `{"sharedSecret": "${nearMiss}"`,
      "not a JSON file",
    ],
    [
      "a JSON list",
      JSON.stringify([nearMiss]),
      "does not hold the sharedSecret",
    ],
    [
      "a bare JSON string",
      JSON.stringify(nearMiss),
      "does not hold the sharedSecret",
    ],
    [
      "no sharedSecret",
      commandLineKeyText({ expires: "2026-12-31T00:00:00.000Z" }),
      "it has no sharedSecret",
    ],
    [
      "a secret Alcove would not write",
      commandLineKeyText({ sharedSecret: nearMiss }),
      "its sharedSecret is not an Alcove shared secret",
    ],
    [
      "a secret that is not a string",
      JSON.stringify({ sharedSecret: 42 }),
      "its sharedSecret is not an Alcove shared secret",
    ],
    [
      "an expires that is not a date and time",
      commandLineKeyText({
        sharedSecret: generateSharedSecret(),
        expires: nearMiss,
      }),
      "its expires is not a date and time",
    ],
    [
      "a pending relay registration that is not a date and time",
      commandLineKeyText({
        sharedSecret: generateSharedSecret(),
        relayRegistrationPendingSince: nearMiss,
      }),
      "its relayRegistrationPendingSince is not a date and time",
    ],
    [
      "a file over the cap",
      " ".repeat(10_001) + nearMiss,
      "larger than a key file",
    ],
  ];

  test.each(cases)(
    "%s is refused by name, echoing nothing",
    (_, source, named) => {
      const error = thrownBy(() => readManagedCommandLineKeyFile(source));
      expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
      expect((error as Error).message).toContain(named);
      expect((error as Error).message).toContain("Nothing was imported");
      expect(errorText(error)).not.toContain(nearMiss);
    },
  );

  test("a valid secret beside a bad field is still never echoed", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readManagedCommandLineKeyFile(
        commandLineKeyText({ sharedSecret, expires: "tomorrow" }),
      ),
    );
    expect((error as Error).message).toContain("its expires is not");
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a rotationInFlightSince that is not a date and time is named, not the whole shape", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readManagedCommandLineKeyFile(
        commandLineKeyText({ sharedSecret, rotationInFlightSince: "soon" }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toContain(
      "its rotationInFlightSince is not a date and time",
    );
    expect((error as Error).message).not.toContain(
      "does not hold the sharedSecret",
    );
    expect(errorText(error)).not.toContain(sharedSecret);
  });
});

describe("reading a .alcove.key of an earlier version", () => {
  const FAILURE_REMEDY =
    "Use the version of Alcove that wrote the key file, or report the " +
    "failure to the Alcove maintainers.";

  function readUnder(table: FormatMigrations<number>, fields: object) {
    return readManagedCommandLineKeyFileFields(
      commandLineKeyText(fields),
      keyFileSchemaFor(table),
    );
  }

  test("a migration that throws is refused naming the version, the current version and the cause, never a value", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readUnder(
        {
          ...KEY_FILE_MIGRATIONS,
          current: 3,
          steps: [
            {
              from: 2,
              to: 3,
              migrate: () => {
                throw new Error("expiresAt is not an instant");
              },
            },
          ],
        },
        { version: 2, sharedSecret },
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toBe(
      "The key file is format version 2, and this version of Alcove could " +
        "not move it to version 3: expiresAt is not an instant. The file " +
        `was not changed. ${FAILURE_REMEDY} Nothing was imported.`,
    );
    expect((error as Error).message).not.toContain("does not hold");
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a version no chain of steps leads from is refused naming the version and the current version", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readUnder(
        {
          ...KEY_FILE_MIGRATIONS,
          current: 3,
          steps: [{ from: 2, to: 3, migrate: (document) => document }],
        },
        { version: 1, sharedSecret },
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toBe(
      "The key file is format version 1, and this version of Alcove could " +
        "not move it to version 3: it has no migration from version 1. The " +
        `file was not changed. ${FAILURE_REMEDY} Nothing was imported.`,
    );
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a field a migration renames is not named as unread", () => {
    const sharedSecret = generateSharedSecret();
    const table: FormatMigrations<number> = {
      ...KEY_FILE_MIGRATIONS,
      current: 2,
      steps: [
        {
          from: 1,
          to: 2,
          migrate: ({ expiresAt, ...rest }) => ({
            ...rest,
            expires: expiresAt,
          }),
        },
      ],
    };
    const read = readUnder(table, {
      version: 1,
      sharedSecret,
      expiresAt: "2026-12-31T00:00:00.000Z",
    });
    expect(read.fields).toEqual({
      sharedSecret,
      expires: "2026-12-31T00:00:00.000Z",
    });
    expect(read.unreadFieldNames).toEqual([]);
  });

  test("a field the migrated key file holds and the import drops is still named, never a value", () => {
    const sharedSecret = generateSharedSecret();
    const previous = generateSharedSecret();
    const table: FormatMigrations<number> = {
      ...KEY_FILE_MIGRATIONS,
      current: 2,
      steps: [
        {
          from: 1,
          to: 2,
          migrate: ({ oldSecret, ...rest }) => ({
            ...rest,
            previousSharedSecret: oldSecret,
          }),
        },
      ],
    };
    const read = readUnder(table, {
      version: 1,
      sharedSecret,
      oldSecret: previous,
    });
    expect(read.unreadFieldNames).toEqual(["previousSharedSecret"]);
    expect(JSON.stringify(read.unreadFieldNames)).not.toContain(previous);
  });
});

describe("reading a configuration with its key file", () => {
  test("the pair builds a runnable record holding the key file's secret", () => {
    const { record, configuration, key } = exportedPair({
      expires: "2026-12-31T00:00:00.000Z",
      tokenMaxAgeDays: 30,
    });
    const imported = readManagedCommandLinePair(configuration, key);
    expect(runnableManagedExchange(imported)).toBe(true);
    expect(imported.sharedSecret).toBe(record.sharedSecret);
    expect(imported.expires).toBe("2026-12-31T00:00:00.000Z");
    expect(imported.tokenMaxAgeDays).toBe(30);
    expect(imported.side).toBe("acceptor");
    expect(imported.exchangeFile).toEqual({
      formatVersion: 1,
      ...record.exchangeFile,
    });
    expect(imported.id).not.toBe(record.id);
    // The secret lands in the record's own secret field and nowhere else in it.
    const { sharedSecret: _secret, ...rest } = imported;
    expect(JSON.stringify(rest)).not.toContain(record.sharedSecret);
  });

  test("a pending relay registration in the key file is carried onto the record", () => {
    const { record, configuration } = exportedPair();
    const imported = readManagedCommandLinePair(
      configuration,
      commandLineKeyText({
        sharedSecret: record.sharedSecret,
        relayRegistrationPendingSince: "2026-09-01T00:00:00.000Z",
      }),
    );
    expect(imported.relayRegistrationPendingSince).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(imported.relayRegistrar).toBeUndefined();
    expect(imported.sharedSecret).toBe(record.sharedSecret);
  });

  test("the configuration alone still builds an editable record that does not run", () => {
    const { configuration } = exportedPair();
    const imported = readManagedCommandLineConfiguration(configuration);
    expect(runnableManagedExchange(imported)).toBe(false);
    expect(imported.sharedSecret).toBeUndefined();
  });

  test("a refused key file refuses the pair, with no secret in the refusal", () => {
    const { configuration, record } = exportedPair();
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({
          sharedSecret: record.sharedSecret,
          expires: "soon",
        }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(errorText(error)).not.toContain(record.sharedSecret);
  });

  test("a refused configuration refuses the pair, with no secret in the refusal", () => {
    const sharedSecret = generateSharedSecret();
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...newExchange().exchangeFile,
        connection: { channel: "webrtc", server: { host: "x.example.org" } },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a configuration on a channel this app does not run is refused with its key file", () => {
    const sharedSecret = generateSharedSecret();
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...newExchange().exchangeFile,
        connection: {
          channel: "filedrop",
          path: "/srv/exchange",
        },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toContain("runs over filedrop");
    expect((error as Error).message).toContain("on its own");
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a configuration with a signing block is refused with its key file", () => {
    const sharedSecret = generateSharedSecret();
    const document = newExchange().exchangeFile;
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...document,
        connection: { ...document.connection, role: "inviter" },
        signing: {
          mode: "certificate",
          identityFile: "./identity.json",
          partnerFingerprint: "0123456789012345678901234567890123456789abA",
        },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toContain("holds signing");
    expect(errorText(error)).not.toContain(sharedSecret);
  });
});

describe("laying a pair over the stored record it completes", () => {
  /** A configuration-only record of `newExchange`'s exchange: the only kind a
   * pair completes. */
  function configurationOnly(
    overrides: Partial<NewManagedExchange> = {},
  ): ManagedExchangeRecord {
    const record = buildManagedExchangeRecord(
      newExchange({ ...overrides, sharedSecret: undefined }),
    );
    expect(runnableManagedExchange(record)).toBe(false);
    return record;
  }

  test("the pair's fields complete the record; its id, label, and standing condition stay", () => {
    const stored = configurationOnly({
      label: "Riverbend quarterly",
      tokenMaxAgeDays: 14,
      standingCondition: {
        kind: "auth",
        since: "2026-07-01T00:00:00.000Z",
      },
    });
    const imported = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({ label: "", expires: "2026-10-01T00:00:00.000Z" }),
      ),
    );
    const completed = applyManagedExchangeCommandLinePair(stored, imported);
    expect(completed.id).toBe(stored.id);
    expect(completed.label).toBe("Riverbend quarterly");
    expect(completed.standingCondition).toEqual(stored.standingCondition);
    expect(completed.sharedSecret).toBe(imported.sharedSecret);
    expect(completed.expires).toBe("2026-10-01T00:00:00.000Z");
    expect(completed.tokenMaxAgeDays).toBeUndefined();
    expect(completed.side).toBe(imported.side);
    expect(completed.exchangeFile).toEqual(imported.exchangeFile);
  });

  const REGISTRAR = {
    url: "https://relay.example.org:8443",
    exchangeId: "riverbend-q3",
  };

  test("the pair's relay registrar and pending registration land on the record, or none", () => {
    const stored = configurationOnly();
    const pair = (fields: Partial<NewManagedExchange>) =>
      runnableManagedExchangeOrRefuse(
        buildManagedExchangeRecord(newExchange({ label: "", ...fields })),
      );

    const pending = applyManagedExchangeCommandLinePair(
      stored,
      pair({
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingSince: "2026-09-01T00:00:00.000Z",
      }),
    );
    expect(pending.relayRegistrar).toEqual(REGISTRAR);
    expect(pending.relayRegistrationPendingSince).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(pending).not.toHaveProperty("relayRegistrationPendingReason");

    const confirmed = applyManagedExchangeCommandLinePair(
      stored,
      pair({ relayRegistrar: REGISTRAR }),
    );
    expect(confirmed.relayRegistrar).toEqual(REGISTRAR);
    expect(confirmed).not.toHaveProperty("relayRegistrationPendingSince");

    const none = applyManagedExchangeCommandLinePair(stored, pair({}));
    expect(none).not.toHaveProperty("relayRegistrar");
    expect(none).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("a record holding a secret is refused: completing takes a configuration only", () => {
    const stored = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const imported = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange({ label: "" })),
    );
    expect(() =>
      applyManagedExchangeCommandLinePair(stored, imported),
    ).toThrow();
  });
});

/** Injected boundaries for the pair import, recording what it wrote. */
function recordingDeps(
  reconciled: ManagedPairReconcileOutcome = { kind: "no-match" },
  replaced: ManagedReplaceOutcome = { kind: "changed" },
): ManagedPairImportDeps & {
  installed: Array<ManagedExchangeRecord>;
  reconcile: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  markImported: ReturnType<typeof vi.fn>;
} {
  const installed: Array<ManagedExchangeRecord> = [];
  return {
    installed,
    reconcile: vi.fn(() => Promise.resolve(reconciled)),
    replace: vi.fn(() => Promise.resolve(replaced)),
    install: (record) => {
      installed.push(record);
      return Promise.resolve(record);
    },
    markImported: vi.fn(() => Promise.resolve()),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("importing a configuration with its key file", () => {
  test("with no match, installs the runnable record and marks it imported", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps();
    const { record: installed, missingGrants } =
      await importManagedCommandLinePair(configuration, key, deps);
    expect(deps.reconcile).toHaveBeenCalledOnce();
    expect(deps.installed).toEqual([installed]);
    expect(installed.sharedSecret).toBe(record.sharedSecret);
    expect(runnableManagedExchange(installed)).toBe(true);
    expect(missingGrants).toEqual([]);
    expect(deps.markImported).toHaveBeenCalledWith(
      installed.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("a stored exchange holding the secret refuses, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps({ kind: "held", label: "Riverbend" });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportAlreadyHeldError);
    expect((error as ManagedImportAlreadyHeldError).label).toBe("Riverbend");
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a stored exchange with its terms and side is offered, and nothing is written", async () => {
    const { configuration, key, record } = exportedPair();
    const copies = [
      { id: "stored", label: "Riverbend", state: "configuration-only" },
    ] as const;
    const deps = recordingDeps({ kind: "stored-copy", copies });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportStoredCopyError);
    expect((error as ManagedImportStoredCopyError).copies).toEqual(copies);
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("the operator's answer reaches the reconciliation", async () => {
    const { configuration, key } = exportedPair();
    const at = "2026-07-14T12:00:00.000Z";
    for (const answer of [{ into: "stored" }, { besideIds: ["stored"] }]) {
      const deps = recordingDeps();
      await importManagedCommandLinePair(configuration, key, deps, answer);
      expect(deps.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ side: "acceptor" }),
        at,
        answer,
      );
    }
  });

  test("a chosen configuration-only exchange is completed in place, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps({ kind: "completed", record });
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
      { into: record.id },
    );
    expect(result.record).toBe(record);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a chosen exchange that changed since is refused, writing nothing", async () => {
    const { configuration, key } = exportedPair();
    const deps = recordingDeps({ kind: "chosen-copy-changed" });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps, { into: "gone" }),
    );
    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect(deps.installed).toHaveLength(0);
  });

  test("a chosen exchange that runs here is replaced in place over the secret it holds, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps(
      { kind: "replace", id: record.id, sharedSecret: STORED_SECRET },
      { kind: "replaced", record },
    );
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
      { into: record.id },
    );
    expect(deps.replace).toHaveBeenCalledWith(
      record.id,
      STORED_SECRET,
      "2026-07-14T12:00:00.000Z",
      expect.objectContaining({ sharedSecret: record.sharedSecret }),
      "command-line",
    );
    expect(result.record).toBe(record);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a replace a run holds off is refused as a run in progress", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps(
      { kind: "replace", id: record.id, sharedSecret: STORED_SECRET },
      { kind: "run-in-flight" },
    );
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps, {
        into: record.id,
      }),
    );
    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect((error as ManagedImportChosenCopyError).reason).toBe(
      "run-in-flight",
    );
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toHaveLength(0);
  });

  test("a malformed key file reaches no store step", async () => {
    const { configuration } = exportedPair();
    const deps = recordingDeps();
    await expect(
      importManagedCommandLinePair(configuration, "{not json", deps),
    ).rejects.toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.installed).toHaveLength(0);
  });

  test("the app's backup file given as the configuration is refused as one", async () => {
    const { record, key } = exportedPair();
    const backup = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const deps = recordingDeps();
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(backup, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportBackupNotConfigurationError);
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  test("a failed import marker still reports the durable install", async () => {
    const { configuration, key } = exportedPair();
    const deps = recordingDeps();
    deps.markImported.mockImplementation(() =>
      Promise.reject(new Error("marker write failed")),
    );
    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
    );
    expect(deps.installed).toEqual([record]);
  });
});

describe("the secret reaches no log line and no request", () => {
  const consoleMethods = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
  ] as const;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleSpies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Every argument any console method was called with, as text. */
  function everythingLogged(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((call: Array<unknown>) =>
        call.map((argument) => errorText(argument)).join(" "),
      )
      .join("\n");
  }

  test("an accepted pair, and every refusal of one, logs and sends nothing holding it", async () => {
    const { configuration, key, record } = exportedPair();
    await importManagedCommandLinePair(configuration, key, recordingDeps());
    await rejectionOf(() =>
      importManagedCommandLinePair(
        configuration,
        key,
        recordingDeps({ kind: "held", label: "" }),
      ),
    );
    await rejectionOf(() =>
      importManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret: record.sharedSecret, expires: 1 }),
        recordingDeps(),
      ),
    );
    await rejectionOf(() =>
      importManagedCommandLinePair("connection: [", key, recordingDeps()),
    );
    expect(everythingLogged()).not.toContain(record.sharedSecret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the relay key registration across the command-line files", () => {
  const REGISTRAR = {
    url: "https://relay.example.org:8443",
    exchangeId: "riverbend-q3",
  };
  const PENDING_SINCE = "2026-09-29T12:00:00.000Z";
  const OWN_TURN = "turns:relay.example.org:443?transport=tcp";
  const ownRelay = (): OwnRelayRead => ({
    kind: "set",
    relay: { turn: [OWN_TURN], stun: [] },
  });

  test.each([
    ["no pending registration", {}],
    [
      "a pending registration",
      { relayRegistrationPendingSince: PENDING_SINCE },
    ],
  ])(
    "an exported pair with %s reads back with its registrar and marker",
    (_case, pending) => {
      const { record, configuration, key } = exportedPair(
        { relayRegistrar: REGISTRAR, ...pending },
        ownRelay,
      );
      const imported = readManagedCommandLinePair(configuration, key);
      expect(imported.relayRegistrar).toEqual(REGISTRAR);
      expect(imported.relayRegistrationPendingSince).toBe(
        record.relayRegistrationPendingSince,
      );
      expect(imported).not.toHaveProperty("relayRegistrationPendingReason");
      // The registrar and the minted TURN entries beside it leave the stored
      // document, so a re-export writes the same file.
      expect(imported.exchangeFile).toEqual({
        formatVersion: 1,
        ...record.exchangeFile,
      });
      expect(composeManagedCronExport(imported, ownRelay).config.text).toBe(
        configuration,
      );
    },
  );

  test("a fresh install of an imported pair keeps its registrar and marker", async () => {
    const { configuration, key } = exportedPair(
      {
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingSince: PENDING_SINCE,
      },
      ownRelay,
    );
    const deps = recordingDeps();
    deps.install = (record) =>
      Promise.resolve(buildManagedExchangeRecord(managedInstallFields(record)));
    const { record: installed } = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
    );
    expect(installed.relayRegistrar).toEqual(REGISTRAR);
    expect(installed.relayRegistrationPendingSince).toBe(PENDING_SINCE);
  });

  test("a pair import returns the TURN urls its configuration names beside the registrar", async () => {
    const { configuration, key } = exportedPair(
      { relayRegistrar: REGISTRAR },
      ownRelay,
    );
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      recordingDeps(),
    );
    expect(result.droppedTurnUrls).toEqual([OWN_TURN]);
  });

  test("a pair import naming no registrar returns no dropped TURN url", async () => {
    const { configuration, key } = exportedPair();
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      recordingDeps(),
    );
    expect(result).not.toHaveProperty("droppedTurnUrls");
  });

  test("a pair import whose key file misspells expires is refused naming the fields, never a value, and stores nothing", async () => {
    const { record, configuration } = exportedPair();
    const misspelledBound = "2026-12-31T00:00:00.000Z";
    const deps = recordingDeps();
    const error = await importManagedCommandLinePair(
      configuration,
      commandLineKeyText({
        sharedSecret: record.sharedSecret,
        expiry: misspelledBound,
        expire: record.sharedSecret,
      }),
      deps,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect((error as Error).message).toContain(
      'has the fields "expiry", "expire"',
    );
    expect(errorText(error)).not.toContain(misspelledBound);
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toEqual([]);
  });

  test("a pair import whose key file holds a previous secret lands without it and names it, never a value, and keeps the rotation history", async () => {
    const { record, configuration } = exportedPair();
    const previous = generateSharedSecret();
    const rotationHistory = [
      { verifier: generateSharedSecret(), expires: "2026-12-31T00:00:00.000Z" },
      { verifier: generateSharedSecret() },
    ];
    const result = await importManagedCommandLinePair(
      configuration,
      commandLineKeyText({
        sharedSecret: record.sharedSecret,
        previousSharedSecret: previous,
        previousExpires: "2026-12-31T00:00:00.000Z",
        rotationHistory,
      }),
      recordingDeps(),
    );
    expect(result.record.sharedSecret).toBe(record.sharedSecret);
    expect(result.record).not.toHaveProperty("previousSharedSecret");
    expect(result.record).not.toHaveProperty("previousExpires");
    expect(result.record.rotationHistory).toEqual(rotationHistory);
    expect(result.unreadKeyFileFields).toEqual([
      "previousSharedSecret",
      "previousExpires",
    ]);
    expect(JSON.stringify(result.unreadKeyFileFields)).not.toContain(previous);
  });

  test("a pair import keeps the newest entries of a rotation history longer than the record holds", async () => {
    const { record, configuration } = exportedPair();
    const rotationHistory = Array.from(
      { length: ROTATION_HISTORY_MAX_ENTRIES + 3 },
      () => ({ verifier: generateSharedSecret() }),
    );
    const result = await importManagedCommandLinePair(
      configuration,
      commandLineKeyText({
        sharedSecret: record.sharedSecret,
        rotationHistory,
      }),
      recordingDeps(),
    );
    expect(result.record.rotationHistory).toEqual(
      rotationHistory.slice(0, ROTATION_HISTORY_MAX_ENTRIES),
    );
  });

  test("a key file holding the longest history and every field, as the command line writes it, is under the import cap", () => {
    const entry = {
      verifier: generateSharedSecret(),
      expires: "2026-12-31T00:00:00.000Z",
    };
    const text = serializeKeyFile({
      sharedSecret: generateSharedSecret(),
      expires: entry.expires,
      rotationInFlightSince: entry.expires,
      relayRegistrationPendingSince: entry.expires,
      previousSharedSecret: generateSharedSecret(),
      previousExpires: entry.expires,
      rotationHistory: Array.from(
        { length: ROTATION_HISTORY_MAX_ENTRIES },
        () => entry,
      ),
    });
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
      MAX_KEY_FILE_IMPORT_BYTES,
    );
    expect(readManagedCommandLineKeyFile(text).rotationHistory).toHaveLength(
      ROTATION_HISTORY_MAX_ENTRIES,
    );
  });

  test("the command-line export writes the rotation history and no previous secret, and the pair import reads the history back", async () => {
    const rotationHistory = [
      { verifier: generateSharedSecret(), expires: "2026-12-31T00:00:00.000Z" },
      { verifier: generateSharedSecret() },
    ];
    const { configuration, key } = exportedPair({ rotationHistory });
    const written = KeyFileSchema.parse(JSON.parse(key));
    expect(written.rotationHistory).toEqual(rotationHistory);
    expect(written).not.toHaveProperty("previousSharedSecret");
    expect(written).not.toHaveProperty("previousExpires");
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      recordingDeps(),
    );
    expect(result.record.rotationHistory).toEqual(rotationHistory);
    expect(result).not.toHaveProperty("unreadKeyFileFields");
  });

  test("a key file whose rotation history is not the list Alcove writes is refused, naming the field and never a value", async () => {
    const { record, configuration } = exportedPair();
    const notAVerifier = "not-a-verifier-but-a-value-to-keep-out";
    const refusal = await importManagedCommandLinePair(
      configuration,
      commandLineKeyText({
        sharedSecret: record.sharedSecret,
        rotationHistory: [{ verifier: notAVerifier }],
      }),
      recordingDeps(),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(errorText(refusal)).toContain(
      "its rotationHistory is not the list Alcove writes",
    );
    expect(errorText(refusal)).not.toContain(notAVerifier);
    expect(errorText(refusal)).not.toContain(record.sharedSecret);
  });

  test("a pair import whose key file holds only fields it reads names none", async () => {
    const { configuration, key } = exportedPair();
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      recordingDeps(),
    );
    expect(result).not.toHaveProperty("unreadKeyFileFields");
  });

  test("the configuration alone naming a registrar is refused, naming both ways past it", () => {
    const { configuration } = exportedPair(
      { relayRegistrar: REGISTRAR },
      ownRelay,
    );
    const error = thrownBy(() =>
      readManagedCommandLineConfiguration(configuration),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toBe(
      "This configuration registers its relay key at a relay registrar " +
        "(connection.relay_registrar), which this app does only for an " +
        "exchange it runs. Choose the .alcove.key beside it as well to run " +
        "the exchange here, or remove connection.relay_registrar and " +
        "connection.turn and import it again.",
    );
  });

  test("a TURN entry stating a credential beside the registrar is refused, naming turn", () => {
    const { configuration, key } = exportedPair(
      { relayRegistrar: REGISTRAR },
      ownRelay,
    );
    const credential = "turn-credential-not-in-any-message";
    const edited = configuration.replace(
      `  turn:\n    - url: ${OWN_TURN}\n`,
      `  turn:\n    - url: ${OWN_TURN}\n` +
        "    - url: turn:relay.example.org:3478\n" +
        "      username: operator\n" +
        `      credential: ${credential}\n`,
    );
    expect(edited).not.toBe(configuration);
    const error = thrownBy(() => readManagedCommandLinePair(edited, key));
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toContain(": turn.");
    expect(errorText(error)).not.toContain(credential);
  });
});
