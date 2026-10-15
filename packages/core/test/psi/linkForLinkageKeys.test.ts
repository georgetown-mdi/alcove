import { expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  buildStandardizedDataset,
  StandardizedKeyIterable,
} from "../../src/standardization";
import { makeParticipant } from "../utils/support";
import { linkViaPSI } from "../../src/psi/link";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { ColumnMetadata } from "../../src/config/metadata";

import { createMessagePipe } from "../../src/connection/messageConnection";

// --- Fixtures ----------------------------------------------------------------

const metadata: ColumnMetadata[] = [
  { name: "id", type: "identifier", role: "identifier", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
];

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "lastName", type: "last_name" },
    { name: "firstName", type: "first_name" },
    { name: "dateOfBirth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [
        { field: "ssn" },
        { field: "lastName" },
        { field: "dateOfBirth" },
      ],
    },
    {
      name: "SSN + LN1 + FN1",
      elements: [
        { field: "ssn" },
        {
          field: "lastName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
        {
          field: "firstName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
      ],
    },
  ],
};

function makeIterables(
  rawRows: ReadonlyArray<Record<string, string>>,
  isReceiver = false,
): StandardizedKeyIterable[] {
  const dataset = buildStandardizedDataset(undefined, rawRows, metadata, terms);
  return terms.linkageKeys.map(
    (key) =>
      new StandardizedKeyIterable(key, dataset, rawRows.length, isReceiver),
  );
}

// --- PSI participants ---------------------------------------------------------

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = makeParticipant(psiLibrary, "starter");
const client = makeParticipant(psiLibrary, "joiner");

// --- Tests --------------------------------------------------------------------

test("rules match in order", async () => {
  // Data is pre-cleaned: SSNs without dashes, DOBs in YYYYMMDD.
  const serverRows = [
    {
      id: "159859483",
      first_name: "James",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];

  // Client row 0 matches only by key 2 (SSN+LN1+FN1, wrong DOB).
  // Client row 1 matches by key 1 (SSN+LN+DOB, exact match).
  // Client row 2 matches only by key 2 (SSN+LN1+FN1, wrong DOB) -- same SSN as
  // server row 0, but key 1 consumed that server record already.
  const clientRows = [
    {
      id: "159859483",
      first_name: "Jim",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750717",
    }, // wrong DOB
    {
      id: "159859483",
      first_name: "Jim",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750818",
    }, // wrong DOB
  ];

  const serverKeys = makeIterables(serverRows);
  const clientKeys = makeIterables(clientRows);

  const [serverResult, clientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverKeys,
      fanOutFreeBounds(serverKeys.length, clientKeys[0].length),
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientKeys,
      fanOutFreeBounds(clientKeys.length, serverKeys[0].length),
      -1,
    ),
  ]);

  expect(serverResult).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(clientResult).toEqual([
    [1, 2],
    [0, 1],
  ]);
});

test("each matched pair reports the round of the key it matched on", async () => {
  const [starterConn, joinerConn] = createMessagePipe();
  const starter = makeParticipant(psiLibrary, "starter");
  const joiner = makeParticipant(psiLibrary, "joiner");

  // Starter row 0 and joiner row 1 agree on every field, so they pair on the
  // first key. Starter row 1 and joiner row 2 differ on date of birth alone,
  // so they pair on the second.
  const starterRows = [
    {
      id: "a",
      first_name: "James",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "b",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];
  const joinerRows = [
    {
      id: "x",
      first_name: "Maria",
      last_name: "LOPEZ",
      ssn: "111223333",
      date_of_birth: "19800101",
    },
    {
      id: "y",
      first_name: "Jim",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "z",
      first_name: "Albert",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750818",
    },
  ];

  const starterKeys = makeIterables(starterRows);
  const joinerKeys = makeIterables(joinerRows);
  let starterRounds: Array<number> | undefined;
  let joinerRounds: Array<number> | undefined;

  const [starterTable, joinerTable] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      starter,
      starterConn,
      starterKeys,
      fanOutFreeBounds(starterKeys.length, joinerKeys[0].length),
      -1,
      undefined,
      undefined,
      (rounds) => {
        starterRounds = rounds;
      },
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      joiner,
      joinerConn,
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, starterKeys[0].length),
      -1,
      undefined,
      undefined,
      (rounds) => {
        joinerRounds = rounds;
      },
    ),
  ]);

  expect(starterTable).toEqual([
    [0, 1],
    [1, 2],
  ]);
  expect(joinerTable).toEqual([
    [1, 2],
    [0, 1],
  ]);
  // Both parties count the same rounds, entry for entry with their own table.
  expect(starterRounds).toEqual([0, 1]);
  expect(joinerRounds).toEqual([0, 1]);
});
