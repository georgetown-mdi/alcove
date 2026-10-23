import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  MAX_ENDPOINT_HOST_LENGTH,
  decodeInvitation,
  generateSharedSecret,
} from "@alcove/core";

import { SIGNALING_SCHEME_MISMATCH } from "@utils/signalingScheme";

import {
  COORDINATION_SERVER_TOO_LONG_MESSAGE,
  coordinationServerFormMessage,
  parseCoordinationServerUrl,
  readCoordinationServerSetting,
  webAppAddressMessage,
  writeCoordinationServerSetting,
} from "../../../src/psi/transport/coordinationServerSetting.js";
import {
  NoSignalingAddressError,
  generateInvitation,
  invitationSignalingAddress,
  webrtcEndpointFromAddress,
} from "../../../src/psi/invitation.js";
import {
  inviterSignalingAddress,
  resolveInviterSignalingAddress,
  resolveSignalingAddress,
  settingServerNamedBy,
} from "../../../src/psi/transport/signalingAddress.js";
import { invitationLocation } from "../../../src/psi/invitationLocation.js";
import { listenAsInviter } from "../../../src/psi/transport/rendezvous.js";

import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";
import type { SignalingServerSetting } from "@utils/clientConfig";
import type { WebRTCEndpoint } from "@alcove/core";

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
    stubStorage();
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

  async function registeredOptions(
    endpoint: WebRTCEndpoint,
  ): Promise<PeerOptions> {
    let captured: PeerOptions | undefined;
    const fake = new FakePeer();
    const pending = listenAsInviter(generateSharedSecret(), endpoint, {
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
    const options = await registeredOptions(endpoint);
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

/** A localStorage stand-in over a Map, returned so a test reads what was
 * written. */
function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

const OWN_SERVER = "wss://coordination.agency.example/signal/";

/** A host name of labels of `a`s, one of each length in `lengths`. */
function hostOfLabels(lengths: Array<number>): string {
  return lengths.map((length) => "a".repeat(length)).join(".");
}

describe("this browser's coordination server setting", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://app.example.org",
        protocol: "https:",
        hostname: "app.example.org",
        port: "",
      },
    });
    setting.current = {
      secure: true,
      host: "signaling.example.org",
      path: "/api/",
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setting.current = undefined;
    setting.consoleBuild = false;
  });

  test("resolves to the build's server when none is set", () => {
    stubStorage();
    expect(inviterSignalingAddress()).toStrictEqual({
      host: "signaling.example.org",
      port: 443,
      path: "/api/",
      secure: true,
    });
  });

  test("resolves to the setting when one is set, its port stated", () => {
    stubStorage();
    writeCoordinationServerSetting(OWN_SERVER);
    expect(inviterSignalingAddress()).toStrictEqual({
      host: "coordination.agency.example",
      port: 443,
      path: "/signal/",
      secure: true,
    });
  });

  test("reads the build's address only where no setting is given", () => {
    const deployment = vi.fn(() => ({
      host: "signaling.example.org",
      path: "/api/",
      secure: true,
    }));
    expect(
      resolveInviterSignalingAddress("ws://localhost:9000/api/", deployment),
    ).toStrictEqual({
      host: "127.0.0.1",
      port: 9000,
      path: "/api/",
      secure: false,
    });
    expect(deployment).not.toHaveBeenCalled();
    expect(resolveInviterSignalingAddress(undefined, deployment).host).toBe(
      "signaling.example.org",
    );
  });

  test("a stored value this page refuses names the build's server", () => {
    const values = stubStorage();
    values.set(
      "alcove-own-coordination-server",
      JSON.stringify({ version: 1, url: "ws://coordination.agency.example/" }),
    );
    expect(readCoordinationServerSetting("https:")).toEqual({
      kind: "unreadable",
    });
    expect(inviterSignalingAddress().host).toBe("signaling.example.org");
  });

  test("storage that refuses the read is unreadable, not unset", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
    });
    expect(readCoordinationServerSetting("https:")).toEqual({
      kind: "unreadable",
    });
    expect(inviterSignalingAddress().host).toBe("signaling.example.org");

    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("The operation is insecure.");
      },
    });
    expect(readCoordinationServerSetting("https:")).toEqual({
      kind: "unreadable",
    });
  });

  test("no storage at all is unset", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readCoordinationServerSetting("https:")).toEqual({ kind: "none" });
  });

  test("an accepted 255-character host mints an invitation naming it", async () => {
    stubStorage();
    const host = hostOfLabels([63, 63, 63, 63]);
    expect(host).toHaveLength(255);
    const entry = parseCoordinationServerUrl(`wss://${host}/api/`, "https:");
    expect(entry.ok).toBe(true);
    writeCoordinationServerSetting(entry.ok ? entry.url : undefined);
    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: "County Health Dept",
      profiledColumns: ["ssn", "first_name", "last_name", "dob"],
      location: invitationLocation(),
      defaultRelay: () => undefined,
    });
    expect(
      (await decodeInvitation(minted.encoded)).connectionEndpoint,
    ).toMatchObject({ channel: "webrtc", host });
  });

  test("clearing the setting names the build's server again", () => {
    const values = stubStorage();
    writeCoordinationServerSetting(OWN_SERVER);
    writeCoordinationServerSetting(undefined);
    expect(values.size).toBe(0);
    expect(inviterSignalingAddress().host).toBe("signaling.example.org");
  });

  test("an invitation created with the setting names it", async () => {
    stubStorage();
    writeCoordinationServerSetting(OWN_SERVER);
    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: "County Health Dept",
      profiledColumns: ["ssn", "first_name", "last_name", "dob"],
      location: invitationLocation(),
      defaultRelay: () => undefined,
    });
    const expected: WebRTCEndpoint = {
      channel: "webrtc",
      host: "coordination.agency.example",
      port: 443,
      path: "/signal/",
    };
    expect((await decodeInvitation(minted.encoded)).connectionEndpoint).toEqual(
      expected,
    );
    expect(settingServerNamedBy(expected)).toBe(
      "wss://coordination.agency.example/signal/",
    );
  });

  test("an invitation created before a change keeps its server, and the inviter registers there", async () => {
    stubStorage();
    writeCoordinationServerSetting(OWN_SERVER);
    const before = webrtcEndpointFromAddress(
      invitationSignalingAddress(invitationLocation()),
    );
    writeCoordinationServerSetting("wss://other.agency.example/");
    const options = await new Promise<PeerOptions>((resolve) => {
      void listenAsInviter(generateSharedSecret(), before, {
        peerFactory: (_id, peerOptions) => {
          resolve(peerOptions);
          const fake = new FakePeer();
          queueMicrotask(() => fake.emit("open"));
          return fake as unknown as Peer;
        },
      });
    });
    expect(options).toMatchObject({
      host: "coordination.agency.example",
      port: 443,
      path: "/signal/",
    });
  });

  test("the build's own server is not named as the setting's", () => {
    stubStorage();
    expect(
      settingServerNamedBy({
        host: "signaling.example.org",
        port: 443,
        path: "/api/",
      }),
    ).toBeUndefined();
  });
});

describe("parseCoordinationServerUrl", () => {
  test.each([
    [
      "wss://coordination.agency.example/signal",
      "wss://coordination.agency.example/signal/",
    ],
    [
      "  wss://coordination.agency.example:8443/  ",
      "wss://coordination.agency.example:8443/",
    ],
  ])("takes %j under an https page", (text, url) => {
    expect(parseCoordinationServerUrl(text, "https:")).toEqual({
      ok: true,
      url,
    });
  });

  test("blank text names none", () => {
    expect(parseCoordinationServerUrl("   ", "https:")).toEqual({ ok: true });
  });

  test.each([
    "ws://coordination.agency.example/",
    "coordination.agency.example",
    "not a url",
    "wss://user:secret@coordination.agency.example/",
    "wss://coordination.agency.example/?token=1",
    "wss://coordination.agency.example/#x",
    "wss://coordination.agency.example/%2e%2e/",
    "wss://coordination.agency.example:0/",
    "wss://coordination.agency.example/a@b/",
    "wss://coordination.agency.example/a b/",
  ])("refuses %j under an https page, naming the wss form", (text) => {
    expect(parseCoordinationServerUrl(text, "https:")).toEqual({
      ok: false,
      message: coordinationServerFormMessage("https:"),
    });
  });

  test.each(["https://psi.data-bridge.org", "http://psi.data-bridge.org/"])(
    "refuses %j as a web page's address, saying who gives the server's",
    (text) => {
      expect(parseCoordinationServerUrl(text, "https:")).toEqual({
        ok: false,
        message:
          "This is a web page's address, not a coordination server's. " +
          "Whoever runs the server can give you its wss:// address.",
      });
      expect(webAppAddressMessage("https:")).toContain("its wss:// address");
      expect(webAppAddressMessage("http:")).toContain("its ws:// address");
    },
  );

  test.each([
    ["a 300-character host", hostOfLabels([63, 63, 63, 63, 44])],
    ["a 64-character label", `${"a".repeat(64)}.example.org`],
  ])("refuses %s as too long", (_case, host) => {
    expect(parseCoordinationServerUrl(`wss://${host}/api/`, "https:")).toEqual({
      ok: false,
      message: COORDINATION_SERVER_TOO_LONG_MESSAGE,
    });
  });

  test("takes a 255-character host of labels of at most 63", () => {
    const host = hostOfLabels([63, 63, 63, 63]);
    expect(host).toHaveLength(255);
    expect(parseCoordinationServerUrl(`wss://${host}/api/`, "https:")).toEqual({
      ok: true,
      url: `wss://${host}/api/`,
    });
  });

  test("the too-long message says the address is too long and gives the bounds", () => {
    expect(hostOfLabels([63, 63, 63, 63, 44])).toHaveLength(300);
    expect(COORDINATION_SERVER_TOO_LONG_MESSAGE).toBe(
      `This address is too long. Enter an address whose host name has at ` +
        `most ${String(MAX_ENDPOINT_HOST_LENGTH)} characters, and at most 63 ` +
        "between two dots.",
    );
  });

  test("the message names the wss form under https and the ws form under http", () => {
    expect(coordinationServerFormMessage("https:")).toBe(
      "Enter the coordination server's address starting with wss://, for " +
        "example wss://signaling.example.org/api/. It cannot contain a user " +
        "name, password, space, @, ?, # or %.",
    );
    expect(coordinationServerFormMessage("http:")).toContain(
      "Enter the coordination server's address starting with ws://, for " +
        "example ws://signaling.example.org/api/.",
    );
    expect(parseCoordinationServerUrl("wss://a.example/", "http:").ok).toBe(
      false,
    );
    expect(parseCoordinationServerUrl("ws://a.example/", "http:")).toEqual({
      ok: true,
      url: "ws://a.example/",
    });
  });
});
