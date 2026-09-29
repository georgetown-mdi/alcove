import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  UsageError,
} from "@alcove/core";
import type { ExchangeSpec, PreparedExchange } from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import {
  buildSaveSpec,
  finalizeBootstrap,
} from "../../../src/commands/zeroSetup";
import { loadKeyFile } from "../../../src/keyFile";

// A 43-char base64url token satisfying the sharedSecret format constraint, as a
// stand-in for a secret the initiator would have generated in-band.
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function sampleSpec(): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Test Party"),
  };
}

// buildSaveSpec reads only linkageTerms and metadata off the prepared exchange
// (the rest travels the recurring config no other route this test drives), so
// each fixture below fills the remaining required fields via the shared
// minimal factory.
function preparedFrom(
  linkageTerms: PreparedExchange["linkageTerms"],
  metadata: PreparedExchange["metadata"],
): PreparedExchange {
  return minimalPreparedExchange({ linkageTerms, metadata });
}

function capture(): {
  log: { info: (m: string) => void; warn: (m: string) => void };
  messages: string[];
  warnings: string[];
} {
  const messages: string[] = [];
  const warnings: string[] = [];
  return {
    messages,
    warnings,
    log: {
      info: (m: string) => messages.push(m),
      warn: (m: string) => warnings.push(m),
    },
  };
}

let dir: string;
let configFile: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-zerosave-"));
  configFile = path.join(dir, "alcove.yaml");
  keyFile = path.join(dir, ".alcove.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- buildSaveSpec -----------------------------------------------------------

test("buildSaveSpec includes the connection, terms and metadata, omitting standardization", () => {
  const connection = { channel: "filedrop", path: "/mnt/share" } as const;
  const linkageTerms = getDefaultLinkageTerms("Test Party");
  const metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  ] satisfies PreparedExchange["metadata"];
  const prepared = preparedFrom(linkageTerms, metadata);

  const spec = buildSaveSpec(connection, prepared);

  expect(spec.connection).toBe(connection);
  expect(spec.linkageTerms).toBe(linkageTerms);
  expect(spec.metadata).toBe(metadata);
  expect(spec.standardization).toBeUndefined();
  expect(spec.expectedPayloadColumns).toBeUndefined();
});

test("buildSaveSpec records a filled receive list in the saved terms", () => {
  // A zero-setup --save party fills its unset receive list from the partner's
  // declared send set, so a later `alcove exchange` holds the partner to it.
  const prepared = preparedFrom(getDefaultLinkageTerms("Test Party"), []);

  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    prepared,
    ["dob", "zip"],
  );

  expect(spec.linkageTerms.payload?.receive).toEqual([
    { name: "dob" },
    { name: "zip" },
  ]);
  expect(spec.expectedPayloadColumns).toBeUndefined();
});

test("buildSaveSpec records an empty fill as receive nothing", () => {
  // The fill is the partner's declared set, not an observation of what
  // arrived, so an empty one is what the partner declared it sends.
  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    preparedFrom(getDefaultLinkageTerms("Test Party"), []),
    [],
  );

  expect(spec.linkageTerms.payload?.receive).toEqual([]);
});

test("a saved filled receive list reloads intact", () => {
  const { log } = capture();
  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    preparedFrom(getDefaultLinkageTerms("Test Party"), []),
    ["dob", "zip"],
  );
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec,
    configFile,
    keyFile,
    log,
  });
  const reloaded = parseExchangeSpec(
    YAML.parse(fs.readFileSync(configFile, "utf8")),
  );
  expect(reloaded.linkageTerms.payload?.receive).toEqual([
    { name: "dob" },
    { name: "zip" },
  ]);
});

// --- both parties saved ------------------------------------------------------

test("both-saved: writes config and key, and reports the shared secret", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(true);
  expect(loadKeyFile(keyFile)?.sharedSecret).toBe(SECRET);
  expect(messages.some((m) => m.includes("established a shared secret"))).toBe(
    true,
  );
});

// --- the fill notice logs only after the write it depends on ----------------

test("both-saved: the fill notice logs only once the config write lands", () => {
  // The columns are recorded in memory well before this call (at the terms
  // exchange); the notice must not follow that record but the write this
  // function itself performs, so a message logged before the config exists
  // on disk would be a false claim.
  const messages: string[] = [];
  const configExistsAtLog: boolean[] = [];
  const log = {
    info: (m: string) => {
      messages.push(m);
      configExistsAtLog.push(fs.existsSync(configFile));
    },
    warn: () => {},
  };
  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    preparedFrom(getDefaultLinkageTerms("Test Party"), []),
    ["dob", "zip"],
  );
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec,
    configFile,
    keyFile,
    log,
    filledPayloadReceive: ["dob", "zip"],
  });

  const noticeIndex = messages.findIndex((m) =>
    m.includes("payload.receive was not set"),
  );
  expect(noticeIndex).toBeGreaterThanOrEqual(0);
  expect(configExistsAtLog[noticeIndex]).toBe(true);
});

test("we-saved-partner-did-not: logs no fill notice when the save fails", () => {
  const { log, messages } = capture();
  // Simulate the same post-preflight conflict the TOCTOU tests below exercise,
  // so the config-only branch's write throws before returning.
  fs.writeFileSync(configFile, "preexisting: true\n");
  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    preparedFrom(getDefaultLinkageTerms("Test Party"), []),
    ["dob", "zip"],
  );

  expect(() =>
    finalizeBootstrap({
      save: true,
      bootstrap: { partnerSaveIntent: false },
      spec,
      configFile,
      keyFile,
      log,
      filledPayloadReceive: ["dob", "zip"],
    }),
  ).toThrow(UsageError);

  expect(messages.some((m) => m.includes("payload.receive was not set"))).toBe(
    false,
  );
});

test("save persists an @path credential as the reference, never the secret contents", () => {
  // End-to-end at-rest check for the --save path: a connection whose password is
  // an @path reference is persisted verbatim, so the referenced file's contents
  // (the secret) never land in alcove.yaml. Read the value back through the YAML
  // parser rather than as a raw substring -- a long quoted scalar may line-wrap.
  const { log } = capture();
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, "s3cret\n");
  const spec = buildSaveSpec(
    {
      channel: "sftp",
      server: { host: "h", username: "u", password: `@${pwFile}` },
    },
    preparedFrom(getDefaultLinkageTerms("Test Party"), []),
  );
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec,
    configFile,
    keyFile,
    log,
  });
  const written = fs.readFileSync(configFile, "utf8");
  expect(written).not.toContain("s3cret");
  expect(YAML.parse(written).connection.server.password).toBe(`@${pwFile}`);
});

// --- only this party saved ---------------------------------------------------

test("we-saved-partner-did-not: writes config only and instructs to invite", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: false },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(true);
  // No secret was established, so no key file is written.
  expect(fs.existsSync(keyFile)).toBe(false);
  const joined = messages.join("\n");
  expect(joined).toContain("did not also choose to save");
  expect(joined).toContain("alcove invite");
});

// --- this party did not save -------------------------------------------------

test("partner-saved-we-did-not: saves nothing and reports nothing was saved", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: false,
    bootstrap: { partnerSaveIntent: true },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
  expect(
    messages.some((m) => m.includes("nothing was saved on your end")),
  ).toBe(true);
});

test("neither-saved: saves nothing and emits the standard recurring hint", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: false,
    bootstrap: { partnerSaveIntent: false },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
  expect(messages.some((m) => m.includes("alcove invite URL INPUT_FILE"))).toBe(
    true,
  );
});

// --- post-exchange conflict re-check (TOCTOU window) -------------------------

test("we-saved-partner-did-not: aborts without clobbering a config that appeared after the pre-flight check", () => {
  const { log } = capture();
  // Simulate a file materializing at the config path in the window between the
  // handler's up-front conflict gate and this post-exchange write. The
  // both-saved branch gets this re-check from provisionConfigAndKey; the
  // config-only branch must match it rather than silently overwrite.
  fs.writeFileSync(configFile, "preexisting: true\n");
  expect(() =>
    finalizeBootstrap({
      save: true,
      bootstrap: { partnerSaveIntent: false },
      spec: sampleSpec(),
      configFile,
      keyFile,
      log,
    }),
  ).toThrow(UsageError);
  expect(fs.readFileSync(configFile, "utf8")).toContain("preexisting");
});

/** Report `hidden` absent to every lstat while `fn` runs. */
function hideFromLstat<T>(hidden: string, fn: () => T): T {
  const realLstat = fs.lstatSync;
  const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
    target: fs.PathLike,
    options?: fs.StatSyncOptions,
  ) => {
    if (target === hidden)
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    return realLstat(target, options);
  }) as typeof fs.lstatSync);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

test("we-saved-partner-did-not: refuses a config that appears after the re-check too", () => {
  const { log } = capture();
  fs.writeFileSync(configFile, "preexisting: true\n");
  hideFromLstat(configFile, () =>
    expect(() =>
      finalizeBootstrap({
        save: true,
        bootstrap: { partnerSaveIntent: false },
        spec: sampleSpec(),
        configFile,
        keyFile,
        log,
      }),
    ).toThrow("refusing to overwrite"),
  );
  expect(fs.readFileSync(configFile, "utf8")).toBe("preexisting: true\n");
});

// --- invariant guard ---------------------------------------------------------

test("refuses a shared secret when this party did not save, rather than dropping it silently", () => {
  const { log } = capture();
  // Unreachable from real exchange code (the secret frame is gated on this
  // party's own intent), but the guard turns the contradiction into a loud
  // failure instead of a silently discarded secret.
  expect(() =>
    finalizeBootstrap({
      save: false,
      bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
      spec: sampleSpec(),
      configFile,
      keyFile,
      log,
    }),
  ).toThrow("internal error");
  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
});
