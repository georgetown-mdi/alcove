import { describe, expect, test } from "vitest";

import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  mintExchangeSpec,
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import {
  applyManagedExchangeLocalEdits,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  managedAllowedRelays,
  parseManagedExchangeRecord,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  composeManagedCronExport,
  composeManagedCronExportConfig,
} from "@psi/managed/managedCronExport";
import { CSV_DELIMITER_OTHER } from "@components/csvDelimiterChoice";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";
import { readManagedCommandLineConfiguration } from "@psi/managed/managedCommandLineImport";

import {
  allowedRelaysError,
  allowedRelaysOffered,
  allowedRelaysRemovable,
  allowedRelaysShown,
  allowsNoRelay,
  commandLineRunListsRelay,
  csvDelimiterChoiceFrom,
  delimiterRecheckFrom,
  delimiterRecheckNote,
  localDocumentFieldEdits,
  localDocumentFieldValuesFrom,
  matchingKeyWithheld,
  ownColumnsOffered,
  removeAllowedRelaysValues,
} from "@recurring/localDocumentFieldsModel";
import { MATCHING_KEY_STORED_WITHHELD_COPY } from "@psi/matchingKeyModel";

import type {
  CSVRow,
  ExchangeSpec,
  LinkageTerms,
  MatchingKeyUnavailableReason,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type { LocalDocumentFieldValues } from "@recurring/localDocumentFieldsModel";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The stored exchange's editor for its document's five per-party settings:
// what each control starts on for an imported document, what a save writes,
// and that each edit reaches both the configuration the export hands back and
// the document the next run is prepared from.

const columns = ["client_id", "first_name", "last_name", "dob", "program_code"];
const metadata = inferMetadata(columns, []);
const linkageTerms = getDefaultLinkageTerms("County Health Dept", metadata);

const rows: Array<CSVRow> = [
  {
    client_id: "17",
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "12/10/1815",
    program_code: "A7",
  },
];

const note = "Filed with the program office for seven years.";

function storedDocument(overrides: Partial<ExchangeSpec> = {}): ExchangeSpec {
  return {
    ...composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
      metadata,
    }),
    ...overrides,
  };
}

/** A record a browser runs: it holds a secret. */
function runnableRecord(
  overrides: Partial<ExchangeSpec> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: storedDocument(overrides),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
}

/** Save the controls as the editor would, through the store's own transform. */
function save(
  record: ManagedExchangeRecord,
  edit: Partial<LocalDocumentFieldValues>,
): ManagedExchangeRecord {
  const values = {
    ...localDocumentFieldValuesFrom(record.exchangeFile),
    ...edit,
  };
  return applyManagedExchangeLocalEdits(
    record,
    localDocumentFieldEdits(record.exchangeFile, values),
  );
}

/** The document the command-line export writes for a record, read back. */
function exported(record: ManagedExchangeRecord): ExchangeSpec {
  return parseExchangeSpec(
    parseSensitiveYaml(
      composeManagedCronExport(runnableManagedExchangeOrRefuse(record)).config
        .text,
      "export",
    ),
  );
}

/** The record the store reads back, as a plain object through the schema. */
function readBack(record: ManagedExchangeRecord): ManagedExchangeRecord {
  return parseManagedExchangeRecord(
    JSON.parse(JSON.stringify(record)) as unknown,
  );
}

describe("an imported value pre-fills each control", () => {
  test("each control starts on the value the imported file states", () => {
    const imported = readManagedCommandLineConfiguration(
      stringifyYaml(
        snakeizeKeys({
          ...storedDocument({
            includeOwnColumns: "disclosed",
            includeMatchingKey: true,
            csvDelimiter: ";",
            retentionDisposition: note,
          }),
          connection: {
            ...storedDocument().connection,
            role: "acceptor",
            allowedRelays: ["relay.example.org", "backup.example.org:443"],
          },
        }),
      ),
    );

    expect(localDocumentFieldValuesFrom(imported.exchangeFile)).toEqual({
      ownColumns: "disclosed",
      matchingKey: true,
      delimiter: { option: ";", other: "" },
      retentionNote: note,
      allowedRelays: "relay.example.org\nbackup.example.org:443",
      removeAllowedRelays: false,
    });
  });

  test("a document stating none starts each control on what it reads as", () => {
    expect(localDocumentFieldValuesFrom(storedDocument())).toEqual({
      ownColumns: "none",
      matchingKey: false,
      delimiter: { option: ",", other: "" },
      retentionNote: "",
      allowedRelays: "",
      removeAllowedRelays: false,
    });
  });

  test.each([
    ["a named separator", "|", { option: "|", other: "" }],
    ["a tab", "\t", { option: "\t", other: "" }],
    ["detection", "detect", { option: "detect", other: "" }],
    ["any other character", ":", { option: CSV_DELIMITER_OTHER, other: ":" }],
  ] as const)("%s selects its own option", (_case, stored, choice) => {
    expect(csvDelimiterChoiceFrom(stored)).toEqual(choice);
  });

  test("a document read back with `tab` spelled out selects the tab option", () => {
    const record = readBack(runnableRecord({ csvDelimiter: "tab" }));

    expect(localDocumentFieldValuesFrom(record.exchangeFile).delimiter).toEqual(
      { option: "\t", other: "" },
    );
  });
});

describe("a save writes only what the operator changed", () => {
  test("an untouched editor writes nothing to the document", () => {
    const document = storedDocument({
      includeOwnColumns: "all",
      includeMatchingKey: true,
      csvDelimiter: "|",
      retentionDisposition: note,
    });

    expect(
      localDocumentFieldEdits(document, localDocumentFieldValuesFrom(document)),
    ).toEqual({});
  });

  test("a document with none of the four is left without them", () => {
    const record = runnableRecord();

    expect(save(record, {}).exchangeFile).toEqual(record.exchangeFile);
  });

  test("the own-columns choice is left alone where the terms write no result file", () => {
    const document = storedDocument({
      linkageTerms: {
        ...linkageTerms,
        output: { expectsOutput: false, shareWithPartner: true },
      },
    });

    expect(ownColumnsOffered(document)).toBe(false);
    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        ownColumns: "all",
      }),
    ).toEqual({});
  });

  test.each<{
    reason: MatchingKeyUnavailableReason;
    terms: Partial<LinkageTerms>;
  }>([
    {
      reason: "count-only",
      terms: {
        algorithm: "psi-c",
        linkageKeys: linkageTerms.linkageKeys.slice(0, 1),
        output: { expectsOutput: false, shareWithPartner: false },
      },
    },
    { reason: "single-pass", terms: { linkageStrategy: "single-pass" } },
    {
      reason: "no-output",
      terms: { output: { expectsOutput: false, shareWithPartner: true } },
    },
  ])(
    "the matched-key control is disabled with its reason, and left alone, on $reason terms",
    ({ reason, terms }) => {
      const document = storedDocument({
        linkageTerms: { ...linkageTerms, ...terms },
      });

      expect(matchingKeyWithheld(document)).toBe(reason);
      expect(MATCHING_KEY_STORED_WITHHELD_COPY[reason]).toMatch(
        /^Not available/,
      );
      expect(
        localDocumentFieldEdits(document, {
          ...localDocumentFieldValuesFrom(document),
          matchingKey: true,
        }),
      ).toEqual({});
    },
  );

  test("the matched-key control is offered on terms that give a key to name", () => {
    expect(matchingKeyWithheld(storedDocument())).toBeUndefined();
  });

  test("a refused separator writes nothing", () => {
    const document = storedDocument();

    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        delimiter: { option: CSV_DELIMITER_OTHER, other: '"' },
      }),
    ).toEqual({});
  });
});

describe("each edit reaches the export and the next run", () => {
  test("the own-columns choice", () => {
    const edited = readBack(save(runnableRecord(), { ownColumns: "all" }));

    expect(exported(edited).includeOwnColumns).toBe("all");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeOwnColumns,
    ).toBe("all");
  });

  test("clearing the own-columns choice drops it from both", () => {
    const edited = readBack(
      save(runnableRecord({ includeOwnColumns: "all" }), {
        ownColumns: "none",
      }),
    );

    expect(exported(edited)).not.toHaveProperty("includeOwnColumns");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeOwnColumns,
    ).toBeUndefined();
  });

  test("the matched-key choice, kept on reload", () => {
    const edited = readBack(save(runnableRecord(), { matchingKey: true }));

    expect(edited.exchangeFile.includeMatchingKey).toBe(true);
    expect(localDocumentFieldValuesFrom(edited.exchangeFile).matchingKey).toBe(
      true,
    );
    expect(exported(edited).includeMatchingKey).toBe(true);
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeMatchingKey,
    ).toBe(true);
  });

  test("clearing the matched-key choice drops it from both", () => {
    const edited = readBack(
      save(runnableRecord({ includeMatchingKey: true }), {
        matchingKey: false,
      }),
    );

    expect(localDocumentFieldValuesFrom(edited.exchangeFile).matchingKey).toBe(
      false,
    );
    expect(exported(edited)).not.toHaveProperty("includeMatchingKey");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeMatchingKey,
    ).toBeUndefined();
  });

  test("the separator", () => {
    const edited = readBack(
      save(runnableRecord(), { delimiter: { option: ";", other: "" } }),
    );

    // The run reads its input by the stored document's `csvDelimiter`
    // (`acquireValidatedManagedInput`), and writes its result with it.
    expect(edited.exchangeFile.csvDelimiter).toBe(";");
    expect(exported(edited).csvDelimiter).toBe(";");
  });

  test("a separator typed under Other", () => {
    const edited = readBack(
      save(runnableRecord({ csvDelimiter: "|" }), {
        delimiter: { option: CSV_DELIMITER_OTHER, other: "tab" },
      }),
    );

    expect(edited.exchangeFile.csvDelimiter).toBe("\t");
    expect(exported(edited).csvDelimiter).toBe("\t");
  });

  test("the retention note, trimmed", () => {
    const edited = readBack(
      save(runnableRecord(), { retentionNote: `  ${note}\n` }),
    );

    expect(exported(edited).retentionDisposition).toBe(note);
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .retentionDisposition,
    ).toBe(note);
  });

  test("an emptied retention note drops it from both", () => {
    const edited = readBack(
      save(runnableRecord({ retentionDisposition: note }), {
        retentionNote: "  ",
      }),
    );

    expect(exported(edited)).not.toHaveProperty("retentionDisposition");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .retentionDisposition,
    ).toBeUndefined();
  });

  test("an imported configuration exports back with all four edits and nothing else changed", () => {
    const source = stringifyYaml(
      snakeizeKeys({
        ...storedDocument({ csvDelimiter: "|" }),
        connection: { ...storedDocument().connection, role: "acceptor" },
      }),
    );
    const imported = readManagedCommandLineConfiguration(source);

    const edited = save(imported, {
      ownColumns: "disclosed",
      matchingKey: true,
      delimiter: { option: ";", other: "" },
      retentionNote: note,
    });

    expect(
      parseExchangeSpec(
        parseSensitiveYaml(
          composeManagedCronExportConfig(edited).config.text,
          "re-export",
        ),
      ),
    ).toEqual({
      formatVersion: 1,
      ...parseExchangeSpec(parseSensitiveYaml(source, "import")),
      includeOwnColumns: "disclosed",
      includeMatchingKey: true,
      csvDelimiter: ";",
      retentionDisposition: note,
    });
  });
});

describe("the allowed relays", () => {
  /** A stored document whose connection's allowed relays are `allowedRelays`. */
  function relaysDocument(allowedRelays?: ReadonlyArray<string>) {
    return composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
      metadata,
      ...(allowedRelays !== undefined ? { allowedRelays } : {}),
    });
  }

  function relaysRecord(allowedRelays?: ReadonlyArray<string>) {
    return buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: relaysDocument(allowedRelays),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
  }

  function connectionOf(record: ManagedExchangeRecord) {
    return record.exchangeFile.connection;
  }

  function assembleSftpDocument(): ExchangeSpec {
    return mintExchangeSpec({
      connection: {
        channel: "sftp",
        host: "sftp.example.org",
        path: "/exchange",
      },
      linkageTerms,
    });
  }

  test("an untouched field writes nothing, an empty list included", () => {
    for (const stored of [undefined, [], ["relay.example.org"]]) {
      const document = relaysDocument(stored);
      expect(
        localDocumentFieldEdits(
          document,
          localDocumentFieldValuesFrom(document),
        ),
      ).toEqual({});
    }
  });

  test("entered relays are set on the connection, reach the export, and read back", () => {
    const edited = readBack(
      save(relaysRecord(), {
        allowedRelays: "Relay.Example.org\n\nbackup.example.org:443\n",
      }),
    );

    expect(connectionOf(edited)).toMatchObject({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
    expect(exported(edited).connection).toMatchObject({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
    expect(
      localDocumentFieldValuesFrom(edited.exchangeFile).allowedRelays,
    ).toBe("relay.example.org\nbackup.example.org:443");
  });

  test("an emptied field clears them, so runs use every relay they list", () => {
    const edited = readBack(
      save(relaysRecord(["relay.example.org"]), { allowedRelays: "  \n" }),
    );

    expect(connectionOf(edited)).not.toHaveProperty("allowedRelays");
    expect(exported(edited).connection).not.toHaveProperty("allowedRelays");
  });

  test("the same entries written another way write nothing", () => {
    const document = relaysDocument(["relay.example.org"]);

    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        allowedRelays: "RELAY.example.org.\n",
      }),
    ).toEqual({});
  });

  test("an empty stored list is stated, kept by an empty field, and replaced by entered relays", () => {
    const document = relaysDocument([]);
    expect(allowsNoRelay(document)).toBe(true);
    expect(allowsNoRelay(relaysDocument())).toBe(false);
    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        allowedRelays: "\n",
      }),
    ).toEqual({});

    const edited = save(relaysRecord([]), {
      allowedRelays: "relay.example.org",
    });
    expect(connectionOf(edited)).toMatchObject({
      allowedRelays: ["relay.example.org"],
    });
  });

  test("the remove control is offered only where the document holds a list", () => {
    expect(allowedRelaysRemovable(relaysDocument([]))).toBe(true);
    expect(allowedRelaysRemovable(relaysDocument(["relay.example.org"]))).toBe(
      true,
    );
    expect(allowedRelaysRemovable(relaysDocument())).toBe(false);
    expect(allowedRelaysRemovable(assembleSftpDocument())).toBe(false);
  });

  test.each([
    ["an empty list", []],
    ["a list", ["relay.example.org"]],
  ] as const)(
    "removing %s drops it, so runs and the export use no restriction",
    (_case, stored) => {
      const record = relaysRecord(stored);
      const values = {
        ...localDocumentFieldValuesFrom(record.exchangeFile),
        ...removeAllowedRelaysValues(record.exchangeFile, true),
      };
      const edits = localDocumentFieldEdits(record.exchangeFile, values);
      expect(edits).toEqual({ allowedRelays: null });

      const edited = readBack(applyManagedExchangeLocalEdits(record, edits));
      expect(connectionOf(edited)).not.toHaveProperty("allowedRelays");
      expect(managedAllowedRelays(edited.exchangeFile)).toBeUndefined();
      expect(exported(edited).connection).not.toHaveProperty("allowedRelays");
      // The editor keeps its values over the record a save hands back, and
      // they write nothing further there.
      expect(localDocumentFieldEdits(edited.exchangeFile, values)).toEqual({});
    },
  );

  test("clearing the remove control restores the stored list and writes nothing", () => {
    const document = relaysDocument(["relay.example.org"]);
    expect(removeAllowedRelaysValues(document, true)).toEqual({
      allowedRelays: "",
      removeAllowedRelays: true,
    });
    const values = {
      ...localDocumentFieldValuesFrom(document),
      ...removeAllowedRelaysValues(document, false),
    };
    expect(values.allowedRelays).toBe("relay.example.org");
    expect(localDocumentFieldEdits(document, values)).toEqual({});
  });

  test("a refused entry is named by its line and writes nothing", () => {
    const document = relaysDocument();
    const text = "relay.example.org\nturns:relay.example.org:443";

    expect(allowedRelaysError(text)).toMatch(/^Line 2: /);
    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        allowedRelays: text,
      }),
    ).toEqual({});
  });

  test("only core's entry rule bounds them: no count or length cap", () => {
    const many = Array.from(
      { length: 12 },
      (_unused, index) => `relay-${index}.example.org`,
    );
    const long = `${"a".repeat(1100)}.example.org`;
    const text = [...many, long].join("\n");

    expect(allowedRelaysError(text)).toBeUndefined();
    const edited = readBack(save(relaysRecord(), { allowedRelays: text }));
    expect(connectionOf(edited)).toMatchObject({
      allowedRelays: [...many, long],
    });
  });

  test("are shown where the document holds a list, the field holds text or was edited, or the runs list a relay", () => {
    const unset = relaysDocument();
    const untouched = { text: "", edited: false };
    const typed = { text: "relay.example.org", edited: true };

    expect(allowedRelaysShown(unset, untouched, false)).toBe(false);
    expect(allowedRelaysShown(unset, untouched, true)).toBe(true);
    expect(allowedRelaysShown(unset, typed, false)).toBe(true);
    expect(allowedRelaysShown(unset, { text: "", edited: true }, false)).toBe(
      true,
    );
    expect(allowedRelaysShown(relaysDocument([]), untouched, false)).toBe(true);
    expect(
      allowedRelaysShown(
        relaysDocument(["relay.example.org"]),
        untouched,
        false,
      ),
    ).toBe(true);
    expect(allowedRelaysShown(assembleSftpDocument(), typed, true)).toBe(false);
  });

  test("a command-line run lists a relay where its connection or its invitation relay names a TURN or WebSocket relay url", () => {
    const withConnection = (
      fields: Partial<WebRTCConnectionConfig>,
    ): ExchangeSpec => {
      const document = relaysDocument();
      const connection = document.connection as WebRTCConnectionConfig;
      return { ...document, connection: { ...connection, ...fields } };
    };

    expect(commandLineRunListsRelay(relaysDocument())).toBe(false);
    expect(
      commandLineRunListsRelay(
        withConnection({ turn: [{ url: "turn:relay.example.org" }] }),
      ),
    ).toBe(true);
    expect(
      commandLineRunListsRelay(
        withConnection({ websocketRelay: "wss://relay.example.org/relay" }),
      ),
    ).toBe(true);
    expect(
      commandLineRunListsRelay(
        withConnection({
          invitationRelay: { turn: ["turn:partner.example.net"] },
        }),
      ),
    ).toBe(true);
    expect(
      commandLineRunListsRelay(
        withConnection({
          stun: ["stun:stun.example.org"],
          invitationRelay: { stun: ["stun:partner.example.net"] },
        }),
      ),
    ).toBe(false);
    // A list that leaves every url out still has urls to leave out.
    expect(
      commandLineRunListsRelay(
        withConnection({
          turn: [{ url: "turn:relay.example.org" }],
          allowedRelays: [],
        }),
      ),
    ).toBe(true);
    expect(commandLineRunListsRelay(assembleSftpDocument())).toBe(false);
  });

  test("a connection on another channel is not offered them, and a save leaves it alone", () => {
    const sftp = assembleSftpDocument();

    expect(allowedRelaysOffered(sftp)).toBe(false);
    expect(allowedRelaysOffered(relaysDocument())).toBe(true);
    expect(
      localDocumentFieldEdits(sftp, {
        ...localDocumentFieldValuesFrom(sftp),
        allowedRelays: "relay.example.org",
      }),
    ).toEqual({});
  });
});

describe("re-reading the input file under a changed separator", () => {
  test("a file whose columns cover every agreed key fits", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), columns);

    expect(recheck).toEqual({ kind: "fits", columnCount: columns.length });
    expect(delimiterRecheckNote(recheck)?.tone).toBe("ok");
  });

  test("a file read as one column states the separator remedy", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), [columns.join(";")]);

    expect(recheck).toEqual({ kind: "short", singleColumn: true });
    expect(delimiterRecheckNote(recheck)?.message).toContain("single column");
  });

  test("a file short of an agreed key is named as such", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), [
      "client_id",
      "program_code",
    ]);

    expect(recheck).toEqual({ kind: "short", singleColumn: false });
    expect(delimiterRecheckNote(recheck)?.message).toContain(
      "every agreed key",
    );
  });
});
