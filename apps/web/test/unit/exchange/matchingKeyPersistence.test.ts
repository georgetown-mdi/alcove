import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
} from "@alcove/core";

import {
  EMPTY_SAVE_FIELDS,
  exchangeFileInputFor,
} from "@exchange/saveExchangeModel";
import {
  buildManagedDeposit,
  webrtcLocatorFromEndpoint,
} from "@exchange/manageOfferModel";
import {
  buildManagedExchangeRecord,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  composeConfigDocument,
  composeSftpConfigDocument,
} from "@jobs/intentConfig";
import { authoringStateFromDocument } from "@console/loadedConfig";
import { disclosedDocument } from "@jobs/configLoad";
import { jobExchangeIntentSchema } from "@jobContract/intentSchemas";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";

import {
  testSftpServerEntry,
  validIntent,
  validSftpIntent,
} from "../../utils/jobFixtures";

import type { CSVRow, WebRTCEndpoint } from "@alcove/core";
import type { GeneratedInvitation } from "@psi/invitation";

// Where the matched-key choice lands once it leaves the editor: the artifacts an
// authored exchange produces, the read-back a recurring run depends on, and the
// console's projection of an opened configuration.

const columns = ["client_id", "first_name", "last_name", "dob"];
const metadata = inferMetadata(columns, []);
const terms = getDefaultLinkageTerms("County Health Dept", metadata);

const rows: Array<CSVRow> = [
  { client_id: "17", first_name: "Ada", last_name: "Lovelace", dob: "1815" },
];

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
};

describe("a managed exchange keeps the choice", () => {
  test("it round-trips through the stored record into a re-run", () => {
    const stored = buildManagedExchangeRecord(
      buildManagedDeposit(
        {
          documentParts: {
            side: "inviter",
            linkageTerms: terms,
            metadata,
            includeMatchingKey: true,
          },
          connection: webrtcLocatorFromEndpoint(endpoint),
          allowedRelays: undefined,
          rotatedSecret: generateSharedSecret(),
          choices: { label: "Riverbend quarterly" },
        },
        Date.parse("2026-03-01T00:00:00.000Z"),
      ),
    );
    const readBack = parseManagedExchangeRecord(
      JSON.parse(JSON.stringify(stored)) as unknown,
    );
    expect(readBack.exchangeFile.includeMatchingKey).toBe(true);
    expect(
      prepareManagedRerunExchange(readBack.exchangeFile, rows, columns)
        .includeMatchingKey,
    ).toBe(true);
  });
});

describe("the saved exchange file states the choice", () => {
  const minted = {
    linkageTerms: terms,
    metadata,
  } as unknown as GeneratedInvitation;

  test("the mint's decided choice reaches the file's input", () => {
    const input = exchangeFileInputFor(
      "filedrop",
      { ...EMPTY_SAVE_FIELDS, sharedDirectory: "/rendezvous" },
      { ...minted, includeMatchingKey: true },
    );
    expect(input.includeMatchingKey).toBe(true);
  });

  test("a mint that decided none composes no key", () => {
    const input = exchangeFileInputFor(
      "filedrop",
      { ...EMPTY_SAVE_FIELDS, sharedDirectory: "/rendezvous" },
      minted,
    );
    expect(input).not.toHaveProperty("includeMatchingKey");
  });
});

describe("the console's composed config states the choice", () => {
  test("the boundary schema admits a boolean and refuses anything else", () => {
    for (const value of [true, false])
      expect(
        jobExchangeIntentSchema.safeParse({
          mode: "exchange",
          ...validIntent({ includeMatchingKey: value }),
        }).success,
      ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse({
        mode: "exchange",
        ...validIntent({ includeMatchingKey: "yes" as unknown as boolean }),
      }).success,
    ).toBe(false);
  });

  test("the filedrop and sftp composers write include_matching_key", () => {
    const filedrop = parseYaml(
      composeConfigDocument(
        validIntent({ includeMatchingKey: true }),
        "/rendezvous",
      ),
    ) as Record<string, unknown>;
    expect(filedrop["include_matching_key"]).toBe(true);
    const sftp = parseYaml(
      composeSftpConfigDocument(
        validSftpIntent({ includeMatchingKey: true }),
        testSftpServerEntry(),
      ),
    ) as Record<string, unknown>;
    expect(sftp["include_matching_key"]).toBe(true);
  });

  test("an intent without the field composes no key", () => {
    const composed = parseYaml(
      composeConfigDocument(validIntent(), "/rendezvous"),
    ) as Record<string, unknown>;
    expect(composed).not.toHaveProperty("include_matching_key");
  });

  test("the key is refused beside single-pass terms, before any run", () => {
    expect(() =>
      composeConfigDocument(
        validIntent({
          includeMatchingKey: true,
          linkageTerms: {
            ...validIntent().linkageTerms,
            linkageStrategy: "single-pass",
          },
        }),
        "/rendezvous",
      ),
    ).toThrow("include_matching_key is set on a single-pass exchange");
  });
});

describe("an opened configuration projects the choice to the console", () => {
  const opened = parseExchangeSpec({
    connection: { channel: "filedrop", path: "/rendezvous" },
    linkage_terms: terms,
    include_matching_key: true,
  });

  test("the disclosed document states it", () => {
    expect(disclosedDocument(opened).includeMatchingKey).toBe(true);
  });

  test("the authoring state starts the control from it, and off where it is absent", () => {
    expect(
      authoringStateFromDocument(disclosedDocument(opened)).matchingKey,
    ).toBe(true);
    const { includeMatchingKey: _dropped, ...without } = opened;
    expect(
      authoringStateFromDocument(disclosedDocument(without)).matchingKey,
    ).toBe(false);
  });
});
