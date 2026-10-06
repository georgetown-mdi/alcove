import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";
import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKeys,
} from "@alcove/core";
import { saveConfig } from "../../src/config";

// The command line's editor for a setting is the configuration file itself, so
// its round trip is a load, an edit, and a save (docs/EXCHANGE_REFERENCE.md,
// "Where each setting is edited"). Each document below states every setting the
// shared schema admits on its channel, and the edit changes every one of them:
// the file saved back must be the edited document, key for key.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-config-round-trip-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 0 is the document as written, 1 the same document with every value edited. */
type Variant = 0 | 1;

function pick<T>(variant: Variant, written: T, edited: T): T {
  return variant === 0 ? written : edited;
}

const host = (variant: Variant, name: string) =>
  `${name}${pick(variant, "", "-2")}.example.org`;

const doubled = (variant: Variant, value: number) => value * (variant + 1);

const flipped = (variant: Variant, value: boolean) =>
  variant === 0 ? value : !value;

const text = (variant: Variant, value: string) =>
  pick(variant, value, `${value}, edited`);

function httpEndpoint(variant: Variant, name: string) {
  return {
    host: host(variant, name),
    port: doubled(variant, 8443),
    path: pick(variant, "/v1", "/v2"),
    auth: pick<Record<string, string>>(
      variant,
      { username: "operator", password: "fake-password-for-tests" },
      { bearer: "fake-bearer-for-tests" },
    ),
  };
}

function connectionTimeouts(variant: Variant) {
  return {
    peerTimeoutMs: doubled(variant, 600_000),
    inactivityTimeoutMs: doubled(variant, 120_000),
    serverConnectTimeoutMs: doubled(variant, 30_000),
    maxReconnectAttempts: doubled(variant, 3),
  };
}

function fileSyncOptions(variant: Variant) {
  return {
    ...connectionTimeouts(variant),
    pollIntervalMs: doubled(variant, 2_000),
    retainFiles: true,
    timestampInFilename: true,
    locklessRendezvous: true,
    peerId: text(variant, "county"),
    unexpectedFiles: pick(variant, "warn", "ignore"),
    connectionPerPoll: flipped(variant, false),
  };
}

function sftpConnection(variant: Variant, server: Record<string, unknown>) {
  return {
    channel: "sftp",
    server: {
      host: host(variant, "sftp"),
      port: doubled(variant, 2222),
      username: text(variant, "linkage"),
      hostKeyFingerprint: pick<string | Array<string>>(
        variant,
        `SHA256:${"A".repeat(43)}`,
        [`SHA256:${"B".repeat(42)}A`, `SHA256:${"C".repeat(42)}A`],
      ),
      provision: {
        mode: pick(variant, "start", "create"),
        ...httpEndpoint(variant, "wake"),
      },
      ...server,
    },
    options: fileSyncOptions(variant),
    providerOptions: { readyTimeout: doubled(variant, 20_000) },
  };
}

const sftpKeyConnection = (variant: Variant) =>
  sftpConnection(variant, {
    inboundPath: text(variant, "/in"),
    outboundPath: text(variant, "/out"),
    privateKey: text(variant, "@/run/secrets/key"),
    privateKeyPassphrase: text(variant, "@/run/secrets/passphrase"),
  });

const sftpPasswordConnection = (variant: Variant) =>
  sftpConnection(variant, {
    path: text(variant, "/exchange"),
    password: text(variant, "@/run/secrets/password"),
    keyboardInteractive: flipped(variant, false),
  });

const filedropConnection = (variant: Variant) => ({
  channel: "filedrop",
  path: text(variant, "/mnt/share"),
  options: fileSyncOptions(variant),
});

const filedropPairConnection = (variant: Variant) => ({
  channel: "filedrop",
  inboundPath: text(variant, "/mnt/in"),
  outboundPath: text(variant, "/mnt/out"),
  options: fileSyncOptions(variant),
});

function webrtcConnection(variant: Variant, ice: Record<string, unknown>) {
  return {
    channel: "webrtc",
    server: {
      host: host(variant, "broker"),
      port: doubled(variant, 443),
      path: pick(variant, "/peers", "/api/"),
      username: text(variant, "county"),
      key: text(variant, "fake-broker-key"),
      secure: flipped(variant, true),
      provision: httpEndpoint(variant, "broker-wake"),
    },
    role: pick(variant, "inviter", "acceptor"),
    invitationRelay: {
      turn: [`turns:${host(variant, "relay")}:443?transport=tcp`],
      stun: [`stun:${host(variant, "relay")}:3478`],
    },
    iceTransportPolicy: pick(variant, "all", "relay"),
    options: connectionTimeouts(variant),
    providerOptions: { debugLevel: doubled(variant, 1) },
    ...ice,
  };
}

const webrtcRelayConnection = (variant: Variant) =>
  webrtcConnection(variant, {
    stun: [`stun:${host(variant, "stun")}:3478`],
    turn: [
      {
        url: `turn:${host(variant, "turn")}:3478`,
        username: text(variant, "county"),
        credential: text(variant, "fake-turn-credential"),
        credentialType: pick(variant, "password", "hmac-sha1"),
      },
      { url: `turn:${host(variant, "minted")}:3478` },
    ],
    relayRegistrar: {
      url: `https://${host(variant, "registrar")}`,
      exchangeId: text(variant, "riverbend-quarterly").replace(", ", "-"),
    },
  });

const webrtcIceProvisionConnection = (variant: Variant) =>
  webrtcConnection(variant, { iceProvision: httpEndpoint(variant, "ice") });

/** Every setting outside `connection`, the linkage terms' included. */
function documentSettings(variant: Variant) {
  const defaults = getDefaultLinkageTerms("County Health");
  const description = text(variant, "Program enrolled in");
  return {
    linkageTerms: {
      ...defaults,
      version: pick(variant, "1.0.0", "1.1.0"),
      identity: text(variant, "County Health"),
      date: pick(variant, "2026-09-01", "2026-10-01"),
      linkageStrategy: pick(variant, "cascade", "single-pass"),
      output: {
        expectsOutput: true,
        shareWithPartner: flipped(variant, false),
      },
      deduplicate: flipped(variant, false),
      linkageFields: defaults.linkageFields.map((field) =>
        field.type === "ssn"
          ? { ...field, constraints: { validOnly: flipped(variant, true) } }
          : field,
      ),
      linkageKeys: defaults.linkageKeys.slice(variant),
      linkageRuleSet: pick(variant, defaults.linkageRuleSet, undefined),
      payload: {
        send: [{ name: "program", description }],
        receive: [{ name: pick(variant, "outcome", "outcome_code") }],
      },
      legalAgreement: {
        reference: pick(variant, "MOU-2026-0042", "MOU-2026-0043"),
        purpose: text(variant, "Program evaluation"),
        expirationDate: pick(variant, "2027-06-30", "2028-06-30"),
      },
    },
    metadata: [
      { name: "case_id", type: "identifier", role: "identifier" },
      { name: "ssn", type: "ssn", role: "linkage" },
      { name: "program", type: "other", role: "payload", description },
    ].map((column) => ({ ...column, isPayload: column.role === "payload" })),
    standardization: [
      {
        output: "ssn",
        input: pick(variant, "SSN", "SOCIAL"),
        steps: [{ function: pick(variant, "trim", "uppercase") }],
      },
    ],
    authentication: { tokenMaxAgeDays: doubled(variant, 30) },
    signing: {
      mode: pick(variant, "certificate", "session-derived"),
      identityFile: text(variant, "/home/county/identity.json"),
      partnerFingerprint: `${pick(variant, "C", "D").repeat(42)}A`,
    },
    retentionDisposition: text(variant, "Filed for seven years."),
    expectedPartnerDeduplicate: flipped(variant, true),
    includeOwnColumns: pick(variant, "disclosed", "all"),
    csvDelimiter: pick(variant, "|", "\t"),
  };
}

test.each([
  ["sftp with a private key and a directory pair", sftpKeyConnection],
  ["sftp with a password and one directory", sftpPasswordConnection],
  ["filedrop with one folder", filedropConnection],
  ["filedrop with a folder pair", filedropPairConnection],
  ["webrtc with relay settings", webrtcRelayConnection],
  ["webrtc with an ICE provisioning endpoint", webrtcIceProvisionConnection],
] as const)(
  "a %s configuration comes back from a load, an edit of every setting, and a save as edited",
  (_label, connection) => {
    const configPath = path.join(dir, "alcove.yaml");
    const document = (variant: Variant) =>
      parseExchangeSpec({
        connection: connection(variant),
        ...documentSettings(variant),
      });
    const load = () =>
      parseExchangeSpec(
        parseSensitiveYaml(fs.readFileSync(configPath, "utf8"), "round trip"),
      );
    fs.writeFileSync(configPath, YAML.stringify(snakeizeKeys(document(0))));

    expect(load()).toEqual(document(0));
    saveConfig(configPath, document(1));

    expect(load()).toEqual(document(1));
    expect(load()).not.toEqual(document(0));
  },
);
