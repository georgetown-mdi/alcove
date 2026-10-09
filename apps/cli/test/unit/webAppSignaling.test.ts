import { describe, expect, test } from "vitest";
import { ConnectionError, UsageError } from "@alcove/core";

import { exitCodeForError } from "../../src/util/exit";
import { resolveWebAppSignalingServer } from "../../src/webAppSignaling";

const APP = new URL("https://app.example.org/");
const INVITE_REMEDY =
  "Give the coordination server itself as a wss://<server>/api/ URL, or " +
  "author `channel: webrtc` in alcove.yaml and run 'alcove exchange'.";

async function refusal(fetch: typeof globalThis.fetch): Promise<Error> {
  try {
    await resolveWebAppSignalingServer(APP, { fetch });
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("the CLI's resolveWebAppSignalingServer", () => {
  test("passes core's answer through", async () => {
    const server = await resolveWebAppSignalingServer(APP, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ signaling_server: "wss://signal.example.org/" }),
          ),
        ),
    });
    expect(server.href).toBe("wss://signal.example.org/");
  });

  test("ends an unusable answer on what to give alcove invite, exit 64", async () => {
    const err = await refusal(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    expect(err).toBeInstanceOf(UsageError);
    expect(exitCodeForError(err)).toBe(64);
    expect(err.message.endsWith(` ${INVITE_REMEDY}`)).toBe(true);
  });

  test("ends an unreachable app on the same remedy, exit 69", async () => {
    const err = await refusal(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(err)).toBe(69);
    expect(err.message.endsWith(` ${INVITE_REMEDY}`)).toBe(true);
  });
});
