import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  PAIRED_FRAME,
  RELAY_MAX_MESSAGE_BYTES,
  RelayCloseCode,
  START_FRAME,
} from "../src/protocol.ts";

import {
  EXCHANGE_ID,
  OTHER_RELAY_KEY,
  Party,
  RELAY_KEY,
  connect,
  eventually,
  forwardingParties,
  helloFrame,
  keyTableOf,
  pairedParties,
  receivedInOrder,
  startRelay,
} from "./harness.ts";

import type { AddressInfo } from "node:net";

import type { RunningRelay } from "./harness.ts";

const running: RunningRelay[] = [];

async function relay(
  options: Parameters<typeof startRelay>[0] = {},
): Promise<RunningRelay> {
  const started = await startRelay(options);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

const START = '{"type":"start"}';

/** Send `message` as one binary message in 1-byte WebSocket fragments. */
function sendInFragments(party: Party, message: Buffer): void {
  for (let index = 0; index < message.length; index += 1) {
    party.socket.send(message.subarray(index, index + 1), {
      fin: index === message.length - 1,
    });
  }
}

// A byte rate no loopback test reaches, for a test moving more than one
// burst whose subject is not the rate.
const UNLIMITED_RATE = Number.MAX_SAFE_INTEGER;

describe("pairing", () => {
  it("pairs an inviter and an acceptor and forwards binary both ways once both start", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await pairedParties(url);
    expect(inviter.received[0]).toEqual({ text: PAIRED_FRAME });
    expect(acceptor.received[0]).toEqual({ text: PAIRED_FRAME });

    inviter.send(START);
    expect((await acceptor.receivedCount(2))[1]).toEqual({ text: START_FRAME });
    acceptor.send(START);
    expect((await inviter.receivedCount(2))[1]).toEqual({ text: START_FRAME });

    const toAcceptor = Buffer.from([1, 2, 3, 0xff]);
    const toInviter = Buffer.from("from the acceptor");
    inviter.send(toAcceptor);
    acceptor.send(toInviter);
    expect((await acceptor.receivedCount(3))[2]).toEqual({
      binary: toAcceptor,
    });
    expect((await inviter.receivedCount(3))[2]).toEqual({ binary: toInviter });
  });

  it("shows a test observer each forwarded message, its pairing's key and its sender", async () => {
    const seen: Array<[string, string, Buffer]> = [];
    const { url } = await relay({
      testing: {
        observer: {
          forwarded: (key, from, data) => seen.push([key, from, data]),
        },
      },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    inviter.send(Buffer.from([1, 2]));
    await acceptor.receivedCount(3);
    acceptor.send(Buffer.from([3]));
    await inviter.receivedCount(3);
    expect(seen).toEqual([
      [RELAY_KEY, "inviter", Buffer.from([1, 2])],
      [RELAY_KEY, "acceptor", Buffer.from([3])],
    ]);
  });

  it("tells a late partner of a start sent before it arrived", async () => {
    const { url } = await relay();
    const inviter = await connect(url);
    inviter.send(await helloFrame({ role: "inviter" }));
    inviter.send(START);
    const acceptor = await connect(url);
    acceptor.send(await helloFrame({ role: "acceptor" }));
    expect(await acceptor.receivedCount(2)).toEqual([
      { text: PAIRED_FRAME },
      { text: START_FRAME },
    ]);
    expect(await inviter.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);
    acceptor.send(START);
    expect((await inviter.receivedCount(2))[1]).toEqual({ text: START_FRAME });
    acceptor.send(Buffer.from("first"));
    expect((await inviter.receivedCount(3))[2]).toEqual({
      binary: Buffer.from("first"),
    });
  });

  it("refuses a second socket for a role already held and keeps the pairing", async () => {
    const { url } = await relay();
    const inviter = await connect(url);
    inviter.send(await helloFrame({ role: "inviter" }));
    const second = await connect(url);
    second.send(await helloFrame({ role: "inviter" }));
    expect(await second.closed).toEqual({
      code: RelayCloseCode.roleTaken,
      reason: "",
    });
    const acceptor = await connect(url);
    acceptor.send(await helloFrame({ role: "acceptor" }));
    expect(await inviter.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);
    expect(await acceptor.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);
  });

  it("refuses a third socket once both roles are held", async () => {
    const { url } = await relay();
    await pairedParties(url);
    const third = await connect(url);
    third.send(await helloFrame({ role: "acceptor" }));
    expect((await third.closed).code).toBe(RelayCloseCode.roleTaken);
  });

  it("frees a role when its socket closes before pairing", async () => {
    const { url, connections } = await relay();
    const first = await connect(url);
    first.send(await helloFrame({ role: "inviter" }));
    // The relay answers a waiting party nothing, so a second hello under the
    // role, refused, shows the first one holds it.
    const probe = await connect(url);
    probe.send(await helloFrame({ role: "inviter" }));
    expect((await probe.closed).code).toBe(RelayCloseCode.roleTaken);
    first.socket.close(1000);
    await eventually(async () => (await connections()) === 0);
    const { inviter, acceptor } = await pairedParties(url);
    expect(inviter.received).toEqual([{ text: PAIRED_FRAME }]);
    expect(acceptor.received).toEqual([{ text: PAIRED_FRAME }]);
  });

  it("pairs only sockets under the same relay key", async () => {
    const { url } = await relay({
      keyTable: keyTableOf({
        [EXCHANGE_ID]: RELAY_KEY,
        "exchange-2": OTHER_RELAY_KEY,
      }),
    });
    const inviter = await connect(url);
    inviter.send(await helloFrame({ role: "inviter" }));
    const other = await connect(url);
    other.send(
      await helloFrame({
        role: "acceptor",
        exchangeId: "exchange-2",
        relayKey: OTHER_RELAY_KEY,
      }),
    );
    const acceptor = await connect(url);
    acceptor.send(await helloFrame({ role: "acceptor" }));
    expect(await inviter.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);
    expect(await acceptor.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);
    expect(other.received).toEqual([]);
  });
});

describe("refusals", () => {
  it("refuses a proof that does not verify under the exchange's key", async () => {
    const { url } = await relay();
    const party = await connect(url);
    party.send(
      await helloFrame({ role: "inviter", relayKey: OTHER_RELAY_KEY }),
    );
    expect(await party.closed).toEqual({
      code: RelayCloseCode.proofRefused,
      reason: "",
    });
  });

  it("refuses a proof made for the other role", async () => {
    const { url } = await relay();
    const party = await connect(url);
    party.send(await helloFrame({ role: "inviter", claimedRole: "acceptor" }));
    expect((await party.closed).code).toBe(RelayCloseCode.proofRefused);
  });

  it("refuses an expired proof with the relay's Unix second as the reason", async () => {
    const { url } = await relay();
    const party = await connect(url);
    const before = Math.floor(Date.now() / 1000);
    party.send(
      await helloFrame({
        role: "inviter",
        ttlSeconds: 60,
        now: new Date(Date.now() - 120_000),
      }),
    );
    const closed = await party.closed;
    expect(closed.code).toBe(RelayCloseCode.proofExpired);
    expect(closed.reason).toMatch(/^[1-9][0-9]*$/);
    const serverTime = Number(closed.reason);
    expect(serverTime).toBeGreaterThanOrEqual(before);
    expect(serverTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("refuses an exchange id no key is enrolled under", async () => {
    const { url } = await relay();
    const party = await connect(url);
    party.send(await helloFrame({ role: "inviter", exchangeId: "unknown" }));
    expect((await party.closed).code).toBe(RelayCloseCode.notEnrolled);
  });

  it.each([
    ["a binary first message", Buffer.from("hello")],
    ["text that is not JSON", "hello"],
    ["a start before the hello", START],
    [
      "a hello with an extra key",
      JSON.stringify({
        type: "hello",
        exchangeId: EXCHANGE_ID,
        role: "inviter",
        proof: "alcove-relay-websocket-v2:hello\ninviter\n1",
        tag: "0".repeat(64),
        extra: 1,
      }),
    ],
    [
      "an exchange id outside the registrar's alphabet",
      JSON.stringify({
        type: "hello",
        exchangeId: "-starts-with-a-dash",
        role: "inviter",
        proof: "alcove-relay-websocket-v2:hello\ninviter\n1",
        tag: "0".repeat(64),
      }),
    ],
    [
      "a role that is not a rendezvous role",
      JSON.stringify({
        type: "hello",
        exchangeId: EXCHANGE_ID,
        role: "observer",
        proof: "alcove-relay-websocket-v2:hello\ninviter\n1",
        tag: "0".repeat(64),
      }),
    ],
    [
      "a proof not in the proof's layout",
      JSON.stringify({
        type: "hello",
        exchangeId: EXCHANGE_ID,
        role: "inviter",
        proof: "alcove-relay-websocket-v2:hello\ninviter\n01",
        tag: "0".repeat(64),
      }),
    ],
    [
      "a tag that is not 64 lowercase hex",
      JSON.stringify({
        type: "hello",
        exchangeId: EXCHANGE_ID,
        role: "inviter",
        proof: "alcove-relay-websocket-v2:hello\ninviter\n1",
        tag: "0".repeat(63),
      }),
    ],
  ])("refuses %s as a malformed hello", async (_name, frame) => {
    const { url } = await relay();
    const party = await connect(url);
    party.send(frame);
    expect((await party.closed).code).toBe(RelayCloseCode.helloMalformed);
  });

  it("refuses a socket that sends no hello within the hello bound", async () => {
    const { url } = await relay({ testing: { helloTimeoutMs: 100 } });
    const party = await connect(url);
    expect((await party.closed).code).toBe(RelayCloseCode.helloTimeout);
  });

  it("refuses a message above the cap and closes the partner behind what it was sent", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    const atCap = Buffer.alloc(RELAY_MAX_MESSAGE_BYTES, 7);
    inviter.send(atCap);
    inviter.send(Buffer.alloc(RELAY_MAX_MESSAGE_BYTES + 1, 8));
    expect((await inviter.closed).code).toBe(RelayCloseCode.messageTooBig);
    expect(await acceptor.closed).toEqual({
      code: RelayCloseCode.partnerEnded,
      reason: "",
    });
    expect(acceptor.received.slice(2)).toEqual([{ binary: atCap }]);
  });

  it("refuses a message in two fragments and closes the partner, forwarding nothing", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    sendInFragments(inviter, Buffer.alloc(2, 9));
    expect((await inviter.closed).code).toBe(RelayCloseCode.tooManyFragments);
    expect(await acceptor.closed).toEqual({
      code: RelayCloseCode.partnerEnded,
      reason: "",
    });
    expect(acceptor.received.slice(2)).toEqual([]);
  });

  it("forwards a message in one frame, intact", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    const message = Buffer.alloc(RELAY_MAX_MESSAGE_BYTES, 9);
    inviter.send(message);
    const received = await acceptor.receivedCount(3);
    expect(received[2]).toEqual({ binary: message });
  });

  it("forwards nothing until both parties have sent a start", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await pairedParties(url);
    inviter.send(START);
    await acceptor.receivedCount(2);
    inviter.send(Buffer.from("too early"));
    expect((await inviter.closed).code).toBe(RelayCloseCode.unexpectedMessage);
    expect((await acceptor.closed).code).toBe(RelayCloseCode.partnerEnded);
    expect(acceptor.received).toEqual([
      { text: PAIRED_FRAME },
      { text: START_FRAME },
    ]);
  });

  it.each([
    ["a second hello", async () => helloFrame({ role: "inviter" })],
    ["a second start", async () => START],
  ])("refuses %s before forwarding opens", async (_name, frame) => {
    const { url } = await relay();
    const { inviter } = await pairedParties(url);
    inviter.send(START);
    inviter.send(await frame());
    expect((await inviter.closed).code).toBe(RelayCloseCode.unexpectedMessage);
  });

  it("refuses a text message once forwarding is open", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.send("not binary");
    expect((await acceptor.closed).code).toBe(RelayCloseCode.unexpectedMessage);
    expect((await inviter.closed).code).toBe(RelayCloseCode.partnerEnded);
  });

  it("refuses a second message sent while the hello is being checked", async () => {
    const { url } = await relay();
    const party = await connect(url);
    party.send(await helloFrame({ role: "inviter" }));
    party.send(START);
    party.send(START);
    expect((await party.closed).code).toBe(RelayCloseCode.unexpectedMessage);
  });

  it("refuses with 1011 and reports once while the key table cannot be read", async () => {
    let failing = true;
    const { url, faults } = await relay({
      keyTable: {
        lookup: () => {
          if (failing) throw new Error("the table is locked");
          return RELAY_KEY;
        },
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const party = await connect(url);
      party.send(await helloFrame({ role: "inviter" }));
      expect((await party.closed).code).toBe(RelayCloseCode.internalError);
    }
    expect(faults).toEqual([
      "the table is locked; every hello is refused until a lookup succeeds",
    ]);
    failing = false;
    const { inviter } = await pairedParties(url);
    expect(inviter.received).toEqual([{ text: PAIRED_FRAME }]);
  });

  it("refuses with 1011 and reports a malformed enrolled key once for each exchange id", async () => {
    const { url, faults } = await relay({
      keyTable: keyTableOf({ "exchange-1": "not hex", "exchange-2": "zz" }),
    });
    for (const exchangeId of ["exchange-1", "exchange-1", "exchange-2"]) {
      const party = await connect(url);
      party.send(await helloFrame({ role: "inviter", exchangeId }));
      expect((await party.closed).code).toBe(RelayCloseCode.internalError);
    }
    expect(faults).toEqual([
      "the relay key enrolled under exchange id exchange-1 is not 64 lowercase hex characters",
      "the relay key enrolled under exchange id exchange-2 is not 64 lowercase hex characters",
    ]);
  });

  it("answers an upgrade on any other path with 404", async () => {
    const { url } = await relay();
    const { port } = new URL(url);
    const socket = connectTcp(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      "GET /elsewhere HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    const [answer] = (await once(socket, "data")) as [Buffer];
    expect(answer.toString()).toMatch(/^HTTP\/1\.1 404 /);
    socket.destroy();
  });
});

/** Open a socket to the relay: the open party, or the status of the answer
 * that refused the upgrade. */
async function attemptUpgrade(
  url: string,
): Promise<{ party: Party } | { status: number }> {
  const socket = new WebSocket(url);
  socket.on("error", () => {});
  return new Promise((resolve) => {
    socket.once("open", () => resolve({ party: new Party(socket) }));
    socket.once("unexpected-response", (request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      request.destroy();
    });
  });
}

describe("sockets awaiting a hello", () => {
  it("answers an upgrade 503 at the cap and takes one again once a socket verifies or closes", async () => {
    const { url } = await relay({ testing: { maxUnverifiedSockets: 2 } });
    const first = await connect(url);
    const second = await connect(url);
    expect(await attemptUpgrade(url)).toEqual({ status: 503 });

    first.send(await helloFrame({ role: "inviter" }));
    let third: Party | undefined;
    await eventually(async () => {
      const attempt = await attemptUpgrade(url);
      if ("party" in attempt) third = attempt.party;
      return third !== undefined;
    });
    expect(await attemptUpgrade(url)).toEqual({ status: 503 });

    second.socket.close();
    await second.closed;
    await eventually(async () => "party" in (await attemptUpgrade(url)));
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(third?.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("counts a refused socket that never answers the close until the relay drops it", async () => {
    const refusalCloseWaitMs = 2000;
    const { url, connections } = await relay({
      testing: { maxUnverifiedSockets: 2, refusalCloseWaitMs },
    });
    const refused = [await connect(url), await connect(url)];
    for (const party of refused) {
      // A paused client reads nothing, so it never answers the relay's close.
      party.socket.pause();
      party.send("not a hello");
    }
    const sentAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await connections()).toBe(2);
    expect(await attemptUpgrade(url)).toEqual({ status: 503 });

    await eventually(async () => (await connections()) === 0, 5000);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(refusalCloseWaitMs - 50);
    await eventually(async () => "party" in (await attemptUpgrade(url)));
    expect("party" in (await attemptUpgrade(url))).toBe(true);
    expect(await attemptUpgrade(url)).toEqual({ status: 503 });

    for (const party of refused) {
      party.socket.resume();
      expect((await party.closed).code).toBe(RelayCloseCode.helloMalformed);
    }
  });

  it("holds to the cap across upgrades arriving together", async () => {
    const { url } = await relay({ testing: { maxUnverifiedSockets: 3 } });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => attemptUpgrade(url)),
    );
    expect(attempts.filter((attempt) => "party" in attempt)).toHaveLength(3);
    expect(attempts.filter((attempt) => "status" in attempt)).toEqual([
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
  });

  it("relies on the pinned ws answering an upgrade before handleUpgrade returns", async () => {
    const server = createServer();
    const socketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
    });
    const answeredBeforeReturn = new Promise<boolean>((resolve) => {
      server.on("upgrade", (request, socket, head) => {
        let answered = false;
        socketServer.handleUpgrade(request, socket, head, (webSocket) => {
          answered = true;
          webSocket.terminate();
        });
        resolve(answered);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    client.on("error", () => {});
    try {
      expect(await answeredBeforeReturn).toBe(true);
    } finally {
      client.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("backpressure", () => {
  it("stops reading the source above the send-buffer bound and resumes below the lower one", async () => {
    const events: string[] = [];
    const { url } = await relay({
      testing: {
        sendBufferHighBytes: 64 * 1024,
        sendBufferLowBytes: 16 * 1024,
        bytesPerSecond: UNLIMITED_RATE,
        observer: {
          held: (role, reason) => events.push(`held ${role} ${reason}`),
          released: (role, reason) => events.push(`released ${role} ${reason}`),
        },
      },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.socket.pause();
    const messages = Array.from({ length: 1024 }, (_, index) =>
      Buffer.alloc(16_000, index % 251),
    );
    for (const message of messages) inviter.send(message);
    await eventually(() => events.includes("held inviter backpressure"));
    expect(events).not.toContain("released inviter backpressure");
    acceptor.socket.resume();
    const received = await acceptor.receivedCount(2 + messages.length);
    expect(receivedInOrder(received.slice(2), messages)).toBe(true);
    expect(events).toContain("released inviter backpressure");
    expect(events.indexOf("held inviter backpressure")).toBeLessThan(
      events.indexOf("released inviter backpressure"),
    );
  });
});

describe("keepalive", () => {
  it("answers a party's ping and forwards nothing", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    inviter.socket.ping(Buffer.from("keepalive"));
    const [payload] = (await once(inviter.socket, "pong")) as [Buffer];
    expect(payload.toString()).toBe("keepalive");
    acceptor.send(Buffer.from("after the ping"));
    expect((await inviter.receivedCount(3))[2]).toEqual({
      binary: Buffer.from("after the ping"),
    });
    expect(acceptor.received).toHaveLength(2);
  });

  it("pings every socket it holds", async () => {
    const { url } = await relay({ testing: { pingIntervalMs: 50 } });
    const party = await connect(url);
    party.send(await helloFrame({ role: "inviter" }));
    await once(party.socket, "ping");
    expect(party.received).toEqual([]);
  });
});

describe("close", () => {
  it("forwards a normal close after every message queued ahead of it", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    const messages = Array.from({ length: 64 }, (_, index) =>
      Buffer.alloc(16_000, index),
    );
    for (const message of messages) inviter.send(message);
    inviter.socket.close(1000);
    expect(await acceptor.closed).toEqual({
      code: RelayCloseCode.normal,
      reason: "",
    });
    expect(receivedInOrder(acceptor.received.slice(2), messages)).toBe(true);
  });

  it("forwards a close behind messages a slow reader has not yet read", async () => {
    const { url } = await relay({
      testing: {
        sendBufferHighBytes: 64 * 1024,
        sendBufferLowBytes: 16 * 1024,
        bytesPerSecond: UNLIMITED_RATE,
      },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.socket.pause();
    const messages = Array.from({ length: 512 }, (_, index) =>
      Buffer.alloc(16_000, index % 251),
    );
    for (const message of messages) inviter.send(message);
    inviter.socket.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    acceptor.socket.resume();
    expect((await acceptor.closed).code).toBe(RelayCloseCode.normal);
    expect(receivedInOrder(acceptor.received.slice(2), messages)).toBe(true);
  });

  it("forwards a close with no status code as a normal close", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.socket.close();
    expect((await inviter.closed).code).toBe(RelayCloseCode.normal);
  });

  it("closes the partner with 4000 when a socket ends without a normal close", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await forwardingParties(url);
    inviter.send(Buffer.from("last"));
    await acceptor.receivedCount(3);
    inviter.socket.terminate();
    expect((await acceptor.closed).code).toBe(RelayCloseCode.partnerEnded);
  });

  it("closes the partner with 4000 when a socket closes with another code", async () => {
    const { url } = await relay();
    const { inviter, acceptor } = await pairedParties(url);
    inviter.socket.close(1001);
    expect((await acceptor.closed).code).toBe(RelayCloseCode.partnerEnded);
  });

  it("drops a socket that does not answer a forwarded close within the close wait", async () => {
    const { url, connections } = await relay({ testing: { closeWaitMs: 300 } });
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.socket.pause();
    inviter.socket.close(1000);
    await inviter.closed;
    await eventually(async () => (await connections()) === 0, 3000);
  });

  it("holds a socket that has not answered a forwarded close until the close wait", async () => {
    const { url, connections } = await relay({
      testing: { closeWaitMs: 5000 },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    acceptor.socket.pause();
    inviter.socket.close(1000);
    await inviter.closed;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await connections()).toBe(1);
    acceptor.socket.resume();
    expect((await acceptor.closed).code).toBe(RelayCloseCode.normal);
  });

  it("closes every socket with 1001 when the relay closes", async () => {
    const started = await relay();
    const { inviter, acceptor } = await pairedParties(started.url);
    started.relay.close();
    expect((await inviter.closed).code).toBe(RelayCloseCode.goingAway);
    expect((await acceptor.closed).code).toBe(RelayCloseCode.goingAway);
  });
});
