/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { AuthenticationError, FileSyncConnection } from "@alcove/core";

import { BrowserSftpTransport } from "@psi/transport/browserSsh/browserSftpTransport";
import { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";

import type {
  SshTarget,
  SshTargetOptions,
} from "../devServer/sshTargetCommands";

/**
 * The browser SFTP file transport under a file-sync connection, two parties in
 * one page meeting on a real OpenSSH sshd through the SFTP relay
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

const CASE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;
const PEER_TIMEOUT_MS = 30_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startTarget(): Promise<SshTarget> {
  const target = await commands.startSshTarget({ origin: location.origin });
  cleanups.push(() => commands.stopSshTarget(target.id));
  return target;
}

/** A file-sync connection over its own transport, its key authorized on `target`. */
async function party(target: SshTarget): Promise<{
  connection: FileSyncConnection;
  errors: Array<unknown>;
}> {
  const key = await NonExtractableEcdsaP256KeyPair.generate();
  await commands.authorizeSshKey(target.id, await key.authorizedKeysLine());
  const connection = new FileSyncConnection(
    new BrowserSftpTransport({ relayUrl: target.relayUrl, key }),
    { verbose: -1 },
  );
  const errors: Array<unknown> = [];
  connection.on("error", (error) => errors.push(error));
  cleanups.push(() => connection.close().catch(() => {}));
  return { connection, errors };
}

function sftpConfig(target: SshTarget, hostKeyFingerprint: string | undefined) {
  return {
    channel: "sftp" as const,
    server: {
      host: "127.0.0.1",
      username: target.username,
      path: target.remoteRoot,
      ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    },
    options: {
      pollIntervalMs: POLL_INTERVAL_MS,
      peerTimeoutMs: PEER_TIMEOUT_MS,
      inactivityTimeoutMs: PEER_TIMEOUT_MS,
    },
  };
}

function nextMessage(connection: FileSyncConnection): Promise<unknown> {
  return new Promise((resolve) => connection.once("data", resolve));
}

sshTest(
  "two parties complete a file-sync exchange on the server through the relay",
  async () => {
    const target = await startTarget();
    const pin = target.hostKeyFingerprints.ed25519;
    const a = await party(target);
    const b = await party(target);

    await Promise.all([
      a.connection.open(sftpConfig(target, pin)),
      b.connection.open(sftpConfig(target, pin)),
    ]);
    await Promise.all([a.connection.synchronize(), b.connection.synchronize()]);
    expect(a.connection.peerId).toBe(b.connection.id);
    expect(b.connection.peerId).toBe(a.connection.id);
    expect(a.connection.handshakeRole).not.toBe(b.connection.handshakeRole);
    a.connection.start();
    b.connection.start();

    // Past one READ and several WRITEs, so the transfer is chunked both ways.
    const large = { payload: "x".repeat(600_000) };
    const atB = nextMessage(b.connection);
    await a.connection.send(large);
    expect(await atB).toEqual(large);

    const atA = nextMessage(a.connection);
    await b.connection.send({ reply: "received" });
    expect(await atA).toEqual({ reply: "received" });

    await Promise.all([a.connection.close(), b.connection.close()]);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);

    // Both parties removed what they wrote.
    const observerKey = await NonExtractableEcdsaP256KeyPair.generate();
    await commands.authorizeSshKey(
      target.id,
      await observerKey.authorizedKeysLine(),
    );
    const observer = new BrowserSftpTransport({
      relayUrl: target.relayUrl,
      key: observerKey,
    });
    await observer.connect({
      username: target.username,
      hostVerifier: (_blob: Uint8Array, verdict: (ok: boolean) => void) =>
        verdict(true),
    });
    cleanups.push(() => observer.end());
    const left = (await observer.list(target.remoteRoot))
      .map((entry) => entry.name)
      .filter((name) => name !== "." && name !== "..");
    expect(left).toEqual([]);
  },
  CASE_TIMEOUT_MS,
);

sshTest(
  "a server whose host key matches no pin is refused before authenticating",
  async () => {
    const target = await startTarget();
    const { connection } = await party(target);
    const wrongPin = `SHA256:${"A".repeat(43)}`;
    await expect(
      connection.open(sftpConfig(target, wrongPin)),
    ).rejects.toBeInstanceOf(AuthenticationError);
  },
  CASE_TIMEOUT_MS,
);
