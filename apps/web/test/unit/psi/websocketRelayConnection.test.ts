import { describe, expect, test, vi } from "vitest";

import {
  ConnectionError,
  PeerJsFrameEncoder,
  checkWebSocketRelayProof,
  deriveWebSocketRelayProofKey,
  packCloseSentinel,
  parseWebSocketRelayProof,
} from "@alcove/core";
import { boundedInboundFramesWithBounds } from "@alcove/core/testing";

import { openWebSocketRelayConnection } from "../../../src/psi/transport/websocketRelayConnection.js";

import type { MessageConnection } from "@alcove/core";
import type { PeerCloseOutcome } from "../../../src/psi/transport/waitForPeerClose.js";
import type { WebSocketRelayConnectionOptions } from "../../../src/psi/transport/websocketRelayConnection.js";

/** The relay key of the secret of bytes 0x00..0x1f (docs/spec/PROTOCOL.md). */
const RELAY_KEY =
  "1d970dcfd9f445a4c83c4ee3b03845209f891b2931e8b7bb2b41a17dd2249a9e";
const RELAY_URL = "wss://relay.example/relay";
const PAIRED = '{"type":"paired"}';
const START = '{"type":"start"}';

/**
 * A browser `WebSocket` as the transport uses it. `close()` records the code
 * and leaves the socket closed without an event, as this side's own close
 * reaches no handler that matters; `closeFromRelay` is the relay's close.
 */
class FakeRelaySocket extends EventTarget {
  binaryType: BinaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    super();
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("send on a socket not open");
    this.sent.push(data);
    if (typeof data !== "string") this.bufferedAmount += data.byteLength;
  }

  close(code?: number): void {
    if (this.readyState >= 2) return;
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  fromRelay(data: string | Uint8Array): void {
    const payload =
      typeof data === "string"
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.dispatchEvent(new MessageEvent("message", { data: payload }));
  }

  closeFromRelay(code: number, reason = ""): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  binarySent(): Array<Uint8Array> {
    return this.sent.filter((d): d is Uint8Array => typeof d !== "string");
  }
}

interface Opening {
  socket: FakeRelaySocket;
  pending: Promise<MessageConnection>;
}

/** Start opening a connection and wait until its socket exists. */
async function startOpening(
  options: Partial<WebSocketRelayConnectionOptions> = {},
): Promise<Opening> {
  let socket: FakeRelaySocket | undefined;
  const pending = openWebSocketRelayConnection({
    url: RELAY_URL,
    exchangeId: "exchange-1",
    role: "inviter",
    relayKey: RELAY_KEY,
    createSocket: (url) => {
      socket = new FakeRelaySocket(url);
      return socket as unknown as WebSocket;
    },
    ...options,
  });
  pending.catch(() => {});
  await vi.waitFor(() => {
    if (socket === undefined) throw new Error("no socket yet");
  });
  return { socket: socket as FakeRelaySocket, pending };
}

/** Open a connection the relay has paired and started. */
async function openStarted(
  options: Partial<WebSocketRelayConnectionOptions> = {},
): Promise<{ socket: FakeRelaySocket; mc: MessageConnection }> {
  const { socket, pending } = await startOpening(options);
  socket.open();
  socket.fromRelay(PAIRED);
  socket.fromRelay(START);
  return { socket, mc: await pending };
}

/** The datagrams a partner sends for `value`. */
function partnerFrames(value: unknown): Array<Uint8Array> {
  return new PeerJsFrameEncoder().encode(value);
}

describe("the hello", () => {
  test("sends the hello and the start at once on open, and resolves on the partner's start", async () => {
    const { socket, pending } = await startOpening({ role: "acceptor" });
    expect(socket.url).toBe(RELAY_URL);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toHaveLength(2);
    const hello = JSON.parse(socket.sent[0] as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(hello).sort()).toEqual(
      ["exchangeId", "proof", "role", "tag", "type"].sort(),
    );
    expect(hello).toMatchObject({
      type: "hello",
      exchangeId: "exchange-1",
      role: "acceptor",
    });
    expect(hello.tag).toMatch(/^[0-9a-f]{64}$/);
    expect(socket.sent[1]).toBe(START);

    const proof = parseWebSocketRelayProof(
      new TextEncoder().encode(hello.proof as string),
      Uint8Array.from(Buffer.from(hello.tag as string, "hex")),
    );
    await expect(
      checkWebSocketRelayProof({
        proofKey: await deriveWebSocketRelayProofKey(RELAY_KEY),
        proof,
        role: "acceptor",
        now: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(proof.expiresAtSeconds - Math.floor(Date.now() / 1000)).toBe(300);

    socket.fromRelay(PAIRED);
    let resolved = false;
    void pending.then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.fromRelay(START);
    await expect(pending).resolves.toBeDefined();
  });

  test("refuses an address that is not wss before opening a socket", async () => {
    const createSocket = vi.fn();
    await expect(
      openWebSocketRelayConnection({
        url: "ws://relay.example/relay",
        exchangeId: "exchange-1",
        role: "inviter",
        relayKey: RELAY_KEY,
        createSocket,
      }),
    ).rejects.toMatchObject({ kind: "usage", message: /wss:\/\// });
    expect(createSocket).not.toHaveBeenCalled();
  });

  test.each(["wss://relay.example/relay#part", "wss://relay.example/relay#"])(
    "refuses the address %s, which has a fragment, before opening a socket",
    async (url) => {
      const createSocket = vi.fn();
      const error = await openWebSocketRelayConnection({
        url,
        exchangeId: "exchange-1",
        role: "inviter",
        relayKey: RELAY_KEY,
        createSocket,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({
        kind: "usage",
        message: `The WebSocket relay address ${url} has a fragment, a part starting with #. Remove the fragment from the relay address, then start the exchange again.`,
      });
      expect(createSocket).not.toHaveBeenCalled();
    },
  );

  test("a socket the browser refuses to open is a usage failure naming the address", async () => {
    const refusal = new DOMException("blocked port", "SecurityError");
    const error = await openWebSocketRelayConnection({
      url: "wss://relay.example:6000/relay",
      exchangeId: "exchange-1",
      role: "inviter",
      relayKey: RELAY_KEY,
      createSocket: () => {
        throw refusal;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({
      kind: "usage",
      message:
        "The browser refused to open a connection to the WebSocket relay at wss://relay.example:6000/relay. Check the relay address, then start the exchange again.",
      cause: refusal,
    });
  });

  test("a relay key no proof can be built from is a usage failure", async () => {
    const error = await openWebSocketRelayConnection({
      url: RELAY_URL,
      exchangeId: "exchange-1",
      role: "inviter",
      relayKey: "not-a-key",
      createSocket: vi.fn(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({
      kind: "usage",
      message: /^Could not build this side's proof for the WebSocket relay/,
    });
  });

  test("refuses exchange data the relay passes on before both starts", async () => {
    const { socket, pending } = await startOpening();
    socket.open();
    socket.fromRelay(PAIRED);
    socket.fromRelay(partnerFrames("early")[0]);
    await expect(pending).rejects.toMatchObject({ kind: "protocol" });
    expect(socket.closedWith).toBe(4000);
  });

  test("refuses a start before the pairing", async () => {
    const { socket, pending } = await startOpening();
    socket.open();
    socket.fromRelay(START);
    await expect(pending).rejects.toMatchObject({ kind: "protocol" });
  });

  test("gives up when no partner arrives within the pairing wait", async () => {
    const { socket, pending } = await startOpening({ pairingTimeoutMs: 20 });
    socket.open();
    await expect(pending).rejects.toMatchObject({
      kind: "transport",
      message: /did not reach the WebSocket relay within 1 minute\./,
    });
    expect(socket.closedWith).toBe(4000);
  });

  test("gives up when a paired partner does not start", async () => {
    const { socket, pending } = await startOpening({ startTimeoutMs: 20 });
    socket.open();
    socket.fromRelay(PAIRED);
    await expect(pending).rejects.toThrow(/did not start the exchange/);
  });

  test("an abort while waiting for the partner closes the socket", async () => {
    const controller = new AbortController();
    const { socket, pending } = await startOpening({
      signal: controller.signal,
    });
    socket.open();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "closed" });
    expect(socket.closedWith).toBe(4000);
  });
});

describe("a refused hello", () => {
  const refusals: Array<[number, RegExp]> = [
    [4003, /no key enrolled for this exchange\. Enroll the exchange/],
    [
      4004,
      /refused this side's proof: the key it holds for this exchange is not the one this invitation gives\. Check that both parties use the current invitation/,
    ],
    [4006, /Another connection already holds this side's place/],
    [4008, /as many exchanges as it allows\. Wait a few minutes/],
    [1011, /could not check this side's proof\. Wait a few minutes/],
  ];

  test.each(refusals)(
    "code %i states what happened and what to do",
    async (code, message) => {
      const { socket, pending } = await startOpening();
      socket.open();
      socket.closeFromRelay(code);
      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).kind).toBe("transport");
      expect((error as Error).message).toMatch(message);
    },
  );

  describe("an expired proof", () => {
    const localSecond = 1_767_225_600;

    /** Start opening a connection that records every socket it dials. */
    function startRecording(): {
      sockets: Array<FakeRelaySocket>;
      pending: Promise<MessageConnection>;
    } {
      const sockets: Array<FakeRelaySocket> = [];
      const pending = openWebSocketRelayConnection({
        url: RELAY_URL,
        exchangeId: "exchange-1",
        role: "inviter",
        relayKey: RELAY_KEY,
        now: () => new Date(localSecond * 1000),
        createSocket: (url) => {
          const socket = new FakeRelaySocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
      pending.catch(() => {});
      return { sockets, pending };
    }

    async function dialed(
      sockets: Array<FakeRelaySocket>,
      count: number,
    ): Promise<FakeRelaySocket> {
      await vi.waitFor(() => expect(sockets).toHaveLength(count));
      return sockets[count - 1];
    }

    function proofExpiry(socket: FakeRelaySocket): number {
      const hello = JSON.parse(socket.sent[0] as string) as Record<
        string,
        string
      >;
      return parseWebSocketRelayProof(
        new TextEncoder().encode(hello.proof),
        Uint8Array.from(Buffer.from(hello.tag, "hex")),
      ).expiresAtSeconds;
    }

    test("is signed again once on the relay's clock, over a new socket", async () => {
      const { sockets, pending } = startRecording();
      const first = await dialed(sockets, 1);
      first.open();
      expect(proofExpiry(first)).toBe(localSecond + 300);
      const relaySecond = localSecond + 3_600;
      first.closeFromRelay(4005, String(relaySecond));

      const second = await dialed(sockets, 2);
      second.open();
      expect(proofExpiry(second)).toBe(relaySecond + 300);
      expect(second.sent[1]).toBe(START);
      second.fromRelay(PAIRED);
      second.fromRelay(START);
      await expect(pending).resolves.toBeDefined();
      expect(sockets).toHaveLength(2);
    });

    test("refused again on the relay's clock ends the attempt without blaming this device's clock", async () => {
      const { sockets, pending } = startRecording();
      const first = await dialed(sockets, 1);
      first.open();
      first.closeFromRelay(4005, String(localSecond + 3_600));
      const second = await dialed(sockets, 2);
      second.open();
      second.closeFromRelay(4005, String(localSecond + 7_200));

      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({
        kind: "transport",
        message:
          "The WebSocket relay refused this side's proof as expired twice, the second time signed on the relay's own clock. Start the exchange again, and if the relay refuses it again, check the relay and the exchange's enrollment at it.",
      });
      expect(sockets).toHaveLength(2);
    });

    test.each([
      ["text that is not a second", "\u001b[31mspoofed"],
      ["an empty reason", ""],
      ["a second past what a date can hold", "9000000000000000"],
    ])(
      "with %s ends the attempt with the refusal and uses none of the reason",
      async (_label, reason) => {
        const { sockets, pending } = startRecording();
        const first = await dialed(sockets, 1);
        first.open();
        first.closeFromRelay(4005, reason);

        const error = await pending.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConnectionError);
        expect(error).toMatchObject({
          kind: "transport",
          message:
            "The WebSocket relay refused this side's proof as expired: this device's clock is behind the relay's. Set this device's clock to the correct time, then start the exchange again.",
        });
        expect(sockets).toHaveLength(1);
      },
    );
  });

  test("a socket that never opens is a connection failure", async () => {
    const { socket, pending } = await startOpening();
    socket.closeFromRelay(1006);
    await expect(pending).rejects.toThrow(
      /Could not connect to the WebSocket relay/,
    );
  });
});

describe("pacing", () => {
  test("stops at the 1 MiB window and resumes once the buffer is at 256 KiB", async () => {
    const { socket, mc } = await openStarted();
    // Two frames of four chunks each; the window fills inside the first.
    const frame = new Uint8Array(60_000).fill(7);
    socket.bufferedAmount = 1024 * 1024 - 20_000;
    const sends = Promise.all([mc.send(frame), mc.send(frame)]);

    await vi.waitFor(() => expect(socket.binarySent()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.binarySent()).toHaveLength(2);

    socket.bufferedAmount = 256 * 1024 + 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.binarySent()).toHaveLength(2);

    socket.bufferedAmount = 256 * 1024;
    await sends;
    expect(socket.binarySent()).toHaveLength(8);
  });

  test("a send waiting on the window fails once the socket closes", async () => {
    const { socket, mc } = await openStarted();
    socket.bufferedAmount = 1024 * 1024;
    const send = mc.send(new Uint8Array(10));
    socket.closeFromRelay(4000);
    await expect(send).rejects.toBeInstanceOf(ConnectionError);
    expect(socket.binarySent()).toHaveLength(0);
  });
});

describe("the inbound path", () => {
  test("reassembles the partner's chunked frame", async () => {
    const { socket, mc } = await openStarted();
    const frame = new Uint8Array(50_000).map((_, i) => i & 0xff);
    for (const datagram of partnerFrames(frame)) socket.fromRelay(datagram);
    const received = (await mc.receive()) as Uint8Array;
    expect(Array.from(received)).toEqual(Array.from(frame));
  });

  test("refuses a frame above the reassembler's size limit and delivers nothing", async () => {
    const { socket, mc } = await openStarted({
      inboundFrames: () =>
        boundedInboundFramesWithBounds({ maxFrameBytes: 40_000 }),
    });
    for (const datagram of partnerFrames(new Uint8Array(60_000)))
      socket.fromRelay(datagram);
    await expect(mc.receive()).rejects.toMatchObject({
      kind: "protocol",
      message: /exceeds its 40000-byte size limit/,
    });
    expect(socket.closedWith).toBe(4000);
  });

  test("refuses a text message once forwarding has started", async () => {
    const { socket, mc } = await openStarted();
    socket.fromRelay(START);
    await expect(mc.receive()).rejects.toMatchObject({ kind: "protocol" });
  });

  test("the partner's sentinel drains its final frame and closes cleanly", async () => {
    const { socket, mc } = await openStarted();
    for (const datagram of partnerFrames("final")) socket.fromRelay(datagram);
    socket.fromRelay(packCloseSentinel());
    expect(socket.closedWith).toBe(1000);
    await expect(mc.receive()).resolves.toBe("final");
    await expect(mc.receive()).rejects.toThrow("peer connection closed");
  });

  test("a partner that ends without a clean close fails the connection", async () => {
    const { socket, mc } = await openStarted();
    socket.closeFromRelay(4000);
    await expect(mc.receive()).rejects.toThrow(
      /partner's connection to the WebSocket relay ended without a clean close/,
    );
  });
});

describe("the close", () => {
  async function flushingClose(
    options: Partial<WebSocketRelayConnectionOptions> = {},
  ) {
    const outcomes: Array<PeerCloseOutcome> = [];
    const opened = await openStarted({
      onCloseOutcome: (outcome) => outcomes.push(outcome),
      ...options,
    });
    await opened.mc.send("last");
    let closed = false;
    const closing = opened.mc.close().then(() => (closed = true));
    await vi.waitFor(() =>
      expect(opened.socket.binarySent().at(-1)).toEqual(packCloseSentinel()),
    );
    return { ...opened, outcomes, closing, isClosed: () => closed };
  }

  test("waits for the partner's relayed close after sending the sentinel", async () => {
    const { socket, outcomes, closing, isClosed } = await flushingClose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isClosed()).toBe(false);
    expect(socket.closedWith).toBeUndefined();

    socket.closeFromRelay(1000);
    await closing;
    expect(outcomes).toEqual(["peer-closed"]);
  });

  test("ends the wait on the partner's own sentinel and closes cleanly", async () => {
    const { socket, outcomes, closing } = await flushingClose();
    socket.fromRelay(packCloseSentinel());
    await closing;
    expect(outcomes).toEqual(["peer-closed"]);
    expect(socket.closedWith).toBe(1000);
  });

  test("a partner that ends abnormally during the wait is reported gone", async () => {
    const { socket, outcomes, closing } = await flushingClose();
    socket.closeFromRelay(4000);
    await closing;
    expect(outcomes).toEqual(["peer-gone"]);
  });

  test("stops at the close drain budget and closes without a clean close", async () => {
    const { socket, outcomes, closing } = await flushingClose({
      closeDrainTimeoutMs: 30,
    });
    await closing;
    expect(outcomes).toEqual(["ceiling"]);
    expect(socket.closedWith).toBe(4000);
  });

  test("an abort ends the wait", async () => {
    const controller = new AbortController();
    const { outcomes, closing } = await flushingClose({
      signal: controller.signal,
    });
    controller.abort();
    await closing;
    expect(outcomes).toEqual(["run-aborted"]);
  });
});
