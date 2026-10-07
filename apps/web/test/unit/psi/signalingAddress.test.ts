import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { generateSharedSecret } from "@alcove/core";

import { SIGNALING_SCHEME_MISMATCH } from "@utils/signalingScheme";

import {
  NoSignalingAddressError,
  invitationSignalingAddress,
  webrtcEndpointFromAddress,
} from "../../../src/psi/invitation.js";
import { invitationLocation } from "../../../src/psi/invitationLocation.js";
import { listenAsInviter } from "../../../src/psi/transport/rendezvous.js";
import { resolveSignalingAddress } from "../../../src/psi/transport/signalingAddress.js";

import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";
import type { SignalingServerSetting } from "@utils/clientConfig";

const setting = vi.hoisted(() => ({
  current: undefined as SignalingServerSetting | undefined,
  consoleBuild: false,
}));

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    {
      signalingServerSetting: () => setting.current,
      isConsoleBuild: () => setting.consoleBuild,
    },
  ),
);

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

  test.each<[string, boolean]>([
    ["https:", true],
    ["http:", false],
  ])("names the default port explicitly under %s", (protocol, secure) => {
    expect(
      resolveSignalingAddress(
        { secure, host: "signaling.example.org", path: "/api/" },
        { ...httpsPage, protocol },
      ).port,
    ).toBe(secure ? 443 : 80);
  });

  test("refuses a ws: setting under an https page", () => {
    expect(() =>
      resolveSignalingAddress({ ...configured, secure: false }, httpsPage),
    ).toThrow(SIGNALING_SCHEME_MISMATCH);
  });

  test("refuses a wss: setting under an http page", () => {
    expect(() =>
      resolveSignalingAddress(configured, { ...httpsPage, protocol: "http:" }),
    ).toThrow(SIGNALING_SCHEME_MISMATCH);
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
    setting.consoleBuild = false;
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
    const endpoint = webrtcEndpointFromAddress(
      invitationSignalingAddress(invitationLocation()),
    );
    const options = await registeredOptions();
    expect(options).toMatchObject({
      host: endpoint.host,
      port: endpoint.port ?? 443,
      path: endpoint.path,
      secure: true,
    });
    expect(invitationLocation().origin).toBe("https://app.example.org");
  });

  test("an invitation names a configured server's default port", () => {
    setting.current = {
      secure: true,
      host: "signaling.example.org",
      path: "/api/",
    };
    expect(
      webrtcEndpointFromAddress(
        invitationSignalingAddress(invitationLocation()),
      ),
    ).toStrictEqual({
      channel: "webrtc",
      host: "signaling.example.org",
      port: 443,
      path: "/api/",
    });
  });

  test("an invitation omits the default port when no server is set", () => {
    expect(
      webrtcEndpointFromAddress(
        invitationSignalingAddress(invitationLocation()),
      ),
    ).toStrictEqual({
      channel: "webrtc",
      host: "app.example.org",
      path: "/api/",
    });
  });

  test("an invitation never names the page's host once a server is set", () => {
    setting.current = {
      secure: true,
      host: "signaling.example.org",
      path: "/api/",
    };
    expect(
      webrtcEndpointFromAddress(
        invitationSignalingAddress(invitationLocation()),
      ).host,
    ).toBe("signaling.example.org");
  });

  test.each<[string, SignalingServerSetting | undefined]>([
    ["no setting", undefined],
    [
      "a configured server",
      { secure: true, host: "signaling.example.org", path: "/api/" },
    ],
  ])(
    "a console names no signaling address under %s, so it mints no webrtc invitation",
    (_label, configured) => {
      setting.current = configured;
      setting.consoleBuild = true;
      const location = invitationLocation();
      expect(location.signaling).toBeUndefined();
      expect(() => invitationSignalingAddress(location)).toThrow(
        NoSignalingAddressError,
      );
    },
  );
});
