#!/usr/bin/env node
// PostToolUse hook on Bash: when the harness persists an oversized result to a
// file and shows the session only a preview, read that file back into context.
// The harness's notice is matched only at the start of a candidate field,
// optionally behind its <persisted-output> wrapper line, never inside the text,
// so output that quotes the notice triggers nothing. Every string-valued
// payload field is tried. The readback keeps the last READBACK_BYTES bytes of
// the file and says so when there was more. The hook cannot block: the outcome
// is an additionalContext message or silence, and every error fails open.
// Rationale and limits: docs/notes/agent-hooks-and-scripts.md.

import { readFileSync, statSync } from "node:fs";

import { eventForTools } from "./lib/event.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const READBACK_BYTES = 51200;
const CANDIDATE_FIELDS = ["output", "stdout", "content"];

// The harness's persisted-result notice, anchored to the start of the field.
const NOTICE =
  /^\s*(?:<persisted-output>\r?\n)?Output too large \([^)\r\n]*\)\. Full output saved to: ([^\r\n]+?)[ \t]*(?:\r?\n|$)/;

function candidates(toolResponse) {
  if (typeof toolResponse === "string") return [toolResponse];
  if (toolResponse === null || typeof toolResponse !== "object") return [];
  return CANDIDATE_FIELDS.map((field) => toolResponse[field]).filter(
    (value) => typeof value === "string",
  );
}

/** The persisted-output path a candidate field announces, or null. */
function savedOutputPath(toolResponse) {
  for (const candidate of candidates(toolResponse)) {
    const match = NOTICE.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

// Exit only once the payload has reached the pipe. process.exit() straight after
// write() discards whatever the stream still holds, so a payload past the OS pipe
// buffer -- exactly the long readback this hook exists for -- arrives cut off
// mid-string and unparseable. Callers return rather than leaning on emit to end
// the turn, since it no longer ends it synchronously.
function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
    }),
    () => process.exit(0),
  );
}

// A tail taken by byte count can open inside a multi-byte sequence, which would
// decode to a replacement character. Only the leading edge can be partial (the
// slice ends at EOF), and a UTF-8 sequence is at most four bytes, so at most
// three continuation bytes stand before the first whole character.
function fromCharacterBoundary(bytes) {
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start);
}

function readback(path) {
  const contents = readFileSync(path);
  if (contents.length <= READBACK_BYTES) {
    return `Full bash output (read from ${path}):\n${contents.toString("utf8")}`;
  }
  const tail = fromCharacterBoundary(
    contents.subarray(contents.length - READBACK_BYTES),
  );
  return (
    `Full bash output, last ${READBACK_BYTES} bytes of ${contents.length} ` +
    `(read from ${path} -- read that file directly for the earlier part):\n` +
    tail.toString("utf8")
  );
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool

  const path = savedOutputPath(event.tool_response);
  if (path === null) process.exit(0);

  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
  } catch {
    return emit(
      `WARNING: this command's output was too large to show and was saved to ${path}, ` +
        "but that path is not a readable file. The result above is a preview only -- " +
        "re-run the command narrowed to what you need rather than concluding from it.",
    );
  }

  try {
    emit(readback(path));
  } catch (error) {
    emit(
      `WARNING: this command's output was too large to show and was saved to ${path}, ` +
        `which could not be read back (${error?.message ?? error}). The result above is ` +
        "a preview only -- read that file directly before concluding from it.",
    );
  }
}

// The deferred exit keeps the process alive until the payload flushes, so a pipe
// the harness closes first reaches this listener instead of dying on EPIPE.
process.stdout.on("error", () => process.exit(0));

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt the session on an unexpected error
}
