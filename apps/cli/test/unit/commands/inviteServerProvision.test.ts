import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  decodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  UsageError,
} from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";

import {
  handler as inviteHandler,
  validateInvite,
} from "../../../src/commands/invite";
import { saveConfig } from "../../../src/config";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import { captureProcessExit } from "../../exitCapture";

// A create-mode server.provision block through the offline `alcove invite`
// from a configuration: the call runs before the mint, the returned address
// is what the invitation names and what the configuration is updated to, and
// a failed call leaves no token printed and no key file written.

const BEARER = "create-bearer-2468";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-invite-provision-"));
  tmpDirs.push(dir);
  return dir;
}

function optionsIn(dir: string): CommonBootstrapOptions {
  return {
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
  };
}

/** Write a configuration whose server states `provision`, its bearer token in
 * a file, under an operator comment the in-place write must keep. */
function writeConfig(
  dir: string,
  connection: ExchangeSpec["connection"],
): string {
  const tokenFile = path.join(dir, "provision.token");
  fs.writeFileSync(tokenFile, `${BEARER}\n`);
  const configPath = path.join(dir, "alcove.yaml");
  const withAuth =
    connection.channel === "filedrop" ||
    connection.server.provision === undefined
      ? connection
      : {
          ...connection,
          server: {
            ...connection.server,
            provision: {
              ...connection.server.provision,
              auth: { bearer: `@${tokenFile}` },
            },
          },
        };
  saveConfig(configPath, {
    connection: withAuth,
    linkageTerms: {
      ...getDefaultLinkageTerms(
        "Agency A",
        inferMetadata(["first_name", "last_name", "dob", "ssn"], []),
      ),
      payload: { receive: [] },
    },
  } as ExchangeSpec);
  fs.writeFileSync(
    configPath,
    `# operator note: keep me\n${fs.readFileSync(configPath, "utf8")}`,
  );
  return configPath;
}

const sftpCreate: ExchangeSpec["connection"] = {
  channel: "sftp",
  server: {
    host: "pending",
    port: 2200,
    username: "alice",
    provision: { mode: "create", host: "api.example.org", path: "/create" },
  },
};

const webrtcCreate: ExchangeSpec["connection"] = {
  channel: "webrtc",
  role: "inviter",
  server: {
    host: "pending",
    provision: { mode: "create", host: "api.example.org", path: "/create" },
  },
};

/** Stub the global fetch, answering `status` with `body`. */
function stubFetch(body: string | null, status = 200) {
  const fetch = vi.fn(
    async (_input: URL | RequestInfo, _init?: RequestInit) =>
      new Response(body, { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function quietLog() {
  const log = getLogger("invite-provision");
  log.setLevel("silent");
  return log;
}

test("an sftp create-mode configuration names the returned server in the invitation", async () => {
  const dir = scratch();
  writeConfig(dir, sftpCreate);
  const fetch = stubFetch(
    JSON.stringify({ host: "sftp-7.example.org", port: 22, path: "/drop" }),
  );
  const ready = await validateInvite({
    resolved: { mode: "offline" },
    options: optionsIn(dir),
    acceptTimeout: 900,
    log: quietLog(),
  });
  if (ready.mode !== "offlineFromConfig")
    throw new Error("expected the offline-from-config mode");
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe("https://api.example.org/create");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${BEARER}`,
  );
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "sftp",
    host: "sftp-7.example.org",
    port: 22,
    path: "/drop",
  });
  expect(JSON.stringify(token)).not.toContain("api.example.org");
  expect(JSON.stringify(token)).not.toContain(BEARER);
});

test("a webrtc create-mode configuration names the returned coordination server", async () => {
  const dir = scratch();
  writeConfig(dir, webrtcCreate);
  stubFetch(JSON.stringify({ host: "peers-4.example.org", path: "/psi" }));
  const ready = await validateInvite({
    resolved: { mode: "offline" },
    options: optionsIn(dir),
    acceptTimeout: 900,
    log: quietLog(),
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "webrtc",
    host: "peers-4.example.org",
    path: "/psi",
  });
});

test.each([
  [
    "sftp",
    {
      ...sftpCreate,
      server: { ...sftpCreate.server, provision: { host: "api.example.org" } },
    },
  ],
  [
    "webrtc",
    {
      ...webrtcCreate,
      server: {
        host: "peers.example.org",
        provision: { host: "api.example.org" },
      },
    },
  ],
] as Array<[string, ExchangeSpec["connection"]]>)(
  "a %s start-mode configuration sends no call at invite time",
  async (_, connection) => {
    const dir = scratch();
    writeConfig(dir, connection);
    const fetch = stubFetch("{}");
    await validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir),
      acceptTimeout: 900,
      log: quietLog(),
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("an unknown mode in an sftp configuration is refused before any call", async () => {
  const dir = scratch();
  const configPath = writeConfig(dir, sftpCreate);
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace("mode: create", "mode: allocate"),
  );
  const fetch = stubFetch("{}");
  await expect(
    validateInvite({
      resolved: { mode: "offline" },
      options: optionsIn(dir),
      acceptTimeout: 900,
      log: quietLog(),
    }),
  ).rejects.toThrow(/unknown mode "allocate"/);
  expect(fetch).not.toHaveBeenCalled();
});

test("a returned path the sftp block cannot hold beside its split directories is refused", async () => {
  const dir = scratch();
  writeConfig(dir, {
    channel: "sftp",
    server: {
      ...(sftpCreate.channel === "sftp" ? sftpCreate.server : { host: "" }),
      inboundPath: "/in",
      outboundPath: "/out",
    },
    options: {
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
    },
  });
  stubFetch(JSON.stringify({ host: "sftp-7.example.org", path: "/drop" }));
  const err = await validateInvite({
    resolved: { mode: "offline" },
    options: optionsIn(dir),
    acceptTimeout: 900,
    log: quietLog(),
  }).catch((raised: unknown) => raised);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(
    "the provisioning endpoint at api.example.org:443 returned a server address",
  );
});

function inviteArgv(dir: string): Arguments {
  return {
    _: [],
    $0: "alcove",
    args: [],
    "config-file": path.join(dir, "alcove.yaml"),
    "key-file": path.join(dir, ".alcove.key"),
    "log-level": "silent",
    record: false,
  } as unknown as Arguments;
}

test("handler: the returned address is written into the configuration in place, its provision block kept", async () => {
  const dir = scratch();
  const configPath = writeConfig(dir, sftpCreate);
  stubFetch(JSON.stringify({ host: "sftp-7.example.org", path: "/drop" }));
  const printed: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    printed.push(args.map(String).join(" "));
  });
  const exitSpy = captureProcessExit();
  try {
    await inviteHandler(inviteArgv(dir));
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  expect(printed).toHaveLength(1);
  const text = fs.readFileSync(configPath, "utf8");
  expect(text.startsWith("# operator note: keep me\n")).toBe(true);
  const written = YAML.parse(text);
  expect(written.connection.server).toEqual({
    host: "sftp-7.example.org",
    port: 2200,
    path: "/drop",
    username: "alice",
    provision: {
      mode: "create",
      host: "api.example.org",
      path: "/create",
      auth: { bearer: `@${path.join(dir, "provision.token")}` },
    },
  });
  expect(fs.existsSync(path.join(dir, ".alcove.key"))).toBe(true);
});

test.each([
  ["an HTTP 503 answer", null, 503, 69],
  ["an HTTP 401 answer", null, 401, 64],
  ["an answer with an extra key", '{"host":"a.example.org","x":1}', 200, 64],
  ["an answer that is not JSON", "<html>", 200, 64],
  ...[
    ["whitespace", "a b.example.org"],
    ["a control character", "a\u0001b.example.org"],
    ["a line break", "a\nb.example.org"],
    ["a leading @", "@evil.example.org"],
    ["/?#", "a.example.org/?#x"],
    ["a leading-hyphen label", "-bad.example.org"],
  ].map(([what, host]) => [
    `a returned host holding ${what}`,
    JSON.stringify({ host }),
    200,
    64,
  ]),
  [
    "a returned path holding a control character",
    JSON.stringify({ host: "a.example.org", path: "/a\u0001b" }),
    200,
    64,
  ],
  [
    "a returned path holding relative/../../etc",
    JSON.stringify({ host: "a.example.org", path: "relative/../../etc" }),
    200,
    64,
  ],
  [
    "a returned path holding /ok path",
    JSON.stringify({ host: "a.example.org", path: "/ok path" }),
    200,
    64,
  ],
] as Array<[string, string | null, number, number]>)(
  "handler: %s stops the invite before any token or key file",
  async (_, body, status, code) => {
    const dir = scratch();
    const configPath = writeConfig(dir, sftpCreate);
    const before = fs.readFileSync(configPath, "utf8");
    const fetch = stubFetch(body, status);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = captureProcessExit();
    try {
      await expect(inviteHandler(inviteArgv(dir))).rejects.toThrow(
        `exit:${code}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(dir, ".alcove.key"))).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  },
);

test("handler: a returned path of / is accepted and written into connection.server.path", async () => {
  const dir = scratch();
  const configPath = writeConfig(dir, sftpCreate);
  stubFetch(JSON.stringify({ host: "sftp-7.example.org", path: "/" }));
  const exitSpy = captureProcessExit();
  try {
    await inviteHandler(inviteArgv(dir));
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
  const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
  expect(written.connection.server.path).toBe("/");
  expect(fs.existsSync(path.join(dir, ".alcove.key"))).toBe(true);
});
