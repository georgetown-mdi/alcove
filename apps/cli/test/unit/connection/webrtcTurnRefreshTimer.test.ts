import {
  Message,
  TurnProtocol,
  classes,
  makeIntegrityKey,
  methods,
  parseMessage,
} from "werift";
import { expect, test } from "vitest";

/**
 * The TURN allocation refresh timer, pinned because the CLI's teardown cannot
 * reach it: werift re-arms REFRESH from the granted lifetime, and a timer left
 * armed after `close()` holds the event loop for about five sixths of that
 * lifetime past the end of a relayed exchange. werift's own close disarms it,
 * which is what lets such a run return once its work is done
 * (docs/spec/DEPENDENCY_PINS.md); a release that leaves it armed fails here.
 */

type Address = ConstructorParameters<typeof TurnProtocol>[0];
type IceTransport = ConstructorParameters<typeof TurnProtocol>[4];

const SERVER: Address = ["127.0.0.1", 3478];
const RELAYED_ADDRESS: Address = ["127.0.0.1", 50_000];
const MAPPED_ADDRESS: Address = ["127.0.0.1", 45_000];
const USERNAME = "alcove";
const PASSWORD = "secret";
const REALM = "relay.test";
const NONCE = Buffer.from("nonce");

/** The lifetime werift itself requests, in seconds. */
const REQUESTED_LIFETIME = 600;
/** What this relay grants instead, in seconds. */
const GRANTED_LIFETIME = 1;
/** Five sixths of the grant, less the slack a loaded machine takes. */
const EARLIEST_REFRESH_MS = 700;

interface ScriptedRelay {
  transport: IceTransport;
  /** Resolves when the relay is asked for `method`; rejects at the deadline. */
  awaitRequest: (method: methods, withinMs: number) => Promise<void>;
}

/**
 * A relay that answers the long-term-credential ALLOCATE and then anything
 * else, over a transport that stays readable after `close()`. A transport that
 * reported itself closed would have werift drop the post-close request before
 * this saw it, and that request is the whole observation.
 */
function scriptedRelay(): ScriptedRelay {
  const waiting = new Map<methods, () => void>();
  const integrityKey = makeIntegrityKey(USERNAME, REALM, PASSWORD);
  let challenged = false;

  const answer = (request: Message): Message =>
    challenged
      ? new Message(
          request.messageMethod,
          classes.RESPONSE,
          request.transactionId,
        )
          .setAttribute("XOR-RELAYED-ADDRESS", RELAYED_ADDRESS)
          .setAttribute("XOR-MAPPED-ADDRESS", MAPPED_ADDRESS)
          .setAttribute("LIFETIME", GRANTED_LIFETIME)
          .addMessageIntegrity(integrityKey)
      : new Message(request.messageMethod, classes.ERROR, request.transactionId)
          .setAttribute("ERROR-CODE", [401, "Unauthorized"])
          .setAttribute("REALM", REALM)
          .setAttribute("NONCE", NONCE);

  const transport = {
    type: "udp",
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    closed: false,
    onData: (_data: Buffer, _addr: Address) => {},
    send: async (data: Buffer): Promise<void> => {
      const request = parseMessage(data);
      if (request === undefined) return;
      waiting.get(request.messageMethod)?.();
      const response = answer(request);
      challenged = true;
      setImmediate(() => {
        transport.onData(response.bytes, SERVER);
      });
    },
    close: async (): Promise<void> => {},
  };

  return {
    transport: transport as unknown as IceTransport,
    awaitRequest: (method, withinMs) =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          waiting.delete(method);
          reject(new Error(`no ${methods[method]} within ${withinMs} ms`));
        }, withinMs);
        waiting.set(method, () => {
          clearTimeout(deadline);
          waiting.delete(method);
          resolve();
        });
      }),
  };
}

test("an open allocation refreshes at five sixths of the granted lifetime", async () => {
  // The control for the test below: this relay does draw a REFRESH from a
  // live allocation, so its absence after the close is the timer disarmed.
  const relay = scriptedRelay();
  const turn = new TurnProtocol(
    SERVER,
    USERNAME,
    PASSWORD,
    REQUESTED_LIFETIME,
    relay.transport,
  );

  await turn.connectionMade();
  expect(turn.relayedAddress).toEqual(RELAYED_ADDRESS);
  const allocatedAt = Date.now();

  try {
    // Armed from the granted second, not the requested ten minutes: five
    // sixths of the request would land far outside this budget.
    await relay.awaitRequest(methods.REFRESH, 10_000);
    expect(Date.now() - allocatedAt).toBeGreaterThanOrEqual(
      EARLIEST_REFRESH_MS,
    );
  } finally {
    await turn.close();
  }
}, 15_000);

test("close disarms the TURN refresh timer", async () => {
  const relay = scriptedRelay();
  const turn = new TurnProtocol(
    SERVER,
    USERNAME,
    PASSWORD,
    REQUESTED_LIFETIME,
    relay.transport,
  );
  await turn.connectionMade();
  await turn.close();

  // Still armed, it would fire within five sixths of the grant.
  await expect(
    relay.awaitRequest(methods.REFRESH, 3 * GRANTED_LIFETIME * 1000),
  ).rejects.toThrow(/no REFRESH within/);
}, 10_000);
