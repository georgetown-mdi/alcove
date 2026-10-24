// Synthetic transcript records for the retro kit's tests, shaped like the
// entries Claude Code writes to a projects directory, and a writer that lays
// them out as a store. Every id here is made up.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let serial = 0;
const nextUuid = () =>
  `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

/** A session id for a fixture. */
export const sessionId = (n) =>
  `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

/**
 * A `message.usage` object. `cache5m` and `cache1h` go under `cache_creation`
 * unless `flat` is set, which writes their sum as `cache_creation_input_tokens`
 * alone.
 */
export function usage({
  input = 0,
  output = 0,
  cacheRead = 0,
  cache5m = 0,
  cache1h = 0,
  flat = false,
} = {}) {
  const u = {
    input_tokens: input,
    cache_creation_input_tokens: cache5m + cache1h,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    service_tier: "standard",
  };
  if (!flat) {
    u.cache_creation = {
      ephemeral_5m_input_tokens: cache5m,
      ephemeral_1h_input_tokens: cache1h,
    };
  }
  return u;
}

function base(ts, extra) {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/workspace",
    sessionId: sessionId(0),
    version: "2.1.300",
    gitBranch: "staging",
    uuid: nextUuid(),
    timestamp: ts,
    ...extra,
  };
}

/** An assistant entry; `id` is its message.id, `u` its usage (or null). */
export function assistant(
  ts,
  { id, u, model = "claude-opus-5-5", content, requestId, ...extra } = {},
) {
  const message = {
    type: "message",
    role: "assistant",
    model,
    content: content ?? [{ type: "text", text: "Done." }],
    stop_reason: null,
    stop_sequence: null,
  };
  if (id !== undefined) message.id = id;
  if (u !== null) message.usage = u ?? usage({ input: 1, output: 1 });
  return base(ts, {
    type: "assistant",
    requestId: requestId ?? `req_fixture_${id ?? serial}`,
    message,
    ...extra,
  });
}

/** A user entry whose content is `content` (a string or content blocks). */
export function user(ts, content, extra = {}) {
  return base(ts, {
    type: "user",
    message: { role: "user", content },
    ...extra,
  });
}

/** A user entry holding one tool result. */
export function toolResult(ts, text, { isError = false, ...extra } = {}) {
  return user(
    ts,
    [
      {
        type: "tool_result",
        tool_use_id: "toolu_fixture",
        content: text,
        is_error: isError,
      },
    ],
    extra,
  );
}

/** A `tool_use` content block. */
export const toolUse = (name, input = {}) => ({
  type: "tool_use",
  id: "toolu_fixture",
  name,
  input,
});

/** A fresh temporary directory for one test's store and outputs. */
export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "retro-kit-test-"));
}

// An entry given as a string is written as that raw line.
function writeJsonl(file, entries, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = entries.map((e) =>
    typeof e === "string" ? e : JSON.stringify(e),
  );
  fs.writeFileSync(file, lines.map((l) => l + "\n").join(""));
  fs.utimesSync(file, mtime, mtime);
}

/**
 * Write one project directory `<root>/<project>` holding `sessions`, keyed by
 * session id: `{ main, mtime?, subagents?: { [agentId]: { entries, meta?,
 * mtime? } }, workflows?: { [wfId]: { record, agents: { [agentId]: entries } } } }`.
 * Files take `mtime` (a Date) unless their session or subagent names its own.
 * Returns the project directory.
 */
export function writeProject(root, project, sessions, mtime) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, s] of Object.entries(sessions)) {
    writeJsonl(path.join(dir, `${id}.jsonl`), s.main, s.mtime ?? mtime);
    for (const [agentId, a] of Object.entries(s.subagents ?? {})) {
      const file = path.join(dir, id, "subagents", `${agentId}.jsonl`);
      writeJsonl(file, a.entries, a.mtime ?? mtime);
      if (a.meta) {
        fs.writeFileSync(
          file.replace(/\.jsonl$/, ".meta.json"),
          JSON.stringify(a.meta),
        );
      }
    }
    for (const [wfId, w] of Object.entries(s.workflows ?? {})) {
      fs.mkdirSync(path.join(dir, id, "workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, id, "workflows", `${wfId}.json`),
        JSON.stringify(w.record),
      );
      for (const [agentId, entries] of Object.entries(w.agents)) {
        writeJsonl(
          path.join(
            dir,
            id,
            "subagents",
            "workflows",
            wfId,
            `${agentId}.jsonl`,
          ),
          entries,
          mtime,
        );
      }
    }
  }
  return dir;
}
