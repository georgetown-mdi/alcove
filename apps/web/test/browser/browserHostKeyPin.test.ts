/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";

import { AuthenticationError, FileSyncConnection } from "@alcove/core";

import {
  connectBrowserSsh,
  onHostKeyFromVerifier,
} from "@psi/transport/browserSsh/browserSshClient";
import { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";

import type {
  BrowserSshHostVerifier,
  BrowserSshSftpSession,
} from "@psi/transport/browserSsh/browserSshClient";
import type { FileTransportClient, SFTPConnectionConfig } from "@alcove/core";
import type {
  SshTarget,
  SshTargetOptions,
} from "../devServer/sshTargetCommands";

/**
 * Core's host-key pin check, handed to the browser SSH client's `onHostKey`,
 * against a real OpenSSH sshd through the SFTP relay
 * (test/devServer/sshTargetCommands.ts).
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

const WRONG_PIN = `SHA256:${"A".repeat(43)}`;

const cleanups: Array<() => Promise<void>> = [];
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function unused(): never {
  throw new Error("not reached in a connect test");
}

/** Just enough of a file transport for core's connect and probe. */
class ConnectOnlyTransport implements FileTransportClient {
  session: BrowserSshSftpSession | undefined;

  constructor(
    private readonly target: SshTarget,
    private readonly key: NonExtractableEcdsaP256KeyPair,
  ) {}

  async connect(options: Record<string, unknown>): Promise<void> {
    this.session = await connectBrowserSsh({
      relayUrl: this.target.relayUrl,
      username: this.target.username,
      key: this.key,
      onHostKey: onHostKeyFromVerifier(
        options["hostVerifier"] as BrowserSshHostVerifier,
      ),
    });
  }
  end = async () => {
    await this.session?.close();
  };
  list = unused;
  get = unused;
  put = unused;
  delete = unused;
  safeDelete = () => Promise.resolve();
  rename = unused;
  createExclusive = unused;
  exists = unused;
}

async function connectionTo(): Promise<{
  target: SshTarget;
  connection: FileSyncConnection;
}> {
  const target = await commands.startSshTarget({ origin: location.origin });
  cleanups.push(() => commands.stopSshTarget(target.id));
  const key = await NonExtractableEcdsaP256KeyPair.generate();
  await commands.authorizeSshKey(target.id, await key.authorizedKeysLine());
  const transport = new ConnectOnlyTransport(target, key);
  cleanups.push(() => transport.end());
  return {
    target,
    connection: new FileSyncConnection(transport, { verbose: -1 }),
  };
}

function sftpConfig(
  target: SshTarget,
  hostKeyFingerprint?: string | Array<string>,
): SFTPConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host: "127.0.0.1",
      username: target.username,
      ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    },
  };
}

function ed25519Fingerprint(target: SshTarget): string {
  const fingerprint = target.hostKeyFingerprints.ed25519;
  if (fingerprint === undefined)
    throw new Error("the target started with no ed25519 host key");
  return fingerprint;
}

function causeMessages(error: unknown): Array<string> {
  const messages: Array<string> = [];
  for (let link = error; link instanceof Error; link = link.cause)
    messages.push(link.message);
  return messages;
}

sshTest(
  "a server whose key matches no pin is refused before signing, naming both fingerprints",
  async () => {
    const { target, connection } = await connectionTo();
    const failure = await connection.open(sftpConfig(target, WRONG_PIN)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthenticationError);
    const messages = causeMessages(failure);
    expect(messages[0]).toContain(ed25519Fingerprint(target));
    expect(messages).toContain(`pinned fingerprint: ${WRONG_PIN}`);
    expect(signatures).toBe(0);
  },
);

sshTest("a rotation pin beside a stale one is accepted", async () => {
  const { target, connection } = await connectionTo();
  const current = ed25519Fingerprint(target);
  await connection.open(sftpConfig(target, [WRONG_PIN, current]));
  expect(signatures).toBe(1);
  expect(connection.observedHostKey?.fingerprint).toBe(current);
});

sshTest("a first-use probe reads the key without signing", async () => {
  const { target, connection } = await connectionTo();
  await expect(
    connection.probeHostKeyFingerprint(sftpConfig(target)),
  ).resolves.toEqual({
    fingerprint: ed25519Fingerprint(target),
    keyType: "ssh-ed25519",
  });
  expect(signatures).toBe(0);
});
