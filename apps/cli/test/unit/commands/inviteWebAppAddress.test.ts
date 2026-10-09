import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  decodeInvitation,
  getLogger,
  InternalConsistencyError,
  UsageError,
} from "@alcove/core";

import {
  resolveInvitePositionals,
  validateInvite,
} from "../../../src/commands/invite";
import { saveConfig } from "../../../src/config";
import {
  inviterConnectionFromURL,
  WEB_APP_ADDRESS_REFUSED,
  webAppOrigin,
} from "../../../src/connectionFromUrl";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-invite-web-app-"));
  tmpDirs.push(dir);
  return dir;
}

function optionsIn(
  dir: string,
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  return {
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
    identity: "Agency A",
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

function writeInput(dir: string): string {
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return input;
}

function silentLog(name: string) {
  const log = getLogger(name);
  log.setLevel("silent");
  return log;
}

describe("webAppOrigin", () => {
  test("takes the app's bare address, its scheme-default port normalized away", () => {
    const cases: Array<[string, string]> = [
      ["https://app.example.org", "https://app.example.org"],
      ["https://app.example.org/", "https://app.example.org"],
      ["https://app.example.org:443/", "https://app.example.org"],
      ["https://app.example.org:8443/", "https://app.example.org:8443"],
      ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ];
    for (const [address, origin] of cases)
      expect(webAppOrigin(new URL(address))).toBe(origin);
  });

  test("refuses a path, user, query, or fragment without echoing the URL", () => {
    const token = "secret-invitation-token";
    for (const raw of [
      "https://app.example.org/accept",
      `https://app.example.org/accept#${token}`,
      "https://app.example.org/api/",
      `https://app.example.org/#${token}`,
      "https://someone@app.example.org/",
      "https://someone:hunter2@app.example.org/",
      "https://app.example.org/?key=private",
    ]) {
      let caught: unknown;
      try {
        webAppOrigin(new URL(raw));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      const message = (caught as Error).message;
      expect(message).toBe(WEB_APP_ADDRESS_REFUSED);
      expect(message).not.toContain(token);
      expect(message).not.toContain("hunter2");
      // The refusal names both forms the command takes.
      expect(message).toContain("https://");
      expect(message).toContain("wss://");
    }
  });
});

describe("inviterConnectionFromURL", () => {
  test("is never handed an unresolved web app address", () => {
    expect(() =>
      inviterConnectionFromURL(new URL("https://app.example.org/"), {}),
    ).toThrow(InternalConsistencyError);
  });
});

/** Serve `document` as every web app's /alcove.json for the rest of the test. */
function publishSignalingServer(document: unknown): Array<string> {
  const fetched: Array<string> = [];
  vi.stubGlobal("fetch", (input: string | URL) => {
    fetched.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(document)));
  });
  return fetched;
}

describe("alcove invite with a web app address", () => {
  test("an http(s) address dispatches online", () => {
    for (const raw of ["https://app.example.org/", "http://127.0.0.1:3000"]) {
      const r = resolveInvitePositionals([raw, "input.csv"]);
      expect(r.mode).toBe("online");
      if (r.mode !== "online") return;
      expect(r.url.href).toBe(new URL(raw).href);
      expect(r.input).toBe("input.csv");
    }
  });

  test("a path on the address fails before the token exists or any request", async () => {
    const fetched = publishSignalingServer({});
    const dir = scratch();
    const options = optionsIn(dir);
    await expect(
      validateInvite({
        resolved: {
          mode: "online",
          url: new URL("https://app.example.org/accept"),
          input: writeInput(dir),
        },
        options,
        acceptTimeout: 900,
        log: silentLog("invite-web-app-path"),
      }),
    ).rejects.toThrow(WEB_APP_ADDRESS_REFUSED);
    expect(fs.existsSync(options.keyFile)).toBe(false);
    expect(fetched).toEqual([]);
  });

  test("an app that publishes no server fails before the token exists", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("<!doctype html>", { status: 200 })),
    );
    const dir = scratch();
    const options = optionsIn(dir);
    await expect(
      validateInvite({
        resolved: {
          mode: "online",
          url: new URL("https://app.example.org/"),
          input: writeInput(dir),
        },
        options,
        acceptTimeout: 900,
        log: silentLog("invite-web-app-unpublished"),
      }),
    ).rejects.toThrow(
      "https://app.example.org does not publish the address of its coordination server",
    );
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("the invitation and the written configuration name the published server, and the offline form reuses it", async () => {
    const fetched = publishSignalingServer({
      signaling_server: "wss://signal.example.org:8443/api/",
    });
    const dir = scratch();
    const options = optionsIn(dir);
    const ready = await validateInvite({
      resolved: {
        mode: "online",
        url: new URL("https://app.example.org/"),
        input: writeInput(dir),
      },
      options,
      acceptTimeout: 900,
      log: silentLog("invite-web-app-online"),
    });
    if (ready.mode !== "online") throw new Error("expected online mode");
    expect(fetched).toEqual(["https://app.example.org/alcove.json"]);
    // The accept link is built from the address the operator gave.
    expect(ready.url.href).toBe("https://app.example.org/");
    const onlineToken = await decodeInvitation(ready.invitation);
    const endpoint = {
      channel: "webrtc",
      host: "signal.example.org",
      port: 8443,
      path: "/api/",
    };
    expect(onlineToken.connectionEndpoint).toEqual(endpoint);

    // The bootstrap writes this connection as the configuration's block.
    saveConfig(options.configFile, {
      connection: ready.connection,
      ...ready.dataSpec,
    });
    const written = YAML.parse(fs.readFileSync(options.configFile, "utf8"));
    expect(written.connection).toEqual({
      channel: "webrtc",
      role: "inviter",
      server: { host: "signal.example.org", port: 8443, path: "/api/" },
    });

    const offline = await validateInvite({
      resolved: { mode: "offline" },
      options,
      acceptTimeout: 900,
      log: silentLog("invite-web-app-offline"),
    });
    expect(offline.mode).toBe("offlineFromConfig");
    const offlineToken = await decodeInvitation(offline.invitation);
    expect(offlineToken.connectionEndpoint).toEqual(endpoint);
  });
});
