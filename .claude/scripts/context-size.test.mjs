import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  findTranscript,
  lastPromptTokens,
  promptTokens,
} from "./context-size.mjs";

const SCRIPT = fileURLToPath(new URL("./context-size.mjs", import.meta.url));

const usage = (input, created, read) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: 900,
});

const assistant = (fields) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { model: "claude-test", usage: usage(2, 3000, 120000) },
    ...fields,
  });

const transcriptText = (...lines) => `${lines.join("\n")}\n`;

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A config directory holding one transcript, under a project of its own. */
function configWith(sessionId, text) {
  const root = mkdtempSync(join(tmpdir(), "context-size-"));
  roots.push(root);
  mkdirSync(join(root, "projects", "-other"), { recursive: true });
  mkdirSync(join(root, "projects", "-work-tree"), { recursive: true });
  writeFileSync(
    join(root, "projects", "-work-tree", `${sessionId}.jsonl`),
    text,
  );
  return root;
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

describe("promptTokens", () => {
  it("sums the uncached, cache-write and cache-read input", () => {
    expect(promptTokens(usage(2, 3000, 120000))).toBe(123002);
  });

  it("counts a missing or non-numeric field as zero", () => {
    expect(promptTokens({ cache_read_input_tokens: 5 })).toBe(5);
    expect(
      promptTokens({ input_tokens: "7", cache_read_input_tokens: 5 }),
    ).toBe(5);
    expect(promptTokens(undefined)).toBe(0);
    expect(promptTokens(null)).toBe(0);
  });
});

describe("lastPromptTokens", () => {
  it("reads the last assistant entry, not an earlier one", () => {
    const text = transcriptText(
      assistant({ message: { usage: usage(1, 10, 100) } }),
      JSON.stringify({ type: "user", message: { content: "next" } }),
      assistant({ message: { usage: usage(2, 20, 200) } }),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
    );
    expect(lastPromptTokens(text)).toBe(222);
  });

  it("skips an API-error entry whose usage is all zero", () => {
    const text = transcriptText(
      assistant({ message: { usage: usage(2, 20, 200) } }),
      assistant({
        isApiErrorMessage: true,
        message: { model: "<synthetic>", usage: usage(0, 0, 0) },
      }),
    );
    expect(lastPromptTokens(text)).toBe(222);
  });

  it("skips a sidechain entry and an entry with no usage", () => {
    const text = transcriptText(
      assistant({ message: { usage: usage(2, 20, 200) } }),
      assistant({ isSidechain: true, message: { usage: usage(9, 9, 9000) } }),
      assistant({ message: { content: [] } }),
    );
    expect(lastPromptTokens(text)).toBe(222);
  });

  it("skips a line still being written", () => {
    const text = `${assistant({ message: { usage: usage(2, 20, 200) } })}\n{"type":"assist`;
    expect(lastPromptTokens(text)).toBe(222);
  });

  it("reads the compacted context after a compaction boundary", () => {
    const text = transcriptText(
      assistant({ message: { usage: usage(2, 900, 640000) } }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preTokens: 640902, postTokens: 12000 },
      }),
      assistant({ message: { usage: usage(3, 12000, 0) } }),
    );
    expect(lastPromptTokens(text)).toBe(12003);
  });

  it("is null for a transcript with no model call", () => {
    expect(
      lastPromptTokens(transcriptText(JSON.stringify({ type: "user" }))),
    ).toBeNull();
    expect(lastPromptTokens("")).toBeNull();
  });
});

describe("findTranscript", () => {
  it("finds the session's file in whichever project directory holds it", () => {
    const root = configWith("abc-123", transcriptText(assistant({})));
    expect(findTranscript(root, "abc-123")).toBe(
      join(root, "projects", "-work-tree", "abc-123.jsonl"),
    );
  });

  it("is null for an unknown session or a missing projects directory", () => {
    const root = configWith("abc-123", transcriptText(assistant({})));
    expect(findTranscript(root, "other-session")).toBeNull();
    expect(findTranscript(join(root, "absent"), "abc-123")).toBeNull();
  });
});

describe("the command", () => {
  it("prints the session's context size from the environment", () => {
    const root = configWith("abc-123", transcriptText(assistant({})));
    const result = run([], {
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_SESSION_ID: "abc-123",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("123002 tokens\n");
  });

  it("reads a transcript named on the command line", () => {
    const root = configWith(
      "abc-123",
      transcriptText(assistant({ message: { usage: usage(4, 0, 0) } })),
    );
    const result = run(
      [join(root, "projects", "-work-tree", "abc-123.jsonl")],
      {
        CLAUDE_CODE_SESSION_ID: "",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("4 tokens\n");
  });

  it("fails naming the variable when no session id is set", () => {
    const result = run([], { CLAUDE_CODE_SESSION_ID: "" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/CLAUDE_CODE_SESSION_ID is not set/);
  });

  it("fails naming the session when no transcript holds it", () => {
    const root = configWith("abc-123", transcriptText(assistant({})));
    const result = run([], {
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_SESSION_ID: "missing-session",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No transcript for session missing-session/);
  });

  it("fails when the transcript records no model call", () => {
    const root = configWith(
      "abc-123",
      transcriptText(JSON.stringify({ type: "user" })),
    );
    const result = run([], {
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_SESSION_ID: "abc-123",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/records no model call yet/);
  });

  it("refuses more than one argument with the usage", () => {
    const result = run(["a.jsonl", "b.jsonl"], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Usage: node context-size\.mjs/);
  });
});
