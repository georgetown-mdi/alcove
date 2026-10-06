// Child process for eventStreamBackPressure.test.ts. It opens the event stream
// on the fd 3 its parent wired, through the CLI's own preflight and writer,
// writes ALCOVE_TEST_EVENT_COUNT warnings each near the warning budget, and
// reports on stderr how many it handed to the writer and how many fd-3 writes
// met a full buffer -- a short count, or a call that blocked -- which is how
// the parent knows back pressure was reached. Whether every event arrived
// whole is the parent's assertion.
import fs from "node:fs";

import { EVENT_STREAM_FD } from "@alcove/cli-contract";

import { openEventStream } from "../../../src/eventStream";

const BLOCKED_WRITE_MS = 5;
let shortWrites = 0;
let blockedWrites = 0;
const realWriteSync = fs.writeSync;
fs.writeSync = ((
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => {
  const started = performance.now();
  const written = realWriteSync(fd, buffer, offset, length);
  if (fd === EVENT_STREAM_FD && length > 0) {
    if (written < length) shortWrites += 1;
    if (performance.now() - started > BLOCKED_WRITE_MS) blockedWrites += 1;
  }
  return written;
}) as typeof fs.writeSync;

const count = Number(process.env.ALCOVE_TEST_EVENT_COUNT);
if (!Number.isInteger(count) || count <= 0)
  throw new Error(
    "eventStreamBackPressureChild: ALCOVE_TEST_EVENT_COUNT unset",
  );

const emitter = openEventStream(true);
if (emitter === undefined) throw new Error("no emitter for an enabled stream");
const filler = "x".repeat(4000);
for (let index = 0; index < count; index += 1)
  emitter.warning("termsExchange", `${index} ${filler}`);
process.stderr.write(
  `emitted ${count} short ${shortWrites} blocked ${blockedWrites}\n`,
);
