import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  decodeTermsUpdate,
  deriveAcceptedLinkageTerms,
  encodeTermsUpdate,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
  termsUpdateFor,
} from "@alcove/core";
import type { ExchangeSpec, LinkageTerms, Metadata } from "@alcove/core";

vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirm: vi.fn() };
});

import { handler as applyHandler } from "../../../src/commands/apply";
import { handler as updateHandler } from "../../../src/commands/update";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { promptConfirm } from "../../../src/util/prompt";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirm);

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

interface Party {
  config: string;
  key: string;
}

interface Partnership {
  dir: string;
  a: Party;
  b: Party;
  secret: string;
  aTerms: LinkageTerms;
}

let partnership: Partnership;

/** The linkage columns, plus each of `sent` declared as sent to the partner. */
function metadataWith(...sent: string[]): Metadata {
  return [
    ...inferMetadata(LINKAGE_COLUMNS, []),
    ...sent.map((name) => ({
      name,
      type: "other" as const,
      role: "payload" as const,
      isPayload: true,
    })),
  ];
}

/**
 * An established partnership: Agency A's metadata discloses `notes` and its
 * terms leave `payload.send` unset, Agency B's `payload.receive` lists the
 * `notes` it receives and its metadata discloses `program`, and both key files
 * hold one secret.
 */
function establishPartnership(): Partnership {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-terms-update-"));
  const a = { config: path.join(dir, "a.yaml"), key: path.join(dir, "a.key") };
  const b = { config: path.join(dir, "b.yaml"), key: path.join(dir, "b.key") };
  const aTerms = getDefaultLinkageTerms(
    "Agency A",
    inferMetadata(LINKAGE_COLUMNS, []),
  );
  saveConfig(a.config, {
    connection: { channel: "filedrop", path: "/mnt/a" },
    linkageTerms: aTerms,
    metadata: metadataWith("notes"),
  });
  const bTerms = deriveAcceptedLinkageTerms(
    { ...aTerms, payload: { send: [{ name: "notes" }] } },
    "Agency B",
  );
  saveConfig(b.config, {
    connection: { channel: "filedrop", path: "/mnt/b" },
    linkageTerms: bTerms,
    metadata: metadataWith("program"),
    expectedPartnerDeduplicate: false,
  });
  const secret = generateSharedSecret();
  saveKeyFile(a.key, { sharedSecret: secret });
  saveKeyFile(b.key, { sharedSecret: secret });
  return { dir, a, b, secret, aTerms };
}

/** Agency A's edit: one linkage key fewer, and `county` disclosed too. */
function editAgencyA(): LinkageTerms {
  const edited: LinkageTerms = {
    ...partnership.aTerms,
    linkageKeys: partnership.aTerms.linkageKeys.slice(1),
  };
  saveConfig(partnership.a.config, {
    ...readSpec(partnership.a.config),
    linkageTerms: edited,
    metadata: metadataWith("notes", "county"),
  });
  return edited;
}

function readSpec(configPath: string): ExchangeSpec {
  return parseExchangeSpec(YAML.parse(fs.readFileSync(configPath, "utf8")));
}

function argv(
  command: string,
  party: Party,
  extra: Record<string, unknown> = {},
): Arguments {
  return {
    _: [command],
    $0: "alcove",
    "config-file": party.config,
    "key-file": party.key,
    "log-level": "info",
    ...extra,
  } as unknown as Arguments;
}

/** Run `alcove update` for Agency A, returning the printed update and what
 *  the run wrote to stderr. */
async function runUpdateWithStderr(): Promise<{
  printed: string;
  stderr: string;
}> {
  const printedLines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      printedLines.push(args.map(String).join(" "));
    });
  const stdio = captureStdio();
  try {
    await updateHandler(argv("update", partnership.a));
  } finally {
    stdio.restore();
    logSpy.mockRestore();
  }
  const printed = printedLines.join("\n").trim();
  expect(printed).not.toBe("");
  return { printed, stderr: stdio.stderrWrites.join("") };
}

/** Run `alcove update` for Agency A, returning the printed update. */
async function runUpdate(): Promise<string> {
  return (await runUpdateWithStderr()).printed;
}

/** The distinctive clause of the warning `alcove update` logs when it
 *  replaces a present payload.send. */
const REPLACED_SEND_CLAUSE = "named other columns than its metadata sends";

/** Run `alcove apply` for Agency B; returns stderr and the exit code. */
async function runApply(
  update: string,
  party: Party = partnership.b,
  extra: Record<string, unknown> = {},
): Promise<{ stderr: string; exit: string | undefined }> {
  const exitSpy = captureProcessExit();
  const stdio = captureStdio();
  let exit: string | undefined;
  try {
    await applyHandler(argv("apply", party, { args: [update], ...extra }));
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  } finally {
    stdio.restore();
    exitSpy.mockRestore();
  }
  return { stderr: stdio.stderrWrites.join(""), exit };
}

beforeEach(() => {
  partnership = establishPartnership();
  promptConfirmMock.mockReset();
});

afterEach(() => {
  fs.rmSync(partnership.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("alcove update", () => {
  test("prints the edited terms and disclosed columns, authenticated under the key file's secret", async () => {
    const edited = editAgencyA();
    const keyBefore = fs.readFileSync(partnership.a.key, "utf8");
    const printed = await runUpdate();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    expect(update.linkageTerms).toEqual({
      ...edited,
      payload: { send: [{ name: "notes" }, { name: "county" }] },
    });
    expect(printed).not.toContain(partnership.secret);
    expect(fs.readFileSync(partnership.a.key, "utf8")).toBe(keyBefore);
  });

  test("prints the update core's shared composition encodes for the configuration", async () => {
    editAgencyA();
    const spec = readSpec(partnership.a.config);
    const printed = await runUpdate();

    expect(printed).toBe(
      await encodeTermsUpdate(
        termsUpdateFor(spec.linkageTerms, spec.metadata),
        partnership.secret,
      ),
    );
  });

  test("writes the stated payload.send into a configuration that leaves it unset, keeping comments", async () => {
    fs.writeFileSync(
      partnership.a.config,
      "# operator-authored note\n" +
        fs.readFileSync(partnership.a.config, "utf8"),
    );
    const { printed, stderr } = await runUpdateWithStderr();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    expect(update.linkageTerms.payload?.send).toEqual([{ name: "notes" }]);
    const raw = fs.readFileSync(partnership.a.config, "utf8");
    expect(raw).toContain("# operator-authored note");
    // Filling an unset payload.send replaces nothing the operator wrote.
    expect(stderr).not.toContain(REPLACED_SEND_CLAUSE);
    expect(readSpec(partnership.a.config).linkageTerms).toEqual(
      update.linkageTerms,
    );
  });

  test("leaves a configuration already stating the send set byte-identical", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: {
        ...partnership.aTerms,
        payload: { send: [{ name: "notes" }] },
      },
    });
    const before = fs.readFileSync(partnership.a.config, "utf8");
    const printed = await runUpdate();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    expect(update.linkageTerms.payload?.send).toEqual([{ name: "notes" }]);
    expect(fs.readFileSync(partnership.a.config, "utf8")).toBe(before);
  });

  test("states no send set and leaves the configuration unchanged without a metadata block", async () => {
    const { metadata: _metadata, ...withoutMetadata } = readSpec(
      partnership.a.config,
    );
    saveConfig(partnership.a.config, withoutMetadata);
    const before = fs.readFileSync(partnership.a.config, "utf8");
    const printed = await runUpdate();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    expect(update.linkageTerms.payload?.send).toBeUndefined();
    expect(fs.readFileSync(partnership.a.config, "utf8")).toBe(before);
  });

  test("states the metadata's columns over a payload.send naming others, rewrites it, and warns", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: {
        ...partnership.aTerms,
        payload: { send: [{ name: "notes" }] },
      },
      metadata: metadataWith("notes", "county"),
    });
    const { printed, stderr } = await runUpdateWithStderr();

    const update = await decodeTermsUpdate(printed, partnership.secret);
    const stated = [{ name: "notes" }, { name: "county" }];
    expect(update.linkageTerms.payload?.send).toEqual(stated);
    expect(readSpec(partnership.a.config).linkageTerms.payload?.send).toEqual(
      stated,
    );
    expect(stderr).toContain(
      `linkage_terms.payload.send in ${partnership.a.config} ${REPLACED_SEND_CLAUSE}`,
    );
    expect(stderr).toContain("change is_payload or role");
    expect(stderr).toContain("generate the terms update again");
    expect(stderr.split(REPLACED_SEND_CLAUSE)).toHaveLength(2);
  });

  test("refuses without a key file, printing nothing", async () => {
    fs.rmSync(partnership.a.key);
    const exitSpy = captureProcessExit();
    const printed: unknown[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    const stdio = captureStdio();
    try {
      await expect(
        updateHandler(argv("update", partnership.a)),
      ).rejects.toThrow("exit:64");
    } finally {
      stdio.restore();
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(printed).toEqual([]);
    expect(stdio.stderrWrites.join("")).toContain("no key file at");
  });
});

describe("alcove apply", () => {
  test("rewrites the linkage terms and refreshes the record in one write", async () => {
    const edited = editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);

    const stated = await decodeTermsUpdate(update, partnership.secret);
    const after = readSpec(partnership.b.config);
    expect(after.linkageTerms).toEqual(
      deriveAcceptedLinkageTerms(stated.linkageTerms, "Agency B", false),
    );
    expect(after.linkageTerms.payload?.receive).toEqual([
      { name: "notes" },
      { name: "county" },
    ]);
    expect(after.expectedPartnerDeduplicate).toBe(edited.deduplicate);
  });

  test("records the partner's changed deduplicate and keeps this party's own", async () => {
    const edited: LinkageTerms = { ...partnership.aTerms, deduplicate: true };
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: edited,
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain("your partner's deduplicate");
    const after = readSpec(partnership.b.config);
    expect(after.expectedPartnerDeduplicate).toBe(true);
    expect(after.linkageTerms.deduplicate).toBe(false);
  });

  test("neither rotates the shared secret nor touches the connection block", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);
    const keyBefore = fs.readFileSync(partnership.b.key, "utf8");
    const connectionBefore = readSpec(partnership.b.config).connection;

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(fs.readFileSync(partnership.b.key, "utf8")).toBe(keyBefore);
    expect(readSpec(partnership.b.config).connection).toEqual(connectionBefore);
  });

  test("states a disclosed-column change on its own line, apart from the terms", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(lines).toContain("  columns you will receive: change");
    expect(
      lines.some((line) => line.startsWith("  linkage terms: linkage_keys")),
    ).toBe(true);
    expect(lines).toContain("      county");
  });

  test("a disclosure-only update reports a payload change of the linkage terms", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      metadata: metadataWith("notes", "county"),
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(lines).toContain(
      "  linkage terms: payload change (the new terms follow)",
    );
    expect(lines).toContain("  columns you will receive: change");
  });

  test("applies terms whose payload.send differs from what this party's metadata transmits", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: { ...partnership.aTerms, payload: { receive: [] } },
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(true);

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    const after = readSpec(partnership.b.config);
    expect(after.linkageTerms.payload?.send).toEqual([]);
    expect(after.metadata).toEqual(metadataWith("program"));
  });

  test("declining leaves the configuration byte-identical", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue(false);
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain(
      "update declined; the configuration was not changed",
    );
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("--consent-to-terms applies the update without asking, reading no answer", async () => {
    editAgencyA();
    const update = await runUpdate();

    const { exit, stderr } = await runApply(update, partnership.b, {
      "consent-to-terms": true,
    });
    expect(exit).toBeUndefined();
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(stderr).toContain("--consent-to-terms given");
    const stated = await decodeTermsUpdate(update, partnership.secret);
    expect(readSpec(partnership.b.config).linkageTerms).toEqual(
      deriveAcceptedLinkageTerms(stated.linkageTerms, "Agency B", false),
    );
  });

  test("--consent-to-terms still refuses an update made for another partnership", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms },
      generateSharedSecret(),
    );
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(encoded, partnership.b, {
      "consent-to-terms": true,
    });
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the partnership check");
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update altered after it was made is refused by the MAC check before anything is shown", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms },
      partnership.secret,
    );
    const [body, mac] = encoded.split(".") as [string, string];
    const content = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { linkageTerms: Record<string, unknown> };
    content.linkageTerms["deduplicate"] = !partnership.aTerms.deduplicate;
    const tampered = `${Buffer.from(JSON.stringify(content)).toString(
      "base64url",
    )}.${mac}`;
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(tampered);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the MAC check");
    expect(stderr).not.toContain("Terms update details");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update made for another partnership is refused by the partnership check", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms },
      generateSharedSecret(),
    );
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(encoded);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the partnership check");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("an update made from this party's own configuration is refused", async () => {
    editAgencyA();
    const update = await runUpdate();
    const before = fs.readFileSync(partnership.a.config, "utf8");

    const { exit, stderr } = await runApply(update, partnership.a);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("names your own identity");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.a.config, "utf8")).toBe(before);
  });
});

describe("a configuration holding a retired setting", () => {
  /** Add `key` to the configuration at `configPath` as written YAML. */
  function addRetiredSetting(configPath: string, key: string): void {
    const doc = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(configPath, YAML.stringify({ ...doc, [key]: ["notes"] }));
  }

  test.each([
    "disclosed_payload_columns",
    "outbound_payload_consent",
    "expected_payload_columns",
  ])(
    "alcove update refuses one holding %s before printing anything, naming the key and the remedy",
    async (key) => {
      addRetiredSetting(partnership.a.config, key);
      const before = fs.readFileSync(partnership.a.config, "utf8");
      const exitSpy = captureProcessExit();
      const printed: unknown[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          printed.push(...args);
        });
      const stdio = captureStdio();
      try {
        await expect(
          updateHandler(argv("update", partnership.a)),
        ).rejects.toThrow("exit:64");
      } finally {
        stdio.restore();
        exitSpy.mockRestore();
        logSpy.mockRestore();
      }
      expect(printed).toEqual([]);
      expect(stdio.stderrWrites.join("")).toContain(
        `the setting "${key}" is retired; delete it from the file`,
      );
      expect(fs.readFileSync(partnership.a.config, "utf8")).toBe(before);
    },
  );

  test.each([
    "disclosed_payload_columns",
    "outbound_payload_consent",
    "expected_payload_columns",
  ])(
    "alcove apply refuses one holding %s, naming the key and the remedy",
    async (key) => {
      editAgencyA();
      const update = await runUpdate();
      addRetiredSetting(partnership.b.config, key);
      const before = fs.readFileSync(partnership.b.config, "utf8");

      const { exit, stderr } = await runApply(update);
      expect(exit).toBe("exit:64");
      expect(stderr).toContain(
        `the setting "${key}" is retired; delete it from the file`,
      );
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
    },
  );
});
