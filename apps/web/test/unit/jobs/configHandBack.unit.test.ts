import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  getDefaultLinkageTerms,
  serializeExchangeDocument,
  snakeizeKeys,
} from "@alcove/core";

import {
  ConfigurationHandBackRefusedError,
  handBackMountedConfiguration,
} from "@jobs/configHandBack";
import {
  ConfigurationLoadRefusedError,
  mountedConfigurationDocument,
  readMountedConfiguration,
} from "@jobs/configLoad";
import {
  PREVIOUS_CONFIGURATION_FILE_NAME,
  jobConfigurationHandBackSchema,
} from "@jobs/intentSchemas";
import { HANDOFF_SIGNING_IDENTITY_PLACEHOLDER } from "@jobs/handoff";
import { trackScratchDirs } from "../../utils/jobFixtures";

import type { ExchangeSpec } from "@alcove/core";
import type { JobConfigurationHandBack } from "@jobs/intentSchemas";

// The hand-back of a webrtc configuration the console opened: the settings the
// authoring steps edit are written into the mounted alcove.yaml, and every
// other key the file stated -- its whole connection, credentials included --
// is written back as it was. Driven through the real mount read, core's
// schema, and core's writer.

/** A signing partner fingerprint of the canonical base64url shape. */
const PARTNER_FINGERPRINT = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";

/** Obviously fake credential values, written inline so a byte comparison of
 * the handed-back file can find each one. */
const BROKER_KEY = "fake-broker-key-for-tests";
const TURN_CREDENTIAL = "fake-turn-credential-for-tests";
const PROVIDER_OPTION_PATH = "@/run/secrets/fake-provider-option";

/** A webrtc document of the shape the web application writes, its broker key,
 * TURN credential, and a provider option among the connection settings. */
function webrtcDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connection: {
      channel: "webrtc",
      role: "inviter",
      server: {
        host: "broker.example",
        port: 443,
        path: "/peers",
        key: BROKER_KEY,
        secure: true,
      },
      turn: [
        {
          url: "turn:turn.example.org:3478",
          username: "county",
          credential: TURN_CREDENTIAL,
        },
      ],
      ice_transport_policy: "relay",
      options: { peer_timeout_ms: 600_000 },
      provider_options: { debug_level: 0, config_file: PROVIDER_OPTION_PATH },
    },
    linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
    csv_delimiter: "|",
    include_own_columns: "all",
    expected_partner_deduplicate: false,
    retention_disposition: "Filed with the 2026 intake.",
    signing: {
      mode: "certificate",
      identity_file: "/home/county/.alcove/identity.json",
      partner_fingerprint: PARTNER_FINGERPRINT,
    },
    authentication: { token_max_age_days: 30 },
    ...overrides,
  };
}

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  removeScratchDirs();
});

function mountHolding(document: Record<string, unknown>): string {
  const dir = scratchDir("handback");
  fs.writeFileSync(path.join(dir, "alcove.yaml"), stringifyYaml(document), {
    mode: 0o640,
  });
  return dir;
}

function mountedText(dir: string): string {
  return fs.readFileSync(path.join(dir, "alcove.yaml"), "utf8");
}

function previousText(dir: string): string {
  return fs.readFileSync(
    path.join(dir, PREVIOUS_CONFIGURATION_FILE_NAME),
    "utf8",
  );
}

/** The hand-back of a document's own values: what the steps hold when the
 * operator changed nothing. Parsed through the route's own schema, so the
 * fixture is one the route admits. */
function unchangedHandBack(document: ExchangeSpec): JobConfigurationHandBack {
  return jobConfigurationHandBackSchema.parse({
    linkageTerms: document.linkageTerms,
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
    ...(document.standardization !== undefined
      ? { standardization: document.standardization }
      : {}),
    ...(document.includeOwnColumns !== undefined
      ? { includeOwnColumns: document.includeOwnColumns }
      : {}),
    ...(document.csvDelimiter !== undefined
      ? { csvDelimiter: document.csvDelimiter }
      : {}),
    signing: {
      mode: document.signing?.mode ?? "none",
      ...(document.signing?.partnerFingerprint !== undefined
        ? { partnerFingerprint: document.signing.partnerFingerprint }
        : {}),
    },
    ...(document.retentionDisposition !== undefined
      ? { retentionDisposition: document.retentionDisposition }
      : {}),
  });
}

/** The document as the mount holds it now. */
function readBack(dir: string): ExchangeSpec {
  return mountedConfigurationDocument(mountedText(dir));
}

describe("a webrtc configuration handed back unchanged", () => {
  test("is the file Alcove writes for that document, byte for byte", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(opened));
    expect(mountedText(dir)).toBe(serializeExchangeDocument(opened));
  });

  test("re-writes to itself", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, unchangedHandBack(readBack(dir)));
    const first = mountedText(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(readBack(dir)));
    expect(mountedText(dir)).toBe(first);
  });
});

describe("a webrtc configuration handed back with edits", () => {
  function editedHandBack(opened: ExchangeSpec): JobConfigurationHandBack {
    return {
      ...unchangedHandBack(opened),
      linkageTerms: { ...opened.linkageTerms, identity: "County Health West" },
      csvDelimiter: ";",
      retentionDisposition: "Destroyed after 90 days.",
      signing: { mode: "certificate" },
    };
  }

  test("holds the edits", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, editedHandBack(readBack(dir)));
    const written = readBack(dir);
    expect(written.linkageTerms.identity).toBe("County Health West");
    expect(written.csvDelimiter).toBe(";");
    expect(written.retentionDisposition).toBe("Destroyed after 90 days.");
    expect(written.signing?.partnerFingerprint).toBeUndefined();
  });

  test("drops nothing: every other key is the one the file stated", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, editedHandBack(opened));
    const written = readBack(dir);
    const unedited = (document: ExchangeSpec) => {
      const {
        linkageTerms: { identity: _identity, ...terms },
        csvDelimiter: _csvDelimiter,
        retentionDisposition: _retentionDisposition,
        signing,
        ...rest
      } = document;
      const { partnerFingerprint: _pin, ...heldSigning } = signing ?? {};
      return { ...rest, linkageTerms: terms, signing: heldSigning };
    };
    expect(unedited(written)).toEqual(unedited(opened));
    expect(Object.keys(written).sort()).toEqual(Object.keys(opened).sort());
  });

  test("writes the connection block exactly as the file states it", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, editedHandBack(opened));
    expect(readBack(dir).connection).toEqual(opened.connection);
    const connectionBlock = (text: string) =>
      text.slice(text.indexOf("connection:"), text.indexOf("linkage_terms:"));
    expect(connectionBlock(mountedText(dir))).toBe(
      connectionBlock(serializeExchangeDocument(opened)),
    );
    for (const credential of [
      BROKER_KEY,
      TURN_CREDENTIAL,
      PROVIDER_OPTION_PATH,
    ])
      expect(mountedText(dir)).toContain(credential);
  });

  test("keeps the file's own permission bits and leaves no other file", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, editedHandBack(readBack(dir)));
    for (const name of ["alcove.yaml", PREVIOUS_CONFIGURATION_FILE_NAME])
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "alcove.yaml",
      PREVIOUS_CONFIGURATION_FILE_NAME,
    ]);
  });

  test("keeps the file as it was before the save beside it", () => {
    const dir = mountHolding(webrtcDocument());
    fs.appendFileSync(
      path.join(dir, "alcove.yaml"),
      "# the operator's own comment\n",
    );
    const before = mountedText(dir);
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, editedHandBack(opened));
    expect(previousText(dir)).toBe(before);
    expect(mountedText(dir)).not.toContain("the operator's own comment");
    expect(readBack(dir).linkageTerms.identity).toBe("County Health West");
  });

  test("a second save keeps the file the first one wrote", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, editedHandBack(readBack(dir)));
    const firstSaved = mountedText(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(readBack(dir)));
    expect(previousText(dir)).toBe(firstSaved);
  });

  test("a copy that cannot be written leaves the file unreplaced", () => {
    const dir = mountHolding(webrtcDocument());
    fs.mkdirSync(path.join(dir, PREVIOUS_CONFIGURATION_FILE_NAME));
    const before = mountedText(dir);
    expect(() =>
      handBackMountedConfiguration(dir, editedHandBack(readBack(dir))),
    ).toThrow(ConfigurationHandBackRefusedError);
    expect(mountedText(dir)).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "alcove.yaml",
      PREVIOUS_CONFIGURATION_FILE_NAME,
    ]);
  });
});

describe("a webrtc configuration with every setting the hand-back edits edited", () => {
  const metadata = (description: string) => [
    {
      name: "case_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    {
      name: "program",
      type: "other",
      role: "payload",
      isPayload: true,
      description,
    },
  ];
  const standardization = (input: string) => [
    { output: "ssn", input, steps: [{ function: "trim" }] },
  ];

  test("comes back as the opened document with exactly those edits", () => {
    const dir = mountHolding(
      webrtcDocument({
        metadata: snakeizeKeys(metadata("Program enrolled in")),
        standardization: standardization("SSN"),
      }),
    );
    const opened = readBack(dir);
    const terms = opened.linkageTerms;
    const editedFields = {
      linkageTerms: {
        ...terms,
        identity: "County Health West",
        linkageStrategy: "single-pass" as const,
        output: { expectsOutput: true, shareWithPartner: false },
        deduplicate: true,
        linkageKeys: terms.linkageKeys.slice(1),
        payload: {
          send: [{ name: "program" }],
          receive: [{ name: "outcome" }],
        },
        legalAgreement: {
          reference: "MOU-2026-0043",
          purpose: "Program audit",
          expirationDate: "2028-06-30",
        },
      },
      metadata: metadata("Program at intake"),
      standardization: standardization("SOCIAL"),
      includeOwnColumns: "disclosed" as const,
      csvDelimiter: "\t",
      retentionDisposition: "Destroyed after 90 days.",
    };
    const pin = "E".repeat(42) + "A";

    handBackMountedConfiguration(
      dir,
      jobConfigurationHandBackSchema.parse({
        ...editedFields,
        signing: { mode: "certificate", partnerFingerprint: pin },
      }),
    );

    expect(readBack(dir)).toEqual({
      ...opened,
      ...editedFields,
      signing: { ...opened.signing, partnerFingerprint: pin },
    });
  });
});

describe("a webrtc configuration naming a relay registrar", () => {
  const RELAY_REGISTRAR = {
    url: "https://registrar.example.org:8443",
    exchange_id: "county-health-intake",
  };

  function registrarDocument(): Record<string, unknown> {
    const document = webrtcDocument();
    return {
      ...document,
      connection: {
        ...(document.connection as Record<string, unknown>),
        turn: [
          ...(document.connection as { turn: Array<unknown> }).turn,
          { url: "turns:relay.example.org:5349" },
        ],
        relay_registrar: RELAY_REGISTRAR,
      },
    };
  }

  test("keeps the block through load, edit, and save, for the command line", () => {
    const dir = mountHolding(registrarDocument());
    expect(readMountedConfiguration(mountedText(dir)).relayRegistrarNamed).toBe(
      true,
    );
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, {
      ...unchangedHandBack(opened),
      linkageTerms: { ...opened.linkageTerms, identity: "County Health West" },
      csvDelimiter: ";",
    });
    const saved = readBack(dir);
    expect(saved.linkageTerms.identity).toBe("County Health West");
    expect(saved.connection).toEqual(opened.connection);
    const written = parseYaml(mountedText(dir)) as {
      connection: { relay_registrar?: unknown };
    };
    expect(written.connection.relay_registrar).toEqual(RELAY_REGISTRAR);
    expect(readMountedConfiguration(mountedText(dir)).relayRegistrarNamed).toBe(
      true,
    );
  });
});

describe("the signing block a hand-back writes", () => {
  test("turning signing off writes no block", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, {
      ...unchangedHandBack(opened),
      signing: { mode: "none" },
    });
    expect(readBack(dir).signing).toBeUndefined();
  });

  test("turning it on names the placeholder identity where the file names none", () => {
    const dir = mountHolding(webrtcDocument({ signing: undefined }));
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, {
      ...unchangedHandBack(opened),
      signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
    });
    expect(readBack(dir).signing).toEqual({
      mode: "certificate",
      identityFile: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
  });

  test("a retired receipt path the file states is not written back", () => {
    const dir = mountHolding(
      webrtcDocument({
        signing: {
          mode: "certificate",
          identity_file: "/home/county/.alcove/identity.json",
          receipt_output: "/home/county/receipts/latest.json",
        },
      }),
    );
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(opened));
    expect(mountedText(dir)).not.toContain("receipt_output");
    expect(readBack(dir).signing).toEqual({
      mode: "certificate",
      identityFile: "/home/county/.alcove/identity.json",
    });
  });

  test("a session-derived block the operator left is kept whole", () => {
    const dir = mountHolding(
      webrtcDocument({ signing: { mode: "session-derived" } }),
    );
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(opened));
    expect(readBack(dir).signing).toEqual({ mode: "session-derived" });
  });
});

describe("what a hand-back refuses", () => {
  test("a mount holding no configuration", () => {
    const dir = mountHolding(webrtcDocument());
    const handBack = unchangedHandBack(readBack(dir));
    fs.rmSync(path.join(dir, "alcove.yaml"));
    expect(() => handBackMountedConfiguration(dir, handBack)).toThrow(
      ConfigurationLoadRefusedError,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("a file changed on disk to a channel the console runs itself", () => {
    const dir = mountHolding(webrtcDocument());
    const handBack = unchangedHandBack(readBack(dir));
    const filedrop = webrtcDocument({
      connection: { channel: "filedrop", path: "/drop" },
      signing: undefined,
    });
    fs.writeFileSync(path.join(dir, "alcove.yaml"), stringifyYaml(filedrop));
    const before = mountedText(dir);
    expect(() => handBackMountedConfiguration(dir, handBack)).toThrow(
      /runs over filedrop now/,
    );
    expect(mountedText(dir)).toBe(before);
  });

  test("settings that do not make a valid configuration, leaving the file", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    const before = mountedText(dir);
    let refusal: unknown;
    try {
      // include_own_columns has no result file to act on beside a count-only
      // algorithm, which core's schema refuses once the two are merged.
      handBackMountedConfiguration(dir, {
        ...unchangedHandBack(opened),
        linkageTerms: { ...opened.linkageTerms, algorithm: "psi-c" },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConfigurationHandBackRefusedError);
    expect((refusal as Error).message).toContain("save again");
    expect(mountedText(dir)).toBe(before);
  });
});
