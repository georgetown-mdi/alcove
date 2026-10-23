import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getDefaultLinkageTerms } from "@alcove/core";

import {
  SIGNALING_PROBE_TIMEOUT_MS,
  browserReadinessCheck,
  probeSignalingServer,
  recordSignalingAddress,
  runReadinessCheck,
  signalingSocketUrl,
} from "@recurring/readinessCheck";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import type { ReadinessRecord } from "@recurring/readinessCheck";

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    {
      isConsoleBuild: () => false,
      signalingServerSetting: () => ({
        secure: true,
        host: "build-signaling.example.org",
        path: "/api/",
      }),
    },
  ),
);

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

  test("a connection the server opens and then closes is an answer", async () => {
    const socket = fakeSocket();
    const answer = probeSignalingServer(address, {
      createSocket: () => socket,
    });
    socket.fire("open");
    socket.fire("close");
    await expect(answer).resolves.toBe(true);
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

  test("silence past the default bound is no answer", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    let settled: boolean | undefined;
    void probeSignalingServer(address, {
      createSocket: () => socket,
    }).then((answered) => {
      settled = answered;
    });
    await vi.advanceTimersByTimeAsync(SIGNALING_PROBE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
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

/** A saved exchange on `side` whose record names `server`. */
function savedRecord(
  side: "inviter" | "acceptor",
  server: { host: string; port?: number; path?: string },
): ReadinessRecord {
  return {
    side,
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", ...server },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
  };
}

const SERVER_A = {
  host: "saved-signaling.example.org",
  port: 9999,
  path: "/signal/",
};

describe("runReadinessCheck", () => {
  const readings = {
    isInstalledRuntime: () => true,
    isOnline: () => true,
    pageProtocol: () => "https:",
    probeSignalingServer: () => Promise.resolve(true),
    checkWorkingFolder: () => Promise.resolve("ready" as const),
  };

  test("combines the readings", async () => {
    const report = await runReadinessCheck(
      savedRecord("inviter", SERVER_A),
      readings,
    );
    expect(report).toEqual({
      installedRuntime: true,
      folder: "ready",
      signaling: "answered",
    });
  });

  test("an offline browser seeks no answer", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const report = await runReadinessCheck(savedRecord("inviter", SERVER_A), {
      ...readings,
      isInstalledRuntime: () => false,
      isOnline: () => false,
      probeSignalingServer: probe,
      checkWorkingFolder: () => Promise.resolve("none"),
    });
    expect(report.signaling).toBe("offline");
    expect(probe).not.toHaveBeenCalled();
  });

  test("an unanswered probe reads as no answer", async () => {
    const report = await runReadinessCheck(savedRecord("inviter", SERVER_A), {
      ...readings,
      probeSignalingServer: () => Promise.resolve(false),
    });
    expect(report.signaling).toBe("noAnswer");
  });

  test.each([
    ["inviter", "inviterAddressRefused"],
    ["acceptor", "acceptorAddressRefused"],
  ] as const)(
    "an %s record whose saved address a run refuses reports that and probes nothing, online or not",
    async (side, refusal) => {
      const probe = vi.fn(() => Promise.resolve(true));
      for (const online of [true, false]) {
        const report = await runReadinessCheck(
          savedRecord(side, { host: "a@b", path: "/api/" }),
          { ...readings, isOnline: () => online, probeSignalingServer: probe },
        );
        expect(report.signaling).toBe(refusal);
      }
      expect(probe).not.toHaveBeenCalled();
    },
  );
});

describe("the server the readiness check probes", () => {
  /** The urls the WebSocket stand-in was opened at; each one answers. */
  let opened: Array<string>;

  beforeEach(() => {
    opened = [];
    vi.stubGlobal("window", {
      location: {
        origin: "https://app.example.org",
        protocol: "https:",
        hostname: "app.example.org",
        port: "",
      },
    });
    vi.stubGlobal(
      "WebSocket",
      class {
        private readonly listeners = new Map<string, () => void>();
        constructor(url: string) {
          opened.push(url);
          queueMicrotask(() => this.listeners.get("open")?.());
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners.set(type, listener);
        }
        close() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const platform = {
    ...browserReadinessCheck,
    isInstalledRuntime: () => true,
    isOnline: () => true,
    checkWorkingFolder: () => Promise.resolve("ready" as const),
  };

  test.each(["inviter", "acceptor"] as const)(
    "an %s record naming server A, on a build naming server B: the check probes A only",
    async (side) => {
      const report = await runReadinessCheck(
        savedRecord(side, SERVER_A),
        platform,
      );
      expect(opened).toEqual([
        "wss://saved-signaling.example.org:9999/signal/peerjs",
      ]);
      expect(report.signaling).toBe("answered");
    },
  );

  test("a saved address with no port or path is probed at the defaults a run dials", async () => {
    await runReadinessCheck(
      savedRecord("acceptor", { host: "saved-signaling.example.org" }),
      platform,
    );
    expect(opened).toEqual([
      "wss://saved-signaling.example.org:443/api/peerjs",
    ]);
    expect(
      recordSignalingAddress(
        savedRecord("acceptor", { host: "saved-signaling.example.org" }),
        "http:",
      ),
    ).toStrictEqual({
      host: "saved-signaling.example.org",
      port: 80,
      path: "/api/",
      secure: false,
    });
  });

  test("a refused saved address opens no connection, to it or to the build's server", async () => {
    const report = await runReadinessCheck(
      savedRecord("acceptor", { host: "a@b", path: "/api/" }),
      platform,
    );
    expect(opened).toEqual([]);
    expect(report.signaling).toBe("acceptorAddressRefused");
  });
});
