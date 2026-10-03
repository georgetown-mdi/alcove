import { afterEach, describe, expect, test, vi } from "vitest";

import {
  probeSignalingServer,
  runReadinessCheck,
  signalingSocketUrl,
} from "@recurring/readinessCheck";

// The readiness check's signaling probe and its composition, with the socket
// and the platform readings injected. The folder half needs real directory
// handles and is driven in test/browser/keepRunningSection.test.ts.

/** A socket the test opens, fails or leaves silent. */
function fakeSocket() {
  const listeners = new Map<string, () => void>();
  return {
    closed: 0,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    close() {
      this.closed += 1;
    },
    fire(type: "open" | "error" | "close") {
      listeners.get(type)?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("signalingSocketUrl", () => {
  test("is the address the PeerJS client dials", () => {
    expect(
      signalingSocketUrl({
        host: "alcove.example",
        path: "/api/",
        secure: true,
      }),
    ).toBe("wss://alcove.example:443/api/peerjs");
    expect(
      signalingSocketUrl({
        host: "127.0.0.1",
        port: 3000,
        path: "/api/",
        secure: false,
      }),
    ).toBe("ws://127.0.0.1:3000/api/peerjs");
  });
});

describe("probeSignalingServer", () => {
  const address = {
    host: "127.0.0.1",
    port: 3000,
    path: "/api/",
    secure: false,
  };

  test("an accepted connection is an answer, and the socket is closed", async () => {
    const socket = fakeSocket();
    const urls: Array<string> = [];
    const answer = probeSignalingServer(address, {
      createSocket: (url) => {
        urls.push(url);
        return socket;
      },
    });
    socket.fire("open");
    await expect(answer).resolves.toBe(true);
    expect(urls).toEqual(["ws://127.0.0.1:3000/api/peerjs"]);
    expect(socket.closed).toBe(1);
  });

  test("an error before the connection opens is no answer", async () => {
    const socket = fakeSocket();
    const answer = probeSignalingServer(address, {
      createSocket: () => socket,
    });
    socket.fire("error");
    socket.fire("open");
    await expect(answer).resolves.toBe(false);
    expect(socket.closed).toBe(1);
  });

  test("silence past the bound is no answer", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const answer = probeSignalingServer(address, {
      createSocket: () => socket,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe(false);
    expect(socket.closed).toBe(1);
  });

  test("a socket that cannot be constructed is no answer", async () => {
    await expect(
      probeSignalingServer(address, {
        createSocket: () => {
          throw new SyntaxError("bad url");
        },
      }),
    ).resolves.toBe(false);
  });
});

describe("runReadinessCheck", () => {
  test("combines the readings", async () => {
    const report = await runReadinessCheck(undefined, {
      isInstalledRuntime: () => true,
      isOnline: () => true,
      probeSignalingServer: () => Promise.resolve(true),
      checkWorkingFolder: () => Promise.resolve("ready"),
    });
    expect(report).toEqual({
      installedRuntime: true,
      folder: "ready",
      signaling: "answered",
    });
  });

  test("an offline browser seeks no answer", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const report = await runReadinessCheck(undefined, {
      isInstalledRuntime: () => false,
      isOnline: () => false,
      probeSignalingServer: probe,
      checkWorkingFolder: () => Promise.resolve("none"),
    });
    expect(report.signaling).toBe("offline");
    expect(probe).not.toHaveBeenCalled();
  });

  test("an unanswered probe reads as no answer", async () => {
    const report = await runReadinessCheck(undefined, {
      isInstalledRuntime: () => true,
      isOnline: () => true,
      probeSignalingServer: () => Promise.resolve(false),
      checkWorkingFolder: () => Promise.resolve("ready"),
    });
    expect(report.signaling).toBe("noAnswer");
  });
});
