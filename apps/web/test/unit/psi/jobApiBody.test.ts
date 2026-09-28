import { describe, expect, test } from "vitest";

import {
  JobApiBodyError,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
  readJsonOrNull,
} from "@psi/jobClient/jobApiBody";

// The response side every job-API client takes over core's bounded read
// (whose own cases are packages/core/test/utils/boundedJsonBody.test.ts): the
// throwing form raises JobApiBodyError rather than the SyntaxError a platform
// `json()` raises, and the nullable form reads a failure as null.

const encoder = new TextEncoder();

/** A Response whose body enqueues one chunk and then errors, the state a dropped
 * connection or a reset response leaves the read in. */
function failingStreamResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"status":"suc'));
      controller.error(new Error("connection reset"));
    },
  });
  return new Response(stream);
}

/** A Response carrying exactly `bytes`, with no Content-Length claim of its own. */
function byteResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readBoundedJson raises rather than returning a partial answer", () => {
  test("a body within the cap resolves to the parsed value", async () => {
    const response = byteResponse(encoder.encode('{"status":"succeeded"}'));
    await expect(
      readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
    ).resolves.toEqual({ status: "succeeded" });
  });

  test("a body over the cap raises rather than resolving to its value", async () => {
    // Valid JSON, only too large, so the refusal is the cap and not the shape.
    const body = JSON.stringify({ pad: "a".repeat(64 * 1024) });
    await expect(
      readBoundedJson(
        byteResponse(encoder.encode(body)),
        MAX_JOB_STATUS_RESPONSE_BYTES,
      ),
    ).rejects.toBeInstanceOf(JobApiBodyError);
  });

  test("an unreadable body raises", async () => {
    for (const body of ["}{ not json", ""]) {
      await expect(
        readBoundedJson(byteResponse(encoder.encode(body)), 1024),
      ).rejects.toBeInstanceOf(JobApiBodyError);
    }
  });

  test("a body that fails part-way through the stream raises, and reads as null", async () => {
    await expect(
      readBoundedJson(failingStreamResponse(), MAX_JOB_STATUS_RESPONSE_BYTES),
    ).rejects.toBeInstanceOf(JobApiBodyError);
    await expect(
      readJsonOrNull(failingStreamResponse(), MAX_JOB_STATUS_RESPONSE_BYTES),
    ).resolves.toBeNull();
  });

  test("the raised message holds none of the body's bytes", async () => {
    const secret = "operator-secret-value";
    const error = await readBoundedJson(
      byteResponse(encoder.encode(`{"leak": "${secret}"`)),
      1024,
    ).catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(JobApiBodyError);
    expect((error as Error).message).not.toContain(secret);
  });
});
