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
 * A relay's `438 Stale nonce` answer to an allocation's REFRESH, pinned
 * because a relayed run outlives the relay's nonce: coturn answers the
 * refresh that follows a stale nonce with a 438 holding a new NONCE and no
 * MESSAGE-INTEGRITY, and a werift that refused that answer for its missing
 * integrity lost the relay path at the next refresh. Held here: werift sends
 * the REFRESH again under the 438's nonce, signed, as a new transaction, and
 * keeps the lifetime the relay grants it (docs/spec/WEBRTC_STACK.md).
 */

type Address = ConstructorParameters<typeof TurnProtocol>[0];
type IceTransport = ConstructorParameters<typeof TurnProtocol>[4];

const SERVER: Address = ["127.0.0.1", 3478];
const RELAYED_ADDRESS: Address = ["127.0.0.1", 50_000];
const MAPPED_ADDRESS: Address = ["127.0.0.1", 45_000];
const USERNAME = "alcove";
const PASSWORD = "secret";
const REALM = "relay.test";
/** coturn's nonces are 24 hex characters with no RFC 8489 security cookie. */
const FIRST_NONCE = "6af3082dfc2fadab702c4405";
const NEXT_NONCE = "0b493d68c1f2e3a4b5c6d7e8";

/** The lifetime werift itself requests, in seconds. */
const REQUESTED_LIFETIME = 600;
/** The allocation's grant, in seconds: the first REFRESH follows at five sixths of it. */
const ALLOCATED_LIFETIME = 1;
/** What the relay grants the retried REFRESH, in seconds. */
const REFRESHED_LIFETIME = 600;

/** One REFRESH the relay received. */
interface RefreshSeen {
  transactionId: string;
  nonce: string | undefined;
  /** Whether its MESSAGE-INTEGRITY verifies under the long-term key. */
  signed: boolean;
}

/**
 * A relay that challenges the first ALLOCATE with a 401, grants the second,
 * answers the first REFRESH with an unsigned 438 holding a new nonce, as
 * coturn 4.18 does, and grants every REFRESH under the new nonce.
 */
function staleNonceRelay(): {
  transport: IceTransport;
  refreshes: Array<RefreshSeen>;
  refreshCount: () => number;
} {
  const integrityKey = makeIntegrityKey(USERNAME, REALM, PASSWORD);
  const refreshes: Array<RefreshSeen> = [];

  const error = (
    request: Message,
    code: number,
    reason: string,
    nonce: string,
  ) =>
    new Message(request.messageMethod, classes.ERROR, request.transactionId)
      .setAttribute("ERROR-CODE", [code, reason])
      .setAttribute("NONCE", Buffer.from(nonce))
      .setAttribute("REALM", REALM)
      .addFingerprint();

  const success = (request: Message, lifetime: number): Message =>
    new Message(request.messageMethod, classes.RESPONSE, request.transactionId)
      .setAttribute("XOR-RELAYED-ADDRESS", RELAYED_ADDRESS)
      .setAttribute("XOR-MAPPED-ADDRESS", MAPPED_ADDRESS)
      .setAttribute("LIFETIME", lifetime)
      .addMessageIntegrity(integrityKey)
      .addFingerprint();

  const answer = (data: Buffer, request: Message): Message => {
    const nonce = request.attributesKeys.includes("NONCE")
      ? Buffer.from(request.getAttributeValue("NONCE")).toString()
      : undefined;
    if (request.messageMethod === methods.ALLOCATE)
      return nonce === undefined
        ? error(request, 401, "Unauthorized", FIRST_NONCE)
        : success(request, ALLOCATED_LIFETIME);
    refreshes.push({
      transactionId: Buffer.from(request.transactionId).toString("hex"),
      nonce,
      signed: parseMessage(data, integrityKey) !== undefined,
    });
    return nonce === NEXT_NONCE
      ? success(request, REFRESHED_LIFETIME)
      : error(request, 438, "Stale nonce", NEXT_NONCE);
  };

  const transport = {
    type: "udp",
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    closed: false,
    onData: (_data: Buffer, _addr: Address) => {},
    send: async (data: Buffer): Promise<void> => {
      const request = parseMessage(data);
      if (request === undefined) return;
      const response = answer(data, request);
      setImmediate(() => {
        transport.onData(response.bytes, SERVER);
      });
    },
    close: async (): Promise<void> => {},
  };

  return {
    transport: transport as unknown as IceTransport,
    refreshes,
    refreshCount: () => refreshes.length,
  };
}

/** Resolves once `predicate` holds, polled every 20 ms; rejects at the deadline. */
async function until(
  predicate: () => boolean,
  withinMs: number,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`condition not met within ${withinMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a REFRESH answered with an unsigned 438 is sent again under the new nonce, and the granted lifetime is kept", async () => {
  const relay = staleNonceRelay();
  const turn = new TurnProtocol(
    SERVER,
    USERNAME,
    PASSWORD,
    REQUESTED_LIFETIME,
    relay.transport,
  );
  await turn.connectionMade();
  expect(turn.relayedAddress).toEqual(RELAYED_ADDRESS);

  try {
    await until(() => relay.refreshCount() >= 2, 10_000);
    const [stale, retried] = relay.refreshes;
    expect(stale).toMatchObject({ nonce: FIRST_NONCE, signed: true });
    expect(retried).toMatchObject({ nonce: NEXT_NONCE, signed: true });
    expect(retried!.transactionId).not.toBe(stale!.transactionId);

    // A refresh that failed would keep the one-second grant and ask again
    // within a second; the retried one's 600 s grant puts the next far off.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(relay.refreshCount()).toBe(2);
  } finally {
    await turn.close();
  }
}, 20_000);
