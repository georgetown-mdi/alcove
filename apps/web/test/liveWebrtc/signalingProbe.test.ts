/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { probeSignalingServer } from "@recurring/readinessCheck";

import type { SignalingAddress } from "@psi/transport/signalingAddress";

/**
 * The readiness check's signaling probe against the real standalone broker,
 * from a real browser: what the broker does with a connection that names no
 * peer id, and what the probe makes of it and of a port nobody listens on.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startSignalingProbeBroker: () => Promise<{ port: number; path: string }>;
    stopSignalingProbeBroker: () => Promise<void>;
  }
}

let address: SignalingAddress;

beforeAll(async () => {
  const broker = await commands.startSignalingProbeBroker();
  address = {
    host: "127.0.0.1",
    port: broker.port,
    path: `${broker.path}/`,
    secure: false,
  };
});

afterAll(async () => {
  await commands.stopSignalingProbeBroker();
});

test("the broker completes the upgrade, sends an error and closes", async () => {
  const events: Array<string> = [];
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}${address.path}peerjs`,
    );
    socket.addEventListener("open", () => events.push("open"));
    socket.addEventListener("error", () => events.push("error"));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string };
      events.push(`message ${String(message.type)}`);
    });
    socket.addEventListener("close", () => {
      events.push("close");
      resolve();
    });
  });
  expect(events).toEqual(["open", "message ERROR", "close"]);
});

test("the probe treats the broker's reply as an answer", async () => {
  await expect(probeSignalingServer(address)).resolves.toBe(true);
});

test("the probe treats a port nobody listens on as no answer", async () => {
  await commands.stopSignalingProbeBroker();
  await expect(
    probeSignalingServer(address, { timeoutMs: 5_000 }),
  ).resolves.toBe(false);
});
