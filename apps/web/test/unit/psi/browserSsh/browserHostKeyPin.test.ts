import { describe, expect, test } from "vitest";

import { AuthenticationError, FileSyncConnection } from "@alcove/core";
import { computeHostKeyFingerprint } from "@alcove/core/testing";

import { BrowserSshHostKeyRefusedError } from "@psi/transport/browserSsh/browserSshErrors";
import { onHostKeyFromVerifier } from "@psi/transport/browserSsh/browserSshClient";

import type { FileTransportClient, SFTPConnectionConfig } from "@alcove/core";
import type { BrowserSshHostVerifier } from "@psi/transport/browserSsh/browserSshClient";

/**
 * Core's host-key pin check reaching the browser SSH client's `onHostKey`
 * through {@link onHostKeyFromVerifier}. The transport below steps as
 * `connectBrowserSsh` does: the host-key answer first, and a credential only
 * once it is yes.
 */

function ed25519Blob(fill: number): Uint8Array<ArrayBuffer> {
  const type = new TextEncoder().encode("ssh-ed25519");
  const blob = new Uint8Array(4 + type.length + 4 + 32);
  const view = new DataView(blob.buffer);
  view.setUint32(0, type.length);
  blob.set(type, 4);
  view.setUint32(4 + type.length, 32);
  blob.fill(fill, 8 + type.length);
  return blob;
}

const SERVER_KEY = ed25519Blob(7);
const SERVER_FINGERPRINT = await computeHostKeyFingerprint(SERVER_KEY);
const OTHER_FINGERPRINT = await computeHostKeyFingerprint(ed25519Blob(9));

function unused(): never {
  throw new Error("not reached in a connect test");
}

class HostKeyCheckingTransport implements FileTransportClient {
  credentialsPresented = 0;

  async connect(options: Record<string, unknown>): Promise<void> {
    const onHostKey = onHostKeyFromVerifier(
      options["hostVerifier"] as BrowserSshHostVerifier,
    );
    if (!(await onHostKey({ algorithm: "ssh-ed25519", blob: SERVER_KEY })))
      throw new BrowserSshHostKeyRefusedError();
    this.credentialsPresented += 1;
  }
  end = () => Promise.resolve();
  list = unused;
  get = unused;
  put = unused;
  delete = unused;
  safeDelete = () => Promise.resolve();
  rename = unused;
  createExclusive = unused;
  exists = unused;
}

function sftpConnection(
  hostKeyFingerprint?: string | Array<string>,
): SFTPConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      username: "exchange",
      path: "/exchange",
      ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
    },
  };
}

function causeMessages(error: unknown): Array<string> {
  const messages: Array<string> = [];
  for (let link = error; link instanceof Error; link = link.cause)
    messages.push(link.message);
  return messages;
}

async function open(hostKeyFingerprint?: string | Array<string>) {
  const transport = new HostKeyCheckingTransport();
  const connection = new FileSyncConnection(transport, { verbose: -1 });
  const failure = await connection
    .open(sftpConnection(hostKeyFingerprint))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  return { transport, connection, failure };
}

describe("the host-key pin, checked in onHostKey", () => {
  test("a server presenting the pinned key is authenticated to", async () => {
    const { transport, connection, failure } = await open(SERVER_FINGERPRINT);
    expect(failure).toBeUndefined();
    expect(transport.credentialsPresented).toBe(1);
    expect(connection.observedHostKey).toEqual({
      fingerprint: SERVER_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
  });

  test("a server presenting another key is refused before any credential, naming both fingerprints", async () => {
    const { transport, failure } = await open(OTHER_FINGERPRINT);
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(transport.credentialsPresented).toBe(0);
    const messages = causeMessages(failure);
    expect(messages[0]).toContain(SERVER_FINGERPRINT);
    expect(messages).toContain(`pinned fingerprint: ${OTHER_FINGERPRINT}`);
    expect(messages.at(-1)).toBe(new BrowserSshHostKeyRefusedError().message);
  });

  test("a rotation pin beside the current one is honoured", async () => {
    const { transport, connection, failure } = await open([
      OTHER_FINGERPRINT,
      SERVER_FINGERPRINT,
    ]);
    expect(failure).toBeUndefined();
    expect(transport.credentialsPresented).toBe(1);
    expect(connection.observedHostKey?.fingerprint).toBe(SERVER_FINGERPRINT);
  });

  test("no pin refuses before any credential, naming the key to pin", async () => {
    const { transport, failure } = await open();
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(transport.credentialsPresented).toBe(0);
    expect(causeMessages(failure)[0]).toContain(SERVER_FINGERPRINT);
  });

  test("a first-use probe reads the key and presents no credential", async () => {
    const transport = new HostKeyCheckingTransport();
    const presented = await new FileSyncConnection(transport, {
      verbose: -1,
    }).probeHostKeyFingerprint(sftpConnection());
    expect(presented).toEqual({
      fingerprint: SERVER_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
    expect(transport.credentialsPresented).toBe(0);
  });
});

describe("onHostKeyFromVerifier", () => {
  test("answers with the verifier's verdict", async () => {
    const hostKey = { algorithm: "ssh-ed25519", blob: SERVER_KEY };
    await expect(
      onHostKeyFromVerifier((_blob, verdict) => verdict(true))(hostKey),
    ).resolves.toBe(true);
    await expect(
      onHostKeyFromVerifier((_blob, verdict) => verdict(false))(hostKey),
    ).resolves.toBe(false);
  });

  test("refuses when the verifier throws", async () => {
    const onHostKey = onHostKeyFromVerifier(() => {
      throw new Error("unreadable key");
    });
    await expect(
      onHostKey({ algorithm: "ssh-ed25519", blob: SERVER_KEY }),
    ).resolves.toBe(false);
  });
});
