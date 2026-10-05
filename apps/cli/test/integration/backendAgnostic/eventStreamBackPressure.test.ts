import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

/**
 * The fd-3 stream's no-partial-line guarantee under real back pressure
 * (docs/spec/CLI_EVENTS.md, the stream's framing). A child writes enough
 * events through the CLI's own writer to fill the descriptor's buffer many
 * times over while the parent reads slowly, so the writer meets a full buffer
 * on most writes. Both shapes a supervisor wires are driven: the socket pair
 * Node's `stdio: "pipe"` creates, and an OS pipe from a shell redirection.
 */

const EVENT_COUNT = 2_000;
const CHILD = path.join(import.meta.dirname, "eventStreamBackPressureChild.ts");
const CLI_ROOT = path.join(import.meta.dirname, "..", "..", "..");

// Reads `stream` in chunks with a pause after each, so the writer runs ahead
// of the reader for the whole run.
async function readSlowly(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.pause();
  await new Promise((settle) => setTimeout(settle, 300));
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    stream.pause();
    await new Promise((settle) => setTimeout(settle, 2));
    stream.resume();
  }
  return Buffer.concat(chunks);
}

function expectWholeLinesInOrder(received: Buffer): void {
  const text = received.toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  expect(lines).toHaveLength(EVENT_COUNT);
  lines.forEach((line, index) => {
    const event = JSON.parse(line) as { type: string; message: string };
    expect(event.type).toBe("warning");
    expect(event.message.startsWith(`${index} `)).toBe(true);
  });
}

// The child's own report: every event handed to the writer, and at least one
// fd-3 write that met a full buffer, without which the case measured nothing.
// A full buffer blocks the write on both descriptors rather than shortening it.
function expectBackPressureMet(stderr: string): void {
  const report = /emitted (\d+) short (\d+) blocked (\d+)/.exec(stderr);
  expect(report, stderr).not.toBeNull();
  const [, emitted, short, blocked] = report!.map(Number);
  expect(emitted).toBe(EVENT_COUNT);
  expect(blocked).toBeGreaterThan(0);
  expect(short).toBe(0);
}

async function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((settle) => child.once("close", settle));
}

describe("the event stream under back pressure", () => {
  test("a socket pair read slowly receives every event as one whole line", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], {
      cwd: CLI_ROOT,
      env: { ...process.env, ALCOVE_TEST_EVENT_COUNT: String(EVENT_COUNT) },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = exitOf(child);
    const received = await readSlowly(child.stdio[3] as Readable);
    expect(await exited).toBe(0);
    expectBackPressureMet(stderr);
    expectWholeLinesInOrder(received);
  }, 120_000);

  test("an OS pipe from a shell redirection, read slowly, receives every event as one whole line", async () => {
    // fd 3 is the write end of the pipe into cat; cat's output is what this
    // process reads, so a slow read here backs that pipe up.
    const child = spawn(
      "sh",
      [
        "-c",
        `"${process.execPath}" --import tsx "${CHILD}" 3>&1 >/dev/null | cat`,
      ],
      {
        cwd: CLI_ROOT,
        env: { ...process.env, ALCOVE_TEST_EVENT_COUNT: String(EVENT_COUNT) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = exitOf(child);
    const received = await readSlowly(child.stdout!);
    expect(await exited).toBe(0);
    expectBackPressureMet(stderr);
    expectWholeLinesInOrder(received);
  }, 120_000);
});
