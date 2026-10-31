import crypto from "node:crypto";
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
  return { ...actual, promptConfirmOrClosed: vi.fn() };
});

import { handler as applyHandler } from "../../../src/commands/apply";
import { handler as updateHandler } from "../../../src/commands/update";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { termsProposalPath } from "../../../src/termsChange";
import { promptConfirmOrClosed } from "../../../src/util/prompt";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirmOrClosed);

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
/** The JSON body of an encoded terms update. */
function updateBody(encoded: string): Record<string, unknown> {
  const [body] = encoded.split(".") as [string];
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** `content` as a terms update authenticated under `secret`, by the MAC
 * derivation docs/spec/EXCHANGE_FILE.md states (HKDF-SHA-256, zero salt). */
function authenticatedUpdate(content: object, secret: string): string {
  const bytes = Buffer.from(JSON.stringify(content), "utf8");
  const macKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "base64url"),
      Buffer.alloc(0),
      "alcove-terms-update-v2:mac",
      32,
    ),
  );
  const mac = crypto.createHmac("sha256", macKey).update(bytes).digest();
  return `${bytes.toString("base64url")}.${mac.toString("base64url")}`;
}

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

let stdinIsTTY: PropertyDescriptor | undefined;

beforeEach(() => {
  partnership = establishPartnership();
  promptConfirmMock.mockReset();
  // apply asks only at a terminal; a test of the unattended refusal sets it
  // back to undefined.
  stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  fs.rmSync(partnership.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (stdinIsTTY !== undefined)
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

function stdinIsNotATerminal(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
}

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
    promptConfirmMock.mockResolvedValue("yes");

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
    promptConfirmMock.mockResolvedValue("yes");

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
    promptConfirmMock.mockResolvedValue("yes");
    const keyBefore = fs.readFileSync(partnership.b.key, "utf8");
    const connectionBefore = readSpec(partnership.b.config).connection;

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(fs.readFileSync(partnership.b.key, "utf8")).toBe(keyBefore);
    expect(readSpec(partnership.b.config).connection).toEqual(connectionBefore);
  });

  test("states a disclosed-column change in its own section, apart from the other terms", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(lines).toContain("  columns your partner now sends you:");
    expect(lines).toContain("    county");
    expect(lines).toContain("  other terms that differ:");
    expect(
      lines.some((line) => line.startsWith("    linkage keys do not match")),
    ).toBe(true);
  });

  test("a disclosure-only update states the column and no other term", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      metadata: metadataWith("notes", "county"),
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(lines).toContain("  columns your partner now sends you:");
    expect(lines).toContain("    county");
    // Neither the comparison's section nor the line naming a changed term it
    // does not show: the column change is shown in its own section.
    expect(lines.filter((line) => line.includes("other terms that"))).toEqual(
      [],
    );
  });

  test("a description-only update is applied without asking", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: {
        ...partnership.aTerms,
        payload: {
          send: [{ name: "notes", description: "case notes, reworded" }],
        },
      },
    });
    const update = await runUpdate();

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(stderr).toContain("changes no linkage term");
    expect(stderr).not.toContain("Changes this update makes");
    expect(
      readSpec(partnership.b.config).linkageTerms.payload?.receive,
    ).toEqual([{ name: "notes", description: "case notes, reworded" }]);
  });

  test("an update changing a term the comparison shows still names one it does not", async () => {
    // Agency B's empty payload block against an update stating none: no
    // column direction for the comparison to show, beside linkage keys it does.
    const spec = readSpec(partnership.b.config);
    saveConfig(partnership.b.config, {
      ...spec,
      linkageTerms: { ...spec.linkageTerms, payload: {} },
    });
    const { metadata: _metadata, ...withoutMetadata } = readSpec(
      partnership.a.config,
    );
    saveConfig(partnership.a.config, {
      ...withoutMetadata,
      linkageTerms: {
        ...partnership.aTerms,
        linkageKeys: partnership.aTerms.linkageKeys.slice(1),
      },
    });
    const update = await runUpdate();
    expect(
      (await decodeTermsUpdate(update, partnership.secret)).linkageTerms
        .payload,
    ).toBeUndefined();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(
      lines.some((line) => line.startsWith("    linkage keys do not match")),
    ).toBe(true);
    expect(lines).toContain("  other terms that change: payload");
  });

  test("an update stating no columns the partner receives asks before dropping this party's send", async () => {
    const spec = readSpec(partnership.b.config);
    saveConfig(partnership.b.config, {
      ...spec,
      linkageTerms: {
        ...spec.linkageTerms,
        payload: { ...spec.linkageTerms.payload, send: [{ name: "program" }] },
      },
    });
    const update = await runUpdate();
    expect(
      (await decodeTermsUpdate(update, partnership.secret)).linkageTerms.payload
        ?.receive,
    ).toBeUndefined();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(lines).toContain("  columns you send: change");
    expect(lines).toContain("      program");
    expect(lines.some((line) => line.startsWith("    after: not stated"))).toBe(
      true,
    );
  });

  test("an update filling the columns a configuration lists none of asks", async () => {
    const spec = readSpec(partnership.b.config);
    const { payload: _payload, ...withoutPayload } = spec.linkageTerms;
    saveConfig(partnership.b.config, { ...spec, linkageTerms: withoutPayload });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(lines).toContain("  linkage terms: no change");
    expect(lines).toContain("  columns you will receive: change");
    expect(lines).toContain("      notes");
  });

  test("an update leaving the received columns unstated shows before and after, not columns removed", async () => {
    const { metadata: _metadata, ...withoutMetadata } = readSpec(
      partnership.a.config,
    );
    saveConfig(partnership.a.config, withoutMetadata);
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(lines).not.toContain("  columns your partner no longer sends you:");
    expect(lines).toContain("  columns you will receive: change");
    expect(lines).toContain("    before:");
    expect(lines).toContain("      notes");
    expect(lines).toContain(
      "    after: not stated -- the next exchange takes whatever columns your partner sends",
    );
  });

  test("an update recording the partner's deduplicate for the first time asks", async () => {
    const { expectedPartnerDeduplicate: _unused, ...unrecorded } = readSpec(
      partnership.b.config,
    );
    saveConfig(partnership.b.config, unrecorded);
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");

    const { stderr } = await runApply(update);
    const lines = stderr.split("\n");
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(lines).toContain("  linkage terms: no change");
    expect(lines).toContain("  your partner's deduplicate: recorded as false");
  });

  test("applies terms whose payload.send differs from what this party's metadata transmits", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: { ...partnership.aTerms, payload: { receive: [] } },
    });
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("yes");

    const { exit } = await runApply(update);
    expect(exit).toBeUndefined();
    const after = readSpec(partnership.b.config);
    expect(after.linkageTerms.payload?.send).toEqual([]);
    expect(after.metadata).toEqual(metadataWith("program"));
  });

  test("declining leaves the configuration byte-identical", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("no");
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain(
      "update declined; the configuration was not changed",
    );
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("with no terminal on stdin, apply is refused before it shows the terms, changing nothing", async () => {
    editAgencyA();
    const update = await runUpdate();
    stdinIsNotATerminal();
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBe("exit:64");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(stderr).toContain("standard input is not a terminal");
    expect(stderr).toContain("with docker, add -it");
    expect(stderr).toContain("--consent-to-terms");
    expect(stderr).not.toContain("update declined");
    expect(stderr).not.toContain("Changes this update makes");
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });

  test("with no terminal on stdin, a description-only update is still applied", async () => {
    saveConfig(partnership.a.config, {
      ...readSpec(partnership.a.config),
      linkageTerms: {
        ...partnership.aTerms,
        payload: {
          send: [{ name: "notes", description: "case notes, reworded" }],
        },
      },
    });
    const update = await runUpdate();
    stdinIsNotATerminal();

    const { exit, stderr } = await runApply(update);
    expect(exit).toBeUndefined();
    expect(stderr).toContain("changes no linkage term");
    expect(
      readSpec(partnership.b.config).linkageTerms.payload?.receive,
    ).toEqual([{ name: "notes", description: "case notes, reworded" }]);
  });

  test("stdin closing at the question is refused, not taken as a decline", async () => {
    editAgencyA();
    const update = await runUpdate();
    promptConfirmMock.mockResolvedValue("closed");
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("standard input ended at the question above");
    expect(stderr).toContain("with docker, add -it");
    expect(stderr).not.toContain("update declined");
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

  test.each([
    [
      "a newer format version",
      (content: Record<string, unknown>) => ({ ...content, version: "2" }),
      "This terms update is format version 2, made by a newer version of Alcove",
    ],
    [
      "a member it does not read",
      (content: Record<string, unknown>) => ({
        ...content,
        fromALaterBuild: 1,
      }),
      'This terms update has the field "fromALaterBuild"',
    ],
  ])(
    "an update with %s is refused by the decoder's own message and remedy alone",
    async (_case, edit, refusal) => {
      const content = updateBody(
        await encodeTermsUpdate(
          { linkageTerms: partnership.aTerms },
          partnership.secret,
        ),
      );
      const before = fs.readFileSync(partnership.b.config, "utf8");

      const { exit, stderr } = await runApply(
        authenticatedUpdate(edit(content), partnership.secret),
      );
      expect(exit).toBe("exit:64");
      expect(stderr).toContain(refusal);
      expect(stderr).toContain(
        "Update Alcove, then try the terms update again. Nothing was changed.",
      );
      expect(stderr).not.toContain("could not be read");
      expect(stderr).not.toContain("alcove update' again");
      expect(stderr).not.toContain("..");
      expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
    },
  );

  test("an update that is not an Alcove terms update keeps the read refusal and its remedy", async () => {
    const { linkageTerms: _terms, ...content } = updateBody(
      await encodeTermsUpdate(
        { linkageTerms: partnership.aTerms },
        partnership.secret,
      ),
    );

    const { exit, stderr } = await runApply(
      authenticatedUpdate(content, partnership.secret),
    );
    expect(exit).toBe("exit:64");
    expect(stderr).toContain(
      "the terms update could not be read: this is not an Alcove terms update",
    );
    expect(stderr).toContain("Ask your partner to run 'alcove update' again");
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

  test("a partnership refusal points at the terms proposal an exchange wrote beside the configuration", async () => {
    const stale = await encodeTermsUpdate(
      { linkageTerms: partnership.aTerms },
      generateSharedSecret(),
    );
    const proposal = termsProposalPath(partnership.b.config);
    fs.writeFileSync(
      proposal,
      `${await encodeTermsUpdate(
        { linkageTerms: partnership.aTerms },
        partnership.secret,
      )}\n`,
    );

    const { exit, stderr } = await runApply(stale);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("refused by the partnership check");
    expect(stderr).not.toContain("\\x0a");
    const lines = stderr.split("\n");
    expect(lines).toContain(
      `To fix, apply the terms your last exchange with your partner wrote to ${proposal}:`,
    );
    expect(lines).toContain(
      `  alcove apply --config-file ${partnership.b.config} --key-file ${partnership.b.key} @${proposal}`,
    );
    expect(lines).toContain(
      "If those are not the terms you expect, ask your partner to run " +
        "'alcove update' again from the configuration and key file they use " +
        "with you.",
    );

    // The proposal itself, applied, takes no such pointer to itself.
    const { exit: proposalExit } = await runApply(
      `@${proposal}`,
      partnership.b,
      {
        "consent-to-terms": true,
      },
    );
    expect(proposalExit).toBeUndefined();
  });

  test.each([
    ["an absolute", (proposal: string) => proposal],
    [
      "a relative",
      (proposal: string) => path.relative(process.cwd(), proposal),
    ],
    [
      "a ./-relative",
      (proposal: string) =>
        `.${path.sep}${path.relative(process.cwd(), proposal)}`,
    ],
  ])(
    "a refused proposal named by %s path takes no pointer to itself",
    async (_spelling, spell) => {
      const proposal = termsProposalPath(partnership.b.config);
      fs.writeFileSync(
        proposal,
        `${await encodeTermsUpdate(
          { linkageTerms: partnership.aTerms },
          generateSharedSecret(),
        )}\n`,
      );

      // path.relative across Windows drives returns an absolute path, so the
      // run starts on the proposal's own drive.
      const cwd = process.cwd();
      process.chdir(path.dirname(proposal));
      let ran: Awaited<ReturnType<typeof runApply>>;
      try {
        ran = await runApply(`@${spell(proposal)}`);
      } finally {
        process.chdir(cwd);
      }
      const { exit, stderr } = ran;
      expect(exit).toBe("exit:64");
      expect(stderr).toContain("refused by the partnership check");
      expect(stderr).not.toContain("To fix, apply the terms");
    },
  );

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

describe("a configuration holding an unrecognized top-level key", () => {
  /** Add `key` to the configuration at `configPath` as written YAML. */
  function addUnrecognizedKey(configPath: string, key: string): void {
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
  ])("alcove apply refuses one holding %s, naming the key", async (key) => {
    editAgencyA();
    const update = await runUpdate();
    addUnrecognizedKey(partnership.b.config, key);
    const before = fs.readFileSync(partnership.b.config, "utf8");

    const { exit, stderr } = await runApply(update);
    expect(exit).toBe("exit:64");
    expect(stderr).toContain(`Unrecognized key: "${key}"`);
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(partnership.b.config, "utf8")).toBe(before);
  });
});
