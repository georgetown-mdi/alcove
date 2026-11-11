import { describe, expect, test, vi } from "vitest";

import {
  BROWSER_SSH_KEY_EXCHANGES,
  createBrowserSshConfiguration,
} from "@psi/transport/browserSsh/sshSessionConfiguration";
import {
  BrowserSshNoCommonAlgorithmError,
  BrowserSshRelayClosedError,
} from "@psi/transport/browserSsh/browserSshErrors";
import {
  connectBrowserSsh,
  provideBufferGlobal,
} from "@psi/transport/browserSsh/browserSshClient";
import { Buffer } from "@psi/transport/browserSsh/sshLibrary";
import { NonExtractableEcdsaP256KeyPair } from "@psi/transport/browserSsh/nonExtractableEcdsaKey";

import { FakeRelaySocket } from "./fakeRelaySocket";

const SSH_MSG_KEXINIT = 20;
const SERVER_VERSION = "SSH-2.0-OpenSSH_9.6\r\n";

/** The ten name-lists of an SSH_MSG_KEXINIT (RFC 4253, section 7.1). */
interface KexInitLists {
  kex: Array<string>;
  hostKey: Array<string>;
  encryptionClientToServer: Array<string>;
  encryptionServerToClient: Array<string>;
  macClientToServer: Array<string>;
  macServerToClient: Array<string>;
  compressionClientToServer: Array<string>;
  compressionServerToClient: Array<string>;
}

const OPENSSH_DEFAULTS: KexInitLists = {
  kex: ["curve25519-sha256", "ecdh-sha2-nistp256"],
  hostKey: ["ssh-ed25519"],
  encryptionClientToServer: ["aes256-gcm@openssh.com"],
  encryptionServerToClient: ["aes256-gcm@openssh.com"],
  macClientToServer: ["hmac-sha2-256-etm@openssh.com"],
  macServerToClient: ["hmac-sha2-256-etm@openssh.com"],
  compressionClientToServer: ["none"],
  compressionServerToClient: ["none"],
};

function nameList(names: ReadonlyArray<string>): Buffer {
  const body = Buffer.from(names.join(","), "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** An unencrypted binary packet carrying a server KEXINIT. */
function kexInitPacket(lists: KexInitLists): Buffer {
  const payload = Buffer.concat([
    Buffer.from([SSH_MSG_KEXINIT]),
    Buffer.alloc(16, 0x5a),
    nameList(lists.kex),
    nameList(lists.hostKey),
    nameList(lists.encryptionClientToServer),
    nameList(lists.encryptionServerToClient),
    nameList(lists.macClientToServer),
    nameList(lists.macServerToClient),
    nameList(lists.compressionClientToServer),
    nameList(lists.compressionServerToClient),
    nameList([]),
    nameList([]),
    Buffer.from([0, 0, 0, 0, 0]),
  ]);
  let padding = 8 - ((5 + payload.length) % 8);
  if (padding < 4) padding += 8;
  const header = Buffer.alloc(5);
  header.writeUInt32BE(1 + payload.length + padding);
  header[4] = padding;
  return Buffer.concat([header, payload, Buffer.alloc(padding)]);
}

/** The name-lists of the first KEXINIT in what the client sent. */
function clientKexInit(
  sent: ReadonlyArray<Uint8Array>,
): Array<Array<string>> | null {
  const bytes = Buffer.concat(sent.map((part) => Buffer.from(part)));
  const lineEnd = bytes.indexOf("\r\n");
  if (lineEnd < 0 || bytes.length < lineEnd + 2 + 5) return null;
  const packet = bytes.subarray(lineEnd + 2);
  const length = packet.readUInt32BE(0);
  if (packet.length < 4 + length) return null;
  let offset = 5;
  if (packet[offset] !== SSH_MSG_KEXINIT) return null;
  offset += 1 + 16;
  const lists: Array<Array<string>> = [];
  for (let index = 0; index < 10; index += 1) {
    const listLength = packet.readUInt32BE(offset);
    const text = packet.toString("ascii", offset + 4, offset + 4 + listLength);
    lists.push(text === "" ? [] : text.split(","));
    offset += 4 + listLength;
  }
  return lists;
}

/** A relay socket that answers the client's version line as `server` would. */
function scriptedServer(server: KexInitLists): FakeRelaySocket {
  const socket = new FakeRelaySocket();
  let answered = false;
  socket.onSend = () => {
    if (answered) return;
    answered = true;
    queueMicrotask(() => {
      socket.receive(Buffer.from(SERVER_VERSION, "ascii"));
      socket.receive(kexInitPacket(server));
    });
  };
  return socket;
}

async function connectTo(socket: FakeRelaySocket) {
  const onHostKey = vi.fn(() => true);
  const outcome = connectBrowserSsh({
    relayUrl: "ws://relay.test/sftp",
    username: "alcove",
    key: await NonExtractableEcdsaP256KeyPair.generate(),
    onHostKey,
    createSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { failure: await outcome, onHostKey };
}

describe("the browser SSH configuration", () => {
  test("offers ECDH only, and no none algorithm, key-exchange guess or other method", () => {
    const config = createBrowserSshConfiguration();
    const names = (list: ReadonlyArray<{ name: string } | null>) =>
      list.map((algorithm) => algorithm?.name);
    expect(names(config.keyExchangeAlgorithms)).toEqual([
      ...BROWSER_SSH_KEY_EXCHANGES,
    ]);
    expect(names(config.publicKeyAlgorithms)).toEqual([
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "rsa-sha2-512",
      "rsa-sha2-256",
    ]);
    expect(names(config.encryptionAlgorithms)).toEqual([
      "aes256-gcm@openssh.com",
      "aes256-ctr",
    ]);
    expect(names(config.hmacAlgorithms)).toEqual([
      "hmac-sha2-512-etm@openssh.com",
      "hmac-sha2-256-etm@openssh.com",
      "hmac-sha2-512",
      "hmac-sha2-256",
    ]);
    expect(config.authenticationMethods).toEqual(["publickey"]);
    expect(config.enableKeyExchangeGuess).toBe(false);
  });

  test("puts only ECDH key exchanges in the KEXINIT it sends", async () => {
    const socket = scriptedServer({
      ...OPENSSH_DEFAULTS,
      kex: ["diffie-hellman-group14-sha256"],
    });
    await connectTo(socket);
    const lists = clientKexInit(socket.sent);
    expect(lists).not.toBeNull();
    const [kex, , encryption] = lists!;
    expect(kex.filter((name) => !name.startsWith("ext-info-"))).toEqual([
      ...BROWSER_SSH_KEY_EXCHANGES,
    ]);
    expect(kex.some((name) => name.startsWith("diffie-hellman"))).toBe(false);
    expect(encryption).not.toContain("none");
  });
});

describe("negotiation failure", () => {
  test.each([
    {
      label: "only finite-field Diffie-Hellman",
      server: { ...OPENSSH_DEFAULTS, kex: ["diffie-hellman-group14-sha256"] },
      category: "KeyExchange",
    },
    {
      label: "only a cipher the client does not offer",
      server: {
        ...OPENSSH_DEFAULTS,
        encryptionClientToServer: ["aes128-ctr"],
        encryptionServerToClient: ["aes128-ctr"],
      },
      category: "ClientEncryption",
    },
  ])(
    "names the category when the server offers $label",
    async ({ server, category }) => {
      const { failure, onHostKey } = await connectTo(scriptedServer(server));
      expect(failure).toBeInstanceOf(BrowserSshNoCommonAlgorithmError);
      expect(failure).toMatchObject({ category });
      expect(onHostKey).not.toHaveBeenCalled();
    },
  );

  test("reports the relay's close code when the relay closes before the server answers", async () => {
    const socket = new FakeRelaySocket();
    socket.onSend = () => {
      if (clientKexInit(socket.sent) !== null)
        queueMicrotask(() => socket.remoteClose(4001, "targetUnreachable"));
    };
    const { failure, onHostKey } = await connectTo(socket);
    expect(failure).toBeInstanceOf(BrowserSshRelayClosedError);
    expect(failure).toMatchObject({ code: 4001 });
    expect(onHostKey).not.toHaveBeenCalled();
  });
});

describe("abort", () => {
  async function connectWith(
    signal: AbortSignal,
    createSocket: () => FakeRelaySocket,
  ): Promise<unknown> {
    return connectBrowserSsh({
      relayUrl: "ws://relay.test/sftp",
      username: "alcove",
      key: await NonExtractableEcdsaP256KeyPair.generate(),
      onHostKey: () => true,
      signal,
      createSocket,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  test("an already-aborted signal rejects without opening a socket", async () => {
    const reason = new Error("stopped");
    const createSocket = vi.fn(() => new FakeRelaySocket());
    const failure = await connectWith(AbortSignal.abort(reason), createSocket);
    expect(failure).toBe(reason);
    expect(createSocket).not.toHaveBeenCalled();
  });

  test("an abort before the relay socket opens closes it and rejects", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const socket = new FakeRelaySocket();
    const failure = connectWith(controller.signal, () => {
      queueMicrotask(() => controller.abort(reason));
      return socket;
    });
    expect(await failure).toBe(reason);
    expect(socket.closedWith).toBe(1000);
  });

  test("an abort while the server stalls mid-connect closes the socket and rejects", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const socket = new FakeRelaySocket();
    socket.onSend = () => {
      if (clientKexInit(socket.sent) !== null)
        queueMicrotask(() => {
          socket.receive(Buffer.from(SERVER_VERSION, "ascii"));
          controller.abort(reason);
        });
    };
    const failure = await connectWith(controller.signal, () => {
      queueMicrotask(() => socket.open());
      return socket;
    });
    expect(failure).toBe(reason);
    expect(socket.closedWith).toBe(1000);
  });
});

describe("provideBufferGlobal", () => {
  test("installs Buffer when the page has none and leaves an existing one", () => {
    const scope = globalThis as { Buffer?: unknown };
    const original = scope.Buffer;
    try {
      delete scope.Buffer;
      provideBufferGlobal();
      expect(scope.Buffer).toBe(Buffer);
      const existing = { marker: true };
      scope.Buffer = existing;
      provideBufferGlobal();
      expect(scope.Buffer).toBe(existing);
    } finally {
      scope.Buffer = original;
    }
  });
});
