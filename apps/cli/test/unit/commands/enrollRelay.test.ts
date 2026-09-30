import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { deriveRelayKey } from "@alcove/core";

import { enrollRelay } from "../../../src/commands/enrollRelay";
import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";
import { exitCodeForError } from "../../../src/util/exit";
import { fakeRegistrar, jsonResponse } from "../relayRegistrarFake";

const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const OWNER_TOKEN = "0123456789abcdef-owner-token";

const linkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

function webrtcConfig(connection: Record<string, unknown> = {}) {
  return {
    connection: {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      turn: [{ url: "turns:relay.example.org:443?transport=tcp" }],
      relay_registrar: {
        url: "https://relay.example.org:8443",
        exchange_id: "exchange-1",
      },
      ...connection,
    },
    authentication: { token_max_age_days: 45 },
    linkage_terms: linkageTerms,
  };
}

let dir: string;
let configFile: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-enroll-relay-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("asks for the token once, sends it in one enrollment, and stores it nowhere", async () => {
  fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
  saveKeyFile(keyFile, {
    sharedSecret: SECRET,
    relayRegistrationPendingSince: "2026-01-01T00:00:00.000Z",
  });
  const configBefore = fs.readFileSync(configFile, "utf8");
  const registrar = fakeRegistrar([
    jsonResponse(200, { maxAgeDays: 45, lapsesAt: "2026-02-15T00:00:00Z" }),
  ]);
  const readOwnerToken = vi.fn(async (_question: string) => `${OWNER_TOKEN}\n`);

  const notice = await enrollRelay({
    configFile,
    keyFile,
    replace: false,
    readOwnerToken,
    transport: { fetch: registrar.fetch },
  });

  expect(readOwnerToken).toHaveBeenCalledTimes(1);
  expect(readOwnerToken.mock.calls[0]![0]).toContain(
    "https://relay.example.org:8443",
  );
  expect(registrar.requests).toHaveLength(1);
  expect(registrar.requests[0]).toMatchObject({
    url: "https://relay.example.org:8443/exchanges/exchange-1",
    method: "POST",
    authorization: `Bearer ${OWNER_TOKEN}`,
  });
  expect(JSON.parse(registrar.requests[0]!.body)).toEqual({
    key: await deriveRelayKey(SECRET),
    maxAgeDays: 45,
  });
  expect(notice).not.toContain(OWNER_TOKEN);
  expect(fs.readFileSync(configFile, "utf8")).toBe(configBefore);
  const keyFileText = fs.readFileSync(keyFile, "utf8");
  expect(keyFileText).not.toContain(OWNER_TOKEN);
  expect(loadKeyFile(keyFile)).toEqual({ sharedSecret: SECRET });
  for (const name of fs.readdirSync(dir))
    expect(fs.readFileSync(path.join(dir, name), "utf8")).not.toContain(
      OWNER_TOKEN,
    );
});

test("--replace-relay-key sends the token on PUT, the operator's recovery route", async () => {
  fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  const registrar = fakeRegistrar([jsonResponse(200, {})]);
  await enrollRelay({
    configFile,
    keyFile,
    replace: true,
    readOwnerToken: async () => OWNER_TOKEN,
    transport: { fetch: registrar.fetch },
  });
  expect(registrar.requests[0]).toMatchObject({
    method: "PUT",
    authorization: `Bearer ${OWNER_TOKEN}`,
  });
});

test("a configuration naming no registrar is refused before the token is asked for", async () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify(webrtcConfig({ relay_registrar: undefined })),
  );
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  const readOwnerToken = vi.fn(async () => OWNER_TOKEN);
  const failure = (await enrollRelay({
    configFile,
    keyFile,
    replace: false,
    readOwnerToken,
    transport: { fetch: fakeRegistrar([]).fetch },
  }).catch((err: unknown) => err)) as Error;
  expect(exitCodeForError(failure)).toBe(64);
  expect(failure.message).toContain("names no relay registrar");
  expect(readOwnerToken).not.toHaveBeenCalled();
});

test("an empty token sends nothing", async () => {
  fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  const registrar = fakeRegistrar([]);
  const failure = await enrollRelay({
    configFile,
    keyFile,
    replace: false,
    readOwnerToken: async () => "",
    transport: { fetch: registrar.fetch },
  }).catch((err: unknown) => err);
  expect(exitCodeForError(failure)).toBe(64);
  expect(registrar.requests).toHaveLength(0);
});

test.each([
  [401, 77, "Check the token"],
  [409, 64, "--replace-relay-key"],
])(
  "an enrollment answered %i exits %i and never repeats the token",
  async (status, code, step) => {
    fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
    saveKeyFile(keyFile, { sharedSecret: SECRET });
    const registrar = fakeRegistrar([
      jsonResponse(status, { error: "refused" }),
    ]);
    const failure = (await enrollRelay({
      configFile,
      keyFile,
      replace: false,
      readOwnerToken: async () => OWNER_TOKEN,
      transport: { fetch: registrar.fetch },
    }).catch((err: unknown) => err)) as Error;
    expect(exitCodeForError(failure)).toBe(code);
    expect(failure.message).toContain(step);
    expect(failure.message).not.toContain(OWNER_TOKEN);
  },
);
