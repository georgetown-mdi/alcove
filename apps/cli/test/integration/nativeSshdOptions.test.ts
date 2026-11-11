import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ssh2 from "ssh2";
import { afterEach, expect, test } from "vitest";
import { computeHostKeyFingerprint } from "@alcove/core/testing";

import {
  type NativeSshdHandle,
  type NativeSshdOptions,
  type NativeSshdServer,
  startNativeSshdServer,
} from "@alcove/testkit/nativeSshd";

import { selectedBackend, selectedNativeProfile } from "../sftpServer";

// The native backend's three options beyond the profiles, each started as a
// server of its own. Run once, on the baseline native leg: the in-process legs
// provide no sshd, and each hardened leg would repeat the same result.
const nativeBaselineOnly = test.skipIf(
  !(selectedBackend() === "native" && selectedNativeProfile() === "baseline"),
);

const execFileAsync = promisify(execFile);

const started: Array<NativeSshdServer> = [];
const tempDirs: Array<string> = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.stop()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

async function start(options: NativeSshdOptions): Promise<NativeSshdServer> {
  const server = await startNativeSshdServer(options);
  started.push(server);
  return server;
}

interface DialResult {
  ready: boolean;
  error?: string;
  hostKeyFingerprint?: string;
}

/** Dial the server, record the host key it presents, and close once ready. */
function dial(
  handle: NativeSshdHandle,
  privateKey: string,
  algorithms?: ssh2.Algorithms,
): Promise<DialResult> {
  return new Promise((resolve) => {
    const client = new ssh2.Client();
    let fingerprint: Promise<string> | undefined;
    let settled = false;
    const settle = (result: Omit<DialResult, "hostKeyFingerprint">) => {
      if (settled) return;
      settled = true;
      client.end();
      void (fingerprint ?? Promise.resolve(undefined)).then(
        (hostKeyFingerprint) => resolve({ ...result, hostKeyFingerprint }),
      );
    };
    client.once("ready", () => settle({ ready: true }));
    // A refused handshake can be followed by the socket's own reset.
    client.on("error", (err) => settle({ ready: false, error: err.message }));
    client.connect({
      host: handle.host,
      port: handle.port,
      username: handle.usera.username,
      privateKey,
      readyTimeout: 15_000,
      ...(algorithms === undefined ? {} : { algorithms }),
      hostVerifier: (key: Buffer) => {
        fingerprint = computeHostKeyFingerprint(new Uint8Array(key));
        return true;
      },
    });
  });
}

nativeBaselineOnly(
  "serves an ECDSA P-256 host key and reports its fingerprint",
  async () => {
    const { handle } = await start({ hostKeyTypes: ["ecdsa-p256"] });
    const result = await dial(handle, handle.usera.privateKey);
    expect(result).toMatchObject({ ready: true });
    expect(result.hostKeyFingerprint).toBe(
      handle.hostKeyFingerprints["ecdsa-p256"],
    );
    expect(handle.hostKeyFingerprint).toBe(
      handle.hostKeyFingerprints["ecdsa-p256"],
    );
  },
);

nativeBaselineOnly(
  "serves both host keys, each reachable by its algorithm",
  async () => {
    const { handle } = await start({
      hostKeyTypes: ["ed25519", "ecdsa-p256"],
    });
    const ecdsa = await dial(handle, handle.usera.privateKey, {
      serverHostKey: ["ecdsa-sha2-nistp256"],
    });
    const ed25519 = await dial(handle, handle.usera.privateKey, {
      serverHostKey: ["ssh-ed25519"],
    });
    expect(ecdsa.hostKeyFingerprint).toBe(
      handle.hostKeyFingerprints["ecdsa-p256"],
    );
    expect(ed25519.hostKeyFingerprint).toBe(handle.hostKeyFingerprints.ed25519);
    expect(ecdsa.hostKeyFingerprint).not.toBe(ed25519.hostKeyFingerprint);
  },
);

nativeBaselineOnly(
  "authenticates a key authorized while the server runs",
  async () => {
    const server = await start({});
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "alcove-authz-"));
    tempDirs.push(dir);
    const keyPath = path.join(dir, "late_id_ed25519");
    await execFileAsync("ssh-keygen", [
      "-t",
      "ed25519",
      "-f",
      keyPath,
      "-N",
      "",
      "-q",
    ]);
    const privateKey = await fsp.readFile(keyPath, "utf8");
    const publicKey = await fsp.readFile(`${keyPath}.pub`, "utf8");

    const before = await dial(server.handle, privateKey);
    expect(before.ready).toBe(false);
    expect(before.error).toMatch(/authentication/i);

    await server.authorizeKey(publicKey);
    expect(await dial(server.handle, privateKey)).toMatchObject({
      ready: true,
    });
  },
);

nativeBaselineOnly("refuses a multi-line authorized key", async () => {
  const server = await start({});
  await expect(
    server.authorizeKey("ssh-ed25519 AAAA\nssh-ed25519 BBBB"),
  ).rejects.toThrow(/exactly one/);
});

nativeBaselineOnly(
  "applies an extra directive after validating it with sshd -t",
  async () => {
    const { handle } = await start({
      extraDirectives: ["KexAlgorithms ecdh-sha2-nistp256"],
    });
    const offered = await dial(handle, handle.usera.privateKey, {
      kex: ["ecdh-sha2-nistp256"],
    });
    expect(offered).toMatchObject({ ready: true });
    const excluded = await dial(handle, handle.usera.privateKey, {
      kex: ["curve25519-sha256"],
    });
    expect(excluded.ready).toBe(false);
    expect(excluded.error).toMatch(/key exchange|handshake/i);

    await expect(
      startNativeSshdServer({ extraDirectives: ["NoSuchDirective yes"] }),
    ).rejects.toThrow(/rejected the "baseline" profile config/);
  },
);
