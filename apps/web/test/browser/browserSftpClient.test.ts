/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";

import {
  SFTP_MAX_READ_BYTES,
  SftpClient,
} from "@psi/transport/browserSsh/sftp/sftpClient";
import {
  SftpFailureError,
  SftpNoSuchFileError,
} from "@psi/transport/browserSsh/sftp/sftpErrors";
import { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";
import { SftpOpenFlags } from "@psi/transport/browserSsh/sftp/sftpPacket";
import { connectBrowserSsh } from "@psi/transport/browserSsh/browserSshClient";

import type {
  SshTarget,
  SshTargetOptions,
} from "../devServer/sshTargetCommands";
import type { BrowserSshSftpSession } from "@psi/transport/browserSsh/browserSshClient";

/**
 * The SFTP client over the browser SSH client's subsystem channel, against a
 * real OpenSSH sshd through the SFTP relay (test/devServer/sshTargetCommands.ts).
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

/** The size of each WRITE, as the file transport sends them. */
const WRITE_CHUNK_BYTES = 65_536;
/** Requests kept outstanding at once. */
const IN_FLIGHT = 8;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openSftp(): Promise<{
  client: SftpClient;
  root: string;
}> {
  const target = await commands.startSshTarget({ origin: location.origin });
  cleanups.push(() => commands.stopSshTarget(target.id));
  const key = await NonExtractableEcdsaP256KeyPair.generate();
  await commands.authorizeSshKey(target.id, await key.authorizedKeysLine());
  const session: BrowserSshSftpSession = await connectBrowserSsh({
    relayUrl: target.relayUrl,
    username: target.username,
    key,
    onHostKey: () => true,
  });
  cleanups.push(() => session.close());
  const client = await SftpClient.start(session.channel);
  cleanups.push(() => client.end());
  return { client, root: target.remoteRoot };
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
  return bytes;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Run `work` over `offsets`, keeping {@link IN_FLIGHT} outstanding. */
async function pipelined(
  offsets: Array<number>,
  work: (offset: number) => Promise<void>,
): Promise<void> {
  const queue = [...offsets];
  await Promise.all(
    Array.from({ length: IN_FLIGHT }, async () => {
      for (
        let offset = queue.shift();
        offset !== undefined;
        offset = queue.shift()
      )
        await work(offset);
    }),
  );
}

function offsetsOf(length: number, step: number): Array<number> {
  return Array.from(
    { length: Math.ceil(length / step) },
    (_, index) => index * step,
  );
}

async function writeFile(
  client: SftpClient,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const handle = await client.open(
    path,
    SftpOpenFlags.write | SftpOpenFlags.create | SftpOpenFlags.truncate,
  );
  await pipelined(offsetsOf(data.length, WRITE_CHUNK_BYTES), (offset) =>
    client.write(
      handle,
      offset,
      data.subarray(offset, offset + WRITE_CHUNK_BYTES),
    ),
  );
  await client.close(handle);
}

/** Read a file back in the largest reads; returns it and each read's length. */
async function readFile(
  client: SftpClient,
  path: string,
  length: number,
): Promise<{ data: Uint8Array<ArrayBuffer>; readLengths: Array<number> }> {
  const handle = await client.open(path, SftpOpenFlags.read);
  const data = new Uint8Array(length);
  const readLengths: Array<number> = [];
  await pipelined(offsetsOf(length, SFTP_MAX_READ_BYTES), async (offset) => {
    const chunk = await client.read(handle, offset, SFTP_MAX_READ_BYTES);
    if (chunk === null) throw new Error(`end of file at ${offset}`);
    data.set(chunk, offset);
    readLengths.push(chunk.length);
  });
  expect(await client.read(handle, length, SFTP_MAX_READ_BYTES)).toBeNull();
  await client.close(handle);
  return { data, readLengths };
}

sshTest.each([
  { label: "1 MiB", length: 1024 * 1024 },
  { label: "8 MiB", length: 8 * 1024 * 1024 },
])(
  "writes $label through the relay and reads it back unchanged",
  async ({ length }) => {
    const { client, root } = await openSftp();
    const data = randomBytes(length);
    const path = `${root}/payload.bin`;
    await writeFile(client, path, data);
    expect((await client.stat(path)).size).toBe(length);
    const { data: readBack, readLengths } = await readFile(
      client,
      path,
      length,
    );
    expect(await sha256(readBack)).toBe(await sha256(data));
    // OpenSSH answers each full read in full: a DATA reply at the inbound cap.
    expect(
      readLengths.filter((read) => read === SFTP_MAX_READ_BYTES).length,
    ).toBe(Math.floor(length / SFTP_MAX_READ_BYTES));
  },
);

sshTest(
  "lists, renames, removes and stats in the served directory",
  async () => {
    const { client, root } = await openSftp();
    const names = async (): Promise<Array<string>> => {
      const handle = await client.opendir(root);
      const found: Array<string> = [];
      for (
        let batch = await client.readdir(handle);
        batch !== null;
        batch = await client.readdir(handle)
      )
        found.push(...batch.map((entry) => entry.filename));
      await client.close(handle);
      return found.filter((name) => name !== "." && name !== "..").sort();
    };

    await writeFile(client, `${root}/a.json`, Uint8Array.of(1, 2, 3));
    await writeFile(client, `${root}/b.json`, Uint8Array.of(4));
    expect(await names()).toEqual(["a.json", "b.json"]);
    expect(await client.stat(`${root}/a.json`)).toMatchObject({ size: 3 });

    await expect(
      client.open(
        `${root}/a.json`,
        SftpOpenFlags.write | SftpOpenFlags.create | SftpOpenFlags.exclusive,
      ),
    ).rejects.toBeInstanceOf(SftpFailureError);
    await expect(
      client.rename(`${root}/a.json`, `${root}/b.json`),
    ).rejects.toBeInstanceOf(SftpFailureError);

    await client.rename(`${root}/a.json`, `${root}/c.json`);
    expect(await names()).toEqual(["b.json", "c.json"]);
    await expect(client.stat(`${root}/a.json`)).rejects.toBeInstanceOf(
      SftpNoSuchFileError,
    );

    await client.remove(`${root}/b.json`);
    expect(await names()).toEqual(["c.json"]);
    await expect(client.remove(`${root}/b.json`)).rejects.toBeInstanceOf(
      SftpNoSuchFileError,
    );

    expect(await client.realpath(`${root}/c.json`)).toMatch(/\/c\.json$/);
  },
);
