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

import {
  openWebSocketRelayConnection,
  parkWebSocketRelayConnection,
} from "../../../src/psi/transport/websocketRelayConnection.js";

import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "../../../src/psi/transport/websocketRelayConnection.js";
import type { MessageConnection } from "@alcove/core";
import type { PeerCloseOutcome } from "../../../src/psi/transport/waitForPeerClose.js";

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

/**
 * Start opening a connection and resolve as its socket is made, so a test
 * acts on it before the pairing wait, which counts from the start of the
 * opening, can run out.
 */
async function startOpening(
  options: Partial<WebSocketRelayConnectionOptions> = {},
): Promise<Opening> {
  let made!: (socket: FakeRelaySocket) => void;
  const dialed = new Promise<FakeRelaySocket>((resolve) => (made = resolve));
  const pending = openWebSocketRelayConnection({
    url: RELAY_URL,
    exchangeId: "exchange-1",
    role: "inviter",
    relayKey: RELAY_KEY,
    createSocket: (url) => {
      const socket = new FakeRelaySocket(url);
      made(socket);
      return socket as unknown as WebSocket;
    },
    ...options,
  });
  pending.catch(() => {});
  const settledFirst = pending.then(() => {
    throw new Error("the opening resolved before it made a socket");
  });
  return { socket: await Promise.race([dialed, settledFirst]), pending };
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
    // The proof is signed on the clock read as the opening starts, so its
    // expiry is held to the seconds read around the opening: a clock read after
    // the awaits below can fall in the next second.
    const openedFromSecond = Math.floor(Date.now() / 1000);
    const { socket, pending } = await startOpening({ role: "acceptor" });
    const openedBySecond = Math.floor(Date.now() / 1000);
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
    expect(proof.expiresAtSeconds - 300).toBeGreaterThanOrEqual(
      openedFromSecond,
    );
    expect(proof.expiresAtSeconds - 300).toBeLessThanOrEqual(openedBySecond);

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
    ).rejects.toMatchObject({
      kind: "usage",
      message: expect.stringMatching(/wss:\/\//),
    });
    expect(createSocket).not.toHaveBeenCalled();
  });

  test.each([
    ["wss://relay.example/relay#part", "wss://relay.example"],
    ["wss://relay.example/relay#", "wss://relay.example"],
    [
      "wss://user:pw@relay.example:8443/relay?q=1#Call 555-0100 for help",
      "wss://relay.example:8443",
    ],
  ])(
    "refuses the address %s, which has a fragment, naming only its origin, before opening a socket",
    async (url, origin) => {
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
        message: `The WebSocket relay address for ${origin} has a fragment, a part starting with #. Remove the fragment from the relay address, then start the exchange again.`,
      });
      expect(createSocket).not.toHaveBeenCalled();
    },
  );

  test("a socket the browser refuses to open is a usage failure naming only the address's origin", async () => {
    const refusal = new DOMException("blocked port", "SecurityError");
    const error = await openWebSocketRelayConnection({
      url: "wss://user:pw@relay.example:6000/relay/secret-path?q=secret-query",
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
        "The browser refused to open a connection to the WebSocket relay at wss://relay.example:6000. Check the relay address, then start the exchange again.",
      cause: refusal,
    });
    const { message } = error as ConnectionError;
    expect(message).not.toContain("secret-path");
    expect(message).not.toContain("secret-query");
    expect(message).not.toContain("user:pw");
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
      message: expect.stringMatching(
        /^Could not build this side's proof for the WebSocket relay/,
      ),
    });
  });

  test.each([
    ["before the pairing", []],
    ["after the pairing, before the partner's start", [PAIRED]],
  ])(
    "refuses exchange data the relay passes on %s",
    async (_label, controlFrames) => {
      const { socket, pending } = await startOpening();
      socket.open();
      for (const frame of controlFrames) socket.fromRelay(frame);
      socket.fromRelay(partnerFrames("early")[0]);
      await expect(pending).rejects.toMatchObject({
        kind: "protocol",
        message: expect.stringMatching(
          /passed on exchange data before both parties had started/,
        ),
      });
      expect(socket.closedWith).toBe(4000);
    },
  );

  test("refuses a start before the pairing", async () => {
    const { socket, pending } = await startOpening();
    socket.open();
    socket.fromRelay(START);
    await expect(pending).rejects.toMatchObject({ kind: "protocol" });
  });

  test("gives up when no partner arrives within the pairing wait", async () => {
    const { socket, pending } = await startOpening({ pairingTimeoutMs: 300 });
    socket.open();
    await expect(pending).rejects.toMatchObject({ kind: "transport" });
    await expect(pending).rejects.toThrow(
      /did not reach the WebSocket relay within 1 minute\./,
    );
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
    [
      4010,
      /ended the exchange because the exchange partner stopped receiving\. Start the exchange again/,
    ],
  ];

  test.each(refusals)(
    "code %i states what happened and what to do",
    async (code, message) => {
      // A code dialed again on is reported when the pairing wait ends.
      const { socket, pending } = await startOpening({
        pairingTimeoutMs: 300,
        redialIntervalMs: 60_000,
      });
      socket.open();
      socket.closeFromRelay(code);
      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).kind).toBe("transport");
      expect((error as Error).message).toMatch(message);
    },
  );

  test("a refused proof after a cut rotation names the state and the new invitation, and no step that changes a key or a secret", async () => {
    const { socket, pending } = await startOpening({ afterCutRotation: true });
    socket.open();
    socket.closeFromRelay(4004);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).kind).toBe("transport");
    expect((error as Error).message).toBe(
      "The WebSocket relay refused this side's proof: the key it holds for " +
        "this exchange is not the one this device's secret gives. A run " +
        "stopped before both of you saved a new secret, so the key may be " +
        "the one your partner's secret gives, and the exchange can still " +
        "reach your partner over WebRTC or another relay. If the next run " +
        "does not reach them either, reconnect with a new invitation.",
    );
    expect((error as Error).message).not.toMatch(
      /current invitation|enroll|replace|delete|remove/i,
    );
  });

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
    const { socket, pending } = await startOpening({
      pairingTimeoutMs: 300,
      redialIntervalMs: 60_000,
    });
    socket.closeFromRelay(1006);
    await expect(pending).rejects.toThrow(
      /Could not connect to the WebSocket relay/,
    );
  });
});

describe("pacing", () => {
  test("checks the 1 MiB window before each datagram, passing it by under one datagram, and resumes once the buffer is at 256 KiB", async () => {
    const { socket, mc } = await openStarted();
    // Two frames of four chunks each; the window fills inside the first.
    const frame = new Uint8Array(60_000).fill(7);
    socket.bufferedAmount = 1024 * 1024 - 20_000;
    const sends = Promise.all([mc.send(frame), mc.send(frame)]);

    await vi.waitFor(() => expect(socket.binarySent()).toHaveLength(2));
    const overshoot = socket.bufferedAmount - 1024 * 1024;
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThan(socket.binarySent()[1].byteLength);
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

  test("a send the socket throws on fails the connection and closes with 4000", async () => {
    const { socket, mc } = await openStarted();
    socket.send = () => {
      throw new Error("send failed");
    };
    await expect(mc.send("lost")).rejects.toMatchObject({ kind: "transport" });
    expect(socket.closedWith).toBe(4000);
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
      message: expect.stringMatching(/exceeds its 40000-byte size limit/),
    });
    expect(socket.closedWith).toBe(4000);
  });

  test("refuses a chunk repeated past the chunk limit before the frame is joined", async () => {
    const { socket, mc } = await openStarted({
      inboundFrames: () => boundedInboundFramesWithBounds({ maxChunks: 4 }),
    });
    const chunks = partnerFrames(new Uint8Array(20_000).fill(3));
    expect(chunks).toHaveLength(2);
    const [first, last] = chunks;
    // Repeats past the declared two chunks are charged against the limit of
    // four, and the fifth arrival is refused.
    for (let i = 0; i < 4; i++) socket.fromRelay(first);
    expect(socket.closedWith).toBeUndefined();
    socket.fromRelay(first);
    expect(socket.closedWith).toBe(4000);
    socket.fromRelay(last);
    await expect(mc.receive()).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringMatching(/exceeds its 4-chunk reassembly limit/),
    });
  });

  test("refuses a text message once forwarding has started and closes with 4000", async () => {
    const { socket, mc } = await openStarted();
    socket.fromRelay(START);
    await expect(mc.receive()).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringMatching(
        /sent a control message after the exchange started/,
      ),
    });
    expect(socket.closedWith).toBe(4000);
  });

  test("a receive that waits past the inactivity budget closes with 4000", async () => {
    const { socket, mc } = await openStarted({ inactivityTimeoutMs: 30 });
    await expect(mc.receive()).rejects.toMatchObject({
      kind: "transport",
      message: expect.stringMatching(/no message arrived within 30 ms/),
    });
    expect(socket.closedWith).toBe(4000);
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

  test("a relay that ends the exchange because the partner stopped receiving fails the connection", async () => {
    const { socket, mc } = await openStarted();
    socket.closeFromRelay(4010);
    await expect(mc.receive()).rejects.toThrow(
      /ended the exchange because the exchange partner stopped receiving\. Start the exchange again/,
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

  test("an abort ends the wait and closes without a clean close", async () => {
    const controller = new AbortController();
    const { socket, outcomes, closing } = await flushingClose({
      signal: controller.signal,
    });
    expect(socket.closedWith).toBeUndefined();
    controller.abort();
    await closing;
    expect(outcomes).toEqual(["run-aborted"]);
    expect(socket.closedWith).toBe(4000);
  });
});

describe("a parked socket", () => {
  interface Parking {
    parked: ParkedWebSocketRelayConnection;
    sockets: Array<FakeRelaySocket>;
    /** How many times the handle has reported a change. */
    changes: () => number;
    dialed: (count: number) => Promise<FakeRelaySocket>;
  }

  /**
   * Park a relay socket that records every socket it dials. `dialed(n)`
   * resolves as the nth socket is made, so a test acts on it before any of
   * the handle's waits can run out.
   */
  function park(
    options: Partial<WebSocketRelayConnectionOptions> = {},
  ): Parking {
    const sockets: Array<FakeRelaySocket> = [];
    const waiters: Array<() => void> = [];
    const parked = parkWebSocketRelayConnection({
      url: RELAY_URL,
      exchangeId: "exchange-1",
      role: "inviter",
      relayKey: RELAY_KEY,
      redialIntervalMs: 10,
      createSocket: (url) => {
        const socket = new FakeRelaySocket(url);
        sockets.push(socket);
        for (const wake of waiters.splice(0)) wake();
        return socket as unknown as WebSocket;
      },
      ...options,
    });
    let changes = 0;
    parked.onChange(() => (changes += 1));
    return {
      parked,
      sockets,
      changes: () => changes,
      async dialed(count) {
        while (sockets.length < count)
          await new Promise<void>((wake) => waiters.push(wake));
        return sockets[count - 1];
      },
    };
  }

  function helloProofExpiry(socket: FakeRelaySocket): number {
    const hello = JSON.parse(socket.sent[0] as string) as Record<
      string,
      string
    >;
    return parseWebSocketRelayProof(
      new TextEncoder().encode(hello.proof),
      Uint8Array.from(Buffer.from(hello.tag, "hex")),
    ).expiresAtSeconds;
  }

  const settleTimers = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("sends only the hello on open and holds the start through the pairing, with no wait for the partner's start", async () => {
    const { parked, dialed, changes } = park({ startTimeoutMs: 20 });
    expect(parked.url).toBe(RELAY_URL);
    const socket = await dialed(1);
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
      type: "hello",
    });

    socket.fromRelay(PAIRED);
    expect(parked.paired).toBe(true);
    expect(changes()).toBe(1);
    await settleTimers(60);
    expect(parked.failure).toBeUndefined();
    expect(socket.sent).toHaveLength(1);

    const started = parked.start();
    expect(parked.start()).toBe(started);
    expect(socket.sent).toEqual([socket.sent[0], START]);
    socket.fromRelay(START);
    await expect(started).resolves.toBeDefined();
    expect(parked.partnerStarted).toBe(true);
  });

  test("a start asked for before the socket opens follows the hello", async () => {
    const { parked, dialed } = park();
    const started = parked.start();
    const socket = await dialed(1);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toBe(START);
    socket.fromRelay(PAIRED);
    socket.fromRelay(START);
    await expect(started).resolves.toBeDefined();
  });

  test("the partner's start while this side's is held is reported, and this side's start then begins the exchange at once", async () => {
    const { parked, dialed, changes } = park();
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    socket.fromRelay(START);
    expect(parked.partnerStarted).toBe(true);
    expect(changes()).toBe(2);

    const mc = await parked.start();
    expect(socket.sent.at(-1)).toBe(START);
    for (const datagram of partnerFrames("first")) socket.fromRelay(datagram);
    await expect(mc.receive()).resolves.toBe("first");
  });

  test.each([
    [4003, false],
    [4006, false],
    [4009, true],
    [1000, true],
    [4000, true],
    [1005, true],
    [1006, false],
  ])(
    "dials again after a close with code %i, a new proof on the new socket",
    async (code, pairedFirst) => {
      const localSecond = 1_767_225_600;
      let clock = new Date(localSecond * 1000);
      const { parked, dialed, changes } = park({ now: () => clock });
      const first = await dialed(1);
      first.open();
      if (pairedFirst) first.fromRelay(PAIRED);
      const changesBefore = changes();
      first.closeFromRelay(code);
      expect(parked.paired).toBe(false);
      expect(changes()).toBe(pairedFirst ? changesBefore + 1 : changesBefore);
      clock = new Date((localSecond + 60) * 1000);

      const second = await dialed(2);
      second.open();
      expect(second.sent).toHaveLength(1);
      expect(helloProofExpiry(second)).toBe(localSecond + 60 + 300);
      expect(parked.failure).toBeUndefined();
      second.fromRelay(PAIRED);
      second.fromRelay(START);
      await expect(parked.start()).resolves.toBeDefined();
    },
  );

  test.each([4004, 4008, 1011, 1001, 4001, 4002, 4007, 1009, 4010])(
    "ends the attempt on a close with code %i, without dialing again",
    async (code) => {
      const { parked, sockets, dialed, changes } = park();
      const socket = await dialed(1);
      socket.open();
      socket.closeFromRelay(code);
      expect(parked.failure).toBeInstanceOf(ConnectionError);
      expect(changes()).toBe(1);
      await expect(parked.start()).rejects.toBe(parked.failure);
      await settleTimers(40);
      expect(sockets).toHaveLength(1);
    },
  );

  test("a start already sent goes behind the hello on the socket dialed after the partner leaves", async () => {
    const { parked, dialed } = park();
    const started = parked.start();
    const first = await dialed(1);
    first.open();
    first.fromRelay(PAIRED);
    first.closeFromRelay(4000);

    const second = await dialed(2);
    second.open();
    expect(second.sent).toHaveLength(2);
    expect(second.sent[1]).toBe(START);
    second.fromRelay(PAIRED);
    second.fromRelay(START);
    await expect(started).resolves.toBeDefined();
  });

  test("the pairing wait counts across sockets and ends on the last close dialed again on", async () => {
    const { parked, sockets } = park({
      pairingTimeoutMs: 300,
      createSocket: (url) => {
        const socket = new FakeRelaySocket(url);
        sockets.push(socket);
        setTimeout(() => {
          socket.open();
          socket.closeFromRelay(4003);
        }, 0);
        return socket as unknown as WebSocket;
      },
    });
    await vi.waitFor(() => expect(parked.failure).toBeDefined());
    expect(parked.failure?.message).toMatch(
      /no key enrolled for this exchange\. Enroll the exchange/,
    );
    expect(sockets.length).toBeGreaterThan(1);
    const count = sockets.length;
    await settleTimers(40);
    expect(sockets).toHaveLength(count);
  });

  test("the pairing wait ends on the partner not arriving when a socket waits for the pairing", async () => {
    const { parked, dialed } = park({ pairingTimeoutMs: 300 });
    const socket = await dialed(1);
    socket.open();
    await vi.waitFor(() => expect(parked.failure).toBeDefined());
    expect(parked.failure?.message).toMatch(
      /^The exchange partner did not reach the WebSocket relay within 1 minute\./,
    );
    expect(socket.closedWith).toBe(4000);
  });

  test("a pairing formed outlives the pairing wait, and a close after the wait ends the attempt", async () => {
    const { parked, sockets, dialed } = park({ pairingTimeoutMs: 150 });
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    await settleTimers(200);
    expect(parked.failure).toBeUndefined();

    socket.closeFromRelay(4000);
    expect(parked.failure?.message).toMatch(
      /^The exchange partner left the WebSocket relay before the exchange started\./,
    );
    await settleTimers(40);
    expect(sockets).toHaveLength(1);
  });

  test("a socket that does not open in time is closed and dialed again", async () => {
    const { parked, dialed } = park({ openTimeoutMs: 20 });
    const first = await dialed(1);
    const second = await dialed(2);
    expect(first.closedWith).toBe(4000);
    expect(parked.failure).toBeUndefined();
    second.open();
    expect(second.sent).toHaveLength(1);
  });

  test("close before the start closes with 1000, and the start then fails as closed", async () => {
    const { parked, dialed } = park();
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    parked.close();
    expect(socket.closedWith).toBe(1000);
    expect(parked.paired).toBe(false);
    expect(parked.failure).toBeUndefined();
    await expect(parked.start()).rejects.toMatchObject({ kind: "closed" });
  });

  test("close after the start closes with 4000 and fails the start as closed", async () => {
    const { parked, dialed } = park();
    const socket = await dialed(1);
    socket.open();
    const started = parked.start();
    parked.close();
    expect(socket.closedWith).toBe(4000);
    await expect(started).rejects.toMatchObject({ kind: "closed" });
  });

  test("close while waiting to dial again dials nothing more", async () => {
    const { parked, sockets, dialed } = park({ redialIntervalMs: 20 });
    const socket = await dialed(1);
    socket.open();
    socket.closeFromRelay(4003);
    parked.close();
    await settleTimers(60);
    expect(sockets).toHaveLength(1);
  });

  test("close does nothing once the exchange has begun", async () => {
    const { parked, dialed } = park();
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    socket.fromRelay(START);
    const mc = await parked.start();
    parked.close();
    expect(socket.closedWith).toBeUndefined();
    await mc.send("still open");
    expect(socket.binarySent()).toHaveLength(1);
  });

  test("every proof after the relay states its clock is made on that clock, and a later expired refusal ends the attempt", async () => {
    const localSecond = 1_767_225_600;
    const relaySecond = localSecond + 3_600;
    const { parked, dialed } = park({
      now: () => new Date(localSecond * 1000),
    });
    const first = await dialed(1);
    first.open();
    first.closeFromRelay(4005, String(relaySecond));

    const second = await dialed(2);
    second.open();
    expect(helloProofExpiry(second)).toBe(relaySecond + 300);
    second.closeFromRelay(4003);

    const third = await dialed(3);
    third.open();
    expect(helloProofExpiry(third)).toBe(relaySecond + 300);
    third.closeFromRelay(4005, String(relaySecond));
    expect(parked.failure?.message).toMatch(
      /^The WebSocket relay refused this side's proof as expired twice/,
    );
  });

  test("an expired-proof close after the pairing wait ends the attempt without dialing again", async () => {
    const localSecond = 1_767_225_600;
    const { parked, sockets, dialed } = park({
      pairingTimeoutMs: 100,
      now: () => new Date(localSecond * 1000),
    });
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    await settleTimers(150);
    expect(parked.failure).toBeUndefined();

    socket.closeFromRelay(4005, String(localSecond + 3_600));
    expect(parked.failure).toBeInstanceOf(ConnectionError);
    expect(parked.failure?.message).toMatch(
      /^The WebSocket relay refused this side's proof as expired: this device's clock is behind the relay's\./,
    );
    await settleTimers(40);
    expect(sockets).toHaveLength(1);
  });

  test("refuses a second start from the relay", async () => {
    const { parked, dialed } = park();
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    socket.fromRelay(START);
    socket.fromRelay(START);
    expect(parked.failure?.kind).toBe("protocol");
    expect(parked.failure?.message).toMatch(
      /passed on the partner's start twice/,
    );
    expect(socket.closedWith).toBe(4000);
  });

  test("refuses exchange data on a pairing the partner has started while this side's start is held", async () => {
    const { parked, dialed } = park();
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    socket.fromRelay(START);
    socket.fromRelay(partnerFrames("early")[0]);
    expect(parked.failure?.kind).toBe("protocol");
    expect(parked.failure?.message).toMatch(
      /passed on exchange data before both parties had started/,
    );
    expect(socket.closedWith).toBe(4000);
  });

  test("the wait for the partner's start runs from this side's start on a pairing held parked", async () => {
    const { parked, dialed } = park({ startTimeoutMs: 40 });
    const socket = await dialed(1);
    socket.open();
    socket.fromRelay(PAIRED);
    await settleTimers(60);
    const startedAt = Date.now();
    await expect(parked.start()).rejects.toThrow(
      /reached the WebSocket relay but did not start the exchange/,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(socket.closedWith).toBe(4000);
  });

  test("parked under a signal already aborted, it dials no socket", async () => {
    const controller = new AbortController();
    controller.abort();
    const { parked, sockets } = park({ signal: controller.signal });
    expect(parked.failure?.kind).toBe("closed");
    await settleTimers(20);
    expect(sockets).toEqual([]);
  });

  test("an abort while parked ends it as cancelled and closes with 4000", async () => {
    const controller = new AbortController();
    const { parked, dialed } = park({ signal: controller.signal });
    const socket = await dialed(1);
    socket.open();
    controller.abort();
    expect(parked.failure).toMatchObject({ kind: "closed" });
    expect(socket.closedWith).toBe(4000);
  });

  test("an address it refuses is its failure, and no socket is opened", async () => {
    const createSocket = vi.fn();
    const { parked } = park({ url: "ws://relay.example/relay", createSocket });
    expect(parked.failure).toMatchObject({ kind: "usage" });
    await expect(parked.start()).rejects.toBe(parked.failure);
    expect(createSocket).not.toHaveBeenCalled();
  });
});
