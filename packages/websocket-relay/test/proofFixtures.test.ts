import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { webSocketRelayProofRefusalFixtures } from "@alcove/core/testing";

import { RelayCloseCode } from "../src/protocol.ts";

import { EXCHANGE_ID, RELAY_KEY, connect, startRelay } from "./harness.ts";

import type { WebSocketRelayProofRefusal } from "@alcove/core";
import type { WebSocketRelayProofFixture } from "@alcove/core/testing";

import type { RunningRelay } from "./harness.ts";

// Core's refused relay proofs, each presented in a hello to a running relay:
// the relay must close the socket with the code its refusal maps to
// (docs/spec/WEBSOCKET_RELAY.md, Close codes), and forward nothing.

const CLOSE_CODE_OF_REFUSAL: Record<WebSocketRelayProofRefusal, number> = {
  malformed: RelayCloseCode.helloMalformed,
  "role-mismatch": RelayCloseCode.proofRefused,
  expired: RelayCloseCode.proofExpired,
  "tag-mismatch": RelayCloseCode.proofRefused,
};

const fixtures = await webSocketRelayProofRefusalFixtures({
  relayKey: RELAY_KEY,
  now: new Date(),
});

let running: RunningRelay;
beforeAll(async () => {
  running = await startRelay();
});
afterAll(() => running.stop());

function helloOf(fixture: WebSocketRelayProofFixture): string {
  return JSON.stringify({
    type: "hello",
    exchangeId: EXCHANGE_ID,
    role: fixture.role,
    proof: fixture.message,
    tag: Buffer.from(fixture.tag).toString("hex"),
  });
}

describe("the shared refusal fixtures at the relay", () => {
  it.each(fixtures)("closes on $label as $refusedBy", async (fixture) => {
    const party = await connect(running.url);
    party.send(helloOf(fixture));
    const closed = await party.closed;
    expect(closed.code).toBe(CLOSE_CODE_OF_REFUSAL[fixture.refusedBy]);
    expect(party.received).toEqual([]);
  });
});
