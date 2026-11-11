/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import { computeHostKeyFingerprint } from "@alcove/core/testing";

import {
  BROWSER_SSH_KEY_EXCHANGES,
  createBrowserSshConfiguration,
} from "@psi/transport/browserSsh/sshSessionConfiguration";
import {
  BrowserSshAuthenticationRefusedError,
  BrowserSshHostKeyRefusedError,
  BrowserSshNoCommonAlgorithmError,
  BrowserSshUnsupportedKeyExchangeError,
} from "@psi/transport/browserSsh/browserSshErrors";
import {
  Buffer,
  SshAlgorithms,
  SshClientSession,
} from "@psi/transport/browserSsh/sshLibrary";
import {
  connectBrowserSsh,
  provideBufferGlobal,
} from "@psi/transport/browserSsh/browserSshClient";
import { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";
import { SshRelayStream } from "@psi/transport/browserSsh/sshRelayStream";

import type {
  SshTarget,
  SshTargetOptions,
} from "../devServer/sshTargetCommands";
import type { BrowserSshHostKey } from "@psi/transport/browserSsh/browserSshClient";
import type { SshChannel } from "@psi/transport/browserSsh/sshLibrary";

/**
 * The browser SSH client against a real OpenSSH sshd through the SFTP relay,
 * both started in the runner's process (test/devServer/sshTargetCommands.ts),
 * with the bundle's `diffie-hellman` replaced by the stub that throws.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    sshTargetAvailable: () => Promise<boolean>;
    startSshTarget: (options: SshTargetOptions) => Promise<SshTarget>;
    authorizeSshKey: (id: number, line: string) => Promise<void>;
    stopSshTarget: (id: number) => Promise<void>;
  }
}

// Without an sshd these skip, and the run's prerequisite gate
// (test/requireTestPrerequisites.ts) names it, failing the run in CI.
const sshTest = test.skipIf(!(await commands.sshTargetAvailable()));

/** How long a refused negotiation may take to reject: no hang. */
const NEGOTIATION_FAILURE_BOUND_MS = 5_000;

const started: Array<number> = [];
let signatures: number;

beforeEach(() => {
  signatures = 0;
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "sign").mockImplementation((...args) => {
    signatures += 1;
    return sign(...args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map((id) => commands.stopSshTarget(id)));
});

async function startTarget(
  options: Omit<SshTargetOptions, "origin"> = {},
): Promise<SshTarget> {
  const target = await commands.startSshTarget({
    ...options,
    origin: location.origin,
  });
  started.push(target.id);
  return target;
}

async function authorizedKey(
  target: SshTarget,
): Promise<{ key: NonExtractableEcdsaP256KeyPair; pair: CryptoKeyPair }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const key = await NonExtractableEcdsaP256KeyPair.fromCryptoKeyPair(pair);
  await commands.authorizeSshKey(target.id, await key.authorizedKeysLine());
  return { key, pair };
}

/** Send SSH_FXP_INIT (version 3) and resolve with the reply's type and version. */
function sftpInit(
  channel: SshChannel,
): Promise<{ type: number; version: number }> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const subscription = channel.onDataReceived((data) => {
      channel.adjustWindow(data.length);
      received = Buffer.concat([received, data]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (received.length < 4 + length) return;
      subscription.dispose();
      resolve({ type: received[4], version: received.readUInt32BE(5) });
    });
    const init = Buffer.alloc(9);
    init.writeUInt32BE(5, 0);
    init[4] = 1;
    init.writeUInt32BE(3, 5);
    channel.send(init).catch(reject);
  });
}

sshTest(
  "exposes the host key before signing and refuses on the caller's word",
  async () => {
    const target = await startTarget();
    const { key } = await authorizedKey(target);
    let seen: { fingerprint: string; signaturesSoFar: number } | undefined;
    const refused = connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key,
      onHostKey: async (hostKey) => {
        seen = {
          fingerprint: await computeHostKeyFingerprint(hostKey.blob),
          signaturesSoFar: signatures,
        };
        return false;
      },
    });
    await expect(refused).rejects.toBeInstanceOf(BrowserSshHostKeyRefusedError);
    expect(seen).toEqual({
      fingerprint: target.hostKeyFingerprints.ed25519,
      signaturesSoFar: 0,
    });
    expect(signatures).toBe(0);
  },
);

sshTest(
  "authenticates with a key that never leaves WebCrypto and opens the sftp subsystem",
  async () => {
    const target = await startTarget();
    const { key, pair } = await authorizedKey(target);
    expect(pair.privateKey.extractable).toBe(false);
    for (const format of ["pkcs8", "jwk"] as const)
      await expect(
        crypto.subtle.exportKey(format, pair.privateKey),
      ).rejects.toMatchObject({ name: "InvalidAccessError" });

    let hostKey: BrowserSshHostKey | undefined;
    const session = await connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key,
      onHostKey: (offered) => {
        hostKey = offered;
        return true;
      },
    });
    try {
      expect(hostKey?.algorithm).toBe("ssh-ed25519");
      expect(await computeHostKeyFingerprint(session.hostKey.blob)).toBe(
        target.hostKeyFingerprints.ed25519,
      );
      expect(signatures).toBe(1);
      expect(await sftpInit(session.channel)).toEqual({ type: 2, version: 3 });
    } finally {
      await session.close();
    }
  },
);

sshTest(
  "verifies an ECDSA P-256 host key through the library's verifier",
  async () => {
    const target = await startTarget({ hostKeyTypes: ["ecdsa-p256"] });
    const { key } = await authorizedKey(target);
    const session = await connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key,
      onHostKey: () => true,
    });
    try {
      expect(session.hostKey.algorithm).toBe("ecdsa-sha2-nistp256");
      expect(await computeHostKeyFingerprint(session.hostKey.blob)).toBe(
        target.hostKeyFingerprints["ecdsa-p256"],
      );
    } finally {
      await session.close();
    }
  },
);

sshTest("names a key the server does not authorize", async () => {
  const target = await startTarget();
  const key = await NonExtractableEcdsaP256KeyPair.generate();
  await expect(
    connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key,
      onHostKey: () => true,
    }),
  ).rejects.toBeInstanceOf(BrowserSshAuthenticationRefusedError);
});

sshTest.each([
  {
    directive: "KexAlgorithms diffie-hellman-group14-sha256",
    category: "KeyExchange",
    server: ["diffie-hellman-group14-sha256"],
  },
  {
    directive: "Ciphers aes128-ctr",
    category: "ClientEncryption",
    server: ["aes128-ctr"],
  },
])(
  "fails before authentication with a named error when the server offers only $directive",
  async ({ directive, category, server }) => {
    const target = await startTarget({ extraDirectives: [directive] });
    const { key } = await authorizedKey(target);
    const onHostKey = vi.fn(() => true);
    const startedAt = performance.now();
    const failure = await connectBrowserSsh({
      relayUrl: target.relayUrl,
      username: target.username,
      key,
      onHostKey,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(performance.now() - startedAt).toBeLessThan(
      NEGOTIATION_FAILURE_BOUND_MS,
    );
    expect(failure).toBeInstanceOf(BrowserSshNoCommonAlgorithmError);
    const named = failure as BrowserSshNoCommonAlgorithmError;
    expect(named.category).toBe(category);
    expect(named.serverAlgorithms).toEqual(expect.arrayContaining(server));
    if (category === "KeyExchange")
      expect(named.clientAlgorithms).toEqual([...BROWSER_SSH_KEY_EXCHANGES]);
    expect(onHostKey).not.toHaveBeenCalled();
    expect(signatures).toBe(0);
  },
);

// The positive control for the alias: a configuration the client never builds
// offers finite-field Diffie-Hellman to a server that offers nothing else, so
// the pre-bundled library calls into `diffie-hellman`, and the stub answers.
// Matched by name: the optimizer bundles the stub, and the error class it
// imports, into the library's chunk, apart from this file's copy.
sshTest(
  "reaches the diffie-hellman stub when a finite-field exchange is negotiated",
  async () => {
    const target = await startTarget({
      extraDirectives: ["KexAlgorithms diffie-hellman-group14-sha256"],
    });
    provideBufferGlobal();
    const config = createBrowserSshConfiguration();
    config.keyExchangeAlgorithms.push(
      SshAlgorithms.keyExchange.dhGroup14Sha256,
    );
    const session = new SshClientSession(config);
    const stream = await SshRelayStream.open(target.relayUrl);
    try {
      await expect(session.connect(stream)).rejects.toMatchObject({
        name: new BrowserSshUnsupportedKeyExchangeError("").name,
        entry: "getDiffieHellman",
      });
    } finally {
      session.dispose();
      stream.dispose();
    }
  },
);
