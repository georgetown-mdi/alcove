import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { generateSharedSecret } from "@alcove/core";

import {
  INSECURE_SIGNALING_SERVER_REFUSED,
  resolveSignalingAddress,
} from "../../../src/psi/transport/signalingAddress.js";
import { invitationLocation } from "../../../src/psi/invitationLocation.js";
import { listenAsInviter } from "../../../src/psi/transport/rendezvous.js";
import { webrtcEndpointFromAddress } from "../../../src/psi/invitation.js";

import type * as ClientConfigModule from "@utils/clientConfig";
import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";
import type { SignalingServerSetting } from "@utils/clientConfig";

const setting = vi.hoisted(() => ({
  current: undefined as SignalingServerSetting | undefined,
}));

vi.mock("@utils/clientConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof ClientConfigModule>()),
  signalingServerSetting: () => setting.current,
}));

const httpsPage = { protocol: "https:", hostname: "app.example.org", port: "" };

describe("resolveSignalingAddress with no setting", () => {
  test("is the page's own host at /api/, secure under https", () => {
    expect(resolveSignalingAddress(undefined, httpsPage)).toStrictEqual({
      host: "app.example.org",
      path: "/api/",
      secure: true,
    });
  });

  test("normalizes localhost and keeps an explicit port under http", () => {
    expect(
      resolveSignalingAddress(undefined, {
        protocol: "http:",
        hostname: "localhost",
        port: "3000",
      }),
    ).toStrictEqual({
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
      secure: false,
    });
  });

  test.each(["", "0", "8080abc", "70000"])(
    "treats page port %j as the default",
    (port) => {
      expect(
        resolveSignalingAddress(undefined, { ...httpsPage, port }).port,
      ).toBeUndefined();
    },
  );
});

describe("resolveSignalingAddress with a setting", () => {
  const configured: SignalingServerSetting = {
    secure: true,
    host: "signaling.example.org",
    port: 8443,
    path: "/broker/",
  };

  test("is the setting, whatever the page's host", () => {
    expect(resolveSignalingAddress(configured, httpsPage)).toStrictEqual(
      configured,
    );
  });

  test("normalizes a localhost setting to a loopback literal", () => {
    expect(
      resolveSignalingAddress(
        { secure: false, host: "localhost", port: 9000, path: "/api/" },
        { protocol: "http:", hostname: "localhost", port: "3000" },
      ).host,
    ).toBe("127.0.0.1");
  });

  test("refuses a ws: setting under an https page", () => {
    expect(() =>
      resolveSignalingAddress({ ...configured, secure: false }, httpsPage),
    ).toThrow(INSECURE_SIGNALING_SERVER_REFUSED);
  });
});

class FakePeer extends EventEmitter {
  destroy = vi.fn();
}

describe("the inviter's registration and its invitation", () => {
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
    setting.current = undefined;
  });

  async function registeredOptions(): Promise<PeerOptions> {
    let captured: PeerOptions | undefined;
    const fake = new FakePeer();
    const pending = listenAsInviter(generateSharedSecret(), {
      peerFactory: (_id, options) => {
        captured = options;
        queueMicrotask(() => fake.emit("open"));
        return fake as unknown as Peer;
      },
    });
    await pending;
    if (captured === undefined) throw new Error("peer not constructed");
    return captured;
  }

  test.each<[string, SignalingServerSetting | undefined]>([
    ["no setting", undefined],
    [
      "a configured server",
      {
        secure: true,
        host: "signaling.example.org",
        port: 8443,
        path: "/broker/",
      },
    ],
    [
      "a configured server on the default port",
      { secure: true, host: "signaling.example.org", path: "/" },
    ],
  ])("name the same server under %s", async (_label, configured) => {
    setting.current = configured;
    const endpoint = webrtcEndpointFromAddress(invitationLocation().signaling);
    const options = await registeredOptions();
    expect(options).toMatchObject({
      host: endpoint.host,
      port: endpoint.port ?? 443,
      path: endpoint.path,
      secure: true,
    });
    expect(invitationLocation().origin).toBe("https://app.example.org");
  });

  test("an invitation never names the page's host once a server is set", () => {
    setting.current = {
      secure: true,
      host: "signaling.example.org",
      path: "/api/",
    };
    expect(webrtcEndpointFromAddress(invitationLocation().signaling).host).toBe(
      "signaling.example.org",
    );
  });
});
