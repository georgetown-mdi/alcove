// The published entry points, driven as a consumer gets them: the built
// `@alcove/core`, `@alcove/core/testing`, `@alcove/core/untrusted-text` and
// `@alcove/core/websocket-relay`, not this source tree. Plain JavaScript
// because that is what the artifacts are.
//
// A refusal class one entry publishes is matched by `instanceof` against an error
// another entry's code threw, so it only works while every entry reaches ONE copy
// of the module declaring the class at run time. A build giving each entry its own
// copy passes every source-level test and fails each of those matches.

import { Readable } from "node:stream";

import { beforeAll, expect, test } from "vitest";

import {
  CORE_PACKAGE,
  requireFreshDists,
} from "../../../scripts/lib/distFreshness.mjs";

import {
  loadCSVFile,
  parseBoundedJson,
  parseWebSocketRelayProof,
} from "@alcove/core";
import { CsvRowParseError } from "@alcove/core/testing";
import { JsonStructureBoundError } from "@alcove/core/untrusted-text";
import { WebSocketRelayProofRefusedError } from "@alcove/core/websocket-relay";

beforeAll(() => {
  requireFreshDists({ packages: [CORE_PACKAGE], allowOptOut: false });
});

test("a refusal the main entry throws is the class the testing entry publishes", async () => {
  // An unterminated quote: the parsed rows would differ from the file's own.
  const source = Readable.from([
    Buffer.from('first_name,dob\n"Alice,1990-01-02\nBob,1985-12-31\n', "utf8"),
  ]);

  await expect(loadCSVFile(source)).rejects.toBeInstanceOf(CsvRowParseError);
});

test("a refusal the main entry throws is the class the untrusted-text entry publishes", () => {
  const tooDeep = "[".repeat(5000) + "]".repeat(5000);

  expect(() => parseBoundedJson(tooDeep)).toThrow(JsonStructureBoundError);
});

test("a refusal the main entry throws is the class the websocket-relay entry publishes", () => {
  expect(() =>
    parseWebSocketRelayProof(new Uint8Array(1), new Uint8Array(1)),
  ).toThrow(WebSocketRelayProofRefusedError);
});
