import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { deriveRelayKey } from "@alcove/core";

import { enrollRelay, readFirstLine } from "../../../src/commands/enrollRelay";
import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";
import { REMOVED_CREDENTIAL_TEXT } from "../../../src/relayRegistrar";
import {
  exitCodeForError,
  exitWithError,
  renderFailureForOperator,
} from "../../../src/util/exit";
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

/** The line `exitWithError`, the handler's failure path, logs for `failure`. */
function loggedFailureLine(failure: unknown): string {
  const lines: string[] = [];
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    exitWithError({ error: (m) => lines.push(m) }, failure, 1);
  } finally {
    exit.mockRestore();
  }
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

test("a registrar answer echoing the token is shown and logged with the token removed", async () => {
  fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
  saveKeyFile(keyFile, { sharedSecret: SECRET });
  const registrar = fakeRegistrar([
    jsonResponse(401, {
      error:
        `bad credential in Authorization: Bearer ${OWNER_TOKEN} ` +
        `(${Buffer.from(OWNER_TOKEN).toString("base64")})`,
    }),
  ]);
  const failure = (await enrollRelay({
    configFile,
    keyFile,
    replace: false,
    readOwnerToken: async () => OWNER_TOKEN,
    transport: { fetch: registrar.fetch },
  }).catch((err: unknown) => err)) as Error;
  expect(exitCodeForError(failure)).toBe(77);
  const base64Token = Buffer.from(OWNER_TOKEN).toString("base64");
  for (const text of [
    failure.message,
    renderFailureForOperator(failure),
    loggedFailureLine(failure),
  ]) {
    expect(text).toContain(REMOVED_CREDENTIAL_TEXT);
    expect(text).not.toContain(OWNER_TOKEN);
    expect(text).not.toContain(base64Token);
  }
});

test("an enrollment answer whose lapsesAt holds control bytes is refused, and none of them is shown", async () => {
  fs.writeFileSync(configFile, YAML.stringify(webrtcConfig()));
  saveKeyFile(keyFile, {
    sharedSecret: SECRET,
    relayRegistrationPendingSince: "2026-01-01T00:00:00.000Z",
  });
  const registrar = fakeRegistrar([
    jsonResponse(200, {
      maxAgeDays: 45,
      lapsesAt: "2026-02-15T00:00:00Z\u001b[2K\u0007\nforged line",
    }),
  ]);
  const failure = (await enrollRelay({
    configFile,
    keyFile,
    replace: false,
    readOwnerToken: async () => OWNER_TOKEN,
    transport: { fetch: registrar.fetch },
  }).catch((err: unknown) => err)) as Error;
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain("not a UTC timestamp");
  for (const text of [failure.message, loggedFailureLine(failure)]) {
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).not.toContain("forged");
    expect(text).not.toContain("2026-02-15");
  }
  expect(loadKeyFile(keyFile)?.relayRegistrationPendingSince).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});

test("a piped token is read at its newline while the pipe stays open", async () => {
  const pipe = new PassThrough();
  pipe.write(`${OWNER_TOKEN}
later input`);
  await expect(readFirstLine(pipe)).resolves.toBe(OWNER_TOKEN);
});

test("a piped input with no newline in its first 4096 bytes is refused", async () => {
  const pipe = new PassThrough();
  pipe.write("x".repeat(5000));
  await expect(readFirstLine(pipe)).rejects.toThrow(
    "standard input holds no relay-owner token on its first line",
  );
});
