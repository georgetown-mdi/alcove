import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { generateSharedSecret } from "@alcove/core";

import {
  coordinationServerUnreachableMessage,
  failureFor,
  listenAtInvitationServer,
} from "@exchange/useInviterExchange";
import { CoordinationServerUnreachableError } from "@psi/transport/signalingAddress";

import type Peer from "peerjs";
import type { WebRTCEndpoint } from "@alcove/core";

// An inviter whose invitation names the coordination server this browser's
// setting named, and whose registration there goes unanswered, fails naming
// that server and the control that clears the setting. The build's own server
// going unanswered keeps the generic transport failure.

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    {
      signalingServerSetting: () => ({
        secure: true,
        host: "signaling.example.org",
        path: "/api/",
      }),
    },
  ),
);

class SilentPeer extends EventEmitter {
  destroy = vi.fn();
}

const SET_SERVER: WebRTCEndpoint = {
  channel: "webrtc",
  host: "coordination.agency.example",
  port: 443,
  path: "/signal/",
};

const BUILD_SERVER: WebRTCEndpoint = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 443,
  path: "/api/",
};

/** Listen at `endpoint` through a coordination server that never answers. */
function listenUnanswered(endpoint: WebRTCEndpoint): Promise<unknown> {
  return listenAtInvitationServer(
    { sharedSecret: generateSharedSecret(), connectionEndpoint: endpoint },
    {
      peerFactory: () => new SilentPeer() as unknown as Peer,
      registrationTimeoutMs: 5,
    },
  ).catch((error: unknown) => error);
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: {
      origin: "https://app.example.org",
      protocol: "https:",
      hostname: "app.example.org",
      port: "",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an inviter's unanswered registration", () => {
  test("at the server the setting named fails naming it and how to clear it", async () => {
    const error = await listenUnanswered(SET_SERVER);

    expect(error).toBeInstanceOf(CoordinationServerUnreachableError);
    const server = (error as CoordinationServerUnreachableError).server;
    expect(server).toBe("wss://coordination.agency.example/signal/");

    const failure = failureFor("exchange", error, undefined, "browser");
    expect(failure.title).toBe("Your coordination server did not answer");
    expect(failure.message).toBe(coordinationServerUnreachableMessage(server));
    expect(failure.message).toBe(
      "This page could not connect to " +
        "wss://coordination.agency.example/signal/, the coordination server " +
        "set in relay settings, which this invitation names. Your partner " +
        "cannot use this invitation until that server answers. Ask whoever " +
        "runs it to check it, then choose Try again. Or clear the address " +
        "under Coordination server in relay settings, choose Start over " +
        "with a fresh invitation, and send your partner the new one.",
    );
    expect(failure.retry).toBe("offered");
    expect(failure.coordinationServerUnreachable).toBe(true);
  });

  test("at the build's own server keeps the generic failure", async () => {
    const error = await listenUnanswered(BUILD_SERVER);

    expect(error).not.toBeInstanceOf(CoordinationServerUnreachableError);
    const failure = failureFor("exchange", error, undefined, "browser");
    expect(failure.title).toBe("Exchange failed");
    expect(failure.coordinationServerUnreachable).toBeUndefined();
  });

  test("an invitation naming no webrtc endpoint is refused before any contact", async () => {
    const peerFactory = vi.fn();
    await expect(
      listenAtInvitationServer(
        { sharedSecret: generateSharedSecret(), connectionEndpoint: undefined },
        { peerFactory },
      ),
    ).rejects.toThrow(/names no webrtc endpoint/);
    expect(peerFactory).not.toHaveBeenCalled();
  });
});
